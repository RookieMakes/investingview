"""
volume_profile.py — EOD volume-profile levels (DB-only, no yfinance).

Reads daily candles from the ``candles`` table (populated by the existing
16:05 dashboard job + on-demand chart fetches), computes POC/VAH/VAL for
the 3m and 6m windows, and stores latest-only levels in ``volume_profile``.

Python port of frontend/js/components/volume-profile.js:
  - stable nice-grid (1/2/2.5/5 x 10^k)
  - overlap-proportional volume distribution across [low, high]
  - POC = max-volume row, ties toward volume-weighted median then upward
  - 70% value-area expansion from POC by busier neighbor
  - sensitivity probe across 24/30/36-row grids

Zero yfinance calls. The 16:20 scheduler job is the only writer.
"""

import logging
import math
from calendar import monthrange
from datetime import date, datetime

from models.db import get_connection

logger = logging.getLogger(__name__)

ROWS = 30
VALUE_AREA_PCT = 0.7
MIN_BARS = 5

# ── Pure compute (JS port) ──────────────────────────────────────────


def _nice_step(raw_step):
    if not (raw_step and raw_step > 0) or not math.isfinite(raw_step):
        return 1.0
    mag = 10 ** math.floor(math.log10(raw_step))
    norm = raw_step / mag
    if norm >= 7.0710679:
        snap = 10
    elif norm >= 3.5355339:
        snap = 5
    elif norm >= 2.236068:
        snap = 2.5
    elif norm >= 1.4142136:
        snap = 2
    else:
        snap = 1
    return snap * mag


def _stable_grid(min_low, max_high, target_rows):
    target = max(8, min(60, int(round(target_rows)) if target_rows else 30))
    step = _nice_step((max_high - min_low) / target)
    grid_min, grid_max, n = min_low, max_high, target
    for _ in range(8):
        grid_min = math.floor(min_low / step) * step
        grid_max = math.ceil(max_high / step) * step
        grid_min = round(grid_min * 1e10) / 1e10
        grid_max = round(grid_max * 1e10) / 1e10
        n = max(1, int(round((grid_max - grid_min) / step)))
        if n > 60:
            step *= 2
            continue
        if n < 8:
            step /= 2
            continue
        break
    return {"step": step, "grid_min": grid_min, "grid_max": grid_max, "n": n}


def _distribute_volume(valid, grid):
    step, grid_min, n = grid["step"], grid["grid_min"], grid["n"]
    bins = [0.0] * n
    eps = 1e-9
    for c in valid:
        rng = c["high"] - c["low"]
        if rng == 0:
            b = max(0, min(n - 1, int(math.floor((c["low"] - grid_min) / step + eps))))
            bins[b] += c["volume"]
            continue
        lo = int(math.floor((c["low"] - grid_min) / step + eps))
        hi = int(math.ceil((c["high"] - grid_min) / step - eps)) - 1
        lo = max(0, min(n - 1, lo))
        hi = max(0, min(n - 1, hi))
        if hi < lo:
            bins[lo] += c["volume"]
            continue
        for b in range(lo, hi + 1):
            bin_lo = grid_min + b * step
            overlap = max(0.0, min(c["high"], bin_lo + step) - max(c["low"], bin_lo))
            if overlap > 0:
                bins[b] += c["volume"] * (overlap / rng)
    return bins


def _levels_from_bins(bins, value_area_pct):
    total = sum(bins)
    if total <= 0:
        return None
    max_vol = max(bins)
    if max_vol <= 0:
        return None
    cum, median_idx = 0.0, len(bins) - 1
    for i, v in enumerate(bins):
        cum += v
        if cum >= total / 2:
            median_idx = i
            break
    tol = 1e-9 * max(1.0, total)
    poc = -1
    for b, v in enumerate(bins):
        if v < max_vol - tol:
            continue
        if poc < 0:
            poc = b
            continue
        d, best = abs(b - median_idx), abs(poc - median_idx)
        if d < best or (d == best and b > poc):
            poc = b
    lo = hi = poc
    va_vol = bins[poc]
    target = total * value_area_pct
    while va_vol < target and (lo > 0 or hi < len(bins) - 1):
        lo_vol = bins[lo - 1] if lo > 0 else -1
        hi_vol = bins[hi + 1] if hi < len(bins) - 1 else -1
        if hi_vol != lo_vol:
            take_hi = hi_vol > lo_vol
        else:
            take_hi = (hi + 1 - poc) <= (poc - (lo - 1))
        if take_hi:
            hi += 1
            va_vol += bins[hi]
        else:
            lo -= 1
            va_vol += bins[lo]
    return {"poc_index": poc, "max_volume": max_vol, "lo": lo, "hi": hi,
            "va_vol": va_vol, "total_volume": total}


