"""
rankings.py — Ranking leaderboard persistence.

Rules:
  - New ticker: days_on_board = 1, first_seen = today
  - Active ticker: days_on_board = calendar days since first_seen
  - Exited ticker: exit_date set, kept for 7 days then purged
  - Rank by today's score; a sub-point tie-breaker cannot outrank a higher score.
  - qualified_streak counts successive successful scan sessions, not reruns.
  - days_on_board remains historical calendar age, not rank weight.
  - Tickers scoring below MIN_DISPLAY_SCORE stay in the DB and are returned
    as grey below-threshold rows pinned below the ranked qualifiers.
  - Trend: rank change vs previous day (updated at 4 PM EST)
"""

import math
from datetime import date
from models.db import get_connection

PURGE_AFTER_DAYS = 7
REENTRY_GRACE_DAYS = 7

# Minimum scan_score required for a ticker to be ranked.
# Tickers scoring below this threshold are NOT ranked — they are returned as
# grey below-threshold rows pinned at the bottom of the board so the full
# board stays visible instead of tickers winking on/off.
# This matches the LOW threshold defined in services/scoring.py (score < 3).
MIN_DISPLAY_SCORE = 3

# Scan types that use the qualified/grey split. Other types stored in the same
# table (ytd, quality_score) bypass the threshold and keep legacy behavior.
THRESHOLD_SCAN_TYPES = {"momentum", "reversal"}

# Max grey below-threshold rows returned per board by default.
GREY_LIMIT_DEFAULT = 25


def compute_rank_score(score: int | float, tie_breaker: float = 0) -> float:
    """Cap same-score signal-quality tie-breaks below one score point."""
    try:
        s = float(score)
    except (TypeError, ValueError):
        s = 0.0
    try:
        tie = min(0.49, max(0.0, float(tie_breaker)))
    except (TypeError, ValueError):
        tie = 0.0
    return s + tie


def _signal_tie_breaker(entry: dict, scan_type: str) -> float:
    """Current relative volume and price strength, capped at 0.49."""
    try:
        vol = float(entry.get("volume_ratio" if scan_type == "momentum" else "vol_ratio") or 0)
        move = float(entry.get("day_change_pct" if scan_type == "momentum" else "ret_5d") or 0)
    except (TypeError, ValueError):
        return 0.0
    return min(0.49, 0.1 * max(0, vol - 1) + 0.01 * max(0, move))


def _today_str():
    return date.today().isoformat()


def _to_native(val):
    """Convert numpy types to native Python types for SQLite safety."""
    # Lazy import to avoid circular dependency at module level
    try:
        import numpy as np
        if isinstance(val, (np.integer,)):
            return int(val)
        if isinstance(val, (np.floating,)):
            return float(val)
        if isinstance(val, (np.bool_,)):
            return bool(val)
    except ImportError:
        pass
    return val


