"""
universe.py — Universe management service.

Manages the list of stocks (default + custom) in the SQLite database.
Provides CRUD for custom stocks and merged-universe queries consumed
by scanners, news cache, and the frontend.

The database is the single source of truth.  An in-memory cache
(`_universe_cache`, `_universe_metadata_cache`) avoids repeated DB
round-trips for read-heavy consumers.  The cache is invalidated
whenever the database is mutated (seed, add, remove).
"""

import re
import logging

from config import (
    DEFAULT_UNIVERSE,
    COMPANY_NAMES,
    MERGED_UNIVERSE,
    UNIVERSE_SECTORS,
)
from models.db import get_connection

log = logging.getLogger(__name__)

# Compiled regex: uppercase alphanumeric + optional hyphens/dots, 1-10 chars
_TICKER_RE = re.compile(r"^[A-Z0-9][A-Z0-9\-\.]{0,9}$")


# ── In-memory cache ────────────────────────────────────────────────────────
# Populated lazily on first read, invalidated on any DB mutation.
_universe_cache: list[str] | None = None
_universe_metadata_cache: list[dict] | None = None


def invalidate_universe_cache():
    """Invalidate the in-memory universe cache.

    Must be called after any database mutation (seed, add, remove)
    so subsequent reads reflect the updated state.
    """
    global _universe_cache, _universe_metadata_cache
    _universe_cache = None
    _universe_metadata_cache = None
    log.debug("Universe cache invalidated")


# ── Validation ──────────────────────────────────────────────────────────────


def _validate_ticker(ticker: str) -> tuple[bool, str]:
    """Validate ticker format. Returns (ok, error_message)."""
    if not ticker:
        return False, "Ticker is required"
    if not _TICKER_RE.match(ticker):
        return False, (
            f"Invalid ticker '{ticker}'. "
            "Use 1-10 uppercase letters/digits; hyphens allowed (e.g. BRK-B)."
        )
    return True, ""


# ── Seed ────────────────────────────────────────────────────────────────────


def seed_default_universe():
    """Seed the universe table with DEFAULT_UNIVERSE, merging new tickers.

    Called on app startup to ensure all default stocks are present.
    Inserts any tickers from MERGED_UNIVERSE that are not yet in the DB.
    Also populates the ``sector`` column from UNIVERSE_SECTORS so the
    database carries full metadata for every default ticker.
    """
    added = 0
    updated = 0

    with get_connection() as conn:
        existing = {
            row["ticker"]
            for row in conn.execute("SELECT ticker FROM universe").fetchall()
        }

        for ticker in DEFAULT_UNIVERSE:
            company = COMPANY_NAMES.get(ticker, "")
            sector = UNIVERSE_SECTORS.get(ticker, "")

            if ticker in existing:
                # Always update sector from config (source of truth)
                conn.execute(
                    "UPDATE universe SET sector = ? WHERE ticker = ?",
                    (sector, ticker),
                )
                updated += 1
            else:
                conn.execute(
                    "INSERT OR IGNORE INTO universe (ticker, company_name, source, sector) "
                    "VALUES (?, ?, 'default', ?)",
                    (ticker, company, sector),
                )
                added += 1

    if added > 0 or updated > 0:
        log.info(
            "Universe sync: %d added, %d updated (total default: %d)",
            added, updated, len(DEFAULT_UNIVERSE),
        )
        invalidate_universe_cache()


# ── Read helpers ────────────────────────────────────────────────────────────


def get_merged_universe() -> list[str]:
    """Return merged universe (default + custom), de-duplicated.

    Returns:
        List of ticker strings, e.g. ["AAPL", "MSFT", ..., "PLTR", "AI"]
    """
    global _universe_cache
    if _universe_cache is not None:
        return list(_universe_cache)  # defensive copy

    with get_connection() as conn:
        rows = conn.execute(
            "SELECT ticker FROM universe ORDER BY source DESC, ticker"
        ).fetchall()
        result = [row["ticker"] for row in rows]

    _universe_cache = result
    return list(result)


def get_merged_universe_with_metadata() -> list[dict]:
    """Return the full universe with ticker, company_name, and sector.

    This is the primary data source for consumers that need more than
    bare ticker symbols (e.g. yf_fetcher for sector tagging).

    Returns:
        List of dicts, e.g.
        [{"ticker": "AAPL", "company_name": "Apple", "sector": "Tech"}, ...]
    """
    global _universe_metadata_cache
    if _universe_metadata_cache is not None:
        return list(_universe_metadata_cache)

    with get_connection() as conn:
        rows = conn.execute(
            "SELECT ticker, company_name, sector FROM universe "
            "ORDER BY source DESC, ticker"
        ).fetchall()
        result = [
            {
                "ticker": row["ticker"],
                "company_name": row["company_name"] or "",
                "sector": row["sector"] or "",
            }
            for row in rows
        ]

    _universe_metadata_cache = result
    return list(result)


