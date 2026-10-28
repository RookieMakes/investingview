/**
 * Charts — Multi-chart dashboard with tab management, S/R drawing, and auto-refresh.
 *
 * Manages a grid of candlestick charts organized in watchlist tabs.
 * Each chart uses TradingView LightCharts for rendering and supports
 * interactive S/R line placement via click-to-draw.
 *
 * API endpoints consumed:
 *   GET    /api/tabs                  — Load tabs config
 *   POST   /api/tabs                  — Save tabs config
 *   GET    /api/data/history          — Fresh OHLCV data on explicit refresh
 *   GET    /api/data/history/stored   — Stored daily candles for grid navigation
 *   GET    /api/data/quotes           — Live quotes (symbols)
 *   GET    /api/sr/levels             — S/R levels (ticker)
 *   POST   /api/sr/levels             — Add S/R level
 *   DELETE /api/sr/levels/:id         — Delete S/R level
 *   GET    /api/scanner/earnings/all  — Earnings ticker lists (today + upcoming)
 *
 * External dependencies:
 *   - TradingView Lightweight Charts (loaded via CDN in screen template)
 *
 * @example
 *   // Called by App.loadScreen('charts')
 *   Charts.init();
 */

import TickerMetadata from '../ticker-metadata.js';
import ChartModal from '../components/chart-modal.js';
import { chartThemeColors } from '../components/chart-utils.js';
import { detectDominantPattern } from '../components/dominant-pattern.mjs';

/**
 * Compare a crosshair time against the last-real-bar time.
 * Numeric comparison when both times are numbers (intraday epochs),
 * else String() lexicographic comparison (zero-padded YYYY-MM-DD
 * strings sort correctly).
 */
function _isAfterTime(t, ref) {
  if (typeof t === 'number' && typeof ref === 'number') return t > ref;
  return String(t) > String(ref);
}

