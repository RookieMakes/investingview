"""
portfolio_routes.py — Portfolio API endpoints.

CRUD for portfolios and positions, P&L computation, and position
moves between portfolios.

Extracted from reference/portfolio-dashboard/main.py and adapted
to the InvestingView Flask architecture.
"""

import logging
import re
from datetime import date
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP

import yfinance as yf
from flask import Blueprint, jsonify, request

from models.db import get_connection
from services.cycle_stats import compute_cycle

log = logging.getLogger(__name__)

portfolio_bp = Blueprint("portfolio", __name__)
MAX_CASH_CENTS = 9_000_000_000_000_000  # Safely representable in the browser.


# ── Helpers ───────────────────────────────────────────────────────────────────


def _trade_date(data):
    """Use today's date for legacy callers; validate an explicitly supplied date."""
    value = data.get("date", date.today().isoformat())
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        return None
    try:
        parsed = date.fromisoformat(value)
    except ValueError:
        return None
    return value if 1900 <= parsed.year <= 2100 else None


def _trade_value_cents(qty, price):
    """Round each trade's proceeds to cents before applying it to cash."""
    try:
        quantity, unit_price = Decimal(str(qty)), Decimal(str(price))
        if not quantity.is_finite() or not unit_price.is_finite() or quantity <= 0 or unit_price <= 0:
            return None
        amount = quantity * unit_price * 100
        cents = int(amount.quantize(Decimal("1"), rounding=ROUND_HALF_UP))
        return cents if 0 <= cents <= MAX_CASH_CENTS else None
    except (InvalidOperation, ValueError, OverflowError):
        return None


def _compute_pnl_fields(position):
    """Compute cost_basis, market_value, pnl_dollar, pnl_pct for a position.

    Uses ``last_price`` (from a live quote) as the current price.
    If ``last_price`` is missing, returns None for market-value fields
    so the frontend can display "N/A" instead of misleading cost-basis numbers.
    """
    cost_basis = round(position["qty"] * position["avg_price"], 2)
    current_price = position.get("last_price")
    if current_price is None:
        return {
            "cost_basis": cost_basis,
            "market_value": None,
            "pnl_dollar": None,
            "pnl_pct": None,
            "current_price": None,
        }
    market_value = round(position["qty"] * current_price, 2)
    pnl_dollar = round(market_value - cost_basis, 2)
    pnl_pct = (
        round((current_price - position["avg_price"]) / position["avg_price"] * 100, 2)
        if position["avg_price"]
        else 0.0
    )
    return {
        "cost_basis": cost_basis,
        "market_value": market_value,
        "pnl_dollar": pnl_dollar,
        "pnl_pct": pnl_pct,
        "current_price": current_price,
    }


def _enrich_positions_with_metadata(conn, positions):
    """Enrich positions with sector and company_name from the universe table.

    The ``positions`` table does not store sector or company metadata.  This
    helper looks up each position's ticker in the ``universe`` table and
    adds ``sector`` and ``company`` fields so the frontend can render the
    sector allocation panel correctly.

    If a ticker is not found in the universe (e.g. a custom stock not yet
    added), the fields default to empty strings — the frontend handles
    these gracefully.
    """
    if not positions:
        return

    tickers = list({p["ticker"] for p in positions if p.get("ticker")})
    if not tickers:
        return

    placeholders = ",".join("?" * len(tickers))
    rows = conn.execute(
        f"SELECT ticker, company_name, sector FROM universe WHERE ticker IN ({placeholders})",
        tickers,
    ).fetchall()
    meta_map = {row["ticker"]: dict(row) for row in rows}

    for pos in positions:
        meta = meta_map.get(pos["ticker"], {})
        pos["company"] = meta.get("company_name") or ""
        pos["sector"] = meta.get("sector") or ""


def _fetch_cycle_map(conn, portfolio_id):
    """Fetch all transactions for a portfolio, grouped by ticker.

    Single SELECT ordered by (ticker, date ASC, id ASC) — grouped in
    Python to avoid N+1 queries.  Returns {ticker: [txn_dict, ...]}.
    On DB error returns an empty map and logs a warning so the portfolio
    response still succeeds with zero-history fallbacks.
    """
    try:
        rows = conn.execute(
            """SELECT ticker, type, qty, price, total, date, id
               FROM transactions WHERE portfolio_id = ?
               ORDER BY ticker, date ASC, id ASC""",
            (portfolio_id,),
        ).fetchall()
    except Exception as e:
        log.warning(
            "_fetch_cycle_map: failed to fetch transactions for portfolio %d: %s",
            portfolio_id,
            e,
        )
        return {}
    cycle_map = {}
    for r in rows:
        d = dict(r)
        cycle_map.setdefault(d.get("ticker"), []).append(d)
    return cycle_map


