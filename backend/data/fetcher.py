"""
fetcher.py — yfinance wrappers with SQLite caching, chunked batch downloads,
and sector performance tracking.

Public API:
    get_quotes(tickers, use_cache=True)       -> list[dict]
    get_ohlcv(ticker, period="1y")            -> list[dict]
    get_sector_performance()                  -> dict
    fetch_stock_data(tickers)                 -> dict
    fetch_index_performance()                 -> dict
    fetch_sector_performance()                -> dict
    fetch_earnings_dates(tickers)             -> list[dict]
"""

import logging
import math
import time
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
import yfinance as yf

from config import CHUNK_SIZE, OHLCV_CACHE_TTL, QUOTE_CACHE_TTL, SECTOR_ETFS  # noqa: F401
from models.db import get_connection

logger = logging.getLogger(__name__)

# ── In-memory cache for index/sector performance ──────────────────────
_index_perf_cache: dict | None = None
_index_perf_cache_time: float = 0.0
_INDEX_PERF_CACHE_TTL = 900  # 15 minutes

_sector_perf_cache: dict | None = None
_sector_perf_cache_time: float = 0.0
_SECTOR_PERF_CACHE_TTL = 900  # 15 minutes


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _unknown(ticker: str) -> dict:
    """Return a placeholder dict for an unknown or failed ticker."""
    return {
        "ticker": ticker,
        "price": None,
        "change_pct": None,
        "volume": None,
        "avg_volume_30d": None,
        "market_state": None,
    }


def _download_with_retry(
    tickers: list[str],
    retries: int = 3,
    delay: float = 1.0,
) -> pd.DataFrame | None:
    """Download daily data for *tickers* with exponential back-off.

    Returns the raw yfinance DataFrame or ``None`` after all retries
    have been exhausted.
    """
    for attempt in range(retries):
        try:
            return yf.download(
                tickers,
                period="35d",
                interval="1d",
                group_by="ticker",
                auto_adjust=True,
                progress=False,
                threads=True,
            )
        except Exception as exc:
            logger.warning(
                "yf.download attempt %d/%d failed: %s",
                attempt + 1,
                retries,
                exc,
            )
            time.sleep(delay * (attempt + 1))
    return None


def _backfill_close_from_dash(ticker: str, date_str: str) -> dict | None:
    """Look up a finalized/partial close for *ticker*/*date_str* in local tables.

    After market close Yahoo temporarily returns today's daily row with
    ``NaN`` OHLC (only ``Volume`` populated) until the bar settles.  The
    ``16:05 ET`` dashboard fetch usually captured today's partial bar
    *before* the flip, so ``dash_prices``/``candles`` still hold today's
    close while a fresh ``yfinance`` batch download shows ``NaN``.

    Returns ``{"close": ..., "volume": ...}`` or ``None`` when unavailable.
    Never raises — callers treat ``None`` as "no backfill".
    """
    try:
        from services.dashboard import get_ticker_candles

        for row in get_ticker_candles(ticker):
            if row.get("date") == date_str and (row.get("close") or 0) > 0:
                return {"close": float(row["close"]), "volume": int(row.get("volume") or 0)}
    except Exception as exc:
        logger.debug("%s: dash backfill lookup failed: %s", ticker, exc)
    return None


