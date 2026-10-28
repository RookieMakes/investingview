"""
orb_scanner.py — Opening Range Breakout (ORB) board for the Trade tab.

Criteria (per session, ET):
  - ORB window: first 15-min bar, 09:30-09:45 ET
    -> ORBH = its high, ORBL = its low.
  - Confirmation: 15-min bar starting 10:15 ET (ending 10:30 ET)
    -> confirm_close = its close.
  - Long table:  confirm_close > ORBH (strict; exact touch = neither).
  - Short table: confirm_close < ORBL (strict; exact touch = neither).

Writer: a single 10:45 AM ET weekday scheduler job (``run_orb_scan``).
It batch-fetches 15m bars (period=1d, prepost=False) for the merged
universe in chunks of 10 and upserts one row per ticker per session
into ``orb_breakout``. At 10:45 the 10:15-10:30 bar is ~15 min old,
past yfinance's intraday lag; tickers missing either bar are stored
with insufficient_data=1 and appear in neither table.

Reader: ``get_orb_board`` is DB-only (mirrors swing_scanner) — the
Trade tab never calls yfinance.

Criteria 2 (extension, second writer): a single 11:35 AM ET weekday
job (``run_orb_decisions``) reuses the same chunked 15m fetch — by
then 7 bars (09:30→11:00 starts) are available — and evaluates three
checkpoints (10:30 / 11:00 / 11:15) per ticker with buffer-free rules:

  - Continuation LONG: last two completed closes above ORBH and
    rising; SHORT mirror below ORBL and falling.
  - Reversal LONG: previous candle sweeps ORBL or PDL (wick beyond,
    close back above — pure mechanical, no buffer) and the latest
    candle closes above the sweep candle's high and above ORBL.
    SHORT mirror via ORBH/PDH. Reversal wins ties; else no trade.

Decisions upsert into ``orb_decisions``; the board merges them with
the 10:45 baseline so flips/removals stay visible (baseline + change
flag) instead of being overwritten.
"""

import logging
import time
from datetime import datetime
from zoneinfo import ZoneInfo

import pandas as pd
import yfinance as yf

from models.db import get_connection

logger = logging.getLogger(__name__)

_ET = ZoneInfo("America/New_York")

CHUNK_SIZE = 10
CHUNK_SLEEP_SECONDS = 2.0

# ET session windows, minutes since midnight (matches live-auto-sr.js).
ORB_START_MINS = 9 * 60 + 30      # 09:30 ET — ORB bar start
CONFIRM_START_MINS = 10 * 60 + 15  # 10:15 ET — confirmation bar start


def classify_orb(orb_high, orb_low, confirm_close):
    """Strict ORB breakout signal: 'long' | 'short' | 'none'.

    Long only when confirm_close > ORBH; short only when
    confirm_close < ORBL. An exact touch lands in neither table.
    Non-numeric inputs yield 'none'.
    """
    try:
        hi = float(orb_high)
        lo = float(orb_low)
        px = float(confirm_close)
    except (TypeError, ValueError):
        return "none"
    if px > hi:
        return "long"
    if px < lo:
        return "short"
    return "none"


def _et_minutes(ts):
    """Minutes since midnight ET for a tz-aware Timestamp."""
    et = ts.tz_convert(_ET) if ts.tzinfo is not None else ts.tz_localize("UTC").tz_convert(_ET)
    return et.hour * 60 + et.minute, et.date().isoformat()


def _fetch_chunk(symbols):
    """Fetch 15m regular-session bars for up to CHUNK_SIZE symbols.

    Returns the raw yf.download DataFrame (group_by=ticker) or None.
    """
    try:
        data = yf.download(
            tickers=" ".join(symbols),
            period="1d",
            interval="15m",
            group_by="ticker",
            auto_adjust=True,
            prepost=False,
            progress=False,
            threads=True,
        )
        return data
    except Exception as e:
        logger.warning("ORB chunk fetch failed %s: %s", symbols, e)
        return None


