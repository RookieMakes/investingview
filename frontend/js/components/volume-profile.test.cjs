const test = require('node:test');
const assert = require('node:assert/strict');

const { selectVolumeProfileCandles, computeVolumeProfile } = require('./volume-profile.js');

function weekdays(start, count) {
  const rows = [];
  const date = new Date(start + 'T00:00:00Z');
  while (rows.length < count) {
    if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) {
      rows.push({ time: date.toISOString().slice(0, 10) });
    }
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return rows;
}

test('selects calendar presets rather than treating 3M as 90 sessions', () => {
  const candles = weekdays('2025-01-02', 260);
  const selected = selectVolumeProfileCandles(candles, { period: '3m' });
  assert.ok(selected.candles.length >= 60 && selected.candles.length <= 67);
  assert.equal(selected.anchored, false);
});

test('selects a manual anchor through the latest candle', () => {
  const candles = weekdays('2025-01-02', 100);
  const anchor = candles[42].time;
  const selected = selectVolumeProfileCandles(candles, { anchorTime: anchor });
  assert.equal(selected.startTime, anchor);
  assert.equal(selected.candles.length, 58);
  assert.equal(selected.anchored, true);
});

test('allows anchoring any of the latest four real candles', () => {
  const candles = weekdays('2025-01-02', 20);
  for (let remaining = 1; remaining <= 4; remaining++) {
    const index = candles.length - remaining;
    const selected = selectVolumeProfileCandles(candles, { anchorTime: candles[index].time });
    assert.equal(selected.candles.length, remaining);
    assert.equal(selected.startTime, candles[index].time);
  }
});

test('selects 1W as the last 7 calendar days, not a fixed bar count', () => {
  const candles = weekdays('2025-01-02', 60);
  const selected = selectVolumeProfileCandles(candles, { period: '1w' });
  const start = new Date(selected.startTime + 'T00:00:00Z');
  const end = new Date(selected.endTime + 'T00:00:00Z');
  assert.ok((end - start) / 86_400_000 <= 7);
  assert.ok(selected.candles.length >= 4 && selected.candles.length <= 6);
  assert.equal(selected.anchored, false);
});

test('selects 1M as one calendar month back', () => {
  const candles = weekdays('2025-01-02', 120);
  const selected = selectVolumeProfileCandles(candles, { period: '1m' });
  const start = new Date(selected.startTime + 'T00:00:00Z');
  const end = new Date(selected.endTime + 'T00:00:00Z');
  const days = (end - start) / 86_400_000;
  assert.ok(days >= 28 && days <= 33);
  assert.equal(selected.anchored, false);
});

test('clamps calendar presets at month end', () => {
  const candles = weekdays('2024-10-01', 110);
  // Last session is in early March; selection still uses a calendar cutoff,
  // not a hard-coded number of bars.
  const selected = selectVolumeProfileCandles(candles, { period: '3m' });
  const start = new Date(selected.startTime + 'T00:00:00Z');
  const end = new Date(selected.endTime + 'T00:00:00Z');
  assert.ok((end - start) / 86_400_000 <= 95);
});

test('preserves total volume with overlap-weighted allocation', () => {
  const candles = [
    { low: 10, high: 20, volume: 100 },
    { low: 12, high: 18, volume: 200 },
    { low: 15, high: 15, volume: 50 },
    { low: 11, high: 19, volume: 75 },
    { low: 10, high: 20, volume: 125 },
  ];
  const profile = computeVolumeProfile(candles, { rows: 10 });
  assert.ok(profile);
  assert.ok(Math.abs(profile.totalVolume - 550) < 1e-8);
});

test('finds a heavy price node and includes at least 70% in value area', () => {
  const candles = [];
  for (let i = 0; i < 80; i++) {
    const center = i < 60 ? 105 : 125;
    candles.push({ low: center - 1, high: center + 1, volume: i < 60 ? 1_000 : 100 });
  }
  const profile = computeVolumeProfile(candles, { rows: 30, valueAreaPct: 0.7 });
  assert.ok(profile.pocPrice > 103 && profile.pocPrice < 107);
  const valueAreaVolume = profile.rows
    .filter(row => row.priceHi > profile.val && row.priceLo < profile.vah)
    .reduce((sum, row) => sum + row.volume, 0);
  assert.ok(valueAreaVolume / profile.totalVolume >= 0.7);
});