def _parse_batch_quotes(raw: pd.DataFrame, tickers: list[str]) -> list[dict]:
    """Parse a yfinance batch-download DataFrame into quote dicts.

    Handles both single-ticker (flat columns) and multi-ticker
    (MultiIndex columns) response shapes from yfinance.

    After-hours handling: Yahoo returns today's row with ``NaN`` Close
    (only Volume populated) until the daily bar settles.  Naively
    ``dropna``-ing would silently fall back to yesterday's close while
    the chart (which backfills from ``dash_prices``) shows today — a
    1-day divergence in the portfolio table.  Instead we backfill today's
    close from ``dash_prices``/``candles`` when the last row is ``NaN``.
    """
    results: list[dict] = []

    for ticker in tickers:
        try:
            # --- Robust DataFrame extraction ---
            if isinstance(raw.columns, pd.MultiIndex):
                if ticker in raw.columns.get_level_values(-1):
                    df = raw.xs(ticker, level=-1, axis=1)
                elif ticker in raw.columns.get_level_values(0):
                    df = raw[ticker]
                else:
                    df = pd.DataFrame()
            else:
                df = raw.copy()

            if df is None or df.empty:
                logger.debug("%s: empty DataFrame from yfinance", ticker)
                results.append(_unknown(ticker))
                continue

            # Normalize columns if still MultiIndex
            if isinstance(df.columns, pd.MultiIndex):
                df.columns = df.columns.get_level_values(0)

            if "Close" not in df.columns:
                logger.debug("%s: Close column missing", ticker)
                results.append(_unknown(ticker))
                continue

            # --- After-hours NaN handling (do NOT blindly dropna) ---
            # Yahoo posts today's row with NaN OHLC + real Volume after
            # close until settlement.  Preserve the last valid closes and
            # the pending date so we can backfill instead of falling back
            # to yesterday.
            try:
                idx = df.index
                last_label = idx[-1]
                last_date_str = (
                    last_label.strftime("%Y-%m-%d")
                    if hasattr(last_label, "strftime")
                    else str(last_label)[:10]
                )
            except Exception:
                last_date_str = ""
            last_close_raw = df["Close"].iloc[-1] if len(df) else float("nan")
            try:
                last_close_nan = pd.isna(last_close_raw)
            except Exception:
                last_close_nan = last_close_raw is None

            valid = df.dropna(subset=["Close"])

            if len(valid) < 2 and not (len(valid) == 1 and last_close_nan):
                logger.debug("%s: not enough data rows (%d)", ticker, len(valid))
                results.append(_unknown(ticker))
                continue

            if last_close_nan:
                # Today's bar pending settlement — backfill from dash/candles
                # (16:05 ET fetch captured the partial close pre-flip).
                backfilled = _backfill_close_from_dash(ticker, last_date_str) if last_date_str else None
                if backfilled is not None:
                    close_today = backfilled["close"]
                    # Prefer Yahoo's pending-day volume when present (it is
                    # populated even when OHLC is NaN), else dash volume.
                    try:
                        yahoo_vol = int(df["Volume"].iloc[-1]) if "Volume" in df.columns and not pd.isna(df["Volume"].iloc[-1]) else 0
                    except Exception:
                        yahoo_vol = 0
                    volume_today = yahoo_vol or backfilled["volume"]
                    close_prev = float(valid["Close"].iloc[-1])
                    logger.info(
                        "%s: backfilled %s close %.2f from dash_prices (yahoo NaN)",
                        ticker, last_date_str, close_today,
                    )
                else:
                    # No backfill available — fall back to last settled bar
                    # (yesterday) rather than N/A, but log it loudly.
                    logger.warning(
                        "%s: %s Close NaN and no dash backfill — using last settled bar",
                        ticker, last_date_str,
                    )
                    df = valid
                    close_today = float(df["Close"].iloc[-1])
                    close_prev = float(df["Close"].iloc[-2]) if len(df) >= 2 else close_today
                    volume_today = int(df["Volume"].iloc[-1]) if "Volume" in df.columns else 0
            else:
                df = valid
                close_today = float(df["Close"].iloc[-1])
                close_prev = float(df["Close"].iloc[-2])
                volume_today = int(df["Volume"].iloc[-1]) if "Volume" in df.columns else 0
            change_pct = ((close_today - close_prev) / close_prev) * 100 if close_prev else 0.0
            avg_volume_30d = (
                int(df["Volume"].tail(30).mean())
                if "Volume" in df.columns
                else 0
            )

            results.append(
                {
                    "ticker": ticker,
                    "price": round(close_today, 4),
                    "change_pct": round(change_pct, 4),
                    "volume": volume_today,
                    "avg_volume_30d": avg_volume_30d,
                    "market_state": None,
                }
            )

        except Exception as exc:
            logger.error("%s: quote parse failed: %s", ticker, exc)
            results.append(_unknown(ticker))

    return results


# ---------------------------------------------------------------------------
# Cache helpers
# ---------------------------------------------------------------------------

def _read_cached_quotes(tickers: list[str]) -> tuple[list[dict], list[str]]:
    """Read fresh quotes from the database.

    Returns
    -------
    fresh : list[dict]
        Quotes that are still within the TTL window.
    stale : list[str]
        Tickers that are missing or whose data has expired.
    """
    fresh: list[dict] = []
    stale: list[str] = []
    cutoff = (
        datetime.now(timezone.utc) - timedelta(seconds=QUOTE_CACHE_TTL)
    ).isoformat()

    with get_connection() as conn:
        for ticker in tickers:
            row = conn.execute(
                "SELECT ticker, price, change_pct, volume, avg_volume_30d, "
                "       market_state, fetched_at "
                "FROM quotes WHERE ticker = ?",
                (ticker,),
            ).fetchone()

            if row and row["fetched_at"] and row["fetched_at"] > cutoff:
                fresh.append(
                    {
                        "ticker": row["ticker"],
                        "price": row["price"],
                        "change_pct": row["change_pct"],
                        "volume": row["volume"],
                        "avg_volume_30d": row["avg_volume_30d"],
                        "market_state": row["market_state"],
                    }
                )
            else:
                stale.append(ticker)

    return fresh, stale