def _ticker_frame(data, ticker):
    """Extract a single-ticker OHLC frame from a chunk download."""
    try:
        if data is None or len(data) == 0:
            return None
        if isinstance(data.columns, pd.MultiIndex):
            if ticker not in data.columns.get_level_values(0):
                return None
            frame = data[ticker]
        else:
            # Single-symbol download: plain column labels.
            frame = data
        if frame is None or frame.empty:
            return None
        if isinstance(frame.columns, pd.MultiIndex):
            frame.columns = frame.columns.get_level_values(0)
        return frame
    except Exception:
        return None


def _session_levels(frame):
    """Pull ORB + confirmation levels from one ticker's 15m frame.

    Returns dict with orb_high/orb_low/confirm_close/confirm_time/
    day_high/day_low/last_price/session_date, or None when the
    09:30 or 10:15 bar is missing or invalid.
    """
    try:
        idx = frame.index
        if idx.tz is None:
            idx = idx.tz_localize("UTC")
        idx_et = idx.tz_convert(_ET)
    except Exception:
        return None

    orb_row = None
    confirm_row = None
    day_high, day_low, last_close = None, None, None
    session_date = None

    for pos, ts in enumerate(idx_et):
        mins = ts.hour * 60 + ts.minute
        try:
            row = frame.iloc[pos]
            high = float(row["High"])
            low = float(row["Low"])
            close = float(row["Close"])
        except (KeyError, TypeError, ValueError):
            continue
        if not all(v > 0 for v in (high, low, close)):
            continue  # forming/NaN bar — not a valid print
        if session_date is None:
            session_date = ts.date().isoformat()
        elif ts.date().isoformat() != session_date:
            continue  # ignore bars outside the session (shouldn't happen)
        day_high = high if day_high is None else max(day_high, high)
        day_low = low if day_low is None else min(day_low, low)
        last_close = close
        if mins == ORB_START_MINS and orb_row is None:
            orb_row = {"high": high, "low": low}
        elif mins == CONFIRM_START_MINS and confirm_row is None:
            confirm_row = {"close": close, "time": ts.isoformat()}

    if orb_row is None or confirm_row is None or session_date is None:
        return None
    return {
        "orb_high": round(orb_row["high"], 4),
        "orb_low": round(orb_row["low"], 4),
        "confirm_close": round(confirm_row["close"], 4),
        "confirm_time": confirm_row["time"],
        "day_high": round(day_high, 4),
        "day_low": round(day_low, 4),
        "last_price": round(last_close, 4),
        "session_date": session_date,
    }


def run_orb_scan(session_date=None):
    """Fetch today's 15m bars and upsert one orb_breakout row per ticker.

    Runs once daily at 10:45 AM ET. Skips storing entirely when the
    market is closed (bars resolve to an earlier session). Idempotent
    per (ticker, session_date) via INSERT OR REPLACE.
    """
    from services.universe import get_merged_universe_with_metadata

    today = datetime.now(_ET).date().isoformat()
    session_date = session_date or today

    universe = get_merged_universe_with_metadata()
    tickers = [u["ticker"] for u in universe if u.get("ticker")]
    if not tickers:
        logger.warning("ORB scan: empty universe, nothing to do")
        return {"session_date": session_date, "long": 0, "short": 0,
                "none": 0, "insufficient": 0, "scanned_at": datetime.now().isoformat()}

    rows = []
    for i in range(0, len(tickers), CHUNK_SIZE):
        chunk = tickers[i:i + CHUNK_SIZE]
        data = _fetch_chunk(chunk)
        for ticker in chunk:
            levels = _session_levels(_ticker_frame(data, ticker)) if data is not None else None
            if levels is None:
                rows.append({"ticker": ticker, "session_date": session_date,
                             "signal": "none", "insufficient_data": 1})
                continue
            if levels["session_date"] != session_date:
                # Holiday/weekend: yfinance served an older session — never
                # store stale bars under today's date.
                logger.info("ORB scan: market closed for %s (bars=%s, expected=%s); skipping store",
                            ticker, levels["session_date"], session_date)
                continue
            rows.append({**levels, "ticker": ticker,
                         "signal": classify_orb(levels["orb_high"], levels["orb_low"],
                                                levels["confirm_close"]),
                         "insufficient_data": 0})
        if i + CHUNK_SIZE < len(tickers):
            time.sleep(CHUNK_SLEEP_SECONDS)

    if not rows:
        logger.info("ORB scan: no rows to store (market closed?)")
        return {"session_date": session_date, "long": 0, "short": 0,
                "none": 0, "insufficient": 0, "scanned_at": datetime.now().isoformat()}

    with get_connection() as conn:
        for r in rows:
            conn.execute(
                """INSERT OR REPLACE INTO orb_breakout
                   (ticker, session_date, orb_high, orb_low, confirm_close,
                    confirm_time, day_high, day_low, last_price,
                    signal, insufficient_data, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)""",
                (r["ticker"], r.get("session_date", session_date),
                 r.get("orb_high"), r.get("orb_low"), r.get("confirm_close"),
                 r.get("confirm_time"), r.get("day_high"), r.get("day_low"),
                 r.get("last_price"), r.get("signal", "none"),
                 r.get("insufficient_data", 0)),
            )

    counts = {"long": 0, "short": 0, "none": 0, "insufficient": 0}
    for r in rows:
        if r.get("insufficient_data"):
            counts["insufficient"] += 1
        else:
            counts[r.get("signal", "none")] += 1
    logger.info("ORB scan complete session=%s long=%d short=%d none=%d insufficient=%d",
                session_date, counts["long"], counts["short"], counts["none"], counts["insufficient"])
    return {"session_date": session_date, **counts, "scanned_at": datetime.now().isoformat()}


