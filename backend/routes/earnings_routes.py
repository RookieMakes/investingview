"""
earnings_routes.py — Dashboard API endpoints.

Includes the dashboard endpoints that power the Earnings Momentum screen
and the earnings dates lookup (migrated from legacy earnings table to
dash_earnings).
"""

import logging
from datetime import datetime, timezone, date as date_type

from flask import Blueprint, jsonify, request
from models.db import get_connection

logger = logging.getLogger(__name__)

earnings_bp = Blueprint('earnings', __name__)


@earnings_bp.route('/api/earnings/watchlist', methods=['GET'])
def get_earnings_watchlist():
    """Feature-local v2 scores calculated from stored, completed daily sessions."""
    try:
        from services.earnings_watchlist import get_watchlist
        return jsonify(get_watchlist())
    except Exception:
        logger.exception("earnings.watchlist.error")
        return jsonify({"error": "Unable to load the earnings watchlist"}), 500


# ══════════════════════════════════════════════════════════════════════════════
# DASHBOARD ENDPOINTS — Earnings Momentum screen
# ══════════════════════════════════════════════════════════════════════════════

@earnings_bp.route('/api/dashboard', methods=['GET'])
def get_dashboard():
    """Return the full dashboard dataset: stocks with prices, earnings, momentum.

    Response shape:
    {
      "stocks": [
        {
          "symbol": "NVDA", "name": "Nvidia Corp", "sector": "Semis",
          "earnings_date": "2026-07-07", "days_to_earnings": 9,
          "rank_score": 8, "streak": 5, "last_updated": "...", "sp500_rs": 5.2,
          "prices": [{"date": "2026-06-10", "close": 115.3, "pct_change": 1.2, "volume": 50000000}]
        }
      ],
      "last_updated": "2026-06-24T15:45:00"
    }
    """
    try:
        from services.dashboard import get_dashboard_data, get_last_fetch
        data = get_dashboard_data()
        return jsonify({"stocks": data, "last_updated": get_last_fetch()})
    except Exception as e:
        logger.error("dashboard.error: %s", e)
        return jsonify({"error": "Failed to fetch dashboard data"}), 500


@earnings_bp.route('/api/candles/<symbol>', methods=['GET'])
def get_candles(symbol: str):
    """Return OHLCV candle data for a specific ticker.

    Response shape:
    {
      "symbol": "NVDA",
      "candles": [{"date": "2026-06-10", "open": 114.5, "high": 116.2, "low": 113.8, "close": 115.3, "volume": 50000000}]
    }
    """
    try:
        from services.dashboard import get_ticker_candles
        symbol = symbol.upper()
        candles = get_ticker_candles(symbol)
        return jsonify({"symbol": symbol, "candles": candles})
    except Exception as e:
        logger.error("candles.error symbol=%s: %s", symbol, e)
        return jsonify({"error": f"Failed to fetch candles for {symbol}"}), 500


@earnings_bp.route('/api/refresh', methods=['POST'])
def refresh_dashboard():
    """Refresh dashboard data. Fetches real market data via yfinance.

    Response shape:
    {
      "status": "complete" | "skipped",
      "started_at": "...",
      "completed_at": "...",
      "last_fetch": "...",
      "source": "yfinance",
      "reason": "..." (only when skipped)
    }
    """
    try:
        started = datetime.now(timezone.utc).isoformat()

        # Fetch real market data via yfinance
        try:
            from services.yf_fetcher import fetch_all
            result = fetch_all()
            source = "yfinance"
            logger.info("Dashboard refreshed with real market data via yfinance.")
        except Exception as e:
            logger.error("yfinance refresh failed: %s", e)
            return jsonify({"error": "Failed to refresh: yfinance data fetch failed. " + str(e)}), 500

        from services.dashboard import get_last_fetch
        response = {
            "status": result.get("status", "complete"),
            "started_at": started,
            "completed_at": datetime.now(timezone.utc).isoformat(),
            "last_fetch": get_last_fetch(),
            "source": source,
        }
        if result.get("reason"):
            response["reason"] = result["reason"]
        return jsonify(response)
    except Exception as e:
        logger.error("refresh.error: %s", e)
        return jsonify({"error": "Failed to refresh dashboard"}), 500


