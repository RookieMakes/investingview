/**
 * hover-highlight.js — soft hover highlight for candlestick charts.
 *
 * Lightweight-Charts v5.2 CandlestickStyleOptions has NO crosshair-dot option
 * (unlike LineSeries `crosshairMarkerVisible`), so candles never got the
 * line-chart hover dot. The markers plugin cannot be used either:
 * createSeriesMarkers() replaces ALL markers and both chart modules already
 * use it for earnings + transaction markers.
 *
 * Instead this follows the existing custom-primitive pattern
 * (SessionShadePrimitive in session-shade.js, PctMovePrimitive in
 * pivot-move.js): `candleSeries.attachPrimitive(primitive)` with the
 * ISeriesPrimitive interface
 * (attached/detached/updateAllViews/paneViews/zOrder/renderer/draw).
 *
 * What it draws, glued to the crosshair-hovered candle (in sync with the
 * existing floating tooltip, which drives it via setHover):
 *   (a) a full-pane-height vertical band centered on the hovered bar, width
 *       from the time-scale barSpacing clamped to 6–40px, filled with the
 *       candle-direction color at alpha ~0.06–0.08;
 *   (b) a filled dot (r≈4.5px) at the tooltip-side extreme (high when the
 *       tooltip sits above the candle, low when flipped below), offset 10px
 *       outward from the extreme, in the direction color with a thin
 *       contrasting ring (zOrder 'top' so it sits above candles).
 *
 * Loaded globally via index.html (same as session-shade.js / pivot-move.js).
 * Consumed by the Charts grid charts and the Portfolio modal daily + 15m
 * intraday charts (the tooltip-bearing candlestick charts). Live charts have
 * no crosshair/tooltip handler, so no highlight is attached there (no new
 * subscriptions are added anywhere — hover state is pushed from the existing
 * subscribeCrosshairMove handlers).
 *
 * Exports (globals):
 *   - HoverHighlightPrimitive — ISeriesPrimitive described above.
 *   - hoverHighlightColors(isDark) — theme-aware { bandUp, bandDown,
 *     dotUp, dotDown, ring } colors.
 */

/** Base direction colors (match the candleSeries up/down in charts.js / portfolio.js). */
const HOVER_HIGHLIGHT_UP = '#26a69a';
const HOVER_HIGHLIGHT_DOWN = '#ef5350';

/**
 * Convert a '#rrggbb' hex color to an rgba() string at the given alpha.
 * Falls back to the raw input if it cannot be parsed.
 * @param {string} hex
 * @param {number} alpha
 * @returns {string}
 */
