"""
market_routes.py — Market data API endpoints (indices, sectors, CAD rate).
"""

import time
import logging

from flask import Blueprint, jsonify, request
from data.fetcher import fetch_index_performance, fetch_sector_performance

market_bp = Blueprint('market', __name__)
log = logging.getLogger(__name__)

# CAD rate cache (1 hour TTL)
_cad_cache = {"usdcad": None, "cadusd": None, "change_pct": 0.0, "timestamp": 0}
CAD_RATE_CACHE_SECONDS = 3600


@market_bp.route('/api/indices', methods=['GET'])
def get_indices():
    """Get major index performance."""
    indices = fetch_index_performance()
    return jsonify(indices)


@market_bp.route('/api/sectors', methods=['GET'])
def get_sectors():
    """Get sector ETF performance."""
    sectors = fetch_sector_performance()
    return jsonify(sectors)


@market_bp.route('/api/sectors/heatmap', methods=['GET'])
def get_sector_heatmap():
    """Get sector heatmap data."""
    sectors = fetch_sector_performance()

    # Format for heatmap visualization
    heatmap = []
    for sector, data in sectors.items():
        heatmap.append({
            "sector": sector,
            "etf": data["etf"],
            "change_pct": data["change_pct"],
            "price": data["price"],
            "color": "up" if data["change_pct"] >= 0 else "down",
        })

    # Sort by change_pct descending
    heatmap.sort(key=lambda x: x["change_pct"], reverse=True)

    return jsonify(heatmap)


@market_bp.route('/api/cad-rate', methods=['GET'])
def get_cad_rate():
    """Return current USD/CAD and CAD/USD exchange rates (cached 1 hour).

    Returns both rates for conversion (USDCAD) and display (CADUSD).
    Returns 502 if rates cannot be fetched and no cached values exist.
    """
    global _cad_cache
    now = time.time()

    # Return cached rates if still valid
    if _cad_cache["usdcad"] and (now - _cad_cache["timestamp"]) < CAD_RATE_CACHE_SECONDS:
        return jsonify({
            "rate": _cad_cache["usdcad"],
            "cadusd": _cad_cache["cadusd"],
            "change_pct": _cad_cache["change_pct"],
            "cached": True
        })

    try:
        import yfinance as yf
        hist = yf.Ticker("USDCAD=X").history(period="2d")
        if hist.empty:
            raise ValueError("Empty response from yfinance for USDCAD=X")
        usdcad = round(float(hist["Close"].iloc[-1]), 4)
        cadusd = round(1.0 / usdcad, 4)
        if len(hist) >= 2:
            prev = float(hist["Close"].iloc[-2])
            change_pct = round(((usdcad - prev) / prev * 100), 2) if prev > 0 else 0.0
        else:
            change_pct = 0.0
    except Exception as e:
        log.error("Failed to fetch CAD rate from yfinance: %s", e)
        if _cad_cache["usdcad"]:
            return jsonify({
                "rate": _cad_cache["usdcad"],
                "cadusd": _cad_cache["cadusd"],
                "change_pct": _cad_cache["change_pct"],
                "cached": True,
                "stale": True
            })
        return jsonify({"error": "Unable to fetch CAD/USD exchange rate. Please try again later."}), 502

    _cad_cache = {"usdcad": usdcad, "cadusd": cadusd, "change_pct": change_pct, "timestamp": now}
    return jsonify({"rate": usdcad, "cadusd": cadusd, "change_pct": change_pct, "cached": False})
