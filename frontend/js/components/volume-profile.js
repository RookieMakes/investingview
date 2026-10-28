/**
 * volume-profile.js — Range-aware vertical volume profile for the expand modal.
 *
 * Bins selected daily candles (already fetched as 1y/1d with volume) into
 * price rows on a stable grid, distributing each bar's volume across the rows
 * its [low, high] range touches in proportion to overlap. Derives POC (point
 * of control = max-volume row, ties broken toward the volume-weighted median)
 * and a contiguous 70% value area (VAH/VAL), then draws the histogram as a
 * series primitive in a fixed-width lane on the right side of the chart. The
 * result also reports whether POC is sensitive to the row count, so callers
 * can avoid presenting fragile levels as precise ones.
 *
 * Follows the existing custom-primitive pattern (PctMovePrimitive in
 * pivot-move.js, HoverHighlightPrimitive in hover-highlight.js):
 * `candleSeries.attachPrimitive(primitive)` with the ISeriesPrimitive
 * interface (attached/detached/updateAllViews/paneViews/zOrder/renderer/draw).
 * A primitive is used (not markers) so earnings/transaction markers are
 * untouched — createSeriesMarkers() would replace them all.
 *
 * Dependencies: LightweightCharts v5.2+ (standalone CDN build)
 *
 * Exports (window globals for vanilla JS usage):
 *   - selectVolumeProfileCandles(candles, options)
 *   - computeVolumeProfile(candles, options)
 *   - VolumeProfilePrimitive
 */

/* ────────────────────────────────────────────────────────────
 * Profile computation — pure function, no chart dependency
 * ──────────────────────────────────────────────────────────── */

/**
 * Select a rolling calendar period or manual-anchor window from daily bars.
 * The result is fixed until this function is called again; chart zoom does
 * not alter it.
 *
 * @param {Array<{time: string}>} candles Time-ascending real daily candles.
 * @param {{period?: '1w'|'1m'|'3m'|'6m'|'1y', anchorTime?: string|null}} [options]
 * @returns {{candles: Array, startIndex: number, startTime: string,
 *   endTime: string, anchored: boolean} | null}
 */
function selectVolumeProfileCandles(candles, options) {
  if (!Array.isArray(candles) || candles.length < 1) return null;
  const period = options && ['1w', '1m', '3m', '6m', '1y'].includes(options.period) ? options.period : '3m';
  const anchorTime = options && options.anchorTime;
  const endTime = candles[candles.length - 1].time;
  let startIndex = 0;
  let anchored = false;

  if (anchorTime) {
    const index = candles.findIndex(c => c.time >= anchorTime);
    if (index < 0) return null;
    startIndex = index;
    anchored = true;
  } else if (period === '1w') {
    const cutoffDate = new Date(endTime + 'T00:00:00Z');
    cutoffDate.setUTCDate(cutoffDate.getUTCDate() - 7);
    const cutoff = cutoffDate.toISOString().slice(0, 10);
    const index = candles.findIndex(c => c.time >= cutoff);
    startIndex = index >= 0 ? index : 0;
  } else {
    const cutoffDate = new Date(endTime + 'T00:00:00Z');
    const originalDay = cutoffDate.getUTCDate();
    cutoffDate.setUTCDate(1);
    const monthsBack = period === '1y' ? 12 : period === '6m' ? 6 : period === '1m' ? 1 : 3;
    cutoffDate.setUTCMonth(cutoffDate.getUTCMonth() - monthsBack);
    const monthEnd = new Date(Date.UTC(
      cutoffDate.getUTCFullYear(), cutoffDate.getUTCMonth() + 1, 0
    )).getUTCDate();
    cutoffDate.setUTCDate(Math.min(originalDay, monthEnd));
    const cutoff = cutoffDate.toISOString().slice(0, 10);
    const index = candles.findIndex(c => c.time >= cutoff);
    startIndex = index >= 0 ? index : 0;
  }

  const selected = candles.slice(startIndex);
  if (selected.length < 1) return null;
  return {
    candles: selected,
    startIndex,
    startTime: selected[0].time,
    endTime,
    anchored,
  };
}

