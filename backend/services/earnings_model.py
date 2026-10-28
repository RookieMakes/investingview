"""Pure, versioned Earnings Watchlist model. No fetching or persistence.

All returns are percentage points. A score requires 21 valid stock closes on
the expected US sessions and 11 benchmark closes on the same ending sessions.
"""

import math
import statistics
from datetime import date, timedelta
from functools import lru_cache
from zoneinfo import ZoneInfo

MODEL_VERSION = "earnings-momentum-v2"
ET = ZoneInfo("America/New_York")
WEIGHTS = {"momentum_10d": 40, "momentum_3d": 25, "relative_strength": 25, "consistency": 10}
VOLATILITY_FLOOR = 0.5
FLAT_THRESHOLD = 0.15


def _nth_weekday(year, month, weekday, n):
    day = date(year, month, 1)
    return day + timedelta(days=(weekday - day.weekday()) % 7 + 7 * (n - 1))


def _observed(day):
    return day + timedelta(days=-1 if day.weekday() == 5 else 1 if day.weekday() == 6 else 0)


@lru_cache(maxsize=16)
def market_holidays(year):
    """Regular NYSE full-day closures, plus recent extraordinary closures.

    Saturday New Year's Day is not observed on the preceding NYSE Friday.
    Early closes remain sessions; the model conservatively waits until 16:05 ET
    even on those days, matching the existing daily snapshot schedule.
    """
    # Gregorian Easter (Meeus/Jones/Butcher) for Good Friday.
    a, b, c = year % 19, year // 100, year % 100
    d, e = b // 4, b % 4
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = c // 4, c % 4
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    easter = date(year, (h + l - 7 * m + 114) // 31, (h + l - 7 * m + 114) % 31 + 1)
    memorial = date(year, 5, 31)
    memorial -= timedelta(days=memorial.weekday())
    holidays = {
        _nth_weekday(year, 1, 0, 3), _nth_weekday(year, 2, 0, 3),
        easter - timedelta(days=2), memorial, _observed(date(year, 7, 4)),
        _nth_weekday(year, 9, 0, 1), _nth_weekday(year, 11, 3, 4),
        _observed(date(year, 12, 25)),
    }
    new_year = date(year, 1, 1)
    if new_year.weekday() != 5:
        holidays.add(_observed(new_year))
    if year >= 2022:
        holidays.add(_observed(date(year, 6, 19)))
    if year == 2025:
        holidays.add(date(2025, 1, 9))  # National day of mourning.
    return holidays


def is_session(day):
    return day.weekday() < 5 and day not in market_holidays(day.year)


def completed_session(now):
    """Latest session eligible for the close-based screen (never intraday)."""
    now = now.astimezone(ET)
    day = now.date()
    if (now.hour, now.minute) < (16, 5):
        day -= timedelta(days=1)
    while not is_session(day):
        day -= timedelta(days=1)
    return day


def session_window(end, count=21):
    days = []
    while len(days) < count:
        if is_session(end):
            days.append(end.isoformat())
        end -= timedelta(days=1)
    return list(reversed(days))


def valid_close(value):
    return (isinstance(value, (int, float)) and not isinstance(value, bool)
            and math.isfinite(value) and value > 0)


def _return(start, end):
    return 100 * (end / start - 1)


def _clamp(value):
    return max(-1.0, min(1.0, value))


def calculate_score(history, benchmark, dates):
    """Return display metrics plus a score, or an explicit exclusion reason.

    Missing sessions are never bridged, forward-filled, or replaced with zero.
    Histories are date-keyed so positional misalignment cannot affect RS.
    """
    closes = {r["date"]: r["close"] for r in history if valid_close(r.get("close"))}
    spy = {r["date"]: r["close"] for r in benchmark if valid_close(r.get("close"))}
    expected = dates[-21:]
    recent = expected[-11:]
    result = {
        "score": None, "score_status": "incomplete", "score_reason": None,
        "return_10d": None, "return_3d": None, "rs_10d": None,
        "volatility_20d": None, "streak": None, "components": None,
        "coverage": sum(day in closes for day in expected), "required_closes": 21,
    }
    if len(recent) == 11 and all(day in closes for day in recent):
        result["return_10d"] = _return(closes[recent[0]], closes[recent[-1]])
        result["return_3d"] = _return(closes[recent[-4]], closes[recent[-1]])
        if all(day in spy for day in recent):
            result["rs_10d"] = result["return_10d"] - _return(spy[recent[0]], spy[recent[-1]])
        returns = [_return(closes[a], closes[b]) for a, b in zip(recent, recent[1:])]
        directions = [1 if r > FLAT_THRESHOLD else -1 if r < -FLAT_THRESHOLD else 0 for r in returns]
        streak = 0
        for direction in reversed(directions):
            if direction == 0 or direction != directions[-1]:
                break
            streak += direction
        result["streak"] = streak

    if not expected or expected[-1] not in closes:
        result.update(score_status="stale" if closes else "missing",
                      score_reason="No valid close for the expected session")
    elif len(expected) != 21 or result["coverage"] != 21:
        result["score_reason"] = "Need 21 valid closes on the same US trading sessions"
    elif result["rs_10d"] is None:
        result.update(score_status="benchmark_missing", score_reason="SPY is missing a required matching session")
    else:
        returns_20 = [_return(closes[a], closes[b]) for a, b in zip(expected, expected[1:])]
        volatility = statistics.stdev(returns_20)
        scale = max(volatility, VOLATILITY_FLOOR)
        consistency = sum(d * (2 if i >= 7 else 1) for i, d in enumerate(directions)) / 13
        nonflat = [d for d in directions if d]
        flips = sum(a != b for a, b in zip(nonflat, nonflat[1:]))
        chop = flips / max(1, len(nonflat) - 1)
        factors = {
            "momentum_10d": _clamp(result["return_10d"] / (2 * scale * math.sqrt(10))),
            "momentum_3d": _clamp(result["return_3d"] / (2 * scale * math.sqrt(3))),
            "relative_strength": _clamp(result["rs_10d"] / (2 * scale * math.sqrt(10))),
            "consistency": consistency,
        }
        contributions = {key: WEIGHTS[key] * value for key, value in factors.items()}
        raw = sum(contributions.values())
        multiplier = 1 - 0.3 * chop
        result.update(
            score=round(raw * multiplier, 2), score_status="ready", score_reason=None,
            volatility_20d=volatility,
            components={**{k: round(v, 4) for k, v in contributions.items()},
                        "raw_score": round(raw, 4), "choppiness": round(chop, 4),
                        "chop_multiplier": round(multiplier, 4), "volatility_used": round(scale, 4)},
        )
    for key in ("return_10d", "return_3d", "rs_10d", "volatility_20d"):
        if result[key] is not None:
            result[key] = round(result[key], 4)
    return result
