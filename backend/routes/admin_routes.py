"""
admin_routes.py — Admin endpoints for database management.

Provides manual override endpoints for clearing mock data,
forcing re-fetches, and inspecting dashboard data health.
"""

import logging

from flask import Blueprint, jsonify

logger = logging.getLogger(__name__)

admin_bp = Blueprint("admin", __name__)


@admin_bp.route("/api/admin/reset", methods=["POST"])
def admin_reset():
    """Clear all dashboard data and trigger a fresh fetch.

    This is a manual override endpoint for situations where:
    - Mock/seeded data persists and auto-detection failed
    - The database needs to be wiped and repopulated
    - A forced refresh is needed outside the normal schedule

    Returns:
        200 with status summary on success
        500 if the reset or fetch fails
    """
    try:
        from services.dashboard import clear_mock_data, has_data, detect_mock_data
        from services.yf_fetcher import fetch_all

        # Step 1: Clear existing data
        logger.info("Admin reset: clearing all dashboard tables...")
        clear_mock_data()

        # Step 2: Fetch fresh data
        logger.info("Admin reset: triggering fresh data fetch...")
        result = fetch_all()

        status = {
            "cleared": True,
            "fetch_status": result.get("status", "unknown"),
            "success_count": result.get("success_count", 0),
            "fail_count": result.get("fail_count", 0),
        }

        # Step 3: Verify the new data
        if result.get("status") == "complete":
            if has_data() and detect_mock_data():
                status["warning"] = "Freshly fetched data still looks like mock data"
                logger.warning("Admin reset: fetched data appears to be mock data!")
            else:
                logger.info(
                    "Admin reset complete: %d tickers loaded.",
                    result.get("success_count", 0),
                )

        return jsonify(status), 200

    except Exception as e:
        logger.error("Admin reset failed: %s", e, exc_info=True)
        return jsonify({"error": str(e), "cleared": False}), 500


@admin_bp.route("/api/admin/health", methods=["GET"])
def admin_health():
    """Check dashboard data health — detects mock data patterns.

    Returns a diagnostic report without modifying any data.
    """
    try:
        from services.dashboard import has_data, detect_mock_data
        from models.db import get_connection

        report = {
            "has_data": has_data(),
            "is_mock": False,
            "details": {},
        }

        if not report["has_data"]:
            report["details"]["message"] = "No dashboard data found"
            return jsonify(report), 200

        report["is_mock"] = detect_mock_data()

        # Gather diagnostics
        with get_connection() as conn:
            stock_count = conn.execute(
                "SELECT COUNT(*) FROM dash_stocks"
            ).fetchone()[0]
            price_count = conn.execute(
                "SELECT COUNT(*) FROM dash_prices"
            ).fetchone()[0]
            momentum_count = conn.execute(
                "SELECT COUNT(*) FROM dash_momentum"
            ).fetchone()[0]
            distinct_dates = conn.execute(
                "SELECT COUNT(DISTINCT date) FROM dash_prices"
            ).fetchone()[0]
            distinct_ranks = conn.execute(
                "SELECT COUNT(DISTINCT rank_score) FROM dash_momentum"
            ).fetchone()[0]

            # Find the most common rank_score
            dominant_rank = conn.execute(
                """SELECT rank_score, COUNT(*) AS cnt
                   FROM dash_momentum
                   WHERE rank_score != 0
                   GROUP BY rank_score
                   ORDER BY cnt DESC
                   LIMIT 1"""
            ).fetchone()

            report["details"] = {
                "stock_count": stock_count,
                "price_rows": price_count,
                "momentum_rows": momentum_count,
                "distinct_dates": distinct_dates,
                "distinct_rank_scores": distinct_ranks,
                "dominant_rank_score": (
                    {"score": dominant_rank["rank_score"], "count": dominant_rank["cnt"]}
                    if dominant_rank
                    else None
                ),
            }

        return jsonify(report), 200

    except Exception as e:
        logger.error("Admin health check failed: %s", e, exc_info=True)
        return jsonify({"error": str(e)}), 500
