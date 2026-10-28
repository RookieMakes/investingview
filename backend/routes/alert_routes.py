"""
alert_routes.py — Alert API endpoints.

CRUD for price/volume/SR alerts, arm/disarm toggle, and alert history.
Tables: alerts, alert_history (defined in models/schema.py).
"""

import logging

from flask import Blueprint, jsonify, request
from models.db import get_connection

logger = logging.getLogger(__name__)

alerts_bp = Blueprint('alerts', __name__)


@alerts_bp.route('/api/alerts', methods=['GET'])
def list_alerts():
    """List all alerts."""
    try:
        with get_connection() as conn:
            alerts = conn.execute("SELECT * FROM alerts ORDER BY ticker").fetchall()
        return jsonify([dict(a) for a in alerts])
    except Exception as e:
        logger.error("alerts.list.error: %s", e)
        return jsonify({"error": "Failed to list alerts"}), 500


@alerts_bp.route('/api/alerts', methods=['POST'])
def create_alert():
    """Create a new alert."""
    try:
        data = request.get_json()
        if not data or not data.get("ticker") or not data.get("type"):
            return jsonify({"error": "ticker and type are required"}), 400

        ticker = data["ticker"].upper().strip()
        alert_type = data["type"]

        valid_types = ["price_above", "price_below", "vol_spike", "sr_touch"]
        if alert_type not in valid_types:
            return jsonify({"error": f"Invalid type. Must be one of: {valid_types}"}), 400

        with get_connection() as conn:
            cursor = conn.execute(
                """INSERT INTO alerts (ticker, type, threshold, multiplier, watchlist)
                   VALUES (?, ?, ?, ?, ?)""",
                (ticker, alert_type, data.get("threshold"), data.get("multiplier"), data.get("watchlist")),
            )
            alert_id = cursor.lastrowid

        return jsonify({"id": alert_id, "status": "created"}), 201
    except Exception as e:
        logger.error("alerts.create.error: %s", e)
        return jsonify({"error": "Failed to create alert"}), 500


@alerts_bp.route('/api/alerts/<int:alert_id>', methods=['PUT'])
def update_alert(alert_id):
    """Update an alert."""
    try:
        data = request.get_json()
        if not data:
            return jsonify({"error": "No data provided"}), 400

        with get_connection() as conn:
            existing = conn.execute(
                "SELECT * FROM alerts WHERE id = ?", (alert_id,)
            ).fetchone()
            if not existing:
                return jsonify({"error": "Alert not found"}), 404

            conn.execute(
                """UPDATE alerts SET
                   ticker = COALESCE(?, ticker),
                   type = COALESCE(?, type),
                   threshold = COALESCE(?, threshold),
                   multiplier = COALESCE(?, multiplier),
                   watchlist = COALESCE(?, watchlist)
                   WHERE id = ?""",
                (
                    data.get("ticker", "").upper() if data.get("ticker") else None,
                    data.get("type"),
                    data.get("threshold"),
                    data.get("multiplier"),
                    data.get("watchlist"),
                    alert_id,
                ),
            )
        return jsonify({"status": "updated"})
    except Exception as e:
        logger.error("alerts.update.error id=%d: %s", alert_id, e)
        return jsonify({"error": "Failed to update alert"}), 500


@alerts_bp.route('/api/alerts/<int:alert_id>', methods=['DELETE'])
def delete_alert(alert_id):
    """Delete an alert."""
    try:
        with get_connection() as conn:
            existing = conn.execute(
                "SELECT * FROM alerts WHERE id = ?", (alert_id,)
            ).fetchone()
            if not existing:
                return jsonify({"error": "Alert not found"}), 404

            conn.execute("DELETE FROM alerts WHERE id = ?", (alert_id,))
        return jsonify({"status": "deleted"})
    except Exception as e:
        logger.error("alerts.delete.error id=%d: %s", alert_id, e)
        return jsonify({"error": "Failed to delete alert"}), 500


@alerts_bp.route('/api/alerts/<int:alert_id>/arm', methods=['PUT'])
def toggle_arm(alert_id):
    """Toggle arm/disarm an alert."""
    try:
        with get_connection() as conn:
            alert = conn.execute("SELECT armed FROM alerts WHERE id = ?", (alert_id,)).fetchone()
            if not alert:
                return jsonify({"error": "Alert not found"}), 404

            new_state = 0 if alert["armed"] else 1
            conn.execute("UPDATE alerts SET armed = ? WHERE id = ?", (new_state, alert_id))

        return jsonify({"armed": bool(new_state)})
    except Exception as e:
        logger.error("alerts.toggle_arm.error id=%d: %s", alert_id, e)
        return jsonify({"error": "Failed to toggle alert arm state"}), 500


