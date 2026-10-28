"""
db.py — SQLite connection helper.

Provides a context-managed connection with WAL mode enabled and
a one-shot init_db() function that creates every table defined in schema.py.
"""

import logging
import os
import sqlite3
from contextlib import contextmanager

from config import DATABASE_PATH

log = logging.getLogger(__name__)


@contextmanager
def get_connection():
    """Context manager for database connections.

    Yields a sqlite3.Connection with row_factory set to sqlite3.Row.
    Commits on clean exit, rolls back on exception, always closes.
    """
    os.makedirs(os.path.dirname(os.path.abspath(DATABASE_PATH)), exist_ok=True)
    conn = sqlite3.connect(DATABASE_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db():
    """Create all tables if they don't exist, then run migrations.

    Imports CREATE_TABLES from schema so the module is lazily loaded —
    this avoids circular-import issues when other modules import db.py
    at module level.
    """
    from models.schema import CREATE_TABLES

    with get_connection() as conn:
        for sql in CREATE_TABLES:
            conn.execute(sql)

        # ── Migrations: add columns that may not exist on older DBs ──
        _migrate_rankings_trend(conn)
        _migrate_rankings_last_scan(conn)
        _migrate_alert_history_dedup(conn)
        _migrate_total_investment(conn)
        _migrate_sma200_scan(conn)
        _migrate_ytd_scan(conn)
        _migrate_ytd_scan_snapshots(conn)
        _migrate_backfill_transactions(conn)
        _migrate_quality_score_scan(conn)
        _migrate_rankings_streak(conn)
        _migrate_volume_profile_range(conn)
        _migrate_orb_decisions_checkpoint(conn)
        _migrate_portfolio_sort_order(conn)
        _migrate_portfolio_cash(conn)
        _migrate_etf_holding_shares(conn)


def _migrate_etf_holding_shares(conn):
    """Historical weights cannot reconstruct quantities; leave old shares NULL."""
    columns = {row["name"] for row in conn.execute("PRAGMA table_info(etf_holding_snapshots)")}
    if "shares" not in columns:
        conn.execute("ALTER TABLE etf_holding_snapshots ADD COLUMN shares REAL")


def _migrate_rankings_trend(conn):
    """Add previous_rank and trend_updated_at columns to rankings if missing."""
    cursor = conn.execute("PRAGMA table_info(rankings)")
    columns = {row["name"] for row in cursor.fetchall()}

    if "previous_rank" not in columns:
        conn.execute("ALTER TABLE rankings ADD COLUMN previous_rank INTEGER")
    if "trend_updated_at" not in columns:
        conn.execute("ALTER TABLE rankings ADD COLUMN trend_updated_at TEXT")


def _migrate_rankings_last_scan(conn):
    """Add last_scan_completed_at column to rankings if missing."""
    cursor = conn.execute("PRAGMA table_info(rankings)")
    columns = {row["name"] for row in cursor.fetchall()}

    if "last_scan_completed_at" not in columns:
        conn.execute("ALTER TABLE rankings ADD COLUMN last_scan_completed_at TEXT")


def _migrate_alert_history_dedup(conn):
    """Deduplicate alert_history rows, add avg_price column, and create
    the per-position unique index.

    Existing databases may have duplicate entries from the double-scheduler
    bug.  This migration keeps only the earliest row per (ticker, type,
    avg_price, date(fired_at)), then creates a unique index to prevent
    future dupes.  The avg_price column enables per-position dedup so
    different positions in the same ticker each get their own alert.
    """
    # ── Step 1: Add avg_price column if missing ────────────────────────
    cursor = conn.execute("PRAGMA table_info(alert_history)")
    columns = {row["name"] for row in cursor.fetchall()}
    if "avg_price" not in columns:
        conn.execute("ALTER TABLE alert_history ADD COLUMN avg_price REAL")
    if "event_key" not in columns:
        conn.execute("ALTER TABLE alert_history ADD COLUMN event_key TEXT")

    # ── Step 2: Drop the old ticker-level index if it exists ───────────
    old_index = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='index' "
        "AND name='idx_alert_history_dedup'"
    ).fetchone()
    if old_index:
        conn.execute("DROP INDEX idx_alert_history_dedup")

    # ── Step 3: Remove duplicates (keep earliest row per group) ────────
    conn.execute("""
        DELETE FROM alert_history
        WHERE event_key IS NULL AND id NOT IN (
            SELECT MIN(id)
            FROM alert_history
            WHERE event_key IS NULL
            GROUP BY ticker, type, avg_price, date(fired_at)
        )
    """)

    # ── Step 4: Create per-position unique index ───────────────────────
    conn.execute("""
        CREATE UNIQUE INDEX idx_alert_history_dedup
        ON alert_history (ticker, type, avg_price, date(fired_at))
        WHERE event_key IS NULL
    """)
    # Keyed events retain their portfolio/cycle identity across restarts.
    conn.execute("""
        CREATE UNIQUE INDEX IF NOT EXISTS idx_alert_history_event_key
        ON alert_history (event_key) WHERE event_key IS NOT NULL
    """)


