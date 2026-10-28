"""Trade-only, completed-session screening and indicative entry planning.

Scores are explainable heuristics, not probabilities. No shared fetcher, scheduler,
portfolio, or execution state is used by this module.
"""

import logging
from datetime import datetime
import math

import yfinance as yf
import pandas as pd
import numpy as np

logger = logging.getLogger(__name__)

MIN_REWARD_RISK = 2.0
MIN_UPSIDE = {"swing": 3.0, "position": 10.0}
HOLD_SESSIONS = {"swing": 15, "position": 50}
SR_CONFIRM_BARS = 5
SR_LOOKBACK_BARS = 90
SR_MIN_DISTANCE_PCT = 2.0
BULLISH_PATTERNS = ("Bullish Engulfing", "Hammer", "Bullish Marubozu")
BEARISH_PATTERNS = ("Bearish Engulfing", "Shooting Star", "Bearish Marubozu")


def number(value):
    """Finite number or unknown; preserve legitimate zero values."""
    if value is None or isinstance(value, bool):
        return None
    try:
        result = float(value)
        return result if math.isfinite(result) else None
    except (TypeError, ValueError, OverflowError):
        return None


def _today(as_of=None):
    return pd.Timestamp(as_of or datetime.now().astimezone()).date()


def prepare_history(hist, as_of=None, weekly=False):
    """Normalize exchange-local session dates and use only completed prior bars.

    Conservatively exclude today's daily bar even after the close. Weekly bars
    must precede the current Monday. This works without guessing exchange hours.
    Invalid OHLC rows are excluded and reported, never forward-filled.
    """
    required = ["Open", "High", "Low", "Close", "Volume"]
    if hist is None or hist.empty or any(c not in hist for c in required):
        return pd.DataFrame(columns=required)
    frame = hist[required].copy()
    index = pd.DatetimeIndex(pd.to_datetime(frame.index))
    frame.index = index.tz_localize(None).normalize() if index.tz else index.normalize()
    frame = frame[~frame.index.duplicated(keep="last")].sort_index()
    cutoff = pd.Timestamp(_today(as_of))
    if weekly:
        cutoff -= pd.Timedelta(days=cutoff.weekday())
    frame = frame.loc[frame.index < cutoff]
    for col in required:
        frame[col] = pd.to_numeric(frame[col], errors="coerce").replace([np.inf, -np.inf], np.nan)
    valid = (frame[["Open", "High", "Low", "Close"]].notna().all(axis=1)
             & (frame[["Open", "High", "Low", "Close"]] > 0).all(axis=1)
             & (frame["High"] >= frame[["Open", "Close", "Low"]].max(axis=1))
             & (frame["Low"] <= frame[["Open", "Close", "High"]].min(axis=1)))
    dropped = int((~valid).sum())
    frame = frame.loc[valid].copy()
    frame.loc[frame["Volume"] < 0, "Volume"] = np.nan
    frame.attrs["invalid_bars"] = dropped
    return frame


# ═══════════════════════════════════════════════════════════════════════════════
#  DATA HELPERS
# ═══════════════════════════════════════════════════════════════════════════════

def get_ticker_data(ticker: str, trade_type="swing"):
    stock = yf.Ticker(ticker)
    try:
        info = stock.info or {}
    except Exception as exc:
        logger.warning("Trade metadata unavailable for %s: %s", ticker, exc)
        info = {}
    histories = []
    for period, interval in (("5y", "1d"), ("10y", "1wk")):
        if interval == "1wk" and trade_type == "swing":
            histories.append(pd.DataFrame())
            continue
        try:
            histories.append(stock.history(period=period, interval=interval, auto_adjust=True))
        except Exception as exc:
            logger.warning("Trade %s history unavailable for %s: %s", interval, ticker, exc)
            histories.append(pd.DataFrame())
    return stock, info, *histories


def calculate_ema(series: pd.Series, period: int):
    """Same five-bar EMA delta for presentation and scoring; never round inputs."""
    if series is None or len(series) < period + 5 or not np.isfinite(series).all():
        return None, None, None
    ema = series.ewm(span=period, adjust=False).mean()
    current = float(ema.iloc[-1])
    price = float(series.iloc[-1])
    look_back = min(5, len(ema) - 1)
    prior = float(ema.iloc[-1 - look_back])
    slope = "rising" if current > prior else "falling" if current < prior else "flat"
    pos = "above" if price > current else "below" if price < current else "at"
    return current, pos, slope


def get_current_price(info: dict, hist: pd.DataFrame) -> float:
    # A quote must never be mixed with older adjusted OHLC values.
    if not hist.empty:
        return float(hist["Close"].iloc[-1])
    return 0.0


def get_day_range(info: dict, hist: pd.DataFrame):
    if not hist.empty:
        r = hist.tail(1)
        return float(r["Low"].iloc[-1]), float(r["High"].iloc[-1])
    return 0.0, 0.0


def get_52week_range(hist: pd.DataFrame):
    """Long EMA warm-up history must not expand the displayed 52-week range."""
    if not hist.empty:
        recent = hist.loc[hist.index > hist.index[-1] - pd.DateOffset(years=1)]
        return float(recent["Low"].min()), float(recent["High"].max())
    return None, None


