"""
scanner_routes.py — Scanner API endpoints.
"""

import logging
from datetime import datetime

import pytz

from flask import Blueprint, jsonify, request
from models.db import get_connection

logger = logging.getLogger(__name__)

scanner_bp = Blueprint('scanner', __name__)


@scanner_bp.route('/api/scanner/etf-holdings', methods=['GET'])
def etf_holdings_board():
    from services.etf_holdings import ETFS, get_holdings

    etf = request.args.get('etf', 'XDIV.TO').upper()
    if etf not in ETFS:
        return jsonify({"error": "Unsupported ETF"}), 400
    return jsonify(get_holdings(etf))


@scanner_bp.route('/api/scanner/etf-holdings/history', methods=['GET'])
def etf_holdings_history():
    from services.etf_holdings import ETFS, get_holdings_history

    etf = request.args.get('etf', 'XDIV.TO').upper()
    ticker = request.args.get('ticker', '').upper()
    if etf not in ETFS or not ticker or len(ticker) > 20:
        return jsonify({"error": "Invalid ETF or ticker"}), 400
    return jsonify(get_holdings_history(etf, ticker))


@scanner_bp.route('/api/scanner/momentum', methods=['GET'])
def momentum_scan():
    """Run momentum scan."""
    try:
        from services.scanner import run_momentum_scan
        from services.rankings import (
            update_rankings, update_trend_snapshots,
            set_last_scan_completed_at,
        )
        from services.signals import record_alerts

        force = request.args.get("force", "false").lower() == "true"
        result = run_momentum_scan(force=force)

        # Scan completion timestamp (EST)
        est = pytz.timezone("America/New_York")
        completed_at = datetime.now(est).isoformat()

        # Persist scan results into the rankings leaderboard
        # (qualified + grey below-threshold rows so the full board stays visible)
        update_trend_snapshots("momentum", result["session_date"])
        attempted = set(result.get("attempted_tickers", []))
        update_rankings(result["results"], "momentum", attempted_tickers=attempted,
                        below_threshold=result.get("below_threshold"),
                        session_date=result["session_date"])

        # Persist scan completion timestamp for the frontend "Last scan" display
        set_last_scan_completed_at("momentum", completed_at)

        # Record signals for tracking (D+1/D+5/D+10/D+20 follow-through)
        if result.get("results"):
            alerts = [
                {
                    "ticker": r["ticker"],
                    "conviction": r.get("conviction", ""),
                    "score": r.get("score"),
                    "price": r.get("price"),
                }
                for r in result["results"]
            ]
            record_alerts("momentum", alerts, session_date=result["session_date"])

        result["completed_at"] = completed_at

        return jsonify(result)
    except Exception as e:
        logger.error("scanner.momentum.error: %s", e)
        return jsonify({"error": "Failed to run momentum scan"}), 500


@scanner_bp.route('/api/scanner/reversal', methods=['GET'])
def reversal_scan():
    """Run reversal scan."""
    try:
        from services.reversal_scanner import run_reversal_scan
        from services.rankings import (
            update_rankings, update_trend_snapshots,
            set_last_scan_completed_at,
        )
        from services.signals import record_alerts

        force = request.args.get("force", "false").lower() == "true"
        result = run_reversal_scan(force=force)

        # Scan completion timestamp (EST)
        est = pytz.timezone("America/New_York")
        completed_at = datetime.now(est).isoformat()

        # Persist scan results into the rankings leaderboard
        # (qualified + grey below-threshold rows so the full board stays visible)
        update_trend_snapshots("reversal", result["session_date"])
        attempted = set(result.get("attempted_tickers", []))
        update_rankings(result["results"], "reversal", attempted_tickers=attempted,
                        below_threshold=result.get("below_threshold"),
                        session_date=result["session_date"])

        # Persist scan completion timestamp for the frontend "Last scan" display
        set_last_scan_completed_at("reversal", completed_at)

        # Record signals for tracking (D+1/D+5/D+10/D+20 follow-through)
        if result.get("results"):
            alerts = [
                {
                    "ticker": r["ticker"],
                    "conviction": r.get("conviction", ""),
                    "score": r.get("score"),
                    "price": r.get("price"),
                }
                for r in result["results"]
            ]
            record_alerts("reversal", alerts, session_date=result["session_date"])

        result["completed_at"] = completed_at

        return jsonify(result)
    except Exception as e:
        logger.error("scanner.reversal.error: %s", e)
        return jsonify({"error": "Failed to run reversal scan"}), 500