def _enrich_position_with_cycle(pos, txns):
    """Merge current-cycle stats into a position dict in place.

    Uses ``compute_cycle`` when transaction history exists; otherwise
    applies the zero-history fallback (unrecovered=total_investment,
    realized=0, breakeven=avg_price, has_cycle_history=False) so
    pencil-created or legacy holdings still show sensible columns.
    Never raises — on unexpected error logs and falls back.
    """
    try:
        qty_rem = float(pos.get("qty") or 0)
    except (TypeError, ValueError):
        qty_rem = 0.0

    if not txns:
        try:
            total_inv = float(pos.get("total_investment") or 0)
        except (TypeError, ValueError):
            total_inv = 0.0
        try:
            avg = float(pos.get("avg_price") or 0)
        except (TypeError, ValueError):
            avg = 0.0
        pos["unrecovered_capital"] = round(total_inv, 2)
        pos["realized_pnl_cycle"] = 0.0
        pos["breakeven_price"] = round(avg, 2) if avg > 0 else None
        pos["breakeven_raw"] = round(avg, 2) if avg > 0 else None
        pos["cash_recovered"] = 0.0
        pos["remaining_basis"] = round(total_inv, 2)
        pos["total_return_cycle"] = 0.0
        pos["has_cycle_history"] = False
        return

    try:
        stats = compute_cycle(qty_rem, txns)
    except Exception as e:
        log.warning(
            "_enrich_position_with_cycle: compute_cycle failed for %s: %s",
            pos.get("ticker"),
            e,
        )
        pos["unrecovered_capital"] = 0.0
        pos["realized_pnl_cycle"] = 0.0
        pos["breakeven_price"] = None
        pos["breakeven_raw"] = None
        pos["cash_recovered"] = 0.0
        pos["remaining_basis"] = 0.0
        pos["total_return_cycle"] = 0.0
        pos["has_cycle_history"] = False
        return
    pos.update(stats)


def _build_portfolio_summary(conn, portfolio_id):
    """Build a full portfolio dict with positions, P&L, and totals.

    Enriches each position with live market prices fetched via
    ``get_quotes`` so P&L reflects current market values.

    Returns None if the portfolio does not exist.
    """
    pf = conn.execute(
        "SELECT * FROM portfolios WHERE id = ?", (portfolio_id,)
    ).fetchone()
    if not pf:
        return None

    pf_dict = dict(pf)
    positions = [
        dict(r)
        for r in conn.execute(
            "SELECT * FROM positions WHERE portfolio_id = ?", (portfolio_id,)
        ).fetchall()
    ]

    # ── Live-price enrichment ──────────────────────────────────────
    # Fetch current market prices and daily change for each position.
    positions_without_price = 0
    if positions:
        from data.fetcher import get_quotes

        tickers = [p["ticker"] for p in positions]
        try:
            quotes_list = get_quotes(tickers)
            quotes_map = {q["ticker"]: q for q in quotes_list}
            for pos in positions:
                quote = quotes_map.get(pos["ticker"])
                if quote and quote.get("price") is not None:
                    pos["last_price"] = quote["price"]
                    pos["change_pct"] = quote.get("change_pct")
                else:
                    positions_without_price += 1
        except Exception as e:
            positions_without_price = len(positions)
            log.warning(
                "_build_portfolio_summary: failed to fetch live quotes for portfolio %d: %s",
                portfolio_id,
                e,
            )

    # ── Sector / company enrichment ────────────────────────────────────
    _enrich_positions_with_metadata(conn, positions)

    # ── Cycle stats (single query, grouped in Python — no N+1) ─────────
    # Lifetime profit-summary is untouched; these are per-position
    # current-cycle columns derived from the transaction log.
    cycle_map = _fetch_cycle_map(conn, portfolio_id)

    for pos in positions:
        pos.update(_compute_pnl_fields(pos))

    for pos in positions:
        _enrich_position_with_cycle(pos, cycle_map.get(pos.get("ticker"), []))

    pf_dict["positions"] = positions
    pf_dict["total_cost_basis"] = round(sum(pos["cost_basis"] for pos in positions), 2)

    # Sum market_value, skipping positions with None (no live price)
    market_values = [pos["market_value"] for pos in positions if pos["market_value"] is not None]
    pf_dict["total_market_value"] = round(sum(market_values), 2) if market_values else None

    if pf_dict["total_market_value"] is not None and pf_dict["total_cost_basis"]:
        pf_dict["total_pnl_dollar"] = round(
            pf_dict["total_market_value"] - pf_dict["total_cost_basis"], 2
        )
        pf_dict["total_pnl_pct"] = round(
            pf_dict["total_pnl_dollar"] / pf_dict["total_cost_basis"] * 100, 2
        )
    else:
        pf_dict["total_pnl_dollar"] = None
        pf_dict["total_pnl_pct"] = None

    pf_dict["position_count"] = len(positions)
    pf_dict["positions_without_price"] = positions_without_price
    return pf_dict


# ── Portfolio Routes ─────────────────────────────────────────────────────────


@portfolio_bp.route("/api/portfolio", methods=["GET"])
def list_portfolios():
    """List all portfolios with position counts and summary P&L.

    Ordered by user-defined sort_order (Transaction screen consumes the
    same order). Transaction/position rows are unaffected — they are
    keyed by portfolio_id and keep their own date/ticker ordering.
    """
    with get_connection() as conn:
        portfolios = conn.execute(
            "SELECT * FROM portfolios ORDER BY sort_order, id"
        ).fetchall()
        result = []
        for p in portfolios:
            pf = _build_portfolio_summary(conn, p["id"])
            if pf:
                result.append(pf)
    return jsonify(result)