function _hoverRgba(hex, alpha) {
  const m = typeof hex === 'string' && hex.match(/^#([0-9a-fA-F]{6})$/);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
}

/**
 * Theme-aware hover-highlight colors.
 * Bands stay whisper-soft (alpha ~0.06–0.08); dots reuse the candle
 * direction colors so the highlight always agrees with the candle body;
 * the ring contrasts against both the dot and the pane background.
 * @param {boolean} isDark — Whether dark theme is active.
 * @returns {{ bandUp: string, bandDown: string, dotUp: string, dotDown: string, ring: string }}
 */
function hoverHighlightColors(isDark) {
  return isDark
    ? {
      bandUp: _hoverRgba(HOVER_HIGHLIGHT_UP, 0.08),
      bandDown: _hoverRgba(HOVER_HIGHLIGHT_DOWN, 0.08),
      dotUp: HOVER_HIGHLIGHT_UP,
      dotDown: HOVER_HIGHLIGHT_DOWN,
      ring: 'rgba(255,255,255,0.9)',
    }
    : {
      bandUp: _hoverRgba(HOVER_HIGHLIGHT_UP, 0.07),
      bandDown: _hoverRgba(HOVER_HIGHLIGHT_DOWN, 0.07),
      dotUp: HOVER_HIGHLIGHT_UP,
      dotDown: HOVER_HIGHLIGHT_DOWN,
      ring: 'rgba(0,0,0,0.4)',
    };
}

/**
 * Soft vertical band + tooltip-side extreme dot behind/above the hovered candle.
 * Implements the LightweightCharts ISeriesPrimitive interface
 * (attached/detached/updateAllViews/paneViews/zOrder/renderer/draw),
 * following the SessionShadePrimitive pattern in session-shade.js.
 */
class HoverHighlightPrimitive {
  /**
   * @param {Object} [options]
   * @param {{ bandUp: string, bandDown: string, dotUp: string, dotDown: string, ring: string }} [options.colors]
   */
  constructor(options) {
    this._colors = (options && options.colors) || hoverHighlightColors(false);
    /** @type {number|string|null} Hovered bar time (UTCTimestamp or business-day string). */
    this._time = null;
    /** @type {number|null} Hovered candle anchor price (tooltip-side extreme: high/low). */
    this._price = null;
    /** @type {'up'|'down'|null} Candle direction (close >= open). */
    this._direction = null;
    /** @type {'above'|'below'|null} Which side the tooltip sits on (dot offset direction). */
    this._side = null;
    /** @type {object|null} LightweightCharts chart reference (set on attach). */
    this._chart = null;
    /** @type {object|null} LightweightCharts series reference (set on attach). */
    this._series = null;
    /** @type {Function|null} Primitive repaint callback (captured on attach). */
    this._requestUpdate = null;
  }

  /**
   * Update the hovered candle. Call with (null) to clear the highlight
   * (e.g. when the tooltip hides or the pointer leaves the chart).
   * Every call requests a repaint so the highlight tracks mousemove.
   * price is the anchor extreme (high when the tooltip sits above the
   * candle, low when flipped below); side selects the 10px outward
   * offset direction. side=null preserves the legacy behavior (dot drawn
   * at the given price with no offset).
   * @param {number|string|null} time
   * @param {number|null} [price]
   * @param {'up'|'down'|null} [direction]
   * @param {'above'|'below'|null} [side]
   */
  setHover(time, price, direction, side = null) {
    this._time = (time === undefined) ? null : time;
    this._price = (price === undefined) ? null : price;
    this._direction = (direction === undefined) ? null : direction;
    this._side = (side === undefined) ? null : side;
    if (this._requestUpdate) {
      try { this._requestUpdate(); } catch (_) { /* ignore */ }
    }
  }

  /**
   * Replace colors (e.g. on theme toggle) and repaint.
   * @param {{ bandUp: string, bandDown: string, dotUp: string, dotDown: string, ring: string }} colors
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
   * Z-order: above candles so the close dot is never hidden by the bar.
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
   * Draw the hover band + tooltip-side extreme dot on the chart canvas.
   * The dot anchors to the given extreme price, offset 10px outward from
   * the bar on the tooltip's side ('above' → above high, 'below' → below
   * low); side=null draws at the price with no offset (legacy fallback).
   * @param {{ useMediaCoordinateSpace: (fn: (params: { context: CanvasRenderingContext2D, mediaSize: { width: number, height: number } }) => void) => void }} target
   */
  draw(target) {
    const DOT_GAP = 10;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      if (!this._chart || !this._series) return;
      if (this._time == null || this._price == null) return;
      if (this._side != null && this._side !== 'above' && this._side !== 'below') return;
      const timeScale = this._chart.timeScale();
      const x = timeScale.timeToCoordinate(this._time);
      let y = this._series.priceToCoordinate(this._price);
      if (x == null || y == null) return;
      if (this._side === 'below') y = y + DOT_GAP;
      else if (this._side === 'above') y = y - DOT_GAP;
      const height = (mediaSize && mediaSize.height) || (ctx.canvas && ctx.canvas.height) || 0;
      if (!height) return;

      // Bar width from the time scale; fixed fallback when unavailable.
      let barSpacing = 14;
      try {
        const tsOpts = typeof timeScale.options === 'function' ? timeScale.options() : null;
        if (tsOpts && typeof tsOpts.barSpacing === 'number' && tsOpts.barSpacing > 0) {
          barSpacing = tsOpts.barSpacing;
        }
      } catch (_) { /* keep fallback */ }
      const w = Math.max(6, Math.min(40, barSpacing));

      const isUp = this._direction !== 'down';
      const band = isUp ? this._colors.bandUp : this._colors.bandDown;
      const dot = isUp ? this._colors.dotUp : this._colors.dotDown;

      ctx.save();
      // (a) Full-pane-height vertical band centered on the hovered bar.
      ctx.fillStyle = band;
      ctx.fillRect(x - w / 2, 0, w, height);
      // (b) Tooltip-side extreme dot with a thin contrasting ring.
      ctx.beginPath();
      ctx.arc(x, y, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = dot;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = this._colors.ring;
      ctx.stroke();
      ctx.restore();
    });
  }
}

/* ────────────────────────────────────────────────────────────
 * Global exports (vanilla JS — no module bundler)
 * ──────────────────────────────────────────────────────────── */
if (typeof window !== 'undefined') {
  window.HoverHighlightPrimitive = HoverHighlightPrimitive;
  window.hoverHighlightColors = hoverHighlightColors;
}
