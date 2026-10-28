/**
 * pivot-move.js — Percentage Move Lines for TradingView Lightweight Charts.
 *
 * Detects up to 5 pivot points using **trend-based detection**, then draws
 * diagonal lines between consecutive pivots (and today's candle) with
 * percentage-change labels at each line midpoint.
 *
 * Algorithm:
 *   Step 1 — Determine slope direction over an expanding window (10→20→30
 *            candles, excluding today). Compare first HIGH to last HIGH in
 *            the window. Downward slope → look for HIGHEST HIGH.
 *            Upward slope → look for LOWEST LOW.
 *   Step 2 — Find the extreme point in the window (highest high or lowest low).
 *   Step 3 — Confirm by iteratively checking 10 more candles backward. If a
 *            higher high (downward slope) or lower low (upward slope) is found,
 *            replace the pivot with that candle.
 *   Step 4 — Check 5% threshold. If met, accept the pivot. Otherwise expand
 *            the window and retry. If no pivot found after 30 candles, give up.
 *   Step 5 — Find pivots 2–5 by scanning backwards from the previous pivot,
 *            alternating type (high↔low) and requiring ≥5% move between
 *            consecutive pivots. Each pivot undergoes iterative 10-candle
 *            confirmation. Late pivots may not be found; the array simply
 *            stops growing.
 *
 * Dependencies: LightweightCharts v5.2+ (standalone CDN build)
 *
 * Exports (window globals for vanilla JS usage):
 *   - findPivotBySlopeChange(candles)
 *   - PctMovePrimitive  (ISeriesPrimitive implementation)
 *
 * @example
 *   const result = findPivotBySlopeChange(candleData);
 *   if (result) {
 *     const primitive = new PctMovePrimitive({
 *       today: result.today,
 *       pivots: result.pivots,
 *       isDark: true,
 *     });
 *     candleSeries.attachPrimitive(primitive);
 *   }
 */

/* ────────────────────────────────────────────────────────────
 * Pivot Detection — Trend-Based Algorithm
 * ──────────────────────────────────────────────────────────── */

/**
 * Find pivot points using trend-based detection (up to 5 pivots).
 *
 * STEP 1 — Determine slope direction over an expanding window (10→20→30):
 *   Compare first HIGH to last HIGH in the window (excluding today).
 *   Downward slope → look for HIGHEST HIGH.
 *   Upward slope   → look for LOWEST LOW.
 *   Flat → expand window by 10, try again (up to 30 candles).
 *
 * STEP 2 — Find the extreme point in the window:
 *   DOWNWARD slope → candle with highest high.
 *   UPWARD slope   → candle with lowest low.
 *
 * STEP 3 — Confirm by iteratively checking 10 candles backward:
 *   From the initial pivot position, go back another 10 candles.
 *   If a higher high (downward slope) or lower low (upward slope) is found,
 *   replace the pivot with that candle. Repeat until no better extreme is found.
 *
 * STEP 4 — Check 5% threshold:
 *   HIGHEST HIGH pivot: (pivot.price - today.low) / today.low × 100
 *   LOWEST LOW pivot:   (today.high - pivot.price) / pivot.price × 100
 *   If ≥ 5% → accept. Otherwise expand window and retry.
 *
 * STEP 5 — Find pivots 2–5 (loop, alternating type, 10 candles back):
 *   From the previous pivot's position, scan backwards up to 10 candles.
 *   Alternate type: if previous was HIGH → look for LOWEST LOW, and vice versa.
 *   Must be ≥ 5% different from the previous pivot.
 *   Each candidate undergoes iterative 10-candle confirmation (same as Step 3).
 *   Loop runs up to 4 more times (pivots 2–5). Stops early if none found.
 *
 * @param {Array<{time: string, open: number, high: number, low: number, close: number, volume?: number}>} candles
 *   Array of OHLCV candles sorted by time ascending.
 * @returns {{ today: {high: number, low: number, time: string}, pivots: Array<{type: 'high'|'low', time: string, price: number, index: number}> } | null}
 *   Today's data and an array of detected pivots (length 1–5), or null if no valid pivot found.
 */
