/**
 * Find one defensible, drawable price structure in recent daily OHLC candles.
 * Pure price analysis: no DOM, no chart dependency, and no projected dates.
 */
// Different structures mature at different speeds; these are trading sessions,
// not calendar days. Wider reversal windows still draw only the actual formation.
const WINDOWS = [30, 35, 40, 45, 50, 55, 60];
const COMPACT_WINDOWS = [15, 20, 25, 30];
const EARLY_WINDOWS = [20, 24, 28];
const FLAG_WINDOWS = [14, 18, 22];
const REVERSAL_WINDOWS = [35, 45, 55, 60];

function volatility(candles) {
  const ranges = candles.slice(-20).map((c, i, bars) => {
    const prev = i ? bars[i - 1].close : c.close;
    return Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev));
  });
  return ranges.reduce((sum, n) => sum + n, 0) / ranges.length;
}

function pivots(bars, field, radius, threshold) {
  const found = [];
  for (let i = radius; i < bars.length - radius; i++) {
    const value = bars[i][field];
    const neighbors = bars.slice(i - radius, i + radius + 1).filter((_, j) => j !== radius);
    const extreme = field === 'high'
      ? neighbors.every(c => value > c.high)
      : neighbors.every(c => value < c.low);
    const prominence = field === 'high'
      ? value - Math.min(...neighbors.map(c => c.low))
      : Math.max(...neighbors.map(c => c.high)) - value;
    if (extreme && prominence >= threshold && (!found.length || i - found[found.length - 1].index >= 3)) {
      found.push({ index: i, value });
    }
  }
  return found;
}

function fit(points) {
  const mx = points.reduce((a, p) => a + p.index, 0) / points.length;
  const my = points.reduce((a, p) => a + p.value, 0) / points.length;
  const denom = points.reduce((a, p) => a + (p.index - mx) ** 2, 0);
  if (!denom) return null;
  const slope = points.reduce((a, p) => a + (p.index - mx) * (p.value - my), 0) / denom;
  return { slope, at: x => my + slope * (x - mx) };
}

function classify(topDrift, bottomDrift, widthStart, widthEnd, days, priorMove, early, compact) {
  const flat = widthStart * 0.12;
  const narrowing = widthEnd / widthStart;
  const parallel = Math.abs(topDrift - bottomDrift) <= widthStart * 0.28;
  const centerDrift = (topDrift + bottomDrift) / 2;
  if (priorMove && days <= 24 && widthStart <= Math.abs(priorMove) * 0.75) {
    const opposite = Math.abs(centerDrift) < flat || Math.sign(centerDrift) === -Math.sign(priorMove);
    if (opposite && parallel) return 'Flag';
    if (opposite && narrowing >= 0.25 && narrowing <= 0.78) return 'Pennant';
  }
  if (compact) {
    return parallel && Math.abs(topDrift - bottomDrift) <= widthStart * 0.18 &&
      narrowing >= 0.65 && narrowing <= 1.35 &&
      Math.abs(centerDrift) <= widthStart * 0.55 ? 'Parallel consolidation' : null;
  }
  if (early) {
    // A shorter, still-developing compression: don't label it a completed triangle.
    if (narrowing < 0.45 || narrowing > 0.92) return null;
    if (Math.abs(topDrift) <= flat && bottomDrift > flat && bottomDrift < widthStart * 0.65) {
      return 'Higher-low consolidation';
    }
    if (Math.abs(bottomDrift) <= flat && topDrift < -flat && topDrift > -widthStart * 0.65) {
      return 'Lower-high consolidation';
    }
    return null;
  }
  if (days < 30) return null;
  if (Math.abs(topDrift) <= flat && Math.abs(bottomDrift) <= flat && parallel) return 'Trading range';
  if (narrowing >= 0.3 && narrowing <= 0.78) {
    if (topDrift < -flat && bottomDrift > flat) return 'Symmetrical triangle';
    if (Math.abs(topDrift) <= flat && bottomDrift > flat) return 'Ascending triangle';
    if (topDrift < -flat && Math.abs(bottomDrift) <= flat) return 'Descending triangle';
    if (topDrift < -flat && bottomDrift < -flat && topDrift < bottomDrift) return 'Falling wedge';
    if (topDrift > flat && bottomDrift > flat && bottomDrift > topDrift) return 'Rising wedge';
  }
  if (parallel && Math.abs(centerDrift) > flat && Math.sign(topDrift) === Math.sign(bottomDrift)) {
    return centerDrift > 0 ? 'Rising channel' : 'Falling channel';
  }
  return null;
}

