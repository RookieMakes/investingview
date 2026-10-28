/**
 * live-auto-sr.js — Ephemeral auto S/R levels for the live intraday surfaces.
 *
 * Drawn when Live mode opens (modal Live + Charts Live tab), frozen
 * afterwards, and destroyed with the live chart. Never persisted: unlike the
 * daily-chart S/R lines, these never touch `/api/sr/levels` or the legend.
 *
 * Levels (titles double as axis labels):
 *   PDH/PDL — previous regular-session (09:30-16:00 ET) high/low.
 *   PMH/PML — today's premarket (04:00-09:30 ET) high/low (overnight-only
 *             prints and the prior evening's post-market are excluded by
 *             convention — post-market has its own thin AHH/AHL semantics).
 *   ORBH/ORBL — today's opening range (09:30-09:45 ET) high/low.
 *
 * Loaded globally via index.html (same as session-shade.js).
 * Exports (globals):
 *   - computeLiveAutoSR(candles, dailyBars, anchorDay)
 *   - applyLiveAutoSR(candleSeries, levels, isDark)
 *   - removeLiveAutoSR(candleSeries, entries)
 */

// Session windows in ET minutes since midnight.
var LIVE_AUTO_SR_PRE_START = 4 * 60;    // 04:00 ET
var LIVE_AUTO_SR_RTH_OPEN = 9 * 60 + 30; // 09:30 ET
var LIVE_AUTO_SR_ORB_END = 9 * 60 + 45;  // 09:45 ET
var LIVE_AUTO_SR_RTH_CLOSE = 16 * 60;    // 16:00 ET

/** ET wall-clock parts for an epoch-seconds timestamp (numbers, not padded). */
function _liveAutoSREtParts(tsSec) {
  var parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    }).formatToParts(new Date(tsSec * 1000));
  } catch (err) {
    return null;
  }
  var get = function (t) {
    var p = null;
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].type === t) { p = parts[i]; break; }
    }
    return p ? p.value : null;
  };
  var h = Number(get('hour'));
  if (!isFinite(h)) return null;
  h = h % 24; // Intl can emit hour "24" for midnight with hour12:false.
  var min = Number(get('minute'));
  return {
    y: Number(get('year')),
    m: Number(get('month')),
    d: Number(get('day')),
    mins: h * 60 + (isFinite(min) ? min : 0),
  };
}

function _liveAutoSRDayEq(a, b) {
  return !!a && !!b && a.y === b.y && a.m === b.m && a.d === b.d;
}

// -1/0/1 calendar comparison for {y,m,d} day tuples.
function _liveAutoSRDayCmp(a, b) {
  if (a.y !== b.y) return a.y < b.y ? -1 : 1;
  if (a.m !== b.m) return a.m < b.m ? -1 : 1;
  if (a.d !== b.d) return a.d < b.d ? -1 : 1;
  return 0;
}

/** Parse a "YYYY-MM-DD" (time suffix tolerated) daily-bar date. */
function _liveAutoSRParseDay(dateStr) {
  if (typeof dateStr !== 'string') return null;
  var mt = dateStr.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!mt) return null;
  return { y: Number(mt[1]), m: Number(mt[2]), d: Number(mt[3]) };
}

/**
 * Compute auto S/R levels from intraday candles (+ optional daily bars).
 *
 * @param {Array<{time:number,high:number,low:number}>} candles Intraday
 *   candles (UTCTimestamp seconds; ms values tolerated).
 * @param {Array<{date:string,high:number,low:number,close:number}>|null} dailyBars
 *   Regular-session daily bars for the PDH/PDL lookup (may be null).
 * @param {{y:number,m:number,d:number}|null} anchorDay Fixed "today" (ET).
 *   Defaults to the ET date of the newest candle, so weekends/CLOSED
 *   sessions anchor to the last trading day with zero special-casing.
 * @returns {{levels:Array, anchorDay:Object|null, pending:{premarket:boolean,orb:boolean}}}
 *   `levels` entries are {price, kind:'support'|'resistance', title,
 *   provisional}. `provisional` is true while its window is still forming;
 *   `pending` flags tell the caller to recompute later (freeze-once-closed).
 */
