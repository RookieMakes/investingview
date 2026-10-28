"""Daily-close trailing stops, owned by a portfolio holding.

Only completed regular-session candles are used. Touch the old stop first;
if it survives, the close raises tomorrow's stop. No intra-candle ordering
is inferred. Network fetches happen outside the short state transactions.
"""

import math
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP
from zoneinfo import ZoneInfo

from models.db import get_connection

ET = ZoneInfo("America/New_York")


class StopError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def now_et():
    return datetime.now(ET)


def price(value):
    """Stop levels match the chart's two-decimal price scale."""
    try:
        if isinstance(value, bool) or not math.isfinite(float(value)):
            raise ValueError
        return float(Decimal(str(value)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))
    except (ValueError, TypeError, ArithmeticError):
        raise StopError("Stop price must be a finite positive number") from None


def eligible_from(now):
    """First possible full US/Canadian session; holidays have no candle."""
    now = now.astimezone(ET)
    day = now.date()
    if now.time() >= time(9, 30):
        day += timedelta(days=1)
    while day.weekday() >= 5:
        day += timedelta(days=1)
    return day.isoformat()


def completed_candles(candles, now=None):
    """Filter partial sessions; reject bad bars rather than skipping past them."""
    now = (now or now_et()).astimezone(ET)
    result = []
    for raw in candles:
        try:
            day = date.fromisoformat(raw["date"])
        except (KeyError, TypeError, ValueError):
            raise StopError("Market data contains an invalid candle date", 503) from None
        if day > now.date() or day.weekday() >= 5:
            continue
        # Settlement buffer also avoids using a still-changing 4 PM bar.
        if day == now.date() and now.time() < time(16, 15):
            continue
        try:
            values = {key: float(raw[key]) for key in ("open", "high", "low", "close")}
            if not all(math.isfinite(v) and v > 0 for v in values.values()):
                raise ValueError
            if not (values["low"] <= min(values["open"], values["close"])
                    <= max(values["open"], values["close"]) <= values["high"]):
                raise ValueError
        except (KeyError, TypeError, ValueError):
            raise StopError(f"Incomplete market data for {day}; stop not advanced", 503) from None
        result.append({"date": day.isoformat(), **values})
    return sorted(result, key=lambda candle: candle["date"])


def fetch_candles(ticker, now=None, since=None):
    from data.fetcher import get_ohlcv

    now = now or now_et()
    # Cover the checkpoint even after a long interruption.
    period = "max" if since and (now.date() - date.fromisoformat(since)).days > 300 else "1y"
    try:
        candles = get_ohlcv(ticker, period=period, force_refresh=True)
    except Exception as error:
        raise StopError("Daily market data is unavailable; please try again", 503) from error
    return completed_candles(candles, now)


def reference_close(ticker, now=None):
    now = now or now_et()
    candles = fetch_candles(ticker, now)
    if not candles:
        raise StopError("A completed daily close is not available yet", 503)
    latest = candles[-1]
    if (now.date() - date.fromisoformat(latest["date"])).days > 7:
        raise StopError("The latest daily close is stale; try again when data is available", 503)
    return {"date": latest["date"], "close": price(latest["close"])}


def holding(conn, portfolio_id, ticker):
    row = conn.execute(
        "SELECT p.id, pf.name AS portfolio_name FROM positions p "
        "JOIN portfolios pf ON pf.id = p.portfolio_id "
        "WHERE p.portfolio_id = ? AND p.ticker = ? AND p.qty > 0",
        (portfolio_id, ticker),
    ).fetchone()
    if not row:
        raise StopError("Position not found in this portfolio", 404)
    return row


def get_stop(portfolio_id, ticker):
    with get_connection() as conn:
        holding(conn, portfolio_id, ticker)
        row = conn.execute(
            "SELECT * FROM trailing_stops WHERE portfolio_id = ? AND ticker = ?",
            (portfolio_id, ticker),
        ).fetchone()
    return dict(row) if row else None