@portfolio_bp.route("/api/portfolio", methods=["POST"])
def create_portfolio():
    """Create a new portfolio.

    Body: { "name": str, "currency"?: str }   currency defaults to "USD".
    """
    data = request.get_json()
    if not data or not data.get("name"):
        return jsonify({"error": "Name is required"}), 400

    name = data["name"].strip()
    if not name:
        return jsonify({"error": "Name cannot be empty"}), 400

    currency = data.get("currency", "USD").upper()
    if currency not in ("USD", "CAD"):
        return jsonify({"error": "currency must be USD or CAD"}), 400

    with get_connection() as conn:
        existing = conn.execute(
            "SELECT id FROM portfolios WHERE name = ?", (name,)
        ).fetchone()
        if existing:
            return jsonify({"error": f"Portfolio '{name}' already exists"}), 409

        cursor = conn.execute(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM portfolios"
        ).fetchone()
        next_order = cursor[0] if cursor else 0

        cursor = conn.execute(
            "INSERT INTO portfolios (name, currency, sort_order) VALUES (?, ?, ?)",
            (name, currency, next_order),
        )
        portfolio_id = cursor.lastrowid
        portfolio = dict(
            conn.execute("SELECT * FROM portfolios WHERE id = ?", (portfolio_id,)).fetchone()
        )

    log.info("portfolio.create name=%s id=%d", name, portfolio_id)
    return jsonify(portfolio), 201


@portfolio_bp.route("/api/portfolio/order", methods=["PUT"])
def reorder_portfolios():
    """Persist a user-defined portfolio display order.

    Body: { "ordered_ids": [int, ...] } — full ordered list of
    existing portfolio ids, first = leftmost tab / top of dropdown.

    Only updates portfolios.sort_order. Transactions and positions
    reference portfolio_id and are untouched.
    """
    data = request.get_json(silent=True)
    if not data or not isinstance(data.get("ordered_ids"), list):
        return jsonify({"error": "ordered_ids (array of portfolio ids) is required"}), 400

    ordered_ids = data["ordered_ids"]
    if not ordered_ids or any(not isinstance(i, int) for i in ordered_ids):
        return jsonify({"error": "ordered_ids must be a non-empty array of integers"}), 400
    if len(set(ordered_ids)) != len(ordered_ids):
        return jsonify({"error": "ordered_ids contains duplicates"}), 400

    with get_connection() as conn:
        existing_ids = {r["id"] for r in conn.execute("SELECT id FROM portfolios").fetchall()}
        if set(ordered_ids) != existing_ids:
            return jsonify({"error": "ordered_ids must contain exactly all existing portfolio ids"}), 400
        for position, pid in enumerate(ordered_ids):
            conn.execute("UPDATE portfolios SET sort_order = ? WHERE id = ?", (position, pid))

    log.info("portfolio.reorder ids=%s", ordered_ids)
    return jsonify({"status": "ok", "ordered_ids": ordered_ids})


@portfolio_bp.route("/api/portfolio/<int:portfolio_id>", methods=["GET"])
def get_portfolio(portfolio_id):
    """Get a single portfolio with its positions and P&L summary."""
    with get_connection() as conn:
        pf = _build_portfolio_summary(conn, portfolio_id)
    if not pf:
        return jsonify({"error": "Portfolio not found"}), 404
    return jsonify(pf)


@portfolio_bp.route("/api/portfolio/<int:portfolio_id>", methods=["PUT"])
def update_portfolio(portfolio_id):
    """Update a portfolio name and/or currency.

    Body: { "name"?: str, "currency"?: str }
    """
    data = request.get_json()
    if not data:
        return jsonify({"error": "No data provided"}), 400

    with get_connection() as conn:
        existing = conn.execute(
            "SELECT * FROM portfolios WHERE id = ?", (portfolio_id,)
        ).fetchone()
        if not existing:
            return jsonify({"error": "Portfolio not found"}), 404

        updates = {}
        if "name" in data:
            name = data["name"].strip()
            if not name:
                return jsonify({"error": "Name cannot be empty"}), 400
            # Check for duplicate name (excluding self)
            dup = conn.execute(
                "SELECT id FROM portfolios WHERE name = ? AND id != ?",
                (name, portfolio_id),
            ).fetchone()
            if dup:
                return jsonify({"error": f"Portfolio '{name}' already exists"}), 409
            updates["name"] = name

        if "currency" in data:
            currency = data["currency"].upper()
            if currency not in ("USD", "CAD"):
                return jsonify({"error": "currency must be USD or CAD"}), 400
            updates["currency"] = currency

        if updates:
            fields = ", ".join(f"{k} = ?" for k in updates)
            conn.execute(
                f"UPDATE portfolios SET {fields} WHERE id = ?",
                (*updates.values(), portfolio_id),
            )

        portfolio = dict(
            conn.execute("SELECT * FROM portfolios WHERE id = ?", (portfolio_id,)).fetchone()
        )

    log.info("portfolio.update id=%d fields=%s", portfolio_id, list(updates.keys()))
    return jsonify(portfolio)


@portfolio_bp.route("/api/portfolio/<int:portfolio_id>/cash", methods=["GET", "PUT"])
def portfolio_cash(portfolio_id):
    """Read or set this portfolio's current cash balance (in cents)."""
    if request.method == "PUT":
        data = request.get_json(silent=True) or {}
        cash_cents = data.get("cash_cents")
        if type(cash_cents) is not int or not 0 <= cash_cents <= MAX_CASH_CENTS:
            return jsonify({"error": "cash_cents must be a non-negative integer"}), 400

    with get_connection() as conn:
        portfolio = conn.execute(
            "SELECT cash_cents FROM portfolios WHERE id = ?", (portfolio_id,)
        ).fetchone()
        if not portfolio:
            return jsonify({"error": "Portfolio not found"}), 404
        if request.method == "PUT":
            conn.execute(
                "UPDATE portfolios SET cash_cents = ? WHERE id = ?", (cash_cents, portfolio_id)
            )
            return jsonify({"cash_cents": cash_cents})
        return jsonify({"cash_cents": portfolio["cash_cents"]})


