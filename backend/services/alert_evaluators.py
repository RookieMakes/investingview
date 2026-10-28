"""
alert_evaluators.py — Alert evaluation engines.

Pure functions that evaluate alert conditions and return structured results.
No Flask, no scheduler, no notification dependencies — those are handled
by the callers (routes, scheduler jobs).
"""

import logging
from datetime import date, timedelta

from models.db import get_connection
from config import PRICE_ALERT_COOLDOWN_DAYS

logger = logging.getLogger(__name__)


def evaluate_price_alerts(conn) -> list[dict]:
    """Evaluate all armed price_above/price_below alerts against live quotes.

    Args:
        conn: Active sqlite3 connection (caller manages transaction).

    Returns:
        List of dicts where condition is met:
        {
            "alert_id": int,
            "ticker": str,
            "type": str,          # "price_above" or "price_below"
            "threshold": float,
            "current_price": float,
            "change_pct": float,
        }
    """
    from data.fetcher import get_quotes

    alerts = conn.execute(
        "SELECT id, ticker, type, threshold FROM alerts "
        "WHERE armed = 1 AND type IN ('price_above', 'price_below') "
        "AND threshold IS NOT NULL"
    ).fetchall()

    if not alerts:
        return []

    tickers = list({a["ticker"] for a in alerts})
    quotes = get_quotes(tickers, use_cache=True)
    quote_map = {q["ticker"]: q for q in quotes if q["price"] is not None}

    fired = []
    for alert in alerts:
        ticker = alert["ticker"]
        quote = quote_map.get(ticker)
        if not quote or quote["price"] is None:
            continue

        current_price = quote["price"]
        threshold = alert["threshold"]
        alert_type = alert["type"]

        triggered = False
        if alert_type == "price_above" and current_price >= threshold:
            triggered = True
        elif alert_type == "price_below" and current_price <= threshold:
            triggered = True

        if triggered:
            fired.append({
                "alert_id": alert["id"],
                "ticker": ticker,
                "type": alert_type,
                "threshold": threshold,
                "current_price": current_price,
                "change_pct": quote.get("change_pct", 0),
            })

    return fired


def check_price_alert_cooldown(conn, alert_id: int, days: int = None) -> bool:
    """Check if a price alert is in cooldown (should NOT fire).

    Args:
        conn: Active sqlite3 connection.
        alert_id: The alert ID from the alerts table.
        days: Cooldown window. Defaults to PRICE_ALERT_COOLDOWN_DAYS.

    Returns:
        True if in cooldown.
    """
    if days is None:
        days = PRICE_ALERT_COOLDOWN_DAYS
    if days <= 0:
        return False

    cutoff = (date.today() - timedelta(days=days)).isoformat()
    row = conn.execute(
        "SELECT COUNT(*) FROM alert_history "
        "WHERE alert_id = ? AND fired_at >= ?",
        (alert_id, cutoff),
    ).fetchone()
    return row[0] > 0


def log_price_alert_to_history(conn, alert_id: int, ticker: str,
                                alert_type: str, threshold: float,
                                current_price: float, channel: str):
    """Log a fired price alert to alert_history.

    Args:
        conn: Active sqlite3 connection.
        alert_id: The alerts table row ID.
        ticker: Stock ticker.
        alert_type: "price_above" or "price_below".
        threshold: The alert threshold.
        current_price: Price at time of firing.
        channel: Notification channel string (e.g. "discord+email").
    """
    direction = "above" if alert_type == "price_above" else "below"
    message = (
        f"{ticker} price crossed {direction} ${threshold:.2f} "
        f"(current: ${current_price:.2f})"
    )
    conn.execute(
        "INSERT OR IGNORE INTO alert_history (alert_id, ticker, type, message, channel) "
        "VALUES (?, ?, ?, ?, ?)",
        (alert_id, ticker, alert_type, message, channel),
    )


def evaluate_avg_price_crosses(conn, filter_ticker: str = None) -> list[dict]:
    """Evaluate positions for avg price cross/touch events.

    Args:
        conn: Active sqlite3 connection.
        filter_ticker: Optional ticker to check (None = all positions).

    Returns:
        List of fired event dicts:
        {
            "ticker": str,
            "position_id": int,
            "qty": float,
            "portfolio_id": int,
            "portfolio_name": str,
            "avgPrice": float,
            "close": float, "open": float, "high": float, "low": float,
            "pattern": str,     # cross_above, cross_below, touch_bullish, touch_bearish
            "direction": str,   # "bullish" or "bearish" (for dedup grouping)
            "type": str,        # "cross" or "touch"
        }
    """
    if filter_ticker:
        positions = conn.execute(
            "SELECT p.id AS position_id, p.ticker, p.qty, p.avg_price, "
            "p.portfolio_id, pf.name AS portfolio_name "
            "FROM positions p "
            "LEFT JOIN universe u ON p.ticker = u.ticker "
            "LEFT JOIN portfolios pf ON p.portfolio_id = pf.id "
            "WHERE p.ticker = ? AND p.avg_price > 0 "
            "AND (u.sector IS NULL OR u.sector != 'ETF')",
            (filter_ticker,),
        ).fetchall()
    else:
        positions = conn.execute(
            "SELECT p.id AS position_id, p.ticker, p.qty, p.avg_price, "
            "p.portfolio_id, pf.name AS portfolio_name "
            "FROM positions p "
            "LEFT JOIN universe u ON p.ticker = u.ticker "
            "LEFT JOIN portfolios pf ON p.portfolio_id = pf.id "
            "WHERE p.avg_price > 0 "
            "AND (u.sector IS NULL OR u.sector != 'ETF')"
        ).fetchall()

    fired = []
    for pos in positions:
        ticker = pos["ticker"]
        avg_price = pos["avg_price"]

        row = conn.execute(
            "SELECT open, high, low, close FROM candles "
            "WHERE ticker = ? ORDER BY date DESC LIMIT 1",
            (ticker,),
        ).fetchone()
        if not row:
            continue

        open_p, high_p, low_p, close_p = (
            row["open"], row["high"], row["low"], row["close"]
        )

        buffer = avg_price * 0.003
        touched = low_p <= avg_price + buffer and high_p >= avg_price - buffer
        if not touched:
            continue

        same_candle_cross = (
            (open_p > avg_price and close_p < avg_price)
            or (open_p < avg_price and close_p > avg_price)
        )

        if same_candle_cross:
            pattern = "cross_above" if close_p > avg_price else "cross_below"
            msg_type = "cross"
        elif close_p > avg_price:
            pattern = "touch_bullish"
            msg_type = "touch"
        elif close_p < avg_price:
            pattern = "touch_bearish"
            msg_type = "touch"
        else:
            continue

        # Group patterns by direction for dedup:
        # cross_above + touch_bullish → "bullish"
        # cross_below + touch_bearish → "bearish"
        direction = "bullish" if pattern in ("cross_above", "touch_bullish") else "bearish"

        fired.append({
            "ticker": ticker,
            "position_id": pos["position_id"],
            "qty": pos["qty"],
            "portfolio_id": pos["portfolio_id"],
            "portfolio_name": pos["portfolio_name"],
            "avgPrice": avg_price,
            "close": close_p,
            "open": open_p,
            "high": high_p,
            "low": low_p,
            "pattern": pattern,
            "direction": direction,
            "type": msg_type,
        })

    return fired