function findPivotBySlopeChange(candles) {
  if (!candles || candles.length < 15) return null;

  const len = candles.length;
  const today = candles[len - 1];
  const minPctMove = 5;  // 5%

  // Try windows of increasing size: 10, 20, 30
  const windowSizes = [10, 20, 30];

  for (const windowSize of windowSizes) {
    // Need at least windowSize + 1 candles (exclude today)
    if (len - 1 < windowSize) continue;

    // ── STEP 1: Determine slope direction ──
    // Window: candles[len - 1 - windowSize] to candles[len - 2]
    const firstIdx = len - 1 - windowSize;
    const lastIdx = len - 2;
    const firstHigh = candles[firstIdx].high;
    const lastHigh = candles[lastIdx].high;

    // If flat, try larger window
    if (firstHigh === lastHigh) continue;

    const downwardSlope = lastHigh < firstHigh;

    // ── STEP 2: Find extreme point in window ──
    let extremeIdx = -1;
    let extremePrice = -Infinity;

    if (downwardSlope) {
      // DOWNWARD slope → find HIGHEST HIGH
      extremePrice = -Infinity;
      for (let i = firstIdx; i <= lastIdx; i++) {
        if (candles[i].high > extremePrice) {
          extremePrice = candles[i].high;
          extremeIdx = i;
        }
      }
    } else {
      // UPWARD slope → find LOWEST LOW
      extremePrice = Infinity;
      for (let i = firstIdx; i <= lastIdx; i++) {
        if (candles[i].low < extremePrice) {
          extremePrice = candles[i].low;
          extremeIdx = i;
        }
      }
    }

    if (extremeIdx === -1) continue;

    // ── STEP 3: Confirm by iteratively checking 10 candles back ──
    let confirmed = true;
    while (confirmed && extremeIdx > 0) {
      const confirmStart = Math.max(0, extremeIdx - 10);
      const confirmEnd = extremeIdx - 1;

      if (confirmStart >= confirmEnd) break;

      let foundBetter = false;

      if (downwardSlope) {
        // Check for HIGHER HIGH in confirmation window
        for (let i = confirmStart; i <= confirmEnd; i++) {
          if (candles[i].high > extremePrice) {
            extremePrice = candles[i].high;
            extremeIdx = i;
            foundBetter = true;
          }
        }
      } else {
        // Check for LOWER LOW in confirmation window
        for (let i = confirmStart; i <= confirmEnd; i++) {
          if (candles[i].low < extremePrice) {
            extremePrice = candles[i].low;
            extremeIdx = i;
            foundBetter = true;
          }
        }
      }

      // No better extreme found → stop
      if (!foundBetter) break;

      // Check if slope direction is still maintained in the new window
      const windowStart = confirmStart;
      const windowEnd = extremeIdx - 1;

      if (windowStart >= windowEnd) break;

      if (downwardSlope) {
        // For HIGHEST HIGH: highs trending down → slope valid
        if (candles[windowEnd].high >= candles[windowStart].high) break;
      } else {
        // For LOWEST LOW: lows trending up → slope valid
        if (candles[windowEnd].low <= candles[windowStart].low) break;
      }

      confirmed = true;
    }

    // ── STEP 4: Check 5% threshold ──
    let pctMove;
    if (downwardSlope) {
      // Pivot is HIGHEST HIGH (above today)
      pctMove = ((extremePrice - today.low) / today.low) * 100;
    } else {
      // Pivot is LOWEST LOW (below today)
      pctMove = ((today.high - extremePrice) / extremePrice) * 100;
    }

    if (pctMove >= minPctMove) {
      // ── STEP 5: Find pivots 2–5 (loop, alternating type, 10 candles back) ──
      const firstPivot = {
        type: downwardSlope ? 'high' : 'low',
        time: candles[extremeIdx].time,
        price: extremePrice,
        index: extremeIdx,
      };

      const pivots = [firstPivot];
      let prevPivot = firstPivot;

      for (let p = 1; p < 5; p++) {
        // Search 10 candles back from prevPivot
        const searchStart = prevPivot.index - 1;
        const searchEnd = Math.max(0, prevPivot.index - 10);

        let foundPivot = null;

        for (let i = searchStart; i >= searchEnd; i--) {
          if (i < 0) break;

          // Alternate type: if prev was high, look for low, and vice versa
          const candidateType = prevPivot.type === 'high' ? 'low' : 'high';
          const candidatePrice = candidateType === 'low' ? candles[i].low : candles[i].high;

          // Check 5% threshold from prevPivot
          const pctFromPrev = Math.abs(candidatePrice - prevPivot.price) / prevPivot.price * 100;

          if (pctFromPrev >= minPctMove) {
            foundPivot = {
              type: candidateType,
              time: candles[i].time,
              price: candidatePrice,
              index: i
            };
            break;
          }
        }

        if (!foundPivot) break;

        // Apply iterative 10-candle confirmation (same logic as Step 3)
        let confirmed = true;
        while (confirmed && foundPivot.index > 0) {
          const confirmStart = Math.max(0, foundPivot.index - 10);
          const confirmEnd = foundPivot.index - 1;

          if (confirmStart >= confirmEnd) break;

          let foundBetter = false;

          if (foundPivot.type === 'low') {
            for (let i = confirmStart; i <= confirmEnd; i++) {
              if (candles[i].low < foundPivot.price) {
                foundPivot = { type: 'low', time: candles[i].time, price: candles[i].low, index: i };
                foundBetter = true;
              }
            }
          } else {
            for (let i = confirmStart; i <= confirmEnd; i++) {
              if (candles[i].high > foundPivot.price) {
                foundPivot = { type: 'high', time: candles[i].time, price: candles[i].high, index: i };
                foundBetter = true;
              }
            }
          }

          if (!foundBetter) break;

          // Slope check
          const windowStart = confirmStart;
          const windowEnd = foundPivot.index - 1;
          if (windowStart >= windowEnd) break;

          if (foundPivot.type === 'low') {
            if (candles[windowEnd].low <= candles[windowStart].low) break;
          } else {
            if (candles[windowEnd].high >= candles[windowStart].high) break;
          }
        }

        pivots.push(foundPivot);
        prevPivot = foundPivot;
      }

      return {
        today: { high: today.high, low: today.low, time: today.time },
        pivots: pivots,
      };
    }
    // If <5%, continue to next window size
  }

  return null;  // no valid pivot found after trying all window sizes
}

