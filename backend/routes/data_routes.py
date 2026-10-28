"""
data_routes.py — Central data service endpoints.
Provides quotes, OHLCV history, and sector performance.
"""

import logging

from flask import Blueprint, jsonify, request

logger = logging.getLogger(__name__)

data_bp = Blueprint('data', __name__)


@data_bp.route('/api/data/history/stored', methods=['GET'])
def get_stored_history():
    """Read daily candles already in SQLite; never contact the market provider."""
    ticker = request.args.get('ticker', '').strip().upper()
    if not ticker:
        return jsonify({'error': 'ticker query parameter is required'}), 400

    try:
        from models.db import get_connection
        with get_connection() as conn:
            rows = conn.execute(
                "SELECT date, open, high, low, close, volume FROM candles "
                "WHERE ticker = ? AND date >= date('now', '-1 year') "
                "AND date GLOB '????-??-??' ORDER BY date",
                (ticker,),
            ).fetchall()
        history = [dict(row) for row in rows]
        return jsonify({'ticker': ticker, 'history': history, 'count': len(history)})
    except Exception as e:
        logger.error('data.history.stored.error: %s', e)
        return jsonify({'error': 'Failed to read stored history'}), 500


@data_bp.route('/api/data/quotes', methods=['GET'])
def get_quotes():
    """
    Get current quotes for tickers.
    Query param: tickers (comma-separated)
    """
    try:
        tickers_param = request.args.get("tickers", "")
        if not tickers_param:
            return jsonify({"error": "tickers query parameter is required"}), 400

        tickers = [t.strip().upper() for t in tickers_param.split(",") if t.strip()]
        if not tickers:
            return jsonify({"error": "tickers query parameter is required"}), 400

        from data.fetcher import get_quotes as fetch_quotes
        quotes = fetch_quotes(tickers)
        return jsonify({"quotes": quotes, "count": len(quotes)})
    except Exception as e:
        logger.error("data.quotes.error: %s", e)
        return jsonify({"error": "Failed to fetch quotes"}), 500


@data_bp.route('/api/data/history', methods=['GET'])
def get_history():
    """
    Get OHLCV history for a ticker.
    Query params: ticker, period (default: 1y), interval (default: 1d), refresh (default: false)
    """
    try:
        ticker = request.args.get("ticker", "").strip().upper()
        if not ticker:
            return jsonify({"error": "ticker query parameter is required"}), 400

        period = request.args.get("period", "1y").strip()
        interval = request.args.get("interval", "1d").strip()
        force_refresh = request.args.get("refresh", "false").lower() == "true"
        # Opt-in extended-hours candles — live-chart seed/re-sync only.
        # Defaults to false so grid/modal-daily callers are unchanged.
        prepost = request.args.get("prepost", "false").lower() == "true"

        from data.fetcher import get_ohlcv
        history = get_ohlcv(ticker, period=period, interval=interval, force_refresh=force_refresh, prepost=prepost)
        return jsonify({"ticker": ticker, "period": period, "interval": interval, "history": history, "count": len(history)})
    except ValueError as e:
        return jsonify({"error": str(e)}), 404
    except Exception as e:
        logger.error("data.history.error: %s", e)
        return jsonify({"error": "Failed to fetch history"}), 500


@data_bp.route('/api/data/sectors', methods=['GET'])
def get_sectors():
    """
    Get sector performance data.
    """
    try:
        from data.fetcher import get_sector_performance
        sectors = get_sector_performance()
        return jsonify({"sectors": sectors, "count": len(sectors)})
    except Exception as e:
        logger.error("data.sectors.error: %s", e)
        return jsonify({"error": "Failed to fetch sector data"}), 500