def get_ytd_change(hist: pd.DataFrame):
    if hist.empty:
        return None
    year = hist.index[-1].year
    previous = hist.loc[hist.index.year == year - 1, "Close"]
    if previous.empty:
        return None
    return (float(hist["Close"].iloc[-1]) / float(previous.iloc[-1]) - 1) * 100


def detect_candlestick(df: pd.DataFrame) -> tuple:
    """Returns (pattern_name, context_string)."""
    if df is None or len(df) < 2:
        return "No significant pattern", "insufficient data"
    last = df.iloc[-1]
    prev = df.iloc[-2]
    o = float(last["Open"])
    c = float(last["Close"])
    h = float(last["High"])
    l = float(last["Low"])
    po = float(prev["Open"])
    pc = float(prev["Close"])
    body = abs(c - o)
    upper_sh = h - max(c, o)
    lower_sh = min(c, o) - l
    candle_range = h - l
    if candle_range <= 0:
        return "No significant pattern", "zero-range candle"
    if body <= candle_range * 0.10:
        return "Doji", "indecision; directional confirmation required"
    # Reversal names need a preceding trend, not just a matching candle shape.
    downtrend = len(df) >= 6 and float(df["Close"].iloc[-2]) < float(df["Close"].iloc[-6])
    uptrend = len(df) >= 6 and float(df["Close"].iloc[-2]) > float(df["Close"].iloc[-6])
    if downtrend and c > o and pc < po and c >= po and o <= pc:
        return "Bullish Engulfing", "bullish reversal signal"
    if uptrend and c < o and pc > po and c <= po and o >= pc:
        return "Bearish Engulfing", "bearish reversal signal"
    if downtrend and lower_sh >= body * 2 and upper_sh <= candle_range * 0.10:
        return "Hammer", "potential bullish reversal"
    if uptrend and lower_sh <= candle_range * 0.10 and upper_sh >= body * 2:
        return "Shooting Star", "potential bearish reversal"
    small_shadows = max(upper_sh, lower_sh) <= candle_range * 0.10
    if c > o and body >= candle_range * 0.80 and small_shadows:
        return "Bullish Marubozu", "strong buying pressure"
    if c < o and body >= candle_range * 0.80 and small_shadows:
        return "Bearish Marubozu", "strong selling pressure"
    return "No significant pattern", "neutral"


def get_weinstein_stage(price: float, hist: pd.DataFrame) -> tuple:
    """A 150-session stage estimate, not independent breakout confirmation."""
    if hist.empty or len(hist) < 160:
        return None, "insufficient data (need 160 completed sessions)"
    ma150 = hist["Close"].rolling(150).mean()
    cur = float(ma150.iloc[-1])
    prior = float(ma150.iloc[-11])
    if number(cur) is None or number(prior) is None:
        return None, "insufficient finite moving-average history"
    above = price > cur
    rising = cur > prior
    if above and rising:
        return 2, "Advancing — price above rising 150-session MA"
    if above and not rising:
        return 3, "Topping — price stalling near highs"
    if not above and rising:
        return 1, "Basing — price near flattening/rising 150-session MA"
    return 4, "Declining — price below declining 150-session MA"


def analyze_support_resistance(hist: pd.DataFrame, window: int = SR_LOOKBACK_BARS):
    """Most-recent qualifying swings from completed daily bars (Pine S/R rules).

    ``window`` is the oldest candidate's offset from the analysis bar, inclusive.
    Each candidate needs SR_CONFIRM_BARS on both sides, so the oldest candidate
    needs additional history beyond the lookback. Equal highs/lows qualify.
    Each side is selected independently; absent swings remain unknown.
    """
    if hist.empty:
        return None, None, None
    price = float(hist["Close"].iloc[-1])
    distance = SR_MIN_DISTANCE_PCT / 100
    support, resistance = None, None
    last = len(hist) - 1
    oldest = min(window, last - SR_CONFIRM_BARS)
    # Scan newest first, including a candidate exactly `window` bars ago.
    for bars_ago in range(SR_CONFIRM_BARS, oldest + 1):
        i = last - bars_ago
        block = hist.iloc[i - SR_CONFIRM_BARS:i + SR_CONFIRM_BARS + 1]
        low, high = float(hist["Low"].iloc[i]), float(hist["High"].iloc[i])
        if resistance is None and high >= price * (1 + distance) and high == float(block["High"].max()):
            resistance = high
        if support is None and low <= price * (1 - distance) and low == float(block["Low"].min()):
            support = low
        if support is not None and resistance is not None:
            break
    return support, resistance, price


def get_volume_info(hist: pd.DataFrame, info: dict) -> dict:
    if hist.empty:
        return {"vol_today": None, "vol_avg": None, "vol_ratio": None}
    vol_today = number(hist["Volume"].iloc[-1])
    previous = hist["Volume"].iloc[-21:-1]
    vol_avg = number(previous.mean()) if len(previous) == 20 and previous.notna().all() else None
    ratio = vol_today / vol_avg if vol_today is not None and vol_avg and vol_avg > 0 else None
    return {"vol_today": vol_today, "vol_avg": vol_avg, "vol_ratio": ratio}


