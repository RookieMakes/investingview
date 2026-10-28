import test from 'node:test';
import assert from 'node:assert/strict';
import { detectDominantPattern } from './dominant-pattern.mjs';

// Alternating five-session swings with small deterministic noise, on trading dates.
function bars(upper, lower, length = 60, preceding = 0) {
  const result = [];
  const start = new Date('2025-01-06T12:00:00Z');
  for (let i = 0; result.length < length + preceding; i++) {
    const date = new Date(start.getTime() + i * 86400000);
    if (date.getUTCDay() === 0 || date.getUTCDay() === 6) continue;
    const j = result.length - preceding;
    const progress = j < 0 ? 0 : j / (length - 1);
    const hi = j < 0 ? upper(0) - 0.7 * -j : upper(progress);
    const lo = j < 0 ? lower(0) - 0.7 * -j : lower(progress);
    const wave = (Math.cos(j * Math.PI / 5) + 1) / 2;
    const close = lo + (hi - lo) * wave;
    result.push({ time: date.toISOString().slice(0, 10), open: close,
      high: close + 0.3, low: close - 0.3, close, volume: 10000 });
  }
  return result;
}

test('finds a horizontal trading range with dated boundaries', () => {
  const data = bars(() => 110, () => 90);
  const result = detectDominantPattern(data);
  assert.equal(result?.name, 'Trading range');
  assert.equal(result.upper.at(-1).time, data.at(-1).time);
  assert.ok(result.upper.length >= 30 && result.upper.length <= 60);
});

test('identifies channels, triangles, and wedges by boundary geometry', () => {
  for (const [name, top, bottom] of [
    ['Rising channel', p => 110 + 10 * p, p => 90 + 10 * p],
    ['Falling channel', p => 110 - 10 * p, p => 90 - 10 * p],
    ['Symmetrical triangle', p => 112 - 8 * p, p => 88 + 8 * p],
    ['Ascending triangle', () => 112, p => 88 + 15 * p],
    ['Descending triangle', p => 112 - 15 * p, () => 88],
    ['Falling wedge', p => 112 - 15 * p, p => 88 - 5 * p],
    ['Rising wedge', p => 112 + 5 * p, p => 88 + 15 * p],
  ]) {
    assert.equal(detectDominantPattern(bars(top, bottom))?.name, name, name);
  }
});

test('does not force a pattern onto short or flat histories', () => {
  assert.equal(detectDominantPattern(bars(() => 110, () => 90, 20)), null);
  const flat = bars(() => 100, () => 100).map(c => ({ ...c, high: 100.1, low: 99.9 }));
  assert.equal(detectDominantPattern(flat), null);
});

test('requires a sharp preceding move before naming a flag or pennant', () => {
  const history = bars(() => 110, () => 90, 68);
  const start = history.length - 34;
  for (let i = start; i < start + 12; i++) {
    const shift = (i - start) * 2;
    history[i] = { ...history[i], open: 91 + shift, close: 91 + shift,
      high: 91.4 + shift, low: 90.6 + shift };
  }
  for (let i = start + 12; i < history.length; i++) {
    const j = i - start - 12;
    const shift = -j * 0.2;
    const close = 115 + shift + 4 * Math.cos(j * Math.PI / 4);
    history[i] = { ...history[i], open: close, close, high: close + 0.3, low: close - 0.3 };
  }
  assert.equal(detectDominantPattern(history)?.name, 'Flag');
});

test('recognizes a pennant only with its preceding pole', () => {
  const history = bars(() => 110, () => 90, 68);
  const start = history.length - 34;
  for (let i = start; i < start + 12; i++) {
    const close = 90 + (i - start) * 2;
    history[i] = { ...history[i], open: close, close, high: close + 0.3, low: close - 0.3 };
  }
  for (let i = start + 12; i < history.length; i++) {
    const j = i - start - 12;
    const width = 7 - j * 0.18;
    const close = 115 + width * Math.cos(j * Math.PI / 4);
    history[i] = { ...history[i], open: close, close, high: close + 0.3, low: close - 0.3 };
  }
  assert.equal(detectDominantPattern(history)?.name, 'Pennant');
});