def get_orb_board():
    """Return {long, short, session_date, counts, scanned_at} for the Trade tab.

    DB-only: shows only today's ET session in orb_breakout, joined with
    universe names. Historical sessions remain stored for backtesting.
    Tickers with insufficient_data are excluded from both tables.
    """
    session_date = datetime.now(_ET).date().isoformat()
    with get_connection() as conn:
        if not conn.execute(
            "SELECT 1 FROM orb_breakout WHERE session_date = ? LIMIT 1", (session_date,)
        ).fetchone():
            return {"long": [], "short": [], "session_date": None,
                    "counts": {"long": 0, "short": 0, "removed": 0,
                               "insufficient": 0, "decided": False},
                    "scanned_at": datetime.now().isoformat()}

        db_rows = conn.execute(
            """SELECT o.ticker, o.orb_high, o.orb_low, o.confirm_close,
                      o.confirm_time, o.day_high, o.day_low, o.last_price,
                      o.signal, o.session_date,
                      COALESCE(u.company_name, s.name, '') AS company
               FROM orb_breakout o
               LEFT JOIN universe u ON u.ticker = o.ticker
               LEFT JOIN dash_stocks s ON s.symbol = o.ticker
               WHERE o.session_date = ?
                 AND o.insufficient_data = 0
               ORDER BY o.ticker""",
            (session_date,),
        ).fetchall()

        insufficient = conn.execute(
            "SELECT COUNT(*) AS n FROM orb_breakout WHERE session_date = ? AND insufficient_data = 1",
            (session_date,),
        ).fetchone()["n"]

        dec_rows = conn.execute(
            """SELECT ticker, checkpoint, setup, direction FROM orb_decisions
               WHERE session_date = ?""",
            (session_date,),
        ).fetchall()

    # Latest checkpoint is authoritative. A later evaluated "none" means the
    # earlier setup is no longer valid; do not fall back to stale signals.
    decisions = {}
    for r in dec_rows:
        decisions.setdefault(r["ticker"], {})[r["checkpoint"]] = {
            "setup": r["setup"], "direction": r["direction"]}
    has_decisions = bool(decisions)

    def resolve_now(ticker):
        """(direction, setup, checkpoint) from the latest stored checkpoint."""
        for cp in ("11:15", "11:00", "10:30"):
            d = (decisions.get(ticker) or {}).get(cp)
            if d:
                return d["direction"], d["setup"], cp
        return "none", "none", None

    long, short, removed = [], [], []
    for r in db_rows:
        try:
            item = {
                "ticker": r["ticker"],
                "company": r["company"] or "",
                "orb_high": float(r["orb_high"]),
                "orb_low": float(r["orb_low"]),
                "confirm_close": float(r["confirm_close"]),
                "day_high": float(r["day_high"]) if r["day_high"] is not None else None,
                "day_low": float(r["day_low"]) if r["day_low"] is not None else None,
                "last_price": float(r["last_price"]) if r["last_price"] is not None else None,
                "session_date": r["session_date"],
            }
        except (TypeError, ValueError):
            continue
        was = r["signal"] if r["signal"] in ("long", "short") else "none"
        if has_decisions:
            now, setup, checkpoint = resolve_now(r["ticker"])
        else:
            # Before the 11:35 run: board mirrors the 10:45 baseline.
            now, setup, checkpoint = was, "strict", "10:30"
        if was == "none" and now == "none":
            continue
        if was == "none":
            change = "new"
        elif now == "none":
            change = "removed"
        elif was == now:
            change = "held"
        else:
            change = "flipped"
        item.update({"was": was, "now": now, "change": change,
                     "setup": setup, "checkpoint": checkpoint})
        if now == "long":
            long.append(item)
        elif now == "short":
            short.append(item)
        elif was == "long":
            long.append(item)  # removed — dimmed in its baseline table
        elif was == "short":
            short.append(item)  # removed — dimmed in its baseline table

    long.sort(key=lambda x: (x["change"] == "removed", x["ticker"]))
    short.sort(key=lambda x: (x["change"] == "removed", x["ticker"]))
    n_removed = (sum(1 for x in long if x["change"] == "removed")
                 + sum(1 for x in short if x["change"] == "removed"))
    return {"long": long, "short": short, "session_date": session_date,
            "counts": {"long": sum(1 for x in long if x["change"] != "removed"),
                       "short": sum(1 for x in short if x["change"] != "removed"),
                       "removed": n_removed, "insufficient": insufficient,
                       "decided": has_decisions},
            "scanned_at": datetime.now().isoformat()}