def compute_volume_profile(candles, rows=ROWS, value_area_pct=VALUE_AREA_PCT):
    """Port of JS computeVolumeProfile. Candles: [{high, low, volume}]."""
    if not candles:
        return None
    valid = [c for c in candles
             if c and math.isfinite(c.get("high", float("nan")))
             and math.isfinite(c.get("low", float("nan")))
             and math.isfinite(c.get("volume", float("nan")))
             and c["volume"] > 0 and c["high"] >= c["low"]]
    if not valid:
        return None
    min_low = min(c["low"] for c in valid)
    max_high = max(c["high"] for c in valid)
    if not (math.isfinite(min_low) and math.isfinite(max_high)) or max_high < min_low:
        return None
    if max_high == min_low:
        pad = max(abs(min_low) * 0.001, 0.01)
        min_low -= pad
        max_high += pad
    main_rows = max(8, min(60, int(round(rows)) if rows else 30))
    grid = _stable_grid(min_low, max_high, main_rows)
    bins = _distribute_volume(valid, grid)
    levels = _levels_from_bins(bins, value_area_pct)
    if not levels:
        return None
    poc_prices = [grid["grid_min"] + (levels["poc_index"] + 0.5) * grid["step"]]
    for r in (24, 36):
        g = _stable_grid(min_low, max_high, r)
        lv = _levels_from_bins(_distribute_volume(valid, g), value_area_pct)
        if lv:
            poc_prices.append(g["grid_min"] + (lv["poc_index"] + 0.5) * g["step"])
    spread = max(poc_prices) - min(poc_prices)
    poc_price = grid["grid_min"] + (levels["poc_index"] + 0.5) * grid["step"]
    return {
        "poc": poc_price,
        "vah": grid["grid_min"] + (levels["hi"] + 1) * grid["step"],
        "val": grid["grid_min"] + levels["lo"] * grid["step"],
        "max_volume": levels["max_volume"],
        "total_volume": levels["total_volume"],
        "step": grid["step"],
        "grid_min": grid["grid_min"],
        "grid_max": grid["grid_max"],
        "value_area_coverage": levels["va_vol"] / levels["total_volume"],
        "stable": spread <= grid["step"] * (1 + 1e-9),
        "poc_spread": spread,
    }


# ── Range windows (same calendar logic as JS selectVolumeProfileCandles) ──

RANGES = (3, 6)


def _months_back_cutoff(end_iso, months):
    """Cutoff date string: same day-of-month minus N calendar months."""
    y, m, d = int(end_iso[0:4]), int(end_iso[5:7]), int(end_iso[8:10])
    m -= months
    while m <= 0:
        m += 12
        y -= 1
    month_end = monthrange(y, m)[1]
    return date(y, m, min(d, month_end)).isoformat()


def select_window_candles(rows, months):
    """Rows: [{date, ...}] ascending. Returns rolling-N-month slice."""
    if not rows:
        return []
    end = rows[-1]["date"]
    cutoff = _months_back_cutoff(end, months)
    return [r for r in rows if r["date"] >= cutoff]


def select_3m_candles(rows):
    """Back-compat alias for the 3-month window."""
    return select_window_candles(rows, 3)


# ── DB scan (only writer; no yfinance) ──────────────────────────────

