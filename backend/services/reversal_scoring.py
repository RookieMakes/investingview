"""
reversal_scoring.py — 5-criterion trend-reversal scoring grid.

Takes pre-computed numpy arrays (closes, highs, lows, volumes) for a single
ticker and returns (score, conviction, criteria_dict, metrics_dict).

Completely standalone — no yfinance, no config, no network.  All array math
is done here so reversal_scanner.py stays clean.

Criteria
--------
A  downtrend_confirmed   Stock was genuinely falling before the reversal signal
                         (prior 20-session return vs 20-session volatility)
B  reversal_trigger      3 higher closes + ATR move ≥ 0.8  OR  single candle > 1.5× ATR on > 2× volume
C  volume_confirmation   Volume ≥ 1.5× 20-day avg  OR  hard catalyst present (earnings/upgrade/M&A)
D  structural_break      Close > 10-day high  AND  (close > 20DMA  OR  20DMA slope flattening)
E  strong_close          Signal candle closes strongly (two days for multi-day signal)

Conviction
----------
STRONG  = 5 / 5
WATCH   = 3–4 / 5
(anything < 3 is excluded by the scanner — never returned to the dashboard)
"""

from __future__ import annotations

import numpy as np


# ── Tunable thresholds — change here, nowhere else ───────────────────────────
VOLATILITY_MULTIPLIER      = 1.0     # prior 20-day decline >= 1x 20-day volatility
ATR_MOVE_THRESHOLD        = 0.8     # (Close[-1] - Close[-3]) / ATR14 ≥ this
VOL_RATIO_THRESHOLD       = 1.5     # today's volume ≥ this × 20-day avg
SINGLE_CANDLE_ATR_MULT    = 1.5     # alt B: single candle move / ATR14 ≥ this
SINGLE_CANDLE_VOL_MULT    = 2.0     # alt B: that candle's volume ≥ this × 20-day avg
CLOSE_POSITION_THRESHOLD  = 0.65    # E: close must be in top 65% of range, all 3 days
SMA20_FLAT_ATR_MULT       = 0.50    # D: 20DMA slope is "flat" when |pct_slope| < this × ATR14%


# ── Minimum rows required (60 gives clean 50-day SMA + 5-session slope buffer) ──
MIN_ROWS = 60


