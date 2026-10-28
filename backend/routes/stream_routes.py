"""
stream_routes.py — SSE live-price fan-out for the Live Chart tab + modal Live.

Additive-only. Existing REST routes are untouched.

  GET /api/stream/prices?tickers=AAPL&sid=... -> text/event-stream of ticks
  GET /api/stream/status?ticker=AAPL    -> {"status","is_open","tick"}
  POST /api/stream/unsubscribe {tickers:[...], reason, sid} -> advisory hint (logs only)

Demand is owned by OPEN SSE connections (see live_prices.client_open /
client_close). The unsubscribe hint exists so teardown paths (sendBeacon /
keepalive fetch) leave an attributable trace even though they change no state.

SSE framing: `data: {...}\n\n` per tick + `:ping` heartbeat every 15s.
Single-ticker focused; up to 5 tickers accepted, 1 expected.
"""

import json
import logging
import time

from flask import Blueprint, Response, jsonify, request, stream_with_context

log = logging.getLogger(__name__)

stream_bp = Blueprint('stream', __name__)

_HEARTBEAT_SECONDS = 15
_TICK_POLL_SECONDS = 1.0
_MAX_STREAM_SECONDS = 3600  # hard cap: client reopens hourly


def _parse_tickers() -> list[str]:
    raw = request.args.get("tickers", "") or request.args.get("ticker", "")
    tickers = [t.strip().upper() for t in raw.split(",") if t.strip()]
    # Keep it tight: Live tab streams exactly one ticker.
    return tickers[:5]


@stream_bp.route('/api/stream/status', methods=['GET'])
def stream_status():
    ticker = (request.args.get("ticker", "") or request.args.get("tickers", "")).strip().upper()
    if not ticker:
        return jsonify({"error": "ticker query parameter is required"}), 400
    try:
        from services.live_prices import get_market_status, get_latest

        m = get_market_status()
        return jsonify({
            "ticker": ticker,
            "status": m["status"],
            "is_open": m["is_open"],
            "tick": get_latest(ticker),
        })
    except Exception as e:
        log.warning("stream.status error: %s", e)
        return jsonify({"error": "status unavailable"}), 500


@stream_bp.route('/api/stream/unsubscribe', methods=['POST'])
def stream_unsubscribe():
    """Advisory teardown hint. Logs with reason+sid; changes no state."""
    try:
        data = request.get_json(silent=True) or {}
        tickers = data.get("tickers") or data.get("ticker") or []
        if isinstance(tickers, str):
            tickers = [tickers]
        reason = str(data.get("reason") or "beacon")
        sid = data.get("sid")
        from services.live_prices import note_unsubscribe_hint

        result = note_unsubscribe_hint([str(t) for t in tickers], reason, sid)
        return jsonify(result)
    except Exception as e:
        log.warning("stream.unsubscribe error: %s", e)
        return jsonify({"ok": False}), 200


@stream_bp.route('/api/stream/prices', methods=['GET'])
def stream_prices():
    tickers = _parse_tickers()
    if not tickers:
        return jsonify({"error": "tickers query parameter is required"}), 400
    sid = (request.args.get("sid") or "").strip()[:16] or None

    try:
        from services.live_prices import (
            get_market_status, get_latest, client_open, client_close,
        )
    except Exception as e:
        log.warning("stream.prices: live_prices unavailable: %s", e)
        return jsonify({"error": "live stream unavailable"}), 503

    market = get_market_status()
    if not market["is_open"]:
        # Freeze path: no socket when closed (product decision). Client shows
        # last REST candle + CLOSED badge. No demand is registered, so any
        # later teardown hint for this session is pure noise (logged, ignored).
        def _closed():
            payload = {
                "type": "status",
                "status": market["status"],
                "is_open": False,
                "ticks": {t: get_latest(t) for t in tickers},
            }
            yield f"data: {json.dumps(payload)}\n\n"
        return Response(_closed(), mimetype="text/event-stream",
                        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    last_sent_ts: dict[str, int] = {}
    start = time.time()
    last_beat = start
    conn_id = client_open(tickers, sid)

    def _gen():
        nonlocal last_beat
        try:
            # Seed immediately so chart paints without waiting for first tick.
            seed = {"type": "status", "status": market["status"],
                    "is_open": market["is_open"],
                    "ticks": {t: get_latest(t) for t in tickers}}
            yield f"data: {json.dumps(seed)}\n\n"
            while True:
                if time.time() - start > _MAX_STREAM_SECONDS:
                    yield f"data: {json.dumps({'type': 'bye', 'reason': 'max-age'})}\n\n"
                    break
                emitted = False
                for t in tickers:
                    tick = get_latest(t)
                    if tick and tick.get("ts", 0) != last_sent_ts.get(t, 0):
                        last_sent_ts[t] = tick.get("ts", 0)
                        yield f"data: {json.dumps({'type': 'tick', **tick})}\n\n"
                        emitted = True
                now = time.time()
                if now - last_beat >= _HEARTBEAT_SECONDS:
                    last_beat = now
                    yield ":ping\n\n"
                if not emitted:
                    time.sleep(_TICK_POLL_SECONDS)
        except GeneratorExit:
            pass
        finally:
            try:
                client_close(conn_id, "sse-close")
            except Exception:
                pass

    return Response(stream_with_context(_gen()), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
