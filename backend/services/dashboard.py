"""
dashboard.py — Earnings Momentum Dashboard service.

Provides data for the dashboard API endpoints by querying the
dash_stocks, dash_prices, dash_earnings, dash_momentum, and dash_last_fetch
tables. These tables are populated by the yfinance fetcher.
"""

import logging
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from models.db import get_connection

logger = logging.getLogger(__name__)


def get_dashboard_data() -> list[dict]:
    """Return all stocks with their price history, earnings, and momentum data.

    Returns a list of stock objects sorted by rank_score descending,
    each containing:
        symbol, name, sector, earnings_date, days_to_earnings,
        rank_score, streak, last_updated, sp500_rs,
        prices: [{date, close, pct_change, volume}]
    """
    with get_connection() as conn:
        rows = conn.execute("""
            SELECT
                u.ticker AS symbol,
                COALESCE(s.name, u.company_name) AS name,
                COALESCE(s.sector, u.sector) AS sector,
                e.earnings_date, e.days_to_earnings,
                m.rank_score, m.streak, m.last_updated, m.sp500_rs
            FROM universe u
            LEFT JOIN dash_stocks s ON u.ticker = s.symbol
            LEFT JOIN dash_earnings e ON u.ticker = e.symbol
            LEFT JOIN dash_momentum m ON u.ticker = m.symbol
            WHERE u.sector != 'ETF'
            ORDER BY m.rank_score DESC NULLS LAST
        """).fetchall()

        result = []
        for row in rows:
            sym = row["symbol"]
            prices = conn.execute("""
                SELECT date, close, pct_change, volume
                FROM dash_prices
                WHERE symbol = ?
                ORDER BY date ASC
            """, (sym,)).fetchall()

            result.append({
                "symbol": sym,
                "name": row["name"],
                "sector": row["sector"],
                "earnings_date": row["earnings_date"],
                "days_to_earnings": row["days_to_earnings"],
                "rank_score": row["rank_score"] or 0,
                "streak": row["streak"] or 0,
                "last_updated": row["last_updated"],
                "sp500_rs": row["sp500_rs"] or 0,
                "prices": [
                    {
                        "date": p["date"],
                        "close": p["close"],
                        "pct_change": p["pct_change"],
                        "volume": p["volume"],
                    }
                    for p in prices
                ],
            })

    return result


def get_ticker_candles(symbol: str) -> list[dict]:
    """Return OHLCV candle data for a specific ticker.

    Returns a list of candle objects sorted by date ascending:
        [{date, open, high, low, close, volume}]
    """
    with get_connection() as conn:
        rows = conn.execute("""
            SELECT date, open, high, low, close, volume
            FROM dash_prices WHERE symbol = ?
            ORDER BY date ASC
        """, (symbol,)).fetchall()

    return [dict(r) for r in rows]


def get_last_fetch() -> str | None:
    """Return the ISO timestamp of the last data fetch, or None."""
    with get_connection() as conn:
        row = conn.execute(
            "SELECT fetched_at FROM dash_last_fetch WHERE id=1"
        ).fetchone()
    return row["fetched_at"] if row else None


def set_last_fetch(dt_str: str):
    """Set the last fetch timestamp."""
    with get_connection() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO dash_last_fetch (id, fetched_at) VALUES (1, ?)",
            (dt_str,),
        )


def is_market_day() -> bool:
    """Return True if today is a weekday (Mon-Fri) in Eastern Time."""
    return datetime.now(ZoneInfo("America/New_York")).weekday() < 5


def is_market_open() -> bool:
    """Return True if the US stock market is currently open.

    Market hours are 9:30 AM – 4:00 PM Eastern Time on weekdays.
    Uses zoneinfo for proper DST/EST handling.
    """
    et = ZoneInfo("America/New_York")
    now_et = datetime.now(et)
    if now_et.weekday() >= 5:  # Saturday or Sunday
        return False
    market_open = now_et.replace(hour=9, minute=30, second=0, microsecond=0)
    market_close = now_et.replace(hour=16, minute=0, second=0, microsecond=0)
    return market_open <= now_et < market_close