def update_rankings(alerts: list[dict], scan_type: str, attempted_tickers: set[str] | None = None,
                    below_threshold: list[dict] | None = None, session_date: str | None = None):
    """
    Update rankings with new scan results.

    alerts: list of {ticker, company, sector, conviction, score} (score >= 3)
    scan_type: "momentum" or "reversal"
    attempted_tickers: set of tickers we tried to fetch. Only exit tickers
                       that were successfully evaluated (present in this set).
                       None preserves existing behavior (exits all missing).
    below_threshold: list of sub-threshold entries (score < 3) persisted as
                     grey rows. They share the same days/exit/purge lifecycle
                     but are never ranked — they pin to the bottom of the board.
    """
    today = session_date or _today_str()
    below_threshold = below_threshold or []
    active_tickers = {a["ticker"] for a in alerts} | {b["ticker"] for b in below_threshold}
    # A ticker qualifying in either list counts as seen with its best (qualified) entry.
    by_ticker: dict[str, dict] = {}
    for entry in list(below_threshold) + list(alerts):
        by_ticker[entry["ticker"]] = entry

    with get_connection() as conn:
        session_row = conn.execute(
            "SELECT last_session FROM scanner_sessions WHERE scan_type = ?", (scan_type,)
        ).fetchone()
        previous_session = session_row["last_session"] if session_row else None
        if previous_session and today < previous_session:
            raise ValueError("Cannot update %s rankings with older session %s" % (scan_type, today))
        # Get existing rankings
        existing = conn.execute(
            "SELECT ticker, first_seen, exit_date, scan_score, last_qualified_date, qualified_streak "
            "FROM rankings WHERE scan_type = ?",
            (scan_type,)
        ).fetchall()
        existing_map = {r["ticker"]: dict(r) for r in existing}

        # Process each alert (qualified entries win over grey for the same ticker)
        for alert in by_ticker.values():
            ticker = alert["ticker"]
            # Ensure all values are native Python types for SQLite safety
            score = int(_to_native(alert["score"]))
            conviction = str(alert.get("conviction", ""))
            company = str(alert.get("company", ""))
            sector = str(alert.get("sector", ""))
            tie = _signal_tie_breaker(alert, scan_type) if scan_type in THRESHOLD_SCAN_TYPES else 0.0
            qualified = score >= MIN_DISPLAY_SCORE if scan_type in THRESHOLD_SCAN_TYPES else True

            if ticker in existing_map:
                existing_entry = existing_map[ticker]

                if existing_entry.get("exit_date"):
                    # Re-entering after being exited
                    exit_date_str = existing_entry["exit_date"]
                    exit_date_obj = date.fromisoformat(exit_date_str)
                    days_since_exit = (date.fromisoformat(today) - exit_date_obj).days

                    if days_since_exit <= REENTRY_GRACE_DAYS:
                        # Re-entering within grace period — keep original first_seen for continuity
                        first_seen = existing_entry["first_seen"]
                        days = (date.fromisoformat(today) - date.fromisoformat(first_seen)).days + 1
                    else:
                        # Re-entering after long absence — reset the clock
                        first_seen = today
                        days = 1
                else:
                    # Continuously active — keep original first_seen
                    first_seen = existing_entry["first_seen"]
                    days = (date.fromisoformat(today) - date.fromisoformat(first_seen)).days + 1

                if qualified:
                    if existing_entry["last_qualified_date"] == today and not existing_entry["exit_date"]:
                        streak = max(1, existing_entry["qualified_streak"] or 0)
                    elif (previous_session == existing_entry["last_qualified_date"]
                          and not existing_entry["exit_date"] and existing_entry["scan_score"] >= MIN_DISPLAY_SCORE):
                        streak = (existing_entry["qualified_streak"] or 0) + 1
                    else:
                        streak = 1
                    last_qualified = today
                else:
                    streak = 0
                    last_qualified = existing_entry["last_qualified_date"]
                rank_score = (compute_rank_score(score, tie) if scan_type in THRESHOLD_SCAN_TYPES
                             else (score if scan_type == 'ytd' else score + math.log1p(days)))

                conn.execute("""
                    UPDATE rankings
                    SET scan_score = ?, conviction = ?, last_seen = ?,
                        days_on_board = ?, rank_score = ?, first_seen = ?,
                        qualified_streak = ?, last_qualified_date = ?, tie_breaker = ?,
                        exit_date = NULL
                    WHERE scan_type = ? AND ticker = ?
                """, (score, conviction, today, days, rank_score, first_seen,
                      streak, last_qualified, tie,
                      scan_type, ticker))
            else:
                # New ticker
                rank_score = (compute_rank_score(score, tie) if scan_type in THRESHOLD_SCAN_TYPES
                              else (score if scan_type == 'ytd' else score + math.log1p(1)))
                conn.execute("""
                    INSERT INTO rankings (scan_type, ticker, company, sector, conviction,
                                         scan_score, first_seen, last_seen, days_on_board, rank_score,
                                         qualified_streak, last_qualified_date, tie_breaker)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
                """, (scan_type, ticker, company, sector,
                      conviction, score, today, today, rank_score,
                      1 if qualified else 0, today if qualified else None, tie))

        # Mark exited tickers
        for ticker, data in existing_map.items():
            if ticker not in active_tickers and not data.get("exit_date"):
                # Only exit tickers that we successfully evaluated.
                # If attempted_tickers is None (old caller), preserve existing behavior.
                if attempted_tickers is None or ticker in attempted_tickers:
                    conn.execute("""
                        UPDATE rankings SET exit_date = ?, qualified_streak = 0
                        WHERE scan_type = ? AND ticker = ?
                    """, (today, scan_type, ticker))

        # Purge old exited tickers
        conn.execute("""
            DELETE FROM rankings
            WHERE scan_type = ? AND exit_date IS NOT NULL
            AND julianday(?) - julianday(exit_date) > ?
        """, (scan_type, today, PURGE_AFTER_DAYS))

        conn.execute("""INSERT INTO scanner_sessions(scan_type, last_session)
                        VALUES (?, ?) ON CONFLICT(scan_type) DO UPDATE SET last_session = excluded.last_session""",
                     (scan_type, today))

        # Calculate current_rank.
        # Threshold boards (momentum/reversal): only qualifiers (score >= 3)
        # are ranked 1..N; grey below-threshold rows get NULL (pinned bottom,
        # unranked). Other scan types keep legacy rank-everything behavior.
        if scan_type in THRESHOLD_SCAN_TYPES:
            ranked = conn.execute("""
                SELECT ticker FROM rankings
                WHERE scan_type = ? AND exit_date IS NULL AND scan_score >= ?
                ORDER BY scan_score DESC, tie_breaker DESC, ticker ASC
            """, (scan_type, MIN_DISPLAY_SCORE)).fetchall()

            for i, row in enumerate(ranked):
                conn.execute("""
                    UPDATE rankings SET current_rank = ?
                    WHERE scan_type = ? AND ticker = ?
                """, (i + 1, scan_type, row["ticker"]))

            conn.execute("""
                UPDATE rankings SET current_rank = NULL
                WHERE scan_type = ? AND exit_date IS NULL
                AND scan_score < ?
            """, (scan_type, MIN_DISPLAY_SCORE))
        else:
            if scan_type == 'ytd':
                active = conn.execute("""
                    SELECT ticker FROM rankings
                    WHERE scan_type = ? AND exit_date IS NULL
                    ORDER BY scan_score DESC, ticker ASC
                """, (scan_type,)).fetchall()
            else:
                active = conn.execute("""
                    SELECT ticker FROM rankings
                    WHERE scan_type = ? AND exit_date IS NULL
                    ORDER BY rank_score DESC
                """, (scan_type,)).fetchall()

            for i, row in enumerate(active):
                conn.execute("""
                    UPDATE rankings SET current_rank = ?
                    WHERE scan_type = ? AND ticker = ?
                """, (i + 1, scan_type, row["ticker"]))