def _migrate_total_investment(conn):
    """Add total_investment column to positions if missing.

    Backfills existing positions using qty * avg_price so the Net
    Investment method works correctly from the start.
    """
    cursor = conn.execute("PRAGMA table_info(positions)")
    columns = {row["name"] for row in cursor.fetchall()}

    if "total_investment" not in columns:
        conn.execute("ALTER TABLE positions ADD COLUMN total_investment REAL NOT NULL DEFAULT 0")
        # Backfill: set total_investment = qty * avg_price for rows that have avg_price > 0
        conn.execute(
            "UPDATE positions SET total_investment = qty * avg_price WHERE total_investment = 0 AND avg_price > 0"
        )


def _migrate_sma200_scan(conn):
    """Create sma200_scan table if it doesn't exist."""
    cursor = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='sma200_scan'")
    if not cursor.fetchone():
        conn.execute("""
            CREATE TABLE IF NOT EXISTS sma200_scan (
                ticker TEXT PRIMARY KEY,
                sma_200 REAL,
                price REAL,
                pct_from_sma REAL,
                above_sma INTEGER,
                scanned_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
        """)


def _migrate_ytd_scan(conn):
    """Create ytd_scan table if it doesn't exist."""
    cursor = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='ytd_scan'")
    if not cursor.fetchone():
        conn.execute("""
            CREATE TABLE IF NOT EXISTS ytd_scan (
                ticker TEXT PRIMARY KEY,
                ytd_pct REAL,
                price REAL,
                year_start_close REAL,
                scanned_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
        """)


def _migrate_ytd_scan_snapshots(conn):
    """Create ytd_scan_snapshots table if it doesn't exist."""
    cursor = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='ytd_scan_snapshots'")
    if not cursor.fetchone():
        conn.execute("""
            CREATE TABLE IF NOT EXISTS ytd_scan_snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ticker TEXT NOT NULL,
                date TEXT NOT NULL,
                ytd_pct REAL NOT NULL,
                price REAL NOT NULL,
                rank INTEGER,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(ticker, date)
            )
        """)
    else:
        # Backfill rank column for databases created before rank tracking
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(ytd_scan_snapshots)").fetchall()}
        if "rank" not in cols:
            conn.execute("ALTER TABLE ytd_scan_snapshots ADD COLUMN rank INTEGER")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_ytd_snap_ticker ON ytd_scan_snapshots(ticker)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_ytd_snap_date ON ytd_scan_snapshots(date DESC)")


def _migrate_backfill_transactions(conn):
    """Create BUY transactions for existing positions that have no transaction record.

    The transactions table was added after positions, so pre-existing holdings
    have no transaction history. This backfill creates one BUY transaction per
    orphaned position using today's date. Idempotent: positions with existing
    transactions are skipped via NOT EXISTS.
    """
    from datetime import date

    # Check if transactions table exists (defensive)
    table_exists = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='transactions'"
    ).fetchone()
    if not table_exists:
        return

    # Find positions with no matching BUY transaction
    orphans = conn.execute("""
        SELECT p.id, p.portfolio_id, p.ticker, p.qty, p.avg_price,
               p.total_investment, p.notes
        FROM positions p
        WHERE NOT EXISTS (
            SELECT 1 FROM transactions t
            WHERE t.portfolio_id = p.portfolio_id
              AND t.ticker = p.ticker
              AND t.type = 'BUY'
        )
        AND p.qty > 0
    """).fetchall()

    if not orphans:
        return

    today = date.today().isoformat()
    count = 0
    for pos in orphans:
        total = pos["total_investment"] if pos["total_investment"] > 0 else pos["qty"] * pos["avg_price"]
        notes = pos["notes"] or ""
        conn.execute(
            """INSERT INTO transactions (portfolio_id, ticker, type, qty, price, total, date, notes)
               VALUES (?, ?, 'BUY', ?, ?, ?, ?, ?)""",
            (pos["portfolio_id"], pos["ticker"], pos["qty"],
             pos["avg_price"], total, today, notes),
        )
        count += 1

    log.info("Backfilled %d transaction(s) from existing positions", count)