@portfolio_bp.route("/api/portfolio/<int:portfolio_id>", methods=["DELETE"])
def delete_portfolio(portfolio_id):
    """Delete a portfolio and all its positions (cascade)."""
    with get_connection() as conn:
        existing = conn.execute(
            "SELECT id, name FROM portfolios WHERE id = ?", (portfolio_id,)
        ).fetchone()
        if not existing:
            return jsonify({"error": "Portfolio not found"}), 404

        position_count = conn.execute(
            "SELECT COUNT(*) FROM positions WHERE portfolio_id = ?", (portfolio_id,)
        ).fetchone()[0]
        conn.execute("DELETE FROM positions WHERE portfolio_id = ?", (portfolio_id,))
        conn.execute("DELETE FROM portfolios WHERE id = ?", (portfolio_id,))

    log.info(
        "portfolio.delete id=%d name=%s positions=%d",
        portfolio_id, existing["name"], position_count,
    )
    return jsonify({"status": "deleted", "id": portfolio_id})


# ── P/L History ─────────────────────────────────────────────────────────────


@portfolio_bp.route("/api/portfolio/<int:portfolio_id>/pnl-history", methods=["GET"])
def get_pnl_history(portfolio_id):
    """Get daily unrealized P/L history for a portfolio.

    Returns snapshots ordered by date ascending.  Each snapshot includes
    the date, P/L in dollars, and P/L as a percentage of cost basis.
    """
    with get_connection() as conn:
        # Validate portfolio exists and get currency
        portfolio = conn.execute(
            "SELECT id, currency FROM portfolios WHERE id = ?", (portfolio_id,)
        ).fetchone()
        if not portfolio:
            return jsonify({"error": "Portfolio not found"}), 404

        currency = portfolio["currency"]

        # Query snapshots ordered by date ascending
        rows = conn.execute(
            """SELECT date, pnl, cost_basis
               FROM portfolio_pnl_snapshots
               WHERE portfolio_id = ?
               ORDER BY date ASC""",
            (portfolio_id,),
        ).fetchall()

        # Build snapshots array
        snapshots = []
        for row in rows:
            pnl = row["pnl"]
            cost_basis = row["cost_basis"]
            # Compute percentage, guard against zero division
            pct = round((pnl / cost_basis) * 100, 2) if cost_basis > 0 else 0.0
            snapshots.append({
                "date": row["date"],
                "pnl": round(pnl, 2),
                "pct": pct,
            })

    log.info("portfolio.pnl_history id=%d snapshots=%d", portfolio_id, len(snapshots))
    return jsonify({
        "portfolio_id": portfolio_id,
        "currency": currency,
        "snapshots": snapshots,
    })


@portfolio_bp.route("/api/portfolio/<int:portfolio_id>/position-pnl-history/<ticker>", methods=["GET"])
def get_position_pnl_history(portfolio_id, ticker):
    """Get daily unrealized P/L history for a single position.

    Returns snapshots ordered by date ascending. Each snapshot includes
    the date, P/L in dollars, and P/L as a percentage of cost basis.
    """
    with get_connection() as conn:
        portfolio = conn.execute(
            "SELECT id FROM portfolios WHERE id = ?", (portfolio_id,)
        ).fetchone()
        if not portfolio:
            return jsonify({"error": "Portfolio not found"}), 404

        rows = conn.execute(
            """SELECT date, pnl, cost_basis
               FROM position_pnl_snapshots
               WHERE portfolio_id = ? AND ticker = ?
               ORDER BY date ASC""",
            (portfolio_id, ticker),
        ).fetchall()

        snapshots = []
        for row in rows:
            pnl = row["pnl"]
            cost_basis = row["cost_basis"]
            pct = round((pnl / cost_basis) * 100, 2) if cost_basis > 0 else 0.0
            snapshots.append({
                "date": row["date"],
                "pnl": round(pnl, 2),
                "pct": pct,
            })

    log.info("portfolio.position_pnl_history id=%d ticker=%s snapshots=%d", portfolio_id, ticker, len(snapshots))
    return jsonify({
        "portfolio_id": portfolio_id,
        "ticker": ticker,
        "snapshots": snapshots,
    })


# ── Position Routes ──────────────────────────────────────────────────────────


