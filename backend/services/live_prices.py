"""
live_prices.py — Single-ticker live price overlay via yfinance WebSocket.

Additive-only service for the standalone "Live Chart" tab + expand-modal
Live button. Does NOT replace any existing REST paths
(get_quotes / get_ohlcv / fetch_all / scanners).

Design:
  - One process-wide Yahoo WebSocket owned by a background thread.
  - Source of truth for demand is OPEN SSE CONNECTIONS (per-connection ids),
    not client hints. The POST /unsubscribe endpoint (beacons / keepalive
    fetches) is advisory-only and only logs — it can arrive twice for one
    close (hint + generator finally) and must never corrupt demand state.
  - Ticks are kept in memory (latest per ticker). DB writes are throttled
    (default 45s) and only touch the `quotes` table — never `candles`.
  - Market-hours gated (America/New_York 04:00-20:00, Mon-Fri). When closed,
    no Yahoo connection is opened and callers get status CLOSED.
  - All failures fall back to existing REST paths; this module never raises
    to request handlers.

Yahoo tick dict (proto, snake_case) includes:
  id, price, change, change_percent, day_high, day_low, day_volume,
  bid/ask, market_hours (0=pre,1=regular,2=post,3=closed), time (ms epoch).
"""

import logging
import threading
import time
import uuid
from datetime import datetime
from zoneinfo import ZoneInfo

log = logging.getLogger(__name__)

_ET = ZoneInfo("America/New_York")

# Throttle DB persistence of WS ticks -> quotes table (seconds per ticker).
_QUOTE_PERSIST_MIN_INTERVAL = 45.0
# How long after the last SSE client leaves before closing Yahoo WS.
_WS_IDLE_CLOSE_SECONDS = 60.0
# Debounce rapid subscribe/unsubscribe churn (e.g. ticker typing).
_SUBSCRIBE_DEBOUNCE_SECONDS = 1.0

_lock = threading.RLock()
_latest: dict[str, dict] = {}
_last_persist: dict[str, float] = {}
# Demand = tickers with >= 1 open SSE connection. Single source of truth.
_desired: set[str] = set()
_sse_clients: dict[str, set[str]] = {}   # ticker -> {conn_id}
_conn_tickers: dict[str, list[str]] = {}  # conn_id -> tickers
_last_sse_activity: float = 0.0

_worker_thread: threading.Thread | None = None
_worker_stop = threading.Event()
_last_subscribe_sent: float = 0.0
# Live Yahoo subscription state. The worker blocks inside ws.listen(), so a
# change to _desired (ticker switch, second viewer, close-to-empty) cannot
# take effect until the current connection is broken and re-subscribed.
# _subscribed = tickers Yahoo actually has; _ws_handle = live connection.
# _resub_pending = intentional break (skip error backoff for snappy switches).
_ws_handle = None
_subscribed: set[str] = set()
_resub_pending = False
# Set whenever demand changes so a parking/backing-off worker wakes
# immediately instead of sleeping out its full delay.
_wakeup = threading.Event()
# Tick-rate observability: ticker -> [window_start_epoch, count].
_tick_stats: dict[str, list] = {}
_TICK_STATS_WINDOW = 60.0


def _now_et() -> datetime:
    return datetime.now(_ET)


def get_market_status() -> dict:
    """Return market session status for badge display.

    Returns {"status": "LIVE"|"PRE"|"POST"|"CLOSED", "is_open": bool}.
    Streaming is allowed for PRE/LIVE/POST (04:00-20:00 ET weekdays);
    CLOSED means freeze + no socket (per product decision).
    """
    now = _now_et()
    if now.weekday() >= 5:
        return {"status": "CLOSED", "is_open": False}
    mins = now.hour * 60 + now.minute
    if mins < 4 * 60:
        return {"status": "CLOSED", "is_open": False}
    if mins < 9 * 60 + 30:
        return {"status": "PRE", "is_open": True}
    if mins < 16 * 60:
        return {"status": "LIVE", "is_open": True}
    if mins < 20 * 60:
        return {"status": "POST", "is_open": True}
    return {"status": "CLOSED", "is_open": False}