def _write_quotes(quotes: list[dict]) -> None:
    """Upsert fetched quotes into the database.

    Quotes with a null ``price`` are silently skipped to avoid
    overwriting good cached data with placeholder values generated
    by a partial download failure (e.g. a single ticker timing out
    in a batch)."""
    if not quotes:
        return

    valid_quotes = [q for q in quotes if q["price"] is not None]
    if not valid_quotes:
        logger.warning("_write_quotes: all quotes have null prices, skipping write")
        return

    skipped = len(quotes) - len(valid_quotes)
    if skipped > 0:
        logger.warning(
            "_write_quotes: skipping %d quotes with null prices — "
            "keeping existing cached data for those tickers",
            skipped,
        )

    now = datetime.now(timezone.utc).isoformat()
    with get_connection() as conn:
        conn.executemany(
            "INSERT INTO quotes (ticker, price, change_pct, volume, "
            "avg_volume_30d, market_state, fetched_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(ticker) DO UPDATE SET "
            "  price = excluded.price, "
            "  change_pct = excluded.change_pct, "
            "  volume = excluded.volume, "
            "  avg_volume_30d = excluded.avg_volume_30d, "
            "  market_state = excluded.market_state, "
            "  fetched_at = excluded.fetched_at",
            [
                (
                    q["ticker"],
                    q["price"],
                    q["change_pct"],
                    q["volume"],
                    q["avg_volume_30d"],
                    q["market_state"],
                    now,
                )
                for q in valid_quotes
            ],
        )


def _read_cached_candles(ticker: str, period: str) -> list[dict] | None:
    """Return cached candles if fresh enough, otherwise ``None``.

    Uses ``OHLCV_CACHE_TTL`` (default 1 hour) to determine freshness.
    """
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT date, open, high, low, close, volume "
            "FROM candles WHERE ticker = ? ORDER BY date",
            (ticker,),
        ).fetchall()

        if not rows:
            return None

        last_date = rows[-1]["date"]
        last_dt = datetime.strptime(last_date, "%Y-%m-%d").replace(
            tzinfo=timezone.utc
        )
        now = datetime.now(timezone.utc)

        cache_age_hours = (now - last_dt).total_seconds() / 3600
        if cache_age_hours > OHLCV_CACHE_TTL / 3600:
            return None

        return [
            {
                "date": r["date"],
                "open": r["open"],
                "high": r["high"],
                "low": r["low"],
                "close": r["close"],
                "volume": r["volume"],
            }
            for r in rows
        ]


def _write_candles(ticker: str, candles: list[dict]) -> None:
    """Upsert OHLCV candles into the database."""
    if not candles:
        return

    with get_connection() as conn:
        conn.executemany(
            "INSERT INTO candles (ticker, date, open, high, low, close, volume) "
            "VALUES (?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(ticker, date) DO UPDATE SET "
            "  open = excluded.open, "
            "  high = excluded.high, "
            "  low = excluded.low, "
            "  close = excluded.close, "
            "  volume = excluded.volume",
            [
                (
                    ticker,
                    c["date"],
                    c["open"],
                    c["high"],
                    c["low"],
                    c["close"],
                    c["volume"],
                )
                for c in candles
            ],
        )


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def get_quotes(tickers: list[str], use_cache: bool = True) -> list[dict]:
    """Fetch current price + volume for a list of tickers.

    Uses the SQLite ``quotes`` table as a cache.  Tickrs whose cached data
    is older than ``QUOTE_CACHE_TTL`` seconds (or missing entirely) are
    re-fetched from yfinance in chunks of ``CHUNK_SIZE``.

    Parameters
    ----------
    tickers : list[str]
        Ticker symbols to look up.
    use_cache : bool
        When ``True`` (default) the cache is consulted first.

    Returns
    -------
    list[dict]
        Each dict contains keys: ticker, price, change_pct, volume,
        avg_volume_30d, market_state.  Unknown tickers get ``None``
        values.
    """
    if not tickers:
        return []

    # Deduplicate while preserving order
    seen: set[str] = set()
    unique: list[str] = []
    for t in tickers:
        t_upper = t.upper()
        if t_upper not in seen:
            seen.add(t_upper)
            unique.append(t_upper)

    # --- 1. Check cache for fresh data ---
    fresh: list[dict] = []
    stale: list[str] = unique

    if use_cache:
        fresh, stale = _read_cached_quotes(unique)
        if stale:
            logger.info(
                "get_quotes: %d cached, %d stale/missing",
                len(fresh),
                len(stale),
            )

    if not stale:
        return fresh

    # --- 2. Chunk stale tickers and fetch from yfinance ---
    fetched: list[dict] = []
    for i in range(0, len(stale), CHUNK_SIZE):
        chunk = stale[i : i + CHUNK_SIZE]
        logger.info(
            "get_quotes: fetching chunk %d/%d (%d tickers)",
            i // CHUNK_SIZE + 1,
            (len(stale) + CHUNK_SIZE - 1) // CHUNK_SIZE,
            len(chunk),
        )

        raw = _download_with_retry(chunk)
        if raw is None or raw.empty:
            fetched.extend([_unknown(t) for t in chunk])
            continue

        chunk_results = _parse_batch_quotes(raw, chunk)

        # Detect tickers that failed within this chunk and retry one-by-one.
        # yfinance can swallow per-ticker exceptions (e.g. a transient empty
        # response from Yahoo Finance for one ticker) and still return a
        # partial result, so we catch those here.
        failed = [q["ticker"] for q in chunk_results if q["price"] is None]
        if failed:
            logger.warning(
                "get_quotes: %d ticker(s) returned unknown — retrying individually: %s",
                len(failed),
                failed,
            )
            for ticker in failed:
                retry_raw = _download_with_retry([ticker])
                if retry_raw is not None and not retry_raw.empty:
                    retry_result = _parse_batch_quotes(retry_raw, [ticker])
                    if retry_result and retry_result[0]["price"] is not None:
                        for j, q in enumerate(chunk_results):
                            if q["ticker"] == ticker:
                                chunk_results[j] = retry_result[0]
                                logger.info("get_quotes: individual retry succeeded for %s", ticker)
                                break

        fetched.extend(chunk_results)

    # --- 3. Persist fresh data ---
    _write_quotes(fetched)

    # --- 4. Merge and return ---
    return fresh + fetched