/* ────────────────────────────────────────────────────────────
 * PctMovePrimitive — ISeriesPrimitive for Lightweight Charts
 * ──────────────────────────────────────────────────────────── */

/**
 * A series primitive that draws diagonal lines between pivot points and
 * today's candle with percentage-change labels at the line midpoints.
 *
 * Implements the LightweightCharts ISeriesPrimitive interface:
 *   attached(), detached(), updateAllViews(), paneViews()
 *
 * The pane view delegates to `this` for zOrder() and renderer().
 * The renderer uses `target.useMediaCoordinateSpace()` to draw on the canvas.
 *
 * @param {Object} options
 * @param {{ high: number, low: number, time: string }} options.today
 *   Today's OHLC data (high, low, time).
 * @param {Array<{ type: 'high'|'low', time: string, price: number, index: number }>} options.pivots
 *   Array of detected pivot points (1–5). Lines are drawn connecting
 *   today → pivots[0] → pivots[1] → … → pivots[n].
 * @param {boolean} options.isDark — Whether dark theme is active.
 */
class PctMovePrimitive {
  constructor(options) {
    /** @type {{ high: number, low: number, time: string }} */
    this._today = options.today;
    /** @type {Array<{ type: string, time: string, price: number, index: number }>} */
    this._pivots = options.pivots;
    /** @type {boolean} */
    this._isDark = options.isDark;
    /** @type {object|null} LightweightCharts chart reference (set on attach) */
    this._chart = null;
    /** @type {object|null} LightweightCharts series reference (set on attach) */
    this._series = null;
  }

  /**
   * Called when the primitive is attached to a series.
   * @param {{ chart: object, series: object }} params
   */
  attached({ chart, series }) {
    this._chart = chart;
    this._series = series;
  }

  /**
   * Called when the primitive is detached from a series.
   */
  detached() {
    this._chart = null;
    this._series = null;
  }

  /**
   * Called on each chart update. No-op since our drawing is static
   * (coordinates are recalculated on every draw call anyway).
   */
  updateAllViews() {
    // Coordinates are computed in draw() — nothing to pre-calculate.
  }

  /**
   * Return the pane views for this primitive.
   * We use a single pane view that delegates rendering to `this`.
   * @returns {Array<object>}
   */
  paneViews() {
    return [this];
  }

  /**
   * Z-order: render on top of candlesticks and other series.
   * @returns {string}
   */
  zOrder() {
    return 'top';
  }

  /**
   * The renderer object — this primitive itself acts as the renderer.
   * Must expose a `draw(target)` method.
   * @returns {this}
   */
  renderer() {
    return this;
  }

