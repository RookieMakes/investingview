"""
app.py — Main Flask application for InvestingView.

Entry point that wires up the Flask app, registers all route blueprints,
serves the static frontend, and handles startup initialization (DB + data fetch).
"""

import os
import sys
import logging
import json
import math
import atexit

from flask import Flask, send_from_directory
from flask_cors import CORS
from flask.json.provider import DefaultJSONProvider

logger = logging.getLogger(__name__)

# Add parent directory to path for imports
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from config import APP_PORT
from models.db import init_db
from services.universe import seed_default_universe




class NumpyJSONProvider(DefaultJSONProvider):
    """Custom JSON provider that handles numpy types for serialization.

    Extends Flask's DefaultJSONProvider to handle numpy integer, floating,
    and boolean types that Flask's standard encoder cannot serialize.
    Also sanitizes NaN/Infinity values which are not valid JSON.
    """

    @staticmethod
    def default(o):
        try:
            import numpy as np
            if isinstance(o, np.integer):
                return int(o)
            if isinstance(o, np.floating):
                return float(o)
            if isinstance(o, np.bool_):
                return bool(o)
            if isinstance(o, np.ndarray):
                return o.tolist()
        except ImportError:
            pass
        return DefaultJSONProvider.default(o)

    def encode(self, obj):
        result = super().encode(obj)
        # NaN and Infinity are not valid JSON — replace with null
        # Python's json.dumps outputs these as bare tokens for float('nan')
        return result.replace(': NaN', ': null').replace(': Infinity', ': null').replace(': -Infinity', ': null')


def create_app():
    """Create and configure the Flask application."""
    app = Flask(__name__, static_folder="../frontend", static_url_path="")
    CORS(app)

    # Install custom JSON provider to handle numpy types
    app.json_provider_class = NumpyJSONProvider
    app.json = NumpyJSONProvider(app)

    # Register blueprints
    from routes.settings_routes import settings_bp
    from routes.portfolio_routes import portfolio_bp
    from routes.alert_routes import alerts_bp
    from routes.sr_routes import sr_bp
    from routes.scanner_routes import scanner_bp
    from routes.earnings_routes import earnings_bp
    from routes.universe_routes import universe_bp
    from routes.chart_routes import chart_bp
    from routes.watchlist_routes import watchlist_bp
    from routes.market_routes import market_bp
    from routes.data_routes import data_bp
    from routes.stream_routes import stream_bp
    from routes.admin_routes import admin_bp
    # Trade screen hidden: routes/trade_routes.py + services/trade_analyzer.py
    # retained but not registered, so /api/trade/* stays disabled.
    from routes.transaction_routes import transaction_bp
    from routes.news_routes import news_bp
    from routes.trailing_stop_routes import trailing_stop_bp

    app.register_blueprint(settings_bp)
    app.register_blueprint(portfolio_bp)
    app.register_blueprint(alerts_bp)
    app.register_blueprint(sr_bp)
    app.register_blueprint(scanner_bp)
    app.register_blueprint(earnings_bp)
    app.register_blueprint(universe_bp)
    app.register_blueprint(chart_bp)
    app.register_blueprint(watchlist_bp)
    app.register_blueprint(market_bp)
    app.register_blueprint(data_bp)
    app.register_blueprint(stream_bp)
    app.register_blueprint(admin_bp)
    # Trade blueprint intentionally not registered (hidden screen).
    app.register_blueprint(transaction_bp)
    app.register_blueprint(news_bp)
    app.register_blueprint(trailing_stop_bp)

    # Serve frontend — index.html at root
    @app.route("/")
    def index():
        return send_from_directory(app.static_folder, "index.html")

    # Catch-all route for static frontend assets
    @app.route("/<path:path>")
    def serve_static(path):
        return send_from_directory(app.static_folder, path)

    # Health check endpoint
    @app.route("/api/health")
    def health():
        return {"status": "ok", "service": "investingview"}

    return app