@portfolio_bp.route("/api/portfolio/<int:portfolio_id>/positions", methods=["GET"])
def list_positions(portfolio_id):
    """List all positions in a portfolio with P&L fields computed.

    Enriches each position with live market prices and daily change
    fetched via ``get_quotes``.
    """
    with get_connection() as conn:
        portfolio = conn.execute(
            "SELECT id FROM portfolios WHERE id = ?", (portfolio_id,)
        ).fetchone()
        if not portfolio:
            return jsonify({"error": "Portfolio not found"}), 404

        positions = [
            dict(r)
            for r in conn.execute(
                "SELECT * FROM positions WHERE portfolio_id = ? ORDER BY ticker",
                (portfolio_id,),
            ).fetchall()
        ]

        # ── Sector / company enrichment from universe table ────────────
        _enrich_positions_with_metadata(conn, positions)

        # ── Cycle stats: one SELECT, group in Python (no N+1) ──────────
        # Fetched inside the connection block; applied after P&L below.
        cycle_map = _fetch_cycle_map(conn, portfolio_id)

    # ── Live-price enrichment ──────────────────────────────────────────
    if positions:
        from data.fetcher import get_quotes

        tickers = [p["ticker"] for p in positions]
        try:
            quotes_list = get_quotes(tickers)
            quotes_map = {q["ticker"]: q for q in quotes_list}
            for pos in positions:
                quote = quotes_map.get(pos["ticker"])
                if quote and quote.get("price") is not None:
                    pos["last_price"] = quote["price"]
                    pos["change_pct"] = quote.get("change_pct")
        except Exception as e:
            log.warning(
                "list_positions: failed to fetch live quotes for portfolio %d: %s",
                portfolio_id,
                e,
            )

    # ── Compute P&L + cycle fields ─────────────────────────────────────
    result = []
    for pos in positions:
        pos.update(_compute_pnl_fields(pos))
        _enrich_position_with_cycle(pos, cycle_map.get(pos.get("ticker"), []))
        result.append(pos)

    return jsonify(result)