/* ── Stable price grid ──────────────────────────────────────────── */

/**
 * Snap a raw row size to a 1/2/2.5/5 × 10^k increment so rows sit on round
 * prices. Thresholds are geometric midpoints, so nearby ranges keep the
 * same step instead of rescaling on every new extreme.
 */
function _niceStep(rawStep) {
  if (!(rawStep > 0) || !Number.isFinite(rawStep)) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  const snap = norm >= 7.0710679 ? 10
    : norm >= 3.5355339 ? 5
    : norm >= 2.236068 ? 2.5
    : norm >= 1.4142136 ? 2 : 1;
  return snap * mag;
}

/**
 * Build a grid whose edges are multiples of a nice increment. A slightly
 * wider high/low extends the grid instead of shifting every row boundary,
 * so POC/VAH/VAL only move when volume actually moved.
 */
function _stableGrid(minLow, maxHigh, targetRows) {
  const target = Math.max(8, Math.min(60, Math.round(targetRows) || 30));
  let step = _niceStep((maxHigh - minLow) / target);
  let gridMin = minLow;
  let gridMax = maxHigh;
  let n = target;
  for (let i = 0; i < 8; i++) {
    gridMin = Math.floor(minLow / step) * step;
    gridMax = Math.ceil(maxHigh / step) * step;
    gridMin = Math.round(gridMin * 1e10) / 1e10;
    gridMax = Math.round(gridMax * 1e10) / 1e10;
    n = Math.max(1, Math.round((gridMax - gridMin) / step));
    if (n > 60) { step *= 2; continue; }
    if (n < 8) { step /= 2; continue; }
    break;
  }
  return { step, gridMin, gridMax, n };
}

/** Spread candle volumes across grid rows in proportion to price overlap. */
function _distributeVolume(valid, grid) {
  const { step, gridMin, n } = grid;
  const bins = new Array(n).fill(0);
  const EPS = 1e-9;
  for (const c of valid) {
    const range = c.high - c.low;
    if (range === 0) {
      const b = Math.max(0, Math.min(n - 1, Math.floor((c.low - gridMin) / step + EPS)));
      bins[b] += c.volume;
      continue;
    }
    let lo = Math.floor((c.low - gridMin) / step + EPS);
    let hi = Math.ceil((c.high - gridMin) / step - EPS) - 1;
    lo = Math.max(0, Math.min(n - 1, lo));
    hi = Math.max(0, Math.min(n - 1, hi));
    if (hi < lo) { bins[lo] += c.volume; continue; }
    for (let b = lo; b <= hi; b++) {
      const binLo = gridMin + b * step;
      const overlap = Math.max(0, Math.min(c.high, binLo + step) - Math.max(c.low, binLo));
      if (overlap > 0) bins[b] += c.volume * (overlap / range);
    }
  }
  return bins;
}

/**
 * Derive POC and a contiguous value area from binned volumes.
 *
 * POC is the max-volume row; ties resolve toward the volume-weighted median
 * row (then upward), so flat plateaus don't silently default to the cheapest
 * row. The value area grows from POC by absorbing the busier neighbor until
 * it holds valueAreaPct of total volume; equal neighbors resolve toward the
 * nearer side, then upward.
 */
