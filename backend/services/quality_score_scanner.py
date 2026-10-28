"""Quality Score orchestration, isolated from shared scanner rankings.

Reads existing candles only. A versioned scan payload is committed atomically;
legacy quality_score_scan/snapshots and all shared rankings remain untouched.
"""

import json
import logging
import math
import threading
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import numpy as np

from models.db import get_connection
from services.quality_score_model import (
    MODEL_VERSION, MIN_CANDLES, OHLC_REL_TOL,
    InvalidCandles, benchmark_for, compute_trend_quality,
)

logger = logging.getLogger(__name__)
ET = ZoneInfo("America/New_York")
# Candle repair bounds: only interior gaps and recent bars are auto-repaired,
# so new listings can never trigger a full-history insert.
REPAIR_LOOKBACK_DAYS = 400
REPAIR_RECENT_DAYS = 5
REPAIR_MAX_PER_TICKER = 25
# Halt tolerance: max missing sessions carried at last close (in memory only).
MAX_CARRIED_SESSIONS = 2
_scan_lock = threading.Lock()


def _now():
    return datetime.now(ET)


def _ensure_schema(conn):
    # Feature-owned table: no change to startup migrations or shared schemas.
    conn.execute("""CREATE TABLE IF NOT EXISTS quality_score_v2_runs (
        model_version TEXT NOT NULL,
        session_date TEXT NOT NULL,
        week_start TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (model_version, session_date)
    )""")


def _latest(conn):
    row = conn.execute("""SELECT payload FROM quality_score_v2_runs
                          WHERE model_version = ? ORDER BY session_date DESC LIMIT 1""",
                       (MODEL_VERSION,)).fetchone()
    return json.loads(row["payload"]) if row else None


def _completed_cutoff(now):
    # Manual daytime scans use yesterday; the weekly Friday 19:35 job uses
    # Friday's close. Actual stored session dates handle exchange holidays.
    day = now.date()
    if (now.hour, now.minute) < (16, 15):
        day -= timedelta(days=1)
    while day.weekday() >= 5:
        day -= timedelta(days=1)
    return day


def _evaluate(rows, baseline, symbol, as_of, require_session):
    """Validate session alignment/coverage, then score. Raises InvalidCandles."""
    if not rows:
        raise InvalidCandles("No candle history")
    if require_session and rows[-1]["date"] != as_of:
        raise InvalidCandles(f"Missing closing candle for {as_of}; latest is {rows[-1]['date']}")
    rows_eff = rows
    filled = []
    if len(baseline) >= MIN_CANDLES and len(rows) >= MIN_CANDLES - MAX_CARRIED_SESSIONS:
        # Halt tolerance: carry up to MAX_CARRIED_SESSIONS missing sessions at
        # the last close, in memory only. Multi-day moves are preserved; a
        # zero daily return is added per carried session.
        have = {r["date"] for r in rows}
        anchor = rows[-MIN_CANDLES]["date"] if len(rows) >= MIN_CANDLES else rows[0]["date"]
        missing = sorted(d for d in {r["date"] for r in baseline}
                         if anchor <= d <= as_of and d not in have)
        if len(missing) > MAX_CARRIED_SESSIONS:
            sample = ", ".join(missing[:3])
            raise InvalidCandles(
                f"Missing {len(missing)} daily sessions inside the calculation window ({sample}...)")
        if missing:
            by_date = {r["date"]: r for r in rows}
            filled_rows = []
            for d in missing:
                prior = [r for r in rows if r["date"] < d]
                if not prior or not prior[-1]["close"]:
                    raise InvalidCandles(
                        f"Missing daily sessions inside the calculation window ({d}...)")
                c = float(prior[-1]["close"])
                filled_rows.append({"date": d, "open": c, "high": c, "low": c,
                                    "close": c, "volume": 0})
            rows_eff = sorted(rows + filled_rows, key=lambda r: r["date"])[-MIN_CANDLES:]
            filled = missing
    elif len(rows) >= MIN_CANDLES and len(baseline) >= MIN_CANDLES:
        dates = {r["date"] for r in rows[-MIN_CANDLES:]}
        expected = {r["date"] for r in baseline if rows[-MIN_CANDLES]["date"] <= r["date"] <= as_of}
        if expected - dates:
            raise InvalidCandles("Missing daily sessions inside the calculation window")
    scored = compute_trend_quality(rows_eff, baseline, symbol)
    if filled:
        note = f"{len(filled)} halted session(s) carried at last close: {', '.join(filled)}"
        scored["flags"] = [note] + scored.get("flags", [])
        scored["carried_sessions"] = len(filled)
    return scored