def _normalize_tick(msg: dict) -> dict | None:
    """Normalize a raw Yahoo WS message to our SSE payload shape."""
    try:
        ticker = str(msg.get("id", "")).upper().strip()
        if not ticker or "error" in msg:
            return None
        price = msg.get("price")
        if price is None:
            return None
        price = float(price)
        if price <= 0:
            return None

        def _f(key, default=0.0):
            try:
                v = msg.get(key, default)
                return float(v) if v is not None else default
            except (TypeError, ValueError):
                return default

        def _i(key, default=0):
            try:
                v = msg.get(key, default)
                return int(v) if v is not None else default
            except (TypeError, ValueError):
                return default

        ts_ms = msg.get("time", 0)
        try:
            ts = int(ts_ms) // 1000 if int(ts_ms) > 10_000_000_000 else int(time.time())
        except (TypeError, ValueError):
            ts = int(time.time())

        mh = msg.get("market_hours", 1)
        try:
            mh = int(mh)
        except (TypeError, ValueError):
            mh = 1

        tick = {
            "ticker": ticker,
            "price": round(price, 4),
            "change": round(_f("change"), 4),
            "change_pct": round(_f("change_percent"), 4),
            "dayHigh": round(_f("day_high"), 4) or None,
            "dayLow": round(_f("day_low"), 4) or None,
            "volume": _i("day_volume"),
            "bid": round(_f("bid"), 4) or None,
            "ask": round(_f("ask"), 4) or None,
            "marketHours": mh,
            "ts": ts,
        }
        return tick
    except Exception as e:
        log.debug("live_prices: bad tick ignored: %s", e)
        return None


def _on_tick(msg: dict) -> None:
    tick = _normalize_tick(msg)
    if not tick:
        return
    ticker = tick["ticker"]
    with _lock:
        if ticker not in _desired:
            return
        _latest[ticker] = tick
        global _last_sse_activity
        _last_sse_activity = time.time()
        # Tick-rate observability: one INFO line per ticker per minute max.
        now = _last_sse_activity
        stat = _tick_stats.get(ticker)
        if stat is None:
            _tick_stats[ticker] = [now, 1]
        else:
            stat[1] += 1
            if now - stat[0] >= _TICK_STATS_WINDOW:
                log.info("live_prices: %s ~%d ticks/min (session=%s)",
                         ticker, stat[1], get_market_status()["status"])
                _tick_stats[ticker] = [now, 0]
    _maybe_persist_tick(tick)


def _maybe_persist_tick(tick: dict) -> None:
    """Throttled write of WS tick into `quotes` table (additive only)."""
    now = time.time()
    ticker = tick["ticker"]
    with _lock:
        last = _last_persist.get(ticker, 0.0)
        if now - last < _QUOTE_PERSIST_MIN_INTERVAL:
            return
        _last_persist[ticker] = now
    try:
        from data.fetcher import _write_quotes

        _write_quotes([{
            "ticker": ticker,
            "price": tick["price"],
            "change_pct": tick["change_pct"],
            "volume": tick["volume"],
            "avg_volume_30d": None,
            "market_state": None,
        }])
    except Exception as e:
        log.debug("live_prices: throttled quotes write skipped for %s: %s", ticker, e)