test('labels emerging higher-low and lower-high consolidations', () => {
  for (const [name, top, bottom] of [
    ['Higher-low consolidation', () => 112, p => 88 + 7 * p],
    ['Lower-high consolidation', p => 112 - 4 * p, () => 88],
  ]) {
    const data = bars(() => name.startsWith('Higher') ? 122 : 112, () => 80, 54);
    for (let i = data.length - 24; i < data.length; i++) {
      const j = i - (data.length - 24);
      const progress = j / 23;
      const wave = (Math.cos(j * Math.PI / 4) + 1) / 2;
      const close = bottom(progress) + (top(progress) - bottom(progress)) * wave;
      data[i] = { ...data[i], open: close, high: close + 0.3, low: close - 0.3, close };
    }
    const result = detectDominantPattern(data);
    assert.equal(result?.name, name, name);
    assert.equal(result?.status, 'Forming');
  }
});

function reversalBars(top, ending) {
  const anchor = top
    ? [[0, 100], [30, 130], [39, 112], [48, 130], [60, ending]]
    : [[0, 130], [30, 100], [39, 118], [48, 100], [60, ending]];
  return bars(() => 100, () => 100, 61).map((c, i) => {
    const k = anchor.findIndex(([index]) => index >= i);
    const [to, target] = anchor[k];
    const [from, start] = anchor[Math.max(0, k - 1)];
    const close = from === to ? target : start + (target - start) * (i - from) / (to - from);
    return { ...c, open: close, high: close + 0.3, low: close - 0.3, close };
  });
}

test('requires a prior trend and neckline break to confirm double tops/bottoms', () => {
  const top = detectDominantPattern(reversalBars(true, 108));
  const bottom = detectDominantPattern(reversalBars(false, 122));
  assert.equal(top?.name, 'Double top');
  assert.equal(top?.status, 'Broken down ↓');
  assert.equal(bottom?.name, 'Double bottom');
  assert.equal(bottom?.status, 'Broken out ↑');
  assert.equal(detectDominantPattern(reversalBars(true, 114))?.name, 'Possible double top');

  const noTrend = reversalBars(true, 108).map((c, i) => i < 30
    ? { ...c, open: 127, close: 127, high: 127.3, low: 126.7 } : c);
  assert.notEqual(detectDominantPattern(noTrend)?.name, 'Double top');
});

test('draws a one-sided trend when the opposite swings cannot form a channel', () => {
  const anchors = [[0, 120], [5, 90], [10, 118], [15, 100], [20, 150],
    [25, 110], [30, 132], [35, 120], [40, 168], [44, 145]];
  const rising = bars(() => 100, () => 100, 45).map((c, i) => {
    const next = anchors.findIndex(([index]) => index >= i);
    const [end, endPrice] = anchors[next];
    const [start, startPrice] = anchors[Math.max(0, next - 1)];
    const price = end === start ? endPrice : startPrice + (endPrice - startPrice) * (i - start) / (end - start);
    return { ...c, open: price, high: price + 0.3, low: price - 0.3, close: price };
  });
  const up = detectDominantPattern(rising);
  assert.equal(up?.name, 'Rising support');
  assert.equal(up?.upper, null);
  assert.ok(up.lower.length >= 10);
  const falling = rising.map(c => ({ ...c, open: 250 - c.open, close: 250 - c.close,
    high: 250 - c.low, low: 250 - c.high }));
  const down = detectDominantPattern(falling);
  assert.equal(down?.name, 'Falling resistance');
  assert.equal(down?.lower, null);
});

test('recognizes a short, gently sloped parallel consolidation', () => {
  const data = bars(() => 105, () => 105).map(c => ({ ...c, high: 105.3, low: 104.7 }));
  for (let i = data.length - 20; i < data.length; i++) {
    const j = i - (data.length - 20);
    const wave = (1 + Math.cos(j * Math.PI / 4)) / 2;
    const close = 100 + j * 0.1 + 10 * wave;
    data[i] = { ...data[i], open: close, high: close + 0.3, low: close - 0.3, close };
  }
  const result = detectDominantPattern(data);
  assert.equal(result?.name, 'Parallel consolidation');
  assert.ok(result.upper.length <= 30);
});

