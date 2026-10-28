"""Portfolio-scoped trailing-stop configuration; monitoring is scheduled."""

from flask import Blueprint, jsonify, request
from services import trailing_stops as stops

trailing_stop_bp = Blueprint("trailing_stops", __name__)
BASE = "/api/portfolio/<int:portfolio_id>/trailing-stops/<ticker>"


@trailing_stop_bp.errorhandler(stops.StopError)
def stop_error(error):
    return jsonify({"error": str(error)}), error.status


@trailing_stop_bp.route(BASE, methods=["GET"])
def get_stop(portfolio_id, ticker):
    ticker = ticker.strip().upper()
    stop = stops.get_stop(portfolio_id, ticker)
    result = {"stop": stop}
    # Normal chart opens only read saved state. Setup explicitly requests a
    # fresh reference, so an unavailable provider never hides an existing HIT.
    if request.args.get("reference") == "true":
        result["reference"] = stops.reference_close(ticker)
        result["eligible_from"] = stops.eligible_from(stops.now_et())
    return jsonify(result)


def _save(portfolio_id, ticker, rearm=False):
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise stops.StopError("A stop configuration is required")
    stop = stops.save_stop(portfolio_id, ticker.strip().upper(), data, rearm=rearm)
    return jsonify({"stop": stop}), 200 if rearm else 201


@trailing_stop_bp.route(BASE, methods=["POST"])
def create_stop(portfolio_id, ticker):
    return _save(portfolio_id, ticker)


@trailing_stop_bp.route(BASE + "/rearm", methods=["POST"])
def rearm_stop(portfolio_id, ticker):
    return _save(portfolio_id, ticker, rearm=True)


@trailing_stop_bp.route(BASE, methods=["DELETE"])
def remove_stop(portfolio_id, ticker):
    stops.remove_stop(portfolio_id, ticker.strip().upper(),
                      request.args.get("stop_id", type=int), request.args.get("cycle", type=int))
    return jsonify({"status": "removed"})