def get_rankings(scan_type: str, limit: int = 50, include_below: bool = True,
                 grey_limit: int = GREY_LIMIT_DEFAULT) -> list[dict]:
    """Get current rankings for a scan type with trend data.

    Returns a list of dicts with all values converted to native Python types
    to ensure JSON serialization safety.

    Threshold boards (momentum/reversal) return qualifiers ranked 1..N
    (ordered by current score, then same-day strength) followed by grey rows pinned
    at the bottom (ordered by scan_score DESC, same-day signal strength).
    Grey rows carry ``below_threshold=True`` and ``current_rank=None``.
    Pass ``include_below=False`` for the legacy qualifiers-only view.

    Each entry includes trend fields:
      - trend_direction: 'up', 'down', 'flat', or 'new'
      - trend_change: absolute number of positions changed (0 if flat/new)
      - below_threshold: True for grey rows pinned below the ranked board
    """
    with get_connection() as conn:
        if scan_type in THRESHOLD_SCAN_TYPES:
            # Fetch active qualifiers in the same order as stored ranks.
            rows = conn.execute("""
                SELECT * FROM rankings
                WHERE scan_type = ? AND exit_date IS NULL AND scan_score >= ?
                ORDER BY scan_score DESC, tie_breaker DESC, ticker ASC
                LIMIT ?
            """, (scan_type, MIN_DISPLAY_SCORE, limit)).fetchall()

            grey_rows = []
            if include_below:
                grey_rows = conn.execute("""
                    SELECT * FROM rankings
                    WHERE scan_type = ? AND exit_date IS NULL AND scan_score < ?
                    ORDER BY scan_score DESC, tie_breaker DESC, ticker ASC
                    LIMIT ?
                """, (scan_type, MIN_DISPLAY_SCORE, grey_limit)).fetchall()
        else:
            # Non-threshold scan types keep legacy behavior (no grey split).
            rows = conn.execute("""
                SELECT * FROM rankings
                WHERE scan_type = ? AND exit_date IS NULL AND scan_score >= ?
                ORDER BY rank_score DESC
                LIMIT ?
            """, (scan_type, MIN_DISPLAY_SCORE, limit)).fetchall()
            grey_rows = []

        def _clean(d: dict) -> dict:
            # Defensive: ensure all values are native Python types
            # SQLite may return bytes for columns that received numpy types
            for key, val in d.items():
                if isinstance(val, bytes):
                    # Attempt to decode bytes to string; fallback to int
                    try:
                        d[key] = val.decode("utf-8")
                    except (UnicodeDecodeError, AttributeError):
                        try:
                            d[key] = int(val)
                        except (ValueError, TypeError):
                            d[key] = val
            return d

        def _trend(d: dict, current_rank: int | None) -> dict:
            # Calculate trend: compare current rank against previous rank
            # previous_rank is stored from the last 4 PM scan update.
            # Grey rows are unranked — they show 'new' on first sight,
            # otherwise 'flat' (still on board, below threshold).
            previous_rank = d.get("previous_rank")
            if current_rank is None:
                if previous_rank is None:
                    d["trend_direction"] = "new"
                else:
                    d["trend_direction"] = "flat"
                d["trend_change"] = 0
                return d
            if previous_rank is None:
                # No previous rank data — this is a new entry
                d["trend_direction"] = "new"
                d["trend_change"] = 0
            else:
                previous_rank = int(previous_rank)
                if current_rank < previous_rank:
                    # Moved up (lower rank number = higher position)
                    d["trend_direction"] = "up"
                    d["trend_change"] = previous_rank - current_rank
                elif current_rank > previous_rank:
                    # Moved down (higher rank number = lower position)
                    d["trend_direction"] = "down"
                    d["trend_change"] = current_rank - previous_rank
                else:
                    # Unchanged
                    d["trend_direction"] = "flat"
                    d["trend_change"] = 0
            return d

        result = []
        for i, r in enumerate(rows):
            d = _clean(dict(r))
            current_rank = i + 1
            d["below_threshold"] = False

            # Ensure current_rank is set correctly
            d["current_rank"] = current_rank
            d = _trend(d, current_rank)

            result.append(d)

        for r in grey_rows:
            d = _clean(dict(r))
            d["below_threshold"] = True
            # Grey rows are unranked — pinned below the ranked board.
            d["current_rank"] = None
            d = _trend(d, None)
            result.append(d)
        return result