function candidate(all, length, atr, { flag = false, early = false, compact = false } = {}) {
  if (all.length < length + (flag ? 12 : 0)) return null;
  const bars = all.slice(-length);
  const highs = pivots(bars, 'high', 2, atr * 0.45);
  const lows = pivots(bars, 'low', 2, atr * 0.45);
  if (highs.length < 2 || lows.length < 2) return null;
  const span = length - 1;
  if (highs.at(-1).index - highs[0].index < span * 0.35 ||
      lows.at(-1).index - lows[0].index < span * 0.35) return null;
  const upper = fit(highs);
  const lower = fit(lows);
  if (!upper || !lower) return null;
  const widthStart = upper.at(0) - lower.at(0);
  const widthEnd = upper.at(span) - lower.at(span);
  if (widthStart < atr * (compact ? 0.9 : 1.4) ||
      widthEnd < atr * (compact ? 0.6 : 0.7) || widthEnd > widthStart * 1.55) return null;
  const topDrift = upper.slope * span;
  const bottomDrift = lower.slope * span;
  const before = all.slice(-length - 12, -length);
  const priorMove = flag && before.length === 12
    ? bars[0].close - before[0].close : 0;
  const strongMove = Math.abs(priorMove) >= Math.max(atr * 3, bars[0].close * 0.05);
  const name = classify(topDrift, bottomDrift, widthStart, widthEnd, length,
    strongMove ? priorMove : 0, early, compact);
  if (!name || (flag && !['Flag', 'Pennant'].includes(name))) return null;
  // A long-window fit must not call a recent flat ceiling a falling ceiling
  // just because older, unrelated highs happened to be higher.
  const lastHighMove = highs.at(-1).value - highs.at(-2).value;
  const lastLowMove = lows.at(-1).value - lows.at(-2).value;
  if ((name === 'Symmetrical triangle' && (lastHighMove >= -atr * 0.12 || lastLowMove <= atr * 0.12)) ||
      (name === 'Ascending triangle' && lastLowMove <= atr * 0.12) ||
      (name === 'Descending triangle' && lastHighMove >= -atr * 0.12) ||
      (name === 'Falling wedge' && (lastHighMove >= -atr * 0.12 || lastLowMove >= -atr * 0.12)) ||
      (name === 'Rising wedge' && (lastHighMove <= atr * 0.12 || lastLowMove <= atr * 0.12))) return null;

  // Fit to swings, but reject shapes that stray far from actual price action.
  const error = [...highs.map(p => Math.abs(upper.at(p.index) - p.value)),
    ...lows.map(p => Math.abs(lower.at(p.index) - p.value))]
    .reduce((a, n) => a + n, 0) / (highs.length + lows.length);
  const typicalWidth = (widthStart + widthEnd) / 2;
  if (error > typicalWidth * (compact ? 0.2 : 0.16)) return null;
  const inside = bars.filter((c, i) => c.close <= upper.at(i) + atr * 0.5 &&
    c.close >= lower.at(i) - atr * 0.5).length / length;
  if (inside < (compact ? 0.85 : 0.8)) return null;

  // Two consecutive closes beyond a boundary qualify as a breakout, not a prediction.
  const margin = Math.max(atr * 0.35, widthEnd * 0.06);
  const last = bars.length - 1;
  const above = [last - 1, last].every(i => bars[i].close > upper.at(i) + margin);
  const below = [last - 1, last].every(i => bars[i].close < lower.at(i) - margin);
  const lastTouchAge = Math.min(last - highs.at(-1).index, last - lows.at(-1).index);
  if (!above && !below && lastTouchAge > Math.min(12, Math.ceil(length * 0.3))) return null;
  const status = above ? 'Broken out ↑' : below ? 'Broken down ↓' : 'Forming';
  const score = inside * 4 - error / typicalWidth * 3 +
    Math.min(highs.length + lows.length, 9) * 0.09 + length * 0.008 -
    (early ? 0.25 : 0) - (compact ? 0.2 : 0) + (flag ? 0.2 : 0) - lastTouchAge * 0.02;
  return {
    name, status, score,
    upper: bars.map((c, i) => ({ time: c.time, value: upper.at(i) })),
    lower: bars.map((c, i) => ({ time: c.time, value: lower.at(i) })),
  };
}