def _valid_bar(o, h, l, c, v):
    """Validate a single fetched bar before it may touch stored candles."""
    try:
        o, h, l, c = float(o), float(h), float(l), float(c)
        v = float(v or 0)
    except (TypeError, ValueError):
        return False
    if not all(math.isfinite(x) for x in (o, h, l, c, v)):
        return False
    if min(o, h, l, c) <= 0 or v < 0:
        return False
    tol = OHLC_REL_TOL * c
    return not (h + tol < max(o, c) or l - tol > min(o, c) or l > h)


def _fetch_bars(ticker, start, end):
    """Download adjusted daily bars for [start, end). Returns {date: candle}."""
    import pandas as pd
    import yfinance as yf

    df = yf.download(ticker, start=start, end=end, interval="1d",
                     auto_adjust=True, progress=False)
    if df is None or df.empty:
        return {}
    if isinstance(df.columns, pd.MultiIndex):
        for level in (-1, 0):
            try:
                df = df.xs(ticker, level=level, axis=1)
                break
            except KeyError:
                continue
        else:
            return {}
        if isinstance(df.columns, pd.MultiIndex):
            df.columns = df.columns.get_level_values(0)
    bars = {}
    for ts, row in df.iterrows():
        try:
            date_str = ts.strftime("%Y-%m-%d")
            bar = {"date": date_str, "open": float(row["Open"]), "high": float(row["High"]),
                   "low": float(row["Low"]), "close": float(row["Close"]),
                   "volume": int(row["Volume"]) if pd.notna(row["Volume"]) else 0}
        except (KeyError, TypeError, ValueError):
            continue
        if _valid_bar(bar["open"], bar["high"], bar["low"], bar["close"], bar["volume"]):
            bars[date_str] = bar
    return bars


