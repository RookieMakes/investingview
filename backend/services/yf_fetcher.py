"""
yf_fetcher.py — Fetch real market data using yfinance.

Fetches actual OHLCV prices, earnings dates, momentum scores,
and relative strength for the earnings dashboard. Falls back
gracefully if yfinance is unavailable or a fetch fails.
"""

import time
import logging
from datetime import datetime, timezone

import yfinance as yf
import pandas as pd

from services.dashboard import (
    upsert_stock, upsert_price, upsert_earnings,
    upsert_momentum, set_last_fetch,
    upsert_earnings_announcement,
)
from data.fetcher import _write_candles
from models.db import get_connection
from services.universe import get_merged_universe_with_metadata


def _compute_rank(pct_changes: list[float]) -> tuple[int, int]:
    """Compute rank score and streak from pct_changes (oldest first).

    +1 per green day, -1 per red day.
    Extra weight for last 3 days. Alternation penalty.
    Streak = consecutive same-direction days from today backward.
    """
    if not pct_changes:
        return 0, 0

    threshold = 0.15
    days = [
        1 if p > threshold else (-1 if p < -threshold else 0)
        for p in pct_changes
    ]

    score = 0
    n = len(days)
    for i, d in enumerate(days):
        weight = 2 if i >= n - 3 else 1
        score += d * weight

    # Alternation penalty
    alternations = 0
    for i in range(1, len(days)):
        if days[i] != 0 and days[i - 1] != 0 and days[i] != days[i - 1]:
            alternations += 1
    penalty = alternations // 2
    score -= penalty

    # Streak from most recent backward
    streak = 0
    if days:
        direction = days[-1]
        for d in reversed(days):
            if d == direction and d != 0:
                streak += 1
            else:
                break
        if direction == -1:
            streak = -streak

    return score, streak


def _compute_rs(stock_returns: list[float], sp_returns: list[float]) -> float:
    """Relative strength vs SPY over last 10 sessions."""
    if not stock_returns or not sp_returns:
        return 0
    n = min(len(stock_returns), len(sp_returns))
    stock_sum = sum(float(x) for x in stock_returns[-n:])
    sp_sum = sum(float(x) for x in sp_returns[-n:])
    return round(stock_sum - sp_sum, 2)

logger = logging.getLogger(__name__)

BATCH_SIZE = 10
BATCH_DELAY = 2  # seconds between batches


def _is_market_day() -> bool:
    """Return True if today is a weekday (Mon-Fri) in Eastern Time."""
    from zoneinfo import ZoneInfo
    return datetime.now(ZoneInfo("America/New_York")).weekday() < 5


def _try_archive_earnings(symbol: str, today) -> bool:
    """Try to archive a passed earnings date; report whether to hold the old row.

    Returns True when dash_earnings holds a past date with no archived
    beat/miss yet — caller should keep pinning plain E instead of
    overwriting with a stale/empty read. Returns False otherwise
    (nothing passed, already archived, or just archived now).

    Shared by refresh_earnings_dates() and refresh_earnings_data() so the
    morning job cannot bypass the Monday-night hold.
    """
    try:
        with get_connection() as conn:
            old_row = conn.execute(
                "SELECT earnings_date FROM dash_earnings WHERE symbol = ?", (symbol,)
            ).fetchone()

        if not old_row or not old_row["earnings_date"]:
            return False
        old_date_str = old_row["earnings_date"]
        try:
            old_dt = datetime.strptime(old_date_str, "%Y-%m-%d").date()
        except (ValueError, TypeError):
            return False
        if old_dt >= today:
            return False

        # Date has passed — archive it with beat/miss from quarterly_earnings
        with get_connection() as conn:
            qe_row = conn.execute(
                "SELECT earnings_date, eps_actual, eps_estimate, surprise_pct "
                "FROM quarterly_earnings "
                "WHERE symbol = ? AND earnings_date <= ? "
                "ORDER BY earnings_date DESC LIMIT 1",
                (symbol, old_date_str),
            ).fetchone()

        if qe_row:
            with get_connection() as conn:
                existing = conn.execute(
                    "SELECT 1 FROM earnings_announcements "
                    "WHERE symbol = ? AND announcement_date = ?",
                    (symbol, old_date_str),
                ).fetchone()
            if not existing:
                upsert_earnings_announcement(
                    symbol,
                    announcement_date=old_date_str,
                    quarter_end_date=qe_row["earnings_date"],
                    eps_actual=qe_row["eps_actual"],
                    eps_estimate=qe_row["eps_estimate"],
                    surprise_pct=qe_row["surprise_pct"],
                )
                logger.info(
                    "Archived earnings for %s: %s (QE: %s)",
                    symbol, old_date_str, qe_row["earnings_date"],
                )
            return False

        # No quarterly beat/miss yet — hold unless already archived before.
        with get_connection() as conn:
            existing = conn.execute(
                "SELECT 1 FROM earnings_announcements "
                "WHERE symbol = ? AND announcement_date = ?",
                (symbol, old_date_str),
            ).fetchone()
        if not existing:
            logger.info(
                "Holding earnings date for %s: %s (no quarterly beat/miss yet)",
                symbol, old_date_str,
            )
            return True
        return False
    except Exception as e:
        logger.warning("Failed to archive past earnings for %s: %s", symbol, e)
        return False