@earnings_bp.route('/api/status', methods=['GET'])
def get_status():
    """Return dashboard status: last fetch time, market day, next fetch.

    Response shape:
    {
      "last_fetch": "2026-06-24T15:45:00",
      "is_market_day": true,
      "server_time_utc": "2026-06-24T19:45:00+00:00",
      "est_hour": 15,
      "next_fetch": "complete for today"
    }
    """
    try:
        from services.dashboard import get_status as get_dashboard_status
        return jsonify(get_dashboard_status())
    except Exception as e:
        logger.error("status.error: %s", e)
        return jsonify({"error": "Failed to fetch status"}), 500


@earnings_bp.route('/api/earnings/dates', methods=['GET'])
def get_earnings_dates_for_tickers():
    """Get earnings dates (next + past) for a list of tickers.

    Query params: tickers (comma-separated), stored=true to skip provider fallbacks.
    Returns: {
      "AAPL": {
        "next": {"display": "Jul 25", "date": "2026-07-25"},
        "past": [
          {"date": "2026-04-25", "display": "Apr 25", "beat": true, "surprise_pct": 5.2},
          ...
        ]
      }, ...
    }
    Only includes tickers that have a future next date or past announcements.

    Reads from dash_earnings (populated by the scheduled earnings refresh)
    for next dates, and earnings_announcements for past dates. Other callers
    retain the yfinance fallback; grid callers use stored=true to skip it.
    """
    try:
        tickers_str = request.args.get('tickers', '')
        tickers = [t.strip().upper() for t in tickers_str.split(',') if t.strip()]
        if not tickers:
            return jsonify({})

        # --- Query next earnings dates from dash_earnings ---
        # Held-over past dates (old_dt < today, not yet archived with beat/miss)
        # are returned as next with pending=True so the chart keeps showing
        # plain E until the weekly run swaps it to E▲/E▼.
        raw_dates = {}
        with get_connection() as conn:
            for ticker in tickers:
                row = conn.execute(
                    "SELECT earnings_date FROM dash_earnings WHERE symbol = ? AND earnings_date IS NOT NULL",
                    (ticker,),
                ).fetchone()
                if row and row['earnings_date']:
                    earnings_date = row['earnings_date']
                    try:
                        dt = datetime.strptime(earnings_date, '%Y-%m-%d').date()
                        raw_dates[ticker] = dt
                    except (ValueError, TypeError):
                        pass

        # --- Query past announcements from earnings_announcements ---
        past_dates = {}
        with get_connection() as conn:
            for ticker in tickers:
                rows = conn.execute(
                    "SELECT announcement_date, eps_actual, eps_estimate, surprise_pct "
                    "FROM earnings_announcements "
                    "WHERE symbol = ? ORDER BY announcement_date DESC LIMIT 4",
                    (ticker,),
                ).fetchall()
                if rows:
                    past_list = []
                    for row in rows:
                        sp = row["surprise_pct"]
                        past_list.append(
                            {
                                "date": row["announcement_date"],
                                "display": datetime.strptime(row["announcement_date"], '%Y-%m-%d').date().strftime('%b %d'),
                                "beat": (sp or 0) > 0,
                                "surprise_pct": round(sp, 2) if sp is not None else None,
                            }
                        )
                    past_dates[ticker] = past_list

        # Build next dates: future/today as normal, held past dates as pending
        # (skipped when already archived in past to avoid duplicate markers).
        dates = {}
        for ticker, dt in raw_dates.items():
            if dt >= date_type.today():
                dates[ticker] = {"display": dt.strftime('%b %d'), "date": dt.strftime('%Y-%m-%d')}
            else:
                archived = {p["date"] for p in past_dates.get(ticker, [])}
                if dt.strftime('%Y-%m-%d') not in archived:
                    dates[ticker] = {
                        "display": dt.strftime('%b %d'),
                        "date": dt.strftime('%Y-%m-%d'),
                        "pending": True,
                    }

        # For tickers not found in DB, try yfinance (slow path, limited)
        missing = [t for t in tickers if t not in dates]
        if missing and request.args.get('stored', 'false').lower() != 'true':
            try:
                from data.fetcher import fetch_earnings_dates
                yf_results = fetch_earnings_dates(missing)
                for r in yf_results:
                    ticker = r.get('ticker', '')
                    date_obj = r.get('date_obj') or r.get('date')
                    if ticker and date_obj:
                        if hasattr(date_obj, 'strftime'):
                            dates[ticker] = {"display": date_obj.strftime('%b %d'), "date": date_obj.strftime('%Y-%m-%d')}
                        else:
                            try:
                                dt = datetime.strptime(str(date_obj), '%Y-%m-%d').date()
                                dates[ticker] = {"display": dt.strftime('%b %d'), "date": dt.strftime('%Y-%m-%d')}
                            except (ValueError, TypeError):
                                pass
            except Exception as inner_e:
                logger.warning("earnings.dates.yfinance.fallback.error: %s", inner_e)

            # Second fallback: direct yfinance call for any still-missing tickers
            still_missing = [t for t in missing if t not in dates]
            if still_missing:
                try:
                    import yfinance as yf
                    for ticker in still_missing:
                        try:
                            stock = yf.Ticker(ticker)
                            cal = stock.calendar
                            if cal is None:
                                continue

                            if isinstance(cal, dict):
                                raw = cal.get("Earnings Date") or cal.get("Earnings")
                                if raw is None:
                                    continue
                                if isinstance(raw, list):
                                    raw = raw[0] if raw else None
                                if raw is None:
                                    continue
                                if hasattr(raw, 'date'):
                                    dates[ticker] = {"display": raw.strftime('%b %d'), "date": raw.strftime('%Y-%m-%d')}
                                else:
                                    dt = datetime.strptime(str(raw), '%Y-%m-%d').date()
                                    dates[ticker] = {"display": dt.strftime('%b %d'), "date": dt.strftime('%Y-%m-%d')}
                                continue

                            if hasattr(cal, 'empty') and cal.empty:
                                continue

                            earnings_date = None
                            for col_name in ("Earnings Date", "Earnings", "Date"):
                                try:
                                    earnings_date = cal.iloc[0].get(col_name)
                                    if earnings_date is not None:
                                        break
                                except (KeyError, IndexError):
                                    continue

                            if earnings_date is not None:
                                if hasattr(earnings_date, 'date'):
                                    dates[ticker] = {"display": earnings_date.strftime('%b %d'), "date": earnings_date.strftime('%Y-%m-%d')}
                                else:
                                    dt = datetime.strptime(str(earnings_date), '%Y-%m-%d').date()
                                    dates[ticker] = {"display": dt.strftime('%b %d'), "date": dt.strftime('%Y-%m-%d')}
                        except Exception:
                            pass
                except ImportError:
                    logger.warning("earnings.dates.yfinance.not_available")
                except Exception as e2:
                    logger.warning("earnings.dates.yfinance.direct_fallback.error: %s", e2)

        # Build final response with next + past
        result = {}
        for ticker in tickers:
            entry = {}
            if ticker in dates:
                entry["next"] = dates[ticker]
            if ticker in past_dates:
                entry["past"] = past_dates[ticker]
            if entry:
                result[ticker] = entry

        return jsonify(result)
    except Exception as e:
        logger.error("earnings.dates.error: %s", e)
        return jsonify({}), 500