test('keeps genuine flat candles in the profile', () => {
  const candles = [
    { low: 10, high: 20, volume: 10 },
    { low: 15, high: 15, volume: 1_000 },
    { low: 10, high: 20, volume: 10 },
    { low: 10, high: 20, volume: 10 },
    { low: 10, high: 20, volume: 10 },
  ];
  const profile = computeVolumeProfile(candles, { rows: 10 });
  assert.ok(profile.pocPrice > 14 && profile.pocPrice < 16);
  assert.ok(Math.abs(profile.totalVolume - 1_040) < 1e-8);
});

test('profiles a single flat anchor candle', () => {
  const profile = computeVolumeProfile([{ low: 25, high: 25, volume: 500 }], { rows: 10 });
  assert.ok(profile);
  assert.ok(Math.abs(profile.totalVolume - 500) < 1e-8);
  assert.ok(profile.pocPrice > 24.9 && profile.pocPrice < 25.1);
});

test('rejects insufficient or unusable data', () => {
  assert.equal(computeVolumeProfile([], {}), null);
  assert.equal(computeVolumeProfile(Array.from({ length: 5 }, () => ({ low: 10, high: 10, volume: 0 })), {}), null);
});

test('keeps the row size when extremes widen slightly', () => {
  const base = [{ low: 100, high: 160, volume: 500 }];
  for (let i = 0; i < 20; i++) base.push({ low: 110 + i, high: 111 + i, volume: 100 });
  const wide = base.concat([
    { low: 98.5, high: 99, volume: 50 },
    { low: 161, high: 161.5, volume: 50 },
  ]);
  const before = computeVolumeProfile(base, { rows: 30 });
  const after = computeVolumeProfile(wide, { rows: 30 });
  assert.equal(after.step, before.step);
  assert.ok(after.gridMin <= before.gridMin);
  assert.ok(after.gridMax >= before.gridMax);
  assert.ok(Math.abs(after.gridMin / after.step - Math.round(after.gridMin / after.step)) < 1e-9);
});

test('breaks POC ties toward the volume-weighted median, not the cheapest row', () => {
  const candles = [];
  for (let i = 0; i < 8; i++) candles.push({ low: 50, high: 50, volume: 100 });
  candles.push({ low: 10, high: 10, volume: 800 });
  candles.push({ low: 60, high: 60, volume: 200 });
  const profile = computeVolumeProfile(candles, { rows: 30 });
  // Equal 800-volume peaks at 10 and 50; most trading sits near 50.
  assert.equal(profile.pocIndex, 20);
  assert.equal(profile.pocPrice, 51);
});

test('expands tied value-area rows symmetrically around POC', () => {
  const profile = computeVolumeProfile([{ low: 0, high: 30, volume: 300 }], { rows: 30 });
  assert.equal(profile.pocIndex, 14);
  assert.equal(profile.val, 4);
  assert.equal(profile.vah, 25);
  assert.ok(Math.abs(profile.valueAreaCoverage - 0.7) < 1e-9);
});

test('marks a lone spike as row-size stable', () => {
  const profile = computeVolumeProfile([{ low: 25, high: 25, volume: 500 }], { rows: 30 });
  assert.equal(profile.sensitivity.stable, true);
  assert.ok(profile.sensitivity.pocSpread <= profile.step);
});

test('flags POC as sensitive when binning flips the peak', () => {
  const candles = [
    { low: 0, high: 34, volume: 340 },
    { low: 10.9, high: 11.1, volume: 1005 },
    { low: 25, high: 25, volume: 1000 },
  ];
  const profile = computeVolumeProfile(candles, { rows: 30 });
  assert.ok(profile);
  assert.equal(profile.sensitivity.stable, false);
  assert.ok(profile.sensitivity.pocSpread > profile.step);
});