def _fetch_batch(symbols: list[str], period: str = "1mo") -> dict:
    """Fetch OHLCV for a batch of symbols using yfinance download.

    Args:
        symbols: List of ticker symbols to fetch.
        period: yfinance period string (e.g. "1mo", "3mo").

    Returns:
        Raw DataFrame from yf.download, or empty dict on failure.
    """
    try:
        logger.info("Fetching batch: %s", symbols)
        data = yf.download(
            tickers=" ".join(symbols),
            period=period,
            interval="1d",
            group_by="ticker",
            auto_adjust=True,
            progress=False,
            threads=True,
        )
        return data
    except Exception as e:
        logger.error("Batch fetch error: %s", e)
        return {}


def _get_earnings_date(symbol: str) -> str | None:
    """Get next earnings date for a symbol via yfinance calendar.

    Returns:
        Date string "YYYY-MM-DD" or None if unavailable.
    """
    try:
        tk = yf.Ticker(symbol)
        cal = tk.calendar
        if cal is None:
            return None
        if isinstance(cal, dict):
            ed = cal.get("Earnings Date")
            if ed:
                if isinstance(ed, list) and len(ed) > 0:
                    return pd.Timestamp(ed[0]).strftime("%Y-%m-%d")
                return pd.Timestamp(ed).strftime("%Y-%m-%d")
        if isinstance(cal, pd.DataFrame):
            if "Earnings Date" in cal.index:
                val = cal.loc["Earnings Date"].values
                if len(val) > 0:
                    return pd.Timestamp(val[0]).strftime("%Y-%m-%d")
        return None
    except Exception as e:
        msg = str(e)
        if "404" in msg or "Not Found" in msg:
            logger.debug("No earnings date for %s (ETF/non-earnings instrument): %s", symbol, msg)
        else:
            logger.warning("Earnings date error for %s: %s", symbol, e)
        return None


def fetch_quarterly_earnings(symbol: str) -> list[dict]:
    """Fetch quarterly earnings history for a symbol via yfinance.

    Uses yfinance's earnings_history which returns past quarterly EPS data.

    Returns:
        List of dicts with keys: earnings_date, eps_actual, eps_estimate, surprise_pct.
        Empty list if no data available.
    """
    try:
        tk = yf.Ticker(symbol)
        history = tk.earnings_history
        if history is None or (hasattr(history, 'empty') and history.empty):
            return []

        results = []
        for idx, row in history.iterrows():
            # idx is the quarter end date (e.g. Timestamp('2025-09-30'))
            date_str = idx.strftime("%Y-%m-%d") if hasattr(idx, "strftime") else str(idx)[:10]
            eps_actual = float(row.get("epsActual", 0) or 0)
            eps_estimate = float(row.get("epsEstimate", 0) or 0)
            surprise_pct = float(row.get("surprisePercent", 0) or 0) * 100  # convert from decimal to percentage

            results.append({
                "earnings_date": date_str,
                "eps_actual": eps_actual,
                "eps_estimate": eps_estimate,
                "surprise_pct": round(surprise_pct, 2),
            })

        return results
    except Exception as e:
        msg = str(e)
        if "404" in msg or "Not Found" in msg:
            logger.debug("No quarterly earnings for %s: %s", symbol, msg)
        else:
            logger.warning("Quarterly earnings error for %s: %s", symbol, e)
        return []