@scanner_bp.route('/api/scanner/ranking', methods=['GET'])
def get_ranking():
    """Get ranking leaderboard.

    Query params:
        type: scan type (default "momentum")
        limit: max ranked qualifiers (default 50)
        include_below: "false" for legacy qualifiers-only view (default true)
        grey_limit: max grey below-threshold rows (default 25)
    """
    try:
        from services.rankings import get_rankings, get_last_scan_completed_at

        scan_type = request.args.get("type", "momentum")
        limit = request.args.get("limit", 50, type=int)
        include_below = request.args.get("include_below", "true").lower() != "false"
        grey_limit = request.args.get("grey_limit", 25, type=int)

        rankings = get_rankings(scan_type, limit,
                                include_below=include_below, grey_limit=grey_limit)
        completed_at = get_last_scan_completed_at(scan_type)
        return jsonify({
            "rankings": rankings,
            "scan_type": scan_type,
            "completed_at": completed_at,
        })
    except Exception as e:
        logger.error("scanner.ranking.error: %s", e)
        return jsonify({"error": "Failed to fetch rankings"}), 500


@scanner_bp.route('/api/scanner/signals', methods=['GET'])
def get_signals():
    """
    Get signal history.
    Query params: scan_type (momentum/reversal), limit (default: 50)
    """
    try:
        scan_type = request.args.get("scan_type")
        limit = request.args.get("limit", 50, type=int)

        with get_connection() as conn:
            if scan_type:
                signals = conn.execute(
                    """SELECT s.*, GROUP_CONCAT(
                           sr.day_offset || ':' || sr.pct_return
                       ) as returns
                       FROM signals s
                       LEFT JOIN signal_returns sr ON sr.signal_id = s.id
                       WHERE s.scan_type = ?
                       GROUP BY s.id
                       ORDER BY s.signal_date DESC, s.ticker
                       LIMIT ?""",
                    (scan_type, limit),
                ).fetchall()
            else:
                signals = conn.execute(
                    """SELECT s.*, GROUP_CONCAT(
                           sr.day_offset || ':' || sr.pct_return
                       ) as returns
                       FROM signals s
                       LEFT JOIN signal_returns sr ON sr.signal_id = s.id
                       GROUP BY s.id
                       ORDER BY s.signal_date DESC, s.ticker
                       LIMIT ?""",
                    (limit,),
                ).fetchall()

        # Parse returns string into structured data
        result = []
        for sig in signals:
            entry = dict(sig)
            returns_str = entry.pop("returns", None)
            if returns_str:
                returns = {}
                for pair in returns_str.split(","):
                    parts = pair.split(":")
                    if len(parts) == 2:
                        offset, pct = parts
                        returns[f"day_{offset}"] = float(pct) if pct else None
                entry["returns"] = returns
            else:
                entry["returns"] = {}
            result.append(entry)

        return jsonify({"signals": result, "count": len(result)})
    except Exception as e:
        logger.error("scanner.signals.error: %s", e)
        return jsonify({"error": "Failed to fetch signals"}), 500


@scanner_bp.route('/api/scanner/signals/backfill', methods=['POST'])
def signals_backfill():
    """
    Trigger return backfill for historical signals.
    Fetches D+1/D+5/D+10/D+20 returns for signals that are old enough.
    """
    try:
        from services.signals import backfill_returns
        backfill_returns()
        return jsonify({"status": "ok", "message": "Backfill complete"})
    except Exception as e:
        logger.error("scanner.signals.backfill.error: %s", e)
        return jsonify({"error": "Failed to backfill returns"}), 500


@scanner_bp.route('/api/scanner/sma200', methods=['GET'])
def sma200_scan():
    """Run 200 SMA proximity scan."""
    try:
        from services.sma200_scanner import run_sma200_scan

        force = request.args.get("force", "false").lower() == "true"
        result = run_sma200_scan(force=force)

        return jsonify(result)
    except Exception as e:
        logger.error("scanner.sma200.error: %s", e)
        return jsonify({"error": "Failed to run 200 SMA scan"}), 500


@scanner_bp.route('/api/scanner/sma200/ranking', methods=['GET'])
def get_sma200_ranking():
    """Get stored 200 SMA proximity rankings."""
    try:
        from services.sma200_scanner import get_sma200_rankings

        rankings = get_sma200_rankings()
        return jsonify({
            "rankings": rankings,
            "count": len(rankings),
        })
    except Exception as e:
        logger.error("scanner.sma200.ranking.error: %s", e)
        return jsonify({"error": "Failed to fetch 200 SMA rankings"}), 500


