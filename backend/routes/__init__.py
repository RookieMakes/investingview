"""
routes/__init__.py — Register all Flask Blueprints.

Import and expose each blueprint so the app factory can register them.
"""

from routes.portfolio_routes import portfolio_bp
from routes.settings_routes import settings_bp
from routes.alert_routes import alerts_bp
from routes.sr_routes import sr_bp
from routes.scanner_routes import scanner_bp
from routes.earnings_routes import earnings_bp
from routes.universe_routes import universe_bp
from routes.chart_routes import chart_bp
from routes.watchlist_routes import watchlist_bp
from routes.market_routes import market_bp
from routes.transaction_routes import transaction_bp

ALL_BLUEPRINTS = [
    portfolio_bp,
    settings_bp,
    alerts_bp,
    sr_bp,
    scanner_bp,
    earnings_bp,
    universe_bp,
    chart_bp,
    watchlist_bp,
    market_bp,
    transaction_bp,
]