def get_ohlcv(ticker: str, period: str = "1y", interval: str = "1d", force_refresh: bool = False, prepost: bool = False) -> list[dict]:
    """Fetch OHLCV history for a single ticker.

    Results are cached in the ``candles`` table and refreshed when
    the most recent candle is older than ``OHLCV_CACHE_TTL`` seconds.

    Parameters
    ----------
    ticker : str
        The ticker symbol (e.g. ``"AAPL"``).
    period : str
        yfinance period string (``"1y"``, ``"6mo"``, ``"3mo"``, etc.).
    interval : str
        yfinance interval string (``"1d"``, ``"15m"``, ``"1h"``, etc.).
        Intraday intervals (``"1m"``-``"90m"``) are only supported for
        periods of 60 days or less.
    force_refresh : bool
        When ``True``, bypass the cache and fetch fresh data from yfinance.
    prepost : bool
        When ``True`` (intraday only), include pre/post-market candles.
        Defaults to ``False`` so all existing daily callers are unchanged.
        Only the live-chart seed/re-sync paths opt in. Intraday results
        are never cached or persisted, so extended-hours data cannot leak
        into daily charts, S/R evaluation, or alert checks.

    Returns
    -------
    list[dict]
        Each dict contains keys: date, open, high, low, close, volume.

    Raises
    ------
    ValueError
        If yfinance returns no data for the given ticker.
    ValueError
        If an intraday interval is used with a period longer than 60 days.
    """
    ticker = ticker.upper()

    # --- Validate intraday intervals vs period ---
    intraday_intervals = {"1m", "2m", "5m", "15m", "30m", "60m", "90m", "1h"}
    if interval in intraday_intervals:
        # Parse the numeric portion of the period string for comparison
        period_num = int("".join(c for c in period if c.isdigit()) or "365")
        if period_num > 60:
            raise ValueError(
                f"Intraday interval '{interval}' is only supported for periods of 60 days or less, "
                f"but period='{period}' was requested. Use a shorter period or switch to interval='1d'."
            )

    # --- 1. Check cache (skip for intraday) ---
    if interval == "1d" and not force_refresh:
        cached = _read_cached_candles(ticker, period)
        if cached is not None:
            logger.debug("get_ohlcv: cache hit for %s", ticker)
            return cached

    # --- 2. Fetch from yfinance ---
    logger.info("get_ohlcv: fetching %s (period=%s)", ticker, period)
    try:
        df = yf.download(
            ticker,
            period=period,
            interval=interval,
            prepost=prepost,
            auto_adjust=True,
            progress=False,
        )
    except Exception as exc:
        raise ValueError(f"Failed to fetch history for {ticker}: {exc}") from exc

    if df is None or df.empty:
        raise ValueError(f"Unknown ticker: {ticker}")

    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)

    # NOTE: Do NOT dropna(subset=["Close"]) here.  After market hours,
    # yfinance returns today's row with NaN for OHLCV (only Volume is
    # populated).  dropna would silently remove the row, causing the
    # chart to show yesterday's candle as the latest.  Instead, we let
    # NaN rows through (they become 0 in the candle dict) and backfill
    # from dash_prices below.

    candles: list[dict] = []
    for ts, row in df.iterrows():
        # Use datetime format for intraday intervals, date-only for daily
        if interval == "1d":
            date_str = ts.strftime("%Y-%m-%d")
        else:
            date_str = ts.strftime("%Y-%m-%d %H:%M:%S%z")
        candles.append(
            {
                "date": date_str,
                "open": round(float(row["Open"]), 4) if not pd.isna(row["Open"]) else 0,
                "high": round(float(row["High"]), 4) if not pd.isna(row["High"]) else 0,
                "low": round(float(row["Low"]), 4) if not pd.isna(row["Low"]) else 0,
                "close": round(float(row["Close"]), 4) if not pd.isna(row["Close"]) else 0,
                "volume": int(row["Volume"]) if not pd.isna(row["Volume"]) else 0,
            }
        )

    # --- Backfill last candle from dash_prices if yfinance returned NaN ---
    # After market hours, yfinance returns today's row with NaN close (only
    # Volume populated).  The dash_prices table has the real 4 PM close
    # because yf_fetcher.fetch_all() ran at 4:05 PM ET.
    if candles and candles[-1]["close"] == 0:
        try:
            from services.dashboard import get_ticker_candles

            latest_date = candles[-1]["date"]
            dp = get_ticker_candles(ticker)
            for d in dp:
                if d["date"] == latest_date and d["close"] > 0:
                    candles[-1] = {
                        "date": d["date"],
                        "open": d["open"],
                        "high": d["high"],
                        "low": d["low"],
                        "close": d["close"],
                        "volume": d["volume"],
                    }
                    logger.info(
                        "get_ohlcv: backfilled %s candle for %s from dash_prices",
                        latest_date,
                        ticker,
                    )
                    break
        except Exception as exc:
            logger.warning(
                "get_ohlcv: dash_prices backfill failed for %s: %s",
                ticker,
                exc,
            )

    # Drop any remaining candles with close == 0 (yfinance returned NaN
    # and dash_prices didn't have the data either).
    candles = [c for c in candles if c["close"] > 0]

    # --- 3. Persist (skip for intraday) ---
    if interval == "1d":
        _write_candles(ticker, candles)

    return candles