# ── Criteria 2: checkpoint decisions (11:35 reassessment) ─────────────

# Latest bar-start (ET mins) included at each checkpoint: bars are
# stamped at their start, so the 10:30 checkpoint uses completed bars
# through the 10:15-10:30 bar. Newest input (11:00-11:15 bar) is
# ~20 min old at the 11:35 job time — past yfinance's intraday lag.
CHECKPOINT_CUTOFFS = {"10:30": 615, "11:00": 645, "11:15": 660}


def _session_bars(frame):
    """Flatten one ticker's 15m frame into sorted session bars.

    Returns ([{mins, date, o, h, l, c}], session_date) for valid
    regular-session prints, or (None, None) when empty.
    """
    try:
        idx = frame.index
        if idx.tz is None:
            idx = idx.tz_localize("UTC")
        idx_et = idx.tz_convert(_ET)
    except Exception:
        return None, None

    bars, session_date = [], None
    for pos, ts in enumerate(idx_et):
        try:
            row = frame.iloc[pos]
            o = float(row["Open"])
            high = float(row["High"])
            low = float(row["Low"])
            close = float(row["Close"])
        except (KeyError, TypeError, ValueError):
            continue
        if not all(v > 0 for v in (o, high, low, close)):
            continue  # forming/NaN bar — not a valid print
        day = ts.date().isoformat()
        if session_date is None:
            session_date = day
        elif day != session_date:
            continue
        bars.append({"mins": ts.hour * 60 + ts.minute, "date": day,
                     "o": o, "h": high, "l": low, "c": close})
    if not bars:
        return None, None
    bars.sort(key=lambda b: b["mins"])
    return bars, session_date


def _decide_at_cutoff(bars, orb_high, orb_low, pdh, pdl):
    """Buffer-free continuation/reversal decision on a bar window.

    ``bars``: eligible completed bars (already cutoff-filtered),
    latest last. Returns (setup, direction) with setup in
    {'continuation', 'reversal', 'none'}.
    """
    if len(bars) < 2:
        return "none", "none"
    prev, latest = bars[-2], bars[-1]
    try:
        hi = float(orb_high)
        lo = float(orb_low)
    except (TypeError, ValueError):
        return "none", "none"

    # ── Continuation: two closes beyond the level, latest extending ──
    if prev["c"] > hi and latest["c"] > hi and latest["c"] > prev["c"]:
        cont = ("continuation", "long")
    elif prev["c"] < lo and latest["c"] < lo and latest["c"] < prev["c"]:
        cont = ("continuation", "short")
    else:
        cont = ("none", "none")

    # ── Reversal: sweep-and-reclaim on prev, confirm on latest ──
    rev = ("none", "none")
    long_sweep = (prev["l"] < lo < prev["c"]) or (
        pdl is not None and prev["l"] < pdl < prev["c"])
    short_sweep = (prev["c"] < hi < prev["h"]) or (
        pdh is not None and prev["c"] < pdh < prev["h"])
    if long_sweep and latest["c"] > prev["h"] and latest["c"] > lo:
        rev = ("reversal", "long")
    elif short_sweep and latest["c"] < prev["l"] and latest["c"] < hi:
        rev = ("reversal", "short")

    # Reversal wins ties (most recent sequence); else continuation.
    if rev[1] != "none":
        return rev
    return cont


