"""
reversal_scanner.py — Reversal scanner orchestrator.

Full pipeline:
  1. Get universe (default + custom)
  2. Fetch 90-day OHLCV data
  3. Score each candidate (5-criterion reversal scoring)
  4. Return structured results
"""

import time
import logging
from datetime import datetime, timedelta

import numpy as np
import pytz
import yfinance as yf

from config import UNIVERSE_SECTORS, SUB_SECTOR_MAP
from data.fetcher import get_cached_earnings_dates, latest_scanner_session_date, valid_scanner_frame
from services.universe import get_merged_universe_with_metadata, get_merged_company_names
from services.reversal_scoring import score_reversal, MIN_ROWS

logger = logging.getLogger(__name__)

_EST = pytz.timezone("America/New_York")

_FETCH_PERIOD = "90d"
_CONVICTION_ORDER = {"STRONG": 0, "WATCH": 1}

# ── Scan result cache ─────────────────────────────────────────────────────────
_SCAN_CACHE_TTL = 1800  # 30 minutes
_scan_cache = {"reversal": None}
_scan_cache_time = {"reversal": 0.0}


def _to_native(val):
    """Convert numpy types to native Python types for JSON/SQLite safety."""
    if isinstance(val, (np.integer,)):
        return int(val)
    if isinstance(val, (np.floating,)):
        return float(val)
    if isinstance(val, (np.bool_,)):
        return bool(val)
    return val


def _last_trading_day(today):
    """Return the most recent trading session before today.

    Skips weekends:
      Monday  -> Friday (3 days back)
      Sunday  -> Friday (2 days back)
      Other   -> yesterday (1 day back)
    """
    if today.weekday() == 0:  # Monday
        return today - timedelta(days=3)
    elif today.weekday() == 6:  # Sunday
        return today - timedelta(days=2)
    else:
        return today - timedelta(days=1)


def _fetch_ohlcv(tickers: list[str], session_date=None) -> dict:
    """Batch-download 90-day OHLCV for the full universe."""
    results = {}
    if not tickers:
        return results

    try:
        raw = yf.download(
            " ".join(tickers), period=_FETCH_PERIOD, interval="1d",
            group_by="ticker", auto_adjust=True, progress=False, threads=True
        )
    except Exception as e:
        logger.error(f"Reversal yfinance batch failed: {e}")
        return results

    for ticker in tickers:
        try:
            df = raw[ticker] if len(tickers) > 1 else raw
            df = valid_scanner_frame(df, ticker, session_date)
            if df is None or len(df) < MIN_ROWS:
                continue

            closes = df["Close"].values.astype(float)
            highs = df["High"].values.astype(float)
            lows = df["Low"].values.astype(float)
            volumes = df["Volume"].values.astype(float)

            price = round(float(closes[-1]), 2)
            ret_5d = round(
                (float(closes[-1]) - float(closes[-6])) / float(closes[-6]) * 100
                if float(closes[-6]) > 0 else 0.0, 2
            )

            results[ticker] = {
                "price": price,
                "closes": closes,
                "highs": highs,
                "lows": lows,
                "volumes": volumes,
                "ret_5d": ret_5d,
            }
        except Exception as e:
            logger.warning(f"Reversal fetch {ticker}: {e}")

    return results