def get_sector_performance() -> dict:
    """Fetch sector ETF performance for all sectors defined in config.

    Uses the ``SECTOR_ETFS`` mapping from config and delegates to
    :func:`get_quotes` for the actual data fetch (with caching).

    Returns
    -------
    dict
        Mapping of sector name to ``{ticker, change_pct, price}``.
        Sectors whose ETF returns unknown data get ``None`` values.
    """
    etf_tickers = list(SECTOR_ETFS.values())

    quotes = get_quotes(etf_tickers)
    quote_map = {q["ticker"]: q for q in quotes}

    result: dict[str, dict] = {}
    for sector, etf in SECTOR_ETFS.items():
        q = quote_map.get(etf)
        if q and q["price"] is not None:
            result[sector] = {
                "ticker": etf,
                "change_pct": q["change_pct"],
                "price": q["price"],
            }
        else:
            result[sector] = {
                "ticker": etf,
                "change_pct": None,
                "price": None,
            }

    return result


# ---------------------------------------------------------------------------
# Scanner-specific data fetchers
# ---------------------------------------------------------------------------

def latest_scanner_session_date():
    """Last completed US weekday session for an on-demand daily scan."""
    now = datetime.now(ZoneInfo("America/New_York"))
    day = now.date()
    if now.weekday() < 5 and (now.hour, now.minute) >= (16, 15):
        return day
    day -= timedelta(days=1)
    while day.weekday() >= 5:
        day -= timedelta(days=1)
    return day