def refresh_earnings_dates() -> dict:
    """Refresh next earnings dates for all universe tickers.

    Fetches from yfinance for ALL tickers to ensure dates are always current.
    Stores in dash_earnings. Runs weekly on Mondays at 4 PM ET.

    Returns:
        dict with success_count and fail_count.
    """
    from services.universe import get_merged_universe_with_metadata
    from services.dashboard import upsert_earnings
    from datetime import date

    universe_metadata = get_merged_universe_with_metadata()
    symbols = [item["ticker"] for item in universe_metadata if item.get("sector") != "ETF"]
    today = date.today()

    success_count = 0
    fail_count = 0
    hold_count = 0

    for i, symbol in enumerate(symbols):
        hold = _try_archive_earnings(symbol, today)
        try:
            # Fetch first so a rolled next-quarter date always wins over a hold.
            ed = _get_earnings_date(symbol)
            ed_date = None
            days_to = None
            if ed:
                try:
                    ed_date = datetime.strptime(ed, "%Y-%m-%d").date()
                    days_to = (ed_date - today).days
                except Exception:
                    ed_date = None
            if ed_date is not None and ed_date > today:
                # Forward progress wins: future E replaces the pinned plain E
                # (old date already archived above when beat data existed).
                upsert_earnings(symbol, ed, days_to)
                success_count += 1
            elif hold:
                # No forward progress and nothing to archive — keep pinning E.
                hold_count += 1
                success_count += 1
            elif not ed:
                # Never wipe a good row on a transient fetch failure.
                with get_connection() as conn:
                    cur = conn.execute(
                        "SELECT earnings_date FROM dash_earnings WHERE symbol = ?",
                        (symbol,),
                    ).fetchone()
                if cur and cur["earnings_date"]:
                    logger.debug(
                        "Keeping earnings date for %s (transient empty read)", symbol
                    )
                    success_count += 1
                else:
                    upsert_earnings(symbol, ed, days_to)
                    success_count += 1
            else:
                upsert_earnings(symbol, ed, days_to)
                success_count += 1
            if i % 5 == 0:
                time.sleep(1)
        except Exception as e:
            logger.warning("Failed to refresh earnings date for %s: %s", symbol, e)
            fail_count += 1

    logger.info(
        "Earnings date refresh: %d succeeded, %d failed (%d held)",
        success_count, fail_count, hold_count,
    )
    return {"success_count": success_count, "fail_count": fail_count}


def fetch_all_quarterly_earnings() -> dict:
    """Fetch quarterly earnings history for all universe tickers.

    Runs weekly on Mondays at 5:05 PM ET. Fetches for ALL tickers.
    Returns:
        dict with success_count and fail_count.
    """
    from services.universe import get_merged_universe_with_metadata
    from services.dashboard import upsert_quarterly_earnings

    universe_metadata = get_merged_universe_with_metadata()
    symbols = [item["ticker"] for item in universe_metadata if item.get("sector") != "ETF"]

    success_count = 0
    fail_count = 0

    for i, symbol in enumerate(symbols):
        try:
            earnings = fetch_quarterly_earnings(symbol)
            upsert_quarterly_earnings(symbol, earnings)
            success_count += 1
            if i % 5 == 0:
                time.sleep(1)
        except Exception as e:
            logger.warning("Failed to fetch quarterly earnings for %s: %s", symbol, e)
            fail_count += 1

    logger.info(
        "Quarterly earnings fetch complete: %d succeeded, %d failed out of %d tickers.",
        success_count, fail_count, len(symbols),
    )
    return {"success_count": success_count, "fail_count": fail_count}


