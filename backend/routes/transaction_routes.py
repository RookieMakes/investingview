"""
transaction_routes.py — Transaction CRUD and P&L summary endpoints.

CRUD for portfolio transactions (trade log) and a realized P/L
summary endpoint using the Average Cost method.

NO-SYNC RULE (intentional, per user decision): editing or deleting a
transaction here does NOT update the positions table, and pencil-editing
a position does NOT create transactions.  Users clear stale data from
the UI via delete-position / delete-transaction.  Portfolio cycle
columns (services/cycle_stats.py) therefore clamp oversells and fall
back when history is missing instead of assuming the log matches
positions.  Do not add auto-sync without renegotiating this decision.
"""

import logging
import math
import re
from datetime import date

from flask import Blueprint, jsonify, request

from models.db import get_connection

log = logging.getLogger(__name__)

transaction_bp = Blueprint("transactions", __name__)

# ── Helpers ───────────────────────────────────────────────────────────────────

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _validate_date(date_str):
    """Return True if *date_str* is a valid YYYY-MM-DD string."""
    if not _DATE_RE.match(date_str):
        return False
    try:
        year, month, day = (int(x) for x in date_str.split("-"))
        return 1 <= month <= 12 and 1 <= day <= 31 and 1900 <= year <= 2100
    except (ValueError, TypeError):
        return False


def _enrich_transactions_with_metadata(conn, transactions):
    """Enrich transactions with company and sector from the universe table.

    Same pattern as ``_enrich_positions_with_metadata`` in portfolio_routes.
    """
    if not transactions:
        return

    tickers = list({t["ticker"] for t in transactions if t.get("ticker")})
    if not tickers:
        return

    placeholders = ",".join("?" * len(tickers))
    rows = conn.execute(
        f"SELECT ticker, company_name, sector FROM universe WHERE ticker IN ({placeholders})",
        tickers,
    ).fetchall()
    meta_map = {row["ticker"]: dict(row) for row in rows}

    for txn in transactions:
        meta = meta_map.get(txn["ticker"], {})
        txn["company"] = meta.get("company_name") or ""
        txn["sector"] = meta.get("sector") or ""


def _get_portfolio_or_404(conn, portfolio_id):
    """Return the portfolio row if it exists, otherwise None."""
    return conn.execute(
        "SELECT id FROM portfolios WHERE id = ?", (portfolio_id,)
    ).fetchone()


def _get_transaction_or_404(conn, portfolio_id, transaction_id):
    """Return the transaction row if it belongs to the portfolio, otherwise None."""
    return conn.execute(
        "SELECT * FROM transactions WHERE id = ? AND portfolio_id = ?",
        (transaction_id, portfolio_id),
    ).fetchone()


# ── Endpoints ─────────────────────────────────────────────────────────────────

_MAX_BY_TICKERS = 500  # Safety cap to prevent abuse


@transaction_bp.route("/api/transactions/by-tickers", methods=["GET"])
def transactions_by_tickers():
    """Return buy/sell transactions grouped by ticker across all portfolios.

    Query params:
        tickers (str): Comma-separated ticker symbols (e.g. "AAPL,MSFT,GOOGL").

    Returns:
        200: { "transactions": { "<TICKER>": [...] } }
        400: If tickers param is missing or empty.
    """
    tickers_raw = request.args.get("tickers", "").strip()
    if not tickers_raw:
        return jsonify({"transactions": {}})

    # Parse and deduplicate tickers, sanitise to uppercase alpha-only
    tickers = list({t.strip().upper() for t in tickers_raw.split(",") if t.strip()})
    if not tickers:
        return jsonify({"transactions": {}})

    # Cap tickers to prevent overly broad queries
    tickers = tickers[:50]

    placeholders = ",".join("?" for _ in tickers)

    with get_connection() as conn:
        rows = conn.execute(
            f"""
            SELECT ticker, type, date, price, qty
            FROM transactions
            WHERE ticker IN ({placeholders})
            ORDER BY ticker, date ASC, id ASC
            LIMIT ?
            """,
            (*tickers, _MAX_BY_TICKERS),
        ).fetchall()

    # Group by ticker
    grouped = {}
    for row in rows:
        ticker = row["ticker"]
        if ticker not in grouped:
            grouped[ticker] = []
        grouped[ticker].append({
            "type": row["type"],
            "date": row["date"],
            "price": round(row["price"], 2),
            "qty": round(row["qty"], 4),
        })

    log.info(
        "transactions.by_tickers tickers=%s total_rows=%d",
        tickers_raw, len(rows),
    )
    return jsonify({"transactions": grouped})