def needs_trend_snapshot(scan_type: str) -> bool:
    """Check if a trend snapshot is needed (i.e., not done today yet).

    Returns True if any active ticker has trend_updated_at != today or NULL,
    meaning we haven't snapshotted the starting ranks for today's comparisons.
    """
    today = _today_str()
    with get_connection() as conn:
        if scan_type in THRESHOLD_SCAN_TYPES:
            row = conn.execute("SELECT snapshot_session FROM scanner_sessions WHERE scan_type = ?",
                               (scan_type,)).fetchone()
            return row is None or row["snapshot_session"] != today
        row = conn.execute("""
            SELECT COUNT(*) as cnt FROM rankings
            WHERE scan_type = ? AND exit_date IS NULL
            AND (trend_updated_at IS NULL OR trend_updated_at != ?)
        """, (scan_type, today)).fetchone()
        return row["cnt"] > 0


def update_trend_snapshots(scan_type: str, session_date: str | None = None):
    """
    Save current rank positions as the previous_rank for next day's trend comparison.

    This should be called ONLY at the 4 PM EST scan (last scan of the day).
    It snapshots the current_rank into previous_rank for all active tickers,
    so that the next day's scans can compute rank changes.

    Morning (9AM) and midday (1PM) scans do NOT call this function —
    they only refresh scores and rank order.

    Threshold boards snapshot ranked qualifiers only — grey rows keep their
    last qualified previous_rank so re-qualifying tickers trend correctly.
    """
    today = session_date or _today_str()

    with get_connection() as conn:
        if scan_type in THRESHOLD_SCAN_TYPES:
            row = conn.execute("SELECT snapshot_session FROM scanner_sessions WHERE scan_type = ?",
                               (scan_type,)).fetchone()
            if row and row["snapshot_session"] == today:
                return
        # For each active ticker in this scan_type, set previous_rank = current_rank
        if scan_type in THRESHOLD_SCAN_TYPES:
            active = conn.execute("""
                SELECT ticker, current_rank FROM rankings
                WHERE scan_type = ? AND exit_date IS NULL
                AND current_rank IS NOT NULL
            """, (scan_type,)).fetchall()
        else:
            active = conn.execute("""
                SELECT ticker, current_rank FROM rankings
                WHERE scan_type = ? AND exit_date IS NULL
            """, (scan_type,)).fetchall()

        for row in active:
            conn.execute("""
                UPDATE rankings
                SET previous_rank = ?, trend_updated_at = ?
                WHERE scan_type = ? AND ticker = ?
            """, (row["current_rank"], today, scan_type, row["ticker"]))
        if scan_type in THRESHOLD_SCAN_TYPES:
            conn.execute("""INSERT INTO scanner_sessions(scan_type, snapshot_session)
                            VALUES (?, ?) ON CONFLICT(scan_type) DO UPDATE
                            SET snapshot_session = excluded.snapshot_session""", (scan_type, today))