@scanner_bp.route('/api/scanner/earnings', methods=['GET'])
def earnings_scan():
    """Get earnings for today or upcoming (10 business days from tomorrow).

    Query params:
        window: "today" (default) — earnings happening today
                "week"  — upcoming earnings within 10 business days
    """
    try:
        from datetime import date, timedelta

        window = request.args.get("window", "today")

        def _next_business_day(n):
            """Return the date that is N business days from tomorrow."""
            current = date.today() + timedelta(days=1)
            count = 0
            while count < n:
                if current.weekday() < 5:  # Mon-Fri
                    count += 1
                if count < n:
                    current += timedelta(days=1)
            return current

        with get_connection() as conn:
            if window == "today":
                rows = conn.execute("""
                    SELECT e.symbol, e.earnings_date, e.days_to_earnings,
                           s.name, s.sector
                    FROM dash_earnings e
                    JOIN dash_stocks s ON e.symbol = s.symbol
                    WHERE e.earnings_date = date('now')
                    ORDER BY e.symbol
                """).fetchall()
            else:
                cutoff_date = _next_business_day(10)
                rows = conn.execute("""
                    SELECT e.symbol, e.earnings_date, e.days_to_earnings,
                           s.name, s.sector
                    FROM dash_earnings e
                    JOIN dash_stocks s ON e.symbol = s.symbol
                    WHERE e.earnings_date > date('now')
                      AND e.earnings_date <= ?
                    ORDER BY e.earnings_date ASC, e.symbol
                """, (cutoff_date.isoformat(),)).fetchall()

        return jsonify({
            "earnings": [dict(r) for r in rows],
            "count": len(rows),
            "window": window,
        })
    except Exception as e:
        logger.error("scanner.earnings.error: %s", e)
        return jsonify({"error": "Failed to fetch earnings data"}), 500


@scanner_bp.route('/api/scanner/earnings/all', methods=['GET'])
def earnings_all():
    """Get all earnings (today + upcoming) in one call for charts screen.

    Returns both today's earnings and upcoming earnings within the next
    10 business days. Designed for the charts screen to fetch all earnings
    data in a single request.
    """
    try:
        from datetime import date, timedelta

        def _next_business_day(n):
            """Return the date that is N business days from tomorrow."""
            current = date.today() + timedelta(days=1)
            count = 0
            while count < n:
                if current.weekday() < 5:  # Mon-Fri
                    count += 1
                if count < n:
                    current += timedelta(days=1)
            return current

        est = pytz.timezone("America/New_York")
        cutoff_date = _next_business_day(10)

        with get_connection() as conn:
            # Today's earnings
            today = conn.execute("""
                SELECT e.symbol, e.earnings_date, e.days_to_earnings,
                       s.name, s.sector
                FROM dash_earnings e
                JOIN dash_stocks s ON e.symbol = s.symbol
                WHERE e.earnings_date = date('now')
                ORDER BY e.symbol
            """).fetchall()

            # Upcoming earnings (10 business days from tomorrow)
            upcoming = conn.execute("""
                SELECT e.symbol, e.earnings_date, e.days_to_earnings,
                       s.name, s.sector
                FROM dash_earnings e
                JOIN dash_stocks s ON e.symbol = s.symbol
                WHERE e.earnings_date > date('now')
                  AND e.earnings_date <= ?
                ORDER BY e.earnings_date ASC, e.symbol
            """, (cutoff_date.isoformat(),)).fetchall()

        return jsonify({
            "today": [dict(r) for r in today],
            "upcoming": [dict(r) for r in upcoming],
            "scanned_at": datetime.now(est).isoformat(),
        })
    except Exception as e:
        logger.error("scanner.earnings.all.error: %s", e)
        return jsonify({"error": "Failed to fetch earnings data"}), 500


@scanner_bp.route('/api/scanner/ytd', methods=['GET'])
def ytd_scan():
    """Run YTD return scan."""
    try:
        from services.ytd_scanner import run_ytd_scan

        force = request.args.get("force", "false").lower() == "true"
        result = run_ytd_scan(force=force)

        result["completed_at"] = result.get("scanned_at")

        return jsonify(result)
    except Exception as e:
        logger.error("scanner.ytd.error: %s", e)
        return jsonify({"error": "Failed to run YTD scan"}), 500


