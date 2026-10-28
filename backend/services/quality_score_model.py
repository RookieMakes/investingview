"""Pure, candle-only Trend Quality model.

All mappings are fixed (not universe percentiles). Changing weights or mappings
requires a new MODEL_VERSION so unlike scores never share a history series.
"""

import math
from datetime import date

import numpy as np

MODEL_VERSION = "trend_quality_v2"
MIN_CANDLES = 253
# Relative OHLC tolerance (~0.2% of close) for feed noise and mid-settlement
# bars. A low printing above a high is always a broken bar.
OHLC_REL_TOL = 0.002
WEIGHTS = {"returns": 25, "consistency": 25, "downside": 20, "momentum": 20, "relative": 10}
LABELS = {
    "quality": "Quality uptrend",
    "stretched": "Strong but stretched",
    "emerging": "Emerging momentum",
    "deteriorating": "Deteriorating",
    "mixed": "Mixed trend",
    "weak": "Weak / downtrend",
    "excluded": "Not scored",
}


class InvalidCandles(ValueError):
    """An actionable exclusion, rather than a silently missing ticker."""


def benchmark_for(ticker):
    # Do not compare a CAD listing to a USD benchmark. Unmapped exchanges have
    # provisional scores rather than an assumed currency conversion.
    if ticker.endswith((".TO", ".V")):
        return "XIC.TO"
    return "SPY" if "." not in ticker else None


def _scale(value, low, high):
    return float(np.clip((value - low) / (high - low), 0, 1) * 100)


def _trend(closes):
    y = np.log(closes)
    x = np.arange(len(y), dtype=float)
    centered = y - y.mean()
    slope = float(np.dot(x - x.mean(), centered) / np.sum((x - x.mean()) ** 2))
    fitted = slope * (x - x.mean())
    variance = float(np.sum(centered ** 2))
    r_squared = max(0.0, min(1.0, 1 - float(np.sum((centered - fitted) ** 2)) / variance)) if variance > 1e-16 else 0.0
    changes = np.diff(y)
    travel = float(np.sum(np.abs(changes)))
    efficiency = float(changes.sum() / travel) if travel > 1e-12 else 0.0
    score = (50 * r_squared + 0.5 * _scale(efficiency, 0, 0.30)) if slope > 0 else 0.0
    return {"slope_daily": slope, "r_squared": r_squared, "efficiency": efficiency, "score": score}


def _validated(candles):
    if len(candles) < MIN_CANDLES:
        raise InvalidCandles(f"Insufficient history: {len(candles)}/{MIN_CANDLES} daily candles")
    candles = candles[-MIN_CANDLES:]
    try:
        dates = [date.fromisoformat(c["date"]) for c in candles]
        values = np.array([[c[k] for k in ("open", "high", "low", "close", "volume")]
                           for c in candles], dtype=float)
    except (KeyError, TypeError, ValueError) as exc:
        raise InvalidCandles("Invalid candle fields") from exc
    if any(a >= b for a, b in zip(dates, dates[1:])):
        raise InvalidCandles("Duplicate or unordered candle dates")
    if (dates[-1] - dates[0]).days > 400:
        raise InvalidCandles("Incomplete daily history: 252 returns span more than 400 days")
    if not np.isfinite(values).all() or (values[:, :4] <= 0).any() or (values[:, 4] < 0).any():
        raise InvalidCandles("Non-finite, nonpositive price or invalid volume")
    opens, highs, lows, closes, volumes = values.T
    wick_tol = OHLC_REL_TOL * closes
    if ((highs + wick_tol < np.maximum(opens, closes)) |
            (lows - wick_tol > np.minimum(opens, closes)) | (lows > highs)).any():
        raise InvalidCandles("Inconsistent OHLC candle")
    # Three consecutive zero-volume or identically repeated OHLCV bars in the
    # recent month warrant exclusion. Equal closes alone are perfectly valid.
    run = 0
    for i in range(len(values) - 21, len(values)):
        suspicious = volumes[i] == 0 or np.array_equal(values[i], values[i - 1])
        run = run + 1 if suspicious else 0
        if run >= 3:
            raise InvalidCandles("Three consecutive inactive/repeated daily candles")
    if closes[-1] < 3:
        raise InvalidCandles("Price below 3 in listing currency")
    if np.median(closes[-63:] * volumes[-63:]) < 1_000_000:
        raise InvalidCandles("Median 63-session turnover below 1M in listing currency")
    return candles, values


