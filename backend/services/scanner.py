"""
scanner.py — Momentum scanner orchestrator.

Full pipeline:
  1. Get universe (default + custom)
  2. Fetch stock data (35d OHLCV with technicals)
  3. Fetch index performance (SP500, Nasdaq, Dow, Russell)
  4. Fetch sector ETF performance
  5. Check earnings landmines (exclude today/last session)
  6. Filter candidates (volume surge, gap up, ATR expansion)
  7. Score each candidate (7-criterion, no C2)
  8. Return structured results with verdict

Skipped per user decision:
  - LLM catalyst analysis (C2 — requires external API)
  - News headline matching
"""

import logging
import time
from datetime import datetime, timedelta

import pytz

from config import UNIVERSE_SECTORS, SUB_SECTOR_MAP as _SUB_SECTOR_MAP
from data.fetcher import (
    fetch_earnings_dates,
    get_cached_earnings_dates,
    fetch_index_performance,
    fetch_sector_performance,
    fetch_stock_data,
    latest_scanner_session_date,
)
from services.scoring import score_stock
from services.universe import get_merged_company_names, get_merged_universe_with_metadata

logger = logging.getLogger(__name__)
_EST = pytz.timezone("America/New_York")

# ── Scan result cache ─────────────────────────────────────────────────────────
_SCAN_CACHE_TTL = 1800  # 30 minutes
_scan_cache = {"momentum": None, "reversal": None}  # "reversal" key reserved for potential shared cache; reversal_scanner.py uses independent cache
_scan_cache_time = {"momentum": 0.0, "reversal": 0.0}


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


