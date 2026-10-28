"""
chart_routes.py — Chart Dashboard API endpoints.

Tab management, user preferences, and alert log retrieval.
Serves the chart dashboard frontend.

Note: S/R line CRUD is handled by sr_routes.py (/api/sr/levels).
      OHLCV data is handled by data_routes.py (/api/data/history).
"""

import json
import logging

from flask import Blueprint, jsonify, request
from models.db import get_connection

log = logging.getLogger(__name__)

chart_bp = Blueprint('chart', __name__)

# ── Safety caps ──────────────────────────────────────────────────────────────
MAX_TICKERS_PER_TAB = 500
MAX_TABS = 50


# ── Tab Management ───────────────────────────────────────────────────────────

@chart_bp.route('/api/tabs', methods=['GET'])
def get_tabs():
    """Get all chart tabs."""
    with get_connection() as conn:
        row = conn.execute("SELECT data FROM tabs_config WHERE id = 1").fetchone()
    return jsonify({"data": json.loads(row["data"]) if row else None})


@chart_bp.route('/api/tabs', methods=['POST'])
def save_tabs():
    """Save chart tabs configuration.

    Expected body: { "tabs": [ { "id": ..., "name": ..., "tickers": [...] }, ... ] }
    Enforces MAX_TABS and MAX_TICKERS_PER_TAB safety limits.
    """
    data = request.get_json()
    if not data:
        return jsonify({"error": "No data provided"}), 400

    tabs = data.get("tabs", [])
    if len(tabs) > MAX_TABS:
        return jsonify({"error": f"Too many tabs (max {MAX_TABS})"}), 400

    for tab in tabs:
        tickers = tab.get("tickers", [])
        if len(tickers) > MAX_TICKERS_PER_TAB:
            name = tab.get("name", "unnamed")
            return jsonify({
                "error": f"Tab '{name}' has {len(tickers)} tickers (max {MAX_TICKERS_PER_TAB})"
            }), 400

    with get_connection() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO tabs_config(id, data) VALUES(1, ?)",
            [json.dumps(data)],
        )
    return jsonify({"ok": True})


@chart_bp.route('/api/tabs/tickers', methods=['GET'])
def get_all_tickers():
    """Get deduplicated list of all tickers across all tabs."""
    with get_connection() as conn:
        row = conn.execute("SELECT data FROM tabs_config WHERE id = 1").fetchone()

    if not row:
        return jsonify({"tickers": []})

    data = json.loads(row["data"])
    seen = set()
    tickers = []
    for tab in data.get("tabs", []):
        for t in tab.get("tickers", []):
            t_upper = t.upper().strip()
            if t_upper and t_upper not in seen:
                seen.add(t_upper)
                tickers.append(t_upper)

    return jsonify({"tickers": tickers})


# ── User Preferences ─────────────────────────────────────────────────────────

@chart_bp.route('/api/prefs', methods=['GET'])
def get_prefs():
    """Get all user preferences."""
    with get_connection() as conn:
        rows = conn.execute("SELECT key, value FROM user_prefs").fetchall()
    return jsonify({row["key"]: row["value"] for row in rows})


@chart_bp.route('/api/prefs', methods=['PUT'])
def update_prefs():
    """Update user preferences (upsert).

    Body: { "theme": "dark", "discord_webhook": "https://...", ... }
    """
    data = request.get_json()
    if not data:
        return jsonify({"error": "No data provided"}), 400

    with get_connection() as conn:
        for key, value in data.items():
            conn.execute(
                """
                INSERT INTO user_prefs (key, value)
                VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value = ?
                """,
                (key, str(value), str(value)),
            )

    return jsonify({"status": "updated"})


# ── Alert Log ────────────────────────────────────────────────────────────────

@chart_bp.route('/api/alerts/log', methods=['GET'])
def get_alert_log():
    """Get recent S/R alert log entries."""
    limit = request.args.get("limit", 20, type=int)
    if limit < 1:
        limit = 20
    elif limit > 100:
        limit = 100

    with get_connection() as conn:
        rows = conn.execute(
            "SELECT * FROM sr_alert_log ORDER BY alerted_at DESC LIMIT ?",
            (limit,)
        ).fetchall()

    return jsonify([dict(r) for r in rows])
