/** Feature-local rendering for the versioned candle-only Trend Quality board. */
export const QUALITY_MODEL = 'trend_quality_v2';

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
const pct = (value) => Number.isFinite(value) ? `${value > 0 ? '+' : ''}${(value * 100).toFixed(1)}%` : '—';
const num = (value) => Number.isFinite(value) ? value.toFixed(2) : '—';

/** Values inside ±0.5% read as flat — no directional color. */
const NEUTRAL_BAND = 0.005;
const signClass = (value) => (
  !Number.isFinite(value) || Math.abs(value) < NEUTRAL_BAND ? '' : (value > 0 ? 'qs-pos' : 'qs-neg')
);
const leg = (value) => `<span class="${signClass(value)}">${pct(value)}</span>`;

const COMPONENTS = {
  returns: 'Return strength', consistency: 'Trend consistency', downside: 'Downside control',
  momentum: 'Current momentum', relative: 'Relative strength',
};

/** Fixed chip order for the assessment filter. */
const ASSESSMENT_ORDER = ['quality', 'stretched', 'emerging', 'deteriorating', 'mixed', 'weak'];
const ASSESSMENT_LABEL = {
  quality: 'Quality uptrend', stretched: 'Strong but stretched', emerging: 'Emerging momentum',
  deteriorating: 'Deteriorating', mixed: 'Mixed trend', weak: 'Weak / downtrend',
};

/** Client-side only filter state — resets on navigation, never sent to the API. */
export const QualityFilter = { assessments: new Set(), hideNA: false, hideProvisional: false };
let _lastItems = [];
let _lastRenderTrend = null;
/** Mobile disclosure state — persists across re-renders within this screen visit. */
let _filtersOpen = false;

const consistencyClass = (label) => (
  label === 'Strong' ? 'qs-cons-strong' : (label === 'Low' ? 'qs-cons-low' : '')
);