function reversal(all, length, atr, top) {
  if (all.length < length + 10) return null;
  const bars = all.slice(-length);
  const swings = pivots(bars, top ? 'high' : 'low', 2, atr * 0.6);
  if (swings.length < 2) return null;
  const first = swings.at(-2);
  const second = swings.at(-1);
  const separation = second.index - first.index;
  if (separation < 12 || separation > 36 || second.index < length - 22) return null;
  const inBetween = bars.slice(first.index + 1, second.index);
  if (inBetween.length < 10) return null;
  const neck = top
    ? Math.min(...inBetween.map(c => c.low))
    : Math.max(...inBetween.map(c => c.high));
  const level = (first.value + second.value) / 2;
  const depth = Math.abs(level - neck);
  if (depth < Math.max(atr * 2.5, level * 0.055) ||
      Math.abs(first.value - second.value) > Math.max(atr * 0.8, level * 0.025)) return null;

  // A reversal needs a trend to reverse, not just repeated range boundaries.
  const beforeIndex = all.length - length + first.index - 20;
  if (beforeIndex < 0) return null;
  const priorClose = all[beforeIndex].close;
  const move = top ? first.value - priorClose : priorClose - first.value;
  if (move < Math.max(atr * 3, priorClose * 0.06)) return null;
  const earlier = all.slice(beforeIndex, beforeIndex + 10);
  if (top ? Math.max(...earlier.map(c => c.high)) >= first.value - depth * 0.3
    : Math.min(...earlier.map(c => c.low)) <= first.value + depth * 0.3) return null;
  const recent = bars.slice(second.index + 1);
  if (recent.some(c => top ? c.close > level + atr : c.close < level - atr)) return null;

  const margin = Math.max(atr * 0.35, depth * 0.06);
  const lastTwo = bars.slice(-2);
  const confirmed = lastTwo.every(c => top ? c.close < neck - margin : c.close > neck + margin);
  const reachedNeck = recent.slice(-5).some(c => top ? c.close <= neck + depth * 0.2
    : c.close >= neck - depth * 0.2);
  // Wait for at least a meaningful move away from the second peak/trough.
  if (!confirmed && !reachedNeck) return null;
  const label = top ? 'Double top' : 'Double bottom';
  const line = (price) => bars.slice(first.index).map(c => ({ time: c.time, value: price }));
  return {
    name: confirmed ? label : `Possible ${label.toLowerCase()}`,
    status: confirmed ? (top ? 'Broken down ↓' : 'Broken out ↑') : 'Forming',
    score: 4.3 + Math.min(depth / atr, 6) * 0.08 + (confirmed ? 0.8 : 0),
    upper: line(top ? level : neck),
    lower: line(top ? neck : level),
  };
}

/** Draw a single confirmed support/resistance slope when no clean channel exists. */
function oneSidedTrend(all, length, atr, rising) {
  if (all.length < length) return null;
  const bars = all.slice(-length);
  const swings = pivots(bars, rising ? 'low' : 'high', 2, atr * 0.45);
  if (swings.length < 3) return null;
  const recent = swings.slice(-3);
  const span = recent[2].index - recent[0].index;
  if (span < 9 || span < length * 0.27 || recent[2].index < length - 10) return null;
  const direction = rising ? 1 : -1;
  if (recent.some((p, i) => i && direction * (p.value - recent[i - 1].value) < atr * 0.12)) return null;
  const boundary = fit(recent);
  if (!boundary || direction * boundary.slope * span < atr * 1.3) return null;
  const error = recent.reduce((sum, p) => sum + Math.abs(boundary.at(p.index) - p.value), 0) / 3;
  if (error > atr * 0.5) return null;
  const move = direction * (bars.at(-1).close - bars[0].close);
  if (move < Math.max(atr * 2, bars[0].close * 0.05)) return null;
  const lastLine = boundary.at(length - 1);
  const distance = direction * (bars.at(-1).close - lastLine);
  if (distance < -atr * 0.85 || distance > atr * 4) return null;
  const points = bars.slice(recent[0].index).map((c, i) => ({
    time: c.time, value: boundary.at(recent[0].index + i),
  }));
  const broken = bars.slice(-2).every((c, i) =>
    direction * (c.close - boundary.at(length - 2 + i)) < -atr * 0.35);
  return {
    name: rising ? 'Rising support' : 'Falling resistance',
    status: broken ? (rising ? 'Broken down ↓' : 'Broken out ↑')
      : distance < -atr * 0.35 ? (rising ? 'Testing support' : 'Testing resistance') : 'Trend',
    score: 4.05 - error / atr * 0.3 - (broken ? 0.3 : 0),
    upper: rising ? null : points,
    lower: rising ? points : null,
  };
}