def startup():
    """Initialize database, seed default universe, and fetch dashboard data.

    On startup:
    1. Creates DB tables if missing
    2. Seeds the default ticker universe
    3. Detects and clears any leftover mock/seeded data
    4. Fetches real market data via yfinance (skips on weekends)
    5. Verifies fetched data is not also mock (defensive check)
    """
    # App log level: INFO so operational lines (scheduler, live_prices
    # sse-open/tick-rate/unsub-hint) reach docker logs. No handler config
    # here on purpose — container runtime owns the stream.
    logging.basicConfig(level=logging.INFO)
    init_db()
    seed_default_universe()

    # Detect and clear any leftover mock/seeded data
    needs_fetch = False
    try:
        from services.dashboard import has_data, detect_mock_data, clear_mock_data
        if has_data():
            if detect_mock_data():
                logger.info("Leftover mock data detected — clearing dashboard tables.")
                clear_mock_data()
                needs_fetch = True
            else:
                logger.info("Existing dashboard data looks valid — skipping initial fetch.")
        else:
            needs_fetch = True
    except Exception as e:
        logger.warning("Mock data detection skipped: %s", e)
        needs_fetch = True

    # Fetch dashboard data via yfinance if needed
    if needs_fetch:
        try:
            from services.yf_fetcher import fetch_all
            result = fetch_all()
            if result.get("status") == "complete":
                logger.info(
                    "Dashboard seeded with market data via yfinance (%d succeeded, %d failed).",
                    result.get("success_count", 0),
                    result.get("fail_count", 0),
                )
                # Defensive: verify freshly fetched data is not also mock
                try:
                    from services.dashboard import detect_mock_data as _detect
                    if _detect():
                        logger.error(
                            "Freshly fetched data still looks like mock data! "
                            "yfinance may be returning cached/stub data."
                        )
                except Exception:
                    pass
            elif result.get("status") == "skipped":
                logger.info("Startup fetch skipped: %s", result.get("reason"))
        except Exception as e:
            logger.warning(
                "yfinance fetch failed (%s). Dashboard will be empty until data is available.",
                e,
            )

    # Refresh earnings dates on startup only if table is empty (first deploy).
    # Weekly Monday job handles ongoing updates — data persists in DB.
    try:
        from models.db import get_connection
        from services.yf_fetcher import refresh_earnings_dates
        with get_connection() as conn:
            count = conn.execute("SELECT COUNT(*) FROM dash_earnings").fetchone()[0]
        if count == 0:
            refresh_earnings_dates()
            logger.info("Startup earnings date refresh complete (first-time population).")
        else:
            logger.info("Skipping startup earnings date refresh (%d records exist).", count)
    except Exception as e:
        logger.warning("Startup earnings date refresh check failed: %s", e)

    # Start background scheduler for daily refreshes
    try:
        from services.scheduler import start_scheduler, stop_scheduler
        start_scheduler()
        atexit.register(stop_scheduler)
    except Exception as e:
        logger.warning("Scheduler failed to start: %s", e)


if __name__ == "__main__":
    app = create_app()
    # Must match the debug= parameter passed to app.run() below.
    # We cannot use app.debug here because it is derived from env vars
    # (FLASK_ENV / FLASK_DEBUG) *before* app.run() overrides it.
    use_debug = True
    # With debug=True Werkzeug forks a monitoring parent (no
    # WERKZEUG_RUN_MAIN) and a child (WERKZEUG_RUN_MAIN=true) that
    # serves the app.  Only start the scheduler in the child so we
    # never have two APScheduler instances firing cron jobs.
    if os.environ.get("WERKZEUG_RUN_MAIN") == "true" or not use_debug:
        startup()
    print(f"Starting InvestingView on port {APP_PORT}...")
    app.run(host="0.0.0.0", port=APP_PORT, debug=use_debug, threaded=True)