def refresh_earnings_data() -> dict:
    """Refresh both earnings dates and quarterly earnings history in one pass.

    Merges refresh_earnings_dates() and fetch_all_quarterly_earnings() into a
    single loop to halve API calls (90 vs 180) and wall time. Runs weekly on
    Mondays at 7 PM ET.

    Returns:
        dict with earnings_date_success, earnings_date_fail,
             quarterly_success, quarterly_fail.
    """
    from services.universe import get_merged_universe_with_metadata
    from services.dashboard import upsert_earnings, upsert_quarterly_earnings
    from datetime import date

    universe_metadata = get_merged_universe_with_metadata()
    symbols = [item["ticker"] for item in universe_metadata if item.get("sector") != "ETF"]
    today = date.today()

    ed_success = 0
    ed_fail = 0
    qe_success = 0
    qe_fail = 0
    hold_count = 0

    for i, symbol in enumerate(symbols):
        # --- Quarterly earnings (fetch first — archive logic needs this data) ---
        try:
            earnings = fetch_quarterly_earnings(symbol)
            upsert_quarterly_earnings(symbol, earnings)
            qe_success += 1
        except Exception as e:
            logger.warning("refresh_earnings_data: quarterly earnings failed for %s: %s", symbol, e)
            qe_fail += 1

        # --- Archive past earnings (shared helper so morning job agrees) ---
        hold_old_date = _try_archive_earnings(symbol, today)

        # --- Earnings date: fetch first so a rolled future date always wins ---
        try:
            ed = _get_earnings_date(symbol)
            ed_date = None
            days_to = None
            if ed:
                try:
                    ed_date = datetime.strptime(ed, "%Y-%m-%d").date()
                    days_to = (ed_date - today).days
                except Exception:
                    ed_date = None
            if ed_date is not None and ed_date > today:
                # Forward progress wins over a hold; old date already archived
                # above when beat data existed.
                upsert_earnings(symbol, ed, days_to)
                ed_success += 1
            elif hold_old_date:
                # No forward progress and nothing to archive — keep pinning E.
                hold_count += 1
                ed_success += 1
            elif not ed:
                # Never wipe a good row on a transient fetch failure.
                with get_connection() as conn:
                    cur = conn.execute(
                        "SELECT earnings_date FROM dash_earnings WHERE symbol = ?",
                        (symbol,),
                    ).fetchone()
                if cur and cur["earnings_date"]:
                    logger.debug(
                        "Keeping earnings date for %s (transient empty read)", symbol
                    )
                    ed_success += 1
                else:
                    upsert_earnings(symbol, ed, days_to)
                    ed_success += 1
            else:
                upsert_earnings(symbol, ed, days_to)
                ed_success += 1
        except Exception as e:
            logger.warning("refresh_earnings_data: earnings date failed for %s: %s", symbol, e)
            ed_fail += 1

        if i % 5 == 0:
            time.sleep(1)

    logger.info(
        "Earnings data refresh complete: dates %d/%d, quarterly %d/%d, held %d out of %d tickers.",
        ed_success, ed_fail, qe_success, qe_fail, hold_count, len(symbols),
    )
    return {
        "earnings_date_success": ed_success,
        "earnings_date_fail": ed_fail,
        "quarterly_success": qe_success,
        "quarterly_fail": qe_fail,
    }


BENCHMARK_SYMBOL = "SPY"


def _persist_price_history(sym: str, df) -> tuple[list[dict], list[float], int]:
    """Normalize a fetched OHLCV frame and persist its last 10 sessions.

    Writes both dash_prices (via upsert_price) and candles (via
    _write_candles). Shared by the stock loop and the SPY benchmark
    persist so the Earnings v2 benchmark can never lag the universe by
    design. Returns (candles_list, pct_changes, avg_vol_30d).
    """
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)
    # Drop duplicate columns that can appear after flattening
    if df.columns.duplicated().any():
        df = df.loc[:, ~df.columns.duplicated()]
    # Normalize column names: yfinance sometimes returns lowercase
    # ("close") and sometimes title-case ("Close").
    col_rename = {}
    expected = {"open", "high", "low", "close", "volume"}
    for col in df.columns:
        if col.lower() in expected and col != col.lower().title():
            col_rename[col] = col.lower().title()
    if col_rename:
        df = df.rename(columns=col_rename)
    if "Close" not in df.columns:
        raise ValueError(f"No 'Close' column for {sym} — columns: {list(df.columns)}")
    # Compute pct_change on the FULL date range first so the oldest
    # row in the tail still has a correct prior-day reference.
    df = df.dropna(subset=["Close"])
    df["pct_change"] = df["Close"].pct_change() * 100
    try:
        avg_vol_30d = int(df["Volume"].tail(30).mean())
    except Exception:
        avg_vol_30d = 0
    df = df.tail(10)
    df = df.fillna(0)
    candles_list = []
    pct_changes = []
    for idx, row in df.iterrows():
        date_str = (
            idx.strftime("%Y-%m-%d")
            if hasattr(idx, "strftime")
            else str(idx)[:10]
        )
        upsert_price(
            sym, date_str,
            float(row.get("Open", 0) or 0),
            float(row.get("High", 0) or 0),
            float(row.get("Low", 0) or 0),
            float(row.get("Close", 0) or 0),
            int(row.get("Volume", 0) or 0),
            float(row.get("pct_change", 0) or 0),
        )
        pct_changes.append(float(row.get("pct_change", 0) or 0))
        candles_list.append({
            "date": date_str,
            "open": float(row.get("Open", 0) or 0),
            "high": float(row.get("High", 0) or 0),
            "low": float(row.get("Low", 0) or 0),
            "close": float(row.get("Close", 0) or 0),
            "volume": int(row.get("Volume", 0) or 0),
        })
    _write_candles(sym, candles_list)
    return candles_list, pct_changes, avg_vol_30d


