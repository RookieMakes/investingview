"""
ytd_scanner.py — Year-To-Date return scanner.

Scans universe tickers to rank stocks by their year-to-date
percentage return. Identifies top and bottom performers for the
current calendar year.
"""

import time
import logging
from datetime import datetime

import numpy as np

from config import UNIVERSE_SECTORS
from services.universe import get_merged_universe_with_metadata, get_merged_company_names
from services.rankings import (
    update_rankings, needs_trend_snapshot, update_trend_snapshots,
    set_last_scan_completed_at,
)
from models.db import get_connection

logger = logging.getLogger(__name__)

# In-memory cache (same pattern as sma200_scanner.py)
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


def run_ytd_scan(force: bool = False) -> dict:
    """
    Scan all universe tickers for Year-To-Date return.

    Pipeline:
    1. Check cache (skip if fresh and force=False)
    2. Get universe tickers
    3. For each ticker, read candles from DB
    4. Filter to current calendar year rows
    5. Compute YTD %: (last_close - first_close_of_year) / first_close_of_year * 100
    6. Sort by YTD % descending
    7. Store results in ytd_scan table
    8. Return structured results
    """
    global _scan_cache, _scan_cache_time

    # Check cache
    if not force and _scan_cache is not None:
        age = time.time() - _scan_cache_time
        if age < _SCAN_CACHE_TTL:
            logger.info("Returning cached YTD scan results (cached %ds ago)", int(age))
            cached = _scan_cache.copy()
            cached["cached"] = True
            return cached

    # Get universe
    universe = get_merged_universe_with_metadata()
    company_names = get_merged_company_names()
    tickers = [item["ticker"] for item in universe]

    # Current calendar year
    current_year = datetime.now().year
    year_start = f"{current_year}-01-01"
    year_end = f"{current_year}-12-31"

    results = []
    errors = []

    # Read candles from DB for each ticker
    with get_connection() as conn:
        for ticker in tickers:
            try:
                # Skip ETFs
                item = next((u for u in universe if u["ticker"] == ticker), None)
                if item and item.get("sector") == "ETF":
                    continue

                rows = conn.execute(
                    "SELECT date, close FROM candles WHERE ticker = ? ORDER BY date",
                    (ticker,),
                ).fetchall()

                if not rows:
                    continue

                # Filter to current calendar year
                year_candles = [
                    row for row in rows
                    if year_start <= row["date"] <= year_end
                ]

                if len(year_candles) < 1:
                    continue

                first_close = float(year_candles[0]["close"])
                last_close = float(year_candles[-1]["close"])

                if first_close <= 0:
                    continue

                ytd_pct = ((last_close - first_close) / first_close) * 100
                price = last_close
                year_start_close = first_close

                results.append({
                    "ticker": ticker,
                    "company": company_names.get(ticker, ""),
                    "sector": UNIVERSE_SECTORS.get(ticker, ""),
                    "price": round(_to_native(price), 2),
                    "ytd_pct": round(_to_native(ytd_pct), 2),
                    "year_start_close": round(_to_native(year_start_close), 2),
                })
            except Exception as e:
                errors.append(ticker)
                logger.warning("ytd_scan.error %s: %s", ticker, e)

    # Sort by YTD % descending (best performers first)
    results.sort(key=lambda x: x["ytd_pct"], reverse=True)

    # Store results in DB
    _store_results(results)

    # Wire into rankings table for trend tracking
    alerts = []
    for r in results:
        alerts.append({
            "ticker": r["ticker"],
            "company": r.get("company", ""),
            "sector": r.get("sector", ""),
            "conviction": "",
            "score": r["ytd_pct"],  # YTD % becomes the scan_score
        })

    # Snapshot previous ranks before updating (first scan of day)
    if needs_trend_snapshot("ytd"):
        update_trend_snapshots("ytd")

    # Update rankings (this handles upserts, exits, rank assignment)
    if alerts:
        attempted = {r["ticker"] for r in results}
        update_rankings(alerts, "ytd", attempted_tickers=attempted)

    # Persist scan completion timestamp
    set_last_scan_completed_at("ytd", datetime.now().isoformat())

    # Attach the stored rank to each result so daily snapshots track rank movement
    with get_connection() as conn:
        rank_rows = conn.execute(
            "SELECT ticker, current_rank FROM rankings WHERE scan_type = 'ytd' AND exit_date IS NULL"
        ).fetchall()
    rank_map = {row["ticker"]: row["current_rank"] for row in rank_rows}
    for r in results:
        r["rank"] = rank_map.get(r["ticker"])

    # Record daily snapshot history (including rank) for chart tracking
    record_ytd_snapshots(results)

    result = {
        "results": results,
        "total": len(results),
        "universe_size": len(tickers),
        "errors": len(errors),
        "year": current_year,
        "scanned_at": datetime.now().isoformat(),
        "cached": False,
    }

    # Update cache
    _scan_cache = result
    _scan_cache_time = time.time()

    return result