def score_reversal(
    closes:            np.ndarray,
    highs:             np.ndarray,
    lows:              np.ndarray,
    volumes:           np.ndarray,
    has_hard_catalyst: bool = False,
    return_below:      bool = False,
) -> tuple[int, str, dict, dict] | None:
    """
    Score a single stock against the 5-criterion reversal grid.

    Parameters
    ----------
    closes, highs, lows, volumes : 1-D float arrays, oldest-first, length ≥ 60
    has_hard_catalyst             : True when a hard catalyst (earnings beat, analyst
                                    upgrade, M&A, contract) is confirmed — waives the
                                    volume requirement in criterion C.
    return_below                  : When True, sub-threshold scores (< 3) are returned
                                    as ("LOW", ...) instead of None so the scanner can
                                    persist grey below-threshold rows for the board.
                                    Default False preserves the original contract.

    Returns
    -------
    (score, conviction, criteria, metrics)  or  None if data is insufficient.

    criteria  — dict[str, bool]  one key per criterion
    metrics   — dict[str, float] raw numbers for the dashboard (diagnostics)
    """
    c = closes
    H = highs
    L = lows
    v = volumes

    if len(c) < MIN_ROWS or len(v) < MIN_ROWS:
        return None

    # ── A: Downtrend state ────────────────────────────────────────────────────
    # 20-day return
    ret_20d: float = (
        (float(c[-4]) - float(c[-24])) / float(c[-24]) * 100
        if float(c[-24]) > 0 else 0.0
    )
    # Assess the state before the three-session reversal, not after the bounce.
    sma50: float       = float(c[-54:-4].mean())
    sma50_prior: float = float(c[-59:-9].mean())
    slope50: float     = sma50 - sma50_prior

    # Volatility-normalized downtrend threshold
    daily_returns = np.diff(c[-24:-3]) / c[-24:-4]
    vol_20d = float(np.std(daily_returns) * 100)   # std dev in percentage terms
    downtrend_threshold = -(VOLATILITY_MULTIPLIER * vol_20d * np.sqrt(20))

    downtrend: bool = (ret_20d < downtrend_threshold) or (
        float(c[-4]) < sma50 and slope50 < 0
    )

    # ── B: Reversal trigger ───────────────────────────────────────────────────
    # vol20 computed here so both B (single-candle check) and C can share it
    vol20: float = float(v[-21:-1].mean()) if len(v) >= 21 else float(v[:-1].mean())

    # Primary path: three consecutive higher closes (last 3 sessions) with meaningful ATR move
    c0, c1, c2 = float(c[-3]), float(c[-2]), float(c[-1])
    three_higher: bool = c2 > c1 > c0

    # ATR-14 (true range of prior 14 bars, not including today — accounts for gaps)
    prev_closes_14: np.ndarray = c[-16:-2]
    tr_14: np.ndarray = np.maximum(
        H[-15:-1] - L[-15:-1],
        np.maximum(
            np.abs(H[-15:-1] - prev_closes_14),
            np.abs(L[-15:-1] - prev_closes_14)
        )
    )
    atr14: float      = float(tr_14.mean()) if len(tr_14) > 0 else 0.0
    atr_move: float   = (c2 - c0) / atr14 if atr14 > 0 else 0.0

    # Alternative path: single engulfing candle > 1.5× ATR on > 2× volume.
    # Now looks back 2 days (today OR yesterday qualifies).
    candle_today_move: float = (float(c[-1]) - float(c[-2])) / atr14 if atr14 > 0 else 0.0
    candle_today_vol:  float = float(v[-1]) / vol20 if vol20 > 0 else 0.0
    candle_yest_move:  float = (float(c[-2]) - float(c[-3])) / atr14 if atr14 > 0 else 0.0
    candle_yest_vol:   float = float(v[-2]) / vol20 if vol20 > 0 else 0.0
    single_candle: bool = (
        (candle_today_move >= SINGLE_CANDLE_ATR_MULT and candle_today_vol >= SINGLE_CANDLE_VOL_MULT)
        or (candle_yest_move  >= SINGLE_CANDLE_ATR_MULT and candle_yest_vol  >= SINGLE_CANDLE_VOL_MULT)
    )

    reversal: bool = (three_higher and atr_move >= ATR_MOVE_THRESHOLD) or single_candle

    # ── C: Volume confirmation ────────────────────────────────────────────────
    # vol20 already computed in B.  Passes on institutional accumulation OR explicit
    # hard catalyst — ORCL proved news-driven moves can run without a volume surge.
    vol_ratio: float = float(v[-1]) / vol20 if vol20 > 0 else 0.0
    vol_ok: bool     = max(candle_today_vol, candle_yest_vol) >= VOL_RATIO_THRESHOLD or has_hard_catalyst

    # ── D: Structural break ───────────────────────────────────────────────────
    # Must clear the 10-day high (non-negotiable) AND show 20DMA improvement.
    # "Improvement" = price above 20DMA, OR slope is flattening (|slope| < 0.3 × ATR14).
    # The slope path catches fast-bouncing stocks (PLTR-style) before they reclaim
    # the moving average — AND logic alone would miss those early entries.
    sma20: float       = float(c[-21:-1].mean())
    sma20_prior: float = float(c[-26:-6].mean())          # 20DMA from 5 sessions ago
    sma20_slope: float = sma20 - sma20_prior               # negative = still declining
    sma20_slope_pct: float = (sma20_slope / sma20) * 100 if sma20 > 0 else 0.0
    atr14_pct: float = (atr14 / float(c[-1])) * 100 if float(c[-1]) > 0 else 0.0
    sma20_flattening: bool = abs(sma20_slope_pct) < atr14_pct * SMA20_FLAT_ATR_MULT
    high10: float      = float(H[-11:-1].max()) if len(H) >= 11 else float(H.max())

    structural: bool = bool(
        float(c[-1]) > high10
        and (float(c[-1]) > sma20 or sma20_flattening)
    )

    # ── E: Strong close position ──────────────────────────────────────────────
    # Judge the actual signal candle, not the prior sell-off candles.
    def _cp(cl: float, hi: float, lo: float) -> float:
        rng = hi - lo
        return (cl - lo) / rng if rng > 0 else 0.5

    strong_close: bool = bool(
        (_cp(float(c[-1]), float(H[-1]), float(L[-1])) >= CLOSE_POSITION_THRESHOLD
         and _cp(float(c[-2]), float(H[-2]), float(L[-2])) >= CLOSE_POSITION_THRESHOLD)
        if three_higher else
        ((_cp(float(c[-1]), float(H[-1]), float(L[-1])) >= CLOSE_POSITION_THRESHOLD)
         if candle_today_move >= SINGLE_CANDLE_ATR_MULT and candle_today_vol >= SINGLE_CANDLE_VOL_MULT
         else (_cp(float(c[-2]), float(H[-2]), float(L[-2])) >= CLOSE_POSITION_THRESHOLD
               and float(c[-1]) >= float(c[-2])))
    )

    # ── Assemble ──────────────────────────────────────────────────────────────
    criteria: dict[str, bool] = {
        "downtrend_confirmed": bool(downtrend),
        "reversal_trigger":    bool(reversal),
        "volume_confirmation": bool(vol_ok),
        "structural_break":    bool(structural),
        "strong_close":        bool(strong_close),
    }

    # No reversal label without both a prior downtrend and a real reversal trigger.
    score: int = sum(criteria.values()) if downtrend and reversal else min(2, sum(criteria.values()))

    # Only caller-visible convictions are STRONG and WATCH; < 3 returns None
    # unless return_below=True (grey below-threshold rows for the full board).
    if score < 3:
        if not return_below:
            return None
        conviction_below: str = "LOW"
        metrics_below: dict = {
            "ret_20d":             round(ret_20d, 2),
            "sma20":               round(sma20, 2),
            "sma20_slope":         round(sma20_slope, 4),
            "sma20_flattening":    bool(sma20_flattening),
            "sma50":               round(sma50, 2),
            "sma50_slope":         round(slope50, 4),
            "three_higher_closes": bool(three_higher),
            "single_candle":       bool(single_candle),
            "atr14":               round(atr14, 4),
            "atr_move":            round(atr_move, 2),
            "vol_ratio":           round(vol_ratio, 2),
            "vol_today":           int(v[-1]),
            "vol_avg_20d":         int(vol20),
            "close_vs_sma20":      round(float(c[-1]) - sma20, 2),
            "high_10d":            round(high10, 2),
            "strong_close":        bool(strong_close),
        }
        return score, conviction_below, criteria, metrics_below

    conviction: str = "STRONG" if score == 5 else "WATCH"

    metrics: dict = {
        "ret_20d":             round(ret_20d, 2),
        "sma20":               round(sma20, 2),
        "sma20_slope":         round(sma20_slope, 4),
        "sma20_flattening":    bool(sma20_flattening),
        "sma50":               round(sma50, 2),
        "sma50_slope":         round(slope50, 4),
        "three_higher_closes": bool(three_higher),
        "single_candle":       bool(single_candle),
        "atr14":               round(atr14, 4),
        "atr_move":            round(atr_move, 2),
        "vol_ratio":           round(vol_ratio, 2),
        "vol_today":           int(v[-1]),
        "vol_avg_20d":         int(vol20),
        "close_vs_sma20":      round(float(c[-1]) - sma20, 2),
        "high_10d":            round(high10, 2),
        "strong_close":        bool(strong_close),
    }

    return score, conviction, criteria, metrics