def repair_candle_data():
    """Backfill interior gaps and re-check recent bars in stored candles.

    Only touches the candles table, only for universe tickers (plus their
    benchmarks): missing interior sessions and invalid recent bars are
    re-fetched; every staged bar must pass validation and a continuity guard
    (boundary log-returns within max(35%, 8 daily sigma)) or it is skipped and
    reported. Returns {"repaired": ..., "unrepaired": ...}.
    """
    from datetime import date as _date

    report = {"repaired": {}, "unrepaired": {}, "checked": 0}
    now = _now()
    cutoff = _completed_cutoff(now)
    start = (cutoff - timedelta(days=REPAIR_LOOKBACK_DAYS)).isoformat()
    end = cutoff.isoformat()
    recent_from = (cutoff - timedelta(days=REPAIR_RECENT_DAYS)).isoformat()

    with get_connection() as conn:
        universe = [r["ticker"] for r in conn.execute(
            "SELECT ticker FROM universe WHERE COALESCE(sector, '') != 'ETF' ORDER BY ticker")]
    symbols = sorted(set(universe))
    refs = {s: benchmark_for(s) or "SPY" for s in symbols}
    targets = sorted(set(symbols) | set(refs.values()))

    with get_connection() as conn:
        stored = {}
        for t in targets:
            stored[t] = [dict(r) for r in conn.execute(
                "SELECT date, open, high, low, close, volume FROM candles "
                "WHERE ticker = ? AND date BETWEEN ? AND ? ORDER BY date", (t, start, end))]

    for ticker in symbols:
        report["checked"] += 1
        own = stored.get(ticker, [])
        if not own:
            continue  # nothing to anchor a repair to; scanner reports short history
        ref_dates = {r["date"] for r in stored.get(refs[ticker], [])}
        if not ref_dates:
            continue
        own_dates = {r["date"] for r in own}
        first, last = own[0]["date"], own[-1]["date"]
        interior = sorted(d for d in ref_dates if first <= d <= last and d not in own_dates)
        tail = sorted(d for d in ref_dates if last < d <= end)
        recheck = [r["date"] for r in own
                   if r["date"] >= recent_from
                   and not _valid_bar(r["open"], r["high"], r["low"], r["close"], r["volume"])]
        wanted = sorted(set(interior + tail + recheck))
        if not wanted:
            continue
        if len(wanted) > REPAIR_MAX_PER_TICKER:
            report["unrepaired"].setdefault(ticker, {})["deferred"] = \
                f"{len(wanted) - REPAIR_MAX_PER_TICKER} dates over per-ticker cap"
            wanted = wanted[:REPAIR_MAX_PER_TICKER]

        try:
            stop = (_date.fromisoformat(wanted[-1]) + timedelta(days=1)).isoformat()
            fetched = _fetch_bars(ticker, wanted[0], stop)
        except Exception as exc:
            report["unrepaired"].setdefault(ticker, {})["fetch"] = str(exc)[:120]
            continue
        staged = {d: fetched[d] for d in wanted if d in fetched}
        for d in wanted:
            if d not in staged:
                report["unrepaired"].setdefault(ticker, {})[d] = "no valid upstream bar"

        # Continuity guard against wrong-basis bars (splits/dividend vintages):
        # boundary log-returns must stay within max(35%, 8 daily sigma).
        closes = {r["date"]: r["close"] for r in own if r["close"] and r["close"] > 0}
        hist = sorted(closes)
        sigmas = []
        for a, b in zip(hist, hist[1:]):
            if closes[a] > 0 and closes[b] > 0:
                sigmas.append(math.log(closes[b] / closes[a]))
        sigma_daily = max(float(np.std(sigmas)) if len(sigmas) > 1 else 0.02, 0.005)
        limit = max(0.35, 8 * sigma_daily)
        pool = {r["date"]: r["close"] for r in own}
        pool.update({d: b["close"] for d, b in staged.items()})
        for d in list(staged):
            c = staged[d]["close"]
            neighbors = [_neighbor_close(pool, d, -1), _neighbor_close(pool, d, 1)]
            if any(o and o > 0 and abs(math.log(c / o)) > limit for o in neighbors):
                report["unrepaired"].setdefault(ticker, {})[d] = "continuity guard tripped"
                del staged[d]

        if staged:
            with get_connection() as conn:
                conn.executemany(
                    "INSERT INTO candles (ticker, date, open, high, low, close, volume) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?) "
                    "ON CONFLICT(ticker, date) DO UPDATE SET "
                    "open = excluded.open, high = excluded.high, low = excluded.low, "
                    "close = excluded.close, volume = excluded.volume",
                    [(ticker, b["date"], b["open"], b["high"], b["low"], b["close"], b["volume"])
                     for b in staged.values()])
            report["repaired"][ticker] = sorted(staged)

    logger.info("repair_candle_data: %d tickers repaired, %d with unrepaired gaps",
                len(report["repaired"]), len(report["unrepaired"]))
    for ticker, gaps in report["unrepaired"].items():
        logger.warning("repair_candle_data unrepaired %s: %s", ticker, gaps)
    return report


def _neighbor_close(pool, d, direction):
    """Closest close on one side of d within a {date: close} pool."""
    dates = sorted(pool)
    try:
        i = dates.index(d)
    except ValueError:
        return None
    j = i + direction
    if 0 <= j < len(dates):
        try:
            return float(pool[dates[j]])
        except (TypeError, ValueError):
            return None
    return None