def fetch_all() -> dict:
    """Fetch real market data for all tickers and upsert into dashboard tables.

    This is the main entry point. It:
    1. Fetches SPY for relative strength baseline
    2. Downloads OHLCV data in batches of 10
    3. Fetches earnings dates one by one
    4. Computes momentum (rank_score, streak, RS)
    5. Upserts everything into the dashboard tables

    Returns:
        dict with keys:
          - "status": "complete" | "skipped"
          - "reason": str (only when skipped)
          - "success_count": int (only when complete)
          - "fail_count": int (only when complete)

    Raises:
        Exception: If critical failures occur (caller should catch and fallback).
    """
    logger.info("Starting yfinance data fetch...")
    if not _is_market_day():
        logger.info("Weekend — skipping yfinance fetch.")
        return {"status": "skipped", "reason": "Market closed — next refresh on next trading day"}

    universe_metadata = get_merged_universe_with_metadata()
    etf_tickers = [m["ticker"] for m in universe_metadata if m.get("sector") == "ETF"]
    universe_metadata = [m for m in universe_metadata if m.get("sector") != "ETF"]
    symbols = [item["ticker"] for item in universe_metadata]
    logger.info("Filtered %d ETF tickers from dashboard fetch", len(etf_tickers))
    ticker_map = {item["ticker"]: item for item in universe_metadata}
    # The Earnings v2 benchmark must be persisted every session even though
    # SPY itself stays out of dash_stocks/dash_momentum and the display
    # universe (it is sector='ETF'). Fetch it alongside the stocks; the
    # Step 3 benchmark block persists only its prices/candles.
    fetch_symbols = symbols if BENCHMARK_SYMBOL in symbols else symbols + [BENCHMARK_SYMBOL]

    # ── Step 1: Fetch SPY for relative strength baseline ──────────────────
    spy_raw = None
    spy_data = None
    try:
        spy_raw = yf.download(
            "SPY", period="1mo", interval="1d",
            auto_adjust=True, progress=False,
        )
        if not spy_raw.empty:
            spy_close = spy_raw["Close"]
            # Newer yfinance returns MultiIndex columns → ["Close"] is a
            # 1-column DataFrame, not a Series. squeeze() normalises both.
            if isinstance(spy_close, pd.DataFrame):
                spy_close = spy_close.squeeze(axis=1)
            spy_data = spy_close.pct_change().dropna() * 100
    except Exception as e:
        logger.warning("SPY fetch failed: %s", e)

    # ── Step 2: Fetch OHLCV in batches ───────────────────────────────────
    all_data: dict[str, pd.DataFrame] = {}
    batches = [fetch_symbols[i:i + BATCH_SIZE] for i in range(0, len(fetch_symbols), BATCH_SIZE)]

    for batch in batches:
        raw = _fetch_batch(batch, period="1mo")
        if raw is not None and not (hasattr(raw, "empty") and raw.empty):
            for sym in batch:
                try:
                    if len(batch) == 1:
                        df = raw
                    else:
                        if sym in raw.columns.get_level_values(0):
                            df = raw[sym]
                        elif hasattr(raw.columns, "levels") and sym in raw.columns.get_level_values(1):
                            df = raw.xs(sym, level=1, axis=1)
                        else:
                            continue

                    if df is not None and not df.empty:
                        all_data[sym] = df
                except Exception as e:
                    logger.warning("Extract error %s: %s", sym, e)
        time.sleep(BATCH_DELAY)

    # ── Step 3: Process and store ─────────────────────────────────────────
    # NOTE on timing: this job runs at 16:05 ET — deliberately *before*
    # Yahoo flips today's daily bar to NaN-Close (settlement window).
    # That way dash_prices/candles capture today's partial close, which
    # get_quotes() later uses as backfill when fresh batch downloads show
    # NaN.  Do NOT move this later into the evening without also handling
    # the NaN window here.
    today = datetime.now().date()
    success_count = 0
    fail_count = 0
    quotes_to_write: list[dict] = []

    for info in universe_metadata:
        sym = info["ticker"]
        upsert_stock(sym, info["company_name"], info["sector"])

        df = all_data.get(sym)
        if df is None or df.empty:
            logger.warning("No price data for %s", sym)
            fail_count += 1
            continue

        try:
            candles_list, pct_changes, avg_vol_30d = _persist_price_history(sym, df)

            # ── Keep quotes table in sync from the same fetch ─────────
            # Portfolio/PnL-snapshot read via get_quotes(); without this the
            # quotes cache can lag dash_prices by a full session (it is only
            # refreshed on demand with a 5-min TTL).  Writing here makes the
            # 16:05 ET job the single source of today's close for both paths.
            try:
                if candles_list:
                    last = candles_list[-1]
                    prev_close = candles_list[-2]["close"] if len(candles_list) >= 2 else last["close"]
                    chg = ((last["close"] - prev_close) / prev_close * 100) if prev_close else 0.0
                    quotes_to_write.append({
                        "ticker": sym,
                        "price": round(float(last["close"]), 4),
                        "change_pct": round(float(chg), 4),
                        "volume": int(last["volume"]),
                        "avg_volume_30d": avg_vol_30d,
                        "market_state": None,
                    })
            except Exception as qe:
                logger.debug("Quote sync skipped for %s: %s", sym, qe)

            rank, streak = _compute_rank(pct_changes)

            # Relative strength — cast to plain Python floats to
            # avoid numpy array leaking through spy_data.values
            rs = 0.0
            if spy_data is not None and len(spy_data) > 0:
                stock_rets = list(pct_changes)
                sp_rets = [float(x) for x in spy_data.values[-len(stock_rets):]]
                rs = _compute_rs(stock_rets, sp_rets)

            upsert_momentum(sym, rank, streak, rs)

            # Earnings — read from DB (refreshed weekly by refresh_earnings_dates())
            with get_connection() as conn:
                row = conn.execute(
                    "SELECT earnings_date, days_to_earnings FROM dash_earnings WHERE symbol = ?",
                    (sym,),
                ).fetchone()
                if row:
                    upsert_earnings(sym, row["earnings_date"], row["days_to_earnings"])

            success_count += 1

        except Exception as e:
            logger.error("Processing error for %s: %s", sym, e, exc_info=True)
            fail_count += 1

    # ── Benchmark persist (prices/candles only) ──────────────────────────
    # SPY stays out of dash_stocks/dash_momentum and the Earnings display
    # universe, but its closes are required for RS/scoring, so persist them
    # from the same batch fetch. Falls back to the Step 1 download.
    spy_df = all_data.get(BENCHMARK_SYMBOL)
    if (spy_df is None or spy_df.empty) and spy_raw is not None and not spy_raw.empty:
        spy_df = spy_raw
    if spy_df is not None and not spy_df.empty:
        try:
            spy_candles, _, spy_avg_vol = _persist_price_history(BENCHMARK_SYMBOL, spy_df)
            if spy_candles:
                last = spy_candles[-1]
                prev_close = spy_candles[-2]["close"] if len(spy_candles) >= 2 else last["close"]
                chg = ((last["close"] - prev_close) / prev_close * 100) if prev_close else 0.0
                quotes_to_write.append({
                    "ticker": BENCHMARK_SYMBOL,
                    "price": round(float(last["close"]), 4),
                    "change_pct": round(float(chg), 4),
                    "volume": int(last["volume"]),
                    "avg_volume_30d": spy_avg_vol,
                    "market_state": None,
                })
            logger.info("Benchmark %s persisted through %s", BENCHMARK_SYMBOL, spy_candles[-1]["date"] if spy_candles else "unknown")
        except Exception as e:
            logger.warning("Benchmark %s persist failed: %s", BENCHMARK_SYMBOL, e)
    else:
        logger.warning("Benchmark %s missing from fetch — Earnings scores will be unscored", BENCHMARK_SYMBOL)

    set_last_fetch(datetime.now(timezone.utc).isoformat())
    # Persist synced quotes (skips null prices internally).
    if quotes_to_write:
        try:
            from data.fetcher import _write_quotes

            _write_quotes(quotes_to_write)
            logger.info("Synced %d quotes from dashboard fetch", len(quotes_to_write))
        except Exception as qe:
            logger.warning("Quote sync write failed: %s", qe)
    logger.info(
        "yfinance fetch complete: %d succeeded, %d failed out of %d tickers.",
        success_count, fail_count, len(symbols),
    )

    if success_count == 0 and fail_count > 0:
        raise RuntimeError(
            f"yfinance fetch failed for all {fail_count} tickers — no data written."
        )

    return {"status": "complete", "success_count": success_count, "fail_count": fail_count}


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    fetch_all()