def set_last_scan_completed_at(scan_type: str, completed_at: str):
    """Persist the scan completion timestamp for a scan type.

    Updates all active rows so the ranking endpoint can return it.
    """
    with get_connection() as conn:
        if scan_type in THRESHOLD_SCAN_TYPES:
            conn.execute("""INSERT INTO scanner_sessions(scan_type, last_completed_at)
                            VALUES (?, ?) ON CONFLICT(scan_type) DO UPDATE
                            SET last_completed_at = excluded.last_completed_at""",
                         (scan_type, completed_at))
        conn.execute("""
            UPDATE rankings SET last_scan_completed_at = ?
            WHERE scan_type = ? AND exit_date IS NULL
        """, (completed_at, scan_type))


def get_last_scan_completed_at(scan_type: str) -> str | None:
    """Get the most recent scan completion timestamp for a scan type."""
    with get_connection() as conn:
        if scan_type in THRESHOLD_SCAN_TYPES:
            row = conn.execute("SELECT last_completed_at FROM scanner_sessions WHERE scan_type = ?",
                               (scan_type,)).fetchone()
            return row["last_completed_at"] if row else None
        row = conn.execute("""
            SELECT MAX(last_scan_completed_at) as completed_at
            FROM rankings
            WHERE scan_type = ? AND exit_date IS NULL
        """, (scan_type,)).fetchone()
        return row["completed_at"] if row and row["completed_at"] else None
