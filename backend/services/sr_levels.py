"""
sr_levels.py — Support/Resistance level detection and alert service.

Detects when a stock's candle touches a Support or Resistance level and
identifies four candle patterns:

  Pattern A — Same-candle bounce/rejection (level holds)
  Pattern B — Two-candle confirmed bounce/rejection (level holds)
  Pattern C — Same-candle break/breakout (level fails, no prior touch)
  Pattern D — Two-candle confirmed break/breakout (level fails, prior touch)

Pattern Priority: A → B → C → D (first match wins, mutually exclusive).

Also provides S/R level calculation via local pivot points and cooldown
gating for alert deduplication.
"""

import math
import logging
from datetime import date, timedelta

from config import SR_TOUCH_BUFFER, SR_COOLDOWN_DAYS
from models.db import get_connection

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _safe_float(val):
    """Return a finite float, or None for NaN/Inf."""
    try:
        f = float(val)
        return None if (math.isnan(f) or math.isinf(f)) else f
    except (TypeError, ValueError):
        return None


def _build_candle(candle: dict) -> dict | None:
    """Build a normalized candle dict with direction flags.

    Accepts {date, open, high, low, close} and returns
    {date, o, h, l, c, bullish, bearish} or None if any value is NaN/Inf.
    """
    o = _safe_float(candle.get("open"))
    h = _safe_float(candle.get("high"))
    l = _safe_float(candle.get("low"))
    c = _safe_float(candle.get("close"))
    if None in (o, h, l, c):
        return None
    return {
        "date": candle.get("date"),
        "o": o,
        "h": h,
        "l": l,
        "c": c,
        "bullish": c > o,
        "bearish": c < o,
    }


# ---------------------------------------------------------------------------
# Core detection logic
# ---------------------------------------------------------------------------

def detect_sr_touch(candles: list[dict], sr_levels: list[dict]) -> list[dict]:
    """Detect S/R touch patterns for recent candles.

    Evaluates the two most recent candles against each S/R level using
    pattern priority A → B → C → D.

    Args:
        candles: List of {date, open, high, low, close} (at least 2 days).
        sr_levels: List of {id, price, type} where type is 'support' or
                   'resistance'.

    Returns:
        List of {sr_id, pattern, ticker, sr_price, sr_type, candle_date}.
        Empty list if no patterns match.
    """
    if len(candles) < 2:
        logger.debug("sr_levels: need >= 2 candles, got %d", len(candles))
        return []

    # Build normalized candles (most recent = c1, prior = c2)
    c2_raw = candles[-2]
    c1_raw = candles[-1]
    c1 = _build_candle(c1_raw)
    c2 = _build_candle(c2_raw)

    if c1 is None:
        logger.warning("sr_levels: latest candle has NaN values, skipping")
        return []

    results = []

    for level in sr_levels:
        sr_id = level.get("id")
        sr_price = _safe_float(level.get("price"))
        sr_type = level.get("type")
        ticker = level.get("ticker", "")

        if sr_price is None or sr_type not in ("support", "resistance"):
            continue

        pattern = _match_pattern(sr_type, sr_price, c1, c2)

        if pattern:
            results.append({
                "sr_id": sr_id,
                "pattern": pattern,
                "ticker": ticker,
                "sr_price": sr_price,
                "sr_type": sr_type,
                "candle_date": c1["date"],
            })

    return results


def _match_pattern(sr_type: str, sr_price: float, c1: dict, c2: dict | None) -> str | None:
    """Match candle patterns A → D for a single S/R level.

    Returns the pattern letter or None if no pattern matches.
    """
    if sr_type == "support":
        return _match_support(sr_price, c1, c2)
    else:
        return _match_resistance(sr_price, c1, c2)


def _match_support(sr_price: float, c1: dict, c2: dict | None) -> str | None:
    """Match support-level patterns. Wick low must reach within buffer."""
    touch_thresh = sr_price * (1 + SR_TOUCH_BUFFER)

    # Pattern A: same candle touched + closed above support
    if (c1["l"] <= touch_thresh
            and c1["c"] > sr_price):
        return "A"

    # Pattern B: yesterday touched, today confirmed the bounce
    if (c2 and c2["l"] <= touch_thresh
            and c1["c"] > sr_price):
        return "B"

    # Pattern C: same candle touched + closed below support (break)
    # Only fires if previous candle did NOT touch (otherwise Pattern D)
    if (c1["l"] <= touch_thresh
            and c1["c"] < sr_price
            and c1["bearish"]
            and (not c2 or c2["l"] > touch_thresh)):
        return "C"

    # Pattern D: yesterday touched, today confirmed the break
    if (c2 and c2["l"] <= touch_thresh
            and c1["c"] < sr_price
            and c1["bearish"]):
        return "D"

    return None


