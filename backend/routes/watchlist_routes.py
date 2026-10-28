"""
watchlist_routes.py — Watchlist API endpoints.
"""

from flask import Blueprint, jsonify, request
from models.db import get_connection
import uuid

watchlist_bp = Blueprint('watchlist', __name__)


@watchlist_bp.route('/api/watchlists', methods=['GET'])
def list_watchlists():
    """List all watchlists with ticker counts."""
    with get_connection() as conn:
        watchlists = conn.execute("SELECT * FROM watchlists ORDER BY name").fetchall()
        result = []
        for w in watchlists:
            count = conn.execute(
                "SELECT COUNT(*) FROM watchlist_tickers WHERE watchlist_id = ?", (w["id"],)
            ).fetchone()[0]
            result.append({**dict(w), "ticker_count": count})
    return jsonify(result)


@watchlist_bp.route('/api/watchlists', methods=['POST'])
def create_watchlist():
    """Create a new watchlist."""
    data = request.get_json()
    if not data or not data.get("name"):
        return jsonify({"error": "name is required"}), 400

    watchlist_id = str(uuid.uuid4())[:8]

    with get_connection() as conn:
        conn.execute(
            "INSERT INTO watchlists (id, name) VALUES (?, ?)",
            (watchlist_id, data["name"])
        )

    return jsonify({"id": watchlist_id, "name": data["name"], "status": "created"}), 201


@watchlist_bp.route('/api/watchlists/<watchlist_id>', methods=['PUT'])
def update_watchlist(watchlist_id):
    """Update a watchlist name."""
    data = request.get_json()
    if not data or not data.get("name"):
        return jsonify({"error": "name is required"}), 400

    with get_connection() as conn:
        conn.execute(
            "UPDATE watchlists SET name = ? WHERE id = ?",
            (data["name"], watchlist_id)
        )

    return jsonify({"status": "updated"})


@watchlist_bp.route('/api/watchlists/<watchlist_id>', methods=['DELETE'])
def delete_watchlist(watchlist_id):
    """Delete a watchlist and all its tickers."""
    with get_connection() as conn:
        conn.execute("DELETE FROM watchlist_tickers WHERE watchlist_id = ?", (watchlist_id,))
        conn.execute("DELETE FROM watchlists WHERE id = ?", (watchlist_id,))
    return jsonify({"status": "deleted"})


@watchlist_bp.route('/api/watchlists/<watchlist_id>/tickers', methods=['GET'])
def list_tickers(watchlist_id):
    """List all tickers in a watchlist."""
    with get_connection() as conn:
        tickers = conn.execute(
            "SELECT ticker, position FROM watchlist_tickers WHERE watchlist_id = ? ORDER BY position",
            (watchlist_id,)
        ).fetchall()
    return jsonify([dict(t) for t in tickers])


@watchlist_bp.route('/api/watchlists/<watchlist_id>/tickers', methods=['POST'])
def add_ticker(watchlist_id):
    """Add a ticker to a watchlist."""
    data = request.get_json()
    if not data or not data.get("ticker"):
        return jsonify({"error": "ticker is required"}), 400

    ticker = data["ticker"].upper().strip()

    with get_connection() as conn:
        # Check if already exists
        existing = conn.execute(
            "SELECT ticker FROM watchlist_tickers WHERE watchlist_id = ? AND ticker = ?",
            (watchlist_id, ticker)
        ).fetchone()

        if existing:
            return jsonify({"error": f"{ticker} already in watchlist"}), 409

        # Get next position
        max_pos = conn.execute(
            "SELECT MAX(position) FROM watchlist_tickers WHERE watchlist_id = ?",
            (watchlist_id,)
        ).fetchone()[0]
        next_pos = (max_pos or 0) + 1

        conn.execute(
            "INSERT INTO watchlist_tickers (watchlist_id, ticker, position) VALUES (?, ?, ?)",
            (watchlist_id, ticker, next_pos)
        )

    return jsonify({"ticker": ticker, "status": "created"}), 201


@watchlist_bp.route('/api/watchlists/<watchlist_id>/tickers/<ticker>', methods=['DELETE'])
def remove_ticker(watchlist_id, ticker):
    """Remove a ticker from a watchlist."""
    with get_connection() as conn:
        conn.execute(
            "DELETE FROM watchlist_tickers WHERE watchlist_id = ? AND ticker = ?",
            (watchlist_id, ticker.upper())
        )
    return jsonify({"status": "deleted"})