def decide_checkpoints(bars, orb_high, orb_low, pdh=None, pdl=None,
                       baseline_direction="none"):
    """Evaluate 10:30 / 11:00 / 11:15 checkpoints on session bars.

    Pure function (no I/O) — unit-testable. ``bars`` from
    ``_session_bars``. PDH/PDL may be None (ORB-only evaluation).
    When the 10:30 baseline was a breakout, keep it alive at a checkpoint
    only while that checkpoint's latest close remains beyond the ORB level.
    Returns {checkpoint: {"setup": ..., "direction": ...}}.
    """
    try:
        hi = float(orb_high)
        lo = float(orb_low)
    except (TypeError, ValueError):
        hi, lo = None, None

    out = {}
    for cp, cutoff in CHECKPOINT_CUTOFFS.items():
        eligible = [b for b in bars if b["mins"] <= cutoff]
        setup, direction = _decide_at_cutoff(eligible, orb_high, orb_low, pdh, pdl)
        if direction == "none" and eligible and hi is not None and lo is not None:
            latest_close = eligible[-1]["c"]
            if baseline_direction == "long" and latest_close > hi:
                setup, direction = "continuation", "long"
            elif baseline_direction == "short" and latest_close < lo:
                setup, direction = "continuation", "short"
        # A same-side reversal can qualify inside the opening range. It must
        # not keep a 10:30 breakout candidate once that breakout has failed.
        if eligible and direction == baseline_direction:
            latest_close = eligible[-1]["c"]
            if ((direction == "long" and (hi is None or latest_close <= hi)) or
                    (direction == "short" and (lo is None or latest_close >= lo))):
                setup, direction = "none", "none"
        out[cp] = {"setup": setup, "direction": direction}
    return out


