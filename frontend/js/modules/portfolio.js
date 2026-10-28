/**
 * Portfolio — Portfolio management screen module.
 *
 * Manages multiple portfolios, their positions, and P&L tracking.
 * Implements: portfolio tabs, stats bar, trade form, positions table,
 * sortable columns, add/edit/delete/move position modals, donut chart,
 * sector allocation panel, and dark mode support.
 *
 * API endpoints:
 *   GET    /api/portfolio                    — list portfolios
 *   POST   /api/portfolio                    — create portfolio
 *   DELETE /api/portfolio/:id                — delete portfolio
 *   GET    /api/portfolio/:id/positions      — list positions
 *   POST   /api/portfolio/:id/positions      — add position
 *   DELETE /api/portfolio/:id/positions/:pid — delete position
 *   POST   /api/portfolio/positions/move     — move positions
 *
 * @example
 *   // Called by App.loadScreen('portfolio')
 *   Portfolio.init();
 */

import TickerMetadata from '../ticker-metadata.js';
import ChartModal from '../components/chart-modal.js';
import MarketTicker from '../components/market-ticker.js';
import { ensureLightCharts, escapeHtml } from '../components/chart-utils.js';

/* ─── CONSTANTS ─── */
const SECTOR_COLORS = Array.from({ length: 8 }, (_, i) => `var(--color-allocation-${i + 1})`);