@alerts_bp.route('/api/alerts/check-avg', methods=['POST'])
def check_avg_price_crosses():
    """Check positions for avg price cross/touch events.

    Dedup: Only ONE alert fires per position per day.
    cross_above + touch_bullish both map to "avg_price_bullish"
    cross_below + touch_bearish both map to "avg_price_bearish"
    """
    try:
        from services.alert_evaluators import evaluate_avg_price_crosses

        data = request.get_json(silent=True) or {}
        filter_ticker = (
            data.get("ticker", "").upper().strip()
            if data.get("ticker") else None
        )

        with get_connection() as conn:
            detected = evaluate_avg_price_crosses(conn, filter_ticker)

            # Filter to only events that actually fire (pass dedup)
            fired = []
            for event in detected:
                # Dedup by position: only ONE alert per position per day
                direction_type = f"avg_price_{event['direction']}"
                existing = conn.execute(
                    "SELECT COUNT(*) FROM alert_history "
                    "WHERE ticker = ? AND type = ? AND avg_price = ? "
                    "AND date(fired_at) = date('now')",
                    (event["ticker"], direction_type, event["avgPrice"]),
                ).fetchone()
                if existing[0] > 0:
                    continue

                # Preserve specific pattern in message for context
                pattern_label = event["pattern"].replace("_", " ").title()
                message = (
                    f"{pattern_label}: Price {event['type']}d average at "
                    f"${event['avgPrice']:.2f}. "
                    f"Close: ${event['close']:.2f}"
                )
                conn.execute(
                    "INSERT OR IGNORE INTO alert_history "
                    "(alert_id, ticker, type, message, channel, avg_price) "
                    "VALUES (NULL, ?, ?, ?, ?, ?)",
                    (
                        event["ticker"],
                        direction_type,
                        message,
                        "system",
                        event["avgPrice"],
                    ),
                )
                fired.append(event)

            if filter_ticker:
                count = conn.execute(
                    "SELECT COUNT(*) FROM positions p "
                    "LEFT JOIN universe u ON p.ticker = u.ticker "
                    "WHERE p.ticker = ? AND p.avg_price > 0 "
                    "AND (u.sector IS NULL OR u.sector != 'ETF')",
                    (filter_ticker,),
                ).fetchone()[0]
            else:
                count = conn.execute(
                    "SELECT COUNT(*) FROM positions p "
                    "LEFT JOIN universe u ON p.ticker = u.ticker "
                    "WHERE p.avg_price > 0 "
                    "AND (u.sector IS NULL OR u.sector != 'ETF')"
                ).fetchone()[0]

        return jsonify({"checked": count, "fired": fired})

    except Exception as e:
        logger.error("alerts.check_avg.error: %s", e)
        return jsonify({"error": "Failed to check avg price crosses"}), 500


@alerts_bp.route('/api/alerts/history', methods=['GET'])
def alert_history():
    """Get alert history."""
    try:
        limit = request.args.get("limit", 50, type=int)

        with get_connection() as conn:
            history = conn.execute(
                "SELECT * FROM alert_history ORDER BY fired_at DESC LIMIT ?",
                (limit,),
            ).fetchall()

        return jsonify([dict(h) for h in history])
    except Exception as e:
        logger.error("alerts.history.error: %s", e)
        return jsonify({"error": "Failed to fetch alert history"}), 500


@alerts_bp.route('/api/alerts/history', methods=['DELETE'])
def clear_alert_history():
    """Clear all alert history records."""
    try:
        with get_connection() as conn:
            conn.execute("DELETE FROM alert_history")
        return jsonify({"status": "cleared"})
    except Exception as e:
        logger.error("alerts.clear_history.error: %s", e)
        return jsonify({"error": "Failed to clear alert history"}), 500


@alerts_bp.route('/api/alerts/history/<int:alert_id>', methods=['GET'])
def alert_history_for_alert(alert_id):
    """Get history for a specific alert."""
    try:
        with get_connection() as conn:
            history = conn.execute(
                "SELECT * FROM alert_history WHERE alert_id = ? ORDER BY fired_at DESC",
                (alert_id,),
            ).fetchall()

        return jsonify([dict(h) for h in history])
    except Exception as e:
        logger.error("alerts.history_for_alert.error id=%d: %s", alert_id, e)
        return jsonify({"error": "Failed to fetch alert history"}), 500