def valid_scanner_frame(df, ticker: str, session_date=None):
    """Use only a valid daily OHLCV bar, never yesterday in place of a NaN latest bar.

    session_date is set by the scheduled close scan; on-demand scans may use
    the most recent available session. When Yahoo's settlement-window OHLC is
    missing, use the dated 4:05 dashboard OHLCV snapshot if valid.
    """
    if df is None or df.empty:
        return None
    if session_date is not None:
        # At 10 AM Yahoo may include today's unfinished daily candle; trim it.
        df = df.loc[df.index.date <= session_date]
        if df.empty:
            return None
    def dashboard_snapshot():
        from services.dashboard import get_ticker_candles
        return next((row for row in reversed(get_ticker_candles(ticker))
                     if row["date"] == session_date.isoformat()), None)

    fields = ("Open", "High", "Low", "Close", "Volume")
    def valid(row):
        try:
            return (all(math.isfinite(float(row[field])) for field in fields)
                    and all(float(row[field]) > 0 for field in fields))
        except (TypeError, ValueError, KeyError):
            return False

    if session_date is not None and df.index[-1].date() != session_date:
        try:
            candle = dashboard_snapshot()
            snapshot = {field: candle[field.lower()] for field in fields} if candle else None
            if not snapshot or not valid(snapshot):
                logger.warning("Scanner %s: latest bar %s, expected %s", ticker, df.index[-1].date(), session_date)
                return None
            df = df.copy()
            df.loc[pd.Timestamp(session_date, tz=df.index.tz), list(fields)] = list(snapshot.values())
            logger.info("Scanner %s: using %s 4:05 dashboard OHLCV snapshot (Yahoo row absent)", ticker, session_date)
        except Exception as exc:
            logger.warning("Scanner %s: dashboard OHLCV fallback failed: %s", ticker, exc)
            return None
    if any(field not in df.columns for field in fields):
        logger.warning("Scanner %s: missing OHLCV fields", ticker)
        return None
    last = df.iloc[-1]
    if not valid(last):
        if session_date is not None:
            try:
                candle = dashboard_snapshot()
                if candle and valid({field: candle[field.lower()] for field in fields}):
                    df = df.copy()
                    for field in fields:
                        df.loc[df.index[-1], field] = candle[field.lower()]
                    logger.info("Scanner %s: using %s 4:05 dashboard OHLCV snapshot", ticker, session_date)
                else:
                    logger.warning("Scanner %s: invalid OHLCV, no valid %s dashboard snapshot", ticker, session_date)
                    return None
            except Exception as exc:
                logger.warning("Scanner %s: dashboard OHLCV fallback failed: %s", ticker, exc)
                return None
        else:
            logger.warning("Scanner %s: latest bar has invalid OHLCV (%s)", ticker, df.index[-1].date())
            return None
    return df.dropna(subset=list(fields))

def fetch_stock_data(tickers: list[str], session_date=None) -> dict:
    """
    Batch-download 35 days OHLCV for the full universe.
    
    Returns per ticker:
        price, day_pct, week_pct, month_pct, vol_ratio, high_52w, low_52w,
        close_position, atr_pct, gap_pct, sma20, sma20_slope, above_sma20
    """
    results = {}
    if not tickers:
        return results
    
    try:
        raw = yf.download(
            " ".join(tickers), period="45d", interval="1d",
            group_by="ticker", auto_adjust=True, progress=False, threads=True
        )
    except Exception as e:
        logger.error(f"yfinance batch download failed: {e}")
        return results
    
    for ticker in tickers:
        try:
            df = raw[ticker] if len(tickers) > 1 else raw
            df = valid_scanner_frame(df, ticker, session_date)
            if df is None or len(df) < 27:
                continue
            
            close = float(df["Close"].iloc[-1])
            prev = float(df["Close"].iloc[-2])
            open_px = float(df["Open"].iloc[-1])
            high_day = float(df["High"].iloc[-1])
            low_day = float(df["Low"].iloc[-1])
            vol_today = int(df["Volume"].iloc[-1])
            avg_vol = float(df["Volume"].iloc[-21:-1].mean())
            
            day_pct = ((close - prev) / prev * 100) if prev > 0 else 0.0
            week_ref = float(df["Close"].iloc[max(0, len(df) - 6)])
            week_pct = ((close - week_ref) / week_ref * 100) if week_ref > 0 else 0.0
            vol_ratio = (vol_today / avg_vol) if avg_vol > 0 else 0.0
            high_52w = float(df["High"].max())
            low_52w = float(df["Low"].min())
            rng = high_day - low_day
            close_pos = ((close - low_day) / rng) if rng > 0 else 0.5
            
            # ATR (14-bar) — True Range accounts for gaps
            highs_atr = df["High"].iloc[-15:-1].values.astype(float)
            lows_atr = df["Low"].iloc[-15:-1].values.astype(float)
            closes_atr = df["Close"].iloc[-16:-2].values.astype(float)
            prev_closes = closes_atr
            tr = np.maximum(
                highs_atr - lows_atr,
                np.maximum(
                    np.abs(highs_atr - prev_closes),
                    np.abs(lows_atr - prev_closes)
                )
            )
            atr_pct = round((tr.mean() / close * 100), 2) if close > 0 and len(tr) > 0 else 0.0
            
            # Gap
            gap_pct = round(((open_px - prev) / prev * 100), 2) if prev > 0 else 0.0
            
            # Month % (22-session)
            month_ref = float(df["Close"].iloc[max(0, len(df) - 23)])
            month_pct = round(((close - month_ref) / month_ref * 100) if month_ref > 0 else 0.0, 2)
            
            # SMA20
            closes_arr = df["Close"].values.astype(float)
            sma20 = round(float(closes_arr[-21:-1].mean()), 2) if len(closes_arr) >= 21 else round(float(closes_arr[:-1].mean()), 2)
            sma20_prior = float(closes_arr[-26:-6].mean()) if len(closes_arr) >= 26 else sma20
            sma20_slope = round(sma20 - sma20_prior, 4)
            above_sma20 = bool(close > sma20)
            high_20d_prior = float(df["High"].iloc[-21:-1].max())
            
            results[ticker] = {
                "price": round(close, 2),
                "day_pct": round(day_pct, 2),
                "week_pct": round(week_pct, 2),
                "month_pct": month_pct,
                "vol_today": vol_today,
                "vol_avg": int(avg_vol),
                "vol_ratio": round(vol_ratio, 2),
                "high_52w": round(high_52w, 2),
                "low_52w": round(low_52w, 2),
                "close_position": round(close_pos, 3),
                "open": round(open_px, 2),
                "high_day": round(high_day, 2),
                "low_day": round(low_day, 2),
                "atr_pct": atr_pct,
                "gap_pct": gap_pct,
                "sma20": sma20,
                "sma20_slope": sma20_slope,
                "above_sma20": above_sma20,
                "high_20d_prior": round(high_20d_prior, 2),
                "session_date": df.index[-1].date().isoformat(),
            }
        except Exception as e:
            logger.warning(f"Error processing {ticker}: {e}")
    
    return results