def save_stop(portfolio_id, ticker, data, rearm=False, now=None):
    now = now or now_et()
    stop_price = price(data.get("stop_price"))
    if stop_price <= 0:
        raise StopError("Stop price must be positive")
    with get_connection() as conn:
        position_id = holding(conn, portfolio_id, ticker)["id"]
    reference = reference_close(ticker, now)
    if (data.get("reference_date") != reference["date"]
            or price(data.get("reference_close")) != reference["close"]):
        raise StopError("The reference close changed. Refresh the setup and save again.", 409)
    distance = price(reference["close"] - stop_price)
    if distance <= 0:
        raise StopError("Stop price must be below the completed daily close")
    with get_connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        if holding(conn, portfolio_id, ticker)["id"] != position_id:
            raise StopError("The holding changed. Reopen the chart and try again.", 409)
        old = conn.execute(
            "SELECT * FROM trailing_stops WHERE portfolio_id = ? AND ticker = ?",
            (portfolio_id, ticker),
        ).fetchone()
        if rearm:
            if not old or old["state"] != "hit":
                raise StopError("Only a hit stop can be re-armed", 409)
            if data.get("stop_id") != old["id"] or data.get("cycle") != old["cycle"]:
                raise StopError("This stop changed. Reopen the setup and try again.", 409)
        elif old:
            raise StopError("This holding already has a trailing stop", 409)

        activated = now.astimezone(timezone.utc).isoformat()
        start = eligible_from(now)
        if rearm:
            conn.execute(
                "UPDATE trailing_stops SET initial_stop = ?, reference_close = ?, "
                "reference_date = ?, trail_amount = ?, stop_price = ?, state = 'active', "
                "cycle = cycle + 1, activated_at = ?, eligible_from = ?, "
                "last_processed_date = NULL, hit_date = NULL, hit_open = NULL, "
                "hit_high = NULL, hit_low = NULL, hit_close = NULL, hit_at = NULL, "
                "updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                (stop_price, reference["close"], reference["date"], distance,
                 stop_price, activated, start, old["id"]),
            )
        else:
            conn.execute(
                "INSERT INTO trailing_stops (portfolio_id, position_id, ticker, "
                "initial_stop, reference_close, reference_date, trail_amount, "
                "stop_price, activated_at, eligible_from) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (portfolio_id, position_id, ticker, stop_price, reference["close"],
                 reference["date"], distance, stop_price, activated, start),
            )
        return dict(conn.execute(
            "SELECT * FROM trailing_stops WHERE portfolio_id = ? AND ticker = ?",
            (portfolio_id, ticker),
        ).fetchone())


def remove_stop(portfolio_id, ticker, stop_id, cycle):
    with get_connection() as conn:
        holding(conn, portfolio_id, ticker)
        deleted = conn.execute(
            "DELETE FROM trailing_stops WHERE portfolio_id = ? AND ticker = ? AND id = ? AND cycle = ?",
            (portfolio_id, ticker, stop_id, cycle),
        ).rowcount
        if not deleted:
            raise StopError("This stop changed. Reopen the chart and try again.", 409)


def advance_stop(stop, candles):
    """Pure transition over chronologically ordered completed candles."""
    state = dict(stop)
    if state["state"] != "active":
        return state
    for candle in sorted(candles, key=lambda bar: bar["date"]):
        day = candle["date"]
        if day < state["eligible_from"] or day <= (state.get("last_processed_date") or ""):
            continue
        state["last_processed_date"] = day
        if candle["low"] <= state["stop_price"]:
            state.update(state="hit", hit_date=day)
            for key in ("open", "high", "low", "close"):
                state[f"hit_{key}"] = candle[key]
            break
        state["stop_price"] = max(state["stop_price"], price(candle["close"] - state["trail_amount"]))
    return state


def evaluate_ticker(ticker, candles, now=None):
    """Commit state + history before callers deliver notifications.

    Reload under a writer lock so simultaneous jobs, re-arms and removals
    cannot emit an event for an obsolete cycle.
    """
    now = now or now_et()
    candles = completed_candles(candles, now)
    if not candles:
        return []
    events = []
    with get_connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        stops = conn.execute(
            "SELECT ts.*, pf.name AS portfolio_name FROM trailing_stops ts "
            "JOIN positions p ON p.id = ts.position_id AND p.portfolio_id = ts.portfolio_id "
            "AND p.ticker = ts.ticker JOIN portfolios pf ON pf.id = ts.portfolio_id "
            "WHERE ts.ticker = ? AND ts.state = 'active' AND p.qty > 0", (ticker,),
        ).fetchall()
        for row in stops:
            old = dict(row)
            checkpoint = old["last_processed_date"] or old["reference_date"]
            if candles[0]["date"] > checkpoint:
                # The provider's retained history no longer covers this stop.
                raise StopError(f"Daily history for {ticker} does not cover the stop checkpoint", 503)
            new = advance_stop(old, candles)
            if new["last_processed_date"] == old["last_processed_date"]:
                continue
            hit_at = now.astimezone(timezone.utc).isoformat() if new["state"] == "hit" else None
            conn.execute(
                "UPDATE trailing_stops SET stop_price = ?, state = ?, last_processed_date = ?, "
                "hit_date = ?, hit_open = ?, hit_high = ?, hit_low = ?, hit_close = ?, hit_at = ?, "
                "updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                (new["stop_price"], new["state"], new["last_processed_date"], new.get("hit_date"),
                 new.get("hit_open"), new.get("hit_high"), new.get("hit_low"), new.get("hit_close"),
                 hit_at, new["id"]),
            )
            if new["state"] != "hit":
                continue
            key = f"trailing_stop:{new['id']}:{new['cycle']}"
            message = (
                f"{ticker} — Trailing Stop HIT — {new['portfolio_name']} "
                f"(portfolio #{new['portfolio_id']}) — Stop ${new['stop_price']:.2f}; "
                f"trail ${new['trail_amount']:.2f}; candle {new['hit_date']}; "
                f"low ${new['hit_low']:.2f}; close ${new['hit_close']:.2f}"
            )
            inserted = conn.execute(
                "INSERT OR IGNORE INTO alert_history (ticker, type, message, channel, event_key) "
                "VALUES (?, 'trailing_stop_hit', ?, 'none', ?)", (ticker, message, key),
            ).rowcount
            if inserted:
                events.append({**new, "event_key": key, "message": message})
    return events