function _levelsFromBins(bins, valueAreaPct) {
  const totalVolume = bins.reduce((a, b) => a + b, 0);
  if (totalVolume <= 0) return null;
  let maxVolume = -Infinity;
  for (const v of bins) if (v > maxVolume) maxVolume = v;
  if (maxVolume <= 0) return null;

  let cum = 0;
  let medianIdx = bins.length - 1;
  for (let i = 0; i < bins.length; i++) {
    cum += bins[i];
    if (cum >= totalVolume / 2) { medianIdx = i; break; }
  }
  const tieTol = 1e-9 * Math.max(1, totalVolume);
  let pocIndex = -1;
  for (let b = 0; b < bins.length; b++) {
    if (bins[b] < maxVolume - tieTol) continue;
    if (pocIndex < 0) { pocIndex = b; continue; }
    const d = Math.abs(b - medianIdx);
    const best = Math.abs(pocIndex - medianIdx);
    if (d < best || (d === best && b > pocIndex)) pocIndex = b;
  }

  let lo = pocIndex;
  let hi = pocIndex;
  let vaVol = bins[pocIndex];
  const target = totalVolume * valueAreaPct;
  while (vaVol < target && (lo > 0 || hi < bins.length - 1)) {
    const loVol = lo > 0 ? bins[lo - 1] : -1;
    const hiVol = hi < bins.length - 1 ? bins[hi + 1] : -1;
    let takeHi;
    if (hiVol !== loVol) takeHi = hiVol > loVol;
    else takeHi = (hi + 1 - pocIndex) <= (pocIndex - (lo - 1));
    if (takeHi) { hi++; vaVol += bins[hi]; }
    else { lo--; vaVol += bins[lo]; }
  }
  return { pocIndex, maxVolume, lo, hi, vaVol, totalVolume };
}

/**
 * Bin candles into a price-distributed volume profile.
 *
 * Daily OHLCV cannot reveal where inside a day volume traded, so each
 * candle's volume is spread across its high–low range in proportion to row
 * overlap. Rows sit on a stable grid (nice increments aligned to multiples),
 * so small new extremes extend the grid instead of moving every level.
 *
 * @param {Array<{time: string, open: number, high: number, low: number, close: number, volume?: number}>} candles
 *   Real daily candles, time ascending. The caller excludes synthetic
 *   earnings placeholders by source/index; genuine flat candles are valid.
 * @param {Object} [options]
 * @param {number} [options.rows=30] — Target number of price bins.
 * @param {number} [options.valueAreaPct=0.7] — Fraction of total volume the
 *   value area must contain (standard 70%).
 * @returns {{ rows: Array<{priceLo: number, priceHi: number, priceCenter: number, volume: number}>,
 *   pocIndex: number, pocPrice: number, vah: number, val: number,
 *   maxVolume: number, totalVolume: number, step: number, gridMin: number,
 *   gridMax: number, valueAreaCoverage: number,
 *   sensitivity: {stable: boolean, pocSpread: number, variants: Array<number>} } | null}
 *   Null when there is not enough valid data. `sensitivity.stable` is false
 *   when POC moves more than one row size across 24/30/36-row grids — treat
 *   such levels as rough zones, not precise lines.
 */
function computeVolumeProfile(candles, options) {
  const rows = (options && options.rows) || 30;
  const valueAreaPct = (options && options.valueAreaPct) || 0.7;

  if (!Array.isArray(candles) || candles.length < 1) return null;

  // Keep bars with a usable range and positive volume.
  const valid = candles.filter((c) => (
    c && Number.isFinite(c.high) && Number.isFinite(c.low)
    && Number.isFinite(c.volume) && c.volume > 0 && c.high >= c.low
  ));
  if (valid.length < 1) return null;

  let minLow = Infinity;
  let maxHigh = -Infinity;
  for (const c of valid) {
    if (c.low < minLow) minLow = c.low;
    if (c.high > maxHigh) maxHigh = c.high;
  }
  if (!Number.isFinite(minLow) || !Number.isFinite(maxHigh) || maxHigh < minLow) return null;
  if (maxHigh === minLow) {
    const padding = Math.max(Math.abs(minLow) * 0.001, 0.01);
    minLow -= padding;
    maxHigh += padding;
  }

  const mainRows = Math.max(8, Math.min(60, Math.round(rows) || 30));
  const grid = _stableGrid(minLow, maxHigh, mainRows);
  const bins = _distributeVolume(valid, grid);
  const levels = _levelsFromBins(bins, valueAreaPct);
  if (!levels) return null;

  // Sensitivity probe: POC should barely move across coarser/finer grids.
  // A large spread means the level is a binning artifact, not structure.
  const variantRows = [24, 36];
  const pocPrices = [grid.gridMin + (levels.pocIndex + 0.5) * grid.step];
  for (const r of variantRows) {
    const g = _stableGrid(minLow, maxHigh, r);
    const lv = _levelsFromBins(_distributeVolume(valid, g), valueAreaPct);
    if (lv) pocPrices.push(g.gridMin + (lv.pocIndex + 0.5) * g.step);
  }
  const pocSpread = Math.max(...pocPrices) - Math.min(...pocPrices);

  const profileRows = bins.map((volume, b) => {
    const priceLo = grid.gridMin + b * grid.step;
    const priceHi = priceLo + grid.step;
    return { priceLo, priceHi, priceCenter: (priceLo + priceHi) / 2, volume };
  });

  return {
    rows: profileRows,
    pocIndex: levels.pocIndex,
    pocPrice: profileRows[levels.pocIndex].priceCenter,
    vah: profileRows[levels.hi].priceHi,
    val: profileRows[levels.lo].priceLo,
    maxVolume: levels.maxVolume,
    totalVolume: levels.totalVolume,
    step: grid.step,
    gridMin: grid.gridMin,
    gridMax: grid.gridMax,
    valueAreaCoverage: levels.vaVol / levels.totalVolume,
    sensitivity: {
      stable: pocSpread <= grid.step * (1 + 1e-9),
      pocSpread,
      variants: [24, mainRows, 36],
    },
  };
}

