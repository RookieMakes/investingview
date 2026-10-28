/** Earnings Watchlist: feature-local v2 score, stored close data, shared chart modal. */
import TickerMetadata from '../ticker-metadata.js';
import ChartModal from '../components/chart-modal.js';
import { isNumber, signed, escapeHtml as esc, tone, heatLevel, earningsLabel, filterStocks } from './earnings-view.mjs';

const EW_SIGNAL_LABELS = { all: 'All scores', positive: 'Positive', negative: 'Negative', unscored: 'Unscored' };
const EW_SORT_LABELS = { score: 'Momentum score ↓', earnings: 'Earnings date ↑', return_10d: '10-session return ↓', rs_10d: 'Relative strength ↓' };

const Earnings = {
  stocks: [],
  filters: { earnings: '14', sector: 'all', search: '', signal: 'all' },
  sortBy: 'score',
  _generation: 0,

  async init() {
    this.destroy();
    this._root = document.getElementById('earnings-watchlist');
    if (!this._root) return;
    this.data = null;
    this.stocks = [];
    this._refreshing = false;
    this._bindEvents();
    this._syncControls();
    // Start before awaiting: navigation cannot leave a timer from an old init.
    this._timer = setInterval(() => {
      if (!document.hidden) this._loadDashboard();
    }, 5 * 60 * 1000);
    await this._loadDashboard();
  },

  destroy() {
    this._generation++;
    clearInterval(this._timer);
    this._controller?.abort();
    this._refreshController?.abort();
    this._events?.abort();
    this._root?.querySelector('dialog[open]')?.close();
    this._root = null;
  },

  _el(id) { return this._root?.querySelector(`#${id}`); },
  _current(root, generation) { return this._root === root && root?.isConnected && generation === this._generation; },

  _bindEvents() {
    this._events = new AbortController();
    const options = { signal: this._events.signal };
    this._root.addEventListener('click', event => {
      const chip = event.target.closest('[data-window]');
      if (chip) {
        this.filters.earnings = chip.dataset.window;
        this._syncControls();
        this._render();
        return;
      }
      const action = event.target.closest('[data-ew-action]');
      if (action) {
        const stock = this.stocks.find(s => s.symbol === action.dataset.symbol);
        if (action.dataset.ewAction === 'refresh') this._refresh();
        if (action.dataset.ewAction === 'reload') this._loadDashboard();
        if (action.dataset.ewAction === 'reset') {
          this.filters = { earnings: 'all', sector: 'all', search: '', signal: 'all' };
          this._syncControls();
          this._render();
        }
        if (action.dataset.ewAction === 'score' && stock) this._showScore(stock);
        if (action.dataset.ewAction === 'day' && stock) this._showDay(stock, Number(action.dataset.index));
        if (action.dataset.ewAction === 'chart' && stock) this._openChart(stock);
        return;
      }
      const dropdown = event.target.closest('.ew-dropdown');
      if (dropdown) {
        const field = dropdown.closest('[data-ew-field]');
        if (field) this._toggleEwMenu(field.dataset.ewField);
        return;
      }
      const option = event.target.closest('.ew-option');
      if (option) {
        const field = option.closest('[data-ew-field]');
        if (field) this._selectEwOption(field.dataset.ewField, option.dataset.value);
        return;
      }
      if (event.target.closest('button, a, summary, input, dialog')) return;
      const row = event.target.closest('[data-stock]');
      const stock = row && this.stocks.find(s => s.symbol === row.dataset.stock);
      if (stock) this._openChart(stock);
    }, options);
    this._el('ew-search').addEventListener('input', event => {
      this.filters.search = event.target.value;
      this._render();
    }, options);
    this._el('ew-dialog').addEventListener('click', event => {
      if (event.target === this._el('ew-dialog')) this._el('ew-dialog').close();
    }, options);
    document.addEventListener('click', event => {
      if (!event.target.closest('#earnings-watchlist .ew-field')) this._closeEwMenus();
    }, options);
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        const openMenu = this._root?.querySelector('.ew-menu:not([hidden])');
        const key = openMenu?.closest('[data-ew-field]')?.dataset.ewField;
        this._closeEwMenus();
        if (key) this._el(`ew-${key}`)?.focus();
        return;
      }
      if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && event.target.closest?.('#earnings-watchlist .ew-dropdown')) {
        const field = event.target.closest('[data-ew-field]');
        if (field) {
          event.preventDefault();
          this._openEwMenu(field.dataset.ewField);
        }
      }
    }, options);
  },

  _syncControls() {
    this._root.querySelectorAll('[data-window]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.window === this.filters.earnings));
    });
    this._el('ew-search').value = this.filters.search;
    this._syncEwMenus();
  },

  _toggleEwMenu(key) {
    const menu = this._el(`ew-${key}-menu`);
    const trigger = this._el(`ew-${key}`);
    if (!menu || !trigger) return;
    const willOpen = menu.hidden;
    this._closeEwMenus();
    menu.hidden = !willOpen;
    trigger.setAttribute('aria-expanded', String(willOpen));
    if (willOpen) menu.querySelector('.ew-option[aria-selected="true"]')?.focus();
  },

  _openEwMenu(key) {
    const menu = this._el(`ew-${key}-menu`);
    if (menu?.hidden) this._toggleEwMenu(key);
  },

  _closeEwMenus() {
    this._root?.querySelectorAll('.ew-menu').forEach(menu => { menu.hidden = true; });
    this._root?.querySelectorAll('.ew-dropdown').forEach(trigger => trigger.setAttribute('aria-expanded', 'false'));
  },

  _selectEwOption(key, value) {
    if (value == null) return;
    if (key === 'sort') this.sortBy = value;
    else if (key === 'sector' || key === 'signal') this.filters[key] = value;
    else return;
    this._syncEwMenus();
    this._closeEwMenus();
    this._render();
  },

  _syncEwMenus() {
    this._syncEwMenu('sector', this.filters.sector === 'all' ? 'All sectors' : this.filters.sector, this.filters.sector);
    this._syncEwMenu('signal', EW_SIGNAL_LABELS[this.filters.signal] ?? this.filters.signal, this.filters.signal);
    this._syncEwMenu('sort', EW_SORT_LABELS[this.sortBy] ?? this.sortBy, this.sortBy);
  },

  _syncEwMenu(key, label, value) {
    const valueEl = this._el(`ew-${key}-value`);
    if (valueEl) valueEl.textContent = label;
    this._el(`ew-${key}-menu`)?.querySelectorAll('.ew-option').forEach(opt => {
      opt.setAttribute('aria-selected', String(opt.dataset.value === value));
    });
  },

  _renderEwSectorMenu(sectors) {
    const menu = this._el('ew-sector-menu');
    if (!menu) return;
    menu.innerHTML = '<button type="button" class="ew-option" role="option" data-value="all"><span class="ew-option-label">All sectors</span></button>'
      + sectors.map(s => `<button type="button" class="ew-option" role="option" data-value="${esc(s)}"><span class="ew-option-label">${esc(s)}</span></button>`).join('');
  },

  async _loadDashboard() {
    const root = this._root, generation = this._generation;
    if (!root) return;
    this._controller?.abort();
    const controller = new AbortController();
    this._controller = controller;
    this._el('ew-board').setAttribute('aria-busy', 'true');
    try {
      const data = await API.get('/earnings/watchlist', {}, controller.signal);
      if (!this._current(root, generation) || controller.signal.aborted) return;
      this.data = data;
      this.stocks = data.stocks || [];
      TickerMetadata.seed(this.stocks);
      const sectors = [...new Set(this.stocks.map(s => s.sector).filter(Boolean))].sort();
      this._renderEwSectorMenu(sectors);
      if (this.filters.sector !== 'all' && !sectors.includes(this.filters.sector)) this.filters.sector = 'all';
      this._syncControls();
      this._el('ew-error').hidden = true;
      this._render();
      this._renderStatus();
    } catch (error) {
      if (controller.signal.aborted || !this._current(root, generation)) return;
      this._el('ew-error').hidden = false;
      this._el('ew-error-text').textContent = `Unable to update the watchlist. ${error.message}`;
      if (!this.data) {
        this._el('ew-body').innerHTML = '<tr><td colspan="7" class="ew-empty">Watchlist unavailable. Use Retry above.</td></tr>';
        this._el('ew-mobile').innerHTML = '<p class="ew-empty">Watchlist unavailable. Use Retry above.</p>';
      }
    } finally {
      if (this._current(root, generation) && this._controller === controller) {
        this._el('ew-board').setAttribute('aria-busy', 'false');
      }
    }
  },

  async _refresh() {
    if (this._refreshing) return;
    this._refreshing = true;
    const root = this._root, generation = this._generation;
    this._refreshController = new AbortController();
    const button = this._el('ew-refresh');
    button.disabled = true;
    button.textContent = 'Fetching…';
    this._message('Fetching prices. Scores use completed daily sessions.');
    try {
      const result = await API.post('/refresh', {}, this._refreshController.signal);
      if (!this._current(root, generation)) return;
      await this._loadDashboard();
      if (!this._current(root, generation)) return;
      this._message(result?.status === 'skipped' ? result.reason || 'Refresh skipped.'
        : 'Fetch finished. Data coverage below shows which stocks can be scored.');
    } catch (error) {
      if (this._current(root, generation)) this._message(`Refresh failed: ${error.message}`);
    } finally {
      if (this._current(root, generation)) {
        this._refreshing = false;
        button.disabled = false;
        button.textContent = '↻ Refresh prices';
      }
    }
  },

  _message(text) { this._el('ew-message').textContent = text; },

  _renderStatus() {
    const data = this.data;
    this._el('ew-asof').textContent = `Session ${this._date(data.session_date)} · ${data.scored_count}/${data.universe_count} scored`;
    this._el('ew-fetched').textContent = data.last_fetch
      ? `Last recorded price fetch ${this._time(data.last_fetch)}` : 'No recorded price fetch';
    this._el('ew-next').textContent = `Next ${data.schedule_status === 'scheduled' ? 'scheduled' : 'configured'} fetch ${this._time(data.next_refresh)}`;
    this._el('ew-benchmark').textContent = `SPY through ${this._date(data.benchmark_as_of)} · 21 matching stock closes required`;
  },

  _render() {
    const rows = filterStocks(this.stocks, this.filters, this.sortBy);
    const soon = rows.filter(s => isNumber(s.days_to_earnings) && s.days_to_earnings >= 0 && s.days_to_earnings <= 14);
    const returns = rows.filter(s => isNumber(s.return_10d));
    const relative = rows.filter(s => isNumber(s.rs_10d));
    const scored = rows.filter(s => isNumber(s.score));
    this._el('ew-stat-soon').textContent = soon.length;
    this._el('ew-stat-return').textContent = returns.filter(s => s.return_10d > 0).length;
    this._el('ew-stat-return-sub').textContent = `of ${returns.length} with 10-session returns`;
    this._el('ew-stat-rs').textContent = relative.filter(s => s.rs_10d > 0).length;
    this._el('ew-stat-rs-sub').textContent = `of ${relative.length} with aligned SPY data`;
    this._el('ew-stat-coverage').textContent = `${scored.length}/${rows.length}`;
    this._el('ew-stat-coverage-sub').textContent = rows.length - scored.length
      ? `${rows.length - scored.length} stale or incomplete` : 'All filtered stocks score-ready';
    this._el('ew-count').textContent = `${rows.length} of ${this.stocks.length} stocks · summaries follow your filters`;
    const empty = this.stocks.length ? 'No stocks match these filters.' : 'No stocks are available in the universe.';
    this._el('ew-body').innerHTML = rows.length ? rows.map(s => this._row(s)).join('')
      : `<tr><td colspan="7" class="ew-empty">${empty} <button type="button" data-ew-action="reset">Show all stocks</button></td></tr>`;
    this._el('ew-mobile').innerHTML = rows.length ? rows.map(s => this._card(s)).join('')
      : `<p class="ew-empty">${empty} <button type="button" data-ew-action="reset">Show all stocks</button></p>`;
  },

  _ticker(stock) {
    return `<button type="button" class="ew-ticker" data-ew-action="chart" data-symbol="${esc(stock.symbol)}" aria-label="Open ${esc(stock.symbol)} chart">${esc(stock.symbol)} <span aria-hidden="true">↗</span></button>
      <span class="ew-company" title="${esc(stock.name)}">${esc(stock.name)}</span><span class="ew-sector-tag">${esc(stock.sector || 'Unclassified')}</span>`;
  },

  _earnings(stock) {
    const urgent = isNumber(stock.days_to_earnings) && stock.days_to_earnings >= 0 && stock.days_to_earnings <= 7;
    return `<span class="ew-earn-date">${this._date(stock.earnings_date)}</span>
      <span class="ew-earn-badge ${urgent ? 'urgent' : ''}">${earningsLabel(stock)}</span>`;
  },

  _score(stock) {
    const value = stock.score;
    return `<button type="button" class="ew-score ${tone(value)}" data-ew-action="score" data-symbol="${esc(stock.symbol)}" aria-label="Explain ${esc(stock.symbol)} momentum score">
      <span>${isNumber(value) ? signed(value) : '—'}</span><span class="ew-score-track" aria-hidden="true"><i style="width:${isNumber(value) ? Math.abs(value) : 0}%"></i></span>
      <small>${isNumber(value) ? 'of ±100 ⓘ' : 'Why unscored?'}</small></button>`;
  },

  _heat(stock) {
    const prices = stock.prices || [];
    return `<div class="ew-heat" aria-label="${esc(stock.symbol)} daily returns, oldest to newest">${prices.map((p, i) => {
      const value = p.pct_change;
      const label = `${this._date(p.date)} · ${signed(value, 2, '%')} · Close ${this._price(p.close)}`;
      return `<button type="button" class="ew-tile ${tone(value, 0.15)} level-${heatLevel(value)}" data-ew-action="day" data-symbol="${esc(stock.symbol)}" data-index="${i}" title="${esc(label)}" aria-label="${esc(label)}">${!isNumber(value) ? '·' : value > 0.15 ? '+' : value < -0.15 ? '−' : '='}</button>`;
    }).join('')}</div><div class="ew-heat-dates"><span>${this._date(prices[0]?.date)}</span><span>${this._date(prices.at(-1)?.date)}</span></div>`;
  },

  _freshness(stock) {
    if (!stock.data_as_of) return '<span class="ew-freshness stale">No stored close</span>';
    const current = stock.data_as_of === this.data?.session_date;
    return `<span class="ew-freshness ${current ? '' : 'stale'}">${current ? 'Close' : 'Stale'} ${this._date(stock.data_as_of)}</span>`;
  },

  _row(stock) {
    return `<tr data-stock="${esc(stock.symbol)}" class="${isNumber(stock.score) ? '' : 'ew-unscored'}">
      <td>${this._ticker(stock)}</td><td>${this._earnings(stock)}</td><td>${this._score(stock)}</td>
      <td>${this._heat(stock)}</td><td class="ew-number ${tone(stock.return_10d)}">${signed(stock.return_10d, 2, '%')}<small>3d ${signed(stock.return_3d, 2, '%')}</small></td>
      <td class="ew-number ${tone(stock.rs_10d)}">${signed(stock.rs_10d, 2)}<small>pp vs SPY</small></td>
      <td class="ew-latest ${tone(stock.daily_change)}"><strong>${this._price(stock.latest_close)}</strong><span class="${tone(stock.daily_change)}">${signed(stock.daily_change, 2, '%')}</span>${this._freshness(stock)}</td></tr>`;
  },

  _card(stock) {
    // Mobile-only card (desktop uses table rows). Compact: title + inline
    // price, heat, metrics. No sector tag, price row, or footer — card tap
    // opens the chart via [data-stock], ticker ↗ is the explicit control.
    return `<article class="ew-card" data-stock="${esc(stock.symbol)}" aria-label="${esc(stock.symbol)} earnings summary">
      <div class="ew-card-heading"><div class="ew-card-title">${this._ticker(stock)}<span class="ew-card-inline-price ${tone(stock.daily_change)}"><strong>${this._price(stock.latest_close)}</strong> <span>${signed(stock.daily_change, 2, '%')}</span></span></div><div class="ew-card-earnings">${this._earnings(stock)}</div></div>
      ${this._heat(stock)}<div class="ew-card-metrics"><div><span>10d return</span><strong class="${tone(stock.return_10d)}">${signed(stock.return_10d, 2, '%')}</strong></div><div><span>Momentum</span>${this._score(stock)}</div><div><span>RS vs SPY</span><strong class="${tone(stock.rs_10d)}">${signed(stock.rs_10d, 2)} pp</strong></div></div></article>`;
  },

  _dialog(title, body) {
    this._el('ew-dialog-title').textContent = title;
    this._el('ew-dialog-body').innerHTML = body;
    if (!this._el('ew-dialog').open) this._el('ew-dialog').showModal();
  },

  _showScore(stock) {
    if (!isNumber(stock.score)) {
      this._dialog(`${stock.symbol} · Not scored`, `<p>${esc(stock.score_reason || 'Insufficient data')}</p>
        <p>${stock.coverage}/21 required stock closes available. Expected session: ${this._date(this.data.session_date)}.</p>
        <p>Matching SPY observations are required. Missing data is never treated as a zero score.</p>`);
      return;
    }
    const c = stock.components;
    const labels = [['momentum_10d', '10-session momentum', 40], ['momentum_3d', '3-session momentum', 25], ['relative_strength', 'Outperformance vs SPY', 25], ['consistency', 'Directional consistency', 10]];
    this._dialog(`${stock.symbol} · Momentum ${signed(stock.score)}`, `<dl class="ew-breakdown">${labels.map(([key, label, weight]) =>
      `<div><dt>${label} <small>±${weight} points</small></dt><dd class="${tone(c[key])}">${signed(c[key], 2)}</dd></div>`).join('')}
      <div><dt>Raw score</dt><dd>${signed(c.raw_score, 2)}</dd></div>
      <div><dt>Choppiness adjustment</dt><dd>×${c.chop_multiplier.toFixed(3)}</dd></div>
      <div><dt>Final score</dt><dd>${signed(stock.score, 2)}</dd></div></dl>
      <p>Daily volatility: ${stock.volatility_20d.toFixed(2)}% (floor 0.50%). Streak: ${this._streak(stock.streak)}.</p>
      <p>Closes through ${this._date(stock.data_as_of)}. Earnings proximity is not part of the score.</p>`);
  },

  _showDay(stock, index) {
    const p = stock.prices[index];
    if (!p) return;
    this._dialog(`${stock.symbol} · ${this._date(p.date, true)}`, `<dl class="ew-breakdown">
      <div><dt>Stored close</dt><dd>${this._price(p.close)}</dd></div>
      <div><dt>Daily return</dt><dd class="${tone(p.pct_change)}">${signed(p.pct_change, 2, '%')}</dd></div>
      <div><dt>Volume</dt><dd>${isNumber(p.volume) ? p.volume.toLocaleString('en-US') : '—'}</dd></div></dl>
      ${isNumber(p.pct_change) ? '' : '<p>A valid close and prior-session close are needed to calculate this daily return.</p>'}`);
  },

  _openChart(stock) {
    ChartModal.open(stock.symbol, stock.name || '');
  },

  _streak(value) {
    if (!isNumber(value) || value === 0) return 'no active streak';
    return `${Math.abs(value)}${Math.abs(value) === 10 ? '+' : ''} ${value > 0 ? 'positive' : 'negative'} sessions`;
  },
  _price(value) { return isNumber(value) ? `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'; },
  _date(value, year = false) {
    if (!value) return '—';
    const day = new Date(`${value}T12:00:00Z`);
    return Number.isNaN(day.getTime()) ? '—' : day.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', ...(year ? { year: 'numeric' } : {}) });
  },
  _time(value) {
    if (!value) return 'unavailable';
    const normalized = /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? value : `${value}Z`;
    const time = new Date(normalized);
    return Number.isNaN(time.getTime()) ? 'unavailable' : time.toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' ET';
  },
};

window.Earnings = Earnings;
export default Earnings;
