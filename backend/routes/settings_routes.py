"""
settings_routes.py — Settings API endpoints.

Settings screen stores Discord webhook URL, email configuration,
and app preferences in a key-value settings table.
"""

from flask import Blueprint, jsonify, request
from models.db import get_connection

settings_bp = Blueprint('settings', __name__)


@settings_bp.route('/api/settings/market-ticker', methods=['GET', 'PUT'])
def market_ticker_settings():
    """Read or save only the market ticker, independently of notifications."""
    from services import market_ticker_settings as ticker

    if request.method == 'GET':
        return jsonify(ticker.get_settings())
    try:
        return jsonify(ticker.save_settings(request.get_json(silent=True)))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@settings_bp.route('/api/settings', methods=['GET'])
def get_settings():
    """Get all settings."""
    with get_connection() as conn:
        rows = conn.execute("SELECT key, value FROM settings").fetchall()
        settings = {row["key"]: row["value"] for row in rows}
    return jsonify(settings)


@settings_bp.route('/api/settings', methods=['PUT'])
def update_settings():
    """Update settings (partial update)."""
    data = request.get_json()
    if not data:
        return jsonify({"error": "No data provided"}), 400

    with get_connection() as conn:
        for key, value in data.items():
            conn.execute("""
                INSERT INTO settings (key, value, updated_at)
                VALUES (?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = CURRENT_TIMESTAMP
            """, (key, str(value), str(value)))

    return jsonify({"status": "updated"})


@settings_bp.route('/api/settings/<key>', methods=['GET'])
def get_setting(key):
    """Get a single setting."""
    with get_connection() as conn:
        row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()

    if not row:
        return jsonify({"error": f"Setting '{key}' not found"}), 404

    return jsonify({"key": key, "value": row["value"]})


@settings_bp.route('/api/settings/<key>', methods=['PUT'])
def update_setting(key):
    """Update a single setting."""
    data = request.get_json()
    if not data or "value" not in data:
        return jsonify({"error": "No value provided"}), 400

    with get_connection() as conn:
        conn.execute("""
            INSERT INTO settings (key, value, updated_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = CURRENT_TIMESTAMP
        """, (key, str(data["value"]), str(data["value"])))

    return jsonify({"status": "updated", "key": key})


@settings_bp.route('/api/settings/<key>', methods=['DELETE'])
def delete_setting(key):
    """Delete a setting."""
    with get_connection() as conn:
        conn.execute("DELETE FROM settings WHERE key = ?", (key,))
    return jsonify({"status": "deleted"})


@settings_bp.route('/api/settings/test-discord', methods=['POST'])
def test_discord():
    """Test Discord webhook."""
    from services.notifications import send_discord

    data = request.get_json() or {}
    webhook_url = data.get("webhook_url")

    # If not provided in request body, read from DB
    if not webhook_url:
        with get_connection() as conn:
            row = conn.execute(
                "SELECT value FROM settings WHERE key = ?",
                ("discord_webhook_url",)
            ).fetchone()
            if row:
                webhook_url = row["value"]

    if not webhook_url:
        return jsonify({"error": "Discord webhook URL not configured"}), 400

    success, error = send_discord("Test notification from InvestingView", webhook_url)

    if success:
        return jsonify({"status": "sent"})
    else:
        return jsonify({"error": error}), 400


@settings_bp.route('/api/settings/test-email', methods=['POST'])
def test_email():
    """Test email configuration."""
    from services.notifications import send_email

    data = request.get_json() or {}

    success, error = send_email(
        subject="InvestingView Test",
        body="Test email from InvestingView",
        sender=data.get("sender"),
        app_password=data.get("app_password"),
        recipient=data.get("recipient")
    )

    if success:
        return jsonify({"status": "sent"})
    else:
        return jsonify({"error": error}), 400