def _migrate_rankings_streak(conn):
    """Introduce qualified streaks without inferring nonexistent daily history."""
    columns = {row["name"] for row in conn.execute("PRAGMA table_info(rankings)")}
    new_streak = "qualified_streak" not in columns
    if "qualified_streak" not in columns:
        conn.execute("ALTER TABLE rankings ADD COLUMN qualified_streak INTEGER DEFAULT 0")
    if "last_qualified_date" not in columns:
        conn.execute("ALTER TABLE rankings ADD COLUMN last_qualified_date TEXT")
    if new_streak:
        conn.execute("""UPDATE rankings SET last_qualified_date = last_seen,
                        qualified_streak = 1
                        WHERE scan_type IN ('momentum', 'reversal')
                        AND exit_date IS NULL AND scan_score >= 3""")
    if "tie_breaker" not in columns:
        conn.execute("ALTER TABLE rankings ADD COLUMN tie_breaker REAL DEFAULT 0")

    conn.execute("""UPDATE rankings SET rank_score = COALESCE(scan_score, 0) + COALESCE(tie_breaker, 0)
                    WHERE scan_type IN ('momentum', 'reversal')""")
    conn.execute("""UPDATE rankings SET current_rank = NULL
                    WHERE scan_type IN ('momentum', 'reversal') AND exit_date IS NULL
                    AND scan_score < 3""")
    for scan_type in ("momentum", "reversal"):
        ranked = conn.execute("""SELECT ticker FROM rankings WHERE scan_type = ?
                              AND exit_date IS NULL AND scan_score >= 3
                              ORDER BY scan_score DESC, tie_breaker DESC, ticker""",
                              (scan_type,)).fetchall()
        for i, row in enumerate(ranked):
            conn.execute("UPDATE rankings SET current_rank = ? WHERE scan_type = ? AND ticker = ?",
                         (i + 1, scan_type, row["ticker"]))


def _migrate_quality_score_scan(conn):
    """Add momentum_12_1 and sigma_raw columns to quality_score_scan if missing."""
    table_exists = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='quality_score_scan'"
    ).fetchone()
    if not table_exists:
        return

    cursor = conn.execute("PRAGMA table_info(quality_score_scan)")
    columns = {row["name"] for row in cursor.fetchall()}

    if "momentum_12_1" not in columns:
        conn.execute("ALTER TABLE quality_score_scan ADD COLUMN momentum_12_1 REAL")
    if "sigma_raw" not in columns:
        conn.execute("ALTER TABLE quality_score_scan ADD COLUMN sigma_raw REAL")