def _upsert_insufficient(conn, ticker, rng, session_date, count):
    conn.execute(
        "INSERT INTO volume_profile (ticker, range, session_date, candle_count, "
        "insufficient_data, updated_at) VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP) "
        "ON CONFLICT(ticker, range) DO UPDATE SET session_date = excluded.session_date, "
        "candle_count = excluded.candle_count, insufficient_data = 1, "
        "updated_at = CURRENT_TIMESTAMP",
        (ticker, rng, session_date, count),
    )


def _upsert_profile(conn, ticker, rng, profile, session_date, count):
    conn.execute(
        """INSERT INTO volume_profile
           (ticker, range, poc, vah, val, max_volume, total_volume, step,
            grid_min, grid_max, value_area_coverage, stable, poc_spread,
            session_date, candle_count, insufficient_data, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)
           ON CONFLICT(ticker, range) DO UPDATE SET
             poc = excluded.poc, vah = excluded.vah, val = excluded.val,
             max_volume = excluded.max_volume, total_volume = excluded.total_volume,
             step = excluded.step, grid_min = excluded.grid_min,
             grid_max = excluded.grid_max,
             value_area_coverage = excluded.value_area_coverage,
             stable = excluded.stable, poc_spread = excluded.poc_spread,
             session_date = excluded.session_date,
             candle_count = excluded.candle_count, insufficient_data = 0,
             updated_at = CURRENT_TIMESTAMP""",
        (ticker, rng, profile["poc"], profile["vah"], profile["val"],
         profile["max_volume"], profile["total_volume"], profile["step"],
         profile["grid_min"], profile["grid_max"], profile["value_area_coverage"],
         1 if profile["stable"] else 0, profile["poc_spread"],
         session_date, count),
    )


def run_volume_profile_scan():
    """Compute 3m + 6m POC/VAH/VAL for every universe ticker from stored candles.

    Reads ``candles`` only (fresh after the 16:05 job). Skips ranges with
    thin history (insufficient_data=1) instead of fetching. Latest-only
    upsert per (ticker, range) into ``volume_profile``.
    """
    from services.universe import get_merged_universe_with_metadata

    universe = get_merged_universe_with_metadata()
    tickers = [u["ticker"] for u in universe if (u.get("sector") or "") != "ETF"]

    updated, skipped = 0, 0
    session_date = None
    with get_connection() as conn:
        for ticker in tickers:
            try:
                rows = conn.execute(
                    "SELECT date, open, high, low, close, volume FROM candles "
                    "WHERE ticker = ? ORDER BY date",
                    (ticker,),
                ).fetchall()
                if not rows:
                    for months in RANGES:
                        _upsert_insufficient(conn, ticker, f"{months}m", None, 0)
                        skipped += 1
                    continue
                all_rows = [dict(r) for r in rows]
                if session_date is None or all_rows[-1]["date"] > (session_date or ""):
                    session_date = all_rows[-1]["date"]
                last_date = all_rows[-1]["date"]
                for months in RANGES:
                    rng = f"{months}m"
                    window = select_window_candles(all_rows, months)
                    if len(window) < MIN_BARS:
                        _upsert_insufficient(conn, ticker, rng, last_date, len(window))
                        skipped += 1
                        continue
                    profile = compute_volume_profile(
                        [{"high": r["high"], "low": r["low"], "volume": r["volume"]}
                         for r in window]
                    )
                    if not profile:
                        _upsert_insufficient(conn, ticker, rng, last_date, len(window))
                        skipped += 1
                        continue
                    _upsert_profile(conn, ticker, rng, profile, last_date, len(window))
                    updated += 1
            except Exception as e:
                logger.warning("volume_profile.skip %s: %s", ticker, e)
                skipped += 1
    logger.info("volume_profile.scan complete: updated=%d skipped=%d session=%s",
                updated, skipped, session_date)
    return {"updated": updated, "skipped": skipped, "session_date": session_date,
            "scanned_at": datetime.now().isoformat()}


def get_volume_profile(ticker):
    """All stored range rows for a ticker: {range: row}. No compute, no yfinance."""
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT * FROM volume_profile WHERE ticker = ?", (ticker.upper(),)
        ).fetchall()
        return {r["range"]: dict(r) for r in rows}
