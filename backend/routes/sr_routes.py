"""
sr_routes.py — S/R Levels API endpoints.

CRUD operations for support/resistance level management.
Persists levels in the sr_levels table (see models/schema.py).
"""

from flask import Blueprint, jsonify, request
from models.db import get_connection

sr_bp = Blueprint('sr', __name__)


@sr_bp.route('/api/sr/levels', methods=['GET'])
def list_sr_levels():
    """List S/R levels, optionally filtered by ticker."""
    ticker = request.args.get("ticker")

    with get_connection() as conn:
        if ticker:
            levels = conn.execute(
                "SELECT * FROM sr_levels WHERE ticker = ? ORDER BY price",
                (ticker.upper(),)
            ).fetchall()
        else:
            levels = conn.execute(
                "SELECT * FROM sr_levels ORDER BY ticker, price"
            ).fetchall()

    return jsonify([dict(l) for l in levels])


@sr_bp.route('/api/sr/levels', methods=['POST'])
def add_sr_level():
    """Add an S/R level.

    Required fields: ticker, price, type ('support' | 'resistance').
    Optional: strength (defaults to 1).
    """
    data = request.get_json()
    if not data or not data.get("ticker") or not data.get("price") or not data.get("type"):
        return jsonify({"error": "ticker, price, and type are required"}), 400

    ticker = data["ticker"].upper().strip()
    sr_type = data["type"]

    if sr_type not in ("support", "resistance"):
        return jsonify({"error": "type must be 'support' or 'resistance'"}), 400

    try:
        price = float(data["price"])
    except (TypeError, ValueError):
        return jsonify({"error": "price must be a valid number"}), 400

    strength = data.get("strength", 1)
    try:
        strength = int(strength)
    except (TypeError, ValueError):
        return jsonify({"error": "strength must be an integer"}), 400

    with get_connection() as conn:
        cursor = conn.execute(
            "INSERT INTO sr_levels (ticker, price, type, strength) VALUES (?, ?, ?, ?)",
            (ticker, price, sr_type, strength)
        )
        level_id = cursor.lastrowid

    return jsonify({"id": level_id, "status": "created"}), 201


@sr_bp.route('/api/sr/levels/<int:level_id>', methods=['PUT'])
def update_sr_level(level_id):
    """Update an S/R level. Only provided fields are updated."""
    data = request.get_json()
    if not data:
        return jsonify({"error": "No data provided"}), 400

    # Validate type if provided
    if "type" in data and data["type"] not in ("support", "resistance"):
        return jsonify({"error": "type must be 'support' or 'resistance'"}), 400

    # Validate price if provided
    if "price" in data:
        try:
            data["price"] = float(data["price"])
        except (TypeError, ValueError):
            return jsonify({"error": "price must be a valid number"}), 400

    # Validate strength if provided
    if "strength" in data:
        try:
            data["strength"] = int(data["strength"])
        except (TypeError, ValueError):
            return jsonify({"error": "strength must be an integer"}), 400

    with get_connection() as conn:
        conn.execute(
            """UPDATE sr_levels SET
               price = COALESCE(?, price),
               type = COALESCE(?, type),
               strength = COALESCE(?, strength)
               WHERE id = ?""",
            (data.get("price"), data.get("type"), data.get("strength"), level_id)
        )
    return jsonify({"status": "updated"})


@sr_bp.route('/api/sr/levels/<int:level_id>', methods=['DELETE'])
def delete_sr_level(level_id):
    """Delete an S/R level by ID."""
    with get_connection() as conn:
        conn.execute("DELETE FROM sr_levels WHERE id = ?", (level_id,))
    return jsonify({"status": "deleted"})


@sr_bp.route('/api/sr/levels/bulk', methods=['POST'])
def add_sr_levels_bulk():
    """Add multiple S/R levels at once.

    Request body: { "levels": [ { "ticker": "AAPL", "price": 150, "type": "support" }, ... ] }
    Only valid entries are inserted; invalid ones are silently skipped.
    """
    data = request.get_json()
    if not data or not data.get("levels"):
        return jsonify({"error": "levels array is required"}), 400

    added = 0
    with get_connection() as conn:
        for level in data["levels"]:
            ticker = level.get("ticker", "").upper().strip()
            price = level.get("price")
            sr_type = level.get("type")

            if ticker and price is not None and sr_type in ("support", "resistance"):
                conn.execute(
                    "INSERT INTO sr_levels (ticker, price, type, strength) VALUES (?, ?, ?, ?)",
                    (ticker, float(price), sr_type, level.get("strength", 1))
                )
                added += 1

    return jsonify({"status": "created", "count": added}), 201


@sr_bp.route('/api/sr/levels/ticker/<ticker>', methods=['DELETE'])
def delete_sr_levels_by_ticker(ticker):
    """Delete all S/R levels for a given ticker."""
    with get_connection() as conn:
        conn.execute("DELETE FROM sr_levels WHERE ticker = ?", (ticker.upper(),))
    return jsonify({"status": "deleted"})