const Charts = {
  // ─── STATE ──────────────────────────────────────────────

  /** @type {Array<{id: string, name: string, tickers: string[]}>} */
  tabs: [],

  /** @type {string|null} Active tab ID */
  activeTabId: null,

  /**
   * Per-ticker chart state.
   * @type {Object<string, {
   *   chart: Object,
   *   candleSeries: Object,
   *   container: HTMLElement,
   *   companyName: string,
   *   lines: Array<{id: number, price: number, type: string}>,
   *   priceLines: Object,
   *   price: number|null,
   *   changePct: number|null,
   *   loading: boolean,
   *   error: string|null
   * }>}
   */
  charts: {},

  // ─── SYSTEM TAB (200 SMA) ─────────────────────────────

  /** @type {string} ID for the auto-generated 200 EMA system tab */
  _SYSTEM_TAB_ID: '__system_sma200',

  /** @type {string} Display name for the system tab */
  _SYSTEM_TAB_NAME: '200 SMA',

  /** @type {string[]} Tickers loaded from the SMA200 scanner ranking */
  _sma200AllTickers: [],

  /** @type {string|null} ISO timestamp of when the SMA200 scan was last run */
  _sma200ScannedAt: null,

  // One derived tab; holdings and cost basis always belong to its selected portfolio.
  _HOLD_TAB_ID: '__system_holdings',
  _holdingsPortfolios: null,
  _holdingsPortfolioId: null,
  _holdingsPositions: [],
  _gridVersion: 0,
  _lifecycleVersion: 0,

  // ─── SYSTEM TAB (Earnings) ──────────────────────────────

  /** @type {string} ID for the auto-generated Earnings system tab */
  _ERN_TAB_ID: '__system_earnings',

  /** @type {string} Display name for the earnings tab */
  _ERN_TAB_NAME: 'Earnings',

  /** @type {string[]} Tickers with earnings today */
  _earningsTodayTickers: [],

  /** @type {string[]} Tickers with upcoming earnings */
  _earningsUpcomingTickers: [],

  /** @type {string|null} ISO timestamp of when earnings data was last fetched */
  _earningsScannedAt: null,

  // ─── SYSTEM TAB (Live Chart, standalone) ──────────────

  /** @type {string} ID for the auto-generated Live Chart system tab */
  _LIVE_TAB_ID: '__system_live',

  /** @type {string} Display name for the live tab */
  _LIVE_TAB_NAME: '● Live Chart',

  /**
   * Standalone live-chart state (exactly one chart + one SSE stream).
   * Socket is open ONLY while this tab is active and document visible.
   */
  _live: null,

  /** @type {number} Idle auto-close in ms (5 min, user gestures only) */
  _LIVE_IDLE_MS: 5 * 60 * 1000,

  /** @type {number} REST re-sync while live (correct WS drift) */
  _LIVE_RESYNC_MS: 60 * 1000,

  /** @type {boolean} Whether S/R draw mode is active */
  drawMode: false,

  /** @type {string|null} Ticker whose chart has draw mode on */
  drawChartTicker: null,

  /** @type {boolean} Skip the next global click-outside picker dismiss */
  _skipPickerDismiss: false,

  /** @type {AbortController|null} For cancelling in-flight data requests */
  _abortController: null,

  /** @type {Object<string, Array>} Bars for currently displayed charts (theme/markers) */
  _barCache: {},

  /** @type {Object<string, Array>} Cross-tab S/R cache keyed by ticker */
  _srCache: {},

  /** @type {Set<string>} Tickers whose S/R has been loaded from the backend */
  _srLoaded: new Set(),

  /** @type {Object<string, {display: string, date: string}>} Earnings dates cache */
  _earningsDates: {},

  /** @type {Object<string, Array<{date: string, eps_actual: number, eps_estimate: number, surprise_pct: number, beat: boolean}>>} Quarterly earnings history cache */
  _quarterlyEarnings: {},

  /** @type {Object<string, Array<{type: string, date: string, price: number, qty: number}>>} Transactions cache per ticker */
  _transactionsCache: {},

  /** @type {number|null} Debounce timer for resize */
  _resizeTimer: null,

  /** Recheck stored earnings for charts left open after a backend update. */
  _earningsPollTimer: null,

  /** @type {string|null} Ticker pending delete confirmation */
  _deleteChartTicker: null,

  /** @type {Function|null} Stored document click handler ref for cleanup */
  _docClickHandler: null,

  /** @type {Function|null} Stored document keydown handler ref for cleanup */
  _docKeyHandler: null,

  /** @type {Function|null} Stored resize handler ref for cleanup */
  _resizeHandler: null,

  /** @type {MutationObserver|null} Theme observer for cleanup */
  _themeObserver: null,

  /** @type {Object<string, string>} Per-ticker active time period */
  chartPeriods: {},

  // ─── INITIALIZATION ─────────────────────────────────────

  /**
   * Initialize the Charts screen.
   * Loads tabs, binds events, renders tabs and chart grid.
   */
  async init() {
    const lifecycle = ++this._lifecycleVersion;
    this._holdingsPortfolios = null;
    await this._ensureLightCharts();
    if (lifecycle !== this._lifecycleVersion) return;
    await this.loadTabs();
    if (lifecycle !== this._lifecycleVersion) return;
    await this._ensureSystemTab();
    if (lifecycle !== this._lifecycleVersion) return;
    await this._ensureEarningsSystemTab();
    if (lifecycle !== this._lifecycleVersion) return;
    this._ensureHoldingsTab();
    this._ensureLiveTab();
    if (!this.tabs.some(t => t.id === this.activeTabId)) this.activeTabId = this.tabs[0]?.id;
    this.bindEvents();

    // Watch for app theme changes and re-theme all charts
    this._themeObserver = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.attributeName === 'data-theme') {
          this._applyAppThemeToCharts();
          break;
        }
      }
    });
    this._themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    // Check if we were navigated to with a specific ticker (Issue 5)
    if (window.__pendingChartTicker) {
      const ticker = window.__pendingChartTicker;
      delete window.__pendingChartTicker;
      await this._ensureTickerInTab(ticker);
      if (lifecycle !== this._lifecycleVersion) return;
    }

    this.renderTabs();
    this._updateAddChartBtn();
    this.renderChartGrid();
    this._earningsPollTimer = setInterval(() => this._pollStoredEarnings(), 10 * 60 * 1000);
    this._startAutoResize();
    console.log('[Charts] initialized');
  },

  /**
   * Destroy the Charts module — clean up event listeners and chart instances.
   * Called by App.loadScreen() before loading a different screen.
   */
  destroy() {
    this._lifecycleVersion++;
    this._gridVersion++;
    this._abortController?.abort();
    this._abortController = null;
    this._holdingsPositions = [];
    this._holdingsPortfolios = null;
    this.closeExpandModal();
    // Remove document-level event listeners
    if (this._docClickHandler) {
      document.removeEventListener('click', this._docClickHandler);
      this._docClickHandler = null;
    }
    if (this._docKeyHandler) {
      document.removeEventListener('keydown', this._docKeyHandler);
      this._docKeyHandler = null;
    }

    // Remove resize listener
    if (this._resizeHandler) {
      window.removeEventListener('resize', this._resizeHandler);
      this._resizeHandler = null;
    }

    // Disconnect theme observer
    if (this._themeObserver) {
      this._themeObserver.disconnect();
      this._themeObserver = null;
    }

    // Clear resize timer
    if (this._resizeTimer) {
      clearTimeout(this._resizeTimer);
      this._resizeTimer = null;
    }
    if (this._earningsPollTimer) {
      clearInterval(this._earningsPollTimer);
      this._earningsPollTimer = null;
    }

    // Destroy all chart instances
    Object.keys(this.charts).forEach((ticker) => {
      const state = this.charts[ticker];
      if (state) {
        if (state.tooltip) state.tooltip.destroy();
        if (state._resizeObserver) state._resizeObserver.disconnect();
        try { state.chart.remove(); } catch {}
        // chart.remove() destroys the attached hover primitive with it.
        state.hoverPrimitive = null;
      }
    });
    this.charts = {};

    // Live tab: close socket + destroy standalone chart (additive cleanup)
    try { this._closeLiveStream({ destroyChart: true, reason: 'screen_leave' }); } catch {}

    // Reset state
    this.drawMode = false;
    this.drawChartTicker = null;
    this._skipPickerDismiss = false;
    this._deleteChartTicker = null;

    // Clear S/R caches
    this._srLoaded.clear();
    this._srCache = {};
    this._barCache = {};
    this._transactionsCache = {};
  },

  /**
   * Dynamically load the Lightweight Charts library if not already present.
   * @returns {Promise<void>}
   */
  _ensureLightCharts() {
    if (typeof LightweightCharts !== 'undefined') return Promise.resolve();

    return new Promise((resolve, reject) => {
      // Check if script tag already exists
      const existing = document.querySelector('script[src*="lightweight-charts"]');
      if (existing) {
        existing.addEventListener('load', () => resolve());
        existing.addEventListener('error', () => reject(new Error('LightCharts load failed')));
        return;
      }

      const script = document.createElement('script');
      script.src = 'https://unpkg.com/lightweight-charts@5.2.0/dist/lightweight-charts.standalone.production.js';
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => {
        console.error('[Charts] Failed to load LightCharts library');
        resolve(); // Don't block — charts will show error state
      };
      document.head.appendChild(script);
    });
  },

  // ─── EVENT BINDING ──────────────────────────────────────

  /**
   * Bind all screen-level event listeners.
   */
  bindEvents() {
    const selector = document.getElementById('holdingsSelector');
    selector?.addEventListener('click', (e) => {
      const tab = e.target.closest('.holdings-portfolio-tab[data-portfolio-id]');
      if (tab) {
        this.switchHoldingsPortfolio(Number(tab.dataset.portfolioId));
        return;
      }
      const option = e.target.closest('.holdings-option[data-portfolio-id]');
      if (option) {
        this.switchHoldingsPortfolio(Number(option.dataset.portfolioId));
        return;
      }
      if (e.target.closest('#holdingsDropdown')) this._toggleHoldingsMenu();
    });
    selector?.addEventListener('keydown', (e) => {
      if (e.target.closest('#holdingsDropdown') && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault();
        const menu = document.getElementById('holdingsMenu');
        if (menu?.hidden) this._toggleHoldingsMenu();
        return;
      }
      const tab = e.target.closest('[data-portfolio-id]');
      if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault();
      const tabs = [...selector.querySelectorAll('[data-portfolio-id]')];
      const index = tabs.indexOf(tab);
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1
        : (index + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      const id = Number(tabs[next].dataset.portfolioId);
      this.switchHoldingsPortfolio(id);
      selector.querySelector(`[data-portfolio-id="${id}"]`)?.focus();
    });
    // Tab management
    const tabBar = document.getElementById('tabBar');
    if (tabBar) {
      tabBar.addEventListener('click', (e) => {
        const pill = e.target.closest('.tab-pill');
        const renameBtn = e.target.closest('.tab-rename');
        const closeBtn = e.target.closest('.tab-close');

        if (renameBtn && pill) {
          e.stopPropagation();
          const tabId = pill.dataset.tabId;
          this.renameTab(tabId);
        } else if (closeBtn && pill) {
          e.stopPropagation();
          const tabId = pill.dataset.tabId;
          this._showDeleteTabModal(tabId);
        } else if (pill && !renameBtn && !closeBtn) {
          this.switchTab(pill.dataset.tabId);
        }
      });
    }

    // Add tab button
    const tabAddBtn = document.getElementById('tabAddBtn');
    if (tabAddBtn) {
      tabAddBtn.addEventListener('click', () => this.addTab());
    }

    // Add chart button
    const addChartBtn = document.getElementById('addChartBtn');
    if (addChartBtn) {
      addChartBtn.addEventListener('click', () => this._showAddChartModal());
    }
    document.getElementById('refreshAllChartsBtn')?.addEventListener('click', () => this._refreshAllCharts());

    // Add chart modal
    this._bindAddChartModal();

    // S/R picker
    this._bindSRPicker();

    // Delete chart modal
    this._bindDeleteChartModal();

    // Delete tab modal
    this._bindDeleteTabModal();

    // Global: click outside S/R picker to dismiss
    this._docClickHandler = (e) => {
      if (this._skipPickerDismiss) {
        this._skipPickerDismiss = false;
        return;
      }
      // Holdings menu closes on any outside tap, even under the modal
      const holdingsHost = document.getElementById('holdingsSelector');
      const holdingsMenu = document.getElementById('holdingsMenu');
      if (holdingsMenu && !holdingsMenu.hidden && holdingsHost && !holdingsHost.contains(e.target)) {
        this._closeHoldingsMenu();
      }
      // Skip if Portfolio's chart modal is open
      const chartModal = document.getElementById('chart-modal');
      if (chartModal && chartModal.classList.contains('open')) return;

      const picker = document.getElementById('srPicker');
      if (picker && picker.style.display !== 'none' && !picker.contains(e.target)) {
        this._hideSRPicker();
      }
    };
    document.addEventListener('click', this._docClickHandler);

    // Global: Escape key
    this._docKeyHandler = (e) => {
      if (e.key === 'Escape') {
        this._closeHoldingsMenu();
        // If Portfolio's chart modal is open, let Portfolio handle Escape
        const chartModal = document.getElementById('chart-modal');
        if (chartModal && chartModal.classList.contains('open')) return;

        this._hideSRPicker();
        this._hideAddChartModal();
        this._closeDeleteChartModal();
      }
    };
    document.addEventListener('keydown', this._docKeyHandler);
  },

  // ─── TAB MANAGEMENT ─────────────────────────────────────

  /**
   * Load tabs from the backend API.
   * Shows error state if no tabs exist instead of falling back to defaults.
   */
  async loadTabs() {
    try {
      const resp = await API.get('/tabs');
      if (resp && resp.data && Array.isArray(resp.data.tabs)) {
        this.tabs = resp.data.tabs;
        if (this.tabs.length > 0 && !this.activeTabId) {
          this.activeTabId = this.tabs[0].id;
        }
      }
    } catch (err) {
      console.warn('[Charts] Failed to load tabs:', err.message);
      this._showInlineError('Unable to load tabs', () => this.loadTabs());
    }

    // If no tabs exist, show empty state
    if (this.tabs.length === 0) {
      this.tabs = [];
      this.activeTabId = null;
      this._showEmptyState();
      return;
    }

    if (!this.activeTabId && this.tabs.length > 0) {
      this.activeTabId = this.tabs[0].id;
    }
  },

  /**
   * Save current tabs to the backend API.
   */
  async saveTabs() {
    try {
      const userTabs = this.tabs.filter(t => t.type !== 'system');
      await API.post('/tabs', { tabs: userTabs });
    } catch (err) {
      console.warn('[Charts] Failed to save tabs:', err.message);
    }
  },

  /**
   * Render the tab pills in the tab bar.
   */
  renderTabs() {
    const tabBar = document.getElementById('tabBar');
    if (!tabBar) return;
    const addBtn = document.getElementById('tabAddBtn');
    tabBar.querySelectorAll('.tab-pill').forEach((el) => el.remove());

    const systemTabs = [];
    const userTabs = [];
    this.tabs.forEach(tab => {
      if (tab.type === 'system') systemTabs.push(tab);
      else userTabs.push(tab);
    });

    // Render user tabs
    userTabs.forEach((tab) => {
      const pill = document.createElement('div');
      pill.className = 'tab-pill' + (tab.id === this.activeTabId ? ' active' : '');
      pill.dataset.tabId = tab.id;
      pill.innerHTML = `
        <button class="tab-select" type="button" role="tab" aria-selected="${tab.id === this.activeTabId}">
          <span class="tab-name">${this._escHtml(tab.name)}</span>
        </button>
        <button class="tab-rename" type="button" title="Rename" aria-label="Rename tab ${this._escHtml(tab.name)}">✎</button>
        <button class="tab-close" type="button" title="Close" aria-label="Close tab ${this._escHtml(tab.name)}">✕</button>
      `;
      tabBar.insertBefore(pill, addBtn);
    });

    // Render system tabs (last, before addBtn)
    systemTabs.forEach((tab) => {
      const pill = document.createElement('button');
      pill.className = 'tab-pill system-tab' + (tab.id === this.activeTabId ? ' active' : '');
      pill.dataset.tabId = tab.id;
      pill.setAttribute('role', 'tab');
      pill.setAttribute('aria-selected', String(tab.id === this.activeTabId));
      const scanTime = tab.id === this._ERN_TAB_ID
        ? this._formatScanTime(this._earningsScannedAt)
        : tab.id === this._SYSTEM_TAB_ID ? this._formatScanTime(this._sma200ScannedAt) : '';
      pill.innerHTML = `
        <svg class="tab-badge-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
          <path d="M7 11V7a5 5 0 0110 0v4"/>
        </svg>
        <span class="tab-name">${this._escHtml(tab.name)}</span>
        ${scanTime ? `<span class="tab-timestamp">${scanTime}</span>` : ''}
      `;
      tabBar.insertBefore(pill, addBtn);
    });

    this._updateChartCount();
  },

  /**
   * Add a new tab with a default name.
   */
  async addTab() {
    const name = `Watchlist ${this.tabs.length + 1}`;
    const tab = { id: this._uid(), name, tickers: [] };
    this.tabs.push(tab);
    this.activeTabId = tab.id;
    await this.saveTabs();
    this.renderTabs();
    this.renderChartGrid();
  },

  /**
   * Rename a tab via prompt dialog.
   * @param {string} tabId
   */
  async renameTab(tabId) {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab || tab.type === 'system') return;

    const newName = prompt('Rename tab:', tab.name);
    if (newName && newName.trim()) {
      tab.name = newName.trim();
      await this.saveTabs();
      this.renderTabs();
    }
  },

  /**
   * Delete a tab. If it's the active tab, switches to another.
   * Prevents deleting the last tab.
   * @param {string} tabId
   */
  async deleteTab(tabId) {
    if (this.tabs.length <= 1) return;

    const idx = this.tabs.findIndex((t) => t.id === tabId);
    if (idx === -1 || this.tabs[idx].type === 'system') return;

    this.tabs.splice(idx, 1);

    if (this.activeTabId === tabId) {
      this.activeTabId = this.tabs[Math.min(idx, this.tabs.length - 1)].id;
    }

    await this.saveTabs();
    this.renderTabs();
    this.renderChartGrid();
  },

  /**
   * Switch to a different tab.
   * @param {string} tabId
   */
  async switchTab(tabId) {
    if (this.activeTabId === tabId) return;
    this.closeExpandModal();
    if (tabId === this._HOLD_TAB_ID) this._holdingsPortfolios = null;
    // Leaving Live tab (or any tab): stop its socket first.
    try { this._closeLiveStream({ destroyChart: true }); } catch {}
    this.activeTabId = tabId;
    this._updateAddChartBtn();
    this.renderTabs();
    this.renderChartGrid();
  },

  // ─── TICKER NAVIGATION (Issue 5) ──────────────────────

  /**
   * Ensure a ticker exists in the active tab, adding it if necessary.
   * Saves to backend if the ticker was added.
   * @param {string} ticker
   */
  async _ensureTickerInTab(ticker) {
    if (!ticker) return;
    const tab = this._getActiveTab();
    if (!tab || tab.type === 'system') return;
    if (!tab.tickers.includes(ticker)) {
      tab.tickers.push(ticker);
      // Save to backend
      try {
        await API.put(`/tabs/${tab.id}`, { tickers: tab.tickers });
      } catch (e) {
        console.warn('[Charts] Failed to save tab:', e);
      }
    }
  },

  // ─── CHART GRID ─────────────────────────────────────────

  /**
   * Get the active tab object.
   * @returns {Object|null}
   */
  _getActiveTab() {
    return this.tabs.find((t) => t.id === this.activeTabId) || null;
  },

  /**
   * Ensure the 200 EMA system tab exists and has current scanner data.
   * Called during init() — fetches fresh ticker list from the SMA200 ranking API
   * and creates or updates the system tab accordingly.
   */
  async _ensureSystemTab() {
    const existing = this.tabs.find(t => t.id === this._SYSTEM_TAB_ID);
    await this._loadSma200Tickers();
    if (existing) {
      existing.tickers = [...this._sma200AllTickers];
    } else {
      this.tabs.push({
        id: this._SYSTEM_TAB_ID,
        name: this._SYSTEM_TAB_NAME,
        type: 'system',
        tickers: [...this._sma200AllTickers],
      });
    }
  },

  /**
   * Ensure the Earnings system tab exists and has current scanner data.
   * Called during init() — fetches fresh ticker list from the earnings API
   * and creates or updates the system tab accordingly.
   */
  async _ensureEarningsSystemTab() {
    const existing = this.tabs.find(t => t.id === this._ERN_TAB_ID);
    await this._loadEarningsTickers();

    // Combine tickers for the tab (sections stored separately)
    const allTickers = [
      ...this._earningsTodayTickers,
      ...this._earningsUpcomingTickers
    ];

    if (existing) {
      existing.tickers = allTickers;
      existing._todayTickers = [...this._earningsTodayTickers];
      existing._upcomingTickers = [...this._earningsUpcomingTickers];
    } else {
      this.tabs.push({
        id: this._ERN_TAB_ID,
        name: this._ERN_TAB_NAME,
        type: 'system',
        tickers: allTickers,
        _todayTickers: [...this._earningsTodayTickers],
        _upcomingTickers: [...this._earningsUpcomingTickers],
      });
    }
  },

  /**
   * Ensure the standalone Live Chart system tab exists.
   * Sync, no API — single chart, ticker from last-viewed pref.
   */
  _ensureLiveTab() {
    const existing = this.tabs.find(t => t.id === this._LIVE_TAB_ID);
    if (existing) {
      existing.name = this._LIVE_TAB_NAME;
      return;
    }
    this.tabs.push({
      id: this._LIVE_TAB_ID,
      name: this._LIVE_TAB_NAME,
      type: 'system',
      tickers: [],
    });
  },

  _ensureHoldingsTab() {
    const existing = this.tabs.find(t => t.id === this._HOLD_TAB_ID);
    const tab = { id: this._HOLD_TAB_ID, name: 'Holdings', type: 'system', tickers: [] };
    if (existing) Object.assign(existing, tab);
    else this.tabs.push(tab);
  },

  _selectedHoldingsPortfolio() {
    return this._holdingsPortfolios?.find(p => p.id === this._holdingsPortfolioId);
  },

  async _loadHoldings(isCurrent, signal) {
    if (!this._holdingsPortfolios) {
      const portfolios = await API.get('/portfolio', {}, signal);
      if (!isCurrent()) return;
      if (!Array.isArray(portfolios)) throw new Error('Invalid portfolio response');
      this._holdingsPortfolios = portfolios;
      let savedId = this._holdingsPortfolioId;
      try { savedId = Number(localStorage.getItem('holdings-portfolio-id')) || savedId; } catch {}
      this._holdingsPortfolioId = portfolios.some(p => p.id === savedId) ? savedId : portfolios[0]?.id ?? null;
    }
    this._renderHoldingsSelector();
    const portfolio = this._selectedHoldingsPortfolio();
    if (!portfolio) return;
    const positions = await API.get(`/portfolio/${portfolio.id}/positions`, {}, signal);
    if (!isCurrent()) return;
    if (!Array.isArray(positions)) throw new Error('Invalid holdings response');
    this._holdingsPositions = positions.filter(p => p.qty > 0 && p.ticker);
    TickerMetadata.seed(this._holdingsPositions);
    this._getActiveTab().tickers = [...new Set(this._holdingsPositions.map(p => p.ticker))];
    try { localStorage.setItem('holdings-portfolio-id', String(portfolio.id)); } catch {}
  },

  _renderHoldingsSelector() {
    const host = document.getElementById('holdingsSelector');
    if (!host) return;
    host.hidden = this.activeTabId !== this._HOLD_TAB_ID;
    const portfolios = this._holdingsPortfolios || [];
    host.innerHTML = '';
    if (host.hidden || !portfolios.length) return;
    host.innerHTML = `
      <span class="holdings-selector-label" id="holdingsSelectorLabel">Portfolio</span>
      <div class="holdings-portfolio-tabs" role="tablist" aria-labelledby="holdingsSelectorLabel"></div>
      <button type="button" class="holdings-dropdown" id="holdingsDropdown" aria-haspopup="listbox" aria-expanded="false" aria-labelledby="holdingsSelectorLabel holdingsDropdownLabel">
        <span class="holdings-dropdown-label" id="holdingsDropdownLabel"></span>
        <svg class="chevron" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <div class="holdings-menu" id="holdingsMenu" role="listbox" aria-labelledby="holdingsSelectorLabel" hidden></div>`;
    const tabs = host.querySelector('[role="tablist"]');
    const menu = host.querySelector('#holdingsMenu');
    const triggerLabel = host.querySelector('#holdingsDropdownLabel');
    for (const portfolio of portfolios) {
      const active = portfolio.id === this._holdingsPortfolioId;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'holdings-portfolio-tab';
      button.dataset.portfolioId = portfolio.id;
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(active));
      button.setAttribute('aria-controls', 'chartGrid');
      button.tabIndex = active ? 0 : -1;
      const name = document.createElement('span');
      name.textContent = portfolio.name;
      const currency = document.createElement('span');
      currency.className = 'holdings-currency';
      currency.textContent = portfolio.currency || '';
      button.append(name, currency);
      tabs.appendChild(button);
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'holdings-option';
      option.dataset.portfolioId = portfolio.id;
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(active));
      const optionName = document.createElement('span');
      optionName.className = 'holdings-option-name';
      optionName.textContent = portfolio.name;
      const optionCurrency = document.createElement('span');
      optionCurrency.className = 'holdings-currency';
      optionCurrency.textContent = portfolio.currency || '';
      option.append(optionName, optionCurrency);
      menu.appendChild(option);
      if (active && triggerLabel) {
        triggerLabel.textContent = `${portfolio.name}${portfolio.currency ? ` — ${portfolio.currency}` : ''}`;
      }
    }
  },

  _toggleHoldingsMenu() {
    const menu = document.getElementById('holdingsMenu');
    const trigger = document.getElementById('holdingsDropdown');
    if (!menu || !trigger) return;
    const willOpen = menu.hidden;
    menu.hidden = !willOpen;
    trigger.setAttribute('aria-expanded', String(willOpen));
    if (willOpen) menu.querySelector('.holdings-option[aria-selected="true"]')?.focus();
  },

  _closeHoldingsMenu(focusTrigger = false) {
    const menu = document.getElementById('holdingsMenu');
    const trigger = document.getElementById('holdingsDropdown');
    if (!menu || menu.hidden) return;
    menu.hidden = true;
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
    if (focusTrigger) trigger?.focus();
  },

  switchHoldingsPortfolio(id) {
    if (this.activeTabId !== this._HOLD_TAB_ID || id === this._holdingsPortfolioId
        || !this._holdingsPortfolios?.some(p => p.id === id)) return;
    this.closeExpandModal();
    this._holdingsPortfolioId = id;
    this._renderHoldingsSelector();
    return this.renderChartGrid();
  },

  _showHoldingsState(message, { loading = false, retry = false } = {}) {
    const grid = document.getElementById('chartGrid');
    if (!grid) return;
    grid.innerHTML = `<div class="holdings-state" role="listitem">
      ${loading ? '<div class="spinner" aria-hidden="true"></div>' : ''}
      <p role="${retry ? 'alert' : 'status'}">${this._escHtml(message)}</p>
      ${retry ? '<button type="button" class="chart-tool-btn">Try again</button>' : ''}
    </div>`;
    grid.querySelector('button')?.addEventListener('click', () => {
      this._holdingsPortfolios = null;
      this.renderChartGrid();
    });
  },

  _createHoldingsCard(ticker) {
    const card = this._createChartCard(ticker);
    card.classList.add('holdings-chart-card');
    card.querySelector('[data-action="delete"]').remove();
    card.querySelector('[data-action="toggle-draw"]').remove();
    const input = card.querySelector('.ticker-input');
    const tickerButton = document.createElement('button');
    tickerButton.type = 'button';
    tickerButton.className = 'holdings-ticker';
    tickerButton.textContent = ticker;
    tickerButton.setAttribute('aria-label', `Expand ${ticker} chart`);
    tickerButton.addEventListener('click', () => this.openExpandModal(ticker));
    input.replaceWith(tickerButton);
    return card;
  },

  _drawHoldingsAvgLine(ticker) {
    const state = this.charts[ticker];
    if (!state || this.activeTabId !== this._HOLD_TAB_ID) return;
    const avg = Number(this._holdingsPositions.find(p => p.ticker === ticker)?.avg_price);
    if (!Number.isFinite(avg) || avg <= 0) return;
    state.avgLine = state.candleSeries.createPriceLine({
      price: avg,
      color: document.documentElement.dataset.theme === 'dark' ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)',
      lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Solid,
      axisLabelVisible: true, title: 'Avg',
    });
  },

  async _initHoldingsCharts(tickers, isCurrent) {
    // Bound history requests without truncating the portfolio's holdings.
    const pending = [...tickers];
    const worker = async () => {
      while (isCurrent() && pending.length) {
        const ticker = pending.shift();
        this._initChartForTicker(ticker);
        this._drawHoldingsAvgLine(ticker);
        await Promise.all([this._loadChartData(ticker), this._loadSRLines(ticker)]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, tickers.length) }, worker));
  },

  /**
   * Fetch earnings tickers from the scanner API and populate
   * _earningsTodayTickers, _earningsUpcomingTickers, and _earningsScannedAt.
   */
  async _loadEarningsTickers() {
    try {
      const resp = await API.get('/scanner/earnings/all');
      if (resp) {
        TickerMetadata.seed(resp.today);
        TickerMetadata.seed(resp.upcoming);
        this._earningsTodayTickers = (resp.today || []).map(e => e.symbol);
        this._earningsUpcomingTickers = (resp.upcoming || []).map(e => e.symbol);
        this._earningsScannedAt = resp.scanned_at || null;
      }
    } catch (err) {
      console.warn('[Charts] Failed to load earnings tickers:', err.message);
      this._earningsTodayTickers = [];
      this._earningsUpcomingTickers = [];
      this._earningsScannedAt = null;
    }
  },

  /**
   * Fetch the SMA200 ranking from the scanner API and populate
   * _sma200AllTickers and _sma200ScannedAt.
   */
  async _loadSma200Tickers() {
    try {
      const resp = await API.get('/scanner/sma200/ranking');
      if (resp && resp.rankings) {
        this._sma200AllTickers = resp.rankings.map(r => r.ticker);
        this._sma200ScannedAt = resp.rankings.length > 0 ? resp.rankings[0].scanned_at : null;
      }
    } catch (err) {
      console.warn('[Charts] Failed to load SMA200 tickers:', err.message);
      this._sma200AllTickers = [];
      this._sma200ScannedAt = null;
    }
  },

  /**
   * Load earnings dates for all tickers in the active tab.
   */
  async _loadEarningsDates(isCurrent = () => true, signal = null) {
    try {
      const tab = this._getActiveTab();
      if (!tab || !tab.tickers || tab.tickers.length === 0) {
        this._earningsDates = {};
        return;
      }
      const tickers = tab.tickers.join(',');
      const dates = await API.get('/earnings/dates', { tickers, stored: 'true' }, signal);
      if (isCurrent()) this._earningsDates = dates || {};
    } catch (err) {
      if (!isCurrent()) return;
      console.warn('[Charts] Failed to load earnings dates:', err.message);
      this._earningsDates = {};
    }
  },

  /**
   * Load quarterly earnings history (EPS beat/miss) for all tickers in the active tab.
   * Populates _quarterlyEarnings: { ticker: [{ date, eps_actual, eps_estimate, surprise_pct, beat }] }
   */
  async _loadQuarterlyEarnings(isCurrent = () => true, signal = null) {
    try {
      const tab = this._getActiveTab();
      if (!tab || !tab.tickers || tab.tickers.length === 0) {
        this._quarterlyEarnings = {};
        return;
      }
      const tickers = tab.tickers.join(',');
      const history = await API.get('/earnings/history', { tickers }, signal);
      if (isCurrent()) this._quarterlyEarnings = history || {};
    } catch (err) {
      if (!isCurrent()) return;
      console.warn('[Charts] Failed to load quarterly earnings:', err.message);
      this._quarterlyEarnings = {};
    }
  },

  /**
   * Load transactions for all tickers in the active tab.
   * Populates _transactionsCache: { ticker: [{ type, date, price, qty }] }
   */
  async _loadTransactions(isCurrent = () => true, signal = null) {
    try {
      const tab = this._getActiveTab();
      if (!tab || !tab.tickers || tab.tickers.length === 0) {
        this._transactionsCache = {};
        return;
      }
      let transactions = {};
      if (tab.id === this._HOLD_TAB_ID) {
        const portfolioId = this._holdingsPortfolioId;
        let page = 1;
        let totalPages = 1;
        do {
          const data = await API.get(`/portfolio/${portfolioId}/transactions`, { page, per_page: 200 }, signal);
          if (!isCurrent()) return;
          for (const txn of data.transactions || []) {
            if (!tab.tickers.includes(txn.ticker)) continue;
            (transactions[txn.ticker] ||= []).push(txn);
          }
          totalPages = data.total_pages || 1;
          page++;
        } while (page <= totalPages);
      } else {
        const data = await API.get('/transactions/by-tickers', { tickers: tab.tickers.join(',') }, signal);
        transactions = data?.transactions || {};
      }
      if (isCurrent()) this._transactionsCache = transactions;
    } catch (err) {
      if (!isCurrent()) return;
      console.warn('[Charts] Failed to load transactions:', err.message);
      this._transactionsCache = {};
    }
  },

  /**
   * Find the candle time closest to (but not after) the given date string.
   * @param {string} dateStr - ISO date "YYYY-MM-DD"
   * @param {Array} candles - Array of candle data with time property
   * @returns {string|null} The matched candle time or null
   */
  _findClosestCandleTime(dateStr, candles) {
    if (!candles || candles.length === 0 || !dateStr) return null;

    // Binary search for the closest candle on or before dateStr
    let lo = 0;
    let hi = candles.length - 1;
    let result = null;

    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const candleTime = typeof candles[mid].time === 'string' ? candles[mid].time : String(candles[mid].time);
      if (candleTime <= dateStr) {
        result = candleTime;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    return result;
  },

  /**
   * Combine all marker types (earnings + transactions) and apply in one call.
   * LightweightCharts.createSeriesMarkers() replaces ALL markers, so we must
   * collect every marker type and apply them together.
   * @param {string} ticker
   * @param {Object} state - Chart state (must have candleSeries)
   * @param {Array} candles - Candle data
   */
  _applyAllMarkers(ticker, state, candles) {
    if (!state || !state.candleSeries) return;

    const markers = [];
    const isDark = document.documentElement.dataset.theme === 'dark';

    // Collect next earnings marker ("E" circle).
    // Future dates use exact match (placeholders created by _addEarningsMarker).
    // Held-over pending dates (nextDate <= last candle, not yet archived as
    // beat/miss) pin plain E at the exact announcement candle instead of
    // disappearing.
    const earningsInfo = this._earningsDates[ticker];
    const nextDate = earningsInfo?.next?.date;
    const pastEarnings = earningsInfo?.past || [];
    const pastSet = new Set(pastEarnings.map(p => p.date));
    const lastCandleTime = candles.length > 0 ? candles[candles.length - 1].time : null;
    if (nextDate && lastCandleTime) {
      if (nextDate > lastCandleTime) {
        const match = candles.find(c => c.time === nextDate);
        if (match) {
          markers.push({
            time: nextDate,
            position: 'aboveBar',
            color: isDark ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.9)',
            shape: 'circle',
            text: 'E',
          });
        }
      } else if (!pastSet.has(nextDate)) {
        const matchedTime = this._findClosestCandleTime(nextDate, candles);
        if (matchedTime) {
          markers.push({
            time: matchedTime,
            position: 'aboveBar',
            color: isDark ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.9)',
            shape: 'circle',
            text: 'E',
          });
        }
      }
    }

    // Collect past earnings markers (text-only below bar, "E▲"/"E▼")
    for (const pe of pastEarnings) {
      const matchedTime = this._findClosestCandleTime(pe.date, candles);
      if (matchedTime) {
        markers.push({
          time: matchedTime,
          position: 'belowBar',
          color: isDark ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.9)',
          text: pe.beat ? 'E▲' : 'E▼',
        });
      }
    }

    // Collect transaction markers
    const txns = this._transactionsCache[ticker];
    if (txns && txns.length > 0) {
      for (const txn of txns) {
        const matchedTime = this._findClosestCandleTime(txn.date, candles);
        if (matchedTime) {
          markers.push({
            time: matchedTime,
            position: txn.type === 'BUY' ? 'belowBar' : 'aboveBar',
            color: isDark ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.9)',
            shape: txn.type === 'BUY' ? 'arrowUp' : 'arrowDown',
            text: txn.type === 'BUY' ? 'B' : 'S',
          });
        }
      }
    }

    // Sort markers by time (required by LightweightCharts)
    markers.sort((a, b) => {
      const tA = typeof a.time === 'string' ? a.time : String(a.time);
      const tB = typeof b.time === 'string' ? b.time : String(b.time);
      return tA.localeCompare(tB);
    });

    // Reuse the marker plugin when metadata arrives after candles.
    if (markers.length > 0 || state.markersPlugin) {
      try {
        if (state.markersPlugin) state.markersPlugin.setMarkers(markers);
        else state.markersPlugin = LightweightCharts.createSeriesMarkers(state.candleSeries, markers);
      } catch (err) {
        console.warn('[Charts] Failed to add markers:', err.message);
      }
    }
  },

  /**
   * Check if an earnings date falls within the visible chart range.
   * Visible range = last ~67 candles + ~20 trading days ahead (~28 calendar days).
   * @param {string} earningsDate - ISO date string "YYYY-MM-DD"
   * @param {Array} candles - Array of candle data with time property
   * @returns {boolean}
   */
  _isInVisibleRange(earningsDate, candles) {
    if (!candles || candles.length === 0) return false;

    const earnings = new Date(earningsDate + 'T12:00:00');
    const lastCandle = new Date(candles[candles.length - 1].time + 'T12:00:00');

    // Allow 20 trading days ahead (~28 calendar days)
    const dayMs = 86400000;
    const rangeEnd = new Date(lastCandle.getTime() + 28 * dayMs);

    return earnings <= rangeEnd;
  },

  /**
   * Add earnings marker to a chart if earnings is in visible range.
   * @param {string} ticker
   * @param {Object} state - Chart state object
   * @param {Array} candles - Candle data
   */
  _addEarningsMarker(ticker, state, candles) {
    const earningsInfo = this._earningsDates[ticker];
    const earningsDate = earningsInfo?.next?.date;
    if (!earningsDate) return;

    // Check if in visible range
    if (!this._isInVisibleRange(earningsDate, candles)) return;

    const lastCandleDate = candles[candles.length - 1]?.time;

    // Past earnings (before last candle) — skip
    if (earningsDate < lastCandleDate) return;

    // Today's earnings need no placeholder; _applyAllMarkers places the E.
    if (earningsDate === lastCandleDate) return;

    // Future earnings — generate intermediate trading-day placeholders + doji + marker
    const lastCandle = candles[candles.length - 1];
    const lastClose = lastCandle.close;
    const placeholder = { open: lastClose, high: lastClose, low: lastClose, close: lastClose };

    // Advance UTC calendar days: local 24h increments repeat the earnings
    // date when daylight saving time ends between the last bar and earnings.
    const start = new Date(lastCandleDate + 'T12:00:00Z');
    const end = new Date(earningsDate + 'T12:00:00Z');
    const dayMs = 86400000;

    for (let t = new Date(start.getTime() + dayMs); t < end; t = new Date(t.getTime() + dayMs)) {
      const dow = t.getUTCDay();
      if (dow === 0 || dow === 6) continue; // skip Sun, Sat
      const dateStr = t.toISOString().split('T')[0];
      candles.push({ ...placeholder, time: dateStr });
    }

    // Final doji at earnings date (for the marker)
    candles.push({ time: earningsDate, ...placeholder });

    // _applyAllMarkers places the earnings marker after the placeholder exists.
  },

  /**
   * Render chart cards for the active tab.
   */
  async renderChartGrid() {
    const grid = document.getElementById('chartGrid');
    if (!grid) return;
    const version = ++this._gridVersion;
    const tab = this._getActiveTab();
    this._abortController?.abort();
    this._abortController = new AbortController();
    const signal = this._abortController.signal;
    const isCurrent = () => version === this._gridVersion && grid.isConnected
      && this._getActiveTab() === tab;
    this._updateAddChartBtn();
    this._renderHoldingsSelector();
    this._hideSRPicker();

    // Destroy existing chart instances
    Object.keys(this.charts).forEach((ticker) => {
      if (this.charts[ticker] && this.charts[ticker].chart) {
        if (this.charts[ticker].tooltip) this.charts[ticker].tooltip.destroy();
        if (this.charts[ticker]._resizeObserver) {
          this.charts[ticker]._resizeObserver.disconnect();
        }
        try { this.charts[ticker].chart.remove(); } catch {}
        // chart.remove() destroys the attached hover primitive with it.
        this.charts[ticker].hoverPrimitive = null;
      }
    });
    this.charts = {};
    this._barCache = {};
    const refreshStatus = document.getElementById('refreshAllChartsStatus');
    if (refreshStatus) refreshStatus.textContent = '';

    // Reset draw mode state since all cards/charts are being recreated
    if (this.drawMode) {
      this.drawMode = false;
      this.drawChartTicker = null;
    }

    grid.innerHTML = '';
    grid.setAttribute('aria-busy', 'false');
    grid.classList.toggle('holdings-grid', tab?.id === this._HOLD_TAB_ID);
    grid.setAttribute('aria-label', tab?.id === this._HOLD_TAB_ID ? 'Portfolio holdings charts' : 'Chart grid');

    // Hide earnings sections by default (shown only for earnings tab)
    const sectionsContainer = document.getElementById('earningsSections');
    if (sectionsContainer) {
      sectionsContainer.classList.remove('visible');
      sectionsContainer.innerHTML = '';
    }

    // Hide live section by default (shown only for live tab)
    const liveSection = document.getElementById('liveChartSection');
    if (liveSection) {
      liveSection.classList.remove('visible');
      liveSection.style.display = 'none';
    }

    // System tab: Live Chart (standalone single chart + SSE)
    if (tab && tab.id === this._LIVE_TAB_ID) {
      grid.innerHTML = '';
      grid.style.display = 'none';
      this._updateChartCount();
      this._updateAddChartBtn();
      await this._openLiveChart();
      return;
    }
    grid.style.display = '';

    if (tab?.id === this._HOLD_TAB_ID) {
      this._holdingsPositions = [];
      tab.tickers = [];
      this._updateChartCount();
      this._showHoldingsState('Loading holdings…', { loading: true });
      grid.setAttribute('aria-busy', 'true');
      try {
        await this._loadHoldings(isCurrent, signal);
      } catch (error) {
        if (!isCurrent()) return;
        console.warn('[Charts] Failed to load holdings:', error.message);
        grid.setAttribute('aria-busy', 'false');
        this._showHoldingsState('Unable to load holdings. Please try again.', { retry: true });
        return;
      }
      if (!isCurrent()) return;
      grid.setAttribute('aria-busy', 'false');
      this._updateChartCount();
      this._updateAddChartBtn();
      if (!tab.tickers.length) {
        const portfolio = this._selectedHoldingsPortfolio();
        this._showHoldingsState(portfolio ? `No holdings in ${portfolio.name}.`
          : 'Create a portfolio to see your holdings charts.');
        return;
      }
    }

    // Render candles without waiting for metadata; add markers when it arrives.
    this._earningsDates = {};
    this._transactionsCache = {};
    Promise.all([
      this._loadEarningsDates(isCurrent, signal),
      this._loadTransactions(isCurrent, signal),
    ]).then(() => {
      if (isCurrent()) this._refreshGridMarkers();
    });
    const tickers = tab ? tab.tickers : [];

    if (tab?.id === this._HOLD_TAB_ID) {
      grid.innerHTML = '';
      tickers.forEach(ticker => grid.appendChild(this._createHoldingsCard(ticker)));
      requestAnimationFrame(() => {
        if (isCurrent()) this._initHoldingsCharts(tickers, isCurrent);
      });
      return;
    }

    // System tab: 200 SMA
    if (tab && tab.type === 'system' && tab.id === this._SYSTEM_TAB_ID) {
      const sysTickers = this._sma200AllTickers;
      if (sysTickers.length === 0) {
        grid.innerHTML = `
          <div class="chart-card empty" role="listitem">
            <div class="card-body">
              <div class="card-status">
                <span style="font-size:13px;color:var(--color-text-secondary);">Run scanner to populate 200 EMA tab</span>
              </div>
            </div>
          </div>`;
        this._updateChartCount();
        return;
      }

      sysTickers.forEach((ticker) => {
        const card = this._createChartCard(ticker);
        const delBtn = card.querySelector('[data-action="delete"]');
        if (delBtn) delBtn.remove();
        const input = card.querySelector('.ticker-input');
        if (input) { input.readOnly = true; input.title = 'Ticker set by scanner'; }
        grid.appendChild(card);
      });

      requestAnimationFrame(() => {
        if (!isCurrent()) return;
        sysTickers.forEach((ticker) => {
          this._initChartForTicker(ticker);
          this._loadChartData(ticker);
          this._loadSRLines(ticker);
        });
      });
      this._updateChartCount();
      return;
    }

    // System tab: Earnings
    if (tab && tab.type === 'system' && tab.id === this._ERN_TAB_ID) {
      const todayTickers = tab._todayTickers || [];
      const upcomingTickers = tab._upcomingTickers || [];
      const allTickers = [...todayTickers, ...upcomingTickers];

      if (allTickers.length === 0) {
        grid.innerHTML = `
          <div class="chart-card empty" role="listitem">
            <div class="card-body">
              <div class="card-status">
                <span style="font-size:13px;color:var(--color-text-secondary);">No earnings data available. Run scanner to populate.</span>
              </div>
            </div>
          </div>`;
        this._updateChartCount();
        return;
      }

      // Show earnings sections container
      const sectionsContainer = document.getElementById('earningsSections');
      if (sectionsContainer) {
        sectionsContainer.classList.add('visible');
        sectionsContainer.innerHTML = '';

        // Helper function to create a locked chart card
        const createLockedCard = (ticker) => {
          const card = this._createChartCard(ticker);
          const delBtn = card.querySelector('[data-action="delete"]');
          if (delBtn) delBtn.remove();
          const input = card.querySelector('.ticker-input');
          if (input) { input.readOnly = true; input.title = 'Ticker set by scanner'; }
          return card;
        };

        // Render "Earnings Today" section
        const todaySection = document.createElement('div');
        todaySection.className = 'earnings-section';
        
        const todayLabel = document.createElement('div');
        todayLabel.className = 'earnings-label';
        todayLabel.textContent = 'Earnings Today';
        todaySection.appendChild(todayLabel);

        if (todayTickers.length === 0) {
          const emptyLabel = document.createElement('div');
          emptyLabel.className = 'earnings-label-empty';
          emptyLabel.textContent = 'No earnings today';
          todaySection.appendChild(emptyLabel);
        } else {
          const todayGrid = document.createElement('div');
          todayGrid.className = 'chart-grid earnings-grid';
          todayTickers.forEach((ticker) => {
            todayGrid.appendChild(createLockedCard(ticker));
          });
          todaySection.appendChild(todayGrid);
        }
        sectionsContainer.appendChild(todaySection);

        // Render "Upcoming Earnings" section
        const upcomingSection = document.createElement('div');
        upcomingSection.className = 'earnings-section';
        
        const upcomingLabel = document.createElement('div');
        upcomingLabel.className = 'earnings-label';
        upcomingLabel.textContent = 'Upcoming Earnings';
        upcomingSection.appendChild(upcomingLabel);

        if (upcomingTickers.length === 0) {
          const emptyLabel = document.createElement('div');
          emptyLabel.className = 'earnings-label-empty';
          emptyLabel.textContent = 'No upcoming earnings';
          upcomingSection.appendChild(emptyLabel);
        } else {
          const upcomingGrid = document.createElement('div');
          upcomingGrid.className = 'chart-grid earnings-grid';
          upcomingTickers.forEach((ticker) => {
            upcomingGrid.appendChild(createLockedCard(ticker));
          });
          upcomingSection.appendChild(upcomingGrid);
        }
        sectionsContainer.appendChild(upcomingSection);
      }

      // Initialize all charts
      requestAnimationFrame(() => {
        if (!isCurrent()) return;
        allTickers.forEach((ticker) => {
          this._initChartForTicker(ticker);
          this._loadChartData(ticker);
          this._loadSRLines(ticker);
        });
      });
      this._updateChartCount();
      return;
    }

    if (tickers.length === 0) {
      grid.innerHTML = `
        <div class="chart-card empty" role="listitem">
          <div class="card-header">
            <div class="card-left">
              <input class="ticker-input" value="" maxlength="10" placeholder="Add ticker" title="Type a ticker to add a chart" inputmode="text" autocorrect="off" autocapitalize="characters" autocomplete="off" spellcheck="false" style="color:var(--color-text-tertiary)" aria-label="Add ticker" disabled/>
            </div>
            <div class="card-right" style="visibility:hidden">
              <button class="card-btn" aria-hidden="true">✎</button>
              <button class="card-btn" aria-hidden="true">↻</button>
              <button class="card-btn" aria-hidden="true">⤢</button>
              <button class="card-btn" aria-hidden="true">✕</button>
            </div>
          </div>
          <div class="card-body">
            <div class="card-status">
              <span style="color:var(--color-text-tertiary);font-size:13px;">+ Add a chart to get started</span>
            </div>
          </div>
        </div>
      `;
      this._updateChartCount();
      return;
    }

    tickers.forEach((ticker) => {
      const card = this._createChartCard(ticker);
      grid.appendChild(card);
    });

    // Init charts after DOM is ready
    requestAnimationFrame(() => {
      if (!isCurrent()) return;
      tickers.forEach((ticker) => {
        this._initChartForTicker(ticker);
        this._loadChartData(ticker);
        this._loadSRLines(ticker);
      });
    });

    this._updateChartCount();
  },

  /**
   * Create a chart card DOM element for a ticker.
   * @param {string} ticker
   * @returns {HTMLElement}
   */
  _createChartCard(ticker) {
    const card = document.createElement('div');
    card.className = 'chart-card';
    card.dataset.ticker = ticker;
    card.setAttribute('role', 'listitem');
    card.setAttribute('aria-label', `Chart for ${ticker}`);

    card.innerHTML = `
      <div class="card-header">
        <div class="card-left">
          <input class="ticker-input" value="${this._escHtml(ticker)}" maxlength="10" size="${Math.max(7, ticker.length + 2)}" title="Click to change ticker" inputmode="text" autocorrect="off" autocapitalize="characters" autocomplete="off" spellcheck="false" aria-label="Ticker symbol for chart"/>
          <div class="price-block">
            <span class="price-val" data-role="price">--</span>
            <span class="price-chg" data-role="change">--</span>
          </div>
        </div>
        <div class="card-right">
          <button class="card-btn" title="Draw S/R — activate then click chart" aria-label="Toggle S/R drawing mode" data-action="toggle-draw">
            <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path d="m4 16 3.5-.8L16 6.7 13.3 4 4.8 12.5 4 16ZM11.8 5.5l2.7 2.7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
          <button class="card-btn" title="Reload" aria-label="Reload chart data" data-action="reload">
            <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M16.5 9a6.5 6.5 0 1 0 .1 2.5M16.5 4.5V9H12" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <button class="card-btn" title="Expand" aria-label="Expand chart" data-action="expand">
            <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path d="M12 3h5v5m0-5-6 6M8 17H3v-5m0 5 6-6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
          <button class="card-btn" title="Delete chart" aria-label="Delete chart" data-action="delete">
            <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path d="M4 5.5h12m-9-2h6m-7.5 2 .7 11h7.6l.7-11M8 8.5v5m4-5v5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
        </div>
      </div>
      <div class="card-body" data-role="chart-body">
        <div class="tv-chart-wrap" data-role="chart-container"></div>
        <button type="button" class="grid-pattern-toggle" data-action="toggle-pattern" hidden
                aria-pressed="true" aria-label="Hide pattern on ${this._escHtml(ticker)} chart" title="Hide pattern">
          <svg class="eye-open" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M2 10s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><circle cx="10" cy="10" r="2.3" stroke="currentColor" stroke-width="1.4"/></svg>
          <svg class="eye-closed" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M3 7.4C4.5 6 6.8 5 10 5c5 0 8 5 8 5-.6 1-1.4 2-2.5 2.9M4.5 13C2.9 11.6 2 10 2 10m5.2 4.5A9 9 0 0 0 10 15c1.1 0 2.1-.2 3-.5M2.5 2.5l15 15" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <div class="draw-hint">CLICK ON CHART TO PLACE S/R LEVEL</div>
        <div class="card-status" data-role="loading">
          <div class="spinner" aria-hidden="true"></div>
          <span style="font-size:13px;color:var(--color-text-secondary);">Loading ${this._escHtml(ticker)}...</span>
        </div>
        <div class="card-status hidden" data-role="error" role="alert">
          <span style="color:var(--color-error);font-size:13px;" data-role="error-msg">Unable to load chart</span>
        </div>
      </div>
    `;

    // Bind card events
    this._bindCardEvents(card, ticker);

    return card;
  },

  /**
   * Bind event listeners within a chart card.
   * @param {HTMLElement} card
   * @param {string} ticker
   */
  _bindCardEvents(card, ticker) {
    // Ticker input change
    const input = card.querySelector('.ticker-input');
    if (input) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const newTicker = input.value.trim().toUpperCase().replace(/[^A-Z.\-]/g, '').slice(0, 10);
          if (newTicker && newTicker !== ticker) {
            this._changeTicker(ticker, newTicker);
          }
        }
      });
      input.addEventListener('blur', () => {
        const val = input.value.trim().toUpperCase().replace(/[^A-Z.\-]/g, '').slice(0, 10);
        if (val && val !== ticker) {
          this._changeTicker(ticker, val);
        } else {
          input.value = ticker;
        }
      });
    }

    // Card button actions
    card.addEventListener('click', (e) => {
      if (e.target.closest('.grid-pattern-toggle')) {
        e.stopPropagation();
        this._toggleCardPattern(ticker, card);
        return;
      }
      const btn = e.target.closest('.card-btn');
      if (!btn) return;
      const action = btn.dataset.action;

      if (action === 'toggle-draw') {
        this.toggleDrawMode(ticker);
      } else if (action === 'reload') {
        this._reloadChart(ticker);
      } else if (action === 'expand') {
        this.openExpandModal(ticker);
      } else if (action === 'delete') {
        this._showDeleteChartModal(ticker);
      }
    });

  },

  /**
   * Change the ticker on a chart card (replaces old ticker in the tab).
   * @param {string} oldTicker
   * @param {string} newTicker
   */
  async _changeTicker(oldTicker, newTicker) {
    const tab = this._getActiveTab();
    if (!tab || tab.type === 'system') return;

    const idx = tab.tickers.indexOf(oldTicker);
    if (idx === -1) return;

    // Remove old chart instance
    if (this.charts[oldTicker] && this.charts[oldTicker].chart) {
      if (this.charts[oldTicker].tooltip) this.charts[oldTicker].tooltip.destroy();
      if (this.charts[oldTicker]._resizeObserver) {
        this.charts[oldTicker]._resizeObserver.disconnect();
      }
      try { this.charts[oldTicker].chart.remove(); } catch {}
      // chart.remove() destroys the attached hover primitive with it.
      this.charts[oldTicker].hoverPrimitive = null;
      delete this.charts[oldTicker];
    }

    tab.tickers[idx] = newTicker;
    await this.saveTabs();
    this.renderChartGrid();
  },

  /**
   * Reload data for a specific chart. Evicts all caches for fresh fetch.
   * @param {string} ticker
   */
  async _reloadChart(ticker) {
    // Force a provider fetch for this chart and update the database.
    this._srLoaded.delete(ticker);

    if (this.charts[ticker]) {
      this.charts[ticker].loading = true;
      this.charts[ticker].error = null;
      this.charts[ticker].lastRealTime = null;
      this._showCardLoading(ticker, true);
      this._showCardError(ticker, null);
    }
    await this._loadChartData(ticker, true);
    await this._loadSRLines(ticker);
  },

  async _pollStoredEarnings() {
    const grid = document.getElementById('chartGrid');
    const tab = this._getActiveTab();
    if (document.hidden || !grid?.isConnected || !tab?.tickers?.length || tab.id === this._LIVE_TAB_ID) return;
    const version = this._gridVersion;
    const isCurrent = () => version === this._gridVersion && this._getActiveTab() === tab;
    const previous = JSON.stringify(this._earningsDates);
    await this._loadEarningsDates(isCurrent, this._abortController?.signal);
    if (isCurrent() && previous !== JSON.stringify(this._earningsDates)) this._refreshGridMarkers();
  },

  /** Apply newly stored earnings/transactions without requesting candles again. */
  _refreshGridMarkers() {
    for (const [ticker, state] of Object.entries(this.charts)) {
      const bars = this._barCache[ticker];
      if (!state?.candleSeries || !bars?.length) continue;
      const candles = bars.filter(b => /^\d{4}-\d{2}-\d{2}$/.test(b.date))
        .map(b => ({ time: b.date, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }));
      if (!candles.length) continue;
      this._addEarningsMarker(ticker, state, candles);
      this._applyAllMarkers(ticker, state, candles);
      state.candleSeries.setData(candles);
    }
  },

  async _refreshAllCharts() {
    const tab = this._getActiveTab();
    const tickers = [...new Set(tab?.tickers || [])];
    const btn = document.getElementById('refreshAllChartsBtn');
    const status = document.getElementById('refreshAllChartsStatus');
    if (!btn || btn.disabled || !tickers.length || tab?.id === this._LIVE_TAB_ID) return;
    const version = this._gridVersion;
    const isCurrent = () => version === this._gridVersion && this._getActiveTab() === tab;
    btn.disabled = true;
    btn.textContent = '↻ Refreshing…';
    if (status) status.textContent = '';
    let failed = 0;
    const pending = [...tickers];
    const worker = async () => {
      while (isCurrent() && pending.length) {
        const ticker = pending.shift();
        if (!await this._loadChartData(ticker, true)) failed++;
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(4, tickers.length) }, worker));
      if (isCurrent() && status) status.textContent = failed
        ? `${tickers.length - failed} refreshed, ${failed} failed.` : `${tickers.length} charts refreshed.`;
    } finally {
      if (isCurrent()) {
        btn.disabled = false;
        btn.textContent = '↻ Refresh All';
      }
    }
  },

  // ─── CHART INSTANCES ────────────────────────────────────

  /**
   * Initialize a LightCharts instance for a ticker.
   * @param {string} ticker
   */
  _initChartForTicker(ticker) {
    const card = document.querySelector(`.chart-card[data-ticker="${ticker}"]`);
    if (!card) return;

    const container = card.querySelector('[data-role="chart-container"]');
    if (!container) return;

    if (typeof LightweightCharts === 'undefined') {
      this._showCardLoading(ticker, false);
      this._showCardError(ticker, 'Chart library not loaded. Please refresh.');
      return;
    }

    const isDark = document.documentElement.dataset.theme === 'dark';
    const { bgColor, textColor, gridColor } = chartThemeColors();

    const chart = LightweightCharts.createChart(container, {
      width: container.clientWidth || 400,
      height: container.clientHeight || 260,
      layout: {
        background: { color: bgColor },
        textColor,
        fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font').trim(),
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: gridColor, style: LightweightCharts.LineStyle.Dotted },
        horzLines: { color: gridColor, style: LightweightCharts.LineStyle.Dotted },
      },
      crosshair: {
        mode: LightweightCharts.CrosshairMode.Normal,
      },
      rightPriceScale: {
        borderColor: gridColor,
      },
      timeScale: {
        borderColor: gridColor,
        timeVisible: false,
        rightOffset: 5,
      },
      handleScroll: { vertTouchDrag: true },
    });

    const candleSeries = chart.addSeries(LightweightCharts.CandlestickSeries, {
      upColor: '#26a69a',
      downColor: '#ef5350',
      borderUpColor: '#26a69a',
      borderDownColor: '#ef5350',
      wickUpColor: '#26a69a',
      wickDownColor: '#ef5350',
    });

    // Hover highlight: soft band + close dot tracking the crosshair in sync
    // with the floating tooltip (driven from subscribeCrosshairMove below).
    // A primitive is used (not markers) so earnings/transaction markers are
    // untouched — createSeriesMarkers() would replace them all.
    let hoverPrimitive = null;
    if (typeof HoverHighlightPrimitive !== 'undefined') {
      try {
        hoverPrimitive = new HoverHighlightPrimitive({ colors: hoverHighlightColors(isDark) });
        candleSeries.attachPrimitive(hoverPrimitive);
      } catch (err) { hoverPrimitive = null; }
    }

    candleSeries.priceScale().applyOptions({
      scaleMargins: { top: 0.1, bottom: 0.15 },
    });

    const smaSeries = chart.addSeries(LightweightCharts.LineSeries, {
      color: isDark ? '#FF9800' : '#E65100',
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });

    // Volume histogram overlay (same pane, bottom 15%)
    const volumeSeries = chart.addSeries(LightweightCharts.HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: '',
    });
    volumeSeries.priceScale().applyOptions({
      scaleMargins: { top: 0.85, bottom: 0 },
    });

    // Click handler for S/R drawing
    chart.subscribeClick((param) => {
      if (!this.drawMode || this.drawChartTicker !== ticker) return;
      if (!param || !param.point) return;

      const price = candleSeries.coordinateToPrice(param.point.y);
      if (price != null) {
        const rect = container.getBoundingClientRect();
        this._skipPickerDismiss = true;
        this._showSRPicker(price, ticker, rect.left + param.point.x, rect.top + param.point.y);
      }
    });

    // Tracking tooltip for candlestick crosshair
    const companyName = TickerMetadata.get(ticker);
    const tooltip = this._createTrackingTooltip(container);
    chart.subscribeCrosshairMove((param) => {
      const side = tooltip.update(param, candleSeries, volumeSeries, this.charts[ticker]?.lastRealTime);
      // Mirror the tooltip's candle into the hover highlight (band + dot).
      // Clears whenever the tooltip would hide (out of bounds / no data).
      if (hoverPrimitive) {
        let hTime = null;
        let hPrice = null;
        let hDir = null;
        let hSide = null;
        if (side && param && param.time && param.point && param.seriesData &&
            param.point.x >= 0 && param.point.y >= 0 &&
            param.point.x <= container.clientWidth && param.point.y <= container.clientHeight) {
          const cd = param.seriesData.get(candleSeries);
          if (cd && cd.close != null) {
            const anchor = side === 'below' ? cd.low : cd.high;
            if (anchor != null) {
              hTime = param.time;
              hPrice = anchor;
              hDir = (cd.open != null && cd.close < cd.open) ? 'down' : 'up';
              hSide = side;
            }
          }
        }
        hoverPrimitive.setHover(hTime, hPrice, hDir, hSide);
      }
    });
    container.addEventListener('mouseleave', () => {
      tooltip.hide();
      if (hoverPrimitive) hoverPrimitive.setHover(null);
    });

    // ResizeObserver
    const ro = new ResizeObserver(() => {
      if (container.clientWidth > 0 && container.clientHeight > 0) {
        chart.applyOptions({
          width: container.clientWidth,
          height: container.clientHeight,
        });
      }
    });
    ro.observe(container);

    this.charts[ticker] = {
      chart,
      candleSeries,
      smaSeries,
      volumeSeries,
      container,
      tooltip,
      hoverPrimitive,
      card,
      companyName,
      lines: [],
      priceLines: {},
      price: null,
      changeAbs: null,
      changePct: null,
      loading: true,
      error: null,
      lastRealTime: null,
      pattern: null,
      patternSeries: [],
      patternVisible: true,
      _loadVersion: 0,
      _resizeObserver: ro,
    };
    this._loadChartCompanyName(ticker, this.charts[ticker]);
  },

  async _loadChartCompanyName(ticker, state) {
    const name = await TickerMetadata.resolve(ticker);
    // Cards can be removed/recreated for the same ticker while metadata loads.
    if (this.charts[ticker] !== state) return;
    state.companyName = name;
  },

  _removeCardPatternSeries(state) {
    for (const series of state.patternSeries) {
      try { state.chart.removeSeries(series); } catch {}
    }
    state.patternSeries = [];
  },

  _updateCardPatternButton(state, ticker) {
    const button = state.card.querySelector('.grid-pattern-toggle');
    if (!button) return;
    button.hidden = !state.pattern;
    button.setAttribute('aria-pressed', String(state.patternVisible));
    const action = state.patternVisible ? 'Hide' : 'Show';
    button.setAttribute('aria-label', `${action} pattern on ${ticker} chart`);
    button.title = `${action} pattern`;
  },

  _clearCardPattern(state) {
    this._removeCardPatternSeries(state);
    state.pattern = null;
    this._updateCardPatternButton(state, state.card.dataset.ticker);
  },

  _renderCardPattern(state, ticker) {
    this._removeCardPatternSeries(state);
    this._updateCardPatternButton(state, ticker);
    if (!state.pattern || !state.patternVisible) return;
    const isDark = document.documentElement.dataset.theme === 'dark';
    try {
      for (const points of [state.pattern.upper, state.pattern.lower]) {
        if (!points?.length) continue;
        const series = state.chart.addSeries(LightweightCharts.LineSeries, {
          color: isDark ? '#83B8EF' : '#2764A2', lineWidth: 1,
          lineStyle: LightweightCharts.LineStyle.Dashed,
          priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
        });
        state.patternSeries.push(series);
        series.setData(points);
      }
    } catch (error) {
      console.warn(`[Charts] Pattern overlay unavailable for ${ticker}:`, error);
      this._clearCardPattern(state);
    }
  },

  _toggleCardPattern(ticker, card) {
    const state = this.charts[ticker];
    if (!state || state.card !== card || !state.pattern) return;
    state.patternVisible = !state.patternVisible;
    this._renderCardPattern(state, ticker);
  },

  // ─── DATA LOADING ───────────────────────────────────────

  /**
   * Load OHLCV data for a ticker and populate the chart.
   * Grid navigation reads stored SQLite candles; explicit reload fetches Yahoo.
   * @param {string} ticker
   */
  async _loadChartData(ticker, refresh = false) {
    const state = this.charts[ticker];
    if (!state) return false;
    const loadVersion = ++state._loadVersion;
    const isCurrent = () => this.charts[ticker] === state &&
      state._loadVersion === loadVersion && state.card.isConnected;

    state.loading = true;
    state.error = null;
    this._clearCardPattern(state);
    this._showCardLoading(ticker, true);
    this._showCardError(ticker, null);

    try {
      const data = refresh
        ? await API.get('/data/history', { ticker, period: '1y', refresh: 'true' }, this._abortController?.signal)
        : await API.get('/data/history/stored', { ticker }, this._abortController?.signal);
      if (!isCurrent()) return false;
      const history = data?.history || [];
      if (!Array.isArray(history) || !history.length) {
        throw new Error('No stored candle data. Use Refresh All to fetch it.');
      }
      this._barCache[ticker] = history;

      // Map OHLCV data to LightCharts format
      const candles = history.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d.date)).map((d) => ({
        time: d.date,
        open: d.open,
        high: d.high,
        low: d.low,
        close: d.close,
        volume: d.volume,
      }));

      // Sort by time ascending
      candles.sort((a, b) => {
        const tA = typeof a.time === 'string' ? new Date(a.time).getTime() / 1000 : a.time;
        const tB = typeof b.time === 'string' ? new Date(b.time).getTime() / 1000 : b.time;
        return tA - tB;
      });

      // Normalize time format: LightCharts daily needs YYYY-MM-DD or Unix timestamp
      const normalizedCandles = candles.map((c) => ({
        ...c,
        time: typeof c.time === 'string' ? c.time.split('T')[0] : c.time,
      }));
      if (!normalizedCandles.length) throw new Error('No daily candle data available');
      // Same detector as the expanded modal; exclude synthetic earnings bars.
      try { state.pattern = detectDominantPattern(normalizedCandles); }
      catch (error) { console.warn(`[Charts] Pattern detection failed for ${ticker}:`, error); state.pattern = null; }

      // Set 200-period SMA overlay (calculate on real candles before earnings markers)
      const sma200 = this._calculateSMA(normalizedCandles, 200);
      if (sma200.length > 0 && state.smaSeries) {
        state.smaSeries.setData(sma200);
      }

      // Track how many placeholder candles _addEarningsMarker adds
      const lenBefore = normalizedCandles.length;
      this._addEarningsMarker(ticker, state, normalizedCandles);
      const placeholderCount = normalizedCandles.length - lenBefore;

      // Apply combined markers (earnings + transactions) — must happen
      // after _addEarningsMarker so future earnings placeholder candles exist
      this._applyAllMarkers(ticker, state, normalizedCandles);

      state.candleSeries.setData(normalizedCandles);
      this._renderCardPattern(state, ticker);

      // Set volume histogram data
      if (state.volumeSeries) {
        const isDarkTheme = document.documentElement.dataset.theme === 'dark';
        const volumeColor = isDarkTheme ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)';
        const volumeData = normalizedCandles
          .filter(c => c.volume != null)
          .map(c => ({
            time: c.time,
            value: c.volume,
            color: volumeColor,
          }));
        state.volumeSeries.setData(volumeData);
      }

      // Position last real candle at ~70% from left, 20 candles space to the right
      const lastRealIdx = normalizedCandles.length - 1 - placeholderCount;
      state.lastRealTime = (lastRealIdx >= 0 && normalizedCandles[lastRealIdx]) ? normalizedCandles[lastRealIdx].time : null;
      if (lastRealIdx >= 70) {
        state.chart.timeScale().setVisibleLogicalRange({ from: lastRealIdx - 70, to: lastRealIdx + 21 });
      } else {
        state.chart.timeScale().fitContent();
      }

      // Update price from last REAL candle (skip earnings placeholder candles)
      const lastCandle = normalizedCandles[lastRealIdx];
      if (lastCandle) {
        state.price = lastCandle.close;
        // Yahoo-style day change vs previous real close: $ abs + %
        state.changeAbs = null;
        state.changePct = null;
        if (lastRealIdx >= 1) {
          const prev = normalizedCandles[lastRealIdx - 1];
          if (prev && prev.close) {
            state.changeAbs = lastCandle.close - prev.close;
            state.changePct = (state.changeAbs / prev.close) * 100;
          }
        }
        this._updateCardPrice(ticker);
      }

      state.loading = false;
      this._showCardLoading(ticker, false);
      return true;
    } catch (err) {
      if (!isCurrent()) return false;
      console.warn(`[Charts] Failed to load data for ${ticker}:`, err.message);
      state.loading = false;
      state.error = err.message;
      this._showCardLoading(ticker, false);
      this._showCardError(ticker, err.message === 'No stored candle data. Use Refresh All to fetch it.'
        ? err.message : 'Unable to load chart data');
      return false;
    }
  },

  // ─── S/R LINES ──────────────────────────────────────────

  /**
   * Load S/R levels for a ticker from the backend (or cache).
   * Uses cross-tab cache to avoid redundant fetches.
   * @param {string} ticker
   */
  async _loadSRLines(ticker) {
    const state = this.charts[ticker];
    if (!state) return;
    // No-op if already loaded for this ticker (cross-tab cache)
    if (this._srLoaded.has(ticker)) {
      // Still render from cache if chart state exists
      if (this.charts[ticker]) {
        this.charts[ticker].lines = this._srCache[ticker] || [];
        this._renderSRLines(ticker);
      }
      return;
    }

    try {
      const lines = await API.get('/sr/levels', { ticker }, this._abortController?.signal);
      if (this.charts[ticker] !== state) return;
      const srLines = Array.isArray(lines) ? lines : [];
      // Deduplicate by id (API may return duplicates)
      const seen = new Set();
      this._srCache[ticker] = srLines.filter((l) => {
        if (seen.has(l.id)) return false;
        seen.add(l.id);
        return true;
      });
      this._srLoaded.add(ticker);

      if (this.charts[ticker]) {
        this.charts[ticker].lines = this._srCache[ticker];
        this._renderSRLines(ticker);
      }
    } catch (err) {
      if (this.charts[ticker] !== state) return;
      console.warn(`[Charts] Failed to load S/R lines for ${ticker}:`, err.message);
      this._srLoaded.delete(ticker); // allow retry on next load
    }
  },

  /**
   * Render S/R price lines on the chart.
   * @param {string} ticker
   */
  _renderSRLines(ticker) {
    const state = this.charts[ticker];
    if (!state || !state.candleSeries) return;

    // Remove all existing price lines
    if (state.priceLines) {
      Object.values(state.priceLines).forEach((pl) => {
        try { state.candleSeries.removePriceLine(pl); } catch {}
      });
    }
    state.priceLines = {};

    // Deduplicate lines by price+type before rendering
    const seen = new Set();
    const uniqueLines = state.lines.filter((l) => {
      const key = `${l.type}_${Number(l.price).toFixed(4)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    // Sync deduped lines back to state and cache
    state.lines = uniqueLines;
    this._srCache[ticker] = uniqueLines;

    console.log(`[Charts] _renderSRLines(${ticker}): rendering ${uniqueLines.length} line(s)`, uniqueLines.map(l => ({ id: l.id, price: l.price, type: l.type })));

    const isDark = document.documentElement.dataset.theme === 'dark';

    uniqueLines.forEach((line) => {
      const color = line.type === 'support'
        ? (isDark ? '#30D158' : 'rgba(29,158,117,0.85)')
        : (isDark ? '#FF453A' : 'rgba(216,90,48,0.85)');

      const pl = state.candleSeries.createPriceLine({
        price: line.price,
        color,
        lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Dashed,
        axisLabelVisible: true,
        title: line.type === 'support' ? 'S' : 'R',
      });
      state.priceLines[line.id] = pl;
    });
  },



  /**
   * Add an S/R level to the backend and refresh the chart.
   * Uses optimistic update: draws the line immediately, then persists to backend.
   * Updates cross-tab S/R cache.
   * @param {string} ticker
   * @param {number} price
   * @param {string} type - 'support' | 'resistance'
   */
  async addSRLine(ticker, price, type) {
    console.log(`[Charts] addSRLine called: ticker=${ticker}, price=${price}, type=${type}`);
    // Optimistic: add to local state immediately
    const tempId = -(Date.now());
    const srItem = { id: tempId, price, type };

    // Update cross-tab cache
    if (!this._srCache[ticker]) this._srCache[ticker] = [];
    this._srCache[ticker].push(srItem);

    if (this.charts[ticker]) {
      this.charts[ticker].lines.push(srItem);
      console.log(`[Charts] addSRLine: total lines for ${ticker} is now ${this.charts[ticker].lines.length}`);
      this._renderSRLines(ticker);
    }

    // Persist to backend
    try {
      const resp = await API.post('/sr/levels', {
        ticker,
        price: Math.round(price * 1e4) / 1e4,
        type,
      });

      // Replace temp ID with server-assigned ID
      if (resp && resp.id && this.charts[ticker]) {
        const lines = this.charts[ticker].lines;
        const item = lines.find((l) => l.id === tempId);
        if (item) {
          // Update price line map
          if (this.charts[ticker].priceLines[tempId]) {
            this.charts[ticker].priceLines[resp.id] = this.charts[ticker].priceLines[tempId];
            delete this.charts[ticker].priceLines[tempId];
          }
          item.id = resp.id;

          // Update cross-tab cache too
          const cacheLines = this._srCache[ticker] || [];
          const cacheItem = cacheLines.find((l) => l.id === tempId);
          if (cacheItem) cacheItem.id = resp.id;

        }

      }
    } catch (err) {
      console.warn(`[Charts] Failed to add S/R line:`, err.message);
      // Rollback optimistic update
      await this._loadSRLines(ticker);
    }
  },

  /**
   * Delete an S/R level from the backend and refresh the chart.
   * Updates cross-tab S/R cache.
   * @param {number} lineId
   * @param {string} ticker
   */
  async deleteSRLine(lineId, ticker) {
    // Optimistic: remove from local state immediately
    if (this.charts[ticker]) {
      const state = this.charts[ticker];
      state.lines = state.lines.filter((l) => l.id !== lineId);

      // Remove price line from chart
      if (state.priceLines[lineId]) {
        try { state.candleSeries.removePriceLine(state.priceLines[lineId]); } catch {}
        delete state.priceLines[lineId];
      }
    }

    // Update cross-tab cache
    if (this._srCache[ticker]) {
      this._srCache[ticker] = this._srCache[ticker].filter((l) => l.id !== lineId);
    }

    // Delete from backend (skip temp/unsynced IDs which are negative)
    if (lineId > 0) {
      try {
        await API.delete(`/sr/levels/${lineId}`);
      } catch (err) {
        console.warn(`[Charts] Failed to delete S/R line:`, err.message);
        // Rollback: reload from server
        await this._loadSRLines(ticker);
      }
    }
  },

  // ─── S/R DRAW MODE ──────────────────────────────────────

  /**
   * Toggle S/R draw mode for a chart.
   * @param {string} ticker
   */
  toggleDrawMode(ticker) {
    if (this.activeTabId === this._HOLD_TAB_ID) return;
    if (this.drawMode && this.drawChartTicker === ticker) {
      // Turn off
      this.drawMode = false;
      this.drawChartTicker = null;
      this._updateDrawModeUI(ticker, false);
    } else {
      // Turn off previous if any
      if (this.drawChartTicker) {
        this._updateDrawModeUI(this.drawChartTicker, false);
      }
      this.drawMode = true;
      this.drawChartTicker = ticker;
      this._updateDrawModeUI(ticker, true);
    }
  },

  /**
   * Update the visual state of draw mode on a card.
   * @param {string} ticker
   * @param {boolean} active
   */
  _updateDrawModeUI(ticker, active) {
    const card = document.querySelector(`.chart-card[data-ticker="${ticker}"]`);
    if (!card) return;

    const body = card.querySelector('[data-role="chart-body"]');
    const drawBtn = card.querySelector('[data-action="toggle-draw"]');
    const chartContainer = card.querySelector('[data-role="chart-container"]');
    if (body) body.classList.toggle('draw-mode', active);
    if (drawBtn) drawBtn.classList.toggle('sr-active', active);

    // Explicitly set cursor on chart container and canvas for reliable crosshair
    if (chartContainer) {
      chartContainer.style.cursor = active ? 'crosshair' : '';
      const canvas = chartContainer.querySelector('canvas');
      if (canvas) canvas.style.cursor = active ? 'crosshair' : '';
    }
  },

  // ─── S/R PICKER ─────────────────────────────────────────

  /**
   * Show the S/R picker near the click position.
   * @param {number} price
   * @param {string} ticker
   * @param {number} [clickX] - Optional X coordinate (viewport) to position near
   * @param {number} [clickY] - Optional Y coordinate (viewport) to position near
   */
  _showSRPicker(price, ticker, clickX, clickY) {
    const picker = document.getElementById('srPicker');
    const priceEl = document.getElementById('srPickerPrice');
    if (!picker || !priceEl) return;

    priceEl.textContent = `$${Number(price).toFixed(2)}`;
    picker.dataset.price = String(price);
    picker.dataset.ticker = ticker;

    // Position near click but clamped to viewport
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    picker.style.left = Math.min(Math.max((clickX || vw / 2) - 80, 8), vw - 280) + 'px';
    picker.style.top = Math.min(Math.max((clickY || 120) - 60, 8), vh - 90) + 'px';
    picker.style.transform = 'none';
    picker.style.display = 'flex';
    picker.querySelector('.sr-picker-cancel').focus();
  },

  /**
   * Hide the S/R picker.
   */
  _hideSRPicker() {
    const picker = document.getElementById('srPicker');
    if (picker) picker.style.display = 'none';
  },

  /**
   * Bind S/R picker button events.
   * Uses _chartsHasSRHandler guard to prevent duplicate bindings when navigating between screens.
   */
  _bindSRPicker() {
    const supportBtn = document.getElementById('srPickerSupport');
    const resistanceBtn = document.getElementById('srPickerResistance');
    const cancelBtn = document.getElementById('srPickerCancel');

    // Use _chartsHasSRHandler to avoid conflicting with Portfolio's bindings
    if (supportBtn && !supportBtn._chartsHasSRHandler) {
      supportBtn.addEventListener('click', () => {
        // Skip if expanded chart modal is open — Portfolio's handler owns that context
        const chartModal = document.getElementById('chart-modal');
        if (chartModal && chartModal.classList.contains('open')) return;

        const picker = document.getElementById('srPicker');
        const price = parseFloat(picker.dataset.price);
        const ticker = picker.dataset.ticker;
        if (!isNaN(price) && ticker) {
          this.addSRLine(ticker, price, 'support');
        }
        this._hideSRPicker();
      });
      supportBtn._chartsHasSRHandler = true;
    }

    if (resistanceBtn && !resistanceBtn._chartsHasSRHandler) {
      resistanceBtn.addEventListener('click', () => {
        // Skip if expanded chart modal is open — Portfolio's handler owns that context
        const chartModal = document.getElementById('chart-modal');
        if (chartModal && chartModal.classList.contains('open')) return;

        const picker = document.getElementById('srPicker');
        const price = parseFloat(picker.dataset.price);
        const ticker = picker.dataset.ticker;
        if (!isNaN(price) && ticker) {
          this.addSRLine(ticker, price, 'resistance');
        }
        this._hideSRPicker();
      });
      resistanceBtn._chartsHasSRHandler = true;
    }

    if (cancelBtn && !cancelBtn._chartsHasSRHandler) {
      cancelBtn.addEventListener('click', () => {
        // Skip if expanded chart modal is open — Portfolio's handler owns that context
        const chartModal = document.getElementById('chart-modal');
        if (chartModal && chartModal.classList.contains('open')) return;

        this._hideSRPicker();
      });
      cancelBtn._chartsHasSRHandler = true;
    }
  },

  // ─── EXPAND MODAL ───────────────────────────────────────

  /**
   * Open the shared expanded chart with an explicit snapshot for the Holdings tab.
   * @param {string} ticker
   */
  async openExpandModal(ticker) {
    this._hideSRPicker();
    const companyName = this.charts[ticker]?.companyName || '';
    const portfolio = this._selectedHoldingsPortfolio();
    const position = this._holdingsPositions.find(p => p.ticker === ticker);
    if (this.activeTabId === this._HOLD_TAB_ID && portfolio && position) {
      await ChartModal.open(ticker, companyName, {
        holding: { portfolioId: portfolio.id, name: portfolio.name, currency: portfolio.currency,
          position: { ...position }, transactions: [...(this._transactionsCache[ticker] || [])] },
      });
    } else {
      await ChartModal.open(ticker, companyName);
    }
  },

  /**
   * Close the shared expanded chart.
   */
  closeExpandModal() {
    ChartModal.close();
  },

  // ─── ADD CHART MODAL ────────────────────────────────────



  // ─── ADD CHART MODAL ────────────────────────────────────

  /**
   * Show the add chart modal.
   */
  _showAddChartModal() {
    if (this._getActiveTab()?.type === 'system') return;
    const modal = document.getElementById('addChartModal');
    const input = document.getElementById('addChartInput');
    const error = document.getElementById('addChartError');
    if (!modal) return;

    if (input) input.value = '';
    if (error) error.textContent = '';
    modal.style.display = 'flex';
    requestAnimationFrame(() => {
      modal.classList.add('open');
      if (input) input.focus();
    });
  },

  /**
   * Hide the add chart modal.
   */
  _hideAddChartModal() {
    const modal = document.getElementById('addChartModal');
    if (!modal) return;
    modal.classList.remove('open');
    setTimeout(() => { modal.style.display = 'none'; }, 300);
  },

  /**
   * Bind add chart modal events.
   */
  _bindAddChartModal() {
    const modal = document.getElementById('addChartModal');
    const cancelBtn = document.getElementById('addChartCancel');
    const submitBtn = document.getElementById('addChartSubmit');
    const input = document.getElementById('addChartInput');

    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => this._hideAddChartModal());
    }
    if (modal) {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) this._hideAddChartModal();
      });
    }
    if (submitBtn) {
      submitBtn.addEventListener('click', () => {
        this._submitAddChart();
      });
    }
    if (input) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') this._submitAddChart();
      });
    }
  },

  // ─── DELETE CHART MODAL ────────────────────────────────

  /**
   * Bind delete chart confirmation modal events.
   */
  _bindDeleteChartModal() {
    const modal = document.getElementById('deleteChartModal');
    const closeBtn = document.getElementById('deleteChartModalClose');
    const cancelBtn = document.getElementById('deleteChartCancel');
    const confirmBtn = document.getElementById('deleteChartConfirm');

    if (closeBtn && !closeBtn._hasHandler) {
      closeBtn.addEventListener('click', () => this._closeDeleteChartModal());
      closeBtn._hasHandler = true;
    }
    if (cancelBtn && !cancelBtn._hasHandler) {
      cancelBtn.addEventListener('click', () => this._closeDeleteChartModal());
      cancelBtn._hasHandler = true;
    }
    if (confirmBtn && !confirmBtn._hasHandler) {
      confirmBtn.addEventListener('click', () => {
        if (this._deleteChartTicker) {
          this._deleteChart(this._deleteChartTicker);
        }
      });
      confirmBtn._hasHandler = true;
    }
    if (modal && !modal._hasHandler) {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) this._closeDeleteChartModal();
      });
      modal._hasHandler = true;
    }
  },

  /**
   * Show the delete chart confirmation modal.
   * @param {string} ticker
   */
  _showDeleteChartModal(ticker) {
    const modal = document.getElementById('deleteChartModal');
    const nameEl = document.getElementById('deleteChartTickerName');
    if (!modal) return;

    this._deleteChartTicker = ticker;
    if (nameEl) nameEl.textContent = ticker;

    modal.style.display = 'flex';
    requestAnimationFrame(() => {
      modal.classList.add('open');
    });
  },

  /**
   * Close the delete chart confirmation modal.
   */
  _closeDeleteChartModal() {
    const modal = document.getElementById('deleteChartModal');
    if (!modal) return;
    modal.classList.remove('open');
    setTimeout(() => { modal.style.display = 'none'; }, 300);
    this._deleteChartTicker = null;
  },

  // ─── DELETE TAB MODAL ─────────────────────────────────

  /**
   * Bind delete tab confirmation modal events.
   */
  _bindDeleteTabModal() {
    const modal = document.getElementById('deleteTabModal');
    const closeBtn = document.getElementById('deleteTabModalClose');
    const cancelBtn = document.getElementById('deleteTabCancel');
    const confirmBtn = document.getElementById('deleteTabConfirm');

    if (closeBtn && !closeBtn._hasHandler) {
      closeBtn.addEventListener('click', () => this._closeDeleteTabModal());
      closeBtn._hasHandler = true;
    }
    if (cancelBtn && !cancelBtn._hasHandler) {
      cancelBtn.addEventListener('click', () => this._closeDeleteTabModal());
      cancelBtn._hasHandler = true;
    }
    if (confirmBtn && !confirmBtn._hasHandler) {
      confirmBtn.addEventListener('click', () => {
        if (this._pendingDeleteTabId) {
          this.deleteTab(this._pendingDeleteTabId);
        }
        this._closeDeleteTabModal();
      });
      confirmBtn._hasHandler = true;
    }
    if (modal && !modal._hasHandler) {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) this._closeDeleteTabModal();
      });
      modal._hasHandler = true;
    }
  },

  /**
   * Show the delete tab confirmation modal.
   * @param {string} tabId
   */
  _showDeleteTabModal(tabId) {
    const modal = document.getElementById('deleteTabModal');
    const nameEl = document.getElementById('deleteTabName');
    if (!modal) return;

    const tab = this.tabs.find(t => t.id === tabId);
    this._pendingDeleteTabId = tabId;
    if (nameEl) nameEl.textContent = tab ? tab.name : 'this tab';

    modal.style.display = 'flex';
    requestAnimationFrame(() => {
      modal.classList.add('open');
    });
  },

  /**
   * Close the delete tab confirmation modal.
   */
  _closeDeleteTabModal() {
    const modal = document.getElementById('deleteTabModal');
    if (!modal) return;
    modal.classList.remove('open');
    setTimeout(() => { modal.style.display = 'none'; }, 300);
    this._pendingDeleteTabId = null;
  },

  /**
   * Execute chart deletion: remove ticker from tab, destroy chart instance,
   * clean up caches, persist, and re-render.
   * @param {string} ticker
   */
  async _deleteChart(ticker) {
    const tab = this._getActiveTab();
    if (!tab || tab.type === 'system') return;

    const idx = tab.tickers.indexOf(ticker);
    if (idx === -1) return;

    // Remove ticker from tab
    tab.tickers.splice(idx, 1);

    // Destroy chart instance
    if (this.charts[ticker]) {
      const state = this.charts[ticker];
      if (state.tooltip) state.tooltip.destroy();
      if (state._resizeObserver) state._resizeObserver.disconnect();
      try { state.chart.remove(); } catch {}
      // chart.remove() destroys the attached hover primitive with it.
      state.hoverPrimitive = null;
      delete this.charts[ticker];
    }

    // Clean up caches
    delete this._barCache[ticker];
    delete this._srCache[ticker];
    this._srLoaded.delete(ticker);

    // If this chart had draw mode active, reset it
    if (this.drawChartTicker === ticker) {
      this.drawMode = false;
      this.drawChartTicker = null;
    }

    // If the expand modal was showing this ticker, close it
    if (this.expandTicker === ticker) {
      this.closeExpandModal();
    }

    // Close modal
    this._closeDeleteChartModal();

    // Persist and re-render
    await this.saveTabs();
    this.renderTabs();
    this.renderChartGrid();
  },

  /**
   * Validate and submit the add chart form.
   */
  _submitAddChart() {
    if (this._getActiveTab()?.type === 'system') return;
    const input = document.getElementById('addChartInput');
    const error = document.getElementById('addChartError');
    if (!input) return;

    const ticker = input.value.trim().toUpperCase().replace(/[^A-Z.\-]/g, '').slice(0, 10);

    if (!ticker) {
      if (error) error.textContent = 'Please enter a valid ticker symbol.';
      return;
    }

    // Check if already exists in active tab
    const tab = this._getActiveTab();
    if (tab && tab.tickers.includes(ticker)) {
      if (error) error.textContent = `${ticker} is already on this tab.`;
      return;
    }

    // Add to active tab
    if (tab) {
      tab.tickers.push(ticker);
    } else {
      // Create first tab
      const newTab = { id: this._uid(), name: 'Watchlist 1', tickers: [ticker] };
      this.tabs.push(newTab);
      this.activeTabId = newTab.id;
    }

    this.saveTabs();
    this._hideAddChartModal();
    this.renderTabs();
    this.renderChartGrid();
  },

  // ─── UI HELPERS ─────────────────────────────────────────

  /**
   * Show/hide loading state on a card.
   * @param {string} ticker
   * @param {boolean} show
   */
  _showCardLoading(ticker, show) {
    const card = document.querySelector(`.chart-card[data-ticker="${ticker}"]`);
    if (!card) return;
    const el = card.querySelector('[data-role="loading"]');
    if (el) el.classList.toggle('hidden', !show);
  },

  /**
   * Show/hide error state on a card.
   * @param {string} ticker
   * @param {string|null} message
   */
  _showCardError(ticker, message) {
    const card = document.querySelector(`.chart-card[data-ticker="${ticker}"]`);
    if (!card) return;
    const el = card.querySelector('[data-role="error"]');
    const msgEl = card.querySelector('[data-role="error-msg"]');
    if (el) el.classList.toggle('hidden', message === null);
    if (msgEl && message) msgEl.textContent = message;
  },

  /**
   * Create a floating tracking tooltip for candlestick charts.
   * Follows the crosshair cursor and shows close price and volume.
   * @param {HTMLElement} container - The chart container element (must be position:relative)
   * @returns {{ element: HTMLElement, update: Function, hide: Function, destroy: Function }}
    */
  _createTrackingTooltip(container) {
    const tip = document.createElement('div');
    tip.className = 'lc-tracking-tooltip';
    tip.innerHTML = `
      <div class="lc-tt-price"></div>
      <div class="lc-tt-volume"></div>
    `;
    container.style.position = 'relative';
    container.appendChild(tip);

    const priceEl = tip.querySelector('.lc-tt-price');
    const volEl = tip.querySelector('.lc-tt-volume');

    return {
      element: tip,
      update(param, candleSeries, volumeSeries, lastRealTime) {
        if (!param || param.point === undefined || !param.time ||
            param.point.x < 0 || param.point.y < 0 ||
            param.point.x > container.clientWidth || param.point.y > container.clientHeight) {
          tip.style.display = 'none';
          return null;
        }
        if (!param.seriesData) { tip.style.display = 'none'; return null; }
        const candleData = param.seriesData.get(candleSeries);
        if (!candleData) { tip.style.display = 'none'; return null; }
        // Suppress tooltip on synthetic earnings-placeholder bars past the last real bar.
        if (lastRealTime != null && _isAfterTime(param.time, lastRealTime)) { tip.style.display = 'none'; return null; }

        const close = candleData.close;
        const open = candleData.open;
        const volData = volumeSeries ? param.seriesData.get(volumeSeries) : null;

        priceEl.textContent = close != null ? close.toFixed(2) : '—';
        // Color price based on candle direction
        if (close != null && open != null) {
          priceEl.style.color = close >= open ? 'var(--color-stock-up, #26a69a)' : 'var(--color-stock-down, #ef5350)';
        }

        if (volData && volData.value != null) {
          const v = volData.value;
          volEl.textContent = v >= 1e9 ? `Vol: ${(v / 1e9).toFixed(1)}B`
            : v >= 1e6 ? `Vol: ${(v / 1e6).toFixed(1)}M`
            : v >= 1e3 ? `Vol: ${(v / 1e3).toFixed(1)}K`
            : `Vol: ${v}`;
          volEl.style.display = '';
        } else {
          volEl.style.display = 'none';
        }

        tip.style.display = 'block';
        const highC = (candleData.high != null) ? candleSeries.priceToCoordinate(candleData.high) : null;
        const lowC = (candleData.low != null) ? candleSeries.priceToCoordinate(candleData.low) : null;
        if (highC === null || highC === undefined || lowC === null || lowC === undefined) { tip.style.display = 'none'; return null; }
        const rect = container.getBoundingClientRect();
        const tipW = tip.offsetWidth || 120;
        const tipH = tip.offsetHeight || 80;
        let left = param.point.x - tipW / 2;
        left = Math.max(8, Math.min(left, rect.width - tipW - 8));
        const GAP = 20;
        let top = highC - tipH - GAP;
        let side = 'above';
        if (top <= 0) { top = lowC + GAP; side = 'below'; }
        top = Math.max(0, Math.min(top, rect.height - tipH));
        tip.style.left = left + 'px';
        tip.style.top = top + 'px';
        return side;
      },
      hide() { tip.style.display = 'none'; },
      destroy() { tip.remove(); }
    };
  },

  /**
   * Update the price display on a card.
   * @param {string} ticker
   */
  _updateCardPrice(ticker) {
    const card = document.querySelector(`.chart-card[data-ticker="${ticker}"]`);
    if (!card) return;

    const state = this.charts[ticker];
    if (!state) return;

    const priceEl = card.querySelector('[data-role="price"]');
    const chgEl = card.querySelector('[data-role="change"]');

    // Yahoo-style: dollar change + percent change only (no absolute price).
    // e.g. yesterday 100, current 120 -> "+$20.00 (+20.00%)", tinted up/dn.
    const hasAbs = state.changeAbs !== null && state.changeAbs !== undefined && !isNaN(Number(state.changeAbs));
    const hasPct = state.changePct !== null && state.changePct !== undefined && !isNaN(Number(state.changePct));
    const dir = (hasAbs || hasPct)
      ? ((Number(hasPct ? state.changePct : state.changeAbs)) > 0 ? 'up'
        : (Number(hasPct ? state.changePct : state.changeAbs)) < 0 ? 'dn' : null)
      : null;

    if (priceEl && hasAbs) {
      const a = Number(state.changeAbs);
      priceEl.textContent = `${a > 0 ? '+' : a < 0 ? '-' : ''}$${Math.abs(a).toFixed(2)}`;
      priceEl.className = dir ? `price-val ${dir}` : 'price-val';
    }

    if (chgEl && hasPct) {
      const v = Number(state.changePct);
      chgEl.textContent = `(${v > 0 ? '+' : v < 0 ? '-' : ''}${Math.abs(v).toFixed(2)}%)`;
      chgEl.className = dir ? `price-chg ${dir}` : 'price-chg';
    }
  },

  /**
   * Update the chart count display.
   */
  _updateChartCount() {
    const el = document.getElementById('chartCount');
    if (!el) return;
    const tab = this._getActiveTab();
    if (tab && tab.id === this._LIVE_TAB_ID) {
      const t = (this._live && this._live.ticker) || this._liveGetTicker();
      el.textContent = `Live • ${t}`;
      return;
    }
    const count = tab ? tab.tickers.length : 0;
    if (tab?.id === this._HOLD_TAB_ID) {
      const portfolio = this._selectedHoldingsPortfolio();
      el.textContent = `${count} holding${count !== 1 ? 's' : ''}${portfolio ? ` — ${portfolio.name}` : ''}`;
      return;
    }
    el.textContent = `${count} chart${count !== 1 ? 's' : ''}`;
  },

  /**
   * Show/hide the "Add Chart" button based on active tab type.
   * Hidden for system tabs (read-only).
   */
  _updateAddChartBtn() {
    const btn = document.getElementById('addChartBtn');
    if (!btn) return;
    const tab = this._getActiveTab();
    btn.style.display = (tab && tab.type === 'system') ? 'none' : '';
    const refreshBtn = document.getElementById('refreshAllChartsBtn');
    if (refreshBtn) {
      refreshBtn.style.display = !tab || tab.id === this._LIVE_TAB_ID || !tab.tickers?.length ? 'none' : '';
      refreshBtn.disabled = false;
      refreshBtn.textContent = '↻ Refresh All';
    }
    const addTab = document.getElementById('tabAddBtn');
    if (addTab) addTab.hidden = tab?.id === this._HOLD_TAB_ID;
  },

  /**
   * Start auto-resize listener for chart reflows.
   */
  _startAutoResize() {
    this._resizeHandler = () => {
      clearTimeout(this._resizeTimer);
      this._resizeTimer = setTimeout(() => {
        Object.keys(this.charts).forEach((ticker) => {
          const state = this.charts[ticker];
          if (state && state.chart && state.container) {
            try {
              state.chart.applyOptions({
                width: state.container.clientWidth,
                height: state.container.clientHeight,
              });
            } catch {}
          }
        });
        // Live standalone chart resizes with the same pass
        try {
          const L = this._live;
          if (L && L.chart && L.container && L.container.clientWidth > 0) {
            L.chart.applyOptions({
              width: L.container.clientWidth,
              height: L.container.clientHeight,
            });
          }
        } catch {}
      }, 150);
    };
    window.addEventListener('resize', this._resizeHandler);
  },

  // ─── UTILITIES ──────────────────────────────────────────

  /**
   * Calculate Simple Moving Average over a given period.
   * @param {Array<{time: string|number, close: number}>} candles - Sorted by time ascending
   * @param {number} period - SMA period (e.g. 200)
   * @returns {Array<{time: string|number, value: number}>} SMA data points
   */
  _calculateSMA(candles, period) {
    const result = [];
    for (let i = period - 1; i < candles.length; i++) {
      let sum = 0;
      for (let j = 0; j < period; j++) sum += candles[i - j].close;
      result.push({ time: candles[i].time, value: sum / period });
    }
    return result;
  },

  /**
   * Generate a short unique ID.
   * @returns {string}
   */
  _uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  },

  /**
   * Escape HTML entities.
   * @param {string} str
   * @returns {string}
   */
  _escHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  },

  /**
   * Format an ISO timestamp into a human-readable "Mon DD HH:MM" string.
   * @param {string|null} isoString - ISO 8601 timestamp
   * @returns {string} Formatted time string, or empty string if invalid
   */
  _formatScanTime(isoString) {
    if (!isoString) return '';
    try {
      const d = new Date(isoString);
      const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      const date = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
      return `${date} ${time}`;
    } catch {
      return '';
    }
  },

  /**
   * Show an inline error message.
   * @param {string} message - Error message to display
   * @param {Function|null} retryFn - Optional retry function
   */
  _showInlineError(message, retryFn) {
    const tabBar = document.getElementById('tabBar');
    const tickerGrid = document.getElementById('tickerGrid');
    if (!tabBar && !tickerGrid) return;

    const container = tickerGrid || tabBar;
    const retryId = 'retry-charts-' + Date.now();
    container.innerHTML = '<div class="error-message" role="alert" style="grid-column: 1 / -1; text-align: center; padding: var(--space-8);">' +
      '<p class="error-text">' + this._escHtml(message) + '</p>' +
      (retryFn ? '<button class="retry-btn" id="' + retryId + '">Retry</button>' : '') +
    '</div>';

    if (retryFn) {
      const retryBtn = document.getElementById(retryId);
      if (retryBtn) {
        retryBtn.addEventListener('click', () => {
          this.render();
          retryFn();
        });
      }
    }
  },

  /**
   * Show empty state when no tabs exist.
   */
  _showEmptyState() {
    const tickerGrid = document.getElementById('tickerGrid');
    if (tickerGrid) {
      tickerGrid.innerHTML = '<div class="empty-state" style="grid-column: 1 / -1; text-align: center; padding: var(--space-8); color: var(--color-text-tertiary);">' +
        '<p>No watchlist tabs yet</p>' +
        '<p style="margin-top: var(--space-2); font-size: var(--font-size-sm);">Create a tab to start tracking stocks</p>' +
      '</div>';
    }
  },

  // ─── LIVE CHART (standalone tab) ────────────────────
  // Additive-only: single chart + one SSE stream. Socket open ONLY while
  // the Live tab is active and document visible; closed on tab/screen leave
  // and after 5 min without user gestures (ticks do NOT reset idle).

  /** Live timeframe defs: UI id -> backend period/interval + bucket seconds.
   * Intraday only (1D removed per product decision). */
  _LIVE_TFS() {
    return [
      { id: '1m', label: '1m', period: '1d', interval: '1m', bucket: 60 },
      { id: '5m', label: '5m', period: '5d', interval: '5m', bucket: 300 },
      { id: '15m', label: '15m', period: '5d', interval: '15m', bucket: 900 },
    ];
  },

  _liveGetTicker() {
    try {
      const t = (localStorage.getItem('liveChart.ticker') || '').toUpperCase().trim();
      if (t) return t;
    } catch {}
    // Fallback: first ticker of last non-system tab, else AAPL.
    try {
      const tab = (this.tabs || []).find(t => t.type !== 'system' && t.tickers && t.tickers.length);
      if (tab) return tab.tickers[0];
    } catch {}
    return 'AAPL';
  },

  _liveGetInterval() {
    try {
      const v = localStorage.getItem('liveChart.interval') || '15m';
      if (v === '1D') { try { localStorage.setItem('liveChart.interval', '15m'); } catch {} return '15m'; }
      if (this._LIVE_TFS().some(t => t.id === v)) return v;
    } catch {}
    return '15m';
  },

  _liveSavePrefs() {
    try {
      if (this._live) {
        localStorage.setItem('liveChart.ticker', this._live.ticker);
        localStorage.setItem('liveChart.interval', this._live.interval);
      }
    } catch {}
  },

  _liveTfDef(interval) {
    return this._LIVE_TFS().find(t => t.id === interval) || this._LIVE_TFS()[2];
  },

  /** New per-session stream id (correlates SSE open/close/hint server logs). */
  _liveNewSid() {
    try { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
    catch { return String(Date.now()); }
  },

  /**
   * Advisory teardown hint: at most once per session, and only when a
   * stream was actually opened (CLOSED-market sessions never touched the
   * server, so they stay silent). The SSE-disconnect server path owns real
   * demand state; this is just fast reclaim + attribution.
   */
  _liveSendUnsub(L, reason) {
    if (!L || L.unsubSent || !L.streamOpened) return;
    L.unsubSent = true;
    const payload = JSON.stringify({ tickers: [L.ticker], reason, sid: L.sid || null });
    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/stream/unsubscribe', new Blob([payload], { type: 'application/json' }));
      } else {
        fetch('/api/stream/unsubscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload, keepalive: true });
      }
    } catch {}
  },

  async _openLiveChart() {
    const section = document.getElementById('liveChartSection');
    if (!section) return;
    section.style.display = 'flex';
    section.classList.add('visible');

    const ticker = this._liveGetTicker();
    const interval = this._liveGetInterval();
    this._live = {
      ticker, interval,
      chart: null, candleSeries: null, volumeSeries: null, container: null,
      eventSource: null, status: 'LOADING', gen: 0,
      candles: [], lastBucket: null, lastDayVolume: 0,
      idleTimer: null, resyncTimer: null, visHandler: null, actHandler: null,
      price: null, changeAbs: null, changePct: null,
      sid: this._liveNewSid(), streamOpened: false, unsubSent: false,
      shade: null, shadeDayKey: null,
      autoSR: [], autoSRPending: null, autoSRDay: null, autoSRDaily: null, autoSRThrottle: 0, autoSRHidden: false, autoSRLevels: [],
    };
    this._renderLiveSection();
    this._updateChartCount();
    await this._liveLoadHistory();
    this._liveStartStream();
    this._liveArmIdle();
    this._liveWatchVisibility();
  },

  _renderLiveSection() {
    const section = document.getElementById('liveChartSection');
    const L = this._live;
    if (!section || !L) return;
    // Defensive: this section must be visible and grid hidden on every render
    // (previously timeframe/ticker switches left both hidden -> blank screen).
    section.style.display = 'flex';
    section.classList.add('visible');
    const grid = document.getElementById('chartGrid');
    if (grid) grid.style.display = 'none';
    const tfs = this._LIVE_TFS().map(t =>
      `<button class="time-interval-btn${t.id === L.interval ? ' active' : ''}" data-live-tf="${t.id}">${t.label}</button>`
    ).join('');
    section.innerHTML = `
      <div class="live-card">
        <div class="live-toolbar">
          <input class="live-ticker-input" id="liveTickerInput" value="${this._escHtml(L.ticker)}" maxlength="10" spellcheck="false" autocomplete="off" autocapitalize="characters" aria-label="Live ticker" title="Type ticker + Enter" />
          <div class="time-interval-bar" role="tablist" aria-label="Live timeframe">${tfs}</div>
          <div class="price-block">
            <span class="price-val" id="livePrice">--</span>
            <span class="price-chg" id="liveChg">--</span>
          </div>
          <span class="live-badge off" id="liveBadge">…</span>
        </div>
        <div class="live-chart-body">
          <div class="tv-chart-wrap" id="liveChartCanvas"></div>
          <button type="button" class="live-sr-toggle" id="liveSRtoggle" hidden
                  aria-pressed="true" aria-label="Hide S/R lines" title="Hide S/R lines">
            <svg class="eye-open" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M2 10s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><circle cx="10" cy="10" r="2.3" stroke="currentColor" stroke-width="1.4"/></svg>
            <svg class="eye-closed" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M3 7.4C4.5 6 6.8 5 10 5c5 0 8 5 8 5-.6 1-1.4 2-2.5 2.9M4.5 13C2.9 11.6 2 10 2 10m5.2 4.5A9 9 0 0 0 10 15c1.1 0 2.1-.2 3-.5M2.5 2.5l15 15" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <div class="card-status" id="liveLoading"><div class="spinner"></div><span style="font-size:13px;color:var(--color-text-secondary);">Loading ${this._escHtml(L.ticker)}…</span></div>
          <div class="card-status hidden" id="liveError" role="alert"><span style="font-size:13px;color:var(--color-error);" id="liveErrorMsg">Unable to load</span></div>
          <div class="live-resume-overlay" id="liveResume"><span style="font-size:13px;color:#fff;">Paused — socket closed after 5 min idle</span><button class="live-resume-btn" id="liveResumeBtn">Resume live</button></div>
        </div>
      </div>`;

    const input = section.querySelector('#liveTickerInput');
    if (input) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') this._liveChangeTicker(input.value);
      });
      input.addEventListener('blur', () => {
        const v = input.value.trim().toUpperCase();
        if (v && v !== L.ticker) this._liveChangeTicker(v);
        else input.value = L.ticker;
      });
    }
    section.querySelectorAll('[data-live-tf]').forEach(btn => {
      btn.addEventListener('click', () => this._liveChangeInterval(btn.dataset.liveTf));
    });
    const resume = section.querySelector('#liveResumeBtn');
    if (resume) resume.addEventListener('click', () => this._liveResume());
    const srToggle = section.querySelector('#liveSRtoggle');
    if (srToggle) srToggle.addEventListener('click', () => this._liveToggleAutoSR());
  },

  _liveSetBadge(status) {
    const badge = document.getElementById('liveBadge');
    if (!badge) return;
    const L = this._live;
    if (L) L.status = status;
    badge.className = 'live-badge ' + (status === 'LIVE' || status === 'PRE' || status === 'POST'
      ? 'on' : status === 'PAUSED' ? 'paused' : 'off');
    badge.textContent = status === 'LIVE' ? '● LIVE'
      : status === 'PRE' ? '● PRE'
      : status === 'POST' ? '● POST'
      : status === 'PAUSED' ? '○ PAUSED'
      : status === 'LOADING' ? '…'
      : '○ ' + status;
  },

  _liveUpdateHeader(changeAbs, chgPct) {
    const p = document.getElementById('livePrice');
    const c = document.getElementById('liveChg');
    // Yahoo-style: dollar change + percent change only (no absolute price).
    const hasAbs = changeAbs !== null && changeAbs !== undefined && !isNaN(Number(changeAbs));
    const hasPct = chgPct !== null && chgPct !== undefined && !isNaN(Number(chgPct));
    const basis = hasPct ? Number(chgPct) : (hasAbs ? Number(changeAbs) : 0);
    const dir = (hasAbs || hasPct) ? (basis > 0 ? 'up' : basis < 0 ? 'dn' : null) : null;
    if (p && hasAbs) {
      const a = Number(changeAbs);
      p.textContent = `${a > 0 ? '+' : a < 0 ? '-' : ''}$${Math.abs(a).toFixed(2)}`;
      p.className = dir ? `price-val ${dir}` : 'price-val';
    }
    if (c && hasPct) {
      const v = Number(chgPct);
      c.textContent = `(${v > 0 ? '+' : v < 0 ? '-' : ''}${Math.abs(v).toFixed(2)}%)`;
      c.className = dir ? `price-chg ${dir}` : 'price-chg';
    }
  },

  _liveChangeAbs(price, pct) {
    // Derive dollar change from price + pct vs prior close.
    // pct=-100% would divide by zero -> return null (unknown).
    const p = Number(price);
    const v = Number(pct);
    if (!isNaN(p) && p > 0 && !isNaN(v) && v > -100) {
      const prev = p / (1 + v / 100);
      return p - prev;
    }
    return null;
  },

  _liveShowLoading(on) {
    const el = document.getElementById('liveLoading');
    if (el) el.classList.toggle('hidden', !on);
  },

  _liveShowError(msg) {
    const el = document.getElementById('liveError');
    const t = document.getElementById('liveErrorMsg');
    if (!el) return;
    if (!msg) { el.classList.add('hidden'); return; }
    if (t) t.textContent = msg;
    el.classList.remove('hidden');
  },

  _initLiveChart() {
    const L = this._live;
    if (!L || typeof LightweightCharts === 'undefined') return;
    const container = document.getElementById('liveChartCanvas');
    if (!container) return;
    if (L.chart) { try { L.chart.remove(); } catch {} L.chart = null; }
    const isDark = document.documentElement.dataset.theme === 'dark';
    const { bgColor, textColor, gridColor } = chartThemeColors();
    const chart = LightweightCharts.createChart(container, {
      width: container.clientWidth || 800,
      height: container.clientHeight || 460,
      layout: { background: { color: bgColor }, textColor, fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font').trim(), attributionLogo: false },
      localization: (typeof etTimeFormatter === 'function')
        ? { timeFormatter: etTimeFormatter }
        : undefined,
      grid: { vertLines: { color: gridColor, style: LightweightCharts.LineStyle.Dotted }, horzLines: { color: gridColor, style: LightweightCharts.LineStyle.Dotted } },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
      rightPriceScale: { borderColor: gridColor },
      timeScale: {
        borderColor: gridColor, timeVisible: true, secondsVisible: false, rightOffset: 5,
        tickMarkFormatter: (typeof etTickMarkFormatter === 'function') ? etTickMarkFormatter : undefined,
      },
    });
    const candleSeries = chart.addSeries(LightweightCharts.CandlestickSeries, {
      upColor: '#26a69a', downColor: '#ef5350', borderUpColor: '#26a69a',
      borderDownColor: '#ef5350', wickUpColor: '#26a69a', wickDownColor: '#ef5350',
    });
    candleSeries.priceScale().applyOptions({ scaleMargins: { top: 0.1, bottom: 0.2 } });
    const volumeSeries = chart.addSeries(LightweightCharts.HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: '' });
    volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });
    const ro = new ResizeObserver(() => {
      if (container.clientWidth > 0 && container.clientHeight > 0) {
        try { chart.applyOptions({ width: container.clientWidth, height: container.clientHeight }); } catch {}
      }
    });
    ro.observe(container);
    L.chart = chart; L.candleSeries = candleSeries; L.volumeSeries = volumeSeries;
    L.container = container; L._resizeObserver = ro;
  },

  /**
   * (Re)build pre/post session shading for the live chart.
   * Detach + re-attach forces a redraw (primitives have no setBands redraw).
   * Chart removal (switch/close) destroys primitives with it.
   */
  _liveUpdateShades() {
    const L = this._live;
    if (!L || !L.candleSeries || typeof SessionShadePrimitive === 'undefined') return;
    try {
      if (L.shade) { try { L.candleSeries.detachPrimitive(L.shade); } catch {} L.shade = null; }
      const times = (L.candles || []).map((c) => c.time).filter((t) => typeof t === 'number');
      if (!times.length) return;
      const isDark = document.documentElement.dataset.theme === 'dark';
      const bands = computeSessionBands(times, { includeToday: true });
      L.shade = new SessionShadePrimitive({
        bands,
        colors: sessionShadeColors(isDark),
        bars: times,
        bucketSec: (this._liveTfDef(L.interval) || {}).bucket || 900,
      });
      L.candleSeries.attachPrimitive(L.shade);
      L.shadeDayKey = (typeof etDateKey === 'function') ? etDateKey(times[times.length - 1]) : null;
      try {
        console.info('[Charts] shade: %d bands (%d pre/%d post)', bands.length,
          bands.filter((b) => b.kind !== 'post').length,
          bands.filter((b) => b.kind === 'post').length);
      } catch {}
    } catch {}
  },

  /**
   * Initial auto S/R draw for the Charts live tab (frozen-snapshot semantics).
   * PDH/PDL come from regular-session daily bars; PMH/PML (04:00-09:30 ET)
   * and ORBH/ORBL (09:30-09:45 ET) come from the seeded intraday candles.
   * Pairs whose window hasn't closed yet stay pending and finalize via
   * _liveUpdatePendingAutoSR. Ephemeral: never touches /sr/levels.
   */
  async _liveDrawAutoSR(gen) {
    const L = this._live;
    if (!L || typeof computeLiveAutoSR !== 'function') return;
    try {
      const daily = await API.get('/data/history', { ticker: L.ticker, period: '5d', interval: '1d' });
      if (this._live !== L || (gen !== undefined && L.gen !== gen)) return;
      L.autoSRDaily = (daily && daily.history) || [];
      this._liveApplyAutoSR(L);
    } catch (err) {
      // Daily fetch failed: still draw PM/ORB from intraday, PD via fallback.
      if (this._live !== L) return;
      L.autoSRDaily = null;
      try { this._liveApplyAutoSR(L); } catch (e) {}
    }
  },

  _liveApplyAutoSR(L) {
    if (!L || !L.candleSeries || typeof computeLiveAutoSR !== 'function' || typeof applyLiveAutoSR !== 'function') return;
    try {
      if (L.autoSR && L.autoSR.length) {
        try { removeLiveAutoSR(L.candleSeries, L.autoSR); } catch (e) {}
      }
      const isDark = document.documentElement.dataset.theme === 'dark';
      const result = computeLiveAutoSR(L.candles || [], L.autoSRDaily || null, null);
      L.autoSRLevels = result.levels || [];
      L.autoSR = L.autoSRHidden ? [] : applyLiveAutoSR(L.candleSeries, result.levels, isDark);
      L.autoSRPending = result.pending;
      L.autoSRDay = result.anchorDay;
      this._liveUpdateAutoSRToggle();
    } catch (e) {}
  },

  /**
   * Toggle auto S/R line visibility (eye button in the live canvas).
   * Session-scoped: hide is visual-only — developing pairs keep finalizing
   * silently so unhiding always shows current levels.
   */
  _liveToggleAutoSR() {
    const L = this._live;
    if (!L || !L.candleSeries) return;
    L.autoSRHidden = !L.autoSRHidden;
    try {
      if (L.autoSRHidden) {
        if (L.autoSR && L.autoSR.length) removeLiveAutoSR(L.candleSeries, L.autoSR);
        L.autoSR = [];
      } else {
        const isDark = document.documentElement.dataset.theme === 'dark';
        L.autoSR = applyLiveAutoSR(L.candleSeries, L.autoSRLevels || [], isDark);
      }
    } catch (e) {}
    this._liveUpdateAutoSRToggle();
  },

  /** Sync the eye button: hidden until levels exist (mirrors grid toggle). */
  _liveUpdateAutoSRToggle() {
    const L = this._live;
    const btn = document.getElementById('liveSRtoggle');
    if (!btn || !L || !L.candleSeries) return;
    btn.hidden = !(L.autoSRLevels && L.autoSRLevels.length);
    const hidden = !!L.autoSRHidden;
    btn.setAttribute('aria-pressed', String(!hidden));
    const action = hidden ? 'Show' : 'Hide';
    btn.setAttribute('aria-label', `${action} S/R lines on ${L.ticker} live chart`);
    btn.title = `${action} S/R lines`;
  },

  /**
   * Finalizer / provisional updater for pending auto S/R pairs.
   * Runs on new-bucket ticks (throttled otherwise) and after resyncs;
   * no-op once every pair is frozen. Only developing pairs are touched —
   * frozen lines are never removed or recreated.
   */
  _liveUpdatePendingAutoSR() {
    const L = this._live;
    if (!L || !L.candleSeries) return;
    if (!L.autoSRPending) return;
    if (!L.autoSRPending.premarket && !L.autoSRPending.orb) return;
    if (typeof computeLiveAutoSR !== 'function') return;
    try {
      const result = computeLiveAutoSR(L.candles || [], L.autoSRDaily || null, L.autoSRDay);
      if (L.autoSRHidden) {
        // Visual-only hide: keep tracking developing pairs silently.
        L.autoSRLevels = result.levels || [];
        L.autoSRPending = result.pending;
        this._liveUpdateAutoSRToggle();
        return;
      }
      const isDark = document.documentElement.dataset.theme === 'dark';
      const byTitle = new Map((L.autoSR || []).map((e) => [e.level && e.level.title, e]));
      for (const lv of result.levels) {
        const cur = byTitle.get(lv.title);
        if (!cur) {
          // Newly-formed pair (window had no bars at draw time).
          const added = applyLiveAutoSR(L.candleSeries, [lv], isDark);
          if (added.length) L.autoSR.push(...added);
        } else if (cur.level.provisional && Number(cur.level.price) !== Number(lv.price)) {
          try { L.candleSeries.removePriceLine(cur.handle); } catch (e) {}
          const added = applyLiveAutoSR(L.candleSeries, [lv], isDark);
          const idx = L.autoSR.indexOf(cur);
          if (added.length && idx >= 0) L.autoSR[idx] = added[0];
          else if (idx >= 0) L.autoSR.splice(idx, 1);
        } else if (cur.level.provisional && !lv.provisional) {
          cur.level.provisional = false;
        }
      }
      L.autoSRPending = result.pending;
      if (!result.pending.premarket && !result.pending.orb) {
        (L.autoSR || []).forEach((e) => { if (e && e.level) e.level.provisional = false; });
      }
    } catch (e) {}
  },

  _liveClearAutoSR(L) {
    if (!L) return;
    try {
      if (L.candleSeries && L.autoSR && L.autoSR.length) removeLiveAutoSR(L.candleSeries, L.autoSR);
    } catch (e) {}
    L.autoSR = []; L.autoSRPending = null; L.autoSRDay = null; L.autoSRDaily = null; L.autoSRThrottle = 0; L.autoSRHidden = false; L.autoSRLevels = [];
  },

  async _liveLoadHistory() {
    const L = this._live;
    if (!L) return;
    const gen = ++L.gen;
    this._liveShowLoading(true);
    this._liveShowError(null);
    this._liveSetBadge('LOADING');
    try {
      const tf = this._liveTfDef(L.interval);
      // prepost=true: live surfaces show extended-hours candles (daily callers unaffected).
      const data = await API.get('/data/history', { ticker: L.ticker, period: tf.period, interval: tf.interval, prepost: 'true' });
      if (!this._live || this._live.gen !== gen) return; // stale after ticker switch
      const history = (data && data.history) || [];
      if (!history.length) throw new Error('No data available');
      const candles = history.map(d => ({
        time: Math.floor(new Date(d.date).getTime() / 1000),
        open: d.open, high: d.high, low: d.low, close: d.close, volume: d.volume || 0,
      })).filter(c => c.close > 0 && c.time);
      candles.sort((a, b) => (a.time > b.time ? 1 : -1));
      L.candles = candles;
      if (!L.chart) this._initLiveChart();
      if (!L.candleSeries) throw new Error('Chart unavailable');
      L.candleSeries.setData(candles.map(({ volume, ...c }) => c));
      const isDark = document.documentElement.dataset.theme === 'dark';
      const vc = isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)';
      L.volumeSeries.setData(candles.map(c => ({ time: c.time, value: c.volume || 0, color: vc })));
      this._liveUpdateShades();
      this._liveDrawAutoSR(gen);
      const last = candles[candles.length - 1];
      L.lastBucket = last ? last.time : null;
      L.lastDayVolume = 0;
      L.price = last ? last.close : null;
      // Badge basis = prior regular-session close (stable across bucket/timeframe
      // changes). Falls back to bucket-vs-bucket only if quotes are unavailable.
      let seeded = false;
      try {
        const q = await API.get('/data/quotes', { tickers: L.ticker });
        if (this._live !== L) return;
        const quote = q && q.quotes && q.quotes.find((x) => x.ticker === L.ticker);
        if (quote && quote.price != null && quote.change_pct != null) {
          L.changePct = Number(quote.change_pct);
          L.changeAbs = this._liveChangeAbs(quote.price, L.changePct);
          this._liveUpdateHeader(L.changeAbs, L.changePct);
          seeded = true;
        }
      } catch {}
      if (!seeded) {
        if (candles.length >= 2) {
          const prev = candles[candles.length - 2];
          L.changeAbs = prev.close ? last.close - prev.close : 0;
          L.changePct = prev.close ? ((last.close - prev.close) / prev.close) * 100 : 0;
          this._liveUpdateHeader(L.changeAbs, L.changePct);
        } else if (last) {
          L.changeAbs = 0;
          this._liveUpdateHeader(0, 0);
        }
      }
      try { L.chart.timeScale().scrollToRealTime(); } catch {}
      this._liveShowLoading(false);
    } catch (err) {
      if (!this._live || this._live.gen !== gen) return;
      this._liveShowLoading(false);
      this._liveShowError(err.message || 'Unable to load chart data');
      this._liveSetBadge('ERROR');
    }
  },

  _liveStartStream() {
    const L = this._live;
    if (!L || L.eventSource) return;
    // Status first: CLOSED -> freeze, no socket (product decision).
    API.get('/stream/status', { ticker: L.ticker }).then(st => {
      if (!this._live || this._live !== L) return;
      const status = (st && st.status) || 'CLOSED';
      if (!st || st.is_open === false) {
        this._liveSetBadge(status || 'CLOSED');
        return; // frozen history + badge, no socket
      }
      this._liveSetBadge(status);
      try {
        const es = new EventSource('/api/stream/prices?tickers=' + encodeURIComponent(L.ticker) + '&sid=' + encodeURIComponent(L.sid || ''));
        L.eventSource = es;
        L.streamOpened = true;
        es.onmessage = (ev) => {
          try { this._liveOnStreamMsg(JSON.parse(ev.data)); } catch {}
        };
        es.onerror = () => { if (this._live === L) this._liveSetBadge('RETRY'); };
      } catch {
        this._liveSetBadge('ERROR');
      }
      // REST re-sync corrects WS drift (single ticker, cheap).
      clearInterval(L.resyncTimer);
      L.resyncTimer = setInterval(() => {
        if (this._live === L && !document.hidden && L.status !== 'PAUSED') this._liveResync();
      }, this._LIVE_RESYNC_MS);
    }).catch(() => { if (this._live === L) this._liveSetBadge('ERROR'); });
  },

  _liveOnStreamMsg(msg) {
    const L = this._live;
    if (!L) return;
    if (msg.type === 'bye') { this._livePause(true, 'max_age'); return; }
    if (msg.type === 'status') {
      if (msg.status) this._liveSetBadge(msg.status);
      const seed = msg.ticks && msg.ticks[L.ticker];
      if (seed && seed.price) this._applyLiveTick(seed);
      return;
    }
    if (msg.ticker && msg.ticker !== L.ticker) return; // stale ticker guard
    if (msg.price) this._applyLiveTick(msg);
  },

  _liveBucketFor(ts) {
    const L = this._live;
    const tf = this._liveTfDef(L.interval);
    if (!tf.bucket) return null;
    return Math.floor(ts / tf.bucket) * tf.bucket;
  },

  _applyLiveTick(tick) {
    const L = this._live;
    if (!L || !L.candleSeries || !L.candles.length) return;
    const price = Number(tick.price);
    if (!price || price <= 0) return;
    const ts = Number(tick.ts || Date.now() / 1000);
    // SSE tick carries dollar `change` + `change_pct`; derive abs if only pct present.
    let abs = tick.change != null && !isNaN(Number(tick.change)) ? Number(tick.change) : null;
    const pct = tick.change_pct != null && !isNaN(Number(tick.change_pct)) ? Number(tick.change_pct) : L.changePct;
    if (abs === null && pct !== null && pct !== undefined) abs = this._liveChangeAbs(price, pct);
    this._liveUpdateHeader(abs !== null ? abs : L.changeAbs, pct);
    if (tick.change_pct != null) L.changePct = Number(tick.change_pct);
    if (abs !== null) L.changeAbs = abs;
    L.price = price;

    const bucket = this._liveBucketFor(ts);
    let last = L.candles[L.candles.length - 1];
    const dayVol = Number(tick.volume || 0);
    const delta = L.lastDayVolume > 0 && dayVol >= L.lastDayVolume ? dayVol - L.lastDayVolume : 0;
    if (dayVol > 0) L.lastDayVolume = dayVol;
    if (L.lastBucket != null && bucket === L.lastBucket && last && typeof last.time === 'number') {
      last.close = price;
      last.high = Math.max(last.high, price);
      last.low = Math.min(last.low, price);
      last.volume = (last.volume || 0) + delta;
      try {
        L.candleSeries.update({ time: last.time, open: last.open, high: last.high, low: last.low, close: last.close });
        if (L.volumeSeries) L.volumeSeries.update({ time: last.time, value: last.volume || 0 });
      } catch {}
      // Developing auto S/R pairs track the forming window (throttled); frozen pairs untouched.
      try {
        const nowTs = Date.now();
        if (!L.autoSRThrottle || nowTs - L.autoSRThrottle > 5000) {
          L.autoSRThrottle = nowTs;
          this._liveUpdatePendingAutoSR();
        }
      } catch (e) {}
    } else {
      const candle = { time: bucket, open: price, high: price, low: price, close: price, volume: delta };
      L.candles.push(candle);
      // Keep window bounded (backend sends 5d; trim beyond 2000 buckets).
      if (L.candles.length > 2000) L.candles.splice(0, L.candles.length - 2000);
      L.lastBucket = bucket;
      // New ET day (e.g. pre-market open) needs fresh session bands.
      try {
        if (typeof etDateKey === 'function' && etDateKey(bucket) !== L.shadeDayKey) this._liveUpdateShades();
      } catch {}
      try {
        L.candleSeries.update({ time: candle.time, open: candle.open, high: candle.high, low: candle.low, close: candle.close });
        if (L.volumeSeries) L.volumeSeries.update({ time: candle.time, value: candle.volume || 0 });
      } catch {}
      L.autoSRThrottle = Date.now();
      try { this._liveUpdatePendingAutoSR(); } catch (e) {}
    }
  },

  async _liveResync() {
    const L = this._live;
    if (!L || !L.candleSeries) return;
    try {
      const tf = this._liveTfDef(L.interval);
      const data = await API.get('/data/history', { ticker: L.ticker, period: tf.period, interval: tf.interval, prepost: 'true' });
      if (!this._live || this._live !== L) return;
      const history = (data && data.history) || [];
      if (!history.length) return;
      const fresh = history.map(d => ({
        time: Math.floor(new Date(d.date).getTime() / 1000),
        open: d.open, high: d.high, low: d.low, close: d.close, volume: d.volume || 0,
      })).filter(c => c.close > 0 && c.time);
      fresh.sort((a, b) => (a.time > b.time ? 1 : -1));
      // Merge: replace by time, append new. Cheap and drift-correcting.
      const byTime = new Map(L.candles.map(c => [c.time, c]));
      for (const c of fresh) byTime.set(c.time, c);
      L.candles = [...byTime.values()].sort((a, b) => (a.time > b.time ? 1 : -1));
      if (L.candles.length > 2000) L.candles.splice(0, L.candles.length - 2000);
      const last = L.candles[L.candles.length - 1];
      if (last) L.lastBucket = last.time;
      L.candleSeries.setData(L.candles.map(({ volume, ...c }) => c));
      const isDark = document.documentElement.dataset.theme === 'dark';
      const vc = isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)';
      if (L.volumeSeries) L.volumeSeries.setData(L.candles.map(c => ({ time: c.time, value: c.volume || 0, color: vc })));
      this._liveUpdateShades();
      this._liveUpdatePendingAutoSR();
    } catch {}
  },

  _liveChangeTicker(raw) {
    const v = String(raw || '').trim().toUpperCase().replace(/[^A-Z.\-]/g, '').slice(0, 10);
    if (!v) return;
    this._liveSwitch(v, null);
  },

  _liveChangeInterval(id) {
    if (!this._LIVE_TFS().some(t => t.id === id)) return;
    this._liveSwitch(null, id);
  },

  /**
   * Single switch path for ticker and/or timeframe.
   * Uses the light connection close (section stays visible) — the previous
   * code called the full teardown which hid the section -> blank screen.
   */
  _liveSwitch(nextTicker, nextInterval) {
    const L = this._live;
    if (!L) return;
    const ticker = nextTicker || L.ticker;
    const interval = nextInterval || L.interval;
    if (ticker === L.ticker && interval === L.interval) return;
    if (L.status === 'LOADING') return; // ignore rapid clicks while seeding
    this._closeLiveConnection('tf_switch');
    this._live = { ticker, interval, chart: null, candleSeries: null, volumeSeries: null, container: null, eventSource: null, status: 'LOADING', gen: 0, candles: [], lastBucket: null, lastDayVolume: 0, idleTimer: null, resyncTimer: null, visHandler: null, actHandler: null, price: null, changeAbs: null, changePct: null, sid: this._liveNewSid(), streamOpened: false, unsubSent: false, shade: null, shadeDayKey: null, autoSR: [], autoSRPending: null, autoSRDay: null, autoSRDaily: null, autoSRThrottle: 0, autoSRHidden: false, autoSRLevels: [] };
    this._liveSavePrefs();
    this._renderLiveSection();
    this._updateChartCount();
    this._liveLoadHistory().then(() => this._liveStartStream());
    this._liveArmIdle();
    this._liveWatchVisibility();
  },

  /**
   * Light close: stop socket/timers/chart instance but KEEP the section
   * visible. Used by ticker/timeframe switches. Full hide only happens in
   * _closeLiveStream (tab leave / screen destroy).
   */
  _closeLiveConnection(reason = 'tf_switch') {
    const L = this._live;
    if (!L) return;
    try { if (L.eventSource) L.eventSource.close(); } catch {}
    this._liveSendUnsub(L, reason);
    clearTimeout(L.idleTimer);
    clearInterval(L.resyncTimer);
    if (L.visHandler) { try { document.removeEventListener('visibilitychange', L.visHandler); } catch {} }
    if (L._resizeObserver) { try { L._resizeObserver.disconnect(); } catch {} }
    try { this._liveClearAutoSR(L); } catch {}
    if (L.chart) { try { L.chart.remove(); } catch {} } // chart removal destroys attached primitives too
    L.eventSource = null; L.chart = null; L.candleSeries = null; L.volumeSeries = null;
    L.shade = null; L.shadeDayKey = null;
  },

  _livePause(showOverlay, reason = 'idle_pause') {
    const L = this._live;
    if (!L) return;
    try { if (L.eventSource) L.eventSource.close(); } catch {}
    L.eventSource = null;
    clearInterval(L.resyncTimer); L.resyncTimer = null;
    this._liveSetBadge('PAUSED');
    const ov = document.getElementById('liveResume');
    if (ov && showOverlay !== false) ov.classList.add('visible');
    this._liveSendUnsub(L, reason);
  },

  _liveResume() {
    const L = this._live;
    if (!L) return;
    const ov = document.getElementById('liveResume');
    if (ov) ov.classList.remove('visible');
    this._liveArmIdle();
    this._liveResync().finally(() => this._liveStartStream());
  },

  _liveArmIdle() {
    const L = this._live;
    if (!L) return;
    clearTimeout(L.idleTimer);
    const section = document.getElementById('liveChartSection');
    if (L.actHandler && section) {
      section.removeEventListener('pointerdown', L.actHandler);
      section.removeEventListener('wheel', L.actHandler);
    }
    // User gestures ONLY reset idle — ticks must not (else a dead phone streams forever).
    L.actHandler = () => {
      if (!this._live) return;
      clearTimeout(this._live.idleTimer);
      this._live.idleTimer = setTimeout(() => this._livePause(true, 'idle_pause'), this._LIVE_IDLE_MS);
    };
    if (section && L.actHandler) {
      section.addEventListener('pointerdown', L.actHandler);
      section.addEventListener('wheel', L.actHandler, { passive: true });
    }
    L.idleTimer = setTimeout(() => this._livePause(true, 'idle_pause'), this._LIVE_IDLE_MS);
  },

  _liveWatchVisibility() {
    const L = this._live;
    if (!L) return;
    if (L.visHandler) document.removeEventListener('visibilitychange', L.visHandler);
    L.visHandler = () => {
      if (!this._live) return;
      if (document.hidden) {
        // Background on iPhone: close socket immediately (OS would suspend anyway).
        this._livePause(false, 'visibility_hidden');
      } else if (this._live.status === 'PAUSED' && !document.getElementById('liveResume')?.classList.contains('visible')) {
        this._liveResume();
      }
    };
    document.addEventListener('visibilitychange', L.visHandler);
  },

  /**
   * Close the live socket + timers. Called on tab switch and screen destroy
   * ONLY (full hide). Ticker/timeframe switches use _closeLiveConnection.
   */
  _closeLiveStream(opts = {}) {
    const L = this._live;
    if (!L) return;
    const { destroyChart = true, reason = 'tab_switch' } = opts;
    // Connection close hints exactly once per session (unsubSent guard).
    this._closeLiveConnection(reason);
    if (destroyChart) {
      const section = document.getElementById('liveChartSection');
      if (section) { section.classList.remove('visible'); section.style.display = 'none'; }
      const grid = document.getElementById('chartGrid');
      if (grid) grid.style.display = '';
    }
    // Keep _live.ticker/interval for count display; drop connection handles.
    if (this._live === L && destroyChart) {
      this._live = { ticker: L.ticker, interval: L.interval, chart: null, candleSeries: null, volumeSeries: null, container: null, eventSource: null, status: 'CLOSED', gen: (L.gen || 0) + 1, candles: [], lastBucket: null, lastDayVolume: 0, idleTimer: null, resyncTimer: null, visHandler: null, actHandler: null, price: null, changeAbs: null, changePct: null, autoSR: [], autoSRPending: null, autoSRDay: null, autoSRDaily: null, autoSRThrottle: 0, autoSRHidden: false, autoSRLevels: [] };
    }
  },

  // ─── APP THEME SYNC ────────────────────────────────────

  /**
   * Re-apply the current app theme (from document.documentElement.dataset.theme)
   * to all chart instances. Called automatically when the app theme changes.
   */
  _applyAppThemeToCharts() {
    const isDark = document.documentElement.dataset.theme === 'dark';
    const { bgColor, textColor, gridColor } = chartThemeColors();

    Object.keys(this.charts).forEach((ticker) => {
      const state = this.charts[ticker];
      if (state && state.chart) {
        try {
          state.chart.applyOptions({
            layout: { background: { color: bgColor }, textColor },
            grid: { vertLines: { color: gridColor, style: LightweightCharts.LineStyle.Dotted }, horzLines: { color: gridColor, style: LightweightCharts.LineStyle.Dotted } },
            rightPriceScale: { borderColor: gridColor },
            timeScale: { borderColor: gridColor },
          });
        } catch {}
      }
      // Update SMA series color for theme
      if (state && state.smaSeries) {
        try {
          state.smaSeries.applyOptions({
            color: isDark ? '#FF9800' : '#E65100',
          });
        } catch {}
      }
      if (state?.patternSeries) {
        state.patternSeries.forEach(series => {
          try { series.applyOptions({ color: isDark ? '#83B8EF' : '#2764A2' }); } catch {}
        });
      }
      if (state?.avgLine) {
        state.avgLine.applyOptions({ color: isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)' });
      }
      // Update volume histogram colors for theme
      if (state && state.volumeSeries) {
        try {
          const rawBars = this._barCache[ticker];
          if (rawBars && rawBars.length > 0) {
            const volData = rawBars.filter(c => /^\d{4}-\d{2}-\d{2}$/.test(c.date)).map(c => ({
              time: c.date,
              value: c.volume ?? 0,
              color: isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)',
            }));
            state.volumeSeries.setData(volData);
          }
        } catch {}
      }
      // Update candlestick series colors for theme
      if (state && state.candleSeries) {
        try {
          state.candleSeries.applyOptions({
            upColor: '#26a69a',
            downColor: '#ef5350',
            borderUpColor: '#26a69a',
            borderDownColor: '#ef5350',
            wickUpColor: '#26a69a',
            wickDownColor: '#ef5350',
          });
        } catch {}
      }
      // Hover highlight follows theme (band alpha + ring contrast)
      if (state && state.hoverPrimitive && typeof hoverHighlightColors === 'function') {
        try { state.hoverPrimitive.setColors(hoverHighlightColors(isDark)); } catch {}
      }
    });

    // Re-render S/R lines with new theme colors
    Object.keys(this.charts).forEach((ticker) => {
      this._renderSRLines(ticker);
    });

    // Live tab: recolor session shading for the new theme
    try { this._liveUpdateShades(); } catch {}

    // Re-apply markers with new theme colors (earnings + transactions)
    Object.keys(this.charts).forEach((ticker) => {
      if (this._transactionsCache[ticker] || this._earningsDates[ticker]) {
        const state = this.charts[ticker];
        const rawBars = this._barCache[ticker];
        if (state && rawBars) {
          const candles = rawBars.filter(c => /^\d{4}-\d{2}-\d{2}$/.test(c.date)).map(c => ({
            ...c,
            time: c.date,
          }));
          this._applyAllMarkers(ticker, state, candles);
        }
      }
    });

    // Live standalone chart follows theme too (minimal: layout + grid only)
    try {
      const L = this._live;
      if (L && L.chart) {
        L.chart.applyOptions({
          layout: { background: { color: bgColor }, textColor },
          grid: { vertLines: { color: gridColor, style: LightweightCharts.LineStyle.Dotted }, horzLines: { color: gridColor, style: LightweightCharts.LineStyle.Dotted } },
          rightPriceScale: { borderColor: gridColor },
          timeScale: { borderColor: gridColor },
        });
      }
    } catch {}
  },
};

// ES module export for app.js dynamic import
export default Charts;

// CommonJS fallback (for Node/testing)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = Charts;
}