function details(item) {
  const components = Object.entries(COMPONENTS).map(([key, label]) => {
    const score = item.components?.[key];
    const weight = item.component_weights?.[key] ?? 0;
    return `<div class="qs-component"><span>${label} <small>(${weight.toFixed(1)}%)</small></span>
      <strong>${Number.isFinite(score) ? score.toFixed(1) + '/100' : 'Unavailable'}</strong>
      <progress max="100" value="${Number.isFinite(score) ? score : 0}" aria-label="${label}"></progress></div>`;
  }).join('');
  const metrics = [
    ['1M / 3M / 6M / 12M', [item.r_1m, item.r_3m, item.r_6m, item.r_12m].map(leg).join(' / ')],
    ['6M max / current drawdown', `${leg(item.max_drawdown)} / ${leg(item.current_drawdown)}`],
    ['6M time underwater', esc(pct(item.underwater_fraction))],
    ['Annualized downside deviation', esc(pct(item.downside_deviation))],
    ['63 / 126-session trend fit (R²)', esc(`${num(item.trend_3m?.r_squared)} / ${num(item.trend_6m?.r_squared)}`)],
    ['63 / 126-session directional efficiency', esc(`${num(item.trend_3m?.efficiency)} / ${num(item.trend_6m?.efficiency)}`)],
    ['50 / 200-session averages', esc(`${num(item.sma50)} / ${num(item.sma200)}`)],
    ['Price vs averages', esc(`${item.above_sma50 ? 'Above' : 'Below'} 50 / ${item.above_sma200 ? 'Above' : 'Below'} 200`)],
    ['21-session change in averages', `${leg(item.sma50_change_21d)} / ${leg(item.sma200_change_21d)}`],
    ['ATR(14) / extension above MA50', esc(`${num(item.atr14)} / ${num(item.extension_atr)} ATR`)],
    [`3M / 6M relative return vs ${esc(item.benchmark || 'unavailable benchmark')}`, `${leg(item.relative_3m)} / ${leg(item.relative_6m)}`],
    ['Up/down-day average volume ratio', esc(num(item.up_down_volume_ratio))],
    ['Sessions through', esc(item.data_as_of)],
  ].map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${value}</dd></div>`).join('');
  return `<div class="qs-detail-content">
    <p><strong>${esc(item.company || item.ticker)}</strong> · ${esc(item.sector || 'Sector unavailable')} · Model v2</p>
    ${item.provisional ? `<p class="qs-warning">Provisional: ${esc(item.benchmark_reason)}. Available components are reweighted to 100%.</p>` : ''}
    <div class="qs-components">${components}</div><dl class="qs-metrics">${metrics}</dl>
    <p>${(item.flags || []).map(esc).join(' · ') || 'No additional volume or extension flags.'}</p>
    <p class="qs-muted">Candle-based trend health, not business fundamentals. Recent evidence rolls forward; there is no leaderboard-age bonus or penalty.</p>
  </div>`;
}

function isVisibleRow(item) {
  if (!Number.isFinite(item.score) || item.insufficient_data) return !QualityFilter.hideNA;
  if (QualityFilter.hideProvisional && item.provisional) return false;
  if (QualityFilter.assessments.size > 0 && !QualityFilter.assessments.has(item.state)) return false;
  return true;
}

function renderFilterBar(allRows) {
  const bar = document.getElementById('qualityScoreFilters');
  if (!bar) return;
  if (!allRows.length) { bar.innerHTML = ''; bar.classList.remove('open'); return; }
  const counts = {};
  let naCount = 0;
  let provisionalCount = 0;
  for (const r of allRows) {
    if (!Number.isFinite(r.score) || r.insufficient_data) { naCount += 1; continue; }
    counts[r.state] = (counts[r.state] || 0) + 1;
    if (r.provisional) provisionalCount += 1;
  }
  const chips = ASSESSMENT_ORDER
    .filter((state) => counts[state] > 0)
    .map((state) => {
      const active = QualityFilter.assessments.has(state);
      return `<button class="qs-chip" data-assessment="${state}" aria-pressed="${active}"
        aria-label="Show only ${ASSESSMENT_LABEL[state]}">${ASSESSMENT_LABEL[state]} <b>${counts[state]}</b></button>`;
    }).join('');
  const naChip = naCount > 0
    ? `<button class="qs-chip" data-filter="hideNA" aria-pressed="${QualityFilter.hideNA}">Hide N/A <b>${naCount}</b></button>` : '';
  const provChip = provisionalCount > 0
    ? `<button class="qs-chip" data-filter="hideProvisional" aria-pressed="${QualityFilter.hideProvisional}">Hide provisional <b>${provisionalCount}</b></button>` : '';
  const filtered = allRows.filter(isVisibleRow).length;
  const hasActive = QualityFilter.assessments.size > 0 || QualityFilter.hideNA || QualityFilter.hideProvisional;
  const activeCount = QualityFilter.assessments.size + (QualityFilter.hideNA ? 1 : 0) + (QualityFilter.hideProvisional ? 1 : 0);
  bar.innerHTML = `<button class="qs-filter-toggle" data-filter="toggle" aria-expanded="${_filtersOpen}" aria-controls="qsFilterOptions">`
    + `<span>Filters <span class="qs-filter-count${activeCount ? '' : ' is-zero'}">${activeCount}</span></span>`
    + `<svg class="qs-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg></button>`
    + `<span class="qs-showing">Showing ${filtered} of ${allRows.length}</span>`
    + `<div class="qs-filter-options" id="qsFilterOptions"><span class="qs-filter-label">Show:</span>${chips}${naChip}${provChip}`
    + `${hasActive ? '<button class="qs-chip qs-chip-reset" data-filter="reset">Reset</button>' : ''}</div>`;
  bar.classList.toggle('open', _filtersOpen);
  if (!bar.dataset.bound) {
    bar.dataset.bound = 'true';
    bar.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      if (btn.dataset.filter === 'toggle') {
        _filtersOpen = !_filtersOpen;
        bar.classList.toggle('open', _filtersOpen);
        btn.setAttribute('aria-expanded', String(_filtersOpen));
        return;
      }
      if (btn.dataset.assessment) {
        const state = btn.dataset.assessment;
        if (QualityFilter.assessments.has(state)) QualityFilter.assessments.delete(state);
        else QualityFilter.assessments.add(state);
      } else if (btn.dataset.filter === 'hideNA') {
        QualityFilter.hideNA = !QualityFilter.hideNA;
      } else if (btn.dataset.filter === 'hideProvisional') {
        QualityFilter.hideProvisional = !QualityFilter.hideProvisional;
      } else if (btn.dataset.filter === 'reset') {
        QualityFilter.assessments.clear();
        QualityFilter.hideNA = false;
        QualityFilter.hideProvisional = false;
      } else {
        return;
      }
      renderQualityTable(_lastItems, _lastRenderTrend);
    });
  }
}