def _match_resistance(sr_price: float, c1: dict, c2: dict | None) -> str | None:
    """Match resistance-level patterns. Wick high must reach within buffer."""
    touch_thresh = sr_price * (1 - SR_TOUCH_BUFFER)

    # Pattern A: same candle touched + closed below resistance
    if (c1["h"] >= touch_thresh
            and c1["c"] < sr_price):
        return "A"

    # Pattern B: yesterday touched, today confirmed the rejection
    if (c2 and c2["h"] >= touch_thresh
            and c1["c"] < sr_price):
        return "B"

    # Pattern C: same candle touched + closed above resistance (breakout)
    # Only fires if previous candle did NOT touch (otherwise Pattern D)
    if (c1["h"] >= touch_thresh
            and c1["c"] > sr_price
            and c1["bullish"]
            and (not c2 or c2["h"] < touch_thresh)):
        return "C"

    # Pattern D: yesterday touched, today confirmed the breakout
    if (c2 and c2["h"] >= touch_thresh
            and c1["c"] > sr_price
            and c1["bullish"]):
        return "D"

    return None


# ---------------------------------------------------------------------------
# S/R level calculation
# ---------------------------------------------------------------------------

def calculate_sr_levels(candles: list[dict]) -> list[dict]:
    """Calculate support/resistance levels from OHLCV candle data.

    Uses the pivot-point method:
      - Support:    local minima where low < prev low AND low < next low
      - Resistance: local maxima where high > prev high AND high > next high

    Requires at least 3 candles for pivot detection. The first and last
    candles cannot be pivots (no neighbor on one side).

    Args:
        candles: List of {date, open, high, low, close}.

    Returns:
        List of {price, type} where type is 'support' or 'resistance'.
        Prices are rounded to 4 decimal places.
    """
    if len(candles) < 3:
        return []

    levels = []

    for i in range(1, len(candles) - 1):
        prev = candles[i - 1]
        curr = candles[i]
        next_ = candles[i + 1]

        prev_low = _safe_float(prev.get("low"))
        curr_low = _safe_float(curr.get("low"))
        next_low = _safe_float(next_.get("low"))

        prev_high = _safe_float(prev.get("high"))
        curr_high = _safe_float(curr.get("high"))
        next_high = _safe_float(next_.get("high"))

        # Skip if any values are NaN/Inf
        if None in (prev_low, curr_low, next_low, prev_high, curr_high, next_high):
            continue

        # Support: local minimum
        if curr_low < prev_low and curr_low < next_low:
            levels.append({
                "price": round(curr_low, 4),
                "type": "support",
            })

        # Resistance: local maximum
        if curr_high > prev_high and curr_high > next_high:
            levels.append({
                "price": round(curr_high, 4),
                "type": "resistance",
            })

    return levels


# ---------------------------------------------------------------------------
# Cooldown management
# ---------------------------------------------------------------------------

def check_cooldown(conn, sr_id: int, days: int = None) -> bool:
    """Check if an S/R alert is in cooldown period.

    An alert is in cooldown if the same sr_id (matched by sr_price + sr_type
    + ticker) has fired within the last `days` days.

    Args:
        conn: Active sqlite3 connection.
        sr_id: The S/R level ID from sr_levels table.
        days: Cooldown window in days. Defaults to SR_COOLDOWN_DAYS.

    Returns:
        True if the alert is in cooldown (should NOT fire).
        False if the alert is clear to fire.
    """
    if days is None:
        days = SR_COOLDOWN_DAYS

    if days <= 0:
        return False

    cutoff = (date.today() - timedelta(days=days)).isoformat()

    # Look up the S/R level to get price and type for matching
    level = conn.execute(
        "SELECT price, type FROM sr_levels WHERE id = ?", (sr_id,)
    ).fetchone()

    if not level:
        return False

    # Check if any alert was logged for this price/type combination within cooldown
    row = conn.execute(
        "SELECT COUNT(*) FROM sr_alert_log "
        "WHERE sr_price = ? AND sr_type = ? AND alerted_date >= ?",
        (level["price"], level["type"], cutoff),
    ).fetchone()

    return row[0] > 0


