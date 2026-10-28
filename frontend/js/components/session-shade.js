/**
 * session-shade.js — TradingView-style pre/post-market session shading for
 * LightweightCharts + shared ET axis formatters for the live surfaces.
 *
 * Loaded globally via index.html (same as pivot-move.js). Consumed by the
 * Charts Live tab and the expand-modal Live controller (both intraday-only,
 * where ET sessions are well-defined — daily grid charts are excluded).
 *
 * Exports (globals):
 *   - SessionShadePrimitive — ISeriesPrimitive that fills full-pane-height
 *     rects behind candles (zOrder 'bottom').
 *   - computeSessionBands(candleTimesSec) — derive PRE/POST ET bands from
 *     the sessions' own bars (index-safe: band edges are always real bars).
 *   - etTimeFormatter / etTickMarkFormatter — ET axis label formatters
 *     (HH:MM America/New_York), matching the legacy 15m modal renderer.
+ *   - formatChartDateDDMONYY — global "DD MON YY" date formatter (e.g.
+ *     "13 Aug 26"), no time component ever.
 */

const SESSION_SHADE_TZ = 'America/New_York';

/** ET wall-clock parts for an epoch-ms instant. */
function _etParts(tsMs) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SESSION_SHADE_TZ, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short',
  }).formatToParts(new Date(tsMs));
  const get = (t) => (parts.find((p) => p.type === t) || {}).value;
  return {
    y: Number(get('year')),
    m: Number(get('month')),
    d: Number(get('day')),
    mins: Number(get('hour')) * 60 + Number(get('minute')),
    // Sat/Sun in ET — Yahoo sends no candles, but guard anyway.
    isWeekend: get('weekday') === 'Sat' || get('weekday') === 'Sun',
  };
}

/** ET calendar day key "y-m-d" for a UTCTimestamp (seconds). */
function etDateKey(tsSec) {
  if (typeof tsSec !== 'number' || !tsSec) return null;
  const p = _etParts(tsSec * 1000);
  return p.y + '-' + p.m + '-' + p.d;
}

/**
 * Derive session bands from candle times (UTCTimestamp seconds, ascending).
 *
 * IMPORTANT: lightweight-charts lays bars out by INDEX with uniform spacing,
 * so overnight gaps are ~1 bar wide no matter how many wall-clock hours they
 * span. Wall-clock session windows (e.g. 16:00–20:00 ET) therefore collapse
 * to ~2px slivers when a session has no bars — which is exactly why "post"
 * was invisible while "pre" (full of bars) rendered fine.
 *
 * So bands are built from the SESSION'S OWN BARS: contiguous same-session
 * runs per ET day, from first-bar time to last-bar time. Sessions with live
 * bars get full-width shading; empty sessions get nothing (nothing traded).
 * Band edges are always real bar times, so coordinate lookup cannot miss.
 *
 * Returns [{ from, to, kind: 'pre'|'post' }]. Only 'pre' (04:00–09:30 ET)
 * and 'post' (16:00–20:00 ET) runs are emitted; regular session stays clean.
 */
function computeSessionBands(candleTimesSec, opts = {}) {
  const bands = [];
  // Group bar times by (ET day, session kind).
  const runs = new Map(); // key -> { kind, first, last }
  for (const t of candleTimesSec || []) {
    if (typeof t !== 'number' || !t) continue;
    const p = _etParts(t * 1000);
    if (p.isWeekend) continue;
    const kind = (p.mins >= 4 * 60 && p.mins < 9 * 60 + 30)
      ? 'pre'
      : (p.mins >= 16 * 60 && p.mins < 20 * 60) ? 'post' : null;
    if (!kind) continue; // regular session: no shading
    const key = p.y + '-' + p.m + '-' + p.d + '|' + kind;
    const run = runs.get(key);
    if (run) {
      if (t < run.first) run.first = t;
      if (t > run.last) run.last = t;
    } else {
      runs.set(key, { kind, first: t, last: t });
    }
  }
  for (const run of runs.values()) {
    bands.push({ from: run.first, to: run.last, kind: run.kind });
  }
  bands.sort((a, b) => a.from - b.from);
  return bands;
}

/** Muted session colors, theme-aware (muted yellowish pre, blue post). */
function sessionShadeColors(isDark) {
  return isDark
    ? { pre: 'rgba(202,174,104,0.22)', post: 'rgba(33,150,243,0.13)' }
    : { pre: 'rgba(202,174,104,0.16)', post: 'rgba(33,150,243,0.07)' };
}

/** Crosshair/tooltip clock in ET. */
function etTimeFormatter(time) {
  const d = new Date(time * 1000);
  return d.toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: SESSION_SHADE_TZ,
  });
}

/** Axis tick labels in ET (day/month breakpoints included for multi-day views). */
function etTickMarkFormatter(time, tickMarkType, _locale) {
  const d = new Date(time * 1000);
  try {
    if (tickMarkType === LightweightCharts.TickMarkType.Time) {
      return d.toLocaleTimeString('en-US', {
        hour: '2-digit', minute: '2-digit', hour12: false, timeZone: SESSION_SHADE_TZ,
      });
    }
    if (tickMarkType === LightweightCharts.TickMarkType.DayOfMonth) {
      return d.toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', timeZone: SESSION_SHADE_TZ,
      });
    }
    if (tickMarkType === LightweightCharts.TickMarkType.Month) {
      return d.toLocaleDateString('en-US', {
        month: 'short', year: 'numeric', timeZone: SESSION_SHADE_TZ,
      });
    }
  } catch (_) { /* fall through */ }
  return null;
}