def get_relative_strength(hist: pd.DataFrame, spy=None, as_of=None) -> dict:
    """Percentage-point excess returns on exactly aligned completed dates."""
    unknown = {"rs_1m": None, "rs_3m": None, "label": "Unknown"}
    try:
        if spy is None:
            spy = yf.Ticker("SPY").history(period="2y", interval="1d", auto_adjust=True)
        spy = prepare_history(spy, as_of)
        if spy.empty or hist.empty or hist.index[-1] != spy.index[-1]:
            return unknown
        aligned = pd.concat([hist["Close"].rename("stock"), spy["Close"].rename("spy")], axis=1, join="inner").dropna()
        values = {}
        for key, sessions in (("rs_1m", 21), ("rs_3m", 63)):
            change = aligned.iloc[-1] / aligned.iloc[-sessions - 1] - 1 if len(aligned) > sessions else None
            values[key] = float((change["stock"] - change["spy"]) * 100) if change is not None else None
        rs1m = values["rs_1m"]
        values["label"] = "Unknown" if rs1m is None else "Outperforming" if rs1m > 2 else "Underperforming" if rs1m < -2 else "Neutral"
        return values
    except Exception as exc:
        logger.warning("Trade benchmark unavailable: %s", exc)
        return unknown


def earnings_status(info, calendar, trade_type, as_of=None):
    """Calendar-date ranges and quote timestamps; absence is never a clear event window."""
    today = _today(as_of)
    # Weekdays plus a calendar-week holiday buffer; deliberately conservative.
    end = (pd.Timestamp(today) + pd.offsets.BDay(HOLD_SESSIONS[trade_type]) + pd.Timedelta(days=7)).date()
    result = {"status": "unknown", "date": None, "window_end": end.isoformat(),
              "description": "Earnings date unavailable"}
    if info.get("quoteType") in ("ETF", "MUTUALFUND"):
        return {**result, "status": "not_applicable", "description": "Not applicable to this fund"}
    raw = calendar.get("Earnings Date") if isinstance(calendar, dict) else None
    if isinstance(calendar, pd.DataFrame) and "Earnings Date" in calendar.index:
        raw = calendar.loc["Earnings Date"].tolist()
    def dates(value):
        if isinstance(value, (list, tuple, np.ndarray, pd.Series)):
            return [d for item in value for d in dates(item)]
        if value is None:
            return []
        try:
            stamp = pd.Timestamp(value, unit="s", tz="UTC") if isinstance(value, (int, float)) else pd.Timestamp(value)
            return [] if pd.isna(stamp) else [stamp.date()]
        except (ValueError, TypeError, OverflowError):
            return []
    # The quote's generic earningsTimestamp can be the previous quarter. Do not
    # combine it with the next estimated range and mistake them for one event.
    sources = [raw, info.get("earningsDate"),
               [info.get("earningsTimestampStart"), info.get("earningsTimestampEnd")],
               info.get("earningsTimestamp")]
    candidates = next((parsed for source in sources if (parsed := dates(source))
                       and any(day >= today for day in parsed)), [])
    future = [day for day in candidates if day >= today]
    if not future:
        return result
    event = min(future)
    # If a reported range straddles today, the event is not safely in the past.
    if min(candidates) < today <= max(candidates):
        event = today
    status = "upcoming" if event <= end else "clear"
    description = f"{event.isoformat()} — " + ("within holding window" if status == "upcoming" else "outside holding window")
    return {**result, "status": status, "date": event.isoformat(), "description": description}


def institutional_ownership(info):
    for key in ("heldPercentInstitutions", "institutionPercentHeld"):
        value = number(info.get(key))
        if value is not None and value >= 0:
            return value
    return None


# ═══════════════════════════════════════════════════════════════════════════════
#  SWING SCORING  (multi-factor, real logic)
# ═══════════════════════════════════════════════════════════════════════════════