def _migrate_volume_profile_range(conn):
    """Migrate volume_profile PK(ticker) -> PK(ticker, range), preserving 3m rows.

    The 3m-only table shipped first with ticker as the sole primary key.
    The Swing upgrade stores 3m + 6m rows per ticker. Rebuild via copy so
    existing levels survive; 6m rows fill in on the next 16:20 run.
    Idempotent: no-op when the composite PK already exists.
    """
    table = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='volume_profile'"
    ).fetchone()
    if not table or not table["sql"]:
        return
    if "PRIMARY KEY (ticker, range)" in table["sql"]:
        return
    log.info("Migrating volume_profile to PK(ticker, range)...")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS volume_profile_new (
            ticker TEXT NOT NULL,
            range TEXT NOT NULL DEFAULT '3m',
            poc REAL,
            vah REAL,
            val REAL,
            max_volume REAL,
            total_volume REAL,
            step REAL,
            grid_min REAL,
            grid_max REAL,
            value_area_coverage REAL,
            stable INTEGER DEFAULT 1,
            poc_spread REAL,
            session_date TEXT,
            candle_count INTEGER,
            insufficient_data INTEGER DEFAULT 0,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (ticker, range)
        )
    """)
    conn.execute("""
        INSERT OR REPLACE INTO volume_profile_new
            (ticker, range, poc, vah, val, max_volume, total_volume, step,
             grid_min, grid_max, value_area_coverage, stable, poc_spread,
             session_date, candle_count, insufficient_data, updated_at)
        SELECT ticker, COALESCE(range, '3m'), poc, vah, val, max_volume,
             total_volume, step, grid_min, grid_max, value_area_coverage,
             stable, poc_spread, session_date, candle_count,
             insufficient_data, updated_at
        FROM volume_profile
    """)
    conn.execute("DROP TABLE volume_profile")
    conn.execute("ALTER TABLE volume_profile_new RENAME TO volume_profile")
    log.info("volume_profile migration complete")


def _migrate_orb_decisions_checkpoint(conn):
    """Migrate orb_decisions checkpoint set 11:30 -> 11:15.

    The Criteria-2 revision moved the third checkpoint from 11:30 to
    11:15 (deterministic inputs — the 11:15-start bar is lag-exposed).
    SQLite cannot ALTER a CHECK constraint, so rebuild the table,
    remapping any stored '11:30' rows. Idempotent: no-op when the new
    constraint already exists. Pre-first-live-run tables are empty;
    the remap preserves rows regardless.
    """
    table = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='orb_decisions'"
    ).fetchone()
    if not table or not table["sql"]:
        return
    if "'11:15'" in table["sql"]:
        return
    log.info("Migrating orb_decisions checkpoint 11:30 -> 11:15...")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS orb_decisions_new (
            ticker TEXT NOT NULL,
            session_date TEXT NOT NULL,
            checkpoint TEXT NOT NULL CHECK(checkpoint IN ('10:30', '11:00', '11:15')),
            setup TEXT CHECK(setup IN ('continuation', 'reversal', 'none')),
            direction TEXT CHECK(direction IN ('long', 'short', 'none')),
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (ticker, session_date, checkpoint)
        )
    """)
    conn.execute("""
        INSERT OR REPLACE INTO orb_decisions_new
            (ticker, session_date, checkpoint, setup, direction, updated_at)
        SELECT ticker, session_date,
               CASE WHEN checkpoint = '11:30' THEN '11:15' ELSE checkpoint END,
               setup, direction, updated_at
        FROM orb_decisions
    """)
    conn.execute("DROP TABLE orb_decisions")
    conn.execute("ALTER TABLE orb_decisions_new RENAME TO orb_decisions")
    log.info("orb_decisions migration complete")


def _migrate_portfolio_sort_order(conn):
    """Add sort_order column to portfolios if missing and backfill it.

    Backfills existing rows in name order so pre-feature databases keep
    their current A-Z display on first load. New portfolios append at
    MAX(sort_order)+1. Idempotent: no-op when the column already exists.
    Only touches the portfolios table — transactions/positions are
    keyed by portfolio_id and unaffected.
    """
    columns = {row["name"] for row in conn.execute("PRAGMA table_info(portfolios)")}
    if "sort_order" not in columns:
        conn.execute("ALTER TABLE portfolios ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0")
        conn.execute("""
            UPDATE portfolios SET sort_order = (
                SELECT COUNT(*) FROM portfolios p2
                WHERE p2.name < portfolios.name
                   OR (p2.name = portfolios.name AND p2.id < portfolios.id)
            )
        """)
        log.info("portfolios sort_order migration complete")
    else:
        # Normalize NULLs/negatives from very old manual edits, if any.
        conn.execute("UPDATE portfolios SET sort_order = 0 WHERE sort_order IS NULL")


def _migrate_portfolio_cash(conn):
    """Give existing portfolios an independent cash tracker starting at zero."""
    columns = {row["name"] for row in conn.execute("PRAGMA table_info(portfolios)")}
    if "cash_cents" not in columns:
        conn.execute(
            "ALTER TABLE portfolios ADD COLUMN cash_cents INTEGER NOT NULL DEFAULT 0 CHECK (cash_cents >= 0)"
        )