def fetch_index_performance(session_date=None) -> dict:
    """Fetch day % change for S&P 500, Nasdaq, Dow, Russell.

    Results cached in memory for 15 minutes to avoid redundant yfinance calls.
    """
    import time as _time
    global _index_perf_cache, _index_perf_cache_time

    if session_date is None and _index_perf_cache is not None:
        age = _time.time() - _index_perf_cache_time
        if age < _INDEX_PERF_CACHE_TTL:
            return _index_perf_cache

    from config import INDEX_TICKERS

    indices = {}
    syms = list(INDEX_TICKERS.values())

    try:
        raw = yf.download(
            " ".join(syms), period="2d", interval="1d",
            group_by="ticker", auto_adjust=True, progress=False
        )
        for name, sym in INDEX_TICKERS.items():
            try:
                df = raw[sym] if len(syms) > 1 else raw
                df = valid_scanner_frame(df, sym, session_date)
                if df is not None and len(df) >= 2:
                    c0 = float(df["Close"].iloc[-2])
                    c1 = float(df["Close"].iloc[-1])
                    pct = ((c1 - c0) / c0 * 100) if c0 > 0 else 0.0
                    indices[name] = {"pct": round(pct, 2), "positive": pct >= 0}
            except Exception:
                pass
    except Exception as e:
        logger.warning(f"Index fetch error: {e}")

    _index_perf_cache = indices
    _index_perf_cache_time = _time.time()
    return indices


def fetch_sector_performance(session_date=None) -> dict:
    """Fetch day % change for each sector ETF.

    Results cached in memory for 15 minutes.
    """
    import time as _time
    global _sector_perf_cache, _sector_perf_cache_time

    if session_date is None and _sector_perf_cache is not None:
        age = _time.time() - _sector_perf_cache_time
        if age < _SECTOR_PERF_CACHE_TTL:
            return _sector_perf_cache

    from config import SECTOR_ETFS

    perf = {}
    etfs = list(set(SECTOR_ETFS.values()))

    try:
        raw = yf.download(
            " ".join(etfs), period="2d", interval="1d",
            group_by="ticker", auto_adjust=True, progress=False
        )
        for sector, etf in SECTOR_ETFS.items():
            try:
                df = raw[etf] if len(etfs) > 1 else raw
                df = valid_scanner_frame(df, etf, session_date)
                if df is not None and len(df) >= 2:
                    c0 = float(df["Close"].iloc[-2])
                    c1 = float(df["Close"].iloc[-1])
                    perf[sector] = {
                        "etf": etf,
                        "change_pct": round(((c1 - c0) / c0 * 100) if c0 > 0 else 0.0, 2),
                        "price": round(c1, 2)
                    }
            except Exception as e:
                logger.warning("Sector %s (%s) unavailable: %s", sector, etf, e)
    except Exception as e:
        logger.warning(f"Sector ETF fetch error: {e}")

    # Yahoo may leave only Volume in its daily bar during the settlement
    # window. Sector ETFs are not in dash_prices, so use their completed
    # regular-session hourly bars as a read-only fallback for the day return.
    missing = {sector: etf for sector, etf in SECTOR_ETFS.items() if sector not in perf}
    if session_date is not None and missing:
        try:
            hourly = yf.download(
                " ".join(set(missing.values())), period="5d", interval="60m",
                group_by="ticker", auto_adjust=True, progress=False, threads=True,
            )
            for sector, etf in missing.items():
                try:
                    bars = hourly[etf] if len(set(missing.values())) > 1 else hourly
                    dates = bars.index.tz_convert("America/New_York")
                    current = bars.loc[(dates.date == session_date) &
                                       ((dates.hour > 15) | ((dates.hour == 15) & (dates.minute >= 30)))]
                    previous = bars.loc[dates.date < session_date]
                    if current.empty or previous.empty:
                        continue
                    price = float(current["Close"].iloc[-1])
                    prior = float(previous["Close"].iloc[-1])
                    if not (math.isfinite(price) and math.isfinite(prior) and price > 0 and prior > 0):
                        continue
                    perf[sector] = {
                        "etf": etf, "price": round(price, 2),
                        "change_pct": round((price - prior) / prior * 100, 2),
                    }
                except Exception as exc:
                    logger.warning("Sector %s hourly fallback unavailable: %s", sector, exc)
            logger.info("Sector performance: %d/%d ETFs from completed hourly bars",
                        sum(sector in perf for sector in missing), len(missing))
        except Exception as exc:
            logger.warning("Sector hourly fallback failed: %s", exc)

    _sector_perf_cache = perf
    _sector_perf_cache_time = _time.time()
    return perf