def run_momentum_scan(force: bool = False, session_date=None) -> dict:
    """Run full momentum scan pipeline.

    Parameters
    ----------
    force : bool
        When True, bypass cache and fetch fresh data from yfinance.

    Returns
    -------
    dict
        {
            "results":      list[dict],  # scored candidates sorted by score desc
            "total":        int,         # number of qualifying results
            "universe_size": int,        # total tickers scanned
            "scan_time":    float,       # wall-clock seconds
            "cached":       bool,        # whether cache was used
            "market_perf":  float,       # SP500 day %
            "indices":      dict,        # index performance map
            "sector_perf":  dict,        # sector performance map
        }
    """
    t0 = time.time()
    session_date = session_date or latest_scanner_session_date()
    today = session_date

    # Return cached results unless force-refresh requested OR TTL expired
    age = time.time() - _scan_cache_time.get("momentum", 0.0)
    if (not force and _scan_cache["momentum"] is not None and age < _SCAN_CACHE_TTL
            and _scan_cache["momentum"].get("session_date") == session_date.isoformat()):
        logger.info("Returning cached momentum scan results (cached %ds ago)", int(age))
        cached = _scan_cache["momentum"].copy()
        cached["cached"] = True
        return cached

    logger.info("Starting momentum scan — %s", today)

    # ── Step 1: Universe ───────────────────────────────────────────────────
    universe_metadata = get_merged_universe_with_metadata()
    universe = [m["ticker"] for m in universe_metadata if m.get("sector") != "ETF"]
    company_names = get_merged_company_names()
    logger.info("Universe: %d tickers", len(universe))

    if not universe:
        logger.warning("Empty universe — scan aborted")
        return {
            "results": [],
            "total": 0,
            "universe_size": 0,
            "session_date": session_date.isoformat(),
            "attempted_tickers": [],
            "scan_time": round(time.time() - t0, 2),
            "cached": False,
            "market_perf": 0.0,
            "indices": {},
            "sector_perf": {},
        }

    # ── Step 2: Fetch stock data (35d OHLCV + technicals) ──────────────────
    stock_data = fetch_stock_data(universe, session_date=session_date)
    attempted_tickers = set(stock_data.keys())
    logger.info("Stock data: %d tickers retrieved", len(stock_data))
    if len(stock_data) < len(universe) * 0.9:
        raise RuntimeError("Momentum daily bars not ready: %d/%d for %s" %
                           (len(stock_data), len(universe), session_date))

    # ── Step 3: Fetch index performance ─────────────────────────────────────
    indices = fetch_index_performance(session_date=session_date)
    if "SP500" not in indices:
        raise RuntimeError("Momentum market daily bar not ready for %s" % session_date)
    market_perf = indices.get("SP500", {}).get("pct", 0.0)
    logger.info(
        "Market performance: SP500 %+.2f%%", market_perf
    )

    # ── Step 4: Fetch sector ETF performance ────────────────────────────────
    sector_perf_raw = fetch_sector_performance(session_date=session_date)
    # Keep full object structure for frontend heatmap display
    sector_perf = sector_perf_raw if isinstance(sector_perf_raw, dict) else {}
    if len(sector_perf) < 8:
        raise RuntimeError("Momentum sector daily bars not ready: %d sectors for %s" %
                           (len(sector_perf), session_date))
    # Also create a flat version for scoring (extract change_pct)
    sector_perf_flat = {
        sector: data.get("change_pct", 0.0) if isinstance(data, dict) else 0.0
        for sector, data in sector_perf.items()
    }
    logger.info("Sector performance: %d sectors", len(sector_perf))

    # Compute sector ranks by day% (1 = best performing sector)
    sorted_sectors = sorted(sector_perf_flat.items(), key=lambda x: x[1], reverse=True)
    sector_ranks = {sector: rank + 1 for rank, (sector, _) in enumerate(sorted_sectors)}

    # ── Step 5: Check earnings landmines ────────────────────────────────────
    # Exclude tickers with earnings on last trading session or today (EST).
    # Tomorrow is intentionally excluded — swing/position trade focus means a
    # stock reporting tomorrow after-close is still a valid setup today.
    landmines = get_cached_earnings_dates(universe)
    last_session = _last_trading_day(today)

    earnings_exclude = {
        lm["ticker"]
        for lm in landmines
        if lm.get("date_obj") is not None
        and last_session <= lm["date_obj"] <= today
    }
    logger.info("Earnings exclusions: %d tickers", len(earnings_exclude))

    # ── Step 6: Filter candidates ───────────────────────────────────────────
    # Long setups only — bearish days belong in a separate pipeline.
    # Filter rationale:
    #   vol_ratio >= 1.5  — raised from 1.2x to cut noise, real interest only
    #   day_pct > 0       — global gate: no candidates on a down day
    #   gap_pct >= 2.0    — gap UP only (gap-down is not a long setup)
    #   ATR expansion     — positive volatility expansion only (bullish)
    candidates = [
        t
        for t, d in stock_data.items()
        if t not in earnings_exclude
        and d["day_pct"] > 0
        and (
            d["day_pct"] >= max(1.0, d["atr_pct"] * 0.8)
            or d["price"] > d["high_20d_prior"]
        )
        and (
            d["vol_ratio"] >= 1.2 or d["price"] > d["high_20d_prior"]
        )
    ]
    logger.info("Candidates: %d", len(candidates))

    # ── Step 7: Score each candidate (7-criterion, no C2) ───────────────────
    # Scores >= 3 go to `results` (qualified board). Scores < 3 go to
    # `below_threshold` (grey rows pinned at the bottom of the board so the
    # full board stays visible instead of tickers winking on/off).
    results = []
    below_threshold = []
    for ticker in candidates:
        d = stock_data[ticker]
        company = company_names.get(ticker, ticker)

        # Look up sector performance for this ticker's sector
        raw_sector = UNIVERSE_SECTORS.get(ticker, "Unknown")
        sector = _SUB_SECTOR_MAP.get(raw_sector, raw_sector)
        if sector == "Unknown":
            logger.warning("Momentum scan: unmapped sector for %s (raw=%s)", ticker, raw_sector)
        s_perf = sector_perf_flat.get(sector, 0.0)
        sector_rank = sector_ranks.get(sector, 99)

        score, conviction, criteria = score_stock(
            day_pct=d["day_pct"],
            week_pct=d["week_pct"],
            month_pct=d["month_pct"],
            vol_ratio=d["vol_ratio"],
            price=d["price"],
            high_52w=d["high_52w"],
            sector_perf=s_perf,
            market_perf=market_perf,
            sector_rank=sector_rank,
            close_position=d["close_position"],
            is_bearish=False,
            sma20=d["sma20"],
            sma20_slope=d["sma20_slope"],
            gap_pct=d.get("gap_pct", 0.0),
            high_20d_prior=d["high_20d_prior"],
        )

        # Determine verdict
        if score >= 5:
            verdict = "YES"
        elif score >= 3:
            verdict = "WATCH"
        else:
            verdict = "NO"

        entry = {
            "ticker": ticker,
            "company": company,
            "sector": sector,
            "price": d["price"],
            "day_change_pct": d["day_pct"],
            "week_change_pct": d["week_pct"],
            "month_pct": d["month_pct"],
            "volume_ratio": d["vol_ratio"],
            "score": score,
            "conviction": conviction,
            "verdict": verdict,
            "criteria": criteria,
            "sma20": d["sma20"],
            "sma20_slope": d["sma20_slope"],
            "above_sma20": d["above_sma20"],
        }

        if conviction not in ("HIGH", "MODERATE"):
            entry["below_threshold"] = True
            below_threshold.append(entry)
            continue

        results.append(entry)

    # Sort by score descending (best setups first)
    results.sort(key=lambda x: x["score"], reverse=True)
    below_threshold.sort(key=lambda x: x["score"], reverse=True)

    scan_time = time.time() - t0
    logger.info(
        "Scan complete: %d results in %.2fs", len(results), scan_time
    )

    result = {
        "results": results,
        "total": len(results),
        "below_threshold": below_threshold,
        "below_total": len(below_threshold),
        "universe_size": len(universe),
        "session_date": session_date.isoformat(),
        "scan_time": round(scan_time, 2),
        "cached": False,
        "market_perf": market_perf,
        "indices": indices,
        "sector_perf": sector_perf,
        "attempted_tickers": list(attempted_tickers),
    }

    # Cache the result for subsequent non-forced calls
    _scan_cache["momentum"] = result
    _scan_cache_time["momentum"] = time.time()

    return result