export function renderQualityTable(items, renderTrend) {
  _lastItems = items;
  _lastRenderTrend = renderTrend;
  const tbody = document.getElementById('qualityScoreBody');
  if (!tbody) return;
  const rows = (items || []).filter(r => r.model_version === QUALITY_MODEL);
  renderFilterBar(rows);
  const visible = rows.filter(isVisibleRow);
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="qs-empty">Run a scan to start Trend Quality v2. Previous ratio-score history is kept separately.</td></tr>';
    return;
  }
  if (!visible.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="qs-empty">No stocks match the current filters. <button class="qs-chip qs-chip-reset" data-qs-reset>Reset filters</button></td></tr>';
    tbody.querySelector('[data-qs-reset]')?.addEventListener('click', () => {
      QualityFilter.assessments.clear();
      QualityFilter.hideNA = false;
      QualityFilter.hideProvisional = false;
      renderQualityTable(_lastItems, _lastRenderTrend);
    }, { once: true });
    return;
  }
  tbody.innerHTML = visible.map((item, index) => {
    const ticker = esc(item.ticker);
    if (!Number.isFinite(item.score) || item.insufficient_data) {
      return `<tr data-ticker="${ticker}" class="qs-excluded">
        <td class="rank-cell">—</td><td class="ticker-cell"><a href="#">${ticker}</a></td>
        <td>N/A</td><td class="qs-exclusion">${esc(item.exclusion_reason || 'Not scored')}</td>
        <td class="qs-secondary">—</td><td class="qs-secondary">—</td><td class="qs-secondary">—</td><td class="qs-secondary">—</td><td>—</td></tr>`;
    }
    const id = `qs-detail-${index}`;
    const ddClass = Number.isFinite(item.max_drawdown) && item.max_drawdown < -0.25 ? 'qs-neg' : '';
    return `<tr data-ticker="${ticker}" data-quality-detail="${id}" class="qs-result">
      <td class="rank-cell">${item.current_rank}</td>
      <td class="ticker-cell"><a href="#" title="View ${ticker} chart">${ticker}</a></td>
      <td><button class="qs-details-btn" aria-label="Explain ${ticker} score" aria-expanded="false" aria-controls="${id}">
        <strong>${item.score.toFixed(1)}</strong><span class="qs-muted">/100 ▾</span>
        <progress max="100" value="${item.score}" aria-label="Trend quality score"></progress></button></td>
      <td class="qs-assessment"><span class="qs-pill qs-pill-${esc(item.state || 'mixed')}">${esc(item.assessment)}</span>${item.provisional ? '<small class="qs-warning">Provisional</small>' : ''}</td>
      <td class="qs-secondary qs-number">${leg(item.r_3m)} / ${leg(item.r_6m)}</td>
      <td class="qs-secondary ${consistencyClass(item.consistency_label)}">${esc(item.consistency_label)}</td>
      <td class="qs-secondary qs-number"><span class="${ddClass}">${pct(item.max_drawdown)}</span></td>
      <td class="qs-secondary qs-number" title="6M relative wealth return vs ${esc(item.benchmark || 'unavailable')}">${leg(item.relative_6m)}<small>${esc(item.benchmark || '—')}</small></td>
      <td class="qs-weekly"><span title="${item.previous_rank == null ? 'No prior ranked entry' : `Previous rank ${item.previous_rank}; moves under 5 places show flat`}">${renderTrend(item)}</span>
        <button class="qs-chart-btn" data-ticker="${ticker}" aria-label="View ${ticker} trend score history" title="Weekly score history"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v18h18M7 16l4-8 4 4 4-6"/></svg></button></td>
    </tr><tr id="${id}" class="qs-detail-row" hidden><td colspan="9">${details(item)}</td></tr>`;
  }).join('');
}

export function toggleQualityDetails(event) {
  if (event.target.closest('a, .qs-chart-btn')) return;
  const row = event.target.closest('tr[data-quality-detail]');
  if (!row) return;
  const detail = document.getElementById(row.dataset.qualityDetail);
  if (!detail) return;
  detail.hidden = !detail.hidden;
  row.querySelector('.qs-details-btn')?.setAttribute('aria-expanded', String(!detail.hidden));
}

export function renderQualityStatus(meta, error = null) {
  const status = document.getElementById('qualityScoreStatus');
  const errorBox = document.getElementById('qualityScoreError');
  if (errorBox) {
    errorBox.hidden = !error;
    errorBox.textContent = error || '';
  }
  if (!status) return;
  if (!meta?.completed_at) {
    status.textContent = 'Weekly: Friday 7:35 PM ET · Run Scan also supports manual updates · Model v2';
    return;
  }
  const completed = new Date(meta.completed_at).toLocaleString('en-US', {
    timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  status.textContent = `Data through ${meta.data_as_of} · Completed ${completed} ET · ${meta.comparison_date ? `Ranks vs ${meta.comparison_date}` : 'First weekly baseline'} · Friday 7:35 PM ET · Model v2`;
}