def score_swing(price, ema_20, ema_50, ema_200, ema20_slope,
                close_pos, pattern, earnings_near,
                support, resistance, vol_ratio,
                day_pct, week_pct) -> tuple:
    """
    Returns a provisional setup verdict, score, reasons and measured target.
    Final entry eligibility is evaluated separately by entry_readiness().

    Each reason is a {"type": "positive"|"neutral"|"negative", "text": str, "score": int}
    dict for frontend color-coded capsule rendering.
    """
    score = 0
    reasons = []

    # -- Trend: EMA20 position (0-2 pts) --
    if ema_20 is not None:
        if price > ema_20:
            score += 2
            reasons.append({"type": "positive", "text": "Above EMA20 ✓", "score": 2})
        elif ema_20 > 0 and abs(price - ema_20) / ema_20 < 0.015:
            score += 1
            reasons.append({"type": "neutral", "text": "Near EMA20 support", "score": 1})
        else:
            reasons.append({"type": "neutral", "text": "Below EMA20", "score": 0})

    # -- Trend: EMA alignment (0-1 pt) --
    if ema_20 is not None and ema_50 is not None:
        if ema_20 > ema_50:
            score += 1
            reasons.append({"type": "positive", "text": "EMA20 > EMA50 ✓", "score": 1})
        else:
            reasons.append({"type": "neutral", "text": "EMA20 ≤ EMA50", "score": 0})

    # -- Trend: EMA20 slope (0-1 pt) --
    if ema20_slope is not None and ema20_slope > 0:
        score += 1
        reasons.append({"type": "positive", "text": "Rising EMA20 slope ✓", "score": 1})
    else:
        reasons.append({"type": "neutral", "text": "Flat/falling slope", "score": 0})

    # -- Momentum: Day change (0-1 pt) --
    if day_pct is not None and day_pct > 0:
        score += 1
        reasons.append({"type": "positive", "text": f"Positive day +{day_pct:.1f}% ✓", "score": 1})
    else:
        reasons.append({"type": "neutral", "text": "Flat/red day", "score": 0})

    # -- Momentum: Week change (0-1 pt) --
    if week_pct is not None and week_pct > 0:
        score += 1
        reasons.append({"type": "positive", "text": f"Positive week +{week_pct:.1f}% ✓", "score": 1})
    else:
        reasons.append({"type": "neutral", "text": "Flat/red week", "score": 0})

    # -- Momentum: Close position (0-1 pt) --
    if close_pos is not None and close_pos >= 0.65:
        score += 1
        reasons.append({"type": "positive", "text": f"Strong close {close_pos:.0%} ✓", "score": 1})
    else:
        reasons.append({"type": "neutral", "text": "Weak close", "score": 0})

    # -- Technicals: Volume (0-1 pt) --
    if vol_ratio is not None and vol_ratio >= 1.5:
        score += 1
        reasons.append({"type": "positive", "text": f"Volume surge {vol_ratio:.1f}x ✓", "score": 1})
    else:
        reasons.append({"type": "neutral", "text": "Normal volume", "score": 0})

    # -- Technicals: Candlestick pattern (bullish + bearish pills) --
    bullish_patterns = BULLISH_PATTERNS
    bearish_patterns = BEARISH_PATTERNS
    if pattern:
        if pattern in bullish_patterns:
            score += 1
            reasons.append({"type": "positive", "text": f"Bullish pattern: {pattern} ✓", "score": 1})
        else:
            reasons.append({"type": "neutral", "text": "No bullish pattern", "score": 0})

        if pattern in bearish_patterns:
            score -= 2
            reasons.append({"type": "negative", "text": f"Bearish pattern: {pattern} ✗", "score": -2})
        else:
            reasons.append({"type": "positive", "text": "No bearish pattern", "score": 0})

    # -- Technicals: Room to resistance (0-1 pt) --
    if resistance and price > 0:
        if price < resistance * 0.97:
            score += 1
            reasons.append({"type": "positive", "text": f"Room to resistance (${resistance:.2f}) ✓", "score": 1})
        else:
            reasons.append({"type": "neutral", "text": "Near resistance", "score": 0})

    # -- Risk: EMA200 position (-1 / 0 pts) --
    if ema_200 is not None:
        if price < ema_200:
            score -= 1
            reasons.append({"type": "negative", "text": "Below EMA200 ⚠", "score": -1})
        else:
            reasons.append({"type": "positive", "text": "Above EMA200", "score": 0})

    # -- Risk: Earnings risk (-2 / 0 pts) --
    if earnings_near is True:
        score -= 2
        reasons.append({"type": "negative", "text": "Earnings within holding window ⚠", "score": -2})
    elif earnings_near is False:
        reasons.append({"type": "positive", "text": "Earnings clear", "score": 0})
    else:
        reasons.append({"type": "neutral", "text": "Earnings unknown", "score": 0})

    MAX_SCORE = 10
    verdict = "YES" if score >= 6 else "WATCH" if score >= 4 else "NO"

    # No fabricated percentage target when price is above known resistance.
    if resistance and resistance > price:
        target = resistance
        upside = (target - price) / price * 100
    else:
        target, upside = None, None

    return verdict, score, MAX_SCORE, reasons, target, upside


# ═══════════════════════════════════════════════════════════════════════════════
#  POSITION SCORING
# ═══════════════════════════════════════════════════════════════════════════════