const Portfolio = {
  /** @type {Array<Object>} List of portfolios */
  portfolios: [],

  /** @type {number|null} Active portfolio ID */
  activePortfolioId: null,

  /** @type {Array<Object>} Current positions (active portfolio only) */
  positions: [],

  /** @type {Array<Object>} Positions across ALL portfolios (for aggregate summary) */
  allPositions: [],

  /** Ignore cash refresh responses that predate a trade or manual edit. */
  _cashVersion: 0,

  /** @type {boolean} */
  loading: false,

  /** @type {string|null} Current sort column */
  sortColumn: 'ticker',

  /** @type {'asc'|'desc'} Current sort direction */
  sortDirection: 'asc',

  /** @type {Set<number>} Selected position IDs */
  selectedPositions: new Set(),

  /** @type {Object<number, boolean>} Session preferences when storage is unavailable */
  _hideFreeOverrides: {},

  /** @type {Object} Cache for validated tickers: { [ticker]: { valid, company, sector } } */
  tickerValidationCache: {},

  /** @type {number|null} USD-to-CAD conversion rate (fetched from /cad-rate) */
  cadRate: null,

  /** @type {number|null} CAD-to-USD display rate (inverse of cadRate) */
  cadUsdRate: null,

  /** @type {number|null} CAD/USD daily percentage change */
  cadUsdChange: null,

  /** @type {Object} Earnings dates cache: { [ticker]: "Jul 25" } */
  _earningsDates: {},

  /** @type {Function|null} Stored document click handler ref for cleanup */
  _docClickHandler: null,

  /** @type {Function|null} Stored document keydown handler ref for cleanup */
  _docKeyHandler: null,

  /** @type {MutationObserver|null} Observer for data-theme attribute changes */
  _themeObserver: null,

  /** @type {Array|null} Cached P/L history snapshots for theme re-renders */
  _currentPnlData: null,

  /** @type {string|null} Cached P/L history currency for theme re-renders */
  _currentPnlCurrency: null,

  /** @type {object|null} LightweightCharts instance for P/L history panel */
  _pnlChartInstance: null,

  /** @type {object|null} LightweightCharts line series for P/L history panel */
  _pnlLineSeries: null,

  // ─── INITIALIZATION ──────────────────────────────────

  /**
   * Initialize the Portfolio screen.
   */
  async init() {
    console.log('[Portfolio] initialized');
    this.bindEvents();
    this._setTradeDateToToday();
    this._themeObserver = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.attributeName === 'data-theme') {
          if (this._currentPnlData) this._renderPnlChart(this._currentPnlData, this._currentPnlCurrency);
          break;
        }
      }
    });
    this._themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    this._marketTicker = new MarketTicker(document.getElementById('portfolio-market-ticker'));
    this._marketTicker.init();
    await this._loadCadRate();
    await this.loadPortfolios();
  },

  /**
   * Destroy the Portfolio module — clean up event listeners.
   * Called by App.loadScreen() before loading a different screen.
   */
  destroy() {
    ChartModal.close();
    this._marketTicker?.destroy();
    this._marketTicker = null;
    if (this._themeObserver) {
      this._themeObserver.disconnect();
      this._themeObserver = null;
    }

    // Remove document-level event listeners
    if (this._docClickHandler) {
      document.removeEventListener('click', this._docClickHandler);
      this._docClickHandler = null;
    }
    if (this._docKeyHandler) {
      document.removeEventListener('keydown', this._docKeyHandler);
      this._docKeyHandler = null;
    }

    // Clean up P/L chart
    if (this._pnlChartInstance) {
      try { this._pnlChartInstance.remove(); } catch {}
      this._pnlChartInstance = null;
      this._pnlLineSeries = null;
    }
    this._currentPnlData = null;
    this._currentPnlCurrency = null;

  },

  /**
   * Fetch USD-to-CAD conversion rate from the API.
   * Shows a warning banner if the rate cannot be fetched.
   */
  async _loadCadRate() {
    try {
      const data = await API.get('/cad-rate');
      if (data && data.rate) {
        this.cadRate = data.rate;
        this.cadUsdRate = data.cadusd || Math.round(1.0 / data.rate * 10000) / 10000;
        this.cadUsdChange = data.change_pct ?? null;
        this._hideCadRateWarning();
      } else {
        throw new Error('Invalid rate data');
      }
    } catch (e) {
      console.warn('[Portfolio] Failed to load CAD rate:', e.message);
      this.cadRate = null;
      this.cadUsdRate = null;
      this._showCadRateWarning();
    }
  },

  /**
   * Fetch next earnings dates for all current positions.
   * Populates _earningsDates map: { ticker: "Mon DD" }.
   * Called after loading positions; errors are silently ignored.
   */
  async _fetchEarningsDates() {
    if (!this.positions || this.positions.length === 0) return;

    const tickers = this.positions.filter(p => p.sector !== 'ETF').map(p => p.ticker).filter(Boolean).join(',');
    if (!tickers) return;

    try {
      const dates = await API.get('/earnings/dates', { tickers });
      this._earningsDates = dates || {};
    } catch (err) {
      console.info('[Portfolio] Failed to fetch earnings dates:', err.message);
      this._earningsDates = {};
    }
  },

  // ─── EVENT BINDING ───────────────────────────────────

  /**
   * Bind all screen-specific event listeners.
   */
  bindEvents() {
    try {
    // Mobile portfolio dropdown — custom trigger
    const portfolioDropdown = document.getElementById('portfolio-tabs-dropdown');
    if (portfolioDropdown) {
      portfolioDropdown.addEventListener('click', (e) => {
        e.stopPropagation();
        this._togglePortfolioDropdown();
      });
      portfolioDropdown.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this._togglePortfolioDropdown();
        } else if (e.key === 'Escape') {
          this._closePortfolioDropdown();
        }
      });
    }

    // New portfolio dropdown toggle
    const addBtn = document.getElementById('add-portfolio-btn');
    if (addBtn) {
      addBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const dropdown = document.getElementById('new-portfolio-dropdown');
        const isOpen = dropdown.classList.toggle('open');
        addBtn.setAttribute('aria-expanded', String(isOpen));
      });
    }

    // Manage order button (desktop, next to New Portfolio)
    const reorderBtn = document.getElementById('reorder-portfolios-btn');
    if (reorderBtn && !reorderBtn._hasReorderHandler) {
      reorderBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._closeDropdown();
        this._openReorderModal();
      });
      reorderBtn._hasReorderHandler = true;
    }

    // Currency option selection — use event delegation on the dropdown
    // so handlers work even if the template loads after bindEvents()
    const dropdown = document.getElementById('new-portfolio-dropdown');
    if (dropdown) {
      dropdown.addEventListener('click', (e) => {
        const opt = e.target.closest('.currency-option');
        if (opt) {
          const currency = opt.dataset.currency;
          if (currency) {
            this.handleCreatePortfolio(currency);
            this._closeDropdown();
          }
        }
      });
    }

    // Close dropdown on outside click
    this._docClickHandler = (e) => {
      if (!e.target.closest('.portfolio-add-wrapper')) {
        this._closeDropdown();
      }
      if (!e.target.closest('#portfolio-tabs-dropdown') && !e.target.closest('#portfolio-dropdown-menu')) {
        this._closePortfolioDropdown();
      }
    };
    document.addEventListener('click', this._docClickHandler);

    // Trade form submission (BUY)
    const tradeForm = document.getElementById('trade-form');
    if (tradeForm) {
      tradeForm.addEventListener('submit', (e) => {
        e.preventDefault();
        this.handleBuyFromTradeForm();
      });
    }

    // SELL button
    const sellBtn = document.getElementById('trade-sell-btn');
    if (sellBtn) {
      sellBtn.addEventListener('click', () => this.handleSellFromTradeForm());
    }

    // Ticker validation in trade form
    const tickerInput = document.getElementById('trade-ticker');
    if (tickerInput) {
      tickerInput.addEventListener('input', (e) => {
        // Auto-uppercase and clear validation (EXACT reference behavior)
        e.target.value = e.target.value.toUpperCase();
        clearTimeout(this._tickerValidationTimeout);
        const status = document.getElementById('trade-ticker-validation');
        const info = document.getElementById('trade-ticker-info');
        if (status) { status.textContent = ''; status.className = 'ticker-validation'; }
        if (info) { info.textContent = ''; }
      });
      tickerInput.addEventListener('blur', () => this._validateTickerOnBlur());
    }

    // Select all checkbox
    const selectAll = document.getElementById('select-all');
    if (selectAll) {
      selectAll.addEventListener('change', () => this._toggleSelectAll(selectAll.checked));
    }

    const hideFreeBtn = document.getElementById('hide-free-btn');
    if (hideFreeBtn) {
      hideFreeBtn.addEventListener('click', () => {
        if (this.activePortfolioId == null) return;
        const hide = !this._hideFreePositions();
        this._hideFreeOverrides[this.activePortfolioId] = hide;
        try { localStorage.setItem(`portfolio-hide-free-${this.activePortfolioId}`, hide ? '1' : '0'); } catch {}
        this.selectedPositions.clear();
        this._renderPositions();
      });
    }

    document.getElementById('cash-edit-btn')?.addEventListener('click', () => this._openCashEditor());
    document.getElementById('cash-cancel-btn')?.addEventListener('click', () => this._closeCashEditor());
    document.getElementById('cash-editor')?.addEventListener('submit', (event) => {
      event.preventDefault();
      this._saveCash();
    });
    document.getElementById('cash-input')?.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        this._closeCashEditor();
      }
    });
    document.getElementById('cash-input')?.addEventListener('input', (event) => {
      event.target.setCustomValidity('');
    });

    // Move button
    const moveBtn = document.getElementById('move-btn');
    if (moveBtn) {
      moveBtn.addEventListener('click', () => this._openMoveModal());
    }

    // Delete positions button
    const deleteBtn = document.getElementById('delete-positions-btn');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', () => this._deleteSelectedPositions());
    }

    // Refresh button
    const refreshBtn = document.getElementById('refresh-btn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => this.refresh());
    }

    // Delete portfolio button
    const deletePortfolioBtn = document.getElementById('delete-portfolio-btn');
    if (deletePortfolioBtn) {
      deletePortfolioBtn.addEventListener('click', () => this._openDeleteModal());
    }

    // Retry button
    const retryBtn = document.getElementById('retry-btn');
    if (retryBtn) {
      retryBtn.addEventListener('click', () => this.loadPortfolios());
    }

    // P/L History retry button
    const pnlRetryBtn = document.getElementById('pnl-retry-btn');
    if (pnlRetryBtn) {
      pnlRetryBtn.addEventListener('click', () => {
        if (this.activePortfolioId) {
          this._loadPnlHistory(this.activePortfolioId);
        }
      });
    }

    // Sortable table headers
    document.querySelectorAll('.positions-table thead th.sortable').forEach((th) => {
      th.addEventListener('click', () => this._handleSort(th.dataset.sort));
      th.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this._handleSort(th.dataset.sort);
        }
      });
    });

    // Position modal
    this._bindModalEvents();

    // Sector panel toggle
    const sectorToggle = document.getElementById('sector-toggle');
    if (sectorToggle) {
      sectorToggle.addEventListener('click', () => this._toggleSectorPanel());
      sectorToggle.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this._toggleSectorPanel();
        }
      });
    }

    // Escape key closes modals
    this._docKeyHandler = (e) => {
      if (e.key === 'Escape') {
        this._closeAllModals();
      }
    };
    document.addEventListener('keydown', this._docKeyHandler);

    // Empty state create button — create a USD portfolio directly
    const emptyCreateBtn = document.getElementById('empty-create-btn');
    if (emptyCreateBtn) {
      emptyCreateBtn.addEventListener('click', () => {
        this.handleCreatePortfolio('USD');
      });
    }

    // Inline empty state create button (Issue 1)
    const inlineCreateBtn = document.getElementById('inline-create-btn');
    if (inlineCreateBtn) {
      inlineCreateBtn.addEventListener('click', () => {
        this.handleCreatePortfolio('USD');
      });
    }

    // Row click opens chart modal — delegated on tbody, registered once at init.
    // Skips clicks on the checkbox and notes cell (those are bound per-element in _renderPositions).
    const positionsTbody = document.getElementById('positions-tbody');
    if (positionsTbody) {
      positionsTbody.addEventListener('click', (e) => {
        console.debug('[Portfolio] positions-tbody click target:', e.target.className, e.target.closest('tr'));
        if (e.target.closest('.row-checkbox') || e.target.closest('.notes-cell')) return;
        const row = e.target.closest('tr');
        if (!row) return;
        const link = row.querySelector('.ticker-symbol-link');
        if (link) {
          e.preventDefault();
          const ticker = link.dataset.ticker;
          if (ticker) {
            const portfolio = this.portfolios.find(p => p.id === this.activePortfolioId);
            const position = this.positions.find(p => p.ticker === ticker);
            ChartModal.open(ticker, position?.company || '', {
              trigger: link,
              holding: position && portfolio ? {
                portfolioId: portfolio.id, name: portfolio.name, currency: portfolio.currency,
                position: { ...position },
              } : null,
            });
          }
        }
      });
    }
    } catch (err) {
      console.error('[Portfolio] bindEvents() failed:', err);
    }
  },

  // ─── DATA LOADING ────────────────────────────────────

  /**
   * Load all portfolios from API. Shows error on failure.
   */
  async loadPortfolios() {
    this.loading = true;
    this._showSkeleton();

    try {
      this.portfolios = await API.get('/portfolio');
    } catch (err) {
      console.error('[Portfolio] Failed to load portfolios:', err.message);
      this._hideSkeleton();
      this._showInlineError('portfolio-tabs-scroll', 'Failed to load portfolios. Please check your connection and try again.', () => this.loadPortfolios());
      this.loading = false;
      return;
    }

    this._hideSkeleton();

    // Build aggregate positions list from all portfolios (for summary cards)
    this._buildAllPositions();
    TickerMetadata.seed(this.allPositions);

    this._renderTabs();

    if (this.portfolios.length > 0) {
      // Preserve the active portfolio across reloads (e.g. after saving a
      // custom order or renaming). Fall back to the first in custom order.
      const stillExists = this.portfolios.some((p) => p.id === this.activePortfolioId);
      const targetId = stillExists ? this.activePortfolioId : this.portfolios[0].id;
      this._hideEmptyState();
      await this.selectPortfolio(targetId);
    } else {
      this._showEmptyState();
    }

    this.loading = false;
  },

  /**
   * Load positions for a specific portfolio. Shows error on failure.
   * @param {number} portfolioId
   */
  async loadPositions(portfolioId) {
    try {
      const result = await API.get(`/portfolio/${portfolioId}/positions`);
      this.positions = Array.isArray(result) ? result : [];
      TickerMetadata.seed(this.positions);
    } catch (err) {
      console.error('[Portfolio] Failed to load positions:', err.message);
      this.positions = [];
      this._showInlineError('positions-tbody', 'Failed to load positions. Please try again.', () => this.loadPositions(portfolioId));
      return;
    }

    // Normalize positions: ensure all required fields have safe defaults.
    // If last_price is missing (quote failed), current_price stays null
    // so the UI can show "N/A" instead of misleading cost-basis numbers.
    this.positions = this.positions.map((p) => ({
      ...p,
      qty: p.qty ?? 0,
      avg_price: p.avg_price ?? 0,
      total_investment: p.total_investment ?? 0,
      current_price: p.current_price ?? p.last_price ?? null,
      change_pct: p.change_pct ?? null,
      company: p.company ?? '',
      sector: p.sector || (p.company && /ETF|Fund/i.test(p.company) ? 'ETF' : 'Other'),
      notes: p.notes ?? '',
      sparkline: p.sparkline ?? [],
    }));

    this.selectedPositions.clear();
    this.sortColumn = 'ticker';
    this.sortDirection = 'asc';
    this._renderPositions();
    this._updateStatsBar();

    // Sync the loaded positions back into this.portfolios so allPositions
    // stays accurate for aggregate summary card calculations
    this._syncPortfolioPositions(portfolioId, this.positions);
    this._updateSummaryCards();

    this._updateDonutChart();
    this._updateSectorPanel();
    this._updateSelectionUI();

    // Load P/L history (non-blocking — handles its own loading/empty/error states)
    this._loadPnlHistory(portfolioId);

    // Fetch earnings dates for all positions (await so we can re-render with data)
    await this._fetchEarningsDates();
    if (this._earningsDates && Object.keys(this._earningsDates).length > 0) {
      this._renderPositions();
    }
  },

  // ─── USER ACTIONS ────────────────────────────────────

  /**
   * Select a portfolio and load its positions.
   * @param {number} portfolioId
   */
  async selectPortfolio(portfolioId) {
    this._closeCashEditor();
    this.activePortfolioId = portfolioId;
    this._renderCash();

    // Update tab active state
    document.querySelectorAll('.portfolio-tab-group').forEach((tab) => {
      const isActive = Number(tab.dataset.portfolioId) === portfolioId;
      tab.setAttribute('aria-selected', String(isActive));
    });

    // Sync mobile dropdown
    this._syncDropdownToActivePortfolio();

    await Promise.all([this.loadPositions(portfolioId), this._loadCash(portfolioId)]);
  },

  _renderCash() {
    const value = document.getElementById('cash-value');
    if (!value) return;
    const portfolio = this.portfolios.find((p) => p.id === this.activePortfolioId);
    document.querySelector('.cash-tracker').hidden = !portfolio;
    const cents = portfolio?.cash_cents ?? 0;
    value.textContent = `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const editBtn = document.getElementById('cash-edit-btn');
    if (editBtn) editBtn.disabled = !portfolio;
  },

  _applyCash(portfolioId, cashCents) {
    const portfolio = this.portfolios.find((p) => p.id === portfolioId);
    if (!portfolio || !Number.isSafeInteger(cashCents) || cashCents < 0) return;
    portfolio.cash_cents = cashCents;
    if (this.activePortfolioId === portfolioId) this._renderCash();
  },

  async _loadCash(portfolioId) {
    const version = this._cashVersion;
    try {
      const result = await API.get(`/portfolio/${portfolioId}/cash`);
      if (version === this._cashVersion) this._applyCash(portfolioId, result.cash_cents);
    } catch (err) {
      console.warn('[Portfolio] Failed to refresh cash:', err.message);
    }
  },

  _openCashEditor() {
    const portfolio = this.portfolios.find((p) => p.id === this.activePortfolioId);
    const editor = document.getElementById('cash-editor');
    const input = document.getElementById('cash-input');
    if (!portfolio || !editor || !input) return;
    input.value = ((portfolio.cash_cents ?? 0) / 100).toFixed(2);
    input.setCustomValidity('');
    document.getElementById('cash-display').hidden = true;
    editor.hidden = false;
    input.focus();
    input.select();
  },

  _closeCashEditor() {
    const editor = document.getElementById('cash-editor');
    if (editor) editor.hidden = true;
    const display = document.getElementById('cash-display');
    if (display) display.hidden = false;
    document.getElementById('cash-input')?.setCustomValidity('');
  },

  async _saveCash() {
    const portfolioId = this.activePortfolioId;
    const input = document.getElementById('cash-input');
    const editor = document.getElementById('cash-editor');
    if (portfolioId == null || !input || !editor) return;
    const raw = input.value.trim();
    const cashCents = Math.round(Number(raw) * 100);
    if (!/^\d+(\.\d{1,2})?$/.test(raw) || !Number.isSafeInteger(cashCents)
        || cashCents > 9_000_000_000_000_000) {
      input.setCustomValidity('Enter a non-negative amount with up to two decimal places.');
      input.reportValidity();
      return;
    }

    this._cashVersion++;
    editor.querySelectorAll('input, button').forEach((element) => { element.disabled = true; });
    try {
      const result = await API.put(`/portfolio/${portfolioId}/cash`, { cash_cents: cashCents });
      this._applyCash(portfolioId, result.cash_cents);
      if (this.activePortfolioId === portfolioId) this._closeCashEditor();
    } catch (err) {
      this._showError(err.message);
    } finally {
      editor.querySelectorAll('input, button').forEach((element) => { element.disabled = false; });
    }
  },

  /**
   * Handle creating a new portfolio.
   * @param {string} currency - 'USD' or 'CAD'
   */
  async handleCreatePortfolio(currency) {
    const name = this.portfolios.length === 0 ? 'Default' : `Portfolio ${this.portfolios.length + 1}`;

    try {
      // New portfolios append at the end of the custom order (backend
      // assigns MAX(sort_order)+1). Select the new row directly so the
      // active tab doesn't jump to the top of the list.
      const created = await API.post('/portfolio', { name, currency });
      await this.loadPortfolios();
      if (created && created.id) {
        await this.selectPortfolio(created.id);
      }
    } catch (err) {
      this._showError(err.message);
    }
  },

  /**
   * Handle BUY from the trade form — uses the /positions/buy endpoint
   * which handles weighted-average pricing for existing positions.
   */
  async handleBuyFromTradeForm() {
    if (!this.activePortfolioId) return;

    const tickerInput = document.getElementById('trade-ticker');
    const qtyInput = document.getElementById('trade-qty');
    const priceInput = document.getElementById('trade-price');
    const notesInput = document.getElementById('trade-notes');

    const ticker = tickerInput ? tickerInput.value.trim().toUpperCase() : '';
    const qty = qtyInput ? Number(qtyInput.value) : 0;
    const price = priceInput ? Number(priceInput.value) : 0;
    const notes = notesInput ? notesInput.value.trim() : '';

    if (!ticker || qty <= 0 || price <= 0) return;
    const date = this._getTradeFormDate();
    if (!date) return;

    try {
      const result = await API.post(`/portfolio/${this.activePortfolioId}/positions/buy`, {
        ticker,
        qty,
        price,
        date,
        notes
      });
      this._cashVersion++;
      this._applyCash(this.activePortfolioId, result.cash_cents);
      await this.loadPositions(this.activePortfolioId);

      // Clear form
      this._clearTradeForm();
    } catch (err) {
      this._showError(err.message);
    }
  },

  /**
   * Handle SELL from the trade form — uses the /positions/sell endpoint
   * which reduces or closes an existing position.
   */
  async handleSellFromTradeForm() {
    if (!this.activePortfolioId) return;

    const tickerInput = document.getElementById('trade-ticker');
    const qtyInput = document.getElementById('trade-qty');
    const priceInput = document.getElementById('trade-price');
    const notesInput = document.getElementById('trade-notes');

    const ticker = tickerInput ? tickerInput.value.trim().toUpperCase() : '';
    const qty = qtyInput ? Number(qtyInput.value) : 0;
    const price = priceInput ? Number(priceInput.value) : 0;
    const notes = notesInput ? notesInput.value.trim() : '';

    if (!ticker || qty <= 0 || price <= 0) return;
    const date = this._getTradeFormDate();
    if (!date) return;

    try {
      const result = await API.post(`/portfolio/${this.activePortfolioId}/positions/sell`, {
        ticker,
        qty,
        price,
        date,
        notes
      });
      this._cashVersion++;
      this._applyCash(this.activePortfolioId, result.cash_cents);
      await this.loadPositions(this.activePortfolioId);

      // Clear form
      this._clearTradeForm();
    } catch (err) {
      this._showError(err.message);
    }
  },

  /**
   * Clear all trade form fields and validation state.
   */
  _clearTradeForm() {
    const tickerInput = document.getElementById('trade-ticker');
    const qtyInput = document.getElementById('trade-qty');
    const priceInput = document.getElementById('trade-price');
    const notesInput = document.getElementById('trade-notes');
    if (tickerInput) tickerInput.value = '';
    if (qtyInput) qtyInput.value = '';
    if (priceInput) priceInput.value = '';
    if (notesInput) notesInput.value = '';
    this._setTradeDateToToday();
    // Clear ticker validation state
    const status = document.getElementById('trade-ticker-validation');
    const info = document.getElementById('trade-ticker-info');
    if (status) { status.textContent = ''; status.className = 'ticker-validation'; }
    if (info) { info.textContent = ''; }
  },

  _setTradeDateToToday() {
    const input = document.getElementById('trade-date');
    if (!input) return;
    const now = new Date();
    input.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  },

  _getTradeFormDate() {
    const input = document.getElementById('trade-date');
    if (!input?.value || !input.checkValidity()) {
      input?.reportValidity();
      return null;
    }
    return input.value;
  },

  /**
   * Refresh current portfolio data — re-fetches prices, earnings dates,
   * and re-renders all UI components.  Shows a loading indicator on the
   * refresh button while the operation is in progress.
   *
   * Note: loadPositions() already awaits _fetchEarningsDates() internally,
   * so the earnings data is available after loadPositions() resolves.
   */
  async refresh() {
    if (!this.activePortfolioId) return;

    const refreshBtn = document.getElementById('refresh-btn');
    if (refreshBtn) {
      refreshBtn.disabled = true;
      refreshBtn.innerHTML = `<svg viewBox="0 0 14 14" fill="none" aria-hidden="true" style="animation:spin 1s linear infinite"><path d="M12 7a5 5 0 11-1.8-3.8M12 2v3h-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg> Refreshing…`;
    }

    try {
      // loadPositions() now awaits earnings dates internally
      await Promise.all([this.loadPositions(this.activePortfolioId), this._loadCash(this.activePortfolioId)]);
    } catch (err) {
      console.error('[Portfolio] Refresh failed:', err);
    } finally {
      if (refreshBtn) {
        refreshBtn.disabled = false;
        refreshBtn.innerHTML = `<svg viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M12 7a5 5 0 11-1.8-3.8M12 2v3h-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg> Refresh`;
      }
    }
  },

  // ─── RENDERING: TABS ─────────────────────────────────

  /**
   * Render portfolio tabs and mobile dropdown.
   */
  _renderTabs() {
    const container = document.getElementById('portfolio-tabs-scroll');
    if (!container) return;

    if (this.portfolios.length === 0) {
      container.innerHTML = '';
      this._renderMobileDropdown();
      return;
    }

    container.innerHTML = this.portfolios
      .map(
        (p) => `
      <div class="portfolio-tab-group" role="tab" tabindex="0"
           aria-selected="${p.id === this.activePortfolioId}"
           data-portfolio-id="${p.id}"
           aria-label="Portfolio: ${p.name} (${p.currency})">
        <span class="tab-drag" aria-hidden="true">&#x2801;</span>
        ${this._escapeHtml(p.name)}
        <span class="tab-currency">${p.currency}</span>
        <button class="tab-edit" title="Rename ${this._escapeHtml(p.name)}" aria-label="Rename ${this._escapeHtml(p.name)}">
          <svg viewBox="0 0 12 12" fill="none"><path d="M8.5 1.5l2 2M1 8l5-5 2 2-5 5H1V8z" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
    `
      )
      .join('');

    // Bind tab click events
    container.querySelectorAll('.portfolio-tab-group').forEach((tab) => {
      tab.addEventListener('click', (e) => {
        if (e.target.closest('.tab-edit')) return;
        this.selectPortfolio(Number(tab.dataset.portfolioId));
      });
      tab.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this.selectPortfolio(Number(tab.dataset.portfolioId));
        }
      });
    });

    // Bind edit buttons
    container.querySelectorAll('.tab-edit').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const tab = btn.closest('.portfolio-tab-group');
        const id = Number(tab.dataset.portfolioId);
        this._handleRenamePortfolio(id);
      });
    });

    // Render mobile dropdown
    this._renderMobileDropdown();
    this._syncReorderButton();
  },

  /**
   * Render the mobile portfolio dropdown (custom).
   * Populates #portfolio-dropdown-menu with portfolio option buttons
   * and a "+ New Portfolio" option at the bottom.
   */
  _renderMobileDropdown() {
    const menu = document.getElementById('portfolio-dropdown-menu');
    if (!menu) return;

    menu.innerHTML = '';

    // Add portfolio options
    this.portfolios.forEach((p) => {
      const btn = document.createElement('button');
      btn.className = 'portfolio-dropdown-option' + (p.id === this.activePortfolioId ? ' active' : '');
      btn.role = 'option';
      btn.dataset.id = String(p.id);
      btn.setAttribute('aria-selected', p.id === this.activePortfolioId ? 'true' : 'false');
      btn.innerHTML = `<span class="option-name">${this._escapeHtml(p.name)}</span><span class="option-currency">${p.currency}</span>`;
      btn.addEventListener('click', () => {
        if (p.id !== this.activePortfolioId) {
          this.selectPortfolio(p.id);
        }
        this._closePortfolioDropdown();
      });
      menu.appendChild(btn);
    });

    // Footer actions, visually separated from the selectable portfolio
    // options: Manage order + New Portfolio (with inline currency choice so
    // it works on mobile, where the desktop currency popup is hidden).
    const footer = document.createElement('div');
    footer.className = 'portfolio-dropdown-footer';
    footer.setAttribute('role', 'group');
    footer.setAttribute('aria-label', 'Portfolio actions');

    if (this.portfolios.length > 0) {
      const divider = document.createElement('div');
      divider.className = 'portfolio-dropdown-divider';
      divider.setAttribute('aria-hidden', 'true');
      menu.appendChild(divider);
    }

    if (this.portfolios.length > 1) {
      const manageBtn = document.createElement('button');
      manageBtn.type = 'button';
      manageBtn.className = 'portfolio-dropdown-action manage-order';
      manageBtn.innerHTML = `<svg viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M2 4h10M2 7h10M2 10h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg><span>Manage order…</span>`;
      manageBtn.addEventListener('click', () => {
        this._closePortfolioDropdown();
        this._openReorderModal();
      });
      footer.appendChild(manageBtn);
    }

    const newBtn = document.createElement('button');
    newBtn.type = 'button';
    newBtn.className = 'portfolio-dropdown-action new-portfolio-action';
    newBtn.setAttribute('aria-expanded', 'false');
    newBtn.innerHTML = `<svg viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M7 2v10M2 7h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg><span>+ New Portfolio</span><svg class="expand-chevron" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M3 5l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

    const submenu = document.createElement('div');
    submenu.className = 'portfolio-dropdown-submenu';
    const currencies = [
      { code: 'USD', flag: '&#x1F1FA;&#x1F1F8;', label: 'USD Portfolio', desc: 'United States Dollar' },
      { code: 'CAD', flag: '&#x1F1E8;&#x1F1E6;', label: 'CAD Portfolio', desc: 'Canadian Dollar' },
    ];
    currencies.forEach(({ code, flag, label, desc }) => {
      const opt = document.createElement('button');
      opt.type = 'button';
      opt.className = 'currency-option';
      opt.dataset.currency = code;
      opt.innerHTML = `<span class="flag" aria-hidden="true">${flag}</span><span class="currency-option-info"><span class="label">${label}</span><span class="desc">${desc}</span></span>`;
      opt.addEventListener('click', () => {
        this._closePortfolioDropdown();
        this.handleCreatePortfolio(code);
      });
      submenu.appendChild(opt);
    });

    newBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = submenu.classList.toggle('open');
      newBtn.setAttribute('aria-expanded', String(isOpen));
    });
    footer.appendChild(newBtn);
    footer.appendChild(submenu);
    menu.appendChild(footer);
  },

  /**
   * Sync the mobile dropdown's selected value and label to match this.activePortfolioId.
   * Called after tab clicks, portfolio creation/deletion, or initial load.
   */
  _syncDropdownToActivePortfolio() {
    const label = document.getElementById('dropdown-label');
    if (!label || this.activePortfolioId === null) return;

    const active = this.portfolios.find(p => p.id === this.activePortfolioId);
    if (active) {
      label.textContent = `${active.name} (${active.currency})`;
    }

    // Update active state on option buttons
    const menu = document.getElementById('portfolio-dropdown-menu');
    if (menu) {
      menu.querySelectorAll('.portfolio-dropdown-option').forEach((opt) => {
        const isActive = Number(opt.dataset.id) === this.activePortfolioId;
        opt.classList.toggle('active', isActive);
        opt.setAttribute('aria-selected', isActive ? 'true' : 'false');
      });
    }
  },

  // ─── RENDERING: STATS BAR ────────────────────────────

  /**
   * Update stats bar values based on current positions.
   */
  _updateStatsBar() {
    const stats = this._calculateStats(this.positions);
    const displayCurrency = this._getPortfolioDisplayCurrency();

    // Show/hide warning banner for positions without prices
    const positionsWithoutPrice = this.positions.filter((p) => p.current_price == null).length;
    const banner = document.getElementById('price-warning-banner');
    const bannerText = document.getElementById('price-warning-text');
    if (banner && bannerText) {
      if (positionsWithoutPrice > 0) {
        banner.style.display = 'flex';
        bannerText.textContent = `${positionsWithoutPrice} of ${this.positions.length} position${positionsWithoutPrice !== 1 ? 's' : ''} missing price data. Allocation and P/L may be incomplete.`;
      } else {
        banner.style.display = 'none';
      }
    }

    this._setText('stat-cost-basis', '$' + this._formatNumber(stats.costBasis));
    this._setText('stat-market-value', '$' + this._formatNumber(stats.marketValue));

    // Add alt currency equivalents
    const altCurrency = displayCurrency === 'USD' ? 'CAD' : 'USD';
    const costBasisAlt = this._convertToDisplay(stats.costBasis, displayCurrency, altCurrency);
    const marketValueAlt = this._convertToDisplay(stats.marketValue, displayCurrency, altCurrency);
    const costBasisAltEl = document.getElementById('stat-cost-basis-alt');
    const marketValueAltEl = document.getElementById('stat-market-value-alt');
    if (costBasisAltEl) costBasisAltEl.textContent = `(${altCurrency} $${this._formatNumber(costBasisAlt)})`;
    if (marketValueAltEl) marketValueAltEl.textContent = `(${altCurrency} $${this._formatNumber(marketValueAlt)})`;

    const pnlEl = document.getElementById('stat-unrealized-pnl');
    if (pnlEl) {
      const sign = stats.unrealizedPnl >= 0 ? '+' : '';
      const pct = stats.costBasis > 0 ? ((stats.unrealizedPnl / stats.costBasis) * 100) : 0;
      pnlEl.textContent = `${sign}$${this._formatNumber(Math.abs(stats.unrealizedPnl))} (${sign}${pct.toFixed(2)}%)`;
      pnlEl.className = 'stats-bar-value ' + (stats.unrealizedPnl >= 0 ? 'up' : 'down');
    }

    // Add alt currency equivalent for Unrealized P/L
    const pnlAlt = this._convertToDisplay(stats.unrealizedPnl, displayCurrency, altCurrency);
    const pnlAltEl = document.getElementById('stat-unrealized-pnl-alt');
    if (pnlAltEl) {
      const signAlt = pnlAlt >= 0 ? '+' : '';
      const pctAlt = stats.costBasis > 0 ? ((pnlAlt / this._convertToDisplay(stats.costBasis, displayCurrency, altCurrency)) * 100) : 0;
      pnlAltEl.textContent = `(${altCurrency} ${signAlt}$${this._formatNumber(Math.abs(pnlAlt))})`;
      pnlAltEl.className = 'stats-bar-alt ' + (pnlAlt >= 0 ? 'up' : 'down');
    }

    // Day change
    const dayEl = document.getElementById('stat-day-change');
    if (dayEl) {
      const daySign = stats.dayChange >= 0 ? '+' : '';
      const dayPct = stats.marketValue > 0 ? ((stats.dayChange / stats.marketValue) * 100) : 0;
      dayEl.textContent = `${daySign}$${this._formatNumber(Math.abs(stats.dayChange))} (${daySign}${dayPct.toFixed(2)}%)`;
      dayEl.className = 'stats-bar-value ' + (stats.dayChange >= 0 ? 'up' : 'down');
    }
    const dayAltEl = document.getElementById('stat-day-change-alt');
    if (dayAltEl) {
      const dayAlt = this._convertToDisplay(stats.dayChange, displayCurrency, altCurrency);
      const dayAltSign = dayAlt >= 0 ? '+' : '';
      dayAltEl.textContent = `(${altCurrency} ${dayAltSign}$${this._formatNumber(Math.abs(dayAlt))})`;
      dayAltEl.className = 'stats-bar-alt ' + (dayAlt >= 0 ? 'up' : 'down');
    }

  },

  // ─── RENDERING: SUMMARY CARDS ────────────────────────

  /**
   * Build the aggregate positions list from all portfolios.
   * Each portfolio in this.portfolios contains a positions array from the
   * API response. This method flattens them into a single list so the
   * summary cards can show true cross-portfolio aggregates.
   *
   * Each position gets a portfolio_currency tag so currency conversion
   * can be applied correctly when summing values.
   */
  _buildAllPositions() {
    const result = [];
    for (const portfolio of this.portfolios) {
      const positions = portfolio.positions || [];
      const currency = portfolio.currency || 'USD';
      for (const pos of positions) {
        result.push({
          ...pos,
          // Carry the portfolio currency so we can normalize during aggregation
          portfolio_currency: currency,
        });
      }
    }
    this.allPositions = result;
  },

  /**
   * Update the positions array of a specific portfolio in this.portfolios,
   * then rebuild allPositions so aggregate summary cards stay accurate.
   *
   * @param {number} portfolioId - The portfolio whose positions to update
   * @param {Array<Object>} positions - Fresh positions array from the API
   */
  _syncPortfolioPositions(portfolioId, positions) {
    const portfolio = this.portfolios.find(p => p.id === portfolioId);
    if (portfolio) {
      portfolio.positions = positions;
    }
    this._buildAllPositions();
  },

  /**
   * Update summary cards with aggregate data.
   */
  _updateSummaryCards() {
    // Aggregate across ALL portfolios (not just the selected one)
    // Each position carries its portfolio_currency for correct conversion
    const allPositions = this.allPositions;
    const totalPositions = allPositions.length;

    // Aggregate cost basis and market value across all portfolios,
    // converting each position's native currency to CAD for the summary cards.
    let totalMarketValueCAD = 0;
    let totalCostBasisCAD = 0;

    for (const pos of allPositions) {
      const nativeCurrency = pos.portfolio_currency || 'USD';
      const qty = pos.qty || 0;
      const avgPrice = pos.avg_price || 0;
      const currentPrice = pos.current_price;

      const costBasisNative = avgPrice * qty;
      totalCostBasisCAD += this._convertToDisplay(costBasisNative, nativeCurrency, 'CAD');

      if (currentPrice != null) {
        const marketValueNative = currentPrice * qty;
        totalMarketValueCAD += this._convertToDisplay(marketValueNative, nativeCurrency, 'CAD');
      }
    }

    const unrealizedPnlCAD = totalMarketValueCAD - totalCostBasisCAD;

    // Total value
    this._setText('summary-total-value', '$' + this._formatNumber(totalMarketValueCAD));

    // Total P/L
    const pnlEl = document.getElementById('summary-pnl-value');
    if (pnlEl) {
      const sign = unrealizedPnlCAD >= 0 ? '+' : '';
      pnlEl.textContent = `${sign}$${this._formatNumber(Math.abs(unrealizedPnlCAD))}`;
      pnlEl.style.color = unrealizedPnlCAD >= 0 ? 'var(--color-stock-up)' : 'var(--color-stock-down)';
    }

    const pnlPct = totalCostBasisCAD > 0 ? ((unrealizedPnlCAD / totalCostBasisCAD) * 100) : 0;
    this._updateChangeEl('summary-pnl-change', pnlPct);

    // Day change — computed from per-position change_pct, converted to CAD
    let dayChangeCAD = 0;
    let dayChangePctDenom = 0;
    for (const pos of allPositions) {
      if (pos.current_price == null || pos.change_pct == null) continue;
      const nativeCurrency = pos.portfolio_currency || 'USD';
      const changePct = pos.change_pct;
      // Guard against division by zero (change_pct = -100%) or negative divisor
      if (1 + changePct / 100 <= 0) continue;
      const prevClose = pos.current_price / (1 + changePct / 100);
      const dayChangeNative = (pos.qty || 0) * prevClose * (changePct / 100);
      dayChangeCAD += this._convertToDisplay(dayChangeNative, nativeCurrency, 'CAD');
      dayChangePctDenom += this._convertToDisplay(prevClose * (pos.qty || 0), nativeCurrency, 'CAD');
    }

    const dayEl = document.getElementById('summary-day-value');
    if (dayEl) {
      const sign = dayChangeCAD >= 0 ? '+' : '';
      dayEl.textContent = `${sign}$${this._formatNumber(Math.abs(dayChangeCAD))}`;
      dayEl.style.color = dayChangeCAD >= 0 ? 'var(--color-stock-up)' : 'var(--color-stock-down)';
    }

    const dayChangePct = dayChangePctDenom > 0 ? (dayChangeCAD / dayChangePctDenom) * 100 : 0;
    this._updateChangeEl('summary-day-change', dayChangePct);

    // Positions count
    this._setText('summary-positions-count', String(totalPositions));
    this._setText('summary-positions-label', `active across ${this.portfolios.length} portfolio${this.portfolios.length !== 1 ? 's' : ''}`);
  },

  /**
   * Update a change element with up/down styling.
   * @param {string} id
   * @param {number} pct
   */
  _updateChangeEl(id, pct) {
    const el = document.getElementById(id);
    if (!el) return;
    const sign = pct >= 0 ? '+' : '';
    const isUp = pct >= 0;
    el.className = 'summary-card-change ' + (isUp ? 'up' : '');
    if (!isUp) el.style.color = 'var(--color-stock-down)';
    else el.style.color = '';
    el.innerHTML = `<svg viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="${isUp ? 'M6 9V3M3 5l3-3 3 3' : 'M6 3v6M3 7l3 3 3-3'}" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg><span>${sign}${pct.toFixed(2)}%</span>`;
  },

  // ─── RENDERING: POSITIONS TABLE ──────────────────────

  /**
   * Render positions table rows.
   */
  _renderPositions() {
    const tbody = document.getElementById('positions-tbody');
    if (!tbody) return;

    const hideFree = this._hideFreePositions();
    const hideFreeBtn = document.getElementById('hide-free-btn');
    if (hideFreeBtn) hideFreeBtn.setAttribute('aria-pressed', String(hideFree));

    if (!Array.isArray(this.positions) || this.positions.length === 0) {
      tbody.innerHTML = `
        <tr><td colspan="12" style="text-align:center;padding:var(--space-8);color:var(--color-text-secondary)">
          No positions in this portfolio. Use the trade form above to add one.
        </td></tr>`;
      this._setText('positions-count', '0 positions');
      this._updateSelectionUI();
      return;
    }

    let positions = hideFree ? this.positions.filter((p) => !this._isFreePosition(p)) : [...this.positions];

    // Sort if needed
    if (this.sortColumn) {
      positions = this._sortPositions(positions, this.sortColumn, this.sortDirection);
    }

    const totalMV = this.positions.reduce((s, p) => s + (p.qty || 0) * (p.current_price || 0), 0);
    this._setText('positions-count', hideFree && positions.length !== this.positions.length
      ? `${positions.length} of ${this.positions.length} positions`
      : `${positions.length} position${positions.length !== 1 ? 's' : ''}`);

    if (positions.length === 0) {
      tbody.innerHTML = '<tr><td colspan="12" style="text-align:center;padding:var(--space-8);color:var(--color-text-secondary)">All positions are hidden. Show FREE positions to view them.</td></tr>';
      this._updateSelectionUI();
      this._updateSortIndicators();
      return;
    }

    tbody.innerHTML = positions
      .map((pos) => {
        const qty = pos.qty || 0;
        const avgPrice = pos.avg_price || 0;
        const currentPrice = pos.current_price;
        const hasPrice = currentPrice != null;
        const pnl = hasPrice ? (currentPrice - avgPrice) * qty : null;
        const pnlPct = hasPrice && avgPrice > 0 ? ((currentPrice - avgPrice) / avgPrice) * 100 : null;
        const mv = hasPrice ? currentPrice * qty : null;
        const alloc = totalMV > 0 && hasPrice ? (mv / totalMV) * 100 : null;
        const up = pnl != null && pnl >= 0;
        const checked = this.selectedPositions.has(pos.id);

        const priceDisplay = hasPrice ? `$${currentPrice.toFixed(2)}` : '<span class="price-na">N/A</span>';
        const pnlDisplay = hasPrice
          ? `<span class="pnl-value ${up ? 'up' : 'down'}">${up ? '+' : '-'}$${Math.abs(pnl).toFixed(2)}</span><span class="pnl-pct ${up ? 'up' : 'down'}">(${up ? '+' : ''}${pnlPct.toFixed(2)}%)</span>`
          : '<span class="pnl-value">N/A</span>';
        const mvDisplay = hasPrice
          ? `$${mv.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
          : 'N/A';
        const allocDisplay = hasPrice
          ? `<div class="allocation-bar"><div class="allocation-track"><div class="allocation-fill" style="width:${alloc.toFixed(1)}%"></div></div><span class="allocation-text">${alloc.toFixed(1)}%</span></div>`
          : '<span class="allocation-text">N/A</span>';

        // ── Cycle stats (backend-enriched, transaction-derived) ──
        // Unrecovered / realized / breakeven need no market price, so they
        // stay visible even when the quote is missing (N/A price state).
        const unrec = pos.unrecovered_capital;
        const realized = pos.realized_pnl_cycle;
        const bePrice = pos.breakeven_price;
        const cycleTipAttr = this._escapeHtml(this._cycleTooltip(pos, pnl));

        const unrecDisplay = unrec != null
          ? `<span class="cycle-value">$${Number(unrec).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>`
          : '<span class="price-na">N/A</span>';

        let realizedDisplay;
        if (realized == null) {
          realizedDisplay = '<span class="price-na">N/A</span>';
        } else {
          const rUp = realized >= 0;
          realizedDisplay = `<span class="pnl-value ${rUp ? 'up' : 'down'}">${rUp ? '+' : '-'}$${Math.abs(realized).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>`;
        }

        // Breakeven <= 0 (backend floors the price at 0.00 and keeps the
        // negative raw for the tooltip) → $0.00 + FREE badge.
        // Sold-down positions with <$10 unrecovered show only FREE in this cell.
        // Null breakeven (no buys / desync) → N/A, sinks bottom in sort.
        const beIsFree = bePrice != null && ((pos.breakeven_raw != null ? pos.breakeven_raw : bePrice) <= 0);
        const nearFree = !beIsFree && this._isFreePosition(pos);
        let beDisplay;
        if (bePrice == null) {
          beDisplay = '<span class="price-na">N/A</span>';
        } else if (beIsFree) {
          beDisplay = '<span class="price-value">$0.00</span> <span class="free-badge">FREE</span>';
        } else if (nearFree) {
          beDisplay = '<span class="free-badge">FREE</span>';
        } else {
          beDisplay = `<span class="price-value">$${Number(bePrice).toFixed(2)}</span>`;
        }

        return `
        <tr data-position-id="${pos.id}" class="${checked ? 'selected' : ''} ${!hasPrice ? 'price-unavailable' : ''}">
          <td><input type="checkbox" class="row-checkbox" ${checked ? 'checked' : ''} aria-label="Select ${this._escapeHtml(pos.ticker)}"></td>
          <td>
            <div class="ticker-cell">
              <button class="ticker-symbol-link" data-ticker="${this._escapeHtml(pos.ticker)}" aria-label="View chart for ${this._escapeHtml(pos.ticker)}">${this._escapeHtml(pos.ticker)}</button>
              <span class="company-name">${this._escapeHtml(pos.company || '')}</span>
            </div>
          </td>
          <td class="text-right"><span class="qty-value">${this._formatShareQty(qty)}</span></td>
          <td class="text-right"><span class="price-value">$${avgPrice.toFixed(2)}</span></td>
          <td class="text-right"><span class="price-value">${priceDisplay}</span></td>
          <td class="text-right">
            <div class="pnl-cell">${pnlDisplay}</div>
          </td>
          <td class="text-right" title="Estimated value of shares held: quantity × current share price"><span class="market-value">${mvDisplay}</span></td>
          <td class="text-right" title="${cycleTipAttr}" aria-label="${cycleTipAttr}">${unrecDisplay}</td>
          <td class="text-right" title="${cycleTipAttr}" aria-label="${cycleTipAttr}">${realizedDisplay}</td>
          <td class="text-right be-cell" title="${cycleTipAttr}" aria-label="${cycleTipAttr}">${beDisplay}</td>
          <td>${allocDisplay}</td>
          <td class="actions-cell">
            <button class="edit-position-btn" data-position-id="${pos.id}" aria-label="Edit ${this._escapeHtml(pos.ticker)}" title="Edit position">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M11.5 1.5l3 3L5 14H2v-3L11.5 1.5z"/></svg>
            </button>
            <button class="notes-cell${(!pos.notes && !this._earningsDates[pos.ticker]?.next) ? ' empty' : ''}" data-position-id="${pos.id}" title="${this._escapeHtml(this._buildNotesDisplay(pos))}">${this._renderNotesContent(pos)}</button>
          </td>
        </tr>`;
      })
      .join('');

    // Bind row events
    tbody.querySelectorAll('.row-checkbox').forEach((cb) => {
      cb.addEventListener('change', () => {
        const tr = cb.closest('tr');
        const id = Number(tr.dataset.positionId);
        if (cb.checked) {
          this.selectedPositions.add(id);
        } else {
          this.selectedPositions.delete(id);
        }
        tr.classList.toggle('selected', cb.checked);
        this._updateSelectionUI();
      });
    });

    tbody.querySelectorAll('.notes-cell').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = Number(btn.dataset.positionId);
        const pos = this.positions.find((p) => p.id === id);
        if (!pos) return;

        const currentNote = pos.notes || '';
        const newNote = prompt(`Edit note for ${pos.ticker} (max 500 chars):`, currentNote);

        // User cancelled or no change
        if (newNote === null || newNote === currentNote) return;

        // Validate length
        if (newNote.length > 500) {
          alert('Note is too long. Maximum 500 characters allowed.');
          return;
        }

        // Save to backend via API
        try {
          if (this.activePortfolioId) {
            await API.put(`/portfolio/${this.activePortfolioId}/positions/${id}`, {
              notes: newNote,
            });
          }
          // Update local state
          pos.notes = newNote;
          this._renderPositions();
        } catch (err) {
          console.error('[Portfolio] Failed to save note:', err);
          alert('Failed to save note. Please try again.');
        }
      });
    });

    tbody.querySelectorAll('.edit-position-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = Number(btn.dataset.positionId);
        const position = this.positions.find(p => p.id === id);
        if (position) {
          this._openAddPositionModal(position);
        }
      });
    });

    this._updateSelectionUI();
    this._updateSortIndicators();
  },

  _hideFreePositions() {
    if (this.activePortfolioId == null) return true;
    if (Object.hasOwn(this._hideFreeOverrides, this.activePortfolioId)) {
      return this._hideFreeOverrides[this.activePortfolioId];
    }
    try { return localStorage.getItem(`portfolio-hide-free-${this.activePortfolioId}`) !== '0'; } catch { return true; }
  },

  _isFreePosition(pos) {
    const bePrice = pos.breakeven_price;
    const unrec = pos.unrecovered_capital;
    return bePrice != null && (
      (pos.breakeven_raw != null ? pos.breakeven_raw : bePrice) <= 0 ||
      (unrec != null && Number(unrec) > 0 && Number(unrec) < 10
        && pos.has_cycle_history === true && Number(pos.cash_recovered) > 0)
    );
  },

  // ─── RENDERING: DONUT CHART ──────────────────────────

  /**
   * Render the allocation donut chart and legend.
   */
  _updateDonutChart() {
  const svg = document.getElementById('donut-chart');
  const legend = document.getElementById('donut-legend');
  if (!svg || !legend) return;

  if (this.positions.length === 0) {
    svg.innerHTML = '';
    legend.innerHTML = '<div class="donut-legend-item"><span class="donut-legend-label" style="color:var(--color-text-tertiary)">No data</span></div>';
    return;
  }

  // All positions with prices, sorted by market value desc
  const sortedPositions = [...this.positions]
    .filter((p) => p.current_price != null)
    .sort((a, b) => (b.qty || 0) * (b.current_price || 0) - (a.qty || 0) * (a.current_price || 0));

  if (sortedPositions.length === 0) {
    svg.innerHTML = '';
    legend.innerHTML = '<div class="donut-legend-item"><span class="donut-legend-label" style="color:var(--color-text-tertiary)">No price data available</span></div>';
    return;
  }

  // Total portfolio market value (denominator matches table)
  const totalPortfolioValue = sortedPositions.reduce((s, p) => s + (p.qty || 0) * (p.current_price || 0), 0);

  // Top 8 individually
  const top8 = sortedPositions.slice(0, 8);
  // Rest aggregated as "Other"
  const rest = sortedPositions.slice(8);
  const otherValue = rest.reduce((s, p) => s + (p.qty || 0) * (p.current_price || 0), 0);

  const donutData = top8.map((p, i) => ({
    label: p.ticker,
    value: (p.qty || 0) * (p.current_price || 0),
    color: SECTOR_COLORS[i % SECTOR_COLORS.length]
  }));

  // Add "Other" if there are more than 8 positions
  if (otherValue > 0) {
    donutData.push({
      label: 'Other',
      value: otherValue,
      color: 'var(--color-allocation-other)'  // neutral remainder
    });
  }

  const total = donutData.reduce((s, d) => s + d.value, 0); // equals totalPortfolioValue

    if (total === 0) {
      svg.innerHTML = '';
      legend.innerHTML = '<div class="donut-legend-item"><span class="donut-legend-label" style="color:var(--color-text-tertiary)">No price data available</span></div>';
      return;
    }

    const cx = 70, cy = 70, R = 55, r = 35;
    let angle = -90;
    let html = '';

    donutData.forEach((d) => {
      const pct = d.value / total;
      const angleSpan = pct * 360;
      const startA = angle;
      const endA = angle + angleSpan;

      const x1 = cx + R * Math.cos((startA * Math.PI) / 180);
      const y1 = cy + R * Math.sin((startA * Math.PI) / 180);
      const x2 = cx + R * Math.cos((endA * Math.PI) / 180);
      const y2 = cy + R * Math.sin((endA * Math.PI) / 180);
      const ix1 = cx + r * Math.cos((endA * Math.PI) / 180);
      const iy1 = cy + r * Math.sin((endA * Math.PI) / 180);
      const ix2 = cx + r * Math.cos((startA * Math.PI) / 180);
      const iy2 = cy + r * Math.sin((startA * Math.PI) / 180);
      const large = angleSpan > 180 ? 1 : 0;

      html += `<path d="M${x1} ${y1} A${R} ${R} 0 ${large} 1 ${x2} ${y2} L${ix1} ${iy1} A${r} ${r} 0 ${large} 0 ${ix2} ${iy2} Z" fill="${d.color}" stroke="var(--color-bg-elevated)" stroke-width="1.5"><title>${d.label}: ${(pct * 100).toFixed(1)}%</title></path>`;
      angle = endA;
    });

    html += `<text x="${cx}" y="${cy - 4}" text-anchor="middle" font-size="18" font-weight="700" font-family="var(--font-mono)" fill="var(--color-text-primary)">$${(total / 1000).toFixed(0)}K</text>`;
    html += `<text x="${cx}" y="${cy + 12}" text-anchor="middle" font-size="10" font-family="var(--font-family)" fill="var(--color-text-secondary)">Total</text>`;

    svg.innerHTML = html;

    legend.innerHTML = donutData
      .map((d) => {
        const pct = ((d.value / total) * 100).toFixed(1);
        return `<div class="donut-legend-item"><span class="donut-legend-dot" style="background:${d.color}"></span><span class="donut-legend-label">${this._escapeHtml(d.label)}</span><span class="donut-legend-pct">${pct}%</span></div>`;
      })
      .join('');
  },

  // ─── RENDERING: SECTOR PANEL ─────────────────────────

  /**
   * Update sector allocation bar and legend.
   */
  _updateSectorPanel() {
    const barEl = document.getElementById('sector-bar');
    const legendEl = document.getElementById('sector-legend');
    if (!barEl || !legendEl) return;

    if (this.positions.length === 0) {
      barEl.innerHTML = '';
      legendEl.innerHTML = '<div class="sector-legend-item"><span class="sector-legend-label" style="color:var(--color-text-tertiary)">No data</span></div>';
      return;
    }

    // Aggregate by sector, skip positions without prices
    const sectors = {};
    this.positions.forEach((p) => {
      if (p.current_price == null) return;
      const sector = p.sector || (p.company && /ETF|Fund/i.test(p.company) ? 'ETF' : 'Other');
      if (!sectors[sector]) sectors[sector] = 0;
      sectors[sector] += (p.qty || 0) * (p.current_price || 0);
    });

    const total = Object.values(sectors).reduce((s, v) => s + v, 0);

    if (total === 0) {
      barEl.innerHTML = '';
      legendEl.innerHTML = '<div class="sector-legend-item"><span class="sector-legend-label" style="color:var(--color-text-tertiary)">No price data available</span></div>';
      return;
    }

    const sorted = Object.entries(sectors).sort((a, b) => b[1] - a[1]);

    barEl.innerHTML = sorted
      .map(([sector, value], i) => {
        const pct = (value / total) * 100;
        return `<div class="sector-bar-segment" style="flex:${pct};background:${SECTOR_COLORS[i % SECTOR_COLORS.length]}" title="${sector}: ${pct.toFixed(1)}%"></div>`;
      })
      .join('');

    legendEl.innerHTML = sorted
      .map(([sector, value], i) => {
        const pct = ((value / total) * 100).toFixed(1);
        return `<div class="sector-legend-item"><span class="sector-legend-dot" style="background:${SECTOR_COLORS[i % SECTOR_COLORS.length]}"></span><span class="sector-legend-label">${this._escapeHtml(sector)}</span><span class="sector-legend-value">${pct}%</span></div>`;
      })
      .join('');
  },

  // ─── RENDERING: P/L HISTORY CHART ───────────────────

  /**
   * Load P/L history data for the active portfolio and render the chart.
   * Shows loading, empty, or chart states. Errors are silently handled.
   * @param {number} portfolioId
   */
  async _loadPnlHistory(portfolioId) {
    this._showPnlLoading();

    try {
      const data = await API.get(`/portfolio/${portfolioId}/pnl-history`);

      // Guard: ignore stale response if user switched portfolios
      if (this.activePortfolioId !== portfolioId) return;

      const snapshots = data.snapshots || [];

      if (snapshots.length === 0) {
        this._showPnlEmpty();
        return;
      }

      // Render the chart
      this._renderPnlChart(snapshots, data.currency);

      // Update summary with latest data point
      this._updatePnlSummary(snapshots);
    } catch (err) {
      // Guard: ignore stale errors
      if (this.activePortfolioId !== portfolioId) return;
      console.info('[Portfolio] Failed to load P/L history:', err.message);
      this._showPnlError();
    }
  },

  /**
   * Render the P/L line chart on the canvas.
   * Destroys any existing chart instance before re-rendering.
   * Stores data for theme-reactive re-renders.
   * @param {Array<{date: string, pnl: number, pct: number}>} snapshots
   * @param {string} currency
   */
  _renderPnlChart(snapshots, currency) {
    const container = document.getElementById('pnl-chart-container');
    if (!container) return;

    // Destroy previous chart instance if any
    if (this._pnlChartInstance) {
      try { this._pnlChartInstance.remove(); } catch {}
      this._pnlChartInstance = null;
      this._pnlLineSeries = null;
    }

    // Show chart state, hide empty/loading
    this._showPnlChart();

    // Store for theme re-rendering
    this._currentPnlData = snapshots;
    this._currentPnlCurrency = currency;

    // Render via LightweightCharts
    this._renderPnlChartLC(snapshots, currency).catch(() => {});
  },

  /**
   * Render P/L line chart using TradingView LightweightCharts library.
   * Creates an area/line chart with crosshair and custom HTML tooltip.
   * @param {Array<{date: string, pnl: number, pct: number}>} snapshots
   * @param {string} currency
   */
  async _renderPnlChartLC(snapshots, currency) {
    await this._ensureLightCharts();
    if (typeof LightweightCharts === 'undefined') {
      console.error('[Portfolio] LightweightCharts failed to load — cannot render P/L chart');
      return;
    }

    const container = document.getElementById('pnl-chart-container');
    if (!container) return;

    // Determine theme colors
    const isDark = document.documentElement.dataset.theme === 'dark';
    const bgColor = isDark ? '#0E0E0E' : '#F4F4F4';
    const textColor = isDark ? '#A3A3A3' : '#5C5C5C';
    // Determine line color based on latest P/L (parity with per-ticker chart; zero stays green)
    const latestPct = snapshots.length ? snapshots[snapshots.length - 1].pct : 0;
    const isNegative = latestPct < 0;
    const lineColor = latestPct >= 0 ? (isDark ? '#34C77B' : '#0E7A3D') : (isDark ? '#F25555' : '#C81E1E');
    const areaTopColor = isNegative
      ? (isDark ? 'rgba(242, 85, 85, 0.28)' : 'rgba(200, 30, 30, 0.28)')
      : (isDark ? 'rgba(52, 199, 123, 0.28)' : 'rgba(14, 122, 61, 0.28)');
    const areaBottomColor = isNegative
      ? (isDark ? 'rgba(242, 85, 85, 0.0)' : 'rgba(200, 30, 30, 0.0)')
      : (isDark ? 'rgba(52, 199, 123, 0.0)' : 'rgba(14, 122, 61, 0.0)');
    const borderColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
    const gridColor = isDark ? 'rgba(255,255,255,0.20)' : 'rgba(0,0,0,0.20)';
    const crosshairColor = isDark ? '#6B7280' : '#9CA3AF';

    // Create chart
    const chart = LightweightCharts.createChart(container, {
      autoSize: true,
      layout: {
        background: { type: 'solid', color: bgColor },
        textColor: textColor,
        fontSize: 11,
        fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font').trim(),
        attributionLogo: false,
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: gridColor, style: LightweightCharts.LineStyle.Dotted },
      },
      crosshair: {
        mode: LightweightCharts.CrosshairMode.Normal,
      },
      timeScale: {
        timeVisible: false,
        borderColor: borderColor,
        rightOffset: 2,
        barSpacing: 10,
        fixLeftEdge: true,
        fixRightEdge: true,
      },
      rightPriceScale: {
        borderColor: borderColor,
        scaleMargins: { top: 0.15, bottom: 0.15 },
      },
      handleScroll: false,
    });

    // Add line series
    const lineSeries = chart.addSeries(LightweightCharts.LineSeries, {
      color: lineColor,
      lineWidth: 2,
      priceFormat: { type: 'custom', formatter: (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%` },
      lastValueVisible: true,
      priceLineVisible: false,
    });

    // Convert data to LightweightCharts format: { time: 'YYYY-MM-DD', value: number }
    const chartData = snapshots.map(s => ({
      time: s.date,
      value: s.pct,
    }));

    lineSeries.setData(chartData);
    requestAnimationFrame(() => chart.timeScale().fitContent());

    // Custom tooltip via crosshair move
    chart.subscribeCrosshairMove((param) => {
      const tooltip = document.getElementById('pnl-tooltip');
      const dateEl = document.getElementById('pnl-tooltip-date');
      const valueEl = document.getElementById('pnl-tooltip-value');

      if (!tooltip || !param || !param.time || !param.point ||
          param.point.x < 0 || param.point.y < 0 ||
          param.point.x > container.clientWidth || param.point.y > container.clientHeight) {
        if (tooltip) tooltip.style.display = 'none';
        return;
      }
      if (!param.seriesData) {
        tooltip.style.display = 'none';
        return;
      }

      // Find matching snapshot
      const snapshot = snapshots.find(s => s.date === param.time);
      if (!snapshot) {
        tooltip.style.display = 'none';
        return;
      }

      // Format date as DD MON YY (no time component)
      dateEl.textContent = formatChartDateDDMONYY(snapshot.date);

      // Format value: percentage + dollar
      const pctSign = snapshot.pnl >= 0 ? '+' : '';
      const dollarSign = snapshot.pnl >= 0 ? '+$' : '-$';
      const dollar = Math.abs(snapshot.pnl).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      valueEl.textContent = `${pctSign}${snapshot.pct.toFixed(2)}% (${dollarSign}${dollar})`;
      valueEl.className = 'pnl-tooltip-value ' + (snapshot.pnl >= 0 ? 'up' : 'down');

      // Floating tooltip: anchor to datapoint via series.priceToCoordinate
      const rect = container.getBoundingClientRect();
      const seriesData = param.seriesData.get(lineSeries);
      if (!seriesData) { tooltip.style.display = 'none'; return; }

      tooltip.style.display = 'block';
      const coordinate = (seriesData.value != null) ? lineSeries.priceToCoordinate(seriesData.value) : null;
      if (coordinate === null || coordinate === undefined) { tooltip.style.display = 'none'; return; }
      const tooltipW = tooltip.offsetWidth || 130;
      const tooltipH = tooltip.offsetHeight || 80;

      let left = param.point.x - tooltipW / 2;
      left = Math.max(8, Math.min(left, rect.width - tooltipW - 8));

      let top = coordinate - tooltipH - 15;
      if (top <= 0) top = coordinate + 15;
      top = Math.max(0, Math.min(top, rect.height - tooltipH));

      tooltip.style.left = left + 'px';
      tooltip.style.top = top + 'px';
    });

    // Hide tooltip on mouse leave
    container.addEventListener('mouseleave', () => {
      const tooltip = document.getElementById('pnl-tooltip');
      if (tooltip) tooltip.style.display = 'none';
    });

    // Store reference for cleanup
    this._pnlChartInstance = chart;
    this._pnlLineSeries = lineSeries;
  },

  /**
   * Update the P/L summary values below the chart.
   * Shows the latest snapshot's dollar P/L and percentage.
   * @param {Array<{date: string, pnl: number, pct: number}>} snapshots
   */
  _updatePnlSummary(snapshots) {
    const latest = snapshots[snapshots.length - 1];
    if (!latest) return;

    const valueEl = document.getElementById('pnl-summary-value');
    const pctEl = document.getElementById('pnl-summary-pct');

    if (valueEl) {
      const sign = latest.pnl >= 0 ? '+' : '-';
      valueEl.textContent = `${sign}$${Math.abs(latest.pnl).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      valueEl.className = 'pnl-summary-value ' + (latest.pnl >= 0 ? 'up' : 'down');
    }

    if (pctEl) {
      const sign = latest.pct >= 0 ? '+' : '';
      pctEl.textContent = `${sign}${latest.pct.toFixed(2)}%`;
      pctEl.className = 'pnl-summary-pct ' + (latest.pct >= 0 ? 'up' : 'down');
    }
  },

  /**
   * Show the P/L tooltip with the hovered data point info.
   * Formats date and value, applies up/down styling.
   * @param {{ date: string, pnl: number, pct: number }} point
   */
  _showPnlTooltip(point) {
    const tooltip = document.getElementById('pnl-tooltip');
    const dateEl = document.getElementById('pnl-tooltip-date');
    const valueEl = document.getElementById('pnl-tooltip-value');

    if (!tooltip || !point) return;

    if (dateEl) {
      dateEl.textContent = formatChartDateDDMONYY(point.date);
    }

    if (valueEl) {
      const sign = point.pnl >= 0 ? '+' : '-';
      valueEl.textContent = `${sign}$${Math.abs(point.pnl).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      valueEl.className = 'pnl-tooltip-value ' + (point.pnl >= 0 ? 'up' : 'down');
    }

    tooltip.style.display = 'block';
  },

  /**
   * Hide the P/L tooltip.
   */
  _hidePnlTooltip() {
      const tooltip = document.getElementById('chart-canvas')?.querySelector('#position-pnl-tooltip');
      if (tooltip) tooltip.style.display = 'none';
  },

  /**
   * Show the chart view, hide empty and loading states.
   */
  _showPnlChart() {
    const chart = document.getElementById('pnl-chart-state');
    const empty = document.getElementById('pnl-empty-state');
    const loading = document.getElementById('pnl-loading-state');
    const error = document.getElementById('pnl-error-state');
    if (chart) chart.style.display = '';
    if (empty) empty.style.display = 'none';
    if (loading) loading.style.display = 'none';
    if (error) error.style.display = 'none';
  },

  /**
   * Show the empty state, hide chart and loading states.
   * Also destroys any existing chart to prevent memory leaks.
   */
  _showPnlEmpty() {
    const chart = document.getElementById('pnl-chart-state');
    const empty = document.getElementById('pnl-empty-state');
    const loading = document.getElementById('pnl-loading-state');
    const error = document.getElementById('pnl-error-state');
    if (chart) chart.style.display = 'none';
    if (empty) empty.style.display = '';
    if (loading) loading.style.display = 'none';
    if (error) error.style.display = 'none';

    // Destroy any existing chart
    if (this._pnlChartInstance) {
      try { this._pnlChartInstance.remove(); } catch {}
      this._pnlChartInstance = null;
      this._pnlLineSeries = null;
    }
  },

  /**
   * Show the loading state, hide chart and empty states.
   */
  _showPnlLoading() {
    const chart = document.getElementById('pnl-chart-state');
    const empty = document.getElementById('pnl-empty-state');
    const loading = document.getElementById('pnl-loading-state');
    const error = document.getElementById('pnl-error-state');
    if (chart) chart.style.display = 'none';
    if (empty) empty.style.display = 'none';
    if (loading) loading.style.display = '';
    if (error) error.style.display = 'none';
  },

  /**
   * Show the error state, hide chart, empty, and loading states.
   * Also destroys any existing chart to prevent memory leaks.
   */
  _showPnlError() {
    const chart = document.getElementById('pnl-chart-state');
    const empty = document.getElementById('pnl-empty-state');
    const loading = document.getElementById('pnl-loading-state');
    const error = document.getElementById('pnl-error-state');
    if (chart) chart.style.display = 'none';
    if (empty) empty.style.display = 'none';
    if (loading) loading.style.display = 'none';
    if (error) error.style.display = '';

    // Destroy any existing chart
    if (this._pnlChartInstance) {
      try { this._pnlChartInstance.remove(); } catch {}
      this._pnlChartInstance = null;
      this._pnlLineSeries = null;
    }
  },

  /**
   * Hide the error state.
   */
  _hidePnlError() {
    const error = document.getElementById('pnl-error-state');
    if (error) error.style.display = 'none';
  },

  // ─── SORTING ─────────────────────────────────────────

  /**
   * Handle column sort click.
   * @param {string} column
   */
  _handleSort(column) {
    if (this.sortColumn === column) {
      this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
    } else {
      this.sortColumn = column;
      this.sortDirection = 'asc';
    }
    this._renderPositions();
  },

  /**
   * Sort positions array.
   * @param {Array<Object>} positions
   * @param {string} column
   * @param {'asc'|'desc'} dir
   * @returns {Array<Object>}
   */
  _sortPositions(positions, column, dir) {
    const mult = dir === 'asc' ? 1 : -1;

    return positions.sort((a, b) => {
      let valA, valB;

      switch (column) {
        case 'ticker':
          valA = a.ticker;
          valB = b.ticker;
          return mult * valA.localeCompare(valB);
        case 'qty':
          valA = a.qty || 0;
          valB = b.qty || 0;
          break;
        case 'avg':
          valA = a.avg_price || 0;
          valB = b.avg_price || 0;
          break;
        case 'current':
          valA = a.current_price ?? -Infinity;
          valB = b.current_price ?? -Infinity;
          break;
        case 'pnl':
          valA = a.current_price != null ? (a.current_price - (a.avg_price || 0)) * (a.qty || 0) : -Infinity;
          valB = b.current_price != null ? (b.current_price - (b.avg_price || 0)) * (b.qty || 0) : -Infinity;
          break;
        case 'cost':
          valA = (a.avg_price || 0) * (a.qty || 0);
          valB = (b.avg_price || 0) * (b.qty || 0);
          break;
        case 'mv':
          valA = a.current_price != null ? (a.current_price || 0) * (a.qty || 0) : -Infinity;
          valB = b.current_price != null ? (b.current_price || 0) * (b.qty || 0) : -Infinity;
          break;
        case 'unrecovered':
        case 'realized':
        case 'breakeven': {
          // Cycle columns (data-sort: unrecovered, realized, breakeven).
          // Null (N/A — e.g. null breakeven with no buys) always sinks to
          // the bottom in both directions, mirroring the nullable price
          // columns' intent.
          const key = column === 'unrecovered' ? 'unrecovered_capital' : column === 'realized' ? 'realized_pnl_cycle' : 'breakeven_price';
          const aNull = a[key] == null;
          const bNull = b[key] == null;
          if (aNull && bNull) return 0;
          if (aNull) return 1;
          if (bNull) return -1;
          return mult * (a[key] - b[key]);
        }
        default:
          return 0;
      }

      return mult * (valA - valB);
    });
  },

  /**
   * Update sort indicator classes on table headers.
   * Generic over data-sort keys, so the cycle columns (unrecovered,
   * realized, breakeven) work with no extra wiring. Also mirrors the
   * state into aria-sort for screen readers.
   */
  _updateSortIndicators() {
    document.querySelectorAll('.positions-table thead th.sortable').forEach((th) => {
      th.classList.remove('sorted-asc', 'sorted-desc');
      th.removeAttribute('aria-sort');
      if (th.dataset.sort === this.sortColumn) {
        th.classList.add(this.sortDirection === 'asc' ? 'sorted-asc' : 'sorted-desc');
        th.setAttribute('aria-sort', this.sortDirection === 'asc' ? 'ascending' : 'descending');
      }
    });
  },

  // ─── SELECTION ───────────────────────────────────────

  /**
   * Update selection UI: pill counts, button disabled state, select-all.
   */
  _updateSelectionUI() {
    const count = this.selectedPositions.size;

    this._setText('selected-count', String(count));
    this._setText('delete-count', String(count));

    const moveBtn = document.getElementById('move-btn');
    const deleteBtn = document.getElementById('delete-positions-btn');
    if (moveBtn) moveBtn.disabled = count === 0;
    if (deleteBtn) deleteBtn.disabled = count === 0;

    const totalCheckboxes = document.querySelectorAll('.row-checkbox').length;
    const selectAll = document.getElementById('select-all');
    if (selectAll) {
      selectAll.checked = totalCheckboxes > 0 && count === totalCheckboxes;
      selectAll.indeterminate = count > 0 && count < totalCheckboxes;
    }
  },

  /**
   * Toggle select all positions.
   * @param {boolean} checked
   */
  _toggleSelectAll(checked) {
    this.selectedPositions.clear();
    if (checked) {
      document.querySelectorAll('#positions-tbody tr[data-position-id]').forEach((tr) => {
        this.selectedPositions.add(Number(tr.dataset.positionId));
      });
    }
    document.querySelectorAll('.row-checkbox').forEach((cb) => {
      cb.checked = checked;
      cb.closest('tr').classList.toggle('selected', checked);
    });
    this._updateSelectionUI();
  },

  // ─── MODALS ──────────────────────────────────────────

  /**
   * Bind modal events (position add/edit, move, delete).
   */
  _bindModalEvents() {
    // Position modal
    const posModal = document.getElementById('position-modal');
    const posClose = document.getElementById('position-modal-close');
    const posCancel = document.getElementById('position-modal-cancel');
    const posSave = document.getElementById('position-modal-save');

    if (posClose) posClose.addEventListener('click', () => this._closePositionModal());
    if (posCancel) posCancel.addEventListener('click', () => this._closePositionModal());
    if (posSave) posSave.addEventListener('click', () => this._savePositionFromModal());
    if (posModal) posModal.addEventListener('click', (e) => { if (e.target === posModal) this._closePositionModal(); });

    // Move modal
    const moveModal = document.getElementById('move-modal');
    const moveClose = document.getElementById('move-modal-close');
    const moveCancel = document.getElementById('move-cancel');
    const moveConfirm = document.getElementById('move-confirm');

    if (moveClose) moveClose.addEventListener('click', () => this._closeModal('move-modal'));
    if (moveCancel) moveCancel.addEventListener('click', () => this._closeModal('move-modal'));
    if (moveConfirm) moveConfirm.addEventListener('click', () => this._executeMove());
    if (moveModal) moveModal.addEventListener('click', (e) => { if (e.target === moveModal) this._closeModal('move-modal'); });

    // Delete modal
    const delModal = document.getElementById('delete-modal');
    const delClose = document.getElementById('delete-modal-close');
    const delCancel = document.getElementById('delete-cancel');
    const delConfirm = document.getElementById('delete-confirm');

    if (delClose) delClose.addEventListener('click', () => this._closeModal('delete-modal'));
    if (delCancel) delCancel.addEventListener('click', () => this._closeModal('delete-modal'));
    if (delConfirm) delConfirm.addEventListener('click', () => this._executeDeletePortfolio());
    if (delModal) delModal.addEventListener('click', (e) => { if (e.target === delModal) this._closeModal('delete-modal'); });

    // Reorder modal
    const reorderModal = document.getElementById('reorder-modal');
    const reorderClose = document.getElementById('reorder-modal-close');
    const reorderCancel = document.getElementById('reorder-cancel');
    const reorderSave = document.getElementById('reorder-save');

    if (reorderClose) reorderClose.addEventListener('click', () => this._closeModal('reorder-modal'));
    if (reorderCancel) reorderCancel.addEventListener('click', () => this._closeModal('reorder-modal'));
    if (reorderSave) reorderSave.addEventListener('click', () => this._saveReorder());
    if (reorderModal) reorderModal.addEventListener('click', (e) => { if (e.target === reorderModal) this._closeModal('reorder-modal'); });
  },

  /**
   * Open the add/edit position modal.
   * @param {Object} [position] - If provided, edit mode
   */
  _openAddPositionModal(position) {
    const modal = document.getElementById('position-modal');
    const title = document.getElementById('position-modal-title');
    if (!modal) return;

    if (title) title.textContent = position ? 'Edit Position' : 'Add Position';

    const ticker = document.getElementById('modal-ticker');
    const qty = document.getElementById('modal-qty');
    const price = document.getElementById('modal-price');
    const notes = document.getElementById('modal-notes');

    if (position) {
      if (ticker) ticker.value = position.ticker;
      if (qty) qty.value = position.qty;
      if (price) price.value = position.avg_price;
      if (notes) notes.value = position.notes || '';
      modal.dataset.editId = position.id;
    } else {
      if (ticker) ticker.value = '';
      if (qty) qty.value = '';
      if (price) price.value = '';
      if (notes) notes.value = '';
      delete modal.dataset.editId;
    }

    this._clearPositionFormErrors();
    modal.classList.add('open');
    document.body.style.overflow = 'hidden';
    if (ticker) ticker.focus();
  },

  /**
   * Close the position modal.
   */
  _closePositionModal() {
    const modal = document.getElementById('position-modal');
    if (modal) {
      modal.classList.remove('open');
      delete modal.dataset.editId;
    }
    document.body.style.overflow = '';
  },

  /**
   * Save position from modal form.
   */
  async _savePositionFromModal() {
    const modal = document.getElementById('position-modal');
    const ticker = document.getElementById('modal-ticker');
    const qty = document.getElementById('modal-qty');
    const price = document.getElementById('modal-price');
    const notes = document.getElementById('modal-notes');

    const tickerVal = ticker ? ticker.value.trim().toUpperCase() : '';
    const qtyVal = qty ? Number(qty.value) : 0;
    const priceVal = price ? Number(price.value) : 0;
    const notesVal = notes ? notes.value.trim() : '';

    // Validate
    let valid = true;
    if (!tickerVal) {
      this._showPositionError('modal-ticker-error');
      valid = false;
    }
    if (qtyVal < 1) {
      this._showPositionError('modal-qty-error');
      valid = false;
    }
    if (priceVal <= 0) {
      this._showPositionError('modal-price-error');
      valid = false;
    }
    if (!valid) return;

    const editId = modal.dataset.editId ? Number(modal.dataset.editId) : null;

    try {
      if (this.activePortfolioId) {
        if (editId) {
          const totalInvestment = qtyVal * priceVal;
          await API.put(`/portfolio/${this.activePortfolioId}/positions/${editId}`, {
            qty: qtyVal,
            avg_price: priceVal,
            total_investment: totalInvestment,
            notes: notesVal
          });
        } else {
          await API.post(`/portfolio/${this.activePortfolioId}/positions`, {
            ticker: tickerVal,
            qty: qtyVal,
            price: priceVal,
            notes: notesVal
          });
        }
        await this.loadPositions(this.activePortfolioId);
      }

      this._closePositionModal();
    } catch (err) {
      this._showError(err.message);
    }
  },

  /**
   * Open move positions modal.
   */
  _openMoveModal() {
    if (this.selectedPositions.size === 0) return;

    const modal = document.getElementById('move-modal');
    const listEl = document.getElementById('move-positions-list');
    const destSelect = document.getElementById('move-dest');

    if (!modal) return;

    // List selected positions
    const selected = this.positions.filter((p) => this.selectedPositions.has(p.id));
    if (listEl) {
      listEl.textContent = selected.map((p) => `${p.ticker} (${this._formatShareQty(p.qty)} shares)`).join(', ');
    }

    // Populate destination dropdown (exclude current)
    if (destSelect) {
      destSelect.innerHTML = this.portfolios
        .filter((p) => p.id !== this.activePortfolioId)
        .map((p) => `<option value="${p.id}">${this._escapeHtml(p.name)} (${p.currency})</option>`)
        .join('');

      if (destSelect.options.length === 0) {
        destSelect.innerHTML = '<option disabled>No other portfolios</option>';
      }
    }

    // Check for currency mismatch warning
    const current = this.portfolios.find((p) => p.id === this.activePortfolioId);
    const warning = document.getElementById('move-warning');
    if (warning && current) {
      const hasDifferentCurrency = this.portfolios.some((p) => p.id !== this.activePortfolioId && p.currency !== current.currency);
      warning.style.display = hasDifferentCurrency ? 'flex' : 'none';
    }

    modal.classList.add('open');
    document.body.style.overflow = 'hidden';
  },

  /**
   * Execute move positions action.
   */
  async _executeMove() {
    const destSelect = document.getElementById('move-dest');
    const destId = destSelect ? Number(destSelect.value) : null;
    if (!destId) return;

    const selected = Array.from(this.selectedPositions);

    try {
      const result = await API.post(`/portfolio/${this.activePortfolioId}/positions/move`, {
        position_ids: selected,
        target_portfolio_id: destId
      });

      // Update portfolio data from the API response to keep allPositions in sync
      if (result && result.source_portfolio) {
        const srcIdx = this.portfolios.findIndex(p => p.id === this.activePortfolioId);
        if (srcIdx !== -1) this.portfolios[srcIdx] = result.source_portfolio;
      }
      if (result && result.target_portfolio) {
        const tgtIdx = this.portfolios.findIndex(p => p.id === destId);
        if (tgtIdx !== -1) this.portfolios[tgtIdx] = result.target_portfolio;
      }
      this._buildAllPositions();

      // Remove moved positions from current list
      this.positions = this.positions.filter((p) => !this.selectedPositions.has(p.id));
      this.selectedPositions.clear();

      this._closeModal('move-modal');
      this._renderPositions();
      this._updateStatsBar();
      this._updateSummaryCards();
      this._updateDonutChart();
      this._updateSectorPanel();
      this._updateSelectionUI();
    } catch (err) {
      this._showError(err.message);
    }
  },

  /**
   * Open delete portfolio confirmation modal.
   */
  _openDeleteModal() {
    const modal = document.getElementById('delete-modal');
    const nameEl = document.getElementById('delete-portfolio-name');
    const current = this.portfolios.find((p) => p.id === this.activePortfolioId);

    if (nameEl && current) {
      nameEl.textContent = `"${current.name}"`;
    }

    if (modal) {
      modal.classList.add('open');
      document.body.style.overflow = 'hidden';
    }
  },

  /**
   * Execute portfolio deletion.
   */
  async _executeDeletePortfolio() {
    if (!this.activePortfolioId) return;

    try {
      await API.delete(`/portfolio/${this.activePortfolioId}`);

      // Remove from local list
      this.portfolios = this.portfolios.filter((p) => p.id !== this.activePortfolioId);
      this._closeModal('delete-modal');

      if (this.portfolios.length > 0) {
        this.selectPortfolio(this.portfolios[0].id);
      } else {
        this.activePortfolioId = null;
        this.positions = [];
        this._buildAllPositions();
        this._renderTabs();
        this._renderPositions();
        this._updateStatsBar();
        this._updateSummaryCards();
        this._updateDonutChart();
        this._updateSectorPanel();
        this._showEmptyState();
      }
    } catch (err) {
      this._showError(err.message);
    }
  },

  /**
   * Delete selected positions.
   */
  async _deleteSelectedPositions() {
    if (this.selectedPositions.size === 0) return;

    const count = this.selectedPositions.size;
    if (!confirm(`Delete ${count} position${count > 1 ? 's' : ''}?`)) return;

    try {
      if (this.activePortfolioId) {
        for (const id of this.selectedPositions) {
          await API.delete(`/portfolio/${this.activePortfolioId}/positions/${id}`);
        }
        await this.loadPositions(this.activePortfolioId);
      }
    } catch (err) {
      this._showError(err.message);
    }
  },

  /**
   * Handle portfolio rename.
   * @param {number} portfolioId
   */
  async _handleRenamePortfolio(portfolioId) {
    const portfolio = this.portfolios.find((p) => p.id === portfolioId);
    if (!portfolio) return;

    const newName = prompt('Rename portfolio:', portfolio.name);
    if (newName && newName.trim() && newName.trim() !== portfolio.name) {
      try {
        await API.put(`/portfolio/${portfolioId}`, { name: newName.trim() });
        await this.loadPortfolios();
      } catch (err) {
        console.error('Failed to rename portfolio:', err);
      }
    }
  },

  // ─── PORTFOLIO REORDER ───────────────────────────────

  /**
   * Open the Manage-order modal. Working copy lives in _reorderIds so
   * Cancel discards changes. Display order is shared with the
   * Transactions screen via GET /api/portfolio (ORDER BY sort_order).
   */
  _openReorderModal() {
    if (this.portfolios.length < 2) return;
    this._reorderIds = this.portfolios.map((p) => p.id);
    this._reorderDirty = false;
    this._renderReorderList();
    const modal = document.getElementById('reorder-modal');
    if (modal) {
      modal.classList.add('open');
      document.body.style.overflow = 'hidden';
    }
    this._syncReorderButton();
  },

  _syncReorderButton() {
    const btn = document.getElementById('reorder-portfolios-btn');
    if (btn) btn.disabled = this.portfolios.length < 2;
  },

  _renderReorderList() {
    const listEl = document.getElementById('reorder-list');
    if (!listEl) return;
    const byId = new Map(this.portfolios.map((p) => [p.id, p]));
    listEl.innerHTML = '';

    this._reorderIds.forEach((id, idx) => {
      const p = byId.get(id);
      if (!p) return;
      const row = document.createElement('div');
      row.className = 'reorder-item';
      row.dataset.id = String(id);
      row.setAttribute('draggable', 'true');
      row.innerHTML = `
        <span class="drag-handle" aria-hidden="true">⠿</span>
        <span class="reorder-name">${this._escapeHtml(p.name)}</span>
        <span class="reorder-currency">${p.currency}</span>
        <span class="reorder-move">
          <button type="button" data-move="up" aria-label="Move ${this._escapeHtml(p.name)} up" ${idx === 0 ? 'disabled' : ''}>▲</button>
          <button type="button" data-move="down" aria-label="Move ${this._escapeHtml(p.name)} down" ${idx === this._reorderIds.length - 1 ? 'disabled' : ''}>▼</button>
        </span>`;
      row.querySelector('[data-move="up"]').addEventListener('click', () => this._moveReorderId(id, -1));
      row.querySelector('[data-move="down"]').addEventListener('click', () => this._moveReorderId(id, 1));
      // Keyboard: arrows move the focused row
      row.tabIndex = 0;
      row.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowUp') { e.preventDefault(); this._moveReorderId(id, -1); }
        if (e.key === 'ArrowDown') { e.preventDefault(); this._moveReorderId(id, 1); }
      });
      // Drag & drop (desktop + mobile long-press via draggable fallback)
      row.addEventListener('dragstart', (e) => {
        this._dragReorderId = id;
        row.classList.add('dragging');
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      });
      row.addEventListener('dragend', () => {
        row.classList.remove('dragging');
        this._dragReorderId = null;
        listEl.querySelectorAll('.reorder-item').forEach((el) => el.classList.remove('dragging'));
      });
      row.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (this._dragReorderId == null || this._dragReorderId === id) return;
        const from = this._reorderIds.indexOf(this._dragReorderId);
        const to = this._reorderIds.indexOf(id);
        if (from < 0 || to < 0) return;
        this._reorderIds.splice(to, 0, this._reorderIds.splice(from, 1)[0]);
        this._reorderDirty = true;
        this._renderReorderList();
      });
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        this._dragReorderId = null;
      });
      listEl.appendChild(row);
    });
  },

  _moveReorderId(id, delta) {
    const from = this._reorderIds.indexOf(id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= this._reorderIds.length) return;
    const [moved] = this._reorderIds.splice(from, 1);
    this._reorderIds.splice(to, 0, moved);
    this._reorderDirty = true;
    this._renderReorderList();
    // Keep focus on the moved row for repeated keyboard moves
    const listEl = document.getElementById('reorder-list');
    const row = listEl && listEl.querySelector(`[data-id="${id}"]`);
    if (row) row.focus();
  },

  /**
   * Persist the working order. Only portfolios.sort_order changes —
   * holdings and transactions (keyed by portfolio_id) are untouched.
   */
  async _saveReorder() {
    if (!this._reorderIds || this._reorderIds.length === 0) {
      this._closeModal('reorder-modal');
      return;
    }
    const saveBtn = document.getElementById('reorder-save');
    if (saveBtn) saveBtn.disabled = true;
    try {
      await API.put('/portfolio/order', { ordered_ids: this._reorderIds });
      this._closeModal('reorder-modal');
      // loadPortfolios preserves activePortfolioId, so selection and all
      // transaction/position data stay on the same portfolio — just reordered.
      await this.loadPortfolios();
      this._syncReorderButton();
    } catch (err) {
      this._showError(err.message || 'Failed to save order');
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  },

  // ─── TICKER VALIDATION ───────────────────────────────

  /**
   * Validate ticker on blur — calls backend endpoint, shows status inline.
   * Uses cache to avoid redundant API calls. No regex fallback.
   *
   * @example
   *   User types "NVDA", tabs away → calls GET /api/validate-ticker/NVDA
   *   → shows ✓ NVIDIA Corp. · Technology
   */
  async _validateTickerOnBlur() {
    const status = document.getElementById('trade-ticker-validation');
    const info = document.getElementById('trade-ticker-info');
    const tickerInput = document.getElementById('trade-ticker');
    if (!status || !info || !tickerInput) return;

    clearTimeout(this._tickerValidationTimeout);

    let ticker = (tickerInput.value || '').trim();
    if (!ticker) {
      status.textContent = ''; status.className = 'ticker-validation';
      info.textContent = '';
      return;
    }
    ticker = ticker.toUpperCase();
    if (ticker.length < 2 || ticker.length > 10) {
      status.textContent = ''; status.className = 'ticker-validation';
      info.textContent = '';
      return;
    }

    // Check cache first
    if (this.tickerValidationCache[ticker]) {
      const cached = this.tickerValidationCache[ticker];
      status.textContent = cached.valid ? '\u2713' : '\u2717';
      status.className = 'ticker-validation ' + (cached.valid ? 'valid' : 'invalid');
      info.textContent = cached.valid ? cached.company + ' \u00B7 ' + cached.sector : '';
      return;
    }

    // Show loading spinner
    status.textContent = '\u27F3'; status.className = 'ticker-validation loading';
    info.textContent = '';

    try {
      const r = await API.get('/validate-ticker/' + encodeURIComponent(ticker));
      this.tickerValidationCache[ticker] = r;
      status.textContent = r.valid ? '\u2713' : '\u2717';
      status.className = 'ticker-validation ' + (r.valid ? 'valid' : 'invalid');
      info.textContent = r.valid ? r.company + ' \u00B7 ' + r.sector : '';
    } catch (e) {
      status.textContent = '?'; status.className = 'ticker-validation invalid';
      info.textContent = '';
    }
  },

  // ─── SECTOR PANEL ────────────────────────────────────

  /**
   * Toggle sector panel collapse.
   */
  _toggleSectorPanel() {
    const toggle = document.getElementById('sector-toggle');
    const body = document.getElementById('sector-body');
    if (!toggle || !body) return;

    const expanded = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', String(!expanded));
    body.classList.toggle('collapsed', expanded);
  },

  // ─── UI HELPERS ──────────────────────────────────────

  // ─── CURRENCY CONVERSION (Issue 3) ────────────────────

  /**
   * Convert a value from one currency to another using the CAD rate.
   * @param {number} value
   * @param {string} fromCurrency - 'USD' or 'CAD'
   * @param {string} toCurrency - 'USD' or 'CAD'
   * @returns {number}
   */
  _convertToDisplay(value, fromCurrency, toCurrency) {
    if (fromCurrency === toCurrency) return value;
    if (this.cadRate === null) return value; // Cannot convert without rate
    if (toCurrency === 'CAD' && fromCurrency === 'USD') return value * this.cadRate;
    if (toCurrency === 'USD' && fromCurrency === 'CAD') return value / this.cadRate;
    return value;
  },

  /**
   * Get the display currency for the currently active portfolio.
   * @returns {string} 'USD' or 'CAD'
   */
  _getPortfolioDisplayCurrency() {
    const portfolio = this.portfolios.find(p => p.id === this.activePortfolioId);
    return portfolio ? portfolio.currency : 'USD';
  },

  /**
   * Calculate portfolio statistics.
   * @param {Array<Object>} positions
   * @returns {Object}
   */
  _calculateStats(positions) {
    const costBasis = positions.reduce((s, p) => s + (p.avg_price || 0) * (p.qty || 0), 0);
    const marketValue = positions.reduce((s, p) => s + (p.current_price || 0) * (p.qty || 0), 0);
    const unrealizedPnl = marketValue - costBasis;
    const cash = this.portfolios.find((p) => p.id === this.activePortfolioId)?.cash || 0;

    // Calculate day change from change_pct with division-by-zero guard
    const dayChange = positions.reduce((s, p) => {
      if (p.current_price == null || p.change_pct == null) return s;
      const changePct = p.change_pct;
      // Guard against division by zero (change_pct = -100%) or negative divisor
      if (1 + changePct / 100 <= 0) return s;
      const prevClose = p.current_price / (1 + changePct / 100);
      return s + (p.qty || 0) * prevClose * (changePct / 100);
    }, 0);

    return { costBasis, marketValue, unrealizedPnl, cash, dayChange };
  },

  /**
   * Format number with commas and 2 decimal places.
   * @param {number} n
   * @returns {string}
   */
  _formatNumber(n) {
    return Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  },

  /** Format share counts for display without changing stored fractional quantities. */
  _formatShareQty(qty) {
    const value = Number(qty);
    return Number.isFinite(value) ? value.toLocaleString('en-US', { maximumFractionDigits: 4 }) : '—';
  },

  /**
   * Build the V1 cycle-stats tooltip for a position (title + aria-label).
   *
   * Locked format: Original $X − Recovered $Y | Basis $Z @ $A | Total return $T
   *   X = original cycle cost (unrecovered + cash recovered = total bought)
   *   Y = cash recovered (total sold in the cycle)
   *   Z = remaining avg-cost basis left (qty_rem x avg buy)
   *   A = position average price
   *   T = combined return: realized cycle + live unrealized when priced,
   *       else realized alone. Backend total_return_cycle is realized-only
   *       by design (no market price in compute_cycle); adding the live
   *       unrealized leg makes the mock-row total read 275 + 275 = 550.
   * Zero-history rows (has_cycle_history === false) get a fallback
   * explainer prefix; backend sends unrecovered=total_investment,
   * realized=0, breakeven=avg_price in that case.
   *
   * @param {Object} pos - Position with backend cycle fields
   * @param {number|null} unreal - Live unrealized P/L dollars (null when unpriced)
   * @returns {string} Plain-text tooltip
   */
  _cycleTooltip(pos, unreal) {
    const fmt = (n) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const unrec = pos.unrecovered_capital ?? 0;
    const cashRec = pos.cash_recovered ?? 0;
    const remBasis = pos.remaining_basis ?? 0;
    const avg = pos.avg_price ?? 0;
    const realized = pos.realized_pnl_cycle ?? 0;
    const combined = Number(realized) + (unreal ?? 0);
    const sign = combined >= 0 ? '+' : '-';
    const tip = 'Original $' + fmt(Number(unrec) + Number(cashRec)) + ' − Recovered $' + fmt(cashRec) + ' | Basis $' + fmt(remBasis) + ' @ $' + fmt(avg) + ' | Total return ' + sign + '$' + fmt(Math.abs(combined));
    if (pos.has_cycle_history === false) {
      return 'No transaction history — cost-basis fallback. ' + tip;
    }
    return tip;
  },

  /**
   * Set text content of an element by ID.
   * @param {string} id
   * @param {string} text
   */
  _setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  },

  /**
   * Build the full display text for a position's notes cell.
   * Combines the earnings date prefix with user notes.
   * @param {Object} pos - Position object with ticker and notes
   * @returns {string} Combined display text
   */
  _buildNotesDisplay(pos) {
    const earningsInfo = this._earningsDates?.[pos.ticker];
    const nextDate = earningsInfo?.next;
    let displayText = '';
    if (nextDate) {
      displayText = nextDate.pending
        ? `Earnings ${nextDate.display || ''} (results pending)`
        : `Next earnings: ${nextDate.display || ''}`;
    }
    if (pos.notes) {
      displayText = displayText ? `${displayText}\n${pos.notes}` : pos.notes;
    }
    return displayText;
  },

  /**
   * Render the notes cell content as HTML with earnings prefix styled separately.
   * @param {Object} pos - Position object with ticker and notes
   * @returns {string} HTML string for the notes cell
   */
  _renderNotesContent(pos) {
    const earningsInfo = this._earningsDates?.[pos.ticker];
    const hasEarnings = !!earningsInfo?.next;
    const hasNotes = !!pos.notes;

    if (!hasEarnings && !hasNotes) {
      return '<span class="notes-placeholder">+ Add note</span>';
    }

    let html = '';
    if (hasEarnings) {
      const pending = !!earningsInfo.next?.pending;
      const label = pending
        ? `Earnings ${this._escapeHtml(earningsInfo.next?.display || '')} (results pending)`
        : `Next earnings: ${this._escapeHtml(earningsInfo.next?.display || '')}`;
      html += `<span class="notes-earnings-prefix">${label}</span>`;
    }
    if (hasNotes) {
      if (hasEarnings) html += '<br>';
      html += `<span class="notes-user-text">${this._escapeHtml(pos.notes)}</span>`;
    }
    return html;
  },

  /**
   * Close the new portfolio dropdown.
   */
  _closeDropdown() {
    const dropdown = document.getElementById('new-portfolio-dropdown');
    const addBtn = document.getElementById('add-portfolio-btn');
    if (dropdown) dropdown.classList.remove('open');
    if (addBtn) addBtn.setAttribute('aria-expanded', 'false');
  },

  /**
   * Toggle the mobile portfolio dropdown open/close.
   */
  _togglePortfolioDropdown() {
    const trigger = document.getElementById('portfolio-tabs-dropdown');
    const menu = document.getElementById('portfolio-dropdown-menu');
    if (!trigger || !menu) return;

    const isOpen = trigger.classList.contains('open');
    if (isOpen) {
      this._closePortfolioDropdown();
    } else {
      trigger.classList.add('open');
      menu.classList.add('open');
      trigger.setAttribute('aria-expanded', 'true');
    }
  },

  /**
   * Close the mobile portfolio dropdown.
   */
  _closePortfolioDropdown() {
    const trigger = document.getElementById('portfolio-tabs-dropdown');
    const menu = document.getElementById('portfolio-dropdown-menu');
    if (trigger) {
      trigger.classList.remove('open');
      trigger.setAttribute('aria-expanded', 'false');
    }
    if (menu) menu.classList.remove('open');
  },

  /**
   * Close a modal by ID.
   * @param {string} modalId
   */
  _closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) modal.classList.remove('open');
    document.body.style.overflow = '';
  },

  /**
   * Close all open modals.
   */
  _closeAllModals() {
    ChartModal.close();
    ['position-modal', 'move-modal', 'delete-modal', 'reorder-modal'].forEach((id) => this._closeModal(id));
    // Alerts panel is now global (App._closeAlertsPanel)
    if (typeof App !== 'undefined' && App._closeAlertsPanel) {
      App._closeAlertsPanel();
    }
    this._closeDropdown();
    this._closePortfolioDropdown();
  },

  /**
   * Show skeleton loading state.
   */
  _showSkeleton() {
    const sk = document.getElementById('skeleton-view');
    const mv = document.getElementById('main-view');
    const banner = document.getElementById('error-banner');
    if (sk) sk.classList.add('visible');
    if (mv) mv.style.display = 'none';
    if (banner) banner.classList.remove('visible');
  },

  /**
   * Hide skeleton loading state.
   */
  _hideSkeleton() {
    const sk = document.getElementById('skeleton-view');
    const mv = document.getElementById('main-view');
    if (sk) sk.classList.remove('visible');
    if (mv) mv.style.display = '';
  },

  /**
   * Show inline empty state within the positions section.
   * Hides table, stats bar, trade form, action bar, and sidebar.
   */
  _showEmptyState() {
    this._renderCash();
    const inlineEmpty = document.getElementById('positions-inline-empty');
    const tableWrapper = document.querySelector('.positions-table-wrapper');
    if (inlineEmpty) inlineEmpty.style.display = '';
    if (tableWrapper) tableWrapper.style.display = 'none';
    // Hide other sections that don't make sense with no portfolio
    const statsBar = document.getElementById('stats-bar');
    const tradeForm = document.getElementById('trade-form');
    const actionBar = document.querySelector('.action-bar');
    const sidebar = document.querySelector('.content-grid aside');
    if (statsBar) statsBar.style.display = 'none';
    if (tradeForm) tradeForm.style.display = 'none';
    if (actionBar) actionBar.style.display = 'none';
    if (sidebar) sidebar.style.display = 'none';
  },

  /**
   * Hide inline empty state and restore the full portfolio view.
   */
  _hideEmptyState() {
    const inlineEmpty = document.getElementById('positions-inline-empty');
    const tableWrapper = document.querySelector('.positions-table-wrapper');
    if (inlineEmpty) inlineEmpty.style.display = 'none';
    if (tableWrapper) tableWrapper.style.display = '';
    const statsBar = document.getElementById('stats-bar');
    const tradeForm = document.getElementById('trade-form');
    const actionBar = document.querySelector('.action-bar');
    const sidebar = document.querySelector('.content-grid aside');
    if (statsBar) statsBar.style.display = '';
    if (tradeForm) tradeForm.style.display = '';
    if (actionBar) actionBar.style.display = '';
    if (sidebar) sidebar.style.display = '';
  },

  /**
   * Show an inline error message inside a container element.
   * @param {string} containerId - ID of the container to show error in
   * @param {string} message - Error message to display
   * @param {Function|null} retryFn - Optional retry function
   */
  _showInlineError(containerId, message, retryFn) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const retryId = 'retry-' + containerId + '-' + Date.now();
    container.innerHTML = `
      <div class="error-message" role="alert">
        <p class="error-text">${this._escapeHtml(message)}</p>
        ${retryFn ? `<button class="retry-btn" id="${retryId}">Retry</button>` : ''}
      </div>
    `;

    if (retryFn) {
      const retryBtn = document.getElementById(retryId);
      if (retryBtn) {
        retryBtn.addEventListener('click', () => {
          container.innerHTML = '';
          retryFn();
        });
      }
    }
  },

  /**
   * Show error banner.
   * @param {string} message
   */
  _showError(message) {
    const banner = document.getElementById('error-banner');
    if (banner) {
      const msgEl = banner.querySelector('.error-banner-message');
      if (msgEl) msgEl.textContent = message;
      banner.classList.add('visible');
    }
  },

  /**
   * Show CAD rate warning banner.
   */
  _showCadRateWarning() {
    const banner = document.getElementById('cad-rate-warning');
    if (banner) banner.classList.add('visible');
  },

  /**
   * Hide CAD rate warning banner.
   */
  _hideCadRateWarning() {
    const banner = document.getElementById('cad-rate-warning');
    if (banner) banner.classList.remove('visible');
  },

  /**
   * Show position form validation error.
   * @param {string} errorId
   */
  _showPositionError(errorId) {
    const el = document.getElementById(errorId);
    if (el) el.classList.add('visible');
  },

  /**
   * Clear all position form validation errors.
   */
  _clearPositionFormErrors() {
    document.querySelectorAll('.position-form-error').forEach((el) => el.classList.remove('visible'));
    document.querySelectorAll('.position-form-input').forEach((el) => el.classList.remove('has-error'));
  },
  _ensureLightCharts: ensureLightCharts,
  _escapeHtml: escapeHtml,
};

// Retain the Portfolio screen API for existing application integrations.
window.Portfolio = Portfolio;

// ES module export for app.js dynamic import
export default Portfolio;

// CommonJS fallback (for Node/testing)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = Portfolio;
}
