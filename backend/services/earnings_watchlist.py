"""Read-only Earnings screen projection over existing daily price tables.

This feature never downloads prices, updates stored ranks, or runs migrations.
The original dashboard/fetcher and all of their consumers retain their contracts.
"""

import sqlite3
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

from models import db
from services.earnings_model import (
    ET, MODEL_VERSION, WEIGHTS, calculate_score, completed_session, session_window, valid_close,
)


def _now():
    return datetime.now(ET)


def _next_refresh(now):
    # Inspect the actual job when available, without importing/starting a scheduler.
    module = sys.modules.get("services.scheduler")
    scheduler = getattr(module, "scheduler", None)
    job = scheduler.get_job("dashboard_data_refresh") if scheduler and scheduler.running else None
    next_run = getattr(job, "next_run_time", None)
    if next_run:
        return next_run.isoformat(), "scheduled"
    # Mirrors the EXISTING weekday 16:05 cron, including its holiday behavior.
    target = now.replace(hour=16, minute=5, second=0, microsecond=0)
    if target <= now:
        target += timedelta(days=1)
    while target.weekday() >= 5:
        target += timedelta(days=1)
    return target.isoformat(), "configured"


def _choose_history(primary, fallback, dates):
    """Choose one coherent price series; never splice different adjustment bases."""
    def quality(rows):
        valid = {r["date"] for r in rows if valid_close(r.get("close"))}
        return (all(d in valid for d in dates), dates[-1] in valid,
                sum(d in valid for d in dates), max(valid, default=""))
    return (primary, "candles") if quality(primary) >= quality(fallback) else (fallback, "dash_prices")


def _earnings(raw, today):
    try:
        day = date.fromisoformat(raw)
    except (TypeError, ValueError):
        return {"earnings_date": None, "days_to_earnings": None, "earnings_status": "unknown"}
    days = (day - today).days
    return {"earnings_date": raw, "days_to_earnings": days,
            "earnings_status": "pending" if days < 0 else "today" if days == 0 else "upcoming"}


def get_watchlist():
    now = _now().astimezone(ET)
    session = completed_session(now)
    dates = session_window(session)
    start = (session - timedelta(days=100)).isoformat()
    # Dedicated mode=ro connection makes accidental writes fail at SQLite level.
    conn = sqlite3.connect(Path(db.DATABASE_PATH).resolve().as_uri() + "?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA query_only = ON")
        conn.execute("BEGIN")
        universe = [dict(r) for r in conn.execute("""
            SELECT u.ticker AS symbol, COALESCE(NULLIF(u.company_name, ''), s.name, u.ticker) AS name,
                   COALESCE(u.sector, '') AS sector, e.earnings_date
            FROM universe u LEFT JOIN dash_stocks s ON s.symbol = u.ticker
            LEFT JOIN dash_earnings e ON e.symbol = u.ticker
            WHERE COALESCE(u.sector, '') != 'ETF' ORDER BY u.ticker
        """)]
        sources = []
        for table, key in (("candles", "ticker"), ("dash_prices", "symbol")):
            grouped = {}
            # Table/key names are internal constants, never request parameters.
            for row in conn.execute(f"""
                SELECT {key} AS symbol, date, close, volume FROM {table}
                WHERE length(date) = 10 AND date BETWEEN ? AND ?
                  AND ({key} = 'SPY' OR {key} IN (SELECT ticker FROM universe))
                ORDER BY {key}, date
            """, (start, session.isoformat())):
                grouped.setdefault(row["symbol"], []).append(dict(row))
            sources.append(grouped)
        fetch = conn.execute("SELECT fetched_at FROM dash_last_fetch WHERE id=1").fetchone()
        last_fetch = fetch["fetched_at"] if fetch else None
    finally:
        conn.close()

    candles, dashboard = sources
    benchmark, _ = _choose_history(candles.get("SPY", []), dashboard.get("SPY", []), dates[-11:])
    results = []
    for item in universe:
        symbol = item["symbol"]
        history, source = _choose_history(candles.get(symbol, []), dashboard.get(symbol, []), dates)
        metrics = calculate_score(history, benchmark, dates)
        valid = {r["date"]: r for r in history if valid_close(r.get("close"))}
        latest = valid[max(valid)] if valid else None
        heat = []
        for previous, day in zip(dates[-11:], dates[-10:]):
            row, prior = valid.get(day), valid.get(previous)
            heat.append({"date": day, "close": row["close"] if row else None,
                         "volume": row["volume"] if row else None,
                         "pct_change": round(100 * (row["close"] / prior["close"] - 1), 4)
                         if row and prior else None})
        results.append({**item, **_earnings(item["earnings_date"], now.date()), **metrics,
                        "data_as_of": latest["date"] if latest else None,
                        "latest_close": latest["close"] if latest else None,
                        "daily_change": heat[-1]["pct_change"], "prices": heat, "price_source": source})
    results.sort(key=lambda r: (r["score"] is None, -(r["score"] or 0),
                               -(r["rs_10d"] or 0), -(r["return_10d"] or 0), r["symbol"]))
    for rank, row in enumerate((r for r in results if r["score"] is not None), 1):
        row["rank"] = rank
    next_refresh, schedule_status = _next_refresh(now)
    spy_valid = [r["date"] for r in benchmark if valid_close(r.get("close"))]
    return {"stocks": results, "model_version": MODEL_VERSION, "weights": WEIGHTS,
            "session_date": session.isoformat(), "session_dates": dates[-10:],
            "benchmark": "SPY", "benchmark_as_of": max(spy_valid, default=None),
            "generated_at": now.isoformat(), "last_fetch": last_fetch,
            "next_refresh": next_refresh, "schedule_status": schedule_status,
            "scored_count": sum(r["score"] is not None for r in results),
            "universe_count": len(results)}