def score_position(price, stage, wema_50, wema_200,
                    ytd_pct, revenue_growth, earnings_growth,
                    target_level, low_52w, rs_label, inst_pct) -> tuple:
    """
    Returns (verdict, score, max_score, reasons, confidence, target, upside_pct)

    Each reason is a {"type": "positive"|"neutral"|"negative", "text": str, "score": int}
    dict for frontend color-coded capsule rendering.
    """
    score = 0
    reasons = []

    # -- Weinstein Stage (-2 to +3 pts) --
    if stage is not None:
        if stage == 2:
            score += 3
            reasons.append({"type": "positive", "text": "Stage 2 Advancing ✓✓✓", "score": 3})
        elif stage == 1:
            score += 1
            reasons.append({"type": "neutral", "text": "Stage 1 Basing", "score": 1})
        elif stage == 3:
            score -= 1
            reasons.append({"type": "negative", "text": "Stage 3 Topping — late-cycle risk ✗", "score": -1})
        elif stage == 4:
            score -= 2
            reasons.append({"type": "negative", "text": "Stage 4 Declining — avoid ✗✗", "score": -2})

    # -- Weekly EMA structure (0-3 pts) --
    if wema_50 is not None:
        if price > wema_50:
            score += 2
            reasons.append({"type": "positive", "text": "Price above 50W EMA ✓", "score": 2})
        else:
            reasons.append({"type": "neutral", "text": "Below 50W EMA", "score": 0})

    if wema_200 is not None:
        if price > wema_200:
            score += 1
            reasons.append({"type": "positive", "text": "Price above 200W EMA ✓", "score": 1})
        else:
            reasons.append({"type": "neutral", "text": "Below 200W EMA", "score": 0})

    # -- Fundamentals (0-2 pts) --
    if revenue_growth is not None:
        if revenue_growth > 0.05:
            score += 1
            reasons.append({"type": "positive", "text": f"Revenue growth +{revenue_growth*100:.1f}% ✓", "score": 1})
        else:
            reasons.append({"type": "neutral", "text": "Revenue growth weak", "score": 0})

    if earnings_growth is not None:
        if earnings_growth > 0.05:
            score += 1
            reasons.append({"type": "positive", "text": f"Earnings growth +{earnings_growth*100:.1f}% ✓", "score": 1})
        else:
            reasons.append({"type": "neutral", "text": "Earnings growth weak", "score": 0})

    # -- Upside potential (0-2 pts) --
    if target_level and target_level > price:
        target_upside = (target_level - price) / price * 100
        if target_upside >= 20:
            score += 2
            reasons.append({"type": "positive", "text": f"+{target_upside:.1f}% to resistance ✓✓", "score": 2})
        elif target_upside >= 10:
            score += 1
            reasons.append({"type": "positive", "text": f"+{target_upside:.1f}% to resistance ✓", "score": 1})
        else:
            reasons.append({"type": "neutral", "text": "Minimal upside to resistance", "score": 0})
    else:
        reasons.append({"type": "neutral", "text": "No measured upside target", "score": 0})

    # -- Relative strength vs SPY (0-1 pt) --
    if rs_label == "Outperforming":
        score += 1
        reasons.append({"type": "positive", "text": "Outperforming SPY ✓", "score": 1})
    else:
        reasons.append({"type": "neutral", "text": f"RS vs SPY: {rs_label}", "score": 0})

    # -- Institutional ownership (0-1 pt) --
    if inst_pct is not None:
        if inst_pct > 0.60:
            score += 1
            reasons.append({"type": "positive", "text": f"Strong institutional ownership {inst_pct*100:.0f}% ✓", "score": 1})
        else:
            reasons.append({"type": "neutral", "text": "Institutional ownership low", "score": 0})

    # -- YTD momentum (-1 to +1 pt) --
    if ytd_pct is not None:
        if ytd_pct > 5:
            score += 1
            reasons.append({"type": "positive", "text": f"YTD +{ytd_pct:.1f}% ✓", "score": 1})
        elif ytd_pct < -15:
            score -= 1
            reasons.append({"type": "negative", "text": f"YTD {ytd_pct:.1f}% headwind ✗", "score": -1})
        else:
            reasons.append({"type": "neutral", "text": "YTD flat", "score": 0})

    MAX_SCORE = 13
    target = target_level if target_level and target_level > price else None
    upside = (target - price) / price * 100 if target is not None else None

    if stage == 4:
        verdict, confidence = "NO", "—"
    elif stage == 3:
        verdict, confidence = ("WATCH", "Low") if score >= 4 else ("NO", "—")
    elif score >= 7 and upside is not None and upside >= 15:
        verdict = "YES"
        confidence = "High"
    elif score >= 5 and upside is not None and upside >= 10:
        verdict = "YES"
        confidence = "Moderate"
    elif score >= 4:
        verdict = "WATCH"
        confidence = "Low"
    else:
        verdict = "NO"
        confidence = "—"

    return verdict, score, MAX_SCORE, reasons, confidence, target, upside


# ═══════════════════════════════════════════════════════════════════════════════
#  HEURISTIC TRADE NOTE  (no LLM)
# ═══════════════════════════════════════════════════════════════════════════════

def get_heuristic_trade_note(ticker, verdict, score, max_score, trade_type) -> str:
    hold = "5-15 sessions" if trade_type == "swing" else "20-50 sessions"
    if verdict == "YES":
        return (
            f"{ticker} meets the {trade_type} setup and entry rules at the analysis close "
            f"(score {score}/{max_score}; {hold}). Recheck levels before entry. "
            "The score is heuristic, not a probability of success."
        )
    elif verdict == "WATCH":
        return (
            f"{ticker} requires further confirmation (score {score}/{max_score}). "
            "Review the entry checks below; setup quality alone is not entry readiness."
        )
    return (
        f"{ticker} does not meet {trade_type} criteria (score {score}/{max_score}). "
        f"Technical or fundamental conditions are not aligned for a {hold} trade."
    )


