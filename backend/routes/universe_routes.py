"""
universe_routes.py — Universe API endpoints.
"""

import logging

from flask import Blueprint, jsonify, request
from models.db import get_connection

logger = logging.getLogger(__name__)

universe_bp = Blueprint('universe', __name__)


@universe_bp.route('/api/universe', methods=['GET'])
def list_universe():
    """List all stocks in the universe."""
    try:
        source = request.args.get("source")  # "default", "custom", or None for all

        with get_connection() as conn:
            if source:
                rows = conn.execute(
                    "SELECT * FROM universe WHERE source = ? ORDER BY ticker",
                    (source,)
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM universe ORDER BY source DESC, ticker"
                ).fetchall()

        return jsonify([dict(r) for r in rows])
    except Exception as e:
        logger.error("universe.list.error: %s", e)
        return jsonify({"error": "Failed to list universe"}), 500


@universe_bp.route('/api/universe', methods=['POST'])
def add_to_universe():
    """Add a stock to the universe."""
    try:
        from services.universe import add_custom_stock

        data = request.get_json()
        if not data or not data.get("ticker"):
            return jsonify({"error": "ticker is required"}), 400

        result = add_custom_stock(data["ticker"], data.get("company_name", ""))

        if result["status"] == "error":
            return jsonify({"error": result["message"]}), 400

        return jsonify(result), 201
    except Exception as e:
        logger.error("universe.add.error: %s", e)
        return jsonify({"error": "Failed to add to universe"}), 500


@universe_bp.route('/api/universe/<ticker>', methods=['DELETE'])
def remove_from_universe(ticker):
    """Remove a custom stock from the universe."""
    try:
        from services.universe import remove_custom_stock

        result = remove_custom_stock(ticker)

        if result["status"] == "error":
            return jsonify({"error": result["message"]}), 400

        return jsonify(result)
    except Exception as e:
        logger.error("universe.remove.error ticker=%s: %s", ticker, e)
        return jsonify({"error": "Failed to remove from universe"}), 500


@universe_bp.route('/api/universe/refresh', methods=['POST'])
def refresh_universe():
    """Refresh quotes for all stocks in universe."""
    try:
        from services.universe import get_merged_universe
        from data.fetcher import get_quotes

        universe = get_merged_universe()
        quotes = get_quotes(universe, use_cache=False)

        return jsonify({
            "status": "refreshed",
            "tickers_refreshed": len(quotes),
        })
    except Exception as e:
        logger.error("universe.refresh.error: %s", e)
        return jsonify({"error": "Failed to refresh universe"}), 500


@universe_bp.route('/api/universe/sectors', methods=['GET'])
def list_sectors():
    """Return the list of allowed sector values."""
    try:
        from services.universe import get_sector_list
        return jsonify(get_sector_list())
    except Exception as e:
        logger.error("universe.sectors.error: %s", e)
        return jsonify({"error": "Failed to load sectors"}), 500


@universe_bp.route('/api/universe/<ticker>', methods=['PUT'])
def update_universe_stock(ticker):
    """Update the sector of a custom universe stock."""
    try:
        from services.universe import update_custom_stock_sector

        data = request.get_json()
        if not data or "sector" not in data:
            return jsonify({"error": "sector is required"}), 400

        result = update_custom_stock_sector(ticker, data["sector"])

        if result["status"] == "error":
            return jsonify({"error": result["message"]}), 400

        return jsonify(result)
    except Exception as e:
        logger.error("universe.update.error ticker=%s: %s", ticker, e)
        return jsonify({"error": "Failed to update universe stock"}), 500