  /**
   * Draw the percentage move lines and labels on the chart canvas.
   *
   * Uses `target.useMediaCoordinateSpace()` to get a 2D canvas context
   * in media (pixel) coordinates. Then converts time/price values to
   * pixel positions via the chart's time scale and series price scale.
   *
   * Draws:
   *   1. Diagonal lines connecting today → pivots[0] → pivots[1] → … → pivots[n]
   *   2. Endpoint dots at all vertices
   *   3. Percentage-change labels at each line midpoint
   *
   * @param {{ useMediaCoordinateSpace: (fn: (params: { context: CanvasRenderingContext2D }) => void) => void }} target
   */
  draw(target) {
    target.useMediaCoordinateSpace(({ context: ctx }) => {
      if (!this._chart || !this._series) return;
      if (!this._today || !this._pivots || this._pivots.length === 0) return;

      const timeScale = this._chart.timeScale();
      const series = this._series;
      const lineColor = this._isDark ? 'rgba(255,255,255,0.8)' : 'rgba(0,0,0,0.8)';

      ctx.save();

      // Build array of all points: [today, ...pivots]
      const points = [
        {
          time: this._today.time,
          price: this._pivots[0].type === 'low' ? this._today.high : this._today.low,
        },
        ...this._pivots.map(p => ({ time: p.time, price: p.price })),
      ];

      // Convert all points to coordinates (do NOT filter — keep index alignment)
      const coords = points.map(p => ({
        x: timeScale.timeToCoordinate(p.time),
        y: series.priceToCoordinate(p.price),
      }));

      // Collect only valid coordinates for drawing, but track their original indices
      const validCoords = [];
      for (let i = 0; i < coords.length; i++) {
        if (coords[i].x != null && coords[i].y != null) {
          validCoords.push({ coord: coords[i], idx: i });
        }
      }

      if (validCoords.length < 2) { ctx.restore(); return; }

      // Draw lines between consecutive valid points
      ctx.beginPath();
      ctx.strokeStyle = lineColor;
      ctx.lineWidth = 2;
      ctx.moveTo(validCoords[0].coord.x, validCoords[0].coord.y);
      for (let i = 1; i < validCoords.length; i++) {
        ctx.lineTo(validCoords[i].coord.x, validCoords[i].coord.y);
      }
      ctx.stroke();

      // Draw endpoint dots at valid coordinates
      ctx.fillStyle = lineColor;
      for (const vc of validCoords) {
        ctx.beginPath();
        ctx.arc(vc.coord.x, vc.coord.y, 4, 0, Math.PI * 2);
        ctx.fill();
      }

      // Draw percentage labels at each line midpoint
      for (let i = 0; i < validCoords.length - 1; i++) {
        const c1 = validCoords[i];
        const c2 = validCoords[i + 1];

        const midX = (c1.coord.x + c2.coord.x) / 2;
        const midY = (c1.coord.y + c2.coord.y) / 2;

        // Use original indices to get correct pivots
        // Index 0 in points = today, index 1+ = pivots[i-1]
        const pIdx1 = c1.idx - 1;  // -1 = today, 0+ = pivot index
        const pIdx2 = c2.idx - 1;

        // Calculate percentage change
        let pctChange;
        if (pIdx1 === -1) {
          // Today to first pivot
          pctChange = this._pivots[0].type === 'low'
            ? ((this._today.high - this._pivots[0].price) / this._pivots[0].price) * 100
            : ((this._pivots[0].price - this._today.low) / this._today.low) * 100;
        } else {
          // Between two pivots
          const pivot1 = this._pivots[pIdx1];
          const pivot2 = this._pivots[pIdx2];
          pctChange = pivot1.type === 'high' && pivot2.type === 'low'
            ? ((pivot1.price - pivot2.price) / pivot2.price) * 100
            : ((pivot2.price - pivot1.price) / pivot1.price) * 100;
        }

        const label = `${pctChange >= 0 ? '+' : ''}${pctChange.toFixed(1)}%`;
        this._drawLabel(ctx, midX, midY, label, lineColor);
      }

      ctx.restore();
    });
  }

  /**
   * Draw a rounded-rect label with text on the canvas.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} x — center X
   * @param {number} y — center Y
   * @param {string} label — text to display
   * @param {string} lineColor — stroke/text color
   */
  _drawLabel(ctx, x, y, label, lineColor) {
    ctx.font = 'bold 12px -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif';
    const textWidth = ctx.measureText(label).width;
    const padding = 6;
    const labelH = 20;
    const bgX = x - textWidth / 2 - padding;
    const bgY = y - labelH / 2;
    const bgW = textWidth + padding * 2;
    const bgR = 4;

    ctx.fillStyle = this._isDark ? 'rgba(40,40,42,0.9)' : 'rgba(240,240,240,0.9)';
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(bgX, bgY, bgW, labelH, bgR);
    } else {
      _drawRoundedRect(ctx, bgX, bgY, bgW, labelH, bgR);
    }
    ctx.fill();

    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.4;
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(bgX, bgY, bgW, labelH, bgR);
    } else {
      _drawRoundedRect(ctx, bgX, bgY, bgW, labelH, bgR);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;

    ctx.fillStyle = lineColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x, y);
  }
}

/* ────────────────────────────────────────────────────────────
 * Helpers
 * ──────────────────────────────────────────────────────────── */

/**
 * Draw a rounded rectangle on a CanvasRenderingContext2D.
 * Fallback for browsers that don't support ctx.roundRect().
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {number} h
 * @param {number} r — corner radius
 */
function _drawRoundedRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/* ────────────────────────────────────────────────────────────
 * Global exports (vanilla JS — no module bundler)
 * ──────────────────────────────────────────────────────────── */
if (typeof window !== 'undefined') {
  window.findPivotBySlopeChange = findPivotBySlopeChange;
  window.PctMovePrimitive = PctMovePrimitive;
}