function computeLiveAutoSR(candles, dailyBars, anchorDay) {
  var empty = { levels: [], anchorDay: anchorDay || null, pending: { premarket: false, orb: false } };
  if (!Array.isArray(candles) || !candles.length) return empty;

  // Enrich + filter valid candles.
  var bars = [];
  for (var i = 0; i < candles.length; i++) {
    var c = candles[i];
    if (!c) continue;
    var t = Number(c.time);
    if (!isFinite(t) || t <= 0) continue;
    if (t > 1e11) t = Math.floor(t / 1000); // tolerate epoch-ms
    var hi = Number(c.high);
    var lo = Number(c.low);
    if (!isFinite(hi) || !isFinite(lo) || hi <= 0 || lo <= 0) continue;
    var p = _liveAutoSREtParts(t);
    if (!p || !isFinite(p.y) || !isFinite(p.m) || !isFinite(p.d)) continue;
    bars.push({ time: t, high: hi, low: lo, day: { y: p.y, m: p.m, d: p.d }, mins: p.mins });
  }
  if (!bars.length) return empty;

  var anchor = anchorDay || null;
  if (!anchor) {
    var newest = bars[0];
    for (var j = 1; j < bars.length; j++) {
      if (bars[j].time > newest.time) newest = bars[j];
    }
    anchor = newest.day;
  }

  var todayRegs = [];
  var todayPre = [];
  var todayOrb = [];
  var hasPostOrb = false;
  for (var k = 0; k < bars.length; k++) {
    var b = bars[k];
    if (!_liveAutoSRDayEq(b.day, anchor)) continue;
    if (b.mins >= LIVE_AUTO_SR_RTH_OPEN && b.mins < LIVE_AUTO_SR_RTH_CLOSE) todayRegs.push(b);
    if (b.mins >= LIVE_AUTO_SR_PRE_START && b.mins < LIVE_AUTO_SR_RTH_OPEN) todayPre.push(b);
    if (b.mins >= LIVE_AUTO_SR_RTH_OPEN && b.mins < LIVE_AUTO_SR_ORB_END) todayOrb.push(b);
    if (b.mins >= LIVE_AUTO_SR_ORB_END) hasPostOrb = true;
  }
  var hasRegularToday = todayRegs.length > 0;

  var levels = [];

  // ── Previous day (regular session only) ──
  var pdHigh = null;
  var pdLow = null;
  if (Array.isArray(dailyBars)) {
    var best = null;
    for (var n = 0; n < dailyBars.length; n++) {
      var db = dailyBars[n];
      if (!db) continue;
      var dd = _liveAutoSRParseDay(db.date);
      if (!dd) continue;
      if (_liveAutoSRDayCmp(dd, anchor) >= 0) continue; // skip today/future partials
      var dh = Number(db.high);
      var dl = Number(db.low);
      if (!isFinite(dh) || !isFinite(dl) || dh <= 0 || dl <= 0) continue;
      if (!best || _liveAutoSRDayCmp(dd, best.day) > 0) best = { day: dd, high: dh, low: dl };
    }
    if (best) { pdHigh = best.high; pdLow = best.low; }
  }
  if (pdHigh === null || pdLow === null) {
    // Fallback: newest earlier ET day with regular-session bars in the
    // intraday set (covers the 1m-TF case where only ~1d is seeded).
    var prevDay = null;
    for (var q = 0; q < bars.length; q++) {
      var ob = bars[q];
      if (ob.mins < LIVE_AUTO_SR_RTH_OPEN || ob.mins >= LIVE_AUTO_SR_RTH_CLOSE) continue;
      if (_liveAutoSRDayCmp(ob.day, anchor) >= 0) continue;
      if (!prevDay || _liveAutoSRDayCmp(ob.day, prevDay) > 0) prevDay = ob.day;
    }
    if (prevDay) {
      for (var r = 0; r < bars.length; r++) {
        var fb = bars[r];
        if (!_liveAutoSRDayEq(fb.day, prevDay)) continue;
        if (fb.mins < LIVE_AUTO_SR_RTH_OPEN || fb.mins >= LIVE_AUTO_SR_RTH_CLOSE) continue;
        if (pdHigh === null || fb.high > pdHigh) pdHigh = fb.high;
        if (pdLow === null || fb.low < pdLow) pdLow = fb.low;
      }
    }
  }
  if (pdHigh !== null && pdLow !== null) {
    levels.push({ price: pdHigh, kind: 'resistance', title: 'PDH', provisional: false });
    levels.push({ price: pdLow, kind: 'support', title: 'PDL', provisional: false });
  }

  // ── Premarket (today 04:00-09:30 ET) ──
  var pendingPre = false;
  if (todayPre.length) {
    var pmHigh = todayPre[0].high;
    var pmLow = todayPre[0].low;
    for (var s = 1; s < todayPre.length; s++) {
      if (todayPre[s].high > pmHigh) pmHigh = todayPre[s].high;
      if (todayPre[s].low < pmLow) pmLow = todayPre[s].low;
    }
    var pmProv = !hasRegularToday; // developing until the open prints
    levels.push({ price: pmHigh, kind: 'resistance', title: 'PMH', provisional: pmProv });
    levels.push({ price: pmLow, kind: 'support', title: 'PML', provisional: pmProv });
    pendingPre = pmProv;
  } else {
    pendingPre = !hasRegularToday; // still pre-open: wait; else data gap: skip
  }

  // ── Opening range (today 09:30-09:45 ET) ──
  var pendingOrb = false;
  if (todayOrb.length) {
    var orbHigh = todayOrb[0].high;
    var orbLow = todayOrb[0].low;
    for (var w = 1; w < todayOrb.length; w++) {
      if (todayOrb[w].high > orbHigh) orbHigh = todayOrb[w].high;
      if (todayOrb[w].low < orbLow) orbLow = todayOrb[w].low;
    }
    var orbProv = !hasPostOrb; // developing until the range closes
    levels.push({ price: orbHigh, kind: 'resistance', title: 'ORBH', provisional: orbProv });
    levels.push({ price: orbLow, kind: 'support', title: 'ORBL', provisional: orbProv });
    pendingOrb = orbProv;
  } else {
    pendingOrb = !hasPostOrb; // still early: wait; else data gap: skip
  }

  return { levels: levels, anchorDay: anchor, pending: { premarket: pendingPre, orb: pendingOrb } };
}

