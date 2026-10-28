/**
 * News — Movers digest screen module (Finviz-style, grouped by mover).
 *
 * EOD digest: movers from quotes.change_pct, headlines from Google News
 * RSS (12h default, 24h debug fallback). Collapsed by default, 7-day
 * history pills, All/Up/Down + text filter, Expand/Collapse all.
 *
 * API endpoints:
 *   GET  /api/news/movers?date=...  — saved digest (latest by default)
 *   GET  /api/news/movers/dates     — recent run dates
 *   POST /api/news/movers/refresh   — compute + save today's digest
 *
 * @example
 *   // Called by App.loadScreen('news')
 *   News.init();
 */

import ChartModal from '../components/chart-modal.js';

const News = {
  /** @type {AbortController|null} */
  _abort: null,

  /** @type {string} Current direction filter */
  _filter: 'all',

  /** @type {string|null} Selected run date */
  _date: null,

  // ─── INITIALIZATION ──────────────────────────────────

  /**
   * Initialize the News screen.
   */
  async init() {
    console.log('[News] initialized');
    this._filter = 'all';
    this._abort = new AbortController();
    this.bindEvents();
    await this.loadDates();
    await this.loadDigest();
  },

  /**
   * Tear down pending requests when leaving the screen.
   */
  destroy() {
    ChartModal.destroy();
    if (this._abort) this._abort.abort();
    this._abort = null;
  },

  // ─── EVENT BINDING ───────────────────────────────────

  /**
   * Bind filter, search, expand/collapse, refresh and history controls.
   */
  bindEvents() {
    ChartModal.bind();
    document.querySelectorAll('#content .news-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        document.querySelectorAll('#content .news-chip').forEach((c) => {
          c.classList.remove('active');
          c.setAttribute('aria-pressed', 'false');
        });
        chip.classList.add('active');
        chip.setAttribute('aria-pressed', 'true');
        this._filter = chip.dataset.f;
        this.applyFilters();
      });
    });

    const search = document.getElementById('news-search');
    if (search) {
      ['input', 'search', 'change', 'compositionend'].forEach((event) => {
        search.addEventListener(event, () => this.applyFilters());
      });
      search.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.isComposing) {
          event.preventDefault();
          this.applyFilters();
          search.blur();
        }
      });
    }

    const expand = document.getElementById('news-expand-btn');
    if (expand) expand.addEventListener('click', () => this._visible().forEach((m) => { m.open = true; }));

    const collapse = document.getElementById('news-collapse-btn');
    if (collapse) collapse.addEventListener('click', () => this._visible().forEach((m) => { m.open = false; }));

    const refresh = document.getElementById('news-refresh-btn');
    if (refresh) refresh.addEventListener('click', () => this.handleRefresh(refresh));
  },

  // ─── DATA LOADING ────────────────────────────────────

  /**
   * Load the 7-day history pills.
   */
  async loadDates() {
    try {
      const dates = await API.get('/news/movers/dates', {}, this._signal());
      this.renderDateline(Array.isArray(dates) ? dates : []);
    } catch (err) {
      console.warn('[News] dates failed:', err.message);
    }
  },

  /**
   * Load the digest for the selected (or latest) date.
   * @param {string} [date] - YYYY-MM-DD or 'today'
   */
  async loadDigest(date) {
    this.showError(null);
    try {
      const params = date ? { date } : {};
      const digest = await API.get('/news/movers', params, this._signal());
      this._date = digest.run_date || date || null;
      this.render(digest);
    } catch (err) {
      if (err.message === 'Request cancelled') return;
      this.showError(err.message);
    }
  },

  /**
   * Trigger a live refresh of today's digest (5pm ET job equivalent).
   * @param {HTMLElement} btn - Refresh button (disabled while running)
   */
  async handleRefresh(btn) {
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = 'Refreshing…';
    try {
      await API.post('/news/movers/refresh', { window: '12h' });
      await this.loadDates();
      await this.loadDigest('today');
    } catch (err) {
      this.showError(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  },

  // ─── RENDERING ───────────────────────────────────────

  /**
   * Render stats, groups and meta from a digest payload.
   * @param {Object} digest - {run_date, window, movers, items, empty}
   */
  render(digest) {
    const movers = digest.movers || [];
    const items = digest.items || {};
    const ups = movers.filter((m) => m.direction === 'up').length;
    const downs = movers.filter((m) => m.direction === 'down').length;
    const stories = movers.reduce((n, m) => n + (items[m.ticker] || []).length, 0);
    const covered = movers.filter((m) => (items[m.ticker] || []).length > 0).length;

    this._set('news-stat-movers', movers.length);
    this._set('news-stat-up', ups);
    this._set('news-stat-down', downs);
    this._set('news-stat-stories', stories);
    this._set('news-stat-coverage', `${covered}/${movers.length}`);
    this._set('news-count', `${movers.length} movers · ${stories} stories`);
    this._set('news-meta-window', `Window ${digest.window || '12h'}`);
    this._set('news-meta-updated', `Updated ${this.formatUpdated(digest)}`);
    this._set('news-meta-universe', `Universe ${digest.universe_count ?? '—'}`);
    this._set('news-panel-title', digest.run_date ? `Top movers · ${digest.run_date}` : 'Top movers');
    if (digest.run_date) this._markActiveDate(digest.run_date);

    const host = document.getElementById('news-groups');
    if (!host) return;
    host.innerHTML = '';
    document.getElementById('news-no-results')?.classList.remove('visible');
    if (digest.empty || !movers.length) {
      host.innerHTML = '<div class="empty-state visible">No digest saved yet — press Refresh to fetch today\'s movers.</div>';
      return;
    }
    const frag = document.createDocumentFragment();
    movers.forEach((mover) => {
      frag.appendChild(this.moverGroup(mover, items[mover.ticker] || []));
    });
    host.appendChild(frag);
    this.applyFilters();
  },

  /**
   * Build a collapsed <details> group for one mover.
   * @param {Object} mover - {ticker, company, move_pct, direction, last_price}
   * @param {Array} stories - [{title, link, published, outlet}]
   * @returns {HTMLElement}
   */
  moverGroup(mover, stories) {
    const pct = Number(mover.move_pct || 0);
    const sign = pct > 0 ? '+' : '';
    const details = document.createElement('details');
    details.className = 'news-mover';
    details.dataset.dir = mover.direction || (pct >= 0 ? 'up' : 'down');
    details.dataset.ticker = mover.ticker;

    const summary = document.createElement('summary');
    const badge = document.createElement('span');
    badge.className = `news-move-badge ${pct >= 0 ? 'up' : 'down'}`;
    badge.textContent = `${sign}${pct}%`;

    const ticker = ChartModal.button(mover.ticker, mover.company, 'ticker-cell');

    const company = document.createElement('span');
    company.className = 'news-company';
    company.textContent = mover.company || '';

    const last = document.createElement('span');
    last.className = 'news-last';
    last.textContent = mover.last_price != null ? `$${mover.last_price}` : '';

    const count = document.createElement('span');
    count.className = 'news-count';
    count.textContent = `${stories.length} ${stories.length === 1 ? 'story' : 'stories'}`;

    summary.append(ticker, company, badge, last, count);
    details.appendChild(summary);

    const table = document.createElement('table');
    table.className = 'ranking-table';
    table.setAttribute('role', 'grid');
    table.setAttribute('aria-label', `News for ${mover.ticker}`);
    table.innerHTML = '<thead><tr><th scope="col" style="width:130px">Time</th>'
      + '<th scope="col">Headline</th>'
      + '<th scope="col" class="hide-mobile" style="width:170px">Source</th></tr></thead>';
    const tbody = document.createElement('tbody');
    if (!stories.length) {
      const tr = document.createElement('tr');
      tr.className = 'news-empty-row';
      tr.innerHTML = '<td colspan="3">No driver found in window — mover flagged on price only.</td>';
      tbody.appendChild(tr);
    } else {
      stories.forEach((story) => tbody.appendChild(this.storyRow(story)));
    }
    table.appendChild(tbody);
    details.appendChild(table);
    return details;
  },

  /**
   * Build a story row (Time | Headline | Source).
   * @param {Object} story - {title, link, published, outlet}
   * @returns {HTMLTableRowElement}
   */
  storyRow(story) {
    const tr = document.createElement('tr');
    const [clock, age] = this.formatTime(story.published);

    const time = document.createElement('td');
    time.className = 'news-time';
    time.textContent = clock;
    const ageSpan = document.createElement('span');
    ageSpan.className = 'news-age';
    ageSpan.textContent = age;
    time.appendChild(ageSpan);

    const headline = document.createElement('td');
    headline.className = 'news-headline';
    const link = document.createElement('a');
    link.href = story.link || '#';
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = story.title || '(untitled)';
    headline.appendChild(link);

    const source = document.createElement('td');
    source.className = 'hide-mobile';
    const chip = document.createElement('span');
    chip.className = 'news-src';
    chip.textContent = story.outlet || '';
    source.appendChild(chip);

    tr.append(time, headline, source);
    return tr;
  },

  /**
   * Render history date pills (latest first, 7-day retention).
   * @param {Array} dates - [{run_date, movers, stories}]
   */
  renderDateline(dates) {
    const host = document.getElementById('news-dateline');
    if (!host) return;
    host.innerHTML = '';
    dates.forEach((entry, index) => {
      const pill = document.createElement('button');
      pill.className = `news-date-pill${index === 0 ? ' active' : ''}`;
      pill.setAttribute('aria-pressed', String(index === 0));
      pill.textContent = `${entry.run_date} · ${entry.movers} movers`;
      pill.addEventListener('click', () => {
        host.querySelectorAll('.news-date-pill').forEach((p) => {
          p.classList.remove('active');
          p.setAttribute('aria-pressed', 'false');
        });
        pill.classList.add('active');
        pill.setAttribute('aria-pressed', 'true');
        this.loadDigest(entry.run_date);
      });
      host.appendChild(pill);
    });
  },

  // ─── FILTERS ─────────────────────────────────────────

  /**
   * Apply direction + text filters to mover groups.
   * Text matches auto-expand their groups.
   */
  applyFilters() {
    const input = document.getElementById('news-search');
    const value = (input ? input.value : '').trim().toLowerCase();
    const groups = document.querySelectorAll('#news-groups .news-mover');
    let visible = 0;
    let stories = 0;
    groups.forEach((group) => {
      const okDir = this._filter === 'all' || group.dataset.dir === this._filter;
      const okText = !value || group.dataset.ticker.toLowerCase().includes(value);
      group.style.display = okDir && okText ? '' : 'none';
      if (okDir && okText) {
        visible++;
        stories += group.querySelectorAll('.news-headline').length;
      }
      if (value && okDir && okText) group.open = true;
    });
    if (groups.length) this._set('news-count', `${visible} movers · ${stories} stories`);
    document.getElementById('news-no-results')?.classList.toggle('visible', groups.length > 0 && visible === 0);
  },

  /**
   * Show or hide the error banner.
   * @param {string|null} message
   */
  showError(message) {
    const banner = document.getElementById('news-error');
    if (!banner) return;
    if (!message) {
      banner.hidden = true;
      banner.classList.remove('visible');
      banner.textContent = '';
    } else {
      banner.hidden = false;
      banner.classList.add('visible');
      banner.textContent = message;
    }
  },

  // ─── HELPERS ─────────────────────────────────────────

  /**
   * @returns {AbortSignal} Signal for in-flight API calls
   */
  _signal() {
    return this._abort ? this._abort.signal : null;
  },

  /**
   * @param {string} id - Element id
   * @param {string|number} value - Text to set
   */
  _set(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  },

  /**
   * @returns {Array<HTMLElement>} Currently visible mover groups
   */
  _visible() {
    return [...document.querySelectorAll('#content .news-mover')]
      .filter((m) => m.style.display !== 'none');
  },

  /**
   * Mark the active history pill for a run date.
   * @param {string} runDate - YYYY-MM-DD
   */
  _markActiveDate(runDate) {
    document.querySelectorAll('#content .news-date-pill').forEach((pill) => {
      const selected = pill.textContent.startsWith(runDate);
      pill.classList.toggle('active', selected);
      pill.setAttribute('aria-pressed', String(selected));
    });
  },

  /**
   * Format the header "Updated" stamp from a digest payload.
   * Prefers the run's fetch timestamp, falls back to the run date.
   * @param {Object} digest - {fetched_at, run_date}
   * @returns {string} Display text without the "Updated " prefix
   */
  formatUpdated(digest) {
    if (digest.fetched_at) {
      const date = new Date(digest.fetched_at);
      if (!Number.isNaN(date.getTime())) {
        return date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
      }
    }
    return digest.run_date || '—';
  },

  /**
   * Format an RSS timestamp as clock + relative age.
   * @param {string} published - RFC2822 date string
   * @returns {[string, string]} [clock, age]
   */
  formatTime(published) {
    if (!published) return ['—', ''];
    const date = new Date(published);
    if (Number.isNaN(date.getTime())) return [String(published).slice(0, 16), ''];
    const clock = date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
    const hours = (Date.now() - date.getTime()) / 3600000;
    const age = hours >= 1 ? `${Math.round(hours)}h ago` : `${Math.max(1, Math.round(hours * 60))}m ago`;
    return [clock, age];
  },
};

export default News;

// CommonJS fallback (for Node/testing)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = News;
}