def get_status() -> dict:
    """Return dashboard status information."""
    last = get_last_fetch()
    now_utc = datetime.now(timezone.utc)
    et = ZoneInfo("America/New_York")
    now_et = datetime.now(et)
    now_est_hour = now_et.hour
    today_str = now_utc.strftime("%Y-%m-%d")
    already_fetched = last and last[:10] == today_str

    return {
        "last_fetch": last,
        "is_market_day": is_market_day(),
        "is_market_open": is_market_open(),
        "server_time_utc": now_utc.isoformat(),
        "est_hour": now_est_hour,
        "already_fetched": already_fetched,
    }


def upsert_stock(symbol: str, name: str, sector: str):
    """Insert or replace a stock in the dashboard stocks table."""
    with get_connection() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO dash_stocks (symbol, name, sector) VALUES (?, ?, ?)",
            (symbol, name, sector),
        )


def upsert_price(symbol: str, date: str, open_: float, high: float,
                 low: float, close: float, volume: int, pct_change: float):
    """Insert or replace a price data point."""
    with get_connection() as conn:
        conn.execute(
            """INSERT OR REPLACE INTO dash_prices
               (symbol, date, open, high, low, close, volume, pct_change)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (symbol, date, open_, high, low, close, volume, pct_change),
        )


def upsert_earnings(symbol: str, earnings_date: str, days_to_earnings: int):
    """Insert or replace earnings date info."""
    with get_connection() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO dash_earnings (symbol, earnings_date, days_to_earnings) VALUES (?, ?, ?)",
            (symbol, earnings_date, days_to_earnings),
        )


def upsert_quarterly_earnings(symbol: str, earnings_list: list[dict]):
    """Replace all quarterly earnings for a symbol.

    Deletes existing rows for the symbol, then inserts all new rows.
    This keeps the table fresh as earnings data rarely changes.

    Args:
        symbol: Ticker symbol.
        earnings_list: List of dicts with keys: earnings_date, eps_actual, eps_estimate, surprise_pct.
    """
    with get_connection() as conn:
        conn.execute("DELETE FROM quarterly_earnings WHERE symbol = ?", (symbol,))
        for entry in earnings_list:
            conn.execute(
                "INSERT OR REPLACE INTO quarterly_earnings "
                "(symbol, earnings_date, eps_actual, eps_estimate, surprise_pct) "
                "VALUES (?, ?, ?, ?, ?)",
                (
                    symbol,
                    entry["earnings_date"],
                    entry.get("eps_actual", 0),
                    entry.get("eps_estimate", 0),
                    entry.get("surprise_pct", 0),
                ),
            )


def upsert_earnings_announcement(
    symbol: str, announcement_date: str, quarter_end_date: str,
    eps_actual: float, eps_estimate: float, surprise_pct: float
):
    """Store a historical earnings announcement with beat/miss data.

    Archives a past earnings date before it gets overwritten by the weekly
    cron refresh. Uses the announcement date (not quarter-end date) as the
    primary key so multiple past earnings can be tracked per ticker.
    """
    with get_connection() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO earnings_announcements "
            "(symbol, announcement_date, quarter_end_date, eps_actual, eps_estimate, surprise_pct) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (symbol, announcement_date, quarter_end_date, eps_actual, eps_estimate, surprise_pct),
        )


def upsert_momentum(symbol: str, rank_score: int, streak: int, sp500_rs: float):
    """Insert or replace momentum score."""
    with get_connection() as conn:
        conn.execute(
            """INSERT OR REPLACE INTO dash_momentum
               (symbol, rank_score, streak, last_updated, sp500_rs)
               VALUES (?, ?, ?, ?, ?)""",
            (symbol, rank_score, streak, datetime.now(timezone.utc).isoformat(), sp500_rs),
        )


def has_data() -> bool:
    """Check if the dashboard tables have any data."""
    with get_connection() as conn:
        count = conn.execute("SELECT COUNT(*) FROM dash_stocks").fetchone()[0]
    return count > 0


def detect_mock_data() -> bool:
    """Detect if dashboard data looks like leftover mock/seeded data.

    Uses multiple heuristics to catch various mock data patterns:

    1. **Uniform dates**: All prices share the same date (single-day snapshot).
    2. **Identical pct_change**: All pct_change values are the same across all tickers.
    3. **Single dominant rank_score**: One rank_score value accounts for >25% of tickers.
       Real computed scores from individual price histories should be well-distributed.
    4. **Low rank diversity**: Too few distinct rank_score values relative to ticker count.
       With ~82 tickers and score range [-17, +17], real data produces broad distribution.
    5. **Uniform per-ticker pct_changes**: >50% of tickers have only 1 distinct pct_change,
       meaning their entire price history is flat or identical — impossible for real market data.
    6. **All rank scores identical**: Every non-zero rank_score is the same value.

    Returns True if data matches mock patterns, False if it looks real.
    """
    with get_connection() as conn:
        total = conn.execute("SELECT COUNT(*) FROM dash_momentum").fetchone()[0]
        if total == 0:
            return False

        # ── Heuristic 1: All prices share the same date ─────────────────
        date_count = conn.execute(
            "SELECT COUNT(DISTINCT date) FROM dash_prices"
        ).fetchone()[0]
        if date_count <= 1:
            logger.warning(
                "Mock data detected: all prices share same date (distinct_dates=%d)",
                date_count,
            )
            return True

        # ── Heuristic 2: All pct_change values identical ────────────────
        pct_values = conn.execute(
            "SELECT DISTINCT ROUND(pct_change, 2) FROM dash_prices"
        ).fetchall()
        if len(pct_values) <= 1:
            logger.warning("Mock data detected: all pct_change values identical")
            return True

        # ── Heuristic 3: Single dominant rank_score (>25% of tickers) ───
        # Real rank scores computed from individual 10-day price histories
        # have a range of ~[-17, +17]. With 82 tickers, the expected count
        # per score is ~2.3. A single score appearing 20+ times is anomalous.
        dominant_threshold = max(5, int(total * 0.25))
        dominant = conn.execute(
            """SELECT rank_score, COUNT(*) AS cnt
               FROM dash_momentum
               WHERE rank_score != 0
               GROUP BY rank_score
               HAVING cnt > ?
               ORDER BY cnt DESC
               LIMIT 1""",
            (dominant_threshold,),
        ).fetchone()
        if dominant:
            pct = 100 * dominant["cnt"] / total
            logger.warning(
                "Mock data detected: rank_score=%d shared by %d/%d tickers (%.0f%%)",
                dominant["rank_score"], dominant["cnt"], total, pct,
            )
            return True

        # ── Heuristic 4: Too few distinct rank_score values ─────────────
        # With ~82 tickers and score range [-17, +17], expect 20+ distinct values.
        distinct_ranks = conn.execute(
            "SELECT COUNT(DISTINCT rank_score) FROM dash_momentum"
        ).fetchone()[0]
        min_distinct = max(5, int(total * 0.15))
        if total >= 10 and distinct_ranks < min_distinct:
            logger.warning(
                "Mock data detected: only %d distinct rank scores for %d tickers (need >=%d)",
                distinct_ranks, total, min_distinct,
            )
            return True

        # ── Heuristic 5: Most tickers have uniform pct_change ───────────
        # Each ticker should have ~10 days of varied price data.
        # If >50% have only 1 distinct pct_change, the data is synthetic.
        uniform_tickers = conn.execute(
            """SELECT COUNT(*) FROM (
                 SELECT symbol, COUNT(DISTINCT ROUND(pct_change, 2)) AS dp
                 FROM dash_prices
                 GROUP BY symbol
                 HAVING dp <= 1
               )"""
        ).fetchone()[0]
        if uniform_tickers > total * 0.5:
            logger.warning(
                "Mock data detected: %d/%d tickers have uniform pct_change",
                uniform_tickers, total,
            )
            return True

        # ── Heuristic 6: All non-zero rank scores identical ─────────────
        rank_values = conn.execute(
            "SELECT DISTINCT rank_score FROM dash_momentum WHERE rank_score != 0"
        ).fetchall()
        if len(rank_values) <= 1 and total > 5:
            logger.warning(
                "Mock data detected: all non-zero rank scores identical (count=%d)",
                total,
            )
            return True

    return False


def clear_mock_data():
    """Clear all dashboard tables to remove leftover mock/seeded data.

    Truncates dash_prices, dash_earnings, dash_momentum, dash_stocks,
    and dash_last_fetch so a fresh fetch can populate real data.
    """
    logger.info("Clearing mock/stale dashboard data...")
    with get_connection() as conn:
        conn.execute("DELETE FROM dash_prices")
        conn.execute("DELETE FROM dash_earnings")
        conn.execute("DELETE FROM dash_momentum")
        conn.execute("DELETE FROM dash_stocks")
        conn.execute("DELETE FROM dash_last_fetch")
    logger.info("Dashboard tables cleared.")