def run_reversal_scan(force: bool = False, session_date=None) -> dict:
    """
    Run full reversal scan pipeline.

    Returns:
        {
            "results": [...],
            "total": int,
            "universe_size": int,
            "scan_time": float,
        }
    """
    t0 = time.time()
    session_date = session_date or latest_scanner_session_date()

    # Return cached results unless force-refresh requested OR TTL expired
    age = time.time() - _scan_cache_time.get("reversal", 0.0)
    if (not force and _scan_cache["reversal"] is not None and age < _SCAN_CACHE_TTL
            and _scan_cache["reversal"].get("session_date") == session_date.isoformat()):
        logger.info("Returning cached reversal scan results (cached %ds ago)", int(age))
        cached = _scan_cache["reversal"].copy()
        cached["cached"] = True
        return cached

    logger.info("Starting reversal scan")

    # Step 1: Get universe
    universe_metadata = get_merged_universe_with_metadata()
    universe = [m["ticker"] for m in universe_metadata if m.get("sector") != "ETF"]
    company_names = get_merged_company_names()
    logger.info(f"Universe: {len(universe)} tickers")

    # Step 2: Fetch OHLCV data
    stock_data = _fetch_ohlcv(universe, session_date=session_date)
    attempted_tickers = set(stock_data.keys())
    logger.info(f"Stock data: {len(stock_data)} tickers retrieved")
    if len(stock_data) < len(universe) * 0.9:
        raise RuntimeError("Reversal daily bars not ready: %d/%d for %s" %
                           (len(stock_data), len(universe), session_date))

    # Step 2.5: Check earnings landmines
    today = session_date
    landmines = get_cached_earnings_dates(universe)
    last_session = _last_trading_day(today)
    earnings_exclude = {
        lm["ticker"]
        for lm in landmines
        if lm.get("date_obj") is not None
        and last_session <= lm["date_obj"] <= today
    }
    logger.info(f"Earnings exclusions: {len(earnings_exclude)} tickers")

    # Step 3: Score each candidate
    # Scores >= 3 go to `results` (qualified board). Scores < 3 go to
    # `below_threshold` (grey rows pinned at the bottom of the board).
    results = []
    below_threshold = []
    for ticker, data in stock_data.items():
        if ticker in earnings_exclude:
            continue
        company = company_names.get(ticker, ticker)
        raw_sector = UNIVERSE_SECTORS.get(ticker, "Unknown")
        sector = SUB_SECTOR_MAP.get(raw_sector, raw_sector)
        if sector == "Unknown":
            logger.warning("Reversal scan: unmapped sector for %s (raw=%s)", ticker, raw_sector)

        # Score using 5-criterion grid - no pre-filtering.
        # return_below=True surfaces sub-threshold scores as LOW instead of None.
        result = score_reversal(
            closes=data["closes"],
            highs=data["highs"],
            lows=data["lows"],
            volumes=data["volumes"],
            has_hard_catalyst=False,  # Can be set True if news/catalyst available
            return_below=True,
        )

        # score_reversal returns None only if data is insufficient (< MIN_ROWS)
        if result is None:
            continue

        score, conviction, criteria, metrics = result

        # Grey watch rows must have an actual reversal setup, not merely be
        # members of the scanned universe with unrelated low scores.
        if not (criteria["downtrend_confirmed"] and criteria["reversal_trigger"]):
            continue

        # Convert numpy types to native Python types for JSON/SQLite safety
        score = _to_native(score)
        criteria = {k: _to_native(v) for k, v in criteria.items()}
        metrics = {k: _to_native(v) for k, v in metrics.items()}

        entry = {
            "ticker": ticker,
            "company": company,
            "sector": sector,
            "price": float(data["price"]),
            "ret_5d": float(data["ret_5d"]),
            "ret_20d": float(metrics["ret_20d"]),
            "sma20": float(metrics["sma20"]),
            "sma20_slope": float(metrics["sma20_slope"]),
            "sma20_flattening": bool(metrics["sma20_flattening"]),
            "sma50": float(metrics["sma50"]),
            "sma50_slope": float(metrics["sma50_slope"]),
            "three_higher_closes": bool(metrics["three_higher_closes"]),
            "single_candle": bool(metrics["single_candle"]),
            "atr14": float(metrics["atr14"]),
            "atr_move": float(metrics["atr_move"]),
            "vol_ratio": float(metrics["vol_ratio"]),
            "vol_today": int(metrics["vol_today"]),
            "vol_avg_20d": int(metrics["vol_avg_20d"]),
            "close_vs_sma20": float(metrics["close_vs_sma20"]),
            "high_10d": float(metrics["high_10d"]),
            "strong_close": bool(metrics["strong_close"]),
            "score": score,
            "conviction": str(conviction),
            "criteria": criteria,
        }

        if int(score) < 3:
            entry["below_threshold"] = True
            below_threshold.append(entry)
            continue

        results.append(entry)

    # Sort by conviction (STRONG first), then by score descending
    results.sort(key=lambda x: (_CONVICTION_ORDER.get(x["conviction"], 2), -x["score"]))
    below_threshold.sort(key=lambda x: -x["score"])

    scan_time = time.time() - t0
    logger.info(f"Reversal scan complete: {len(results)} results in {scan_time:.2f}s")

    result = {
        "results": results,
        "total": len(results),
        "below_threshold": below_threshold,
        "below_total": len(below_threshold),
        "universe_size": len(universe),
        "session_date": session_date.isoformat(),
        "scan_time": round(scan_time, 2),
        "cached": False,
        "attempted_tickers": list(attempted_tickers),
    }

    # Cache the result for subsequent non-forced calls
    _scan_cache["reversal"] = result
    _scan_cache_time["reversal"] = time.time()

    return result