def _worker_loop() -> None:
    """Background thread: own one Yahoo WS, reconnect with backoff.

    The loop re-subscribes whenever _desired diverges from _subscribed
    (ticker switch, new/closed viewer) by breaking the blocking listen()
    via _request_resub() and reconnecting. Requested resubs skip the error
    backoff so switches feel instant; error reconnects keep backoff.
    """
    global _last_subscribe_sent, _ws_handle, _subscribed, _resub_pending
    backoff = 2.0
    while not _worker_stop.is_set():
        with _lock:
            wanted = sorted(_desired)
            idle_for = time.time() - _last_sse_activity if _last_sse_activity else 0
            # Reclaim: no desired tickers or no SSE activity -> idle out.
            if not wanted or (idle_for > _WS_IDLE_CLOSE_SECONDS and _last_sse_activity):
                wanted = []
        if not wanted:
            # Park: break any live listen() so we stop holding a dead
            # Yahoo subscription, then idle-poll for new demand.
            _break_listen("idle-park")
            with _lock:
                _subscribed = set()
            _wakeup.wait(2.0)
            _wakeup.clear()
            backoff = 2.0
            continue

        status = get_market_status()
        if not status["is_open"]:
            log.info("live_prices: market %s — not connecting", status["status"])
            time.sleep(30.0)
            continue

        ws = None
        try:
            import yfinance as yf

            ws = yf.WebSocket(verbose=False)
            # Debounce churn: wait briefly so rapid ticker typing coalesces.
            time.sleep(_SUBSCRIBE_DEBOUNCE_SECONDS)
            with _lock:
                wanted = sorted(_desired)
                if not wanted:
                    try:
                        ws.close()
                    except Exception:
                        pass
                    _subscribed = set()
                    continue
                with_dupe = wanted
            ws.subscribe(with_dupe)
            with _lock:
                _ws_handle = ws
                _subscribed = set(with_dupe)
                _last_subscribe_sent = time.time()
            log.info("live_prices: subscribed %s", with_dupe)
            backoff = 2.0
            # Blocks until error/drop OR _maybe_resub() closes the handle
            # from another thread (recv raises -> listen() exits).
            ws.listen(_on_tick)
            with _lock:
                intentional = _resub_pending
                _resub_pending = False
            if intentional:
                log.info("live_prices: resub break — reconnecting immediately")
            else:
                log.warning("live_prices: listener exited, will reconnect")
        except Exception as e:
            log.warning("live_prices: WS error/reconnect in %.0fs: %s", backoff, e)
        finally:
            with _lock:
                if _ws_handle is ws:
                    _ws_handle = None
            try:
                if ws is not None:
                    ws.close()
            except Exception:
                pass
        # Backoff before reconnect — skipped for intentional resubs so
        # ticker switches feel instant (also gives churn time to settle
        # on genuine errors). _wakeup cuts any sleep short on new demand.
        if intentional:
            backoff = 2.0
        else:
            for _ in range(int(backoff)):
                if _worker_stop.is_set():
                    break
                if _wakeup.wait(1.0):
                    break
            _wakeup.clear()
            backoff = min(backoff * 2, 30.0)


def _break_listen(reason: str) -> None:
    """Close the live Yahoo handle (if any) to unblock listen()."""
    with _lock:
        ws = _ws_handle
    if ws is None:
        return
    try:
        ws.close()
        log.info("live_prices: broke listen() (%s)", reason)
    except Exception as e:
        log.debug("live_prices: break listen failed (%s): %s", reason, e)


def _maybe_resub(reason: str) -> None:
    """If demand diverged from the live subscription, break listen() so the
    worker loop reconnects with the fresh set. Fast path: no error backoff."""
    with _lock:
        wanted = set(_desired)
        live = set(_subscribed)
        worker_alive = _worker_thread is not None and _worker_thread.is_alive()
        has_handle = _ws_handle is not None
    if wanted == live:
        return
    if not wanted:
        _break_listen("idle-park")
        return
    if worker_alive and has_handle:
        # Reset backoff for a snappy switch: the loop reconnects immediately.
        with _lock:
            global _resub_pending
            _resub_pending = True
        log.info("live_prices: resub %s -> %s (reason=%s)",
                 sorted(live), sorted(wanted), reason)
        _break_listen("resub-" + reason)
    # Else: worker will pick up _desired on its next loop pass.