def get_merged_company_names() -> dict[str, str]:
    """Return merged company-name map.

    Custom names override defaults so users can correct inaccurate values.
    """
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT ticker, company_name FROM universe"
        ).fetchall()
        return {row["ticker"]: row["company_name"] or "" for row in rows}


def get_custom_stocks() -> list[dict]:
    """Return only custom (non-default) stocks."""
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT ticker, company_name FROM universe WHERE source = 'custom'"
        ).fetchall()
        return [
            {"ticker": row["ticker"], "company_name": row["company_name"]}
            for row in rows
        ]


# ── CRUD ────────────────────────────────────────────────────────────────────


def add_custom_stock(ticker: str, company_name: str = None, sector: str = None) -> dict:
    """Add a custom stock to the universe.

    Returns:
        {"status": "added", "ticker": ..., "company_name": ...}
        {"status": "exists", "message": "..."}
        {"status": "error",  "message": "..."}
    """
    if not ticker:
        return {"status": "error", "message": "Ticker is required"}
    ticker = str(ticker).upper().strip()

    if not company_name:
        return {"status": "error", "message": "Company name is required"}
    company_name = str(company_name).strip()
    if not company_name:
        return {"status": "error", "message": "Company name cannot be empty"}

    ok, err = _validate_ticker(ticker)
    if not ok:
        return {"status": "error", "message": err}

    # Check if it's already in default universe
    if ticker in DEFAULT_UNIVERSE:
        return {
            "status": "error",
            "message": (
                f"{ticker} is already in the default universe "
                "— no need to add it."
            ),
        }

    with get_connection() as conn:
        existing = conn.execute(
            "SELECT source FROM universe WHERE ticker = ?", (ticker,)
        ).fetchone()

        if existing:
            return {
                "status": "exists",
                "message": (
                    f"{ticker} is already in your universe "
                    f"(source: {existing['source']})."
                ),
            }

        conn.execute(
            "INSERT INTO universe (ticker, company_name, source, sector) "
            "VALUES (?, ?, 'custom', ?)",
            (ticker, company_name, sector or ""),
        )

        # Also insert a placeholder into dash_stocks so the stock
        # appears in the dashboard immediately — data will be
        # enriched by fetch_all() on its next run.
        conn.execute(
            "INSERT OR IGNORE INTO dash_stocks (symbol, name, sector) "
            "VALUES (?, ?, ?)",
            (ticker, company_name, sector or ""),
        )

    invalidate_universe_cache()
    log.info("Added custom stock: %s (%s)", ticker, company_name)
    return {"status": "added", "ticker": ticker, "company_name": company_name}


def remove_custom_stock(ticker: str) -> dict:
    """Remove a custom stock from the universe.

    Cannot remove default stocks.

    Returns:
        {"status": "removed", "ticker": "..."}
        {"status": "error",   "message": "..."}
    """
    if not ticker:
        return {"status": "error", "message": "Ticker is required"}
    ticker = str(ticker).upper().strip()

    with get_connection() as conn:
        existing = conn.execute(
            "SELECT source FROM universe WHERE ticker = ?", (ticker,)
        ).fetchone()

        if not existing:
            return {
                "status": "error",
                "message": f"{ticker} was not found in the universe.",
            }

        if existing["source"] == "default":
            return {
                "status": "error",
                "message": (
                    f"{ticker} is a default stock and cannot be removed."
                ),
            }

        conn.execute("DELETE FROM universe WHERE ticker = ?", (ticker,))

    invalidate_universe_cache()
    log.info("Removed custom stock: %s", ticker)
    return {"status": "removed", "ticker": ticker}


def get_sector_list() -> list[str]:
    """Return sorted list of allowed sector values."""
    from config import SECTOR_ETFS
    sectors = sorted(SECTOR_ETFS.keys())
    sectors.append("ETF")
    return sectors


def update_custom_stock_sector(ticker: str, sector: str) -> dict:
    """Update the sector of a custom universe entry.

    Returns:
        {"status": "updated", "ticker": ..., "sector": ...}
        {"status": "error", "message": "..."}
    """
    if not ticker:
        return {"status": "error", "message": "Ticker is required"}
    ticker = str(ticker).upper().strip()

    ok, err = _validate_ticker(ticker)
    if not ok:
        return {"status": "error", "message": err}

    if not sector:
        return {"status": "error", "message": "Sector is required"}

    allowed = get_sector_list()
    if sector not in allowed:
        return {"status": "error", "message": f"Invalid sector. Allowed: {', '.join(allowed)}"}

    with get_connection() as conn:
        existing = conn.execute(
            "SELECT source FROM universe WHERE ticker = ?", (ticker,)
        ).fetchone()

        if not existing:
            return {"status": "error", "message": f"{ticker} not found in universe"}

        if existing["source"] == "default":
            return {"status": "error", "message": f"{ticker} is a default stock — sector cannot be changed"}

        conn.execute(
            "UPDATE universe SET sector = ? WHERE ticker = ?",
            (sector, ticker),
        )

    invalidate_universe_cache()
    log.info("Updated sector for custom stock: %s → %s", ticker, sector)
    return {"status": "updated", "ticker": ticker, "sector": sector}
