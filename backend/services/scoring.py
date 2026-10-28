"""
scoring.py — daily momentum scoring grid.

Scoring criteria (C2 hard_catalyst SKIPPED — requires LLM):
  C1: vol_explosion      — vol_ratio >= 1.2 and day_pct > 0
  C3: sma_alignment      — price > SMA20 and SMA20 slope >= 0
  C4: sector_tailwind    — sector_rank <= 3 and sector_perf > market_perf + 0.5
  C5: institutional      — vol_ratio >= 2.0 and day_pct > 0 (additional point)
  C6: momentum_continuation — close_position >= 0.70
  C7: clean_session       — gap_pct >= -2.0 and 0 < day_pct < 25 (no gap-down recovery)
  C8: trend_context      — week_pct > 0 and month_pct > 0
  C9: breakout_20d       — price above previous 20-session high
  C10: relative_strength — daily return beats broad market by 0.5%

Conviction thresholds:
  HIGH     = score >= 5
  MODERATE = score 3-4
  LOW      = score < 3
"""


def score_stock(
    day_pct: float,
    week_pct: float,
    month_pct: float,
    vol_ratio: float,
    price: float,
    high_52w: float,
    sector_perf: float,
    market_perf: float,
    sector_rank: int,
    close_position: float,
    is_bearish: bool,
    sma20: float,
    sma20_slope: float,
    gap_pct: float = 0.0,
    high_20d_prior: float = 0.0,
) -> tuple[int, str, dict]:
    """
    Score a stock against daily momentum criteria.

    Returns:
        (score, conviction, criteria_dict)
        conviction: "HIGH" | "MODERATE" | "LOW"
    """
    if is_bearish:
        # ── Bearish distribution pipeline ────────────────────────────────
        criteria = {
            "vol_explosion":         vol_ratio >= 2.0,
            "sma_alignment":         False,
            "sector_tailwind":       sector_perf < -0.5,
            "institutional":         vol_ratio >= 3.0,
            "momentum_continuation": False,
            "clean_session":         False,
            "trend_context":         False,
        }
        total = sum(criteria.values())
        conviction = "BEARISH" if vol_ratio >= 2.0 else "LOW"

    else:
        # ── Bullish momentum ignition pipeline ───────────────────────────

        # Participation earns one point at 1.2x, an additional point at 2x.
        c1_vol_explosion = (vol_ratio >= 1.2) and (day_pct > 0)

        # C3: Trend structure (replaces 52wk-high proximity).
        #     price > SMA20 confirms stock is above its recent average.
        #     SMA20 slope >= 0 confirms the average itself is rising (not just a
        #     temporary spike through a declining MA).
        #     Works in both bull-market breakouts AND recovery environments.
        c3_trend_structure = (price > sma20 > 0) and (sma20_slope >= 0)

        # C4: Sector tailwind — raised from 0.5% to 1.0% AND requires the sector
        #     to outperform the broad market by at least 0.5%.  A sector up 0.3%
        #     while SPY is up 1.5% is a headwind, not a tailwind.
        c4_sector_tailwind = (sector_rank <= 3) and (sector_perf > market_perf + 0.5)

        # C5: Heavy participation (≥ 2.0x), a second volume point.
        #     Requires day_pct > 0 so heavy sell-off volume doesn't trigger this.
        c5_institutional = (vol_ratio >= 2.0) and (day_pct > 0)

        # C6: Momentum continuation (close position) — UNCHANGED.
        #     Close in top 30% of daily range = buyers controlled the session.
        #     This was the best-performing criterion in the backtest; keep as-is.
        c6_momentum_continuation = close_position >= 0.70

        # C7: Clean session — no gap-down recovery, no extreme intraday move.
        #     A stock gapping down 5% and then recovering to +2% fails this.
        #     This is orthogonal to trend structure (C3 has no gap info) and
        #     prior momentum (C8 doesn't care about today's open action).
        c7_clean_session = (gap_pct >= -2.0) and (0.0 < day_pct < 25.0)

        # C8: Trend context — distinguishes continuation from recovery.
        #     week_pct > 0 AND month_pct > 0 means the stock was already trending
        #     BEFORE today's ignition signal — highest quality setup.
        #     Recovery plays (deep hole → bounce) score 0 here, which is correct:
        #     they carry more risk and need a larger stop.
        c8_trend_context = (week_pct > 0) and (month_pct > 0)
        breakout = high_20d_prior > 0 and price > high_20d_prior
        relative_strength = day_pct > market_perf + 0.5

        criteria = {
            "vol_explosion":         c1_vol_explosion,
            "sma_alignment":         c3_trend_structure,
            "sector_tailwind":       c4_sector_tailwind,
            "institutional":         c5_institutional,
            "momentum_continuation": c6_momentum_continuation,
            "clean_session":         c7_clean_session,
            "trend_context":         c8_trend_context,
            "breakout_20d":          breakout,
            "relative_strength":     relative_strength,
        }
        total = sum(criteria.values())

        # Conviction thresholds
        if total >= 5:
            conviction = "HIGH"
        elif total >= 3:
            conviction = "MODERATE"
        else:
            conviction = "LOW"

    return total, conviction, criteria
