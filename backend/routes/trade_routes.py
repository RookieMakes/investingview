"""
trade_routes.py — Trade Analysis API endpoints.
"""

import logging
import math
import re

from flask import Blueprint, jsonify, request
from models.db import get_connection

logger = logging.getLogger(__name__)

trade_bp = Blueprint('trade', __name__)


@trade_bp.route('/api/trade/analyze', methods=['POST'])
def analyze_trade():
    """Analyze a stock for swing or position trade setup."""
    try:
        body = request.get_json(silent=True)
        if not isinstance(body, dict):
            return jsonify({"error": "A JSON object is required"}), 400
        if not isinstance(body.get("ticker", ""), str) or not isinstance(body.get("trade_type", "swing"), str):
            return jsonify({"error": "ticker and trade_type must be strings"}), 400
        ticker = body.get("ticker", "").upper().strip()
        trade_type = body.get("trade_type", "swing").lower().strip()

        if not ticker:
            return jsonify({"error": "Ticker symbol is required"}), 400
        if not re.fullmatch(r"[A-Z0-9^][A-Z0-9.^=\-]{0,19}", ticker):
            return jsonify({"error": "Invalid ticker symbol"}), 400

        if trade_type not in ("swing", "position"):
            return jsonify({"error": "trade_type must be 'swing' or 'position'"}), 400

        from services.trade_analyzer import analyze
        result = analyze(ticker, trade_type)

        # Store result in trade_history
        try:
            # Parse numeric values from formatted strings
            score = result.get("score", 0)
            max_score = result.get("max_score", 0)
            verdict = result.get("verdict", "NO")
            sector = result.get("sector", "Unknown")
            company = result.get("company", ticker)

            # v2 exposes numeric/null prices. Retain legacy result compatibility.
            target_price = result.get("target_price")
            if "target_price" not in result:
                target_str = result.get("target")
                if target_str and target_str != "N/A":
                    target_price = float(target_str.replace("$", "").replace(",", ""))
            if target_price is not None and not math.isfinite(float(target_price)):
                target_price = None

            upside_pct = result.get("upside_pct")

            with get_connection() as conn:
                conn.execute(
                    """INSERT INTO trade_history
                       (ticker, company, trade_type, verdict, score, max_score,
                        target_price, upside_pct, sector)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (ticker, company, trade_type, verdict, score, max_score,
                     target_price, upside_pct, sector),
                )
        except Exception as db_err:
            logger.warning("Failed to store trade history: %s", db_err)

        return jsonify(result)

    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        logger.error("trade.analyze.error: %s", e)
        return jsonify({"error": f"Analysis failed: {str(e)}"}), 500


@trade_bp.route('/api/trade/history', methods=['GET'])
def get_trade_history():
    """Return all trade history entries, sorted by analyzed_at DESC."""
    try:
        with get_connection() as conn:
            rows = conn.execute(
                "SELECT * FROM trade_history ORDER BY analyzed_at DESC"
            ).fetchall()

        history = [dict(row) for row in rows]
        return jsonify({"history": history, "count": len(history)})

    except Exception as e:
        logger.error("trade.history.error: %s", e)
        return jsonify({"error": "Failed to fetch trade history"}), 500


@trade_bp.route('/api/trade/history', methods=['DELETE'])
def clear_trade_history():
    """Clear all trade history entries."""
    try:
        with get_connection() as conn:
            conn.execute("DELETE FROM trade_history")

        return jsonify({"ok": True})

    except Exception as e:
        logger.error("trade.history.clear.error: %s", e)
        return jsonify({"error": "Failed to clear trade history"}), 500
