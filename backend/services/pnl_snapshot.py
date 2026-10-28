"""
pnl_snapshot.py — Portfolio P/L snapshot recording service.

Records daily end-of-day P/L snapshots for each portfolio by:
1. Loading positions from the database
2. Fetching live market quotes via get_quotes()
3. Computing aggregate market_value and cost_basis
4. Inserting/updating the snapshot row in portfolio_pnl_snapshots

Called by the scheduler cron job and can also be invoked manually.
"""

import logging
from datetime import date

from data.fetcher import get_quotes
from models.db import get_connection

log = logging.getLogger(__name__)


def record_portfolio_snapshot(portfolio_id: int) -> bool:
    """Record end-of-day P/L snapshot for a single portfolio.

    Steps:
    1. Load all positions from DB for this portfolio_id
    2. If no positions, return False (nothing to snapshot)
    3. Get ticker list and fetch live quotes via get_quotes()
    4. Enrich positions with last_price from quotes
    5. Compute total market_value = sum(qty * last_price) for positions with prices
    6. Compute total cost_basis = sum(qty * avg_price)
    7. Compute pnl = market_value - cost_basis
    8. Get today's date in ISO format (YYYY-MM-DD)
    9. INSERT OR REPLACE into portfolio_pnl_snapshots
    10. Log the snapshot creation
    11. Return True on success

    Parameters
    ----------
    portfolio_id : int
        The ID of the portfolio to snapshot.

    Returns
    -------
    bool
        True if snapshot was recorded successfully, False if the portfolio
        has no positions (nothing to snapshot).
    """
    with get_connection() as conn:
        # 1. Load all positions for this portfolio
        positions = [
            dict(row)
            for row in conn.execute(
                "SELECT * FROM positions WHERE portfolio_id = ?",
                (portfolio_id,),
            ).fetchall()
        ]

        # 2. No positions — nothing to snapshot
        if not positions:
            log.debug(
                "record_portfolio_snapshot: portfolio %d has no positions, skipping",
                portfolio_id,
            )
            return False

        # 3. Fetch live quotes for all tickers in this portfolio.
        # Bypass the 5-min cache: the 16:30 ET snapshot must reflect today's
        # close, not a pre-close cached bar.  get_quotes() backfills a NaN
        # settlement-window bar from dash_prices (see data/fetcher.py).
        tickers = [p["ticker"] for p in positions]
        quotes_map: dict[str, dict] = {}
        try:
            quotes_list = get_quotes(tickers, use_cache=False)
            quotes_map = {q["ticker"]: q for q in quotes_list}
        except Exception as e:
            log.warning(
                "record_portfolio_snapshot: quote fetch failed for portfolio %d: %s",
                portfolio_id,
                e,
            )

        # 4–7. Compute aggregate market_value and cost_basis
        total_cost_basis = 0.0
        total_market_value = 0.0
        priced_count = 0

        # Collect per-position data for snapshot recording
        position_data = []

        for pos in positions:
            cost_basis = pos["qty"] * pos["avg_price"]
            total_cost_basis += cost_basis

            quote = quotes_map.get(pos["ticker"])
            if quote and quote.get("price") is not None:
                market_value = pos["qty"] * quote["price"]
                total_market_value += market_value
                priced_count += 1
            else:
                market_value = cost_basis  # fallback if no price

            position_data.append({
                "ticker": pos["ticker"],
                "cost_basis": cost_basis,
                "market_value": market_value,
            })

        # Compute P/L
        # If all quotes failed, market_value stays 0 and pnl = -cost_basis
        pnl = total_market_value - total_cost_basis

        # If cost_basis is zero (e.g. gifted / fully-sold positions), pnl = 0
        if total_cost_basis == 0:
            pnl = 0.0

        # 8. Today's date in ISO format
        today = date.today().isoformat()

        # Record per-position snapshots
        for pd in position_data:
            pos_pnl = pd["market_value"] - pd["cost_basis"]
            if pd["cost_basis"] == 0:
                pos_pnl = 0.0
            conn.execute(
                """INSERT INTO position_pnl_snapshots
                       (portfolio_id, ticker, date, pnl, market_value, cost_basis)
                   VALUES (?, ?, ?, ?, ?, ?)
                   ON CONFLICT(portfolio_id, ticker, date) DO UPDATE SET
                       pnl = excluded.pnl,
                       market_value = excluded.market_value,
                       cost_basis = excluded.cost_basis""",
                (
                    portfolio_id,
                    pd["ticker"],
                    today,
                    round(pos_pnl, 2),
                    round(pd["market_value"], 2),
                    round(pd["cost_basis"], 2),
                ),
            )

        # 9. INSERT OR REPLACE (upsert) — update if snapshot already exists for today
        conn.execute(
            """INSERT INTO portfolio_pnl_snapshots
                   (portfolio_id, date, pnl, market_value, cost_basis)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(portfolio_id, date) DO UPDATE SET
                   pnl = excluded.pnl,
                   market_value = excluded.market_value,
                   cost_basis = excluded.cost_basis""",
            (
                portfolio_id,
                today,
                round(pnl, 2),
                round(total_market_value, 2),
                round(total_cost_basis, 2),
            ),
        )

    # 10. Log the snapshot creation
    log.info(
        "record_portfolio_snapshot: portfolio=%d date=%s pnl=%.2f "
        "market_value=%.2f cost_basis=%.2f positions=%d priced=%d",
        portfolio_id,
        today,
        pnl,
        total_market_value,
        total_cost_basis,
        len(positions),
        priced_count,
    )

    # 11. Success
    return True


def record_all_portfolios_snapshots() -> dict:
    """Record snapshots for ALL portfolios. Called by cron job.

    Steps:
    1. Query all portfolio IDs from DB
    2. For each portfolio, call record_portfolio_snapshot()
    3. Track successes and failures
    4. Return summary dict: { "success": N, "failed": N, "total": N }

    Returns
    -------
    dict
        Summary with keys: success (int), failed (int), total (int).
    """
    with get_connection() as conn:
        rows = conn.execute("SELECT id FROM portfolios ORDER BY id").fetchall()
        portfolio_ids = [row["id"] for row in rows]

    total = len(portfolio_ids)
    success = 0
    failed = 0

    for pid in portfolio_ids:
        try:
            recorded = record_portfolio_snapshot(pid)
            if recorded:
                success += 1
            else:
                # Portfolio has no positions — not a failure, count as handled
                success += 1
        except Exception as e:
            log.error(
                "record_all_portfolios_snapshots: failed for portfolio %d: %s",
                pid,
                e,
            )
            failed += 1

    summary = {"success": success, "failed": failed, "total": total}
    log.info("record_all_portfolios_snapshots: completed %s", summary)
    return summary