@transaction_bp.route("/api/portfolio/<int:portfolio_id>/transactions", methods=["GET"])
def list_transactions(portfolio_id):
    """List transactions for a portfolio, sorted by date descending.

    Query params:
        page (int, default 1)
        per_page (int, default 50, max 200)
    """
    page = max(1, request.args.get("page", 1, type=int))
    per_page = min(200, max(1, request.args.get("per_page", 50, type=int)))
    offset = (page - 1) * per_page

    with get_connection() as conn:
        portfolio = _get_portfolio_or_404(conn, portfolio_id)
        if not portfolio:
            return jsonify({"error": "Portfolio not found"}), 404

        total = conn.execute(
            "SELECT COUNT(*) FROM transactions WHERE portfolio_id = ?",
            (portfolio_id,),
        ).fetchone()[0]

        rows = conn.execute(
            "SELECT * FROM transactions WHERE portfolio_id = ? ORDER BY date DESC, id DESC LIMIT ? OFFSET ?",
            (portfolio_id, per_page, offset),
        ).fetchall()

        transactions = [dict(r) for r in rows]
        _enrich_transactions_with_metadata(conn, transactions)

    total_pages = math.ceil(total / per_page) if total > 0 else 1

    return jsonify({
        "transactions": transactions,
        "total": total,
        "page": page,
        "per_page": per_page,
        "total_pages": total_pages,
    })


@transaction_bp.route("/api/portfolio/<int:portfolio_id>/trading-activity", methods=["GET"])
def trading_activity(portfolio_id):
    """Distinct trading dates across the full ledger, independent of pagination."""
    year_arg = request.args.get("year")
    if year_arg is not None:
        try:
            year = int(year_arg)
        except ValueError:
            return jsonify({"error": "year must be an integer"}), 400
        if not 1900 <= year <= 2100:
            return jsonify({"error": "year must be between 1900 and 2100"}), 400

    with get_connection() as conn:
        if not _get_portfolio_or_404(conn, portfolio_id):
            return jsonify({"error": "Portfolio not found"}), 404
        rows = conn.execute(
            """SELECT date,
                      SUM(CASE WHEN type = 'BUY' THEN 1 ELSE 0 END) AS buys,
                      SUM(CASE WHEN type = 'SELL' THEN 1 ELSE 0 END) AS sells
               FROM transactions
               WHERE portfolio_id = ? AND type IN ('BUY', 'SELL')
               GROUP BY date ORDER BY date""",
            (portfolio_id,),
        ).fetchall()

    # Older manual/imported records may contain impossible dates. Never let them
    # inflate totals or roll over into a different calendar day in the browser.
    days = []
    for row in rows:
        try:
            parsed = date.fromisoformat(row["date"])
        except (ValueError, TypeError):
            continue
        if parsed.isoformat() == row["date"] and 1900 <= parsed.year <= 2100:
            days.append((parsed, row))

    current_year = date.today().year
    years = {day.year for day, _ in days if day.year <= current_year}
    min_year = min(years, default=current_year)
    if year_arg is None:
        year = current_year if current_year in years else max(years, default=current_year)

    monthly = [0] * 12
    activity = {}
    for day, row in days:
        if day.year == year:
            monthly[day.month - 1] += 1
            activity[day.isoformat()] = {"buys": row["buys"], "sells": row["sells"]}

    return jsonify({
        "year": year,
        "min_year": min_year,
        "max_year": current_year,
        "days": activity,
        "monthly_totals": monthly,
        "year_total": sum(monthly),
    })