def _excluded(item, reason, as_of):
    return {"ticker": item["ticker"], "company": item.get("company_name") or "",
            "sector": item.get("sector") or "", "score": None, "model_version": MODEL_VERSION,
            "insufficient_data": True, "exclusion_reason": reason, "assessment": "Not scored",
            "state": "excluded", "data_as_of": as_of, "current_rank": None,
            "previous_rank": None, "trend_direction": "new", "trend_change": 0,
            "provisional": False, "flags": []}


def run_quality_score_scan(force=False):
    """Evaluate the current universe from a consistent read snapshot.

    ``force`` remains accepted by the existing API. This inexpensive local-only
    calculation always re-evaluates inputs, avoiding stale universe caches.
    """
    with _scan_lock:
        now = _now()
        cutoff = _completed_cutoff(now)
        with get_connection() as conn:
            _ensure_schema(conn)
            conn.execute("BEGIN")
            universe = [dict(r) for r in conn.execute(
                "SELECT ticker, company_name, sector FROM universe WHERE COALESCE(sector, '') != 'ETF' ORDER BY ticker")]
            latest_date = conn.execute("""SELECT MAX(c.date) AS day FROM candles c
                JOIN universe u ON u.ticker = c.ticker
                WHERE c.date <= ? AND COALESCE(u.sector, '') != 'ETF'""", (cutoff.isoformat(),)).fetchone()["day"]
            if universe and (not latest_date or (cutoff - datetime.fromisoformat(latest_date).date()).days > 5):
                raise RuntimeError("Complete recent daily candles are unavailable; previous Quality Score results retained")
            session = latest_date or cutoff.isoformat()
            start = (datetime.fromisoformat(session).date() - timedelta(days=400)).isoformat()
            symbols = {u["ticker"] for u in universe} | {benchmark_for(u["ticker"]) for u in universe}
            candles = {ticker: [dict(r) for r in conn.execute(
                "SELECT date, open, high, low, close, volume FROM candles WHERE ticker=? AND date BETWEEN ? AND ? ORDER BY date",
                (ticker, start, session))] for ticker in symbols if ticker}

        results = []
        fallbacks = []
        for item in universe:
            ticker = item["ticker"]
            rows = candles.get(ticker, [])
            symbol = benchmark_for(ticker)
            baseline = candles.get(symbol, [])
            try:
                computed = _evaluate(rows, baseline, symbol, session, require_session=True)
            except InvalidCandles as exc:
                # One bad/unsettled latest bar must not sink the whole stock:
                # retry once through the prior session and flag it.
                computed = None
                if len(rows) > MIN_CANDLES:
                    fb_date = rows[-2]["date"]
                    try:
                        computed = _evaluate(rows[:-1], baseline, symbol, fb_date, require_session=False)
                        note = f"Latest session {session} excluded ({exc}); scored through {fb_date}"
                        computed["flags"] = [note] + computed.get("flags", [])
                        computed["session_fallback"] = True
                        fallbacks.append(ticker)
                    except InvalidCandles:
                        computed = None
                if computed is None:
                    results.append(_excluded(item, str(exc), rows[-1]["date"] if rows else None))
                    continue
            # Unexpected errors deliberately abort publication, preserving the
            # last successful board instead of silently dropping tickers.
            results.append({**computed, "ticker": ticker,
                            "company": item.get("company_name") or "", "sector": item.get("sector") or ""})

        scored = sorted((r for r in results if r["score"] is not None), key=lambda r: (-r["score"], r["ticker"]))
        unscored = sorted((r for r in results if r["score"] is None), key=lambda r: r["ticker"])
        day = datetime.fromisoformat(session).date()
        week = (day - timedelta(days=day.weekday())).isoformat()
        with get_connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            latest = _latest(conn)
            if latest and latest["data_as_of"] > session:
                raise RuntimeError("Cannot replace a newer Quality Score scan with older candles")
            # Baseline is the most recent successful scan in an earlier week.
            # Reruns and manual scans within this week cannot reset it.
            previous_row = conn.execute("""SELECT payload FROM quality_score_v2_runs
                WHERE model_version=? AND session_date < ? ORDER BY session_date DESC LIMIT 1""",
                (MODEL_VERSION, week)).fetchone()
            previous = json.loads(previous_row["payload"]) if previous_row else None
            prior_ranks = {r["ticker"]: r.get("current_rank") for r in previous["results"]} if previous else {}
            last_rows = {r["ticker"]: r for r in latest["results"]} if latest else {}
            for rank, row in enumerate(scored, 1):
                old_rank = prior_ranks.get(row["ticker"])
                change = old_rank - rank if old_rank is not None else 0
                old = last_rows.get(row["ticker"], {})
                first_seen = old.get("first_seen", session) if old.get("score") is not None else session
                row.update(current_rank=rank, previous_rank=old_rank,
                           trend_direction=("new" if old_rank is None else "flat" if abs(change) < 5 else
                                            "up" if change > 0 else "down"),
                           trend_change=abs(change) if abs(change) >= 5 else 0,
                           rank_change=change, first_seen=first_seen,
                           days_on_board=(day - datetime.fromisoformat(first_seen).date()).days + 1)
            completed_at = _now().isoformat()
            excluded_by_reason = {}
            for r in unscored:
                key = r.get("exclusion_reason") or "unknown"
                excluded_by_reason[key] = excluded_by_reason.get(key, 0) + 1
            result = {"results": scored + unscored, "total": len(scored), "insufficient_data": len(unscored),
                      "universe_size": len(universe), "errors": 0, "scanned_at": completed_at,
                      "completed_at": completed_at, "data_as_of": session, "week_start": week,
                      "comparison_date": previous["data_as_of"] if previous else None,
                      "model_version": MODEL_VERSION, "cached": False,
                      "provisional_count": sum(r["provisional"] for r in scored),
                      "data_quality": {"session_fallbacks": fallbacks,
                                       "excluded_by_reason": excluded_by_reason}}
            payload = json.dumps(result, allow_nan=False)
            conn.execute("""INSERT INTO quality_score_v2_runs
                (model_version, session_date, week_start, completed_at, payload) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(model_version, session_date) DO UPDATE SET
                completed_at=excluded.completed_at, payload=excluded.payload""",
                (MODEL_VERSION, session, week, completed_at, payload))
        logger.info("Trend Quality: %d scored, %d excluded, data through %s", len(scored), len(unscored), session)
        return result