@portfolio_bp.route("/api/portfolio/<int:portfolio_id>/positions", methods=["POST"])
def add_position(portfolio_id):
    """Add a position to a portfolio.

    Body: { "ticker": str, "qty": float, "price": float, "notes"?: str }
    """
    data = request.get_json()
    # Accept "price" (frontend field name) or "avg_price" (legacy field name)
    avg_price = data.get("avg_price") if data else None
    if avg_price is None and data:
        avg_price = data.get("price")
    if not data or not data.get("ticker") or data.get("qty") is None or avg_price is None:
        return jsonify({"error": "ticker, qty, and price are required"}), 400

    qty = data["qty"]
    if qty <= 0 or avg_price <= 0:
        return jsonify({"error": "qty and price must be positive"}), 400

    ticker = data["ticker"].upper().strip()
    if not ticker:
        return jsonify({"error": "ticker cannot be empty"}), 400
    if len(ticker) > 10:
        return jsonify({"error": "ticker must be 10 characters or fewer"}), 400

    notes = data.get("notes", "") or ""

    with get_connection() as conn:
        portfolio = conn.execute(
            "SELECT id FROM portfolios WHERE id = ?", (portfolio_id,)
        ).fetchone()
        if not portfolio:
            return jsonify({"error": "Portfolio not found"}), 404

        # Check for duplicate ticker in same portfolio
        existing = conn.execute(
            "SELECT id FROM positions WHERE portfolio_id = ? AND ticker = ?",
            (portfolio_id, ticker),
        ).fetchone()
        if existing:
            return jsonify({"error": f"Position for {ticker} already exists in this portfolio. Use PUT to update."}), 409

        cursor = conn.execute(
            """INSERT INTO positions (portfolio_id, ticker, qty, avg_price, total_investment, notes)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (portfolio_id, ticker, qty, avg_price, qty * avg_price, notes),
        )
        position_id = cursor.lastrowid
        position = dict(
            conn.execute("SELECT * FROM positions WHERE id = ?", (position_id,)).fetchone()
        )
        position.update(_compute_pnl_fields(position))

    log.info("position.add portfolio=%d ticker=%s qty=%.4f avg=%.2f", portfolio_id, ticker, qty, avg_price)
    return jsonify(position), 201


@portfolio_bp.route(
    "/api/portfolio/<int:portfolio_id>/positions/<int:position_id>",
    methods=["PUT"],
)
def update_position(portfolio_id, position_id):
    """Update a position (partial update).

    Body: { "qty"?: float, "avg_price"?: float, "notes"?: str }

    NOTE (no-sync rule, intentional): pencil edits here do NOT create or
    update transaction rows.  Positions and the transaction log can
    therefore desync (e.g. qty edited without a matching BUY/SELL).
    Cycle columns in list/summary views clamp defensively and the
    zero-history fallback covers holdings with no log.  Users clear
    stale data from the UI via delete-position / delete-transaction.
    """
    data = request.get_json()
    if not data:
        return jsonify({"error": "No data provided"}), 400

    with get_connection() as conn:
        existing = conn.execute(
            "SELECT * FROM positions WHERE id = ? AND portfolio_id = ?",
            (position_id, portfolio_id),
        ).fetchone()
        if not existing:
            return jsonify({"error": "Position not found"}), 404

        updates = {}
        if "qty" in data:
            if data["qty"] <= 0:
                return jsonify({"error": "qty must be positive"}), 400
            updates["qty"] = data["qty"]

        if "avg_price" in data:
            if data["avg_price"] <= 0:
                return jsonify({"error": "avg_price must be positive"}), 400
            updates["avg_price"] = data["avg_price"]

        if "total_investment" in data:
            if data["total_investment"] < 0:
                return jsonify({"error": "total_investment must be non-negative"}), 400
            updates["total_investment"] = data["total_investment"]

        if "notes" in data:
            notes = data["notes"] or ""
            if len(notes) > 500:
                return jsonify({"error": "notes must be 500 characters or fewer"}), 400
            updates["notes"] = notes

        # Validate ticker change if provided
        if "ticker" in data:
            new_ticker = data["ticker"].upper().strip()
            if not new_ticker:
                return jsonify({"error": "ticker cannot be empty"}), 400
            if len(new_ticker) > 10:
                return jsonify({"error": "ticker must be 10 characters or fewer"}), 400
            # Check duplicate
            dup = conn.execute(
                "SELECT id FROM positions WHERE portfolio_id = ? AND ticker = ? AND id != ?",
                (portfolio_id, new_ticker, position_id),
            ).fetchone()
            if dup:
                return jsonify({"error": f"Position for {new_ticker} already exists in this portfolio"}), 409
            updates["ticker"] = new_ticker

        if not updates:
            return jsonify(dict(existing))

        # Keep total_investment consistent when qty/avg change without an
        # explicit total override.  If the caller supplied total_investment
        # explicitly we respect it (possible desync — see NOTE above).
        if ("qty" in updates or "avg_price" in updates) and "total_investment" not in updates:
            try:
                final_qty = float(updates.get("qty", existing["qty"]))
                final_avg = float(updates.get("avg_price", existing["avg_price"]))
                updates["total_investment"] = final_qty * final_avg
            except (TypeError, ValueError):
                pass

        fields = ", ".join(f"{k} = ?" for k in updates)
        if "ticker" in updates and updates["ticker"] != existing["ticker"]:
            conn.execute("DELETE FROM trailing_stops WHERE position_id = ?", (position_id,))
        conn.execute(
            f"UPDATE positions SET {fields}, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (*updates.values(), position_id),
        )

        position = dict(
            conn.execute("SELECT * FROM positions WHERE id = ?", (position_id,)).fetchone()
        )
        position.update(_compute_pnl_fields(position))

    log.info("position.update portfolio=%d id=%d fields=%s", portfolio_id, position_id, list(updates.keys()))
    return jsonify(position)


@portfolio_bp.route(
    "/api/portfolio/<int:portfolio_id>/positions/<int:position_id>",
    methods=["DELETE"],
)
def delete_position(portfolio_id, position_id):
    """Delete a single position from a portfolio."""
    with get_connection() as conn:
        existing = conn.execute(
            "SELECT id, ticker FROM positions WHERE id = ? AND portfolio_id = ?",
            (position_id, portfolio_id),
        ).fetchone()
        if not existing:
            return jsonify({"error": "Position not found"}), 404

        conn.execute("DELETE FROM positions WHERE id = ?", (position_id,))

    log.info("position.delete portfolio=%d id=%d ticker=%s", portfolio_id, position_id, existing["ticker"])
    return jsonify({"status": "deleted", "id": position_id})


# ── Move Positions ───────────────────────────────────────────────────────────


@portfolio_bp.route("/api/portfolio/<int:portfolio_id>/positions/move", methods=["POST"])
def move_positions(portfolio_id):
    """Move one or more positions to a different portfolio.

    Body: { "position_ids": [int], "target_portfolio_id": int }

    Validates:
    - All positions exist and belong to source portfolio
    - Target portfolio exists and is different from source
    - No ticker conflicts in destination portfolio
    """
    data = request.get_json()
    if not data or not data.get("position_ids") or not data.get("target_portfolio_id"):
        return jsonify({"error": "position_ids and target_portfolio_id are required"}), 400

    position_ids = data["position_ids"]
    target_id = data["target_portfolio_id"]

    if not isinstance(position_ids, list) or len(position_ids) == 0:
        return jsonify({"error": "position_ids must be a non-empty list"}), 400

    if target_id == portfolio_id:
        return jsonify({"error": "Cannot move positions to the same portfolio"}), 400

    with get_connection() as conn:
        # Validate source portfolio
        source = conn.execute(
            "SELECT id, name FROM portfolios WHERE id = ?", (portfolio_id,)
        ).fetchone()
        if not source:
            return jsonify({"error": "Source portfolio not found"}), 404

        # Validate target portfolio
        target = conn.execute(
            "SELECT id, name FROM portfolios WHERE id = ?", (target_id,)
        ).fetchone()
        if not target:
            return jsonify({"error": "Target portfolio not found"}), 404

        # Validate all positions exist, belong to source, and collect tickers
        source_tickers = set()
        for pos_id in position_ids:
            pos = conn.execute(
                "SELECT id, portfolio_id, ticker FROM positions WHERE id = ?",
                (pos_id,),
            ).fetchone()
            if not pos:
                return jsonify({"error": f"Position {pos_id} not found"}), 404
            if pos["portfolio_id"] != portfolio_id:
                return jsonify({"error": f"Position {pos_id} does not belong to portfolio {portfolio_id}"}), 400
            source_tickers.add(pos["ticker"])

        # Check for ticker conflicts in destination
        dest_tickers = {
            row["ticker"]
            for row in conn.execute(
                "SELECT ticker FROM positions WHERE portfolio_id = ?", (target_id,)
            ).fetchall()
        }
        conflicting = source_tickers & dest_tickers
        if conflicting:
            ticker = next(iter(conflicting))
            return jsonify({
                "error": (
                    f"Cannot move {ticker} — it already exists in '{target['name']}'. "
                    "Sell or delete the position in the destination first."
                ),
            }), 400

        # Execute the move
        placeholders = ",".join("?" * len(position_ids))
        # Stops belong to the source portfolio/ticker, not the moved holding.
        conn.execute(
            f"DELETE FROM trailing_stops WHERE position_id IN ({placeholders})",
            position_ids,
        )
        conn.execute(
            f"UPDATE positions SET portfolio_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id IN ({placeholders})",
            [target_id] + list(position_ids),
        )

        # Build response with full portfolio data
        source_pf = _build_portfolio_summary(conn, portfolio_id)
        target_pf = _build_portfolio_summary(conn, target_id)

    log.info(
        "position.move source=%d target=%d count=%d tickers=%s",
        portfolio_id, target_id, len(position_ids), list(source_tickers),
    )
    return jsonify({
        "status": "moved",
        "moved_count": len(position_ids),
        "source_portfolio": source_pf,
        "target_portfolio": target_pf,
    })


# ── Bulk Buy / Sell (trade-style endpoints) ──────────────────────────────────


@portfolio_bp.route("/api/portfolio/<int:portfolio_id>/positions/buy", methods=["POST"])
def buy_position(portfolio_id):
    """Buy (add or increase) a position.

    If the ticker already exists, the qty and avg_price are averaged.
    If it does not exist, a new position is created.

    Body: { "ticker": str, "qty": float, "price": float, "date": "YYYY-MM-DD" (optional) }
    """
    data = request.get_json()
    # Accept "price" (frontend field name) or "avg_price" (legacy field name)
    avg_price = data.get("avg_price") if data else None
    if avg_price is None and data:
        avg_price = data.get("price")
    if not data or not data.get("ticker") or data.get("qty") is None or avg_price is None:
        return jsonify({"error": "ticker, qty, and price are required"}), 400

    trade_date = _trade_date(data)
    if trade_date is None:
        return jsonify({"error": "Invalid date format. Use YYYY-MM-DD"}), 400

    qty = data["qty"]
    if qty <= 0 or avg_price <= 0:
        return jsonify({"error": "qty and price must be positive"}), 400
    trade_cents = _trade_value_cents(qty, avg_price)
    if trade_cents is None:
        return jsonify({"error": "Invalid trade amount"}), 400

    ticker = data["ticker"].upper().strip()
    if not ticker or len(ticker) > 10:
        return jsonify({"error": "Invalid ticker"}), 400

    # Auto-add unknown tickers to universe as custom entries
    from services.universe import get_merged_universe, add_custom_stock
    from config import DEFAULT_UNIVERSE

    if ticker not in DEFAULT_UNIVERSE and ticker not in get_merged_universe():
        try:
            stock = yf.Ticker(ticker)
            info = stock.info or {}
            company_name = info.get("longName") or info.get("shortName") or ticker
            sector = info.get("sector") or ""
            add_custom_stock(ticker, company_name, sector)
            log.info("Auto-added %s to universe (sector=%s)", ticker, sector)
        except Exception as e:
            log.warning("Failed to auto-add %s to universe: %s", ticker, e)

    with get_connection() as conn:
        portfolio = conn.execute(
            "SELECT id FROM portfolios WHERE id = ?", (portfolio_id,)
        ).fetchone()
        if not portfolio:
            return jsonify({"error": "Portfolio not found"}), 404

        # Make the balance change the first write so concurrent cash edits
        # and trades cannot overwrite a balance read before acquiring the lock.
        conn.execute(
            "UPDATE portfolios SET cash_cents = MAX(0, cash_cents - ?) WHERE id = ?",
            (trade_cents, portfolio_id),
        )
        cash_cents = conn.execute(
            "SELECT cash_cents FROM portfolios WHERE id = ?", (portfolio_id,)
        ).fetchone()[0]

        existing = conn.execute(
            "SELECT * FROM positions WHERE portfolio_id = ? AND ticker = ?",
            (portfolio_id, ticker),
        ).fetchone()

        if existing:
            # Cost Basis method: add to total_investment, then derive avg
            new_qty = existing["qty"] + qty
            new_total_investment = existing["total_investment"] + (qty * avg_price)
            new_avg = round(new_total_investment / new_qty, 6)
            conn.execute(
                "UPDATE positions SET qty = ?, avg_price = ?, total_investment = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                (new_qty, new_avg, new_total_investment, existing["id"]),
            )
            position_id = existing["id"]
        else:
            cursor = conn.execute(
                """INSERT INTO positions (portfolio_id, ticker, qty, avg_price, total_investment)
                   VALUES (?, ?, ?, ?, ?)""",
                (portfolio_id, ticker, qty, avg_price, qty * avg_price),
            )
            position_id = cursor.lastrowid

        # Auto-record transaction
        notes = data.get("notes", "") or ""
        conn.execute(
            """INSERT INTO transactions (portfolio_id, ticker, type, qty, price, total, date, notes)
               VALUES (?, ?, 'BUY', ?, ?, ?, ?, ?)""",
            (portfolio_id, ticker, qty, avg_price, qty * avg_price, trade_date, notes),
        )

        position = dict(
            conn.execute("SELECT * FROM positions WHERE id = ?", (position_id,)).fetchone()
        )
        _enrich_positions_with_metadata(conn, [position])
        position.update(_compute_pnl_fields(position))
        position["cash_cents"] = cash_cents

    log.info("position.buy portfolio=%d ticker=%s qty=%.4f avg=%.2f", portfolio_id, ticker, qty, avg_price)
    return jsonify(position), 201


@portfolio_bp.route("/api/portfolio/<int:portfolio_id>/positions/sell", methods=["POST"])
def sell_position(portfolio_id):
    """Sell (reduce or remove) a position.

    Body: { "ticker": str, "qty": float, "price": float, "date": "YYYY-MM-DD" (optional) }
    """
    data = request.get_json()
    if not data or not data.get("ticker") or data.get("qty") is None:
        return jsonify({"error": "ticker and qty are required"}), 400

    trade_date = _trade_date(data)
    if trade_date is None:
        return jsonify({"error": "Invalid date format. Use YYYY-MM-DD"}), 400

    qty = data["qty"]
    if qty <= 0:
        return jsonify({"error": "qty must be positive"}), 400

    ticker = data["ticker"].upper().strip()

    with get_connection() as conn:
        portfolio = conn.execute(
            "SELECT id FROM portfolios WHERE id = ?", (portfolio_id,)
        ).fetchone()
        if not portfolio:
            return jsonify({"error": "Portfolio not found"}), 404

        existing = conn.execute(
            "SELECT * FROM positions WHERE portfolio_id = ? AND ticker = ?",
            (portfolio_id, ticker),
        ).fetchone()
        if not existing:
            return jsonify({"error": f"No position found for {ticker} in this portfolio"}), 404

        if qty > existing["qty"]:
            return jsonify({"error": f"Cannot sell {qty} — only {existing['qty']} held"}), 400

        sell_price = data.get("price")
        if sell_price is None:
            sell_price = existing["avg_price"]
        trade_cents = _trade_value_cents(qty, sell_price)
        if trade_cents is None:
            return jsonify({"error": "Invalid trade amount"}), 400

        cursor = conn.execute(
            "UPDATE portfolios SET cash_cents = cash_cents + ? WHERE id = ? AND cash_cents <= ?",
            (trade_cents, portfolio_id, MAX_CASH_CENTS - trade_cents),
        )
        if cursor.rowcount == 0:
            return jsonify({"error": "Cash balance exceeds supported range"}), 400
        cash_cents = conn.execute(
            "SELECT cash_cents FROM portfolios WHERE id = ?", (portfolio_id,)
        ).fetchone()[0]

        new_qty = round(existing["qty"] - qty, 6)
        if new_qty == 0:
            conn.execute("DELETE FROM positions WHERE id = ?", (existing["id"],))
        else:
            new_total_investment = existing["total_investment"] - (qty * existing["avg_price"])
            new_total_investment = max(0, new_total_investment)
            new_avg = round(new_total_investment / new_qty, 6)
            conn.execute(
                "UPDATE positions SET qty = ?, avg_price = ?, total_investment = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                (new_qty, new_avg, new_total_investment, existing["id"]),
            )

        # Auto-record transaction
        notes = data.get("notes", "") or ""
        transaction = conn.execute(
            """INSERT INTO transactions (portfolio_id, ticker, type, qty, price, total, date, notes)
               VALUES (?, ?, 'SELL', ?, ?, ?, ?, ?)""",
            (portfolio_id, ticker, qty, sell_price, qty * sell_price, trade_date, notes),
        )

        # Capture the pre-sale Portfolio average, not a lifetime ledger average.
        # This insert commits/rolls back with cash, position, and SELL transaction.
        cost_basis = qty * existing["avg_price"]
        proceeds = qty * sell_price
        pnl = proceeds - cost_basis
        conn.execute(
            """INSERT INTO realized_trades
               (transaction_id, portfolio_id, ticker, sell_date, qty_before_sale,
                avg_buy_price, qty_sold, sell_price, cost_basis, sale_proceeds,
                realized_pnl, realized_pnl_pct)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (transaction.lastrowid, portfolio_id, ticker, trade_date, existing["qty"],
             existing["avg_price"], qty, sell_price, cost_basis, proceeds, pnl,
             pnl / cost_basis * 100 if cost_basis > 0 else None),
        )

        # Return updated position (if still exists) or a sold indicator
        if new_qty == 0:
            return jsonify({
                "status": "sold",
                "ticker": ticker,
                "qty_sold": qty,
                "qty_remaining": 0,
                "cash_cents": cash_cents,
            })

        position = dict(
            conn.execute("SELECT * FROM positions WHERE id = ?", (existing["id"],)).fetchone()
        )
        _enrich_positions_with_metadata(conn, [position])
        position.update(_compute_pnl_fields(position))
        position["cash_cents"] = cash_cents

    log.info("position.sell portfolio=%d ticker=%s qty=%.4f price=%.2f", portfolio_id, ticker, qty, sell_price)
    return jsonify(position)


# ── Ticker Validation ───────────────────────────────────────────────────────


@portfolio_bp.route("/api/validate-ticker/<string:ticker>", methods=["GET"])
def validate_ticker(ticker):
    """Validate a ticker symbol against Yahoo Finance.

    Returns JSON:
        valid: True/False
        ticker: normalized uppercase ticker (if valid)
        company: company long name (if valid)
        sector: sector name (if valid)
        error: error message (if invalid)
    """
    ticker = ticker.upper().strip()
    if not ticker or len(ticker) > 10:
        return jsonify({"valid": False, "error": "Invalid ticker format"})

    try:
        stock = yf.Ticker(ticker)
        info = stock.info
        if not info or "regularMarketPrice" not in info:
            return jsonify({"valid": False, "error": "Ticker not found"})

        return jsonify({
            "valid": True,
            "ticker": ticker,
            "company": info.get("longName") or info.get("shortName") or ticker,
            "sector": info.get("sector") or "Unknown",
        })
    except Exception as e:
        log.warning("validate_ticker failed for %s: %s", ticker, e)
        return jsonify({"valid": False, "error": str(e)})