def compute_trend_quality(candles, benchmark_candles=None, benchmark_symbol="SPY"):
    """Score validated, consistently adjusted daily OHLCV, oldest first.

    Fractions (returns, drawdowns, relative return) are not percentage points.
    Missing/unmatched benchmark endpoints remove only its 10% weight.
    """
    candles, values = _validated(candles)
    opens, highs, lows, closes, volumes = values.T
    returns = {n: float(closes[-1] / closes[-n - 1] - 1) for n in (21, 63, 126, 252)}
    logs = np.diff(np.log(closes))
    trend63, trend126 = _trend(closes[-64:]), _trend(closes[-127:])
    consistency = 0.4 * trend63["score"] + 0.6 * trend126["score"]

    path = closes[-127:]
    drawdowns = path / np.maximum.accumulate(path) - 1
    max_drawdown, current_drawdown = float(drawdowns.min()), float(drawdowns[-1])
    underwater = float(np.mean(drawdowns[1:] < -1e-8))
    downside_deviation = float(np.sqrt(np.mean(np.minimum(logs[-126:], 0) ** 2) * 252))
    sma50, sma200 = float(closes[-50:].mean()), float(closes[-200:].mean())
    slope50 = float(sma50 / closes[-71:-21].mean() - 1)
    slope200 = float(sma200 / closes[-221:-21].mean() - 1)
    above50, above200 = bool(closes[-1] > sma50), bool(closes[-1] > sma200)
    true_ranges = np.maximum(highs[1:] - lows[1:],
                             np.maximum(np.abs(highs[1:] - closes[:-1]), np.abs(lows[1:] - closes[:-1])))
    atr = float(true_ranges[-14:].mean())
    extension = float((closes[-1] - sma50) / atr) if atr > 1e-8 else None

    components = {
        "returns": (0.15 * _scale(returns[21], 0, 0.08) + 0.40 * _scale(returns[63], 0, 0.20)
                    + 0.45 * _scale(returns[126], 0, 0.35)),
        "consistency": consistency,
        "downside": (0.45 * _scale(max_drawdown, -0.40, -0.05)
                     + 0.20 * _scale(current_drawdown, -0.25, 0)
                     + 0.25 * (100 - _scale(downside_deviation, 0.08, 0.45))
                     + 0.10 * (1 - underwater) * 100),
        "momentum": (25 * above50 + 25 * above200 + 0.15 * _scale(slope50, -0.03, 0.03)
                     + 0.15 * _scale(slope200, -0.01, 0.01) + 0.20 * _scale(returns[21], -0.05, 0.10)),
        "relative": None,
    }
    benchmark = {c["date"]: c.get("close") for c in (benchmark_candles or [])}
    excess = {}
    benchmark_reason = "Benchmark unavailable or dates not aligned"
    try:
        # Match exact stock endpoints, never substitute a nearby benchmark day.
        for n in (63, 126):
            start = float(benchmark[candles[-n - 1]["date"]])
            end = float(benchmark[candles[-1]["date"]])
            if not (math.isfinite(start) and math.isfinite(end) and start > 0 and end > 0):
                raise ValueError("Invalid benchmark price")
            excess[n] = math.log1p(returns[n]) - math.log(end / start)
        components["relative"] = 0.4 * _scale(excess[63], -0.10, 0.10) + 0.6 * _scale(excess[126], -0.20, 0.20)
        benchmark_reason = None
    except (KeyError, TypeError, ValueError):
        excess = {}
    if not benchmark_symbol:
        benchmark_reason = "No same-currency benchmark configured for this listing"
    available_weight = sum(WEIGHTS[k] for k, v in components.items() if v is not None)
    score = sum(WEIGHTS[k] * v for k, v in components.items() if v is not None) / available_weight

    established = (returns[63] > 0 and returns[126] > 0 and above50 and above200
                   and slope50 > 0 and slope200 > 0 and consistency >= 55 and max_drawdown >= -0.25)
    if returns[126] > 0 and ((not above50 and slope50 < 0) or returns[21] < -0.08):
        state = "deteriorating"
    elif established and score >= 70:
        state = "stretched" if extension is not None and extension > 3 else "quality"
    elif returns[21] > 0 and returns[63] > 0 and above50 and slope50 > 0:
        state = "emerging"
    elif returns[63] <= 0 or not above200:
        state = "weak"
    else:
        state = "mixed"

    flags = []
    if extension is not None and extension > 3:
        flags.append("Price more than 3 ATR above the 50-day average")
    up = logs[-63:] > 0
    down = logs[-63:] < 0
    up_volume = float(volumes[-63:][up].mean()) if up.any() else None
    down_volume = float(volumes[-63:][down].mean()) if down.any() else None
    volume_ratio = up_volume / down_volume if up_volume is not None and down_volume else None
    if volume_ratio is not None:
        flags.append("Higher volume on advancing days" if volume_ratio >= 1.2 else
                     "Higher volume on declining days" if volume_ratio <= 0.8 else "Balanced up/down volume")
    if closes[-1] > highs[-21:-1].max() and volumes[-1] > 1.5 * volumes[-21:-1].mean():
        flags.append("20-session breakout on elevated volume")

    result = {
        "model_version": MODEL_VERSION, "score": round(score, 4),
        "components": {k: round(v, 2) if v is not None else None for k, v in components.items()},
        "component_weights": {k: round(100 * w / available_weight, 4) if components[k] is not None else 0
                              for k, w in WEIGHTS.items()},
        "assessment": LABELS[state], "state": state, "insufficient_data": False,
        "exclusion_reason": None, "provisional": components["relative"] is None,
        "benchmark": benchmark_symbol, "benchmark_reason": benchmark_reason,
        "relative_3m": math.expm1(excess[63]) if excess else None,
        "relative_6m": math.expm1(excess[126]) if excess else None,
        "price": float(closes[-1]), "data_as_of": candles[-1]["date"],
        "r_1m": returns[21], "r_3m": returns[63], "r_6m": returns[126], "r_12m": returns[252],
        "consistency_label": "Strong" if consistency >= 70 else "Moderate" if consistency >= 40 else "Low",
        "trend_3m": trend63, "trend_6m": trend126,
        "max_drawdown": max_drawdown, "current_drawdown": current_drawdown,
        "underwater_fraction": underwater, "downside_deviation": downside_deviation,
        "sma50": sma50, "sma200": sma200, "sma50_change_21d": slope50, "sma200_change_21d": slope200,
        "above_sma50": above50, "above_sma200": above200,
        "atr14": atr, "extension_atr": extension, "up_down_volume_ratio": volume_ratio, "flags": flags,
    }
    if not math.isfinite(score):
        raise InvalidCandles("Non-finite calculated score")
    return result