# ═══════════════════════════════════════════════════════════════════════════════
#  FORMAT OUTPUT BUILDERS
# ═══════════════════════════════════════════════════════════════════════════════

def build_trade_plan(price, support, resistance, hist, trade_type):
    """Indicative long plan, with a structural stop and ATR volatility floor."""
    previous = hist["Close"].shift(1)
    ranges = pd.concat([hist["High"] - hist["Low"],
                        (hist["High"] - previous).abs(),
                        (hist["Low"] - previous).abs()], axis=1).max(axis=1)
    atr = number(ranges.ewm(alpha=1 / 14, adjust=False, min_periods=14).mean().iloc[-1]) if len(hist) >= 14 else None
    stop = None
    if atr and support is not None and 0 < support < price:
        multiple = 1.5 if trade_type == "swing" else 2.0
        candidate = min(support - 0.25 * atr, price - multiple * atr)
        stop = candidate if 0 < candidate < price else None
    target = resistance if resistance is not None and resistance > price else None
    risk = price - stop if stop is not None else None
    reward = target - price if target is not None else None
    return {
        "entry": price, "stop": stop, "target": target, "atr_14": atr,
        "risk_per_share": risk, "reward_per_share": reward,
        "downside_pct": risk / price * 100 if risk is not None else None,
        "upside_pct": reward / price * 100 if reward is not None else None,
        "reward_risk": reward / risk if reward is not None and risk else None,
        "min_reward_risk": MIN_REWARD_RISK, "min_upside_pct": MIN_UPSIDE[trade_type],
        "entry_basis": "Indicative entry at completed-session adjusted close",
        "stop_basis": "Below support by 0.25 ATR; at least " + ("1.5" if trade_type == "swing" else "2") + " ATR from entry",
        "target_basis": (f"R1: most recent confirmed daily swing high at least {SR_MIN_DISTANCE_PCT:g}% above entry; "
                         f"{SR_CONFIRM_BARS} bars each side, up to {SR_LOOKBACK_BARS} bars back; "
                         "N/A if no qualifying swing"),
        "holding_sessions": HOLD_SESSIONS[trade_type],
    }


def entry_readiness(setup_verdict, plan, earnings, missing, stage, trade_type):
    checks = []
    def check(key, passed, text):
        checks.append({"key": key, "passed": bool(passed), "text": text})
    check("setup", setup_verdict == "YES", "Setup score meets entry threshold")
    check("data", not missing, "Required data complete" if not missing else "Missing: " + ", ".join(missing))
    check("earnings", earnings["status"] in ("clear", "not_applicable"), earnings["description"])
    check("stop", plan["stop"] is not None, "Valid support/ATR stop")
    check("target", plan["target"] is not None, "Measured resistance target available")
    upside, ratio = plan["upside_pct"], plan["reward_risk"]
    check("upside", upside is not None and upside + 1e-9 >= MIN_UPSIDE[trade_type],
          f"Target upside at least {MIN_UPSIDE[trade_type]:g}%")
    check("reward_risk", ratio is not None and ratio + 1e-9 >= MIN_REWARD_RISK,
          f"Reward:risk at least {MIN_REWARD_RISK:g}:1")
    if trade_type == "position":
        check("stage", stage in (1, 2), "Position stage must be basing or advancing")
    ready = all(c["passed"] for c in checks)
    verdict = "YES" if ready else "NO" if setup_verdict == "NO" or (trade_type == "position" and stage == 4) else "WATCH"
    return {"ready": ready, "verdict": verdict, "checks": checks,
            "blockers": [c["text"] for c in checks if not c["passed"]]}


def _ema_object(hist, period, name, price):
    value, _, slope = calculate_ema(hist["Close"], period) if not hist.empty else (None, None, None)
    delta = None
    if value is not None:
        series = hist["Close"].ewm(span=period, adjust=False).mean()
        delta = float(series.iloc[-1] - series.iloc[-6])
    return {"name": name, "value": value,
            "position": None if value is None else "above" if price > value else "below" if price < value else "at",
            "slope": slope, "slope_delta": delta, "bars": len(hist)}


def _money(value):
    return f"${value:.2f}" if value is not None else "N/A"


def _ema_text(ema):
    return f"{_money(ema['value'])} | {ema['position']} | {ema['slope']}" if ema["value"] is not None else "N/A"