def get_quality_score_board():
    with get_connection() as conn:
        _ensure_schema(conn)
        latest = _latest(conn)
    latest = latest or {"results": [], "completed_at": None, "data_as_of": None,
                        "comparison_date": None, "model_version": MODEL_VERSION}
    return {**{k: v for k, v in latest.items() if k != "results"},
            "rankings": latest["results"], "count": len(latest["results"])}


def get_quality_score_rankings():
    return get_quality_score_board()["rankings"]


def get_quality_score_history(ticker):
    """One observation per week, using its last successful available scan.

    Legacy ratio scores are intentionally not returned in the 0–100 series.
    Missing/excluded weeks are whitespace points, never fabricated zero scores.
    """
    with get_connection() as conn:
        _ensure_schema(conn)
        rows = conn.execute("""SELECT r.payload FROM quality_score_v2_runs r JOIN (
            SELECT week_start, MAX(session_date) AS session_date FROM quality_score_v2_runs
            WHERE model_version=? GROUP BY week_start
        ) w ON r.week_start=w.week_start AND r.session_date=w.session_date
        WHERE r.model_version=? ORDER BY r.session_date""", (MODEL_VERSION, MODEL_VERSION)).fetchall()
    snapshots = []
    for row in rows:
        run = json.loads(row["payload"])
        item = next((r for r in run["results"] if r["ticker"] == ticker), {})
        snapshots.append({"date": run["data_as_of"], "score": item.get("score"),
                          "price": item.get("price"), "provisional": item.get("provisional", False),
                          "assessment": item.get("assessment"), "components": item.get("components")})
    return {"ticker": ticker, "model_version": MODEL_VERSION, "snapshots": snapshots}