@transaction_bp.route(
    "/api/portfolio/<int:portfolio_id>/transactions", methods=["POST"]
)
def create_transaction(portfolio_id):
    """Create a standalone transaction record.

    This is a manual fallback tool for correcting transaction records.
    It does NOT update positions — it only inserts a transaction row.

    Body: {
        "ticker": str,      # Required, non-empty, uppercase
        "type": str,        # Required, "BUY" or "SELL"
        "qty": number,      # Required, > 0
        "price": number,    # Required, > 0
        "date": str,        # Required, YYYY-MM-DD format
        "notes": str        # Optional, max 500 chars
    }

    Returns:
        201: The created transaction with enriched metadata.
        400: Validation error.
        404: Portfolio not found.
    """
    data = request.get_json()
    if not data:
        return jsonify({"error": "No data provided"}), 400

    # Validate required fields
    ticker = data.get("ticker", "")
    if not isinstance(ticker, str) or not ticker.strip():
        return jsonify({"error": "ticker is required and must be a non-empty string"}), 400
    ticker = ticker.strip().upper()

    txn_type = data.get("type", "")
    if txn_type not in ("BUY", "SELL"):
        return jsonify({"error": "type must be 'BUY' or 'SELL'"}), 400

    qty = data.get("qty")
    if not isinstance(qty, (int, float)) or qty <= 0:
        return jsonify({"error": "qty must be a positive number"}), 400

    price = data.get("price")
    if not isinstance(price, (int, float)) or price <= 0:
        return jsonify({"error": "price must be a positive number"}), 400

    date_str = data.get("date", "")
    if not isinstance(date_str, str) or not _validate_date(date_str):
        return jsonify({"error": "Invalid date format. Use YYYY-MM-DD"}), 400

    notes = data.get("notes", "") or ""
    if len(notes) > 500:
        return jsonify({"error": "notes must be 500 characters or fewer"}), 400

    total = qty * price

    with get_connection() as conn:
        portfolio = _get_portfolio_or_404(conn, portfolio_id)
        if not portfolio:
            return jsonify({"error": "Portfolio not found"}), 404

        cursor = conn.execute(
            """INSERT INTO transactions
                (portfolio_id, ticker, type, qty, price, total, date, notes)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (portfolio_id, ticker, txn_type, qty, price, total, date_str, notes),
        )
        new_id = cursor.lastrowid

        created = dict(
            conn.execute(
                "SELECT * FROM transactions WHERE id = ?", (new_id,)
            ).fetchone()
        )
        _enrich_transactions_with_metadata(conn, [created])

    log.info(
        "transaction.create portfolio=%d id=%d ticker=%s type=%s qty=%.4f price=%.2f",
        portfolio_id, new_id, ticker, txn_type, qty, price,
    )
    return jsonify(created), 201


@transaction_bp.route("/api/portfolio/<int:portfolio_id>/realized-trades", methods=["GET"])
def list_realized_trades(portfolio_id):
    """Saved Portfolio sale snapshots, independent of subsequent ledger edits.

    Best/worst cover the entire portfolio, not just the requested page.
    Historical/manual ledger sales are deliberately not synthesized here.
    """
    page = max(1, request.args.get("page", 1, type=int))
    per_page = min(200, max(1, request.args.get("per_page", 10, type=int)))
    order = {
        "date": "sell_date DESC, id DESC",
        "pnl_desc": "realized_pnl DESC, sell_date DESC, id DESC",
        "pnl_asc": "realized_pnl ASC, sell_date DESC, id DESC",
    }.get(request.args.get("sort", "date"), "sell_date DESC, id DESC")
    sort_columns = {
        "sell_date": "sell_date", "ticker": "ticker COLLATE NOCASE",
        "company": "COALESCE((SELECT company_name FROM universe WHERE universe.ticker = realized_trades.ticker), '') COLLATE NOCASE",
        "qty_sold": "qty_sold", "avg_buy_price": "avg_buy_price",
        "sell_price": "sell_price", "realized_pnl": "realized_pnl",
        "realized_pnl_pct": "realized_pnl_pct",
    }
    column, _, direction = request.args.get("sort", "").rpartition(":")
    if column in sort_columns and direction in ("asc", "desc"):
        order = f"{sort_columns[column]} {direction.upper()}, id DESC"
    with get_connection() as conn:
        if not _get_portfolio_or_404(conn, portfolio_id):
            return jsonify({"error": "Portfolio not found"}), 404
        total = conn.execute(
            "SELECT COUNT(*) FROM realized_trades WHERE portfolio_id = ?",
            (portfolio_id,),
        ).fetchone()[0]
        total_pages = max(1, math.ceil(total / per_page))
        page = min(page, total_pages)
        trades = [dict(row) for row in conn.execute(
            f"""SELECT * FROM realized_trades WHERE portfolio_id = ?
               ORDER BY {order} LIMIT ? OFFSET ?""",
            (portfolio_id, per_page, (page - 1) * per_page),
        ).fetchall()]
        extremes = {}
        for name, direction in (("best_trade", "DESC"), ("worst_trade", "ASC")):
            row = conn.execute(
                f"""SELECT * FROM realized_trades WHERE portfolio_id = ?
                    ORDER BY realized_pnl {direction}, sell_date DESC, id DESC LIMIT 1""",
                (portfolio_id,),
            ).fetchone()
            extremes[name] = dict(row) if row else None
        _enrich_transactions_with_metadata(
            conn, trades + [item for item in extremes.values() if item is not None],
        )
    return jsonify({
        "trades": trades, "total": total, "page": page,
        "per_page": per_page, "total_pages": total_pages, **extremes,
    })


@transaction_bp.route("/api/portfolio/<int:portfolio_id>/profit-summary", methods=["GET"])
def profit_summary(portfolio_id):
    """Realized P/L summary per ticker using the Average Cost method.

    Only includes tickers that have at least one SELL transaction.
    """
    with get_connection() as conn:
        portfolio = _get_portfolio_or_404(conn, portfolio_id)
        if not portfolio:
            return jsonify({"error": "Portfolio not found"}), 404

        # Aggregate buy/sell stats per ticker
        rows = conn.execute(
            """
            SELECT
                ticker,
                SUM(CASE WHEN type = 'BUY' THEN total ELSE 0 END)  AS total_bought,
                SUM(CASE WHEN type = 'SELL' THEN total ELSE 0 END) AS total_sold,
                SUM(CASE WHEN type = 'BUY' THEN qty ELSE 0 END)    AS qty_bought,
                SUM(CASE WHEN type = 'SELL' THEN qty ELSE 0 END)   AS qty_sold,
                COUNT(*)                                           AS trade_count
            FROM transactions
            WHERE portfolio_id = ?
            GROUP BY ticker
            HAVING SUM(CASE WHEN type = 'SELL' THEN 1 ELSE 0 END) > 0
            ORDER BY ticker
            """,
            (portfolio_id,),
        ).fetchall()

        summary = []
        total_realized_pnl = 0.0
        total_cost_basis = 0.0
        total_trades = 0
        profitable_tickers = 0
        total_tickers_traded = len(rows)

        for row in rows:
            ticker = row["ticker"]
            total_bought = round(row["total_bought"], 2)
            total_sold = round(row["total_sold"], 2)
            qty_bought = row["qty_bought"]
            qty_sold = row["qty_sold"]
            trade_count = row["trade_count"]

            avg_buy_price = round(total_bought / qty_bought, 2) if qty_bought else 0.0
            avg_sell_price = round(total_sold / qty_sold, 2) if qty_sold else 0.0

            cost_basis_of_sold = round(qty_sold * avg_buy_price, 2)
            realized_pnl = round(total_sold - cost_basis_of_sold, 2)
            realized_pnl_pct = (
                round((realized_pnl / cost_basis_of_sold) * 100, 2)
                if cost_basis_of_sold
                else 0.0
            )

            total_realized_pnl += realized_pnl
            total_cost_basis += cost_basis_of_sold
            total_trades += trade_count
            if realized_pnl > 0:
                profitable_tickers += 1

            summary.append({
                "ticker": ticker,
                "company": "",
                "sector": "",
                "total_bought": total_bought,
                "total_sold": total_sold,
                "qty_bought": qty_bought,
                "qty_sold": qty_sold,
                "avg_buy_price": avg_buy_price,
                "avg_sell_price": avg_sell_price,
                "realized_pnl": realized_pnl,
                "realized_pnl_pct": realized_pnl_pct,
                "trade_count": trade_count,
            })

        # Enrich company/sector metadata
        _enrich_transactions_with_metadata(conn, summary)

    return jsonify({
        "summary": summary,
        "total_realized_pnl": round(total_realized_pnl, 2),
        "total_cost_basis": round(total_cost_basis, 2),
        "avg_return_pct": round((total_realized_pnl / total_cost_basis) * 100, 2) if total_cost_basis else 0.0,
        "total_trades": total_trades,
        "profitable_tickers": profitable_tickers,
        "total_tickers_traded": total_tickers_traded,
    })


@transaction_bp.route(
    "/api/portfolio/<int:portfolio_id>/transactions/<int:transaction_id>",
    methods=["PUT"],
)
def update_transaction(portfolio_id, transaction_id):
    """Edit a transaction's date, notes, qty, and/or price.

    Body: { "date"?: str, "notes"?: str, "qty"?: number, "price"?: number }

    Rules:
        - ``date``, ``notes``, ``qty``, ``price`` are all optional.
        - Date must be YYYY-MM-DD format.
        - Notes max 500 characters.
        - qty must be > 0 if provided.
        - price must be > 0 if provided.
        - When qty or price changes, total is recalculated as qty * price.
          If only one is provided, the other is taken from the existing record.
    """
    data = request.get_json()
    if not data:
        return jsonify({"error": "No data provided"}), 400

    with get_connection() as conn:
        existing = _get_transaction_or_404(conn, portfolio_id, transaction_id)
        if not existing:
            return jsonify({"error": "Transaction not found"}), 404

        updates = {}

        if "date" in data:
            date_str = data["date"]
            if not isinstance(date_str, str) or not _validate_date(date_str):
                return jsonify({"error": "Invalid date format. Use YYYY-MM-DD"}), 400
            updates["date"] = date_str

        if "notes" in data:
            notes = data["notes"] or ""
            if len(notes) > 500:
                return jsonify({"error": "notes must be 500 characters or fewer"}), 400
            updates["notes"] = notes

        if "qty" in data:
            qty = data["qty"]
            if not isinstance(qty, (int, float)) or qty <= 0:
                return jsonify({"error": "qty must be a positive number"}), 400
            updates["qty"] = qty

        if "price" in data:
            price = data["price"]
            if not isinstance(price, (int, float)) or price <= 0:
                return jsonify({"error": "price must be a positive number"}), 400
            updates["price"] = price

        # Recalculate total if qty or price changed
        if "qty" in updates or "price" in updates:
            final_qty = updates.get("qty", existing["qty"])
            final_price = updates.get("price", existing["price"])
            updates["total"] = final_qty * final_price

        if not updates:
            return jsonify(dict(existing))

        fields = ", ".join(f"{k} = ?" for k in updates)
        conn.execute(
            f"UPDATE transactions SET {fields}, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (*updates.values(), transaction_id),
        )

        updated = dict(
            conn.execute(
                "SELECT * FROM transactions WHERE id = ?", (transaction_id,)
            ).fetchone()
        )
        _enrich_transactions_with_metadata(conn, [updated])

    log.info(
        "transaction.update portfolio=%d id=%d fields=%s",
        portfolio_id, transaction_id, list(updates.keys()),
    )
    return jsonify(updated)


@transaction_bp.route(
    "/api/portfolio/<int:portfolio_id>/transactions/<int:transaction_id>",
    methods=["DELETE"],
)
def delete_transaction(portfolio_id, transaction_id):
    """Delete a transaction record.

    Returns 404 if the transaction doesn't exist or doesn't belong
    to the portfolio.
    """
    with get_connection() as conn:
        existing = _get_transaction_or_404(conn, portfolio_id, transaction_id)
        if not existing:
            return jsonify({"error": "Transaction not found"}), 404

        conn.execute("DELETE FROM transactions WHERE id = ?", (transaction_id,))

    log.info(
        "transaction.delete portfolio=%d id=%d ticker=%s",
        portfolio_id, transaction_id, existing["ticker"],
    )
    return jsonify({"status": "deleted", "id": transaction_id})