def _ensure_worker() -> None:
    global _worker_thread
    with _lock:
        if _worker_thread is not None and _worker_thread.is_alive():
            return
        _worker_stop.clear()
        _worker_thread = threading.Thread(
            target=_worker_loop, name="live-prices-ws", daemon=True
        )
        _worker_thread.start()
        log.info("live_prices: worker started")


def client_open(tickers: list[str], sid: str | None = None) -> str:
    """Register an open SSE connection. The ONLY thing that creates demand.

    Returns the connection id (echoes a client-provided sid when given).
    Never raises.
    """
    clean = [str(t).upper().strip() for t in tickers if str(t).strip()][:5]
    conn_id = (sid or uuid.uuid4().hex[:8])[:16]
    status = get_market_status()
    with _lock:
        global _last_sse_activity
        _last_sse_activity = time.time()
        _conn_tickers[conn_id] = clean
        for t in clean:
            _sse_clients.setdefault(t, set()).add(conn_id)
            _desired.add(t)
        wanted = sorted(_desired)
        open_conns = sum(len(v) for v in _sse_clients.values())
    if clean and status["is_open"]:
        try:
            _ensure_worker()
        except Exception as e:
            log.warning("live_prices: worker start failed: %s", e)
    log.info("live_prices: sse-open sid=%s tickers=%s conns=%d wanted=%s market=%s",
             conn_id, clean, open_conns, wanted, status["status"])
    # Demand may have diverged from the live Yahoo subscription (e.g. ticker
    # switch while the worker blocks in listen()) — resubscribe if needed.
    try:
        _wakeup.set()
        _maybe_resub("client-open")
    except Exception as e:
        log.debug("live_prices: resub check failed: %s", e)
    return conn_id


def client_close(conn_id: str, reason: str = "sse-close") -> dict:
    """Deregister an SSE connection. The ONLY thing that removes demand.

    Never raises. Unknown ids are a no-op (e.g. duplicate close).
    """
    with _lock:
        global _last_sse_activity
        _last_sse_activity = time.time()
        tickers = _conn_tickers.pop(conn_id, [])
        for t in tickers:
            holders = _sse_clients.get(t)
            if holders is not None:
                holders.discard(conn_id)
                if not holders:
                    _sse_clients.pop(t, None)
                    _desired.discard(t)
        wanted = sorted(_desired)
        open_conns = sum(len(v) for v in _sse_clients.values())
    log.info("live_prices: sse-close sid=%s reason=%s tickers=%s conns=%d wanted=%s",
             conn_id, reason, tickers, open_conns, wanted)
    try:
        _wakeup.set()
        _maybe_resub("client-close")
    except Exception as e:
        log.debug("live_prices: resub check failed: %s", e)
    return {"subscribed": wanted}


def note_unsubscribe_hint(tickers: list[str], reason: str = "beacon",
                          sid: str | None = None) -> dict:
    """Advisory-only client hint (sendBeacon / keepalive fetch on teardown).

    Logs only — demand is owned by open SSE connections, so duplicate hints
    (hint + generator finally for the same close) can never corrupt state.
    """
    clean = [str(t).upper().strip() for t in tickers if str(t).strip()][:5]
    with _lock:
        wanted = sorted(_desired)
        open_conns = sum(len(v) for v in _sse_clients.values())
    log.info("live_prices: unsub-hint sid=%s reason=%s tickers=%s conns=%d wanted=%s (advisory, no state change)",
             sid, reason, clean, open_conns, wanted)
    return {"ok": True, "subscribed": wanted}


def get_latest(ticker: str) -> dict | None:
    """Return latest in-memory tick for ticker, or None."""
    with _lock:
        tick = _latest.get(ticker.upper().strip())
        return dict(tick) if tick else None


def get_snapshot(tickers: list[str]) -> dict:
    """Return {ticker: tick|None} + market status (for SSE seed / status API)."""
    status = get_market_status()
    out = {}
    for t in tickers:
        out[t.upper().strip()] = get_latest(t)
    return {"status": status["status"], "is_open": status["is_open"], "ticks": out}