/* ────────────────────────────────────────────────────────────
 * VolumeProfilePrimitive — ISeriesPrimitive for Lightweight Charts
 * ──────────────────────────────────────────────────────────── */

/**
 * Draws the computed profile as horizontal volume bars in a stable lane at
 * the right edge of the main pane. The lane width is independent of candle
 * spacing, so zooming cannot change the profile's visual weight.
 *
 * @param {Object} options
 * @param {Object} options.profile — Return value of computeVolumeProfile().
 * @param {number|string|null} [options.startTime] — Manual anchor candle time.
 * @param {boolean} [options.showStartLine=false] — Draw the anchor marker.
 * @param {boolean} [options.isDark=false] — Theme flag for fallback colors.
 * @param {{base: string, valueArea: string, poc: string, startLine: string}} [options.colors]
 *   Palette resolved from UI theme tokens by the caller. When omitted, the
 *   legacy neutral blue/orange fallback is used (e.g. unit-test context).
 */
class VolumeProfilePrimitive {
  constructor(options) {
    this._profile = options.profile;
    this._startTime = options.startTime || null;
    this._showStartLine = !!options.showStartLine;
    this._isDark = !!options.isDark;
    this._colors = (options && options.colors) || null;
    /** @type {object|null} LightweightCharts chart reference (set on attach) */
    this._chart = null;
    /** @type {object|null} LightweightCharts series reference (set on attach) */
    this._series = null;
    /** @type {Function|null} Primitive repaint callback (captured on attach) */
    this._requestUpdate = null;
  }

  /**
   * Replace the theme flag and repaint.
   * @param {boolean} isDark
   */
  setDark(isDark) {
    this._isDark = !!isDark;
    if (this._requestUpdate) {
      try { this._requestUpdate(); } catch (_) { /* ignore */ }
    }
  }

  /**
   * Replace the palette (e.g. on theme toggle) and repaint.
   * @param {{base: string, valueArea: string, poc: string, startLine: string}} colors
   */
  setColors(colors) {
    if (colors) this._colors = colors;
    if (this._requestUpdate) {
      try { this._requestUpdate(); } catch (_) { /* ignore */ }
    }
  }

  /**
   * Called when the primitive is attached to a series.
   * @param {{ chart: object, series: object, requestUpdate: Function }} params
   */
  attached({ chart, series, requestUpdate }) {
    this._chart = chart;
    this._series = series;
    this._requestUpdate = (typeof requestUpdate === 'function') ? requestUpdate : null;
  }