def _store_results(results: list[dict]) -> None:
    """Store scan results in ytd_scan table."""
    with get_connection() as conn:
        # Clear old results
        conn.execute("DELETE FROM ytd_scan")

        # Insert new results
        for r in results:
            conn.execute(
                """INSERT OR REPLACE INTO ytd_scan
                   (ticker, ytd_pct, price, year_start_close, scanned_at)
                   VALUES (?, ?, ?, ?, ?)""",
                (
                    r["ticker"],
                    r["ytd_pct"],
                    r["price"],
                    r["year_start_close"],
                    datetime.now().isoformat(),
                ),
            )


def record_ytd_snapshots(results: list[dict]) -> None:
    today = datetime.now().strftime("%Y-%m-%d")
    saved = 0
    try:
        with get_connection() as conn:
            for i, r in enumerate(results, start=1):
                ticker = r.get("ticker")
                ytd_pct = r.get("ytd_pct", 0)
                price = r.get("price", 0)
                rank = r.get("rank", i)
                if not ticker:
                    continue
                conn.execute(
                    """INSERT INTO ytd_scan_snapshots (ticker, date, ytd_pct, price, rank)
                       VALUES (?, ?, ?, ?, ?)
                       ON CONFLICT(ticker, date) DO UPDATE SET
                           ytd_pct = excluded.ytd_pct,
                           price = excluded.price,
                           rank = excluded.rank""",
                    (ticker, today, ytd_pct, price, rank),
                )
                saved += 1
        logger.info("record_ytd_snapshots: saved %d snapshots for %s", saved, today)
    except Exception as e:
        logger.warning("record_ytd_snapshots failed: %s", e)


def get_ytd_rankings() -> list[dict]:
    """Get YTD rankings from the rankings table with trend data.

    Trend threshold: only show up/down if rank changed by 2+ positions.
    Smaller changes are tagged as 'flat'.
    """
    TREND_THRESHOLD = 2

    with get_connection() as conn:
        rows = conn.execute("""
            SELECT r.*, y.year_start_close, y.price
            FROM rankings r
            LEFT JOIN ytd_scan y ON r.ticker = y.ticker
            WHERE r.scan_type = 'ytd' AND r.exit_date IS NULL
            ORDER BY r.scan_score DESC
        """).fetchall()

    result = []
    for i, row in enumerate(rows):
        d = dict(row)
        current_rank = i + 1
        d["current_rank"] = current_rank

        previous_rank = d.get("previous_rank")
        if previous_rank is None:
            d["trend_direction"] = "new"
            d["trend_change"] = 0
        else:
            previous_rank = int(previous_rank)
            change = abs(current_rank - previous_rank)
            if change < TREND_THRESHOLD:
                d["trend_direction"] = "flat"
                d["trend_change"] = 0
            elif current_rank < previous_rank:
                d["trend_direction"] = "up"
                d["trend_change"] = change
            elif current_rank > previous_rank:
                d["trend_direction"] = "down"
                d["trend_change"] = change
            else:
                d["trend_direction"] = "flat"
                d["trend_change"] = 0

        # Map scan_score back to ytd_pct for the frontend
        d["ytd_pct"] = d.get("scan_score", 0)
        result.append(d)

    return result
