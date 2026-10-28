"""
news_routes.py — Movers news digest endpoints (news-only, free only).

GET  /api/news/movers?date=YYYY-MM-DD|today&window=12h — saved digest
GET  /api/news/movers/dates — recent run dates (7-day history pills)
POST /api/news/movers/refresh — compute + save today's digest (5pm ET job
     or manual Refresh button). Query/body: {window, mover_pct}.
"""

import logging
import re
from datetime import date

from flask import Blueprint, jsonify, request

from services import news_movers as svc

log = logging.getLogger(__name__)

news_bp = Blueprint("news", __name__)


@news_bp.route("/api/news/ticker/<ticker>", methods=["GET"])
def get_ticker_news(ticker):
    """Recent news for a single symbol, regardless of its daily price change."""
    ticker = ticker.strip().upper()
    if not re.fullmatch(r"[A-Z0-9^][A-Z0-9.^=-]{0,19}", ticker):
        return jsonify({"error": "Invalid ticker symbol"}), 400
    try:
        return jsonify(svc.get_ticker_news(ticker))
    except Exception as exc:
        log.warning("news.ticker.error ticker=%s: %s", ticker, exc)
        return jsonify({"error": "Unable to load recent news. Please try again."}), 503


def _resolve_date(value):
    """Map 'today'/None to the latest saved run date, else validate."""
    if not value or value == "today":
        dates = svc.list_digest_dates(limit=1)
        return dates[0]["run_date"] if dates else None
    try:
        year, month, day = (int(x) for x in value.split("-"))
        assert 1 <= month <= 12 and 1 <= day <= 31 and 1900 <= year <= 2100
    except (ValueError, TypeError, AssertionError, AttributeError):
        return False
    return value


@news_bp.route("/api/news/movers", methods=["GET"])
def get_movers_digest():
    """Return the saved digest for a date (latest by default)."""
    try:
        run_date = _resolve_date(request.args.get("date"))
        if run_date is False:
            return jsonify({"error": "date must be YYYY-MM-DD or 'today'"}), 400
        if run_date is None:
            try:
                from services.universe import get_merged_universe
                universe_count = len(get_merged_universe())
            except Exception:
                universe_count = None
            return jsonify({
                "run_date": None, "movers": [], "items": {},
                "fetched_at": None, "universe_count": universe_count,
                "empty": True,
                "message": "No digest saved yet. POST /api/news/movers/refresh",
            })
        digest = svc.load_digest(run_date)
        digest["empty"] = not digest["movers"]
        return jsonify(digest)
    except Exception as exc:
        log.error("news.movers.get.error: %s", exc)
        return jsonify({"error": "Failed to load news digest"}), 500


@news_bp.route("/api/news/movers/dates", methods=["GET"])
def list_movers_dates():
    """Recent digest run dates with mover/story counts."""
    try:
        return jsonify(svc.list_digest_dates())
    except Exception as exc:
        log.error("news.movers.dates.error: %s", exc)
        return jsonify({"error": "Failed to list digest dates"}), 500


@news_bp.route("/api/news/movers/refresh", methods=["POST"])
def refresh_movers_digest():
    """Compute movers + fetch news + save today's digest."""
    try:
        body = request.get_json(silent=True) or {}
        window = body.get("window") or request.args.get("window") or svc.DEFAULT_WINDOW
        if window not in svc.ALLOWED_WINDOWS:
            return jsonify({
                "error": f"window must be one of {sorted(svc.ALLOWED_WINDOWS)}"
            }), 400
        try:
            mover_pct = float(
                body.get("mover_pct", request.args.get("mover_pct", svc.DEFAULT_MOVER_PCT))
            )
        except (TypeError, ValueError):
            return jsonify({"error": "mover_pct must be a number"}), 400

        movers = svc.get_movers(mover_pct=mover_pct)
        universe_count = len(movers)  # movers only; full count in payload below
        try:
            from services.universe import get_merged_universe
            universe_count = len(get_merged_universe())
        except Exception:
            pass
        items = svc.fetch_digest(movers, window=window)
        run_date = date.today().isoformat()
        svc.save_digest(run_date, movers, items, window=window)
        svc.purge_old_digest()
        total = sum(len(items.get(m["ticker"], [])) for m in movers)
        return jsonify({
            "status": "ok", "run_date": run_date, "window": window,
            "mover_pct": mover_pct, "universe_count": universe_count,
            "movers": len(movers), "stories": total,
        })
    except RuntimeError as exc:  # e.g. feedparser missing
        log.error("news.movers.refresh.unavailable: %s", exc)
        return jsonify({"error": str(exc)}), 503
    except Exception as exc:
        log.error("news.movers.refresh.error: %s", exc)
        return jsonify({"error": "Failed to refresh news digest"}), 500