  /**
   * Called when the primitive is detached from a series.
   */
  detached() {
    this._chart = null;
    this._series = null;
    this._requestUpdate = null;
  }

  /**
   * Called on each chart update. No-op since coordinates resolve in draw().
   */
  updateAllViews() {
    // Coordinates are computed in draw() — nothing to pre-calculate.
  }

  /**
   * Return the pane views for this primitive (single view: this).
   * @returns {Array<object>}
   */
  paneViews() {
    return [this];
  }

  /**
   * Z-order: above candles so the histogram is never hidden by bars.
   * @returns {string}
   */
  zOrder() {
    return 'top';
  }

  /**
   * The renderer object — this primitive itself acts as the renderer.
   * @returns {this}
   */
  renderer() {
    return this;
  }

  /**
   * Draw the volume histogram rows on the chart canvas.
   * @param {{ useMediaCoordinateSpace: (fn: (params: { context: CanvasRenderingContext2D }) => void) => void }} target
   */
  draw(target) {
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      if (!this._chart || !this._series) return;
      if (!this._profile || !this._profile.rows || this._profile.rows.length === 0) return;

      const timeScale = this._chart.timeScale();
      const series = this._series;

      const paneWidth = (mediaSize && mediaSize.width) || (ctx.canvas && ctx.canvas.width) || 0;
      const paneHeight = (mediaSize && mediaSize.height) || (ctx.canvas && ctx.canvas.height) || 0;
      if (!paneWidth) return;
      const totalW = Math.min(160, Math.max(56, paneWidth * 0.18));
      const rightEdge = paneWidth - 8;

      const fallback = this._isDark
        ? { base: 'rgba(237,237,237,0.30)', valueArea: 'rgba(237,237,237,0.52)', poc: '#E8B93E', startLine: 'rgba(237,237,237,0.45)' }
        : { base: 'rgba(17,17,17,0.30)', valueArea: 'rgba(17,17,17,0.52)', poc: '#8A6D00', startLine: 'rgba(17,17,17,0.45)' };
      const palette = this._colors || fallback;
      const baseFill = palette.base;
      const vaFill = palette.valueArea;
      const pocFill = palette.poc;

      const maxVol = this._profile.maxVolume || 1;
      const inValueArea = (row) => row.priceHi > this._profile.val && row.priceLo < this._profile.vah;

      ctx.save();
      if (this._showStartLine && this._startTime != null && paneHeight) {
        const startX = timeScale.timeToCoordinate(this._startTime);
        if (startX != null) {
          ctx.beginPath();
          ctx.setLineDash([4, 4]);
          ctx.strokeStyle = palette.startLine;
          ctx.lineWidth = 1;
          ctx.moveTo(startX, 0);
          ctx.lineTo(startX, paneHeight);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
      for (let i = 0; i < this._profile.rows.length; i++) {
        const row = this._profile.rows[i];
        if (!row || row.volume <= 0) continue;
        const yTop = series.priceToCoordinate(row.priceHi);
        const yBot = series.priceToCoordinate(row.priceLo);
        if (yTop == null || yBot == null) continue;
        const h = yBot - yTop;
        if (h < 1) continue;
        const w = Math.max(1, (row.volume / maxVol) * totalW);
        ctx.fillStyle = i === this._profile.pocIndex ? pocFill : (inValueArea(row) ? vaFill : baseFill);
        // Right-anchored: bars grow leftwards from the anchor edge.
        ctx.fillRect(rightEdge - w, yTop, w, h - 0.5);
      }
      ctx.restore();
    });
  }
}

/* ────────────────────────────────────────────────────────────
 * Global exports (vanilla JS — no module bundler)
 * ──────────────────────────────────────────────────────────── */
if (typeof window !== 'undefined') {
  window.selectVolumeProfileCandles = selectVolumeProfileCandles;
  window.computeVolumeProfile = computeVolumeProfile;
  window.VolumeProfilePrimitive = VolumeProfilePrimitive;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { selectVolumeProfileCandles, computeVolumeProfile, VolumeProfilePrimitive };
}