def log_alert(conn, sr_id: int, ticker: str, sr_price: float,
              sr_type: str, pattern: str, alert_date: str):
    """Log a fired S/R alert to the sr_alert_log table.

    This records the alert for cooldown tracking and history display.

    Args:
        conn: Active sqlite3 connection.
        sr_id: The S/R level ID (for reference; not stored in log table).
        ticker: Stock ticker symbol.
        sr_price: The support/resistance price level.
        sr_type: 'support' or 'resistance'.
        pattern: Alert pattern letter ('A', 'B', 'C', or 'D').
        alert_date: ISO date string (YYYY-MM-DD) of the alert.
    """
    conn.execute(
        "INSERT INTO sr_alert_log (ticker, sr_price, sr_type, pattern, alerted_date) "
        "VALUES (?, ?, ?, ?, ?)",
        (ticker, sr_price, sr_type, pattern, alert_date),
    )
    logger.info(
        "sr_levels: alert logged — %s %s @ %.4f pattern=%s date=%s",
        ticker, sr_type, sr_price, pattern, alert_date,
    )


def check_cooldown_history(conn, ticker: str, sr_type: str,
                            sr_price: float, days: int = None) -> bool:
    """Check if an S/R alert is in cooldown using the alert_history table.

    Looks for recent entries matching the same ticker + type + price pattern.
    This replaces check_cooldown() for the new user-drawn S/R alert system.

    Args:
        conn: Active sqlite3 connection.
        ticker: Stock ticker symbol.
        sr_type: 'support' or 'resistance'.
        sr_price: The S/R price level.
        days: Cooldown window in days. Defaults to SR_COOLDOWN_DAYS.

    Returns:
        True if the alert is in cooldown (should NOT fire).
        False if the alert is clear to fire.
    """
    if days is None:
        days = SR_COOLDOWN_DAYS

    if days <= 0:
        return False

    cutoff = (date.today() - timedelta(days=days)).isoformat()

    # Match on ticker + type + price embedded in the message
    row = conn.execute(
        "SELECT COUNT(*) FROM alert_history "
        "WHERE ticker = ? AND type = 'sr_touch' "
        "AND message LIKE ? AND fired_at >= ?",
        (ticker, f"%${sr_price:.2f}%", cutoff),
    ).fetchone()

    return row[0] > 0


def log_to_alert_history(conn, ticker: str, sr_type: str, sr_price: float,
                          pattern: str, channel: str = "discord+email") -> bool:
    """Log an S/R alert to the alert_history table.

    Uses avg_price = sr_price so the unique index
    (ticker, type, avg_price, date(fired_at)) can enforce per-level
    deduplication.  Different S/R levels for the same ticker each get
    their own log entry because they have different avg_price values.

    Args:
        conn: Active sqlite3 connection.
        ticker: Stock ticker symbol.
        sr_type: 'support' or 'resistance'.
        sr_price: The S/R price level.
        pattern: Alert pattern letter ('A', 'B', 'C', or 'D').
        channel: Notification channel(s) that fired.

    Returns:
        True if the row was inserted (new alert).  False if it was
        ignored because a duplicate already exists for this
        ticker+type+price on the same date.
    """
    message = f"{ticker} — {sr_type.title()} ${sr_price:.2f} — Pattern {pattern}"
    cursor = conn.execute(
        "INSERT OR IGNORE INTO alert_history "
        "(ticker, type, message, channel, avg_price) "
        "VALUES (?, ?, ?, ?, ?)",
        (ticker, "sr_touch", message, channel, sr_price),
    )
    inserted = cursor.rowcount > 0
    if inserted:
        logger.info(
            "alert_history: logged — %s %s @ %.4f pattern=%s channel=%s",
            ticker, sr_type, sr_price, pattern, channel,
        )
    else:
        logger.debug(
            "alert_history: skipped (duplicate) — %s %s @ %.4f pattern=%s",
            ticker, sr_type, sr_price, pattern,
        )
    return inserted