test('never invents a boundary line for a move without swing touches', () => {
  const rising = bars(() => 100, () => 100).map((c, i) => {
    const close = 100 + i * 0.6;
    return { ...c, open: close, high: close + 0.4, low: close - 0.4, close };
  });
  assert.equal(detectDominantPattern(rising), null);
  const falling = rising.map(c => ({ ...c, open: 250 - c.open, close: 250 - c.close,
    high: 250 - c.low, low: 250 - c.high }));
  assert.equal(detectDominantPattern(falling), null);
  const intraday = { ...rising.at(-1), time: `${rising.at(-1).time} 15:30:00`, close: 1 };
  assert.equal(detectDominantPattern([...rising, intraday]), null);
});

test('ignores older range touches rather than drawing a stale trendline', () => {
  const data = bars(() => 110, () => 90, 100);
  for (let i = data.length - 25; i < data.length; i++) {
    const close = 100 + (i - (data.length - 25)) * 1.2;
    data[i] = { ...data[i], open: close, high: close + 0.4, low: close - 0.4, close };
  }
  assert.equal(detectDominantPattern(data), null);
});

test('trend fallbacks touch swing lows or highs instead of candle middles', () => {
  const anchors = [[0, 105], [5, 90], [11, 121], [28, 105], [35, 150], [44, 122]];
  const rising = bars(() => 100, () => 100, 45).map((c, i) => {
    const next = anchors.findIndex(([index]) => index >= i);
    const [end, endPrice] = anchors[next];
    const [start, startPrice] = anchors[Math.max(0, next - 1)];
    const price = end === start ? endPrice : startPrice + (endPrice - startPrice) * (i - start) / (end - start);
    return { ...c, open: price, high: price + 0.3, low: price - 0.3, close: price };
  });
  const up = detectDominantPattern(rising);
  assert.equal(up?.name, 'Rising price trend');
  assert.equal(up?.upper, null);
  for (const i of [5, 28]) {
    const point = up.lower.find(p => p.time === rising[i].time);
    assert.ok(point && Math.abs(point.value - rising[i].low) < 1e-8);
  }
  const falling = rising.map(c => ({ ...c, open: 250 - c.open, close: 250 - c.close,
    high: 250 - c.low, low: 250 - c.high }));
  const down = detectDominantPattern(falling);
  assert.equal(down?.name, 'Falling price trend');
  assert.equal(down?.lower, null);
  for (const i of [5, 28]) {
    const point = down.upper.find(p => p.time === falling[i].time);
    assert.ok(point && Math.abs(point.value - falling[i].high) < 1e-8);
  }
});

test('keeps a broken swing line visible with a broken-support label', () => {
  const data = bars(() => 100, () => 100, 45).map((c, i) => {
    const anchors = [[0, 105], [5, 90], [11, 121], [28, 105], [35, 150], [44, 100]];
    const next = anchors.findIndex(([index]) => index >= i);
    const [end, endPrice] = anchors[next];
    const [start, startPrice] = anchors[Math.max(0, next - 1)];
    const price = end === start ? endPrice : startPrice + (endPrice - startPrice) * (i - start) / (end - start);
    return { ...c, open: price, high: price + 0.3, low: price - 0.3, close: price };
  });
  const result = detectDominantPattern(data);
  assert.equal(result?.name, 'Rising price trend');
  assert.equal(result?.status, 'Broken support');
  assert.equal(result.lower.at(-1).time, data.at(-1).time);
});

test('a recent falling structure outranks an older broken rising line', () => {
  const data = bars(() => 100, () => 100).map((c, i) => {
    const base = i < 40 ? 100 + i * 0.6 : 124 - (i - 40) * 1.2;
    const close = base + 4 * Math.cos(i * Math.PI / 5);
    return { ...c, open: close, high: close + 0.3, low: close - 0.3, close };
  });
  assert.ok(['Flag', 'Falling price trend', 'Falling channel'].includes(detectDominantPattern(data)?.name));
});

test('labels a breakout only after two closes outside the range', () => {
  const data = bars(() => 110, () => 90);
  assert.equal(detectDominantPattern(data)?.status, 'Forming');
  data[data.length - 1] = { ...data.at(-1), open: 116, high: 116.3, low: 115.7, close: 116 };
  assert.equal(detectDominantPattern(data)?.status, 'Forming');
  data[data.length - 2] = { ...data.at(-2), open: 116, high: 116.3, low: 115.7, close: 116 };
  assert.equal(detectDominantPattern(data)?.status, 'Broken out ↑');
});