/**
 * Draw levels as price lines, styled exactly like the app's S/R lines
 * (dashed 1px; green lows / red highs; axis labels with short titles).
 * @returns {Array<{level:Object, handle:Object}>} entries for later removal.
 */
function applyLiveAutoSR(candleSeries, levels, isDark) {
  var entries = [];
  if (!candleSeries || !Array.isArray(levels) || !levels.length) return entries;
  if (typeof LightweightCharts === 'undefined') return entries;
  var sup = isDark ? '#30D158' : '#34C759';
  var res = isDark ? '#FF453A' : '#FF3B30';
  for (var i = 0; i < levels.length; i++) {
    var lv = levels[i];
    if (!lv) continue;
    var price = Number(lv.price);
    if (!isFinite(price) || price <= 0) continue;
    try {
      var handle = candleSeries.createPriceLine({
        price: price,
        color: lv.kind === 'support' ? sup : res,
        lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Dashed,
        axisLabelVisible: true,
        title: lv.title || (lv.kind === 'support' ? 'S' : 'R'),
      });
      entries.push({ level: lv, handle: handle });
    } catch (err) { /* skip unplaceable lines */ }
  }
  return entries;
}

/** Remove previously applied auto S/R price lines. Always returns []. */
function removeLiveAutoSR(candleSeries, entries) {
  if (candleSeries && Array.isArray(entries)) {
    for (var i = 0; i < entries.length; i++) {
      try {
        if (entries[i] && entries[i].handle) candleSeries.removePriceLine(entries[i].handle);
      } catch (err) { /* already gone with the chart */ }
    }
  }
  return [];
}