@earnings_bp.route('/api/earnings/history', methods=['GET'])
def get_quarterly_earnings_history():
    """Get quarterly earnings history (EPS beat/miss) for a list of tickers.

    Query param: tickers (comma-separated, e.g. ?tickers=AAPL,MSFT,NVDA)
    Returns: { "AAPL": [{"date": "2025-09-30", "eps_actual": 1.85, "eps_estimate": 1.77, "surprise_pct": 4.52, "beat": true}, ...] }
    Only includes earnings from the last 1 year.
    """
    try:
        tickers_str = request.args.get('tickers', '')
        tickers = [t.strip().upper() for t in tickers_str.split(',') if t.strip()]
        if not tickers:
            return jsonify({})

        from datetime import datetime, timedelta
        one_year_ago = (datetime.now() - timedelta(days=365)).strftime('%Y-%m-%d')

        result = {}
        with get_connection() as conn:
            for ticker in tickers:
                rows = conn.execute(
                    "SELECT earnings_date, eps_actual, eps_estimate, surprise_pct "
                    "FROM quarterly_earnings "
                    "WHERE symbol = ? AND earnings_date >= ? "
                    "ORDER BY earnings_date ASC",
                    (ticker, one_year_ago),
                ).fetchall()
                if rows:
                    result[ticker] = [
                        {
                            "date": row["earnings_date"],
                            "eps_actual": row["eps_actual"],
                            "eps_estimate": row["eps_estimate"],
                            "surprise_pct": row["surprise_pct"] if row["surprise_pct"] is not None else None,
                            "beat": (row["surprise_pct"] or 0) > 0,
                        }
                        for row in rows
                    ]

        return jsonify(result)
    except Exception as e:
        logger.error("earnings.history.error: %s", e)
        return jsonify({}), 500
