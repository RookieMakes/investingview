"""
sma200_scanner.py — 200 SMA proximity scanner.

Scans universe tickers to find stocks trading near their 200-day
Simple Moving Average. Identifies potential trade setups where price
is within a configurable threshold of the 200 SMA.
"""

import time
import logging
from datetime import datetime

import numpy as np

from config import UNIVERSE_SECTORS, SMA200_PROXIMITY_PCT
from services.universe import get_merged_universe_with_metadata, get_merged_company_names
from models.db import get_connection

logger = logging.getLogger(__name__)

# In-memory cache (same pattern as reversal_scanner.py)
_SCAN_CACHE_TTL = 1800  # 30 minutes
_scan_cache = None
_scan_cache_time = 0.0


def _to_native(val):
    """Convert numpy types to native Python types."""
    if isinstance(val, (np.integer,)):
        return int(val)
    if isinstance(val, (np.floating,)):
        return float(val)
    if isinstance(val, (np.bool_,)):
        return bool(val)
    return val


def _calculate_sma200(closes: np.ndarray) -> float | None:
    """Calculate 200-day Simple Moving Average."""
    if len(closes) < 200:
        return None
    return float(np.mean(closes[-200:]))


def run_sma200_scan(force: bool = False) -> dict:
    """
    Scan all universe tickers for 200 SMA proximity.

    Pipeline:
    1. Check cache (skip if fresh and force=False)
    2. Get universe tickers
    3. For each ticker, read candles from DB
    4. Calculate SMA 200 from close prices
    5. Calculate % distance from current price to SMA 200
    6. Filter: only tickers within SMA200_PROXIMITY_PCT threshold
    7. Sort by proximity (closest first)
    8. Store results in sma200_scan table
    9. Return structured results
    """
    global _scan_cache, _scan_cache_time

    # Check cache
    if not force and _scan_cache is not None:
        age = time.time() - _scan_cache_time
        if age < _SCAN_CACHE_TTL:
            logger.info("Returning cached SMA200 scan results (cached %ds ago)", int(age))
            cached = _scan_cache.copy()
            cached["cached"] = True
            return cached

    # Get universe
    universe = get_merged_universe_with_metadata()
    company_names = get_merged_company_names()
    tickers = [item["ticker"] for item in universe]

    results = []
    errors = []

    # Read candles from DB for each ticker
    with get_connection() as conn:
        for ticker in tickers:
            try:
                rows = conn.execute(
                    "SELECT close FROM candles WHERE ticker = ? ORDER BY date",
                    (ticker,),
                ).fetchall()

                if not rows or len(rows) < 200:
                    continue  # Need 200+ candles for SMA 200

                closes = np.array([float(r["close"]) for r in rows])
                price = float(closes[-1])
                sma_200 = _calculate_sma200(closes)

                if sma_200 is None or sma_200 <= 0:
                    continue

                pct_from_sma = ((price - sma_200) / sma_200) * 100
                above_sma = price >= sma_200

                # Filter by proximity threshold
                if abs(pct_from_sma) > SMA200_PROXIMITY_PCT:
                    continue

                results.append({
                    "ticker": ticker,
                    "company": company_names.get(ticker, ""),
                    "sector": UNIVERSE_SECTORS.get(ticker, ""),
                    "price": round(price, 2),
                    "sma_200": round(sma_200, 2),
                    "pct_from_sma": round(pct_from_sma, 2),
                    "above_sma": above_sma,
                })
            except Exception as e:
                errors.append(ticker)
                logger.warning("sma200_scan.error %s: %s", ticker, e)

    # Sort by proximity (closest to SMA first)
    results.sort(key=lambda x: abs(x["pct_from_sma"]))

    # Store results in DB
    _store_results(results)

    result = {
        "results": results,
        "total": len(results),
        "universe_size": len(tickers),
        "errors": len(errors),
        "threshold_pct": SMA200_PROXIMITY_PCT,
        "scanned_at": datetime.now().isoformat(),
        "cached": False,
    }

    # Update cache
    _scan_cache = result
    _scan_cache_time = time.time()

    return result


def _store_results(results: list[dict]) -> None:
    """Store scan results in sma200_scan table."""
    with get_connection() as conn:
        # Clear old results
        conn.execute("DELETE FROM sma200_scan")

        # Insert new results
        for r in results:
            conn.execute(
                """INSERT INTO sma200_scan
                   (ticker, sma_200, price, pct_from_sma, above_sma, scanned_at)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (
                    r["ticker"],
                    r["sma_200"],
                    r["price"],
                    r["pct_from_sma"],
                    1 if r["above_sma"] else 0,
                    datetime.now().isoformat(),
                ),
            )


def get_sma200_rankings() -> list[dict]:
    """Get stored SMA 200 proximity rankings from DB."""
    with get_connection() as conn:
        rows = conn.execute(
            """SELECT ticker, sma_200, price, pct_from_sma, above_sma, scanned_at
               FROM sma200_scan
               ORDER BY ABS(pct_from_sma) ASC"""
        ).fetchall()

    return [
        {
            "ticker": row["ticker"],
            "sma_200": row["sma_200"],
            "price": row["price"],
            "pct_from_sma": row["pct_from_sma"],
            "above_sma": bool(row["above_sma"]),
            "scanned_at": row["scanned_at"],
        }
        for row in rows
    ]
