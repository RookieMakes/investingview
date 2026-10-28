"""
swing_scanner.py — Swing (VAH/VAL touch) board, DB-only on-read compute.

Joins ``volume_profile`` (3m + 6m POC/VAH/VAL from the 16:20 EOD job) with
the latest completed row in ``candles`` per ticker:

  - VAH table: today's range contains VAH (low <= VAH <= high)
  - VAL table: today's range contains VAL (low <= VAL <= high)
  - Gap days entirely above/below the level are NOT touches.
  - Direction-aware signals from today's open vs close:
    VAH: crossed-above (open<=VAH<close) / held-above (open>VAH, close>VAH)
         / crossed-below (open>VAH, close<=VAH) / bounced (open<=VAH, close<=VAH)
    VAL: crossed-below (open>=VAL>close) / held-below (open<VAL, close<VAL)
         / crossed-above (open<VAL, close>=VAL) / bounced (open>=VAL, close>=VAL).
  - Both ranges merge into one table each; a ticker touching both its 3M
    and 6M level keeps only the 3M row. Each row carries range '3M'/'6M'.

Zero yfinance calls. No scheduler job — fresh on every read after 16:20.
"""

import logging
from datetime import datetime

from models.db import get_connection

logger = logging.getLogger(__name__)


def get_swing_board():
    """Return {vah, val, session_date, counts, scanned_at} for the Swing tab."""
    with get_connection() as conn:
        # Keep the last completed board visible until the profile job has
        # produced levels for a newer candle date.
        sess = conn.execute(
            """SELECT MAX(c.date) AS d FROM candles c
               JOIN volume_profile v ON v.ticker = c.ticker
                 AND v.session_date = c.date
               WHERE v.insufficient_data = 0
                 AND v.vah IS NOT NULL AND v.val IS NOT NULL"""
        ).fetchone()
        session_date = sess["d"] if sess and sess["d"] else None
        if not session_date:
            return {"vah": [], "val": [], "session_date": None,
                    "counts": {"vah": 0, "val": 0, "skipped": 0},
                    "scanned_at": datetime.now().isoformat()}

        rows = conn.execute(
            """SELECT c.ticker, c.high, c.low, c.close, c.open,
                      v.range AS vp_range, v.vah, v.val, v.poc, v.stable,
                      v.session_date AS vp_session,
                      COALESCE(u.company_name, s.name, '') AS company
               FROM candles c
               JOIN volume_profile v ON v.ticker = c.ticker
               LEFT JOIN universe u ON u.ticker = c.ticker
               LEFT JOIN dash_stocks s ON s.symbol = c.ticker
               WHERE c.date = ?
                 AND v.insufficient_data = 0
                 AND v.vah IS NOT NULL AND v.val IS NOT NULL
               ORDER BY c.ticker, v.range""",
            (session_date,),
        ).fetchall()

        # Tickers with no usable range for this session (thin/stale).
        skipped = conn.execute(
            """SELECT COUNT(*) AS n FROM (
                 SELECT ticker FROM volume_profile GROUP BY ticker
                 HAVING SUM(CASE WHEN insufficient_data = 0 AND session_date = ? THEN 1 ELSE 0 END) = 0
               )""",
            (session_date,),
        ).fetchone()["n"]

    vah_by_ticker, val_by_ticker = {}, {}
    for r in rows:
        if r["vp_session"] != session_date:
            continue
        try:
            high, low, close = float(r["high"]), float(r["low"]), float(r["close"])
            level_vah, level_val = float(r["vah"]), float(r["val"])
            open_px = float(r["open"]) if r["open"] is not None else close
        except (TypeError, ValueError):
            continue
        rng = "6M" if (r["vp_range"] or "3m") == "6m" else "3M"
        base = {
            "ticker": r["ticker"],
            "company": r["company"] or "",
            "high": high, "low": low, "close": close, "open": open_px,
            "poc": float(r["poc"]) if r["poc"] is not None else None,
            "stable": bool(r["stable"]) if r["stable"] is not None else True,
            "session_date": session_date,
            "range": rng,
        }
        if low <= level_vah <= high:
            # 3M wins when both ranges touch.
            if r["ticker"] not in vah_by_ticker or rng == "3M":
                if open_px <= level_vah:
                    sig = "crossed-above" if close > level_vah else "bounced"
                else:
                    sig = "held-above" if close > level_vah else "crossed-below"
                vah_by_ticker[r["ticker"]] = {**base, "level": level_vah, "signal": sig}
        if low <= level_val <= high:
            if r["ticker"] not in val_by_ticker or rng == "3M":
                if open_px >= level_val:
                    sig = "crossed-below" if close < level_val else "bounced"
                else:
                    sig = "held-below" if close < level_val else "crossed-above"
                val_by_ticker[r["ticker"]] = {**base, "level": level_val, "signal": sig}

    vah = sorted(vah_by_ticker.values(), key=lambda x: (x["ticker"], x["range"]))
    val = sorted(val_by_ticker.values(), key=lambda x: (x["ticker"], x["range"]))
    return {"vah": vah, "val": val, "session_date": session_date,
            "counts": {"vah": len(vah), "val": len(val), "skipped": skipped},
            "scanned_at": datetime.now().isoformat()}
