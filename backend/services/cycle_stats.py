"""
cycle_stats.py — Current-holding-cycle statistics for portfolio positions.

A "cycle" is the run of transactions for a single (portfolio_id, ticker)
since the last point where the running quantity returned to zero.  This
lets the portfolio table show cash-basis columns (unrecovered capital,
realized P&L in the current cycle, breakeven) that stay correct across
partial sells, while the lifetime profit-summary endpoint is untouched.

Ordering: transactions are ordered by (date ASC, id ASC).
Zero detection: running qty is rounded to 6 decimals and compared with
epsilon 1e-9.
Money: all money fields are rounded to 2 decimals at the response edge.
"""

import logging

log = logging.getLogger(__name__)

_QTY_EPSILON = 1e-9
_QTY_PRECISION = 6


def compute_cycle(qty_rem, txns):
    """Compute current-cycle stats for one (portfolio, ticker) holding.

    Parameters
    ----------
    qty_rem : float
        Remaining quantity from ``positions.qty``.  When the sell path
        fully closes a position the row is deleted, so callers normally
        never pass 0 — a 0 here means legacy/desync data and yields a
        null breakeven.
    txns : list[dict]
        All transactions for this (portfolio_id, ticker), each dict with
        at least ``type`` ("BUY"/"SELL"), ``qty``, ``total``, ``date``,
        ``id``.  ``price`` is used only as a fallback when ``total`` is
        missing.  Order does not need to be pre-sorted; this function
        sorts by (date ASC, id ASC) defensively.

    Returns
    -------
    dict
        {
            "unrecovered_capital": float,   # max(0, total_bought - total_sold)
            "realized_pnl_cycle": float,    # total_sold - clamped_qty_sold * avg_buy
            "breakeven_price": float|None,  # 0.00 when raw <= 0 (frontend FREE badge)
            "breakeven_raw": float|None,    # raw breakeven, rounded (tooltip)
            "cash_recovered": float,        # total_sold in cycle
            "remaining_basis": float,       # qty_rem * avg_buy (avg-cost basis left)
            "total_return_cycle": float,    # == realized (unrealized needs market price)
            "has_cycle_history": bool,      # False when cycle slice is empty
        }

    Notes
    -----
    Pure function — no DB, no HTTP, no side effects except a warning log
    on clamped/desync input.  Safe to unit-test without Flask or SQLite.

    Desync rule: a SELL that exceeds the cycle's bought qty (pencil-edited
    positions, legacy rows) is clamped so money never goes negative.
    Effective sold qty for cost purposes is min(qty_sold, qty_bought);
    unrecovered is floored at 0.  The condition is logged; no extra flag
    is exposed in the API response to keep the contract stable.
    """
    empty_result = {
        "unrecovered_capital": 0.0,
        "realized_pnl_cycle": 0.0,
        "breakeven_price": None,
        "breakeven_raw": None,
        "cash_recovered": 0.0,
        "remaining_basis": 0.0,
        "total_return_cycle": 0.0,
        "has_cycle_history": False,
    }

    try:
        qty_rem_f = float(qty_rem or 0)
    except (TypeError, ValueError):
        qty_rem_f = 0.0

    if not txns:
        return dict(empty_result)

    # Defensive sort — callers already order by (date, id), but unit tests
    # and future callers should not depend on that.
    try:
        ordered = sorted(
            txns, key=lambda t: ((t.get("date") or ""), (t.get("id") or 0))
        )
    except Exception:
        ordered = list(txns)

    # ── Slice since last point where running qty == 0 ────────────────
    running = 0.0
    last_zero_idx = -1
    for i, t in enumerate(ordered):
        try:
            q = float(t.get("qty") or 0)
        except (TypeError, ValueError):
            q = 0.0
        ttype = t.get("type")
        if ttype == "BUY":
            running = round(running + q, _QTY_PRECISION)
        elif ttype == "SELL":
            running = round(running - q, _QTY_PRECISION)
        else:
            continue
        if abs(running) < _QTY_EPSILON:
            running = 0.0
            last_zero_idx = i

    cycle = ordered[last_zero_idx + 1:]
    if not cycle:
        # Fully-closed history with a leftover position row means desync
        # (normally the row is deleted on full sell).  No current cycle.
        return dict(empty_result)

    # ── Aggregate the cycle ──────────────────────────────────────────
    total_bought = 0.0
    total_sold = 0.0
    qty_bought = 0.0
    qty_sold = 0.0
    for t in cycle:
        try:
            q = float(t.get("qty") or 0)
        except (TypeError, ValueError):
            q = 0.0
        total = t.get("total", None)
        try:
            total_f = float(total) if total is not None else None
        except (TypeError, ValueError):
            total_f = None
        if total_f is None:
            # Fallback when total was not stored — qty * price.
            try:
                total_f = q * float(t.get("price") or 0)
            except (TypeError, ValueError):
                total_f = 0.0
        if t.get("type") == "BUY":
            total_bought += total_f
            qty_bought += q
        elif t.get("type") == "SELL":
            total_sold += total_f
            qty_sold += q

    qty_bought = round(qty_bought, _QTY_PRECISION)
    qty_sold = round(qty_sold, _QTY_PRECISION)

    # Degenerate cycle: sells with no buys (desync/legacy).  No cost basis
    # to allocate — report zeros with a null breakeven rather than a
    # misleading profit equal to gross proceeds.
    if qty_bought < _QTY_EPSILON:
        if qty_sold > _QTY_EPSILON:
            log.warning(
                "compute_cycle: cycle has sells (qty=%.6f) with no buys — "
                "returning zeros with null breakeven",
                qty_sold,
            )
        result = dict(empty_result)
        result["cash_recovered"] = round(total_sold, 2)
        result["has_cycle_history"] = True
        return result

    avg_buy = total_bought / qty_bought if qty_bought else 0.0

    # Clamp oversells: costed qty never exceeds bought qty.
    clamped = False
    effective_qty_sold = qty_sold
    if qty_sold > qty_bought + _QTY_EPSILON:
        clamped = True
        effective_qty_sold = qty_bought
        log.warning(
            "compute_cycle: qty_sold=%.6f exceeds qty_bought=%.6f — clamping "
            "cost basis to bought qty",
            qty_sold,
            qty_bought,
        )

    realized = total_sold - effective_qty_sold * avg_buy
    unrecovered_precise = total_bought - total_sold
    unrecovered = unrecovered_precise
    if unrecovered < 0:
        # Oversold proceeds (desync) — floor at zero, never negative.
        if not clamped:
            log.warning(
                "compute_cycle: unrecovered=%.2f negative — flooring at 0",
                unrecovered,
            )
        unrecovered = 0.0

    unrecovered_r = round(unrecovered, 2)
    realized_r = round(realized, 2)
    cash_recovered_r = round(total_sold, 2)
    remaining_basis_r = round(qty_rem_f * avg_buy, 2) if qty_rem_f > 0 else 0.0

    # Breakeven needs a live holding.  qty_rem == 0 normally means the row
    # was deleted on full sell, so a null here signals desync/edge input.
    # Raw uses the unfloored precise value so house-money cases keep a
    # negative raw for the tooltip while price floors at 0.00 (FREE badge).
    breakeven_price = None
    breakeven_raw = None
    if qty_rem_f > _QTY_EPSILON:
        raw = unrecovered_precise / qty_rem_f
        breakeven_raw = round(raw, 2)
        if raw <= 0:
            # House money — frontend shows a FREE badge, raw kept for tooltip.
            breakeven_price = 0.00
        else:
            breakeven_price = round(raw, 2)

    return {
        "unrecovered_capital": unrecovered_r,
        "realized_pnl_cycle": realized_r,
        "breakeven_price": breakeven_price,
        "breakeven_raw": breakeven_raw,
        "cash_recovered": cash_recovered_r,
        "remaining_basis": remaining_basis_r,
        "total_return_cycle": realized_r,
        "has_cycle_history": True,
    }