def analyze_snapshot(ticker, info, hist, hist_weekly, trade_type="swing",
                     calendar=None, as_of=None, benchmark=None):
    """Single cutoff for all calculations; injectable inputs support offline replay.

    Passing an empty benchmark prevents any benchmark network access. Historical
    callers must supply point-in-time metadata/calendar, never today's info.
    """
    if trade_type not in HOLD_SESSIONS:
        raise ValueError("trade_type must be 'swing' or 'position'")
    hist = prepare_history(hist, as_of)
    weekly = prepare_history(hist_weekly, as_of, weekly=True)
    if len(hist) < 20:
        raise ValueError(f"Unable to fetch 20 valid completed sessions for {ticker}. Check the symbol and try again.")
    price = get_current_price(info, hist)
    day_lo, day_hi = get_day_range(info, hist)
    low_52w, hi_52w = get_52week_range(hist)
    vol = get_volume_info(hist, info)
    daily_emas = [_ema_object(hist, p, f"EMA {p}", price) for p in (20, 50, 200)]
    weekly_emas = [_ema_object(weekly, p, f"{p}W EMA", price) for p in (50, 200)] if trade_type == "position" else []
    ema20, ema50, ema200 = daily_emas
    day_pct = (price / float(hist["Close"].iloc[-2]) - 1) * 100
    week_pct = (price / float(hist["Close"].iloc[-6]) - 1) * 100
    close_pos = (price - day_lo) / (day_hi - day_lo) if day_hi > day_lo else None
    pattern, pattern_context = detect_candlestick(hist)
    support, resistance, _ = analyze_support_resistance(hist)
    price_vs_support = (price / support - 1) * 100 if support else None
    event = earnings_status(info, calendar, trade_type, as_of)
    earnings_near = None if event["status"] == "unknown" else event["status"] == "upcoming"
    inst = institutional_ownership(info)
    ytd = get_ytd_change(hist)
    stage, stage_desc = get_weinstein_stage(price, hist)
    revenue, growth = number(info.get("revenueGrowth")), number(info.get("earningsGrowth"))
    rs = get_relative_strength(hist, benchmark, as_of) if trade_type == "position" else {"rs_1m": None, "rs_3m": None, "label": "Unknown"}
    missing = [ema["name"] for ema in daily_emas + weekly_emas if ema["value"] is None]
    warnings = []
    age = (_today(as_of) - hist.index[-1].date()).days
    if age > 4:
        missing.append("recent completed-session prices")
    if hist.attrs.get("invalid_bars") or weekly.attrs.get("invalid_bars"):
        missing.append("valid uninterrupted OHLC history")
    if vol["vol_ratio"] is None:
        missing.append("20-session volume baseline")
    if len(hist) < 400:
        warnings.append("Short daily EMA warm-up history")
    if trade_type == "position":
        for label, value in (("stage", stage), ("YTD base", ytd), ("revenue growth", revenue),
                             ("earnings growth", growth), ("institutional ownership", inst), ("SPY relative strength", rs["rs_1m"])):
            if value is None:
                missing.append(label)
        if not weekly.empty and (_today(as_of) - weekly.index[-1].date()).days > 14:
            missing.append("recent completed weekly prices")
        if len(weekly) < 400:
            warnings.append("Short weekly EMA warm-up history")
        setup, score, max_score, reasons, confidence, _, _ = score_position(
            price, stage, weekly_emas[0]["value"], weekly_emas[1]["value"], ytd,
            revenue, growth, resistance, low_52w, rs["label"], inst)
    else:
        setup, score, max_score, reasons, _, _ = score_swing(
            price, ema20["value"], ema50["value"], ema200["value"], ema20["slope_delta"],
            close_pos, pattern, earnings_near, support, resistance, vol["vol_ratio"], day_pct, week_pct)
        confidence = "High" if score >= 7 else "Moderate" if score >= 6 else "Low"
    for label in missing:
        reasons.append({"type": "neutral", "text": f"Unavailable: {label}", "score": 0})
    plan = build_trade_plan(price, support, resistance, hist, trade_type)
    readiness = entry_readiness(setup, plan, event, missing, stage, trade_type)
    verdict = readiness["verdict"]
    confidence = confidence if verdict == "YES" else "Low" if verdict == "WATCH" else "—"
    income, debt, cash = (number(info.get(key)) for key in ("netIncomeToCommon", "totalDebt", "totalCash"))
    profit = "Unknown" if income is None else "Profitable" if income > 0 else "Pre-profit"
    balance = "Unknown" if debt is None or cash is None else "Net cash" if cash > debt else "Net debt" if debt > cash else "Balanced"
    wpattern, wcontext = detect_candlestick(weekly)
    result = {
        "schema_version": 2, "ticker": ticker, "company": info.get("longName") or ticker,
        "trade_type": trade_type, "sector": info.get("sector") or "Unknown",
        "currency": info.get("currency") or "USD",
        "scan_time": datetime.now().astimezone().isoformat(),
        "snapshot": {"as_of": hist.index[-1].date().isoformat(), "price_basis": "Completed-session adjusted close",
                     "weekly_as_of": weekly.index[-1].date().isoformat() if not weekly.empty else None,
                     "daily_bars": len(hist), "weekly_bars": len(weekly), "age_days": age,
                     "earnings_checked_as_of": _today(as_of).isoformat(),
                     "completion_policy": "Current session and current week excluded"},
        "data_quality": {"complete": not missing, "missing": missing, "warnings": warnings},
        "price": price, "current_price": _money(price), "day_low": day_lo, "day_high": day_hi,
        "day_range": f"{_money(day_lo)} – {_money(day_hi)}",
        "low_52w": low_52w, "high_52w": hi_52w,
        "week_52_range": f"{_money(low_52w)} – {_money(hi_52w)}",
        "day_pct": day_pct, "week_pct": week_pct, "ytd_pct": ytd,
        "daily_emas": daily_emas, "weekly_emas": weekly_emas, "ema20_slope": ema20["slope_delta"],
        "pattern": pattern, "pattern_context": pattern_context,
        "pattern_sentiment": "bullish" if pattern in BULLISH_PATTERNS else "bearish" if pattern in BEARISH_PATTERNS else "neutral",
        "dpattern": pattern, "dpattern_ctx": pattern_context, "wpattern": wpattern, "wpattern_ctx": wcontext,
        "support_price": support, "resistance_price": resistance,
        "support": _money(support), "resistance": _money(resistance),
        "levels_basis": (f"Most recent confirmed daily swings; {SR_CONFIRM_BARS} bars each side, "
                         f"up to {SR_LOOKBACK_BARS} bars back, minimum {SR_MIN_DISTANCE_PCT:g}% distance "
                         "from analysis close; N/A if no qualifying swing"),
        "price_vs_support_pct": price_vs_support,
        "price_vs_support": f"{price_vs_support:+.1f}%" if price_vs_support is not None else "N/A",
        "close_position_pct": close_pos * 100 if close_pos is not None else None,
        "close_position": f"{close_pos:.0%}" if close_pos is not None else "N/A",
        **vol,
        "earnings": event["description"], "earnings_near": earnings_near, "earnings_check": event,
        "stage_num": stage, "stage": f"{stage} — {stage_desc}" if stage else "N/A",
        "stage_description": stage_desc, "stage_confirmed": False,
        "stage_conf": "150-session MA stage estimate; breakout confirmation not assessed",
        "rs_1m": rs["rs_1m"], "rs_3m": rs["rs_3m"], "rs_label": rs["label"],
        "revenue_growth": revenue * 100 if revenue is not None else None,
        "earnings_growth": growth * 100 if growth is not None else None,
        "profitability": profit, "profitability_status": "unknown" if income is None else "profitable" if income > 0 else "pre_profit",
        "balance_sheet": balance, "balance_sheet_status": "unknown" if balance == "Unknown" else "net_cash" if balance == "Net cash" else "net_debt" if balance == "Net debt" else "balanced",
        "institutional_ownership_pct": inst * 100 if inst is not None else None,
        "inst_pct": f"{inst * 100:.1f}%" if inst is not None else "N/A",
        "score": score, "max_score": max_score, "score_pct": round(score / max_score * 100), "reasons": reasons,
        "setup_verdict": setup, "verdict": verdict, "confidence": confidence,
        "trade_plan": plan, "entry_readiness": readiness,
        "target_price": plan["target"], "target": _money(plan["target"]), "upside_pct": plan["upside_pct"],
        "timeframe": "5–15 sessions" if trade_type == "swing" else "20–50 sessions",
        "key_risk": readiness["blockers"][0] if readiness["blockers"] else "Gaps and execution costs can change realized risk/reward",
        "trade_note": get_heuristic_trade_note(ticker, verdict, score, max_score, trade_type),
    }
    # Keep the old formatted EMA fields for compatibility with cached Trade assets.
    for period, ema in zip((20, 50, 200), daily_emas):
        result[f"ema_{period}"] = result[f"dema_{period}"] = _ema_text(ema)
    for period, ema in zip((50, 200), weekly_emas):
        result[f"wema_{period}"] = _ema_text(ema)
    return result