def fetch_earnings_dates(tickers: list[str]) -> list[dict]:
    """Fetch earnings dates for tickers.

    Tries yfinance's ``Ticker.calendar`` which returns the next earnings
    date when available.  Depending on the yfinance version, ``calendar``
    may return a ``dict`` or a ``pandas.DataFrame``.  This function handles
    both cases transparently.
    """
    from datetime import datetime

    results = []
    for ticker in tickers:
        try:
            stock = yf.Ticker(ticker)
            cal = stock.calendar
            if cal is None:
                continue

            # --- dict-style calendar (yfinance >= 0.2.x) ---------------
            if isinstance(cal, dict):
                # The "Earnings Date" value can be a single date or a list
                raw = cal.get("Earnings Date") or cal.get("Earnings")
                if raw is None:
                    continue

                # Unwrap a list (e.g. [date(2026, 7, 30)])
                if isinstance(raw, list):
                    raw = raw[0] if raw else None
                if raw is None:
                    continue

                if isinstance(raw, datetime):
                    date_obj = raw.date()
                elif hasattr(raw, "date"):
                    date_obj = raw.date()
                else:
                    try:
                        date_obj = datetime.strptime(str(raw), "%Y-%m-%d").date()
                    except (ValueError, TypeError):
                        continue

                results.append({
                    "ticker": ticker,
                    "date": str(date_obj),
                    "date_obj": date_obj,
                })
                continue

            # --- DataFrame-style calendar (older yfinance) -------------
            if hasattr(cal, "empty") and cal.empty:
                continue

            # The calendar DataFrame may have different column names depending
            # on the yfinance version.  Try common column names.
            earnings_date = None
            for col_name in ("Earnings Date", "Earnings", "Date"):
                try:
                    earnings_date = cal.iloc[0].get(col_name)
                    if earnings_date is not None:
                        break
                except (KeyError, IndexError):
                    continue

            if earnings_date is None:
                continue

            # Normalise to a date object
            if isinstance(earnings_date, datetime):
                date_obj = earnings_date.date()
            elif hasattr(earnings_date, "date"):
                date_obj = earnings_date.date()
            else:
                # Might be a string like "2025-07-25"
                try:
                    date_obj = datetime.strptime(str(earnings_date), "%Y-%m-%d").date()
                except (ValueError, TypeError):
                    continue

            results.append({
                "ticker": ticker,
                "date": str(date_obj),
                "date_obj": date_obj,
            })
        except Exception as e:
            msg = str(e)
            if "404" in msg or "Not Found" in msg:
                logger.debug("No earnings date for %s (ETF/non-earnings instrument): %s", ticker, msg)
            else:
                logger.warning("Earnings date error for %s: %s", ticker, msg)
    return results


def get_cached_earnings_dates(tickers: list[str]) -> list[dict]:
    """Read earnings dates from dash_earnings table.

    Returns same format as fetch_earnings_dates():
    [{"ticker": "AAPL", "date": "2026-07-25", "date_obj": date(2026,7,25)}, ...]

    Falls back to yfinance for tickers missing from DB.
    """
    from datetime import datetime

    results = []
    missing = []

    with get_connection() as conn:
        for ticker in tickers:
            row = conn.execute(
                "SELECT earnings_date FROM dash_earnings WHERE symbol = ? AND earnings_date IS NOT NULL",
                (ticker,),
            ).fetchone()
            if row and row["earnings_date"]:
                try:
                    date_obj = datetime.strptime(row["earnings_date"], "%Y-%m-%d").date()
                    results.append({
                        "ticker": ticker,
                        "date": str(date_obj),
                        "date_obj": date_obj,
                    })
                except (ValueError, TypeError):
                    missing.append(ticker)
            else:
                missing.append(ticker)

    # Only fetch from yfinance for missing tickers (should be rare)
    if missing:
        yf_results = fetch_earnings_dates(missing)
        results.extend(yf_results)

    return results