/** Pick an actual pivot boundary; never draw the trend fallback through closes. */
function priceTrend(all, length, atr, rising) {
  if (all.length < length) return null;
  const bars = all.slice(-length);
  const direction = rising ? 1 : -1;
  const field = rising ? 'low' : 'high';
  const swings = pivots(bars, field, 2, atr * 0.45);
  if (swings.length < 2) return null;
  const tolerance = Math.max(atr * 0.45, bars.at(-1).close * 0.003);
  const margin = atr * 0.35;
  let best = null;
  for (let i = 0; i < swings.length - 1; i++) {
    for (let j = i + 1; j < swings.length; j++) {
      const first = swings[i];
      const second = swings[j];
      const span = second.index - first.index;
      const age = length - 1 - second.index;
      if (span < 6 || age > 20) continue;
      const slope = (second.value - first.value) / span;
      if (direction * slope * span < Math.max(atr * 0.18, first.value * 0.018)) continue;
      const at = index => first.value + slope * (index - first.index);
      const touches = swings.slice(i).filter(p => Math.abs(p.value - at(p.index)) <= tolerance).length;
      if (touches < 2) continue;
      const prior = bars.slice(first.index, Math.max(first.index, length - 5));
      const violations = prior.filter((c, k) =>
        direction * (c[field] - at(first.index + k)) < -tolerance).length;
      if (violations > Math.max(2, Math.floor(prior.length * 0.15))) continue;
      const lastDistance = direction * (bars.at(-1).close - at(length - 1));
      if (at(length - 1) <= 0 || Math.abs(lastDistance) > atr * 6) continue;
      // A support line far below current price is an old floor, not a
      // useful boundary for the current rising move.
      if (rising && lastDistance > atr * 2) continue;

      const broken = bars.slice(-2).every((c, k) =>
        direction * (c.close - at(length - 2 + k)) < -margin);
      const recentBreak = bars.slice(-6).some((c, k) =>
        direction * (c.close - at(length - 6 + k)) < -margin);
      if (!recentBreak && direction * (bars.at(-1).close - bars[0].close) <
          Math.max(atr, bars[0].close * 0.025)) continue;
      const recovered = bars.slice(-2).every((c, k) =>
        direction * (c.close - at(length - 2 + k)) >= -margin);
      let status = 'Trend';
      if (broken || (recentBreak && !recovered)) {
        status = rising ? 'Broken support' : 'Broken resistance';
      } else if (recentBreak) {
        status = rising ? 'Reclaimed support' : 'Reclaimed resistance';
      } else if (lastDistance < -margin) {
        status = rising ? 'Testing support' : 'Testing resistance';
      } else if (!rising && lastDistance > atr * 0.8) {
        status = 'Below resistance';
      }
      const shortMove = direction * (bars.at(-1).close - bars[Math.max(0, length - 15)].close);
      const overtaken = recentBreak && shortMove < -Math.max(atr * 2, bars.at(-1).close * 0.04);
      const score = 3.4 + Math.min(touches - 2, 4) * 0.18 +
        (20 - age) * 0.014 - violations * 0.08 - Math.abs(lastDistance) / atr * 0.025 -
        (overtaken ? 0.6 : 0);
      if (best && score <= best.score) continue;
      const points = bars.slice(first.index).map((c, offset) => ({
        time: c.time, value: at(first.index + offset),
      }));
      best = {
        name: rising ? 'Rising price trend' : 'Falling price trend',
        status, score,
        upper: rising ? null : points,
        lower: rising ? points : null,
      };
    }
  }
  return best;
}

export function detectDominantPattern(candles) {
  const real = (candles || []).filter(c => c && /^\d{4}-\d{2}-\d{2}$/.test(c.time) &&
    [c.open, c.high, c.low, c.close].every(n => Number.isFinite(n) && n > 0) &&
    c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close));
  if (real.length < 30) return null;
  const atr = volatility(real);
  if (!Number.isFinite(atr) || atr <= 0) return null;
  const options = [
    ...WINDOWS.map(n => candidate(real, n, atr)),
    ...COMPACT_WINDOWS.map(n => candidate(real, n, atr, { compact: true })),
    ...EARLY_WINDOWS.map(n => candidate(real, n, atr, { early: true })),
    ...FLAG_WINDOWS.map(n => candidate(real, n, atr, { flag: true })),
    ...REVERSAL_WINDOWS.flatMap(n => [reversal(real, n, atr, true), reversal(real, n, atr, false)]),
    ...WINDOWS.flatMap(n => [oneSidedTrend(real, n, atr, true), oneSidedTrend(real, n, atr, false)]),
    ...[15, 20, 25, 30, 35, 40, 45, 50, 55, 60].flatMap(n => [
      priceTrend(real, n, atr, true), priceTrend(real, n, atr, false),
    ]),
  ].filter(Boolean);
  options.sort((a, b) => b.score - a.score);
  return options[0] || null;
}