def format_swing_output(ticker, info, hist, hist_weekly, **kwargs):
    return analyze_snapshot(ticker, info, hist, hist_weekly, "swing", **kwargs)


def format_position_output(ticker, info, hist, hist_weekly, **kwargs):
    return analyze_snapshot(ticker, info, hist, hist_weekly, "position", **kwargs)


# ═══════════════════════════════════════════════════════════════════════════════
#  MAIN ENTRY POINT
# ═══════════════════════════════════════════════════════════════════════════════

def analyze(ticker: str, trade_type: str = "swing") -> dict:
    """
    Main analysis entry point. Fetches data and runs the appropriate scorer.

    Args:
        ticker: Stock ticker symbol (e.g. "AAPL")
        trade_type: "swing" or "position"

    Returns:
        Analysis result dict with all metrics, scoring, and verdict.

    Raises:
        ValueError: If ticker is invalid or insufficient data is available.
    """
    ticker = ticker.upper().strip()
    trade_type = trade_type.lower().strip()

    if trade_type not in ("swing", "position"):
        raise ValueError(f"Invalid trade_type '{trade_type}'. Must be 'swing' or 'position'.")

    stock, info, hist, hist_weekly = get_ticker_data(ticker, trade_type)
    try:
        calendar = stock.calendar
    except Exception as exc:
        logger.warning("Trade earnings calendar unavailable for %s: %s", ticker, exc)
        calendar = None
    return analyze_snapshot(ticker, info, hist, hist_weekly, trade_type, calendar=calendar)