/**
 * Full-pane-height session shading behind candles.
 * Implements the LightweightCharts ISeriesPrimitive interface
 * (attached/detached/updateAllViews/paneViews/zOrder/renderer/draw),
 * following the PctMovePrimitive pattern in pivot-move.js.
 */
class SessionShadePrimitive {
  /**
   * @param {Object} options
   * @param {Array<{from:number,to:number,kind:'pre'|'post'}>} options.bands
   * @param {{pre:string,post:string}} options.colors
   * @param {number[]} [options.bars] Sorted candle UTCTimestamps (fallback anchor)
   * @param {number} [options.bucketSec] Candle bucket width in seconds
   */
  constructor(options) {
    this._bands = (options && options.bands) || [];
    this._colors = (options && options.colors) || sessionShadeColors(false);
    this._bars = (options && options.bars) || [];
    this._bucketSec = (options && options.bucketSec) || 900;
    this._chart = null;
    this._series = null;
  }

  /** Replace bands (caller re-attaches to force a redraw — see below). */
  setBands(bands) {
    this._bands = bands || [];
  }

  /** Replace bar anchor times (sorted UTCTimestamps) + bucket width. */
  setBars(bars, bucketSec) {
    this._bars = bars || [];
    if (bucketSec) this._bucketSec = bucketSec;
  }

  setColors(colors) {
    this._colors = colors || this._colors;
  }

  attached({ chart, series }) {
    this._chart = chart;
    this._series = series;
  }

  detached() {
    this._chart = null;
    this._series = null;
  }

  updateAllViews() {
    // Coordinates resolve in draw() — nothing to pre-calculate.
  }

  paneViews() {
    return [this];
  }

  /** Behind candles and volume, like TradingView session shading. */
  zOrder() {
    return 'bottom';
  }

  renderer() {
    return this;
  }

  draw(target) {
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      if (!this._chart || !this._bands.length) return;
      const timeScale = this._chart.timeScale();
      const height = (mediaSize && mediaSize.height) || ctx.canvas.height || 0;
      const width = (mediaSize && mediaSize.width) || ctx.canvas.width || 0;
      if (!height || !width) return;
      ctx.save();
      for (const b of this._bands) {
        const x1 = this._resolveX(timeScale, b.from);
        const x2 = this._resolveX(timeScale, b.to);
        if (x1 == null || x2 == null) continue;
        const left = Math.max(0, Math.min(x1, x2));
        const right = Math.min(width, Math.max(x1, x2));
        if (right <= left) continue;
        ctx.fillStyle = b.kind === 'post' ? this._colors.post : this._colors.pre;
        ctx.fillRect(left, 0, right - left, height);
      }
      ctx.restore();
    });
  }

  /**
   * Resolve an x coordinate for a band edge. Direct lookup first; when the
   * library returns null (bar-less overnight gaps on some versions), fall
   * back to fractional-index interpolation between the flanking real bars —
   * consistent with the uniform-index layout, so post bands can never
   * silently vanish (or smear: offsets stay bounded by the flanking bars).
   */
  _resolveX(timeScale, t) {
    const direct = timeScale.timeToCoordinate(t);
    if (direct != null) return direct;
    const bars = this._bars;
    if (!bars || bars.length < 2) return null;
    // Binary search: largest i with bars[i] <= t (may be -1 / last).
    let lo = 0;
    let hi = bars.length - 1;
    let i = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (bars[mid] <= t) { i = mid; lo = mid + 1; }
      else { hi = mid - 1; }
    }
    // Flanking pair (clamped to ends for extrapolation).
    const a = Math.max(0, Math.min(i, bars.length - 2));
    const b = a + 1;
    const ta = bars[a];
    const tb = bars[b];
    if (tb === ta) return null;
    const xa = timeScale.timeToCoordinate(ta);
    const xb = timeScale.timeToCoordinate(tb);
    if (xa == null || xb == null) return null;
    return xa + ((t - ta) / (tb - ta)) * (xb - xa);
  }
}

/**
 * Format a chart date as DD MON YY (e.g. "13 Aug 26").
 * Global date util (vanilla global, like the rest of this file).
 * Accepts "YYYY-MM-DD" strings (a time suffix is tolerated and ignored),
 * epoch seconds (LightweightCharts UTCTimestamp), epoch ms, or a Date.
 * Never includes a time component. Manual parts (not Intl) so ordering is
 * always day-month-year regardless of locale.
 * @param {string|number|Date} time
 * @returns {string} e.g. "13 Aug 26", or "" when unparseable.
 */
function formatChartDateDDMONYY(time) {
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
               'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  let y, m, d;
  if (time instanceof Date) {
    if (isNaN(time.getTime())) return '';
    y = time.getFullYear();
    m = time.getMonth();
    d = time.getDate();
  } else if (typeof time === 'number' && isFinite(time)) {
    const ms = time > 1e11 ? time : time * 1000;
    const dt = new Date(ms);
    if (isNaN(dt.getTime())) return '';
    y = dt.getFullYear();
    m = dt.getMonth();
    d = dt.getDate();
  } else if (typeof time === 'string') {
    const mt = time.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (!mt) return '';
    y = Number(mt[1]);
    m = Number(mt[2]) - 1;
    d = Number(mt[3]);
    if (m < 0 || m > 11 || d < 1 || d > 31) return '';
  } else {
    return '';
  }
  return String(d).padStart(2, '0') + ' ' + MON[m] + ' ' + String(y).slice(-2);
}