def _levels_from_bars(bars, session_date):
    """Build the orb_breakout levels dict from session bars (backfill use)."""
    orb = next((b for b in bars if b["mins"] == ORB_START_MINS), None)
    confirm = next((b for b in bars if b["mins"] == CONFIRM_START_MINS), None)
    if orb is None or confirm is None:
        return None
    return {
        "orb_high": round(orb["h"], 4),
        "orb_low": round(orb["l"], 4),
        "confirm_close": round(confirm["c"], 4),
        "confirm_time": "%sT%02d:%02d:00" % (
            session_date, CONFIRM_START_MINS // 60, CONFIRM_START_MINS % 60),
        "day_high": round(max(b["h"] for b in bars), 4),
        "day_low": round(min(b["l"] for b in bars), 4),
        "last_price": round(bars[-1]["c"], 4),
        "session_date": session_date,
    }


def _prev_session_levels(session_date):
    """Map ticker -> {pdh, pdl} from the latest daily session before date."""
    try:
        with get_connection() as conn:
            rows = conn.execute(
                """SELECT ticker, high, low FROM candles
                   WHERE date = (SELECT MAX(date) FROM candles WHERE date < ?)""",
                (session_date,),
            ).fetchall()
        return {r["ticker"]: {"pdh": r["high"], "pdl": r["low"]} for r in rows}
    except Exception as e:
        logger.warning("ORB decisions: prev-session lookup failed: %s", e)
        return {}


def run_orb_decisions(session_date=None):
    """Evaluate Criteria-2 checkpoints and upsert into orb_decisions.

    Runs once daily at 11:35 AM ET. Same chunked 15m fetch as the
    10:45 scan (regular session only — no premarket needed since
    sweeps test ORB + PDH/PDL only). Skips storing when the market
    is closed. Idempotent per (ticker, session_date, checkpoint).
    """
    from services.universe import get_merged_universe_with_metadata

    today = datetime.now(_ET).date().isoformat()
    session_date = session_date or today

    universe = get_merged_universe_with_metadata()
    tickers = [u["ticker"] for u in universe if u.get("ticker")]
    if not tickers:
        logger.warning("ORB decisions: empty universe, nothing to do")
        return {"session_date": session_date, "decided": 0,
                "scanned_at": datetime.now().isoformat()}

    prev_levels = _prev_session_levels(session_date)
    with get_connection() as conn:
        baseline_signals = {r["ticker"]: r["signal"] for r in conn.execute(
            "SELECT ticker, signal FROM orb_breakout WHERE session_date = ?", (session_date,))}
    have_baseline = set(baseline_signals)
    rows, baselines, latest_bar = [], [], None
    for i in range(0, len(tickers), CHUNK_SIZE):
        chunk = tickers[i:i + CHUNK_SIZE]
        data = _fetch_chunk(chunk)
        for ticker in chunk:
            frame = _ticker_frame(data, ticker) if data is not None else None
            bars, bar_session = _session_bars(frame) if frame is not None else (None, None)
            if not bars or bar_session != session_date:
                continue  # missing data or market closed — never store stale
            orb = next((b for b in bars if b["mins"] == ORB_START_MINS), None)
            if orb is None:
                continue
            if ticker not in have_baseline:
                # 10:45 missed this ticker: backfill its baseline row so
                # the board can show its checkpoint decisions.
                levels = _levels_from_bars(bars, session_date)
                if levels is not None:
                    baselines.append({**levels, "ticker": ticker,
                                      "signal": classify_orb(levels["orb_high"],
                                                             levels["orb_low"],
                                                             levels["confirm_close"]),
                                      "insufficient_data": 0})
                    baseline_signals[ticker] = baselines[-1]["signal"]
                    have_baseline.add(ticker)
            if latest_bar is None or bars[-1]["mins"] > latest_bar["mins"]:
                latest_bar = bars[-1]
            pl = prev_levels.get(ticker, {})
            decisions = decide_checkpoints(bars, orb["h"], orb["l"],
                                           pl.get("pdh"), pl.get("pdl"),
                                           baseline_signals.get(ticker, "none"))
            for cp, d in decisions.items():
                rows.append({"ticker": ticker, "session_date": session_date,
                             "checkpoint": cp, "setup": d["setup"],
                             "direction": d["direction"]})
        if i + CHUNK_SIZE < len(tickers):
            time.sleep(CHUNK_SLEEP_SECONDS)

    logger.info("ORB decisions: latest bar %s (delay check)",
                ("%02d:%02d ET" % (latest_bar["mins"] // 60, latest_bar["mins"] % 60))
                if latest_bar else "none")

    if not rows:
        logger.info("ORB decisions: no rows to store (market closed?)")
        return {"session_date": session_date, "decided": 0,
                "scanned_at": datetime.now().isoformat()}

    with get_connection() as conn:
        for r in rows:
            conn.execute(
                """INSERT OR REPLACE INTO orb_decisions
                   (ticker, session_date, checkpoint, setup, direction, updated_at)
                   VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)""",
                (r["ticker"], r["session_date"], r["checkpoint"],
                 r["setup"], r["direction"]),
            )
        for b in baselines:
            conn.execute(
                """INSERT OR REPLACE INTO orb_breakout
                   (ticker, session_date, orb_high, orb_low, confirm_close,
                    confirm_time, day_high, day_low, last_price,
                    signal, insufficient_data, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)""",
                (b["ticker"], b["session_date"], b["orb_high"], b["orb_low"],
                 b["confirm_close"], b["confirm_time"], b["day_high"],
                 b["day_low"], b["last_price"], b["signal"]),
            )

    decided = len({r["ticker"] for r in rows})
    logger.info("ORB decisions complete session=%s tickers=%d baselines_backfilled=%d",
                session_date, decided, len(baselines))
    return {"session_date": session_date, "decided": decided,
            "baselines_backfilled": len(baselines),
            "scanned_at": datetime.now().isoformat()}