@scanner_bp.route('/api/scanner/ytd/ranking', methods=['GET'])
def get_ytd_ranking():
    """Get stored YTD return rankings."""
    try:
        from services.ytd_scanner import get_ytd_rankings
        from services.rankings import get_last_scan_completed_at

        rankings = get_ytd_rankings()
        completed_at = get_last_scan_completed_at("ytd")
        return jsonify({
            "rankings": rankings,
            "count": len(rankings),
            "completed_at": completed_at,
        })
    except Exception as e:
        logger.error("scanner.ytd.ranking.error: %s", e)
        return jsonify({"error": "Failed to fetch YTD rankings"}), 500


@scanner_bp.route('/api/scanner/ytd-history/<ticker>', methods=['GET'])
def get_ytd_history(ticker):
    """Get YTD return snapshot history for a ticker."""
    try:
        with get_connection() as conn:
            rows = conn.execute(
                """SELECT date, ytd_pct, price, rank
                   FROM ytd_scan_snapshots
                   WHERE ticker = ?
                   ORDER BY date ASC""",
                (ticker,),
            ).fetchall()

        snapshots = [{"date": row["date"], "ytd_pct": row["ytd_pct"], "price": row["price"], "rank": row["rank"]} for row in rows]

        return jsonify({
            "ticker": ticker,
            "snapshots": snapshots,
        })
    except Exception as e:
        logger.error("scanner.ytd-history.error: %s", e)
        return jsonify({"error": "Failed to fetch YTD history"}), 500


@scanner_bp.route('/api/scanner/quality-score', methods=['GET'])
def quality_score_scan():
    """Run Quality Score scan."""
    try:
        from services.quality_score_scanner import run_quality_score_scan

        force = request.args.get("force", "false").lower() == "true"
        result = run_quality_score_scan(force=force)

        result["completed_at"] = result.get("scanned_at")

        return jsonify(result)
    except RuntimeError as e:
        logger.warning("scanner.quality-score.unavailable: %s", e)
        return jsonify({"error": str(e)}), 503
    except Exception as e:
        logger.error("scanner.quality-score.error: %s", e)
        return jsonify({"error": "Failed to run Quality Score scan"}), 500


@scanner_bp.route('/api/scanner/quality-score/ranking', methods=['GET'])
def get_quality_score_ranking():
    """Get stored Quality Score rankings."""
    try:
        from services.quality_score_scanner import get_quality_score_board

        return jsonify(get_quality_score_board())
    except Exception as e:
        logger.error("scanner.quality-score.ranking.error: %s", e)
        return jsonify({"error": "Failed to fetch Quality Score rankings"}), 500


@scanner_bp.route('/api/scanner/swing', methods=['GET'])
def get_swing_board():
    """Get Swing VAH/VAL touch board (DB-only, fresh after 4:30 PM ET)."""
    try:
        from services.swing_scanner import get_swing_board as _board

        return jsonify(_board())
    except Exception as e:
        logger.error("scanner.swing.error: %s", e)
        return jsonify({"error": "Failed to fetch Swing board"}), 500


@scanner_bp.route('/api/scanner/orb', methods=['GET'])
def get_orb_board():
    """Get ORB breakout board for the Trade tab (DB-only, fresh after 10:45 AM ET)."""
    try:
        from services.orb_scanner import get_orb_board as _board

        return jsonify(_board())
    except Exception as e:
        logger.error("scanner.orb.error: %s", e)
        return jsonify({"error": "Failed to fetch ORB board"}), 500


@scanner_bp.route('/api/scanner/volume-profile', methods=['GET'])
def get_volume_profile_row():
    """Get stored 3m + 6m volume-profile levels for a ticker (DB-only)."""
    try:
        from services.volume_profile import get_volume_profile

        ticker = (request.args.get("ticker") or "").strip().upper()
        if not ticker:
            return jsonify({"error": "ticker query parameter is required"}), 400
        ranges = get_volume_profile(ticker)
        if not ranges:
            return jsonify({"ticker": ticker, "found": False}), 404
        return jsonify({"ticker": ticker, "found": True, "ranges": ranges})
    except Exception as e:
        logger.error("scanner.volume-profile.error: %s", e)
        return jsonify({"error": "Failed to fetch volume profile"}), 500


@scanner_bp.route('/api/scanner/quality-score-history/<ticker>', methods=['GET'])
def get_quality_score_history(ticker):
    """Get Quality Score snapshot history for a ticker."""
    try:
        from services.quality_score_scanner import get_quality_score_history as get_history

        return jsonify(get_history(ticker.upper()))
    except Exception as e:
        logger.error("scanner.quality-score-history.error: %s", e)
        return jsonify({"error": "Failed to fetch Quality Score history"}), 500
