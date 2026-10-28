/**
 * Transactions — Transaction ledger & realized P/L tracking screen module.
 *
 * Manages portfolio tabs, realized P/L summary by ticker, and a full
 * transaction ledger with edit/delete capabilities.
 *
 * API endpoints:
 *   GET    /api/portfolio                              — list portfolios
 *   GET    /api/portfolio/:id/transactions              — list transactions (paginated)
 *   GET    /api/portfolio/:id/profit-summary             — realized P/L by ticker
 *   POST   /api/portfolio/:id/transactions              — add a transaction
 *   PUT    /api/portfolio/:id/transactions/:tid          — edit transaction (date, qty, price, notes)
 *   DELETE /api/portfolio/:id/transactions/:tid          — delete transaction
 *
 * @example
 *   // Called by App.loadScreen('transactions')
 *   Transactions.init();
 */

import ChartModal from '../components/chart-modal.js';
import TradingActivity from '../components/trading-activity.js';

const Transactions = {
  /** @type {Array<Object>} List of portfolios */
  portfolios: [],

  /** @type {number|null} Active portfolio ID */
  activePortfolioId: null,

  /** @type {Array<Object>} Current transactions (active portfolio only) */
  transactions: [],

  /** @type {Array<Object>} Profit summary by ticker */
  profitSummary: [],

  realizedTrades: [],
  realizedTradesPage: 1,
  realizedTradesTotal: 0,
  realizedTradesPages: 1,
  realizedTradesSort: 'sell_date:desc',
  realizedTradesError: false,
  bestTrade: null,
  worstTrade: null,

  /** @type {boolean} */
  loading: false,

  /** @type {number} Current page (1-indexed) */
  currentPage: 1,

  /** @type {number} Transactions per page */
  perPage: 10,

  /** @type {number} Total pages from API */
  totalPages: 1,

  /** @type {number} Total transactions across all pages */
  totalTransactions: 0,

  /** @type {number} Current profit summary page (1-indexed) */
  profitSummaryPage: 1,

  /** @type {number} Profit summary items per page */
  profitSummaryPerPage: 10,

  /** @type {Array<Object>} All transactions (unpaginated) */
  allTransactions: [],

  /** @type {number|null} Selected year for the monthly P/L heatmap */
  selectedYear: null,

  tradingActivity: null,

  /** @type {Object|null} Transaction currently being edited */
  editingTransaction: null,

  /** @type {Function|null} Stored document click handler ref for cleanup */
  _docClickHandler: null,

  /** @type {Function|null} Stored document keydown handler ref for cleanup */
  _docKeyHandler: null,

  /** @type {Object} Cache for ticker validation results */
  tickerValidationCache: {},

  /** @type {number|null} Debounce timeout for add-form ticker validation */
  _addFormTickerValidationTimeout: null,

  // ─── LIFECYCLE ─────────────────────────────────────

  /**
   * Initialize the Transactions screen.
   */
  async init() {
    console.log('[Transactions] initialized');
    this.bindEvents();
    this._bindAddForm();
    const activityRoot = document.getElementById('trading-activity');
    if (activityRoot) this.tradingActivity = new TradingActivity(activityRoot);
    await this.loadPortfolios();
  },

  /**
   * Destroy the Transactions module — clean up event listeners.
   * Called by App.loadScreen() before loading a different screen.
   */
  destroy() {
    this.tradingActivity?.destroy();
    this.tradingActivity = null;
    ChartModal.destroy();
    if (this._docClickHandler) {
      document.removeEventListener('click', this._docClickHandler);
      this._docClickHandler = null;
    }
    if (this._docKeyHandler) {
      document.removeEventListener('keydown', this._docKeyHandler);
      this._docKeyHandler = null;
    }
    clearTimeout(this._addFormTickerValidationTimeout);
    this._addFormTickerValidationTimeout = null;
    // Reset state
    this.editingTransaction = null;
    this.portfolios = [];
    this.activePortfolioId = null;
    this.transactions = [];
    this.profitSummary = [];
    this.realizedTrades = [];
    this.realizedTradesPage = 1;
    this.realizedTradesTotal = 0;
    this.realizedTradesPages = 1;
    this.realizedTradesSort = 'sell_date:desc';
    this.realizedTradesError = false;
    this.bestTrade = null;
    this.worstTrade = null;
    this.avgReturnPct = 0;
    this.selectedYear = null;
    this.currentPage = 1;
    this.profitSummaryPage = 1;
    this.totalTransactions = 0;
    this.allTransactions = [];
    this.tickerValidationCache = {};
  },

  // ─── EVENT BINDING ──────────────────────────────────

  /**
   * Bind all screen-specific event listeners.
   */
  bindEvents() {
    ChartModal.bind();
    document.querySelectorAll('[data-trade-sort]').forEach((header) => {
      const sort = async () => {
        const column = header.dataset.tradeSort;
        const [current, direction] = this.realizedTradesSort.split(':');
        const next = current === column ? (direction === 'asc' ? 'desc' : 'asc')
          : (['ticker', 'company'].includes(column) ? 'asc' : 'desc');
        this.realizedTradesSort = `${column}:${next}`;
        this.realizedTradesPage = 1;
        await this.loadRealizedTrades(this.activePortfolioId);
        this._renderRealizedTrades();
        this._renderStats();
      };
      header.addEventListener('click', sort);
      header.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          sort();
        }
      });
    });
    // Mobile portfolio dropdown trigger
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

    // Close dropdown on outside click
    this._docClickHandler = (e) => {
      if (!e.target.closest('#portfolio-tabs-dropdown') && !e.target.closest('#portfolio-dropdown-menu')) {
        this._closePortfolioDropdown();
      }
    };
    document.addEventListener('click', this._docClickHandler);

    // Retry button
    const retryBtn = document.getElementById('retry-btn');
    if (retryBtn) {
      retryBtn.addEventListener('click', () => this.loadPortfolios());
    }

    // Year heatmap navigation
    const yearPrev = document.getElementById('year-prev');
    if (yearPrev) {
      yearPrev.addEventListener('click', () => this._changeYear(-1));
    }
    const yearNext = document.getElementById('year-next');
    if (yearNext) {
      yearNext.addEventListener('click', () => this._changeYear(1));
    }

    // Empty state "Go to Portfolio" button
    const emptyGotoBtn = document.getElementById('empty-goto-portfolio');
    if (emptyGotoBtn) {
      emptyGotoBtn.addEventListener('click', () => {
        if (typeof App !== 'undefined') {
          App.loadScreen('portfolio');
        }
      });
    }

    // Edit modal: close
    const modalClose = document.getElementById('edit-modal-close');
    if (modalClose) {
      modalClose.addEventListener('click', () => this._closeEditModal());
    }

    // Edit modal: cancel
    const editCancel = document.getElementById('edit-tx-cancel');
    if (editCancel) {
      editCancel.addEventListener('click', () => this._closeEditModal());
    }

    // Edit modal: save
    const editSave = document.getElementById('edit-tx-save');
    if (editSave) {
      editSave.addEventListener('click', () => this._saveEdit());
    }

    // Edit modal: notes char count
    const notesTextarea = document.getElementById('edit-tx-notes');
    const charCount = document.getElementById('notes-char-count');
    if (notesTextarea && charCount) {
      notesTextarea.addEventListener('input', () => {
        charCount.textContent = String(notesTextarea.value.length);
      });
    }

    // Edit modal: qty/price auto-update total
    const editQtyInput = document.getElementById('edit-tx-qty');
    const editPriceInput = document.getElementById('edit-tx-price');
    const editTotalDisplay = document.getElementById('edit-tx-total');
    const updateEditTotal = () => {
      const q = parseFloat(editQtyInput ? editQtyInput.value : '') || 0;
      const p = parseFloat(editPriceInput ? editPriceInput.value : '') || 0;
      if (editTotalDisplay) {
        editTotalDisplay.textContent = '$' + (q * p).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      }
    };
    if (editQtyInput) editQtyInput.addEventListener('input', updateEditTotal);
    if (editPriceInput) editPriceInput.addEventListener('input', updateEditTotal);

    // Hidden date inputs: sync formatted display on change
    const editDateInput = document.getElementById('edit-tx-date');
    const editDateDisplay = document.getElementById('edit-tx-date-display');
    if (editDateInput && editDateDisplay) {
      editDateInput.addEventListener('change', () => {
        editDateDisplay.textContent = editDateInput.value ? this._formatDate(editDateInput.value) : '';
      });
      editDateDisplay.addEventListener('click', () => {
        editDateInput.showPicker();
      });
      editDateDisplay.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); editDateInput.showPicker(); }
      });
    }
    const addDateInput = document.getElementById('add-tx-date');
    const addDateDisplay = document.getElementById('add-tx-date-display');
    if (addDateInput && addDateDisplay) {
      addDateInput.addEventListener('change', () => {
        addDateDisplay.textContent = addDateInput.value ? this._formatDate(addDateInput.value) : '';
      });
      addDateDisplay.addEventListener('click', () => {
        addDateInput.showPicker();
      });
      addDateDisplay.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); addDateInput.showPicker(); }
      });
    }

    // Escape key closes modals
    this._docKeyHandler = (e) => {
      if (e.key === 'Escape') {
        this._closeEditModal();
      }
    };
    document.addEventListener('keydown', this._docKeyHandler);

    // Click on modal backdrop closes modal
    const modalBackdrop = document.getElementById('edit-transaction-modal');
    if (modalBackdrop) {
      modalBackdrop.addEventListener('click', (e) => {
        if (e.target === modalBackdrop) {
          this._closeEditModal();
        }
      });
    }
  },

  // ─── DATA LOADING ───────────────────────────────────

  /**
   * Load all portfolios from API.
   */
  async loadPortfolios() {
    this.loading = true;
    this._showLoading();
    this._hideError();
    this._hideEmpty();

    try {
      this.portfolios = await API.get('/portfolio');
    } catch (err) {
      console.error('[Transactions] Failed to load portfolios:', err.message);
      this._hideLoading();
      this._showError('Failed to load portfolios. Please check your connection and try again.');
      this.loading = false;
      return;
    }

    this._hideLoading();

    if (this.portfolios.length > 0) {
      this._hideEmpty();
      this._showMainView();
      this._renderTabs();
      const firstId = this.portfolios[0].id;
      await this.selectPortfolio(firstId);
    } else {
      this._showEmpty();
      this._hideMainView();
    }

    this.loading = false;
  },

  /**
   * Load transactions for a specific portfolio.
   * @param {number} portfolioId
   */
  async loadTransactions(portfolioId) {
    this._showLoading();
    this._hideError();
    try {
      const data = await API.get(`/portfolio/${portfolioId}/transactions`, {
        per_page: 99999,  // Fetch all transactions for client-side pagination
      });
      this.allTransactions = Array.isArray(data.transactions) ? data.transactions : [];
      this.transactions = this.allTransactions;
    } catch (err) {
      console.error('[Transactions] Failed to load transactions:', err.message);
      this.allTransactions = [];
      this.transactions = [];
      this._hideLoading();
      this._showError('Failed to load transactions. Please try again.');
      return;
    }
  },

  /**
   * Load profit summary for a specific portfolio.
   * @param {number} portfolioId
   */
  async loadProfitSummary(portfolioId) {
    try {
      const summary = await API.get(`/portfolio/${portfolioId}/profit-summary`);
      this.profitSummary = Array.isArray(summary.summary) ? summary.summary : [];
      this.avgReturnPct = summary.avg_return_pct ?? 0;
    } catch (err) {
      console.error('[Transactions] Failed to load profit summary:', err.message);
      this.profitSummary = [];
      this.avgReturnPct = 0;
    }
  },

  async loadRealizedTrades(portfolioId) {
    const page = this.realizedTradesPage;
    const sort = this.realizedTradesSort;
    try {
      const data = await API.get(`/portfolio/${portfolioId}/realized-trades`, {
        page, per_page: 10, sort,
      });
      if (this.activePortfolioId !== portfolioId || this.realizedTradesPage !== page || this.realizedTradesSort !== sort) return;
      this.realizedTrades = data.trades || [];
      this.realizedTradesPage = data.page;
      this.realizedTradesTotal = data.total;
      this.realizedTradesPages = data.total_pages;
      this.bestTrade = data.best_trade;
      this.worstTrade = data.worst_trade;
      this.realizedTradesError = false;
    } catch (err) {
      if (this.activePortfolioId !== portfolioId || this.realizedTradesPage !== page || this.realizedTradesSort !== sort) return;
      this.realizedTrades = [];
      this.realizedTradesTotal = 0;
      this.realizedTradesPages = 1;
      this.bestTrade = null;
      this.worstTrade = null;
      this.realizedTradesError = true;
    }
  },

  _renderRealizedTrades() {
    const tbody = document.getElementById('realized-trades-tbody');
    if (!tbody) return;
    const [column, direction] = this.realizedTradesSort.split(':');
    document.querySelectorAll('[data-trade-sort]').forEach((header) => {
      const active = header.dataset.tradeSort === column;
      header.classList.toggle('sorted-asc', active && direction === 'asc');
      header.classList.toggle('sorted-desc', active && direction === 'desc');
      header.setAttribute('aria-sort', active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none');
    });
    this._setText('realized-trades-count', `${this.realizedTradesTotal} sales`);
    tbody.innerHTML = this.realizedTrades.length ? this.realizedTrades.map((trade) => {
      const up = trade.realized_pnl >= 0;
      const sign = up ? '+' : '';
      const pct = trade.realized_pnl_pct == null ? '—' : `${sign}${this._formatPct(trade.realized_pnl_pct)}`;
      return `<tr>
        <td>${this._escapeHtml(this._formatDate(trade.sell_date))}</td>
        <td><span class="ticker-cell">${ChartModal.button(trade.ticker, trade.company).outerHTML}</span></td>
        <td class="company-column"><span class="company-name">${this._escapeHtml(trade.company || '')}</span></td>
        <td class="text-right">${trade.qty_sold}</td>
        <td class="text-right">${this._formatCurrency(trade.avg_buy_price)}</td>
        <td class="text-right">${this._formatCurrency(trade.sell_price)}</td>
        <td class="text-right"><span class="pnl-value ${up ? 'up' : 'down'}">${sign}${this._formatCurrency(trade.realized_pnl)}</span></td>
        <td class="text-right"><span class="pnl-pct ${up ? 'up' : 'down'}">${pct}</span></td>
      </tr>`;
    }).join('') : `<tr><td colspan="8" style="text-align:center;padding:var(--space-8);color:var(--color-text-secondary)">
      ${this.realizedTradesError ? 'Unable to load saved sales. Please retry.' : 'No saved sales yet. Your next Portfolio sell will appear here.'}
    </td></tr>`;
    const start = (this.realizedTradesPage - 1) * 10;
    this._setText('realized-trades-page-info', this.realizedTradesTotal
      ? `Showing ${start + 1}-${Math.min(start + 10, this.realizedTradesTotal)} of ${this.realizedTradesTotal} sales`
      : (this.realizedTradesError ? 'Load failed' : '0 sales'));
    const buttons = document.getElementById('realized-trades-page-btns');
    if (!buttons) return;
    let html = `<button class="pagination-btn" data-page="prev" aria-label="Previous sales page"${this.realizedTradesPage <= 1 ? ' disabled' : ''}>&#8249;</button>`;
    for (let i = 1; i <= this.realizedTradesPages; i++) {
      if (this.realizedTradesPages > 7 && i > 2 && i < this.realizedTradesPages - 1 && Math.abs(i - this.realizedTradesPage) > 1) {
        if (i === 3 || i === this.realizedTradesPages - 2) html += '<button class="pagination-btn" disabled>...</button>';
        continue;
      }
      html += `<button class="pagination-btn${i === this.realizedTradesPage ? ' active' : ''}" data-page="${i}">${i}</button>`;
    }
    html += `<button class="pagination-btn" data-page="next" aria-label="Next sales page"${this.realizedTradesPage >= this.realizedTradesPages ? ' disabled' : ''}>&#8250;</button>`;
    buttons.innerHTML = this.realizedTradesError
      ? '<button class="pagination-btn" data-page="retry">Retry</button>' : html;
    buttons.onclick = async (e) => {
      const button = e.target.closest('button[data-page]');
      if (!button || button.disabled) return;
      const page = button.dataset.page;
      if (page === 'next') this.realizedTradesPage++;
      else if (page === 'prev') this.realizedTradesPage--;
      else if (page !== 'retry') this.realizedTradesPage = Number(page);
      await this.loadRealizedTrades(this.activePortfolioId);
      this._renderRealizedTrades();
      this._renderStats();
    };
  },

  // ─── RENDERING: PORTFOLIO TABS ──────────────────────

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
           aria-label="Portfolio: ${this._escapeHtml(p.name)} (${p.currency})">
        <span class="tab-drag" aria-hidden="true">&#x2801;</span>
        ${this._escapeHtml(p.name)}
        <span class="tab-currency">${p.currency}</span>
      </div>
    `
      )
      .join('');

    // Bind tab click events
    container.querySelectorAll('.portfolio-tab-group').forEach((tab) => {
      tab.addEventListener('click', () => {
        this.selectPortfolio(Number(tab.dataset.portfolioId));
      });
      tab.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this.selectPortfolio(Number(tab.dataset.portfolioId));
        }
      });
    });

    // Render mobile dropdown
    this._renderMobileDropdown();
  },

  /**
   * Render the mobile portfolio dropdown.
   */
  _renderMobileDropdown() {
    const menu = document.getElementById('portfolio-dropdown-menu');
    if (!menu) return;

    menu.innerHTML = '';

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
  },

  /**
   * Sync the mobile dropdown label to match the active portfolio.
   */
  _syncDropdownToActivePortfolio() {
    const label = document.getElementById('dropdown-selected-name');
    if (!label || this.activePortfolioId === null) return;

    const active = this.portfolios.find((p) => p.id === this.activePortfolioId);
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

  /**
   * Toggle the mobile portfolio dropdown.
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

  // ─── RENDERING: STATS BAR ───────────────────────────

  /**
   * Update the stats bar from profit summary data.
   */
  _renderStats() {
    const summary = this.profitSummary;

    // Total Realized P/L
    const totalPnl = summary.reduce((s, item) => s + (item.realized_pnl || 0), 0);
    const totalPnlEl = document.getElementById('stat-realized-pl');
    if (totalPnlEl) {
      const sign = totalPnl >= 0 ? '+' : '';
      totalPnlEl.textContent = `${sign}${this._formatCurrency(totalPnl)}`;
      totalPnlEl.className = 'stats-bar-value ' + (totalPnl >= 0 ? 'up' : 'down');
    }

    // Average Return %
    const avgReturn = this.avgReturnPct ?? 0;
    const avgReturnEl = document.getElementById('stat-avg-return');
    if (avgReturnEl) {
      const sign = avgReturn >= 0 ? '+' : '';
      avgReturnEl.textContent = `${sign}${this._formatPct(avgReturn)}`;
      avgReturnEl.className = 'stats-bar-value ' + (avgReturn >= 0 ? 'up' : 'down');
    }

    // Total Trades
    const totalTrades = summary.reduce((s, item) => s + (item.trade_count || 0), 0);
    this._setText('stat-total-trades', String(totalTrades));

    // Profitable Tickers
    const profitableTickers = summary.filter((item) => (item.realized_pnl || 0) > 0).length;
    const totalTickers = summary.length;
    this._setText('stat-profitable-tickers', `${profitableTickers} of ${totalTickers}`);

    // Best Trade
    const bestTrade = this.bestTrade;
    const bestTradeEl = document.getElementById('stat-best-trade');
    if (bestTradeEl) {
      if (bestTrade) {
        this._bestWorstCell(bestTradeEl, bestTrade);
      } else {
        bestTradeEl.textContent = '--';
        bestTradeEl.className = 'stats-bar-value';
        bestTradeEl.removeAttribute('title');
      }
    }

    // Worst Trade
    const worstTrade = this.worstTrade;
    const worstTradeEl = document.getElementById('stat-worst-trade');
    if (worstTradeEl) {
      if (worstTrade) {
        this._bestWorstCell(worstTradeEl, worstTrade);
      } else {
        worstTradeEl.textContent = '--';
        worstTradeEl.className = 'stats-bar-value';
        worstTradeEl.removeAttribute('title');
      }
    }

    // Summary meta (header)
    const metaEl = document.getElementById('transactions-summary-meta');
    if (metaEl) {
      const sign = totalPnl >= 0 ? '+' : '';
      metaEl.textContent = `${totalTrades} trades across ${totalTickers} tickers — ${sign}${this._formatCurrency(totalPnl)} realized`;
    }
  },

  // ─── RENDERING: YEAR HEATMAP (monthly realized P/L) ──

  /**
   * Month labels for the year heatmap (Jan–Dec).
   * @type {Array<string>}
   */
  _heatmapMonths: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],

  /**
   * Change the selected heatmap year by a delta, clamped to
   * [earliest transaction year, current calendar year].
   * @param {number} delta -1 or +1
   */
  _changeYear(delta) {
    const nowYear = new Date().getFullYear();
    if (this.selectedYear === null) this.selectedYear = nowYear;
    let next = this.selectedYear + delta;
    if (next > nowYear) next = nowYear;
    const minYear = this._heatmapMinYear();
    if (next < minYear) next = minYear;
    if (next === this.selectedYear) return;
    this.selectedYear = next;
    this._renderYearHeatmap();
  },

  /**
   * Earliest transaction year in the active portfolio,
   * falling back to the selected or current year.
   * @returns {number}
   */
  _heatmapMinYear() {
    let min = Infinity;
    for (const tx of this.allTransactions || []) {
      const d = tx.date || '';
      if (/^\d{4}-\d{2}-\d{2}/.test(d)) {
        const y = Number(d.slice(0, 4));
        if (y < min) min = y;
      }
    }
    if (min === Infinity) {
      return this.selectedYear ?? new Date().getFullYear();
    }
    return min;
  },

  /**
   * Calculate monthly realized P/L for a year using the SELL-date
   * simple method: each SELL contributes
   * qty_sold × (sell_price − ticker lifetime avg_buy_price),
   * bucketed by the SELL date. Matches profit-summary totals.
   * @param {number} year
   * @returns {{ monthly: Array<number>, counts: Array<number> }}
   */
  _calcMonthlyPnl(year) {
    const monthly = new Array(12).fill(0);
    const counts = new Array(12).fill(0);

    // Lifetime average buy price per ticker (prefer profit-summary,
    // fall back to raw transactions when summary is unavailable).
    const avgBuyMap = {};
    if (Array.isArray(this.profitSummary) && this.profitSummary.length > 0) {
      for (const item of this.profitSummary) {
        if (item.ticker) avgBuyMap[item.ticker] = item.avg_buy_price || 0;
      }
    } else {
      const bought = {};
      const qtyBought = {};
      for (const tx of this.allTransactions || []) {
        if ((tx.type || '').toUpperCase() !== 'BUY') continue;
        const t = tx.ticker;
        bought[t] = (bought[t] || 0) + (tx.qty || 0) * (tx.price || 0);
        qtyBought[t] = (qtyBought[t] || 0) + (tx.qty || 0);
      }
      for (const t of Object.keys(bought)) {
        avgBuyMap[t] = qtyBought[t] > 0 ? bought[t] / qtyBought[t] : 0;
      }
    }

    for (const tx of this.allTransactions || []) {
      if ((tx.type || '').toUpperCase() !== 'SELL') continue;
      const d = tx.date || '';
      const m = /^(\d{4})-(\d{2})-\d{2}/.exec(d);
      if (!m) continue;
      if (Number(m[1]) !== year) continue;
      const monthIdx = Number(m[2]) - 1;
      if (monthIdx < 0 || monthIdx > 11) continue;
      const avg = avgBuyMap[tx.ticker] ?? 0;
      monthly[monthIdx] += (tx.qty || 0) * ((tx.price || 0) - avg);
      counts[monthIdx] += 1;
    }
    return { monthly, counts };
  },

  /**
   * Compact heatmap value: full $ below $10k, $12.3k-style above
   * to fit narrow month cells. Title tooltip always holds the full value.
   * @param {number} v
   * @returns {string}
   */
  _formatHeatValue(v) {
    const sign = v >= 0 ? '+' : '-';
    const abs = Math.abs(v);
    if (abs >= 10000) {
      const k = abs / 1000;
      const str = k >= 100
        ? Math.round(k).toLocaleString('en-US')
        : (Math.round(k * 10) / 10).toLocaleString('en-US');
      return `${sign}$${str}k`;
    }
    return `${sign}${this._formatCurrency(v)}`;
  },

  /**
   * Render the year heatmap grid for the active portfolio.
   * Display only — no filtering of the tables below.
   */
  _renderYearHeatmap() {
    const grid = document.getElementById('year-grid');
    const label = document.getElementById('year-label');
    if (!grid) return;

    const now = new Date();
    const nowYear = now.getFullYear();
    const nowMonth = now.getMonth();

    if (this.selectedYear === null) {
      const years = new Set();
      for (const tx of this.allTransactions || []) {
        const d = tx.date || '';
        if (/^\d{4}-\d{2}-\d{2}/.test(d)) years.add(Number(d.slice(0, 4)));
      }
      this.selectedYear = years.has(nowYear)
        ? nowYear
        : (years.size > 0 ? Math.max(...years) : nowYear);
    }

    const year = this.selectedYear;
    if (label) label.textContent = String(year);

    const prevBtn = document.getElementById('year-prev');
    const nextBtn = document.getElementById('year-next');
    const minYear = this._heatmapMinYear();
    if (prevBtn) prevBtn.disabled = year <= minYear;
    if (nextBtn) nextBtn.disabled = year >= nowYear;

    const { monthly, counts } = this._calcMonthlyPnl(year);

    // Year total → 13th TOTAL cell (amber shade, green/red value).
    const rawTotal = monthly.reduce((s, v) => s + v, 0);
    const total = Math.round(rawTotal);
    const totalSells = counts.reduce((s, n) => s + n, 0);
    const totalSign = rawTotal >= 0 ? '+' : '-';
    const totalCls = total > 0 ? 'up' : total < 0 ? 'down' : 'muted';
    const totalText = total === 0 ? '+$0' : this._formatHeatValue(rawTotal);
    const totalTitle = `Total realized P/L in ${year}: ${totalSign}${this._formatCurrency(rawTotal)} · ${totalSells} sell${totalSells !== 1 ? 's' : ''}`;
    const totalCell = `<div class="ym-cell total ${totalCls}" title="${this._escapeHtml(totalTitle)}">` +
      `<span class="ym-month">Total</span><span class="ym-value">${totalText}</span></div>`;

    grid.innerHTML = monthly.map((v, i) => {
      const month = this._heatmapMonths[i];
      const isFuture = year === nowYear && i > nowMonth;
      if (isFuture) {
        return `<div class="ym-cell future" title="${month} ${year} (upcoming)">` +
          `<span class="ym-month">${month}</span><span class="ym-value">--</span></div>`;
      }
      if (Math.abs(v) < 0.005) {
        return `<div class="ym-cell empty" title="No realized P/L in ${month} ${year}">` +
          `<span class="ym-month">${month}</span><span class="ym-value">--</span></div>`;
      }
      const cls = v > 0 ? 'up' : 'down';
      const sign = v >= 0 ? '+' : '-';
      const full = `${sign}${this._formatCurrency(v)} · ${counts[i]} sell${counts[i] !== 1 ? 's' : ''}`;
      return `<div class="ym-cell ${cls}" title="${month} ${year}: ${this._escapeHtml(full)}">` +
        `<span class="ym-month">${month}</span><span class="ym-value">${this._formatHeatValue(v)}</span></div>`;
    }).join('') + totalCell;
  },

  // ─── RENDERING: PROFIT SUMMARY TABLE ────────────────

  /**
   * Render the realized P/L by ticker table.
   */
  _renderProfitSummary() {
    const tbody = document.getElementById('profit-summary-tbody');
    const countEl = document.getElementById('profit-summary-count');
    if (!tbody) return;

    if (this.profitSummary.length === 0) {
      tbody.innerHTML = `
        <tr><td colspan="9" style="text-align:center;padding:var(--space-8);color:var(--color-text-secondary)">
          No realized gains yet. Sell a position to see P/L data here.
        </td></tr>`;
      if (countEl) countEl.textContent = '0 tickers';
      return;
    }

    // Sort by realized P/L descending
    const sorted = [...this.profitSummary].sort((a, b) => (b.realized_pnl || 0) - (a.realized_pnl || 0));

    // Paginate
    const totalItems = sorted.length;
    const start = (this.profitSummaryPage - 1) * this.profitSummaryPerPage;
    const paginatedItems = sorted.slice(start, start + this.profitSummaryPerPage);

    tbody.innerHTML = paginatedItems
      .map((item) => {
        const pnl = item.realized_pnl || 0;
        const qtyBought = item.qty_bought || 0;
        const qtySold = item.qty_sold || 0;
        const avgBuy = item.avg_buy_price || 0;
        const avgSell = item.avg_sell_price || 0;
        const numTrades = item.trade_count || 0;
        const totalBought = item.total_bought || 0;
        const pnlPct = item.realized_pnl_pct != null ? item.realized_pnl_pct : (totalBought > 0 ? ((pnl / totalBought) * 100) : 0);
        const up = pnl >= 0;

        return `
          <tr>
            <td><span class="ticker-cell">${ChartModal.button(item.ticker, item.company).outerHTML}</span></td>
            <td class="company-column"><span class="company-name">${this._escapeHtml(item.company || '')}</span></td>
            <td class="text-right">${qtyBought}</td>
            <td class="text-right">${qtySold}</td>
            <td class="text-right">$${avgBuy.toFixed(2)}</td>
            <td class="text-right">$${avgSell.toFixed(2)}</td>
            <td class="text-right"><span class="pnl-value ${up ? 'up' : 'down'}">${up ? '+' : ''}${this._formatCurrency(pnl)}</span></td>
            <td class="text-right"><span class="pnl-pct ${up ? 'up' : 'down'}">${up ? '+' : ''}${this._formatPct(pnlPct)}</span></td>
            <td class="text-right">${numTrades}</td>
          </tr>
        `;
      })
      .join('');

    if (countEl) {
      countEl.textContent = `${sorted.length} ticker${sorted.length !== 1 ? 's' : ''}`;
    }

    this._renderProfitSummaryPagination(totalItems);
  },

  /**
   * Render pagination controls for profit summary table.
   * @param {number} total - Total number of items
   */
  _renderProfitSummaryPagination(total) {
    const infoEl = document.getElementById('profit-summary-page-info');
    const btnsEl = document.getElementById('profit-summary-page-btns');
    if (!infoEl || !btnsEl) return;

    const perPage = this.profitSummaryPerPage;
    const totalPages = Math.max(1, Math.ceil(total / perPage));
    if (this.profitSummaryPage > totalPages) this.profitSummaryPage = totalPages;

    const start = (this.profitSummaryPage - 1) * perPage;
    const end = Math.min(start + perPage, total);

    infoEl.textContent = total > 0
      ? `Showing ${start + 1}-${end} of ${total} tickers`
      : '0 tickers';

    // Build page buttons with ellipsis
    let html = `<button class="pagination-btn" data-page="prev"${this.profitSummaryPage <= 1 ? ' disabled' : ''}>&#8249;</button>`;
    for (let i = 1; i <= totalPages; i++) {
      if (totalPages > 7 && i > 2 && i < totalPages - 1 && Math.abs(i - this.profitSummaryPage) > 1) {
        if (i === 3 || i === totalPages - 2) html += '<button class="pagination-btn" disabled>...</button>';
        continue;
      }
      html += `<button class="pagination-btn${i === this.profitSummaryPage ? ' active' : ''}" data-page="${i}">${i}</button>`;
    }
    html += `<button class="pagination-btn" data-page="next"${this.profitSummaryPage >= totalPages ? ' disabled' : ''}>&#8250;</button>`;
    btnsEl.innerHTML = html;

    // Bind click events
    btnsEl.onclick = (e) => {
      const btn = e.target.closest('.pagination-btn');
      if (!btn || btn.disabled) return;
      const pg = btn.dataset.page;
      if (pg === 'prev') this.profitSummaryPage--;
      else if (pg === 'next') this.profitSummaryPage++;
      else this.profitSummaryPage = Number(pg);
      this._renderProfitSummary();
    };
  },

  /**
   * Render pagination controls for ledger table.
   * @param {number} total - Total number of items
   */
  _renderLedgerPagination(total) {
    const infoEl = document.getElementById('ledger-page-info');
    const btnsEl = document.getElementById('ledger-page-btns');
    if (!infoEl || !btnsEl) return;

    const totalPages = Math.max(1, Math.ceil(total / this.perPage));
    const start = (this.currentPage - 1) * this.perPage;
    const end = Math.min(start + this.perPage, total);

    infoEl.textContent = total > 0
      ? `Showing ${start + 1}-${end} of ${total} trades`
      : '0 trades';

    // Build page buttons with ellipsis
    let html = `<button class="pagination-btn" data-page="prev"${this.currentPage <= 1 ? ' disabled' : ''}>&#8249;</button>`;
    for (let i = 1; i <= totalPages; i++) {
      if (totalPages > 7 && i > 2 && i < totalPages - 1 && Math.abs(i - this.currentPage) > 1) {
        if (i === 3 || i === totalPages - 2) html += '<button class="pagination-btn" disabled>...</button>';
        continue;
      }
      html += `<button class="pagination-btn${i === this.currentPage ? ' active' : ''}" data-page="${i}">${i}</button>`;
    }
    html += `<button class="pagination-btn" data-page="next"${this.currentPage >= totalPages ? ' disabled' : ''}>&#8250;</button>`;
    btnsEl.innerHTML = html;

    // Bind click events — NO API call, just re-render
    btnsEl.onclick = (e) => {
      const btn = e.target.closest('.pagination-btn');
      if (!btn || btn.disabled) return;
      const pg = btn.dataset.page;
      if (pg === 'prev') this.currentPage--;
      else if (pg === 'next') this.currentPage++;
      else this.currentPage = Number(pg);
      this._renderTransactions();  // Just re-render, no API call
    };
  },

  // ─── RENDERING: TRANSACTION LEDGER ──────────────────

  /**
   * Render the transaction ledger table.
   */
  _renderTransactions() {
    const tbody = document.getElementById('transactions-tbody');
    const countEl = document.getElementById('ledger-count');
    if (!tbody) return;

    if (this.allTransactions.length === 0) {
      tbody.innerHTML = `
        <tr><td colspan="8" style="text-align:center;padding:var(--space-8);color:var(--color-text-secondary)">
          No transactions in this portfolio yet.
        </td></tr>`;
      if (countEl) countEl.textContent = '0 trades';
      return;
    }

    // Sort by date descending
    const sorted = [...this.allTransactions].sort((a, b) => {
      const dateA = a.date || a.created_at || '';
      const dateB = b.date || b.created_at || '';
      return dateB.localeCompare(dateA);
    });

    // Client-side pagination
    const totalItems = sorted.length;
    const totalPages = Math.max(1, Math.ceil(totalItems / this.perPage));
    if (this.currentPage > totalPages) this.currentPage = totalPages;
    const start = (this.currentPage - 1) * this.perPage;
    const paginatedItems = sorted.slice(start, start + this.perPage);

    tbody.innerHTML = paginatedItems
      .map((tx) => {
        const type = (tx.type || '').toUpperCase();
        const isBuy = type === 'BUY';
        const rowClass = isBuy ? 'buy-row' : 'sell-row';
        const badgeClass = isBuy ? 'buy' : 'sell';
        const qty = tx.qty || 0;
        const price = tx.price || 0;
        const total = qty * price;
        const notes = tx.notes || '';

        return `
          <tr class="${rowClass}">
            <td>${this._formatDate(tx.date || tx.created_at || '')}</td>
            <td>
              <div class="ticker-cell">${ChartModal.button(tx.ticker, tx.company).outerHTML}</div>
            </td>
            <td><span class="trade-badge ${badgeClass}">${this._escapeHtml(type)}</span></td>
            <td class="text-right">${qty}</td>
            <td class="text-right">$${price.toFixed(2)}</td>
            <td class="text-right">$${total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
            <td class="notes-cell hide-mobile" title="${this._escapeHtml(notes)}">${this._escapeHtml(notes) || '--'}</td>
            <td class="text-center">
              <button class="btn-edit" data-tx-id="${tx.id}" aria-label="Edit transaction" title="Edit transaction">
                <svg viewBox="0 0 14 14" fill="none"><path d="M10 1.5l2.5 2.5M1.5 10l6.5-6.5 2.5 2.5-6.5 6.5H1.5V10z" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
              </button>
              <button class="btn-delete" data-tx-id="${tx.id}" aria-label="Delete transaction" title="Delete transaction">
                <svg viewBox="0 0 14 14" fill="none"><path d="M2.5 4h9M5.5 4V2.5h3V4M3.5 4l.7 8.5h5.6l.7-8.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
              </button>
            </td>
          </tr>
        `;
      })
      .join('');

    if (countEl) {
      countEl.textContent = `${totalItems} trade${totalItems !== 1 ? 's' : ''}`;
    }

    // Bind edit buttons
    tbody.querySelectorAll('.btn-edit').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const txId = Number(btn.dataset.txId);
        const tx = this.allTransactions.find((t) => t.id === txId);
        if (tx) {
          this._openEditModal(tx);
        }
      });
    });

    // Bind delete buttons
    tbody.querySelectorAll('.btn-delete').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const txId = Number(btn.dataset.txId);
        this._deleteTransaction(txId);
      });
    });

    this._renderLedgerPagination(totalItems);
  },

  // ─── VIEW STATE MANAGEMENT ──────────────────────────

  /**
   * Show the main content view (stats + tables).
   */
  _showMainView() {
    const el = document.getElementById('transactions-main-view');
    if (el) el.style.display = '';
  },

  /**
   * Hide the main content view.
   */
  _hideMainView() {
    const el = document.getElementById('transactions-main-view');
    if (el) el.style.display = 'none';
  },

  /**
   * Show the empty state.
   */
  _showEmpty() {
    const el = document.getElementById('transactions-empty');
    if (el) el.classList.add('visible');
  },

  /**
   * Hide the empty state.
   */
  _hideEmpty() {
    const el = document.getElementById('transactions-empty');
    if (el) el.classList.remove('visible');
  },

  /**
   * Show the loading skeleton.
   */
  _showLoading() {
    const el = document.getElementById('transactions-loading');
    if (el) el.classList.add('visible');
    this._hideMainView();
  },

  /**
   * Hide the loading skeleton.
   */
  _hideLoading() {
    const el = document.getElementById('transactions-loading');
    if (el) el.classList.remove('visible');
    this._showMainView();
  },

  /**
   * Show the error banner with a message.
   * @param {string} msg
   */
  _showError(msg) {
    const el = document.getElementById('transactions-error');
    if (el) {
      const msgEl = el.querySelector('.error-banner-message');
      if (msgEl) msgEl.textContent = msg;
      el.classList.add('visible');
    }
  },

  /**
   * Hide the error banner.
   */
  _hideError() {
    const el = document.getElementById('transactions-error');
    if (el) el.classList.remove('visible');
  },

  // ─── USER ACTIONS ───────────────────────────────────

  /**
   * Select a portfolio and load its data.
   * @param {number} portfolioId
   */
  async selectPortfolio(portfolioId) {
    this.activePortfolioId = portfolioId;

    // Reset pagination state
    this.currentPage = 1;
    this.profitSummaryPage = 1;
    this.realizedTradesPage = 1;
    this.realizedTrades = [];
    this.bestTrade = null;
    this.worstTrade = null;

    // Update tab active state
    document.querySelectorAll('#portfolio-tabs-scroll .portfolio-tab-group').forEach((tab) => {
      const isActive = Number(tab.dataset.portfolioId) === portfolioId;
      tab.setAttribute('aria-selected', String(isActive));
    });

    // Sync mobile dropdown
    this._syncDropdownToActivePortfolio();

    // Load data in parallel
    this._showLoading();
    await Promise.all([
      this.loadTransactions(portfolioId),
      this.loadProfitSummary(portfolioId),
      this.loadRealizedTrades(portfolioId),
      this.tradingActivity?.load(portfolioId),
    ]);
    this._hideLoading();

    // Render everything
    this._renderStats();
    this._renderYearHeatmap();
    this._renderProfitSummary();
    this._renderRealizedTrades();
    this._renderTransactions();
  },

  /**
   * Open the edit modal for a transaction.
   * @param {Object} transaction
   */
  _openEditModal(transaction) {
    this.editingTransaction = transaction;

    // Populate readonly fields
    this._setText('edit-ro-ticker', transaction.ticker || '--');
    this._setText('edit-ro-type', (transaction.type || '--').toUpperCase());
    this._setText('edit-ro-created', this._formatDate(transaction.created_at || ''));

    // Populate editable fields
    const dateInput = document.getElementById('edit-tx-date');
    const notesTextarea = document.getElementById('edit-tx-notes');
    const charCount = document.getElementById('notes-char-count');
    const qtyInput = document.getElementById('edit-tx-qty');
    const priceInput = document.getElementById('edit-tx-price');
    const totalDisplay = document.getElementById('edit-tx-total');

    if (dateInput) {
      const tradeDate = (transaction.date || '').substring(0, 10);
      dateInput.value = tradeDate;
      const display = document.getElementById('edit-tx-date-display');
      if (display) display.textContent = tradeDate ? this._formatDate(tradeDate) : '';
    }
    if (notesTextarea) {
      notesTextarea.value = transaction.notes || '';
    }
    if (charCount) {
      charCount.textContent = String((transaction.notes || '').length);
    }
    if (qtyInput) {
      qtyInput.value = transaction.qty || '';
    }
    if (priceInput) {
      priceInput.value = transaction.price || '';
    }

    // Update total display with initial values
    if (totalDisplay) {
      const q = parseFloat(qtyInput ? qtyInput.value : '') || 0;
      const p = parseFloat(priceInput ? priceInput.value : '') || 0;
      totalDisplay.textContent = '$' + (q * p).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    // Show modal
    const modal = document.getElementById('edit-transaction-modal');
    if (modal) {
      modal.classList.add('open');
      document.body.style.overflow = 'hidden';
    }
  },

  /**
   * Close the edit modal and clear state.
   */
  _closeEditModal() {
    const modal = document.getElementById('edit-transaction-modal');
    if (modal) {
      modal.classList.remove('open');
      document.body.style.overflow = '';
    }
    this.editingTransaction = null;
  },

  /**
   * Save the edited transaction via PUT request.
   */
  async _saveEdit() {
    if (!this.editingTransaction || !this.activePortfolioId) return;

    const dateInput = document.getElementById('edit-tx-date');
    const notesTextarea = document.getElementById('edit-tx-notes');
    const qtyInput = document.getElementById('edit-tx-qty');
    const priceInput = document.getElementById('edit-tx-price');

    const tradeDate = dateInput ? dateInput.value.trim() : '';
    const notes = notesTextarea ? notesTextarea.value.trim() : '';
    const qty = parseFloat(qtyInput ? qtyInput.value : '');
    const price = parseFloat(priceInput ? priceInput.value : '');

    if (!tradeDate) {
      alert('Trade date is required.');
      return;
    }
    if (!qty || qty <= 0) {
      alert('Quantity must be greater than 0.');
      return;
    }
    if (!price || price <= 0) {
      alert('Price must be greater than 0.');
      return;
    }

    const saveBtn = document.getElementById('edit-tx-save');
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';
    }

    try {
      await API.put(
        `/portfolio/${this.activePortfolioId}/transactions/${this.editingTransaction.id}`,
        { date: tradeDate, notes, qty, price }
      );
      this._closeEditModal();
      await this.selectPortfolio(this.activePortfolioId);
    } catch (err) {
      console.error('[Transactions] Failed to save edit:', err.message);
      alert('Failed to save changes. Please try again.');
    } finally {
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save Changes';
      }
    }
  },

  /**
   * Delete a transaction after confirmation.
   * @param {number} transactionId
   */
  async _deleteTransaction(transactionId) {
    if (!this.activePortfolioId) return;

    if (!confirm('Are you sure you want to delete this transaction? This action cannot be undone.')) {
      return;
    }

    try {
      await API.delete(`/portfolio/${this.activePortfolioId}/transactions/${transactionId}`);
      // Reload data
      await this.selectPortfolio(this.activePortfolioId);
    } catch (err) {
      console.error('[Transactions] Failed to delete transaction:', err.message);
      alert('Failed to delete transaction. Please try again.');
    }
  },

  // ─── ADD TRANSACTION FORM ─────────────────────────────

  /**
   * Bind the add-transaction form: toggle, validation, submit.
   */
  _bindAddForm() {
    const addBtn = document.getElementById('add-transaction-btn');
    const addSection = document.getElementById('add-transaction-section');
    const addForm = document.getElementById('add-transaction-form');
    const typeBuyBtn = document.getElementById('add-tx-type-buy');
    const typeSellBtn = document.getElementById('add-tx-type-sell');
    const tickerInput = document.getElementById('add-tx-ticker');

    if (addBtn && addSection) {
      addBtn.addEventListener('click', () => {
        const isVisible = addSection.classList.contains('visible');
        if (isVisible) {
          addSection.classList.remove('visible');
          addBtn.textContent = '+ Add Transaction';
          addBtn.setAttribute('aria-label', 'Add transaction');
        } else {
          addSection.classList.add('visible');
          addBtn.textContent = '× Close';
          addBtn.setAttribute('aria-label', 'Close add transaction form');
          this._clearAddForm();
          if (tickerInput) tickerInput.focus();
        }
      });
    }

    // Type toggle buttons
    if (typeBuyBtn && typeSellBtn) {
      typeBuyBtn.addEventListener('click', () => {
        typeBuyBtn.classList.add('active');
        typeBuyBtn.setAttribute('aria-checked', 'true');
        typeSellBtn.classList.remove('active');
        typeSellBtn.setAttribute('aria-checked', 'false');
      });
      typeSellBtn.addEventListener('click', () => {
        typeSellBtn.classList.add('active');
        typeSellBtn.setAttribute('aria-checked', 'true');
        typeBuyBtn.classList.remove('active');
        typeBuyBtn.setAttribute('aria-checked', 'false');
      });
    }

    // Ticker validation on input (clear state)
    if (tickerInput) {
      tickerInput.addEventListener('input', (e) => {
        e.target.value = e.target.value.toUpperCase();
        clearTimeout(this._addFormTickerValidationTimeout);
        const status = document.getElementById('add-tx-ticker-validation');
        const info = document.getElementById('add-tx-ticker-info');
        if (status) { status.textContent = ''; status.className = 'add-tx-ticker-validation'; }
        if (info) { info.textContent = ''; }
      });
      tickerInput.addEventListener('blur', () => this._validateAddTicker());
    }

    // Form submit
    if (addForm) {
      addForm.addEventListener('submit', (e) => {
        e.preventDefault();
        this._handleAddTransaction();
      });
    }
  },

  /**
   * Validate ticker on blur for the add-transaction form.
   */
  async _validateAddTicker() {
    const status = document.getElementById('add-tx-ticker-validation');
    const info = document.getElementById('add-tx-ticker-info');
    const tickerInput = document.getElementById('add-tx-ticker');
    if (!status || !info || !tickerInput) return;

    clearTimeout(this._addFormTickerValidationTimeout);

    let ticker = (tickerInput.value || '').trim();
    if (!ticker) {
      status.textContent = ''; status.className = 'add-tx-ticker-validation';
      info.textContent = '';
      return;
    }
    ticker = ticker.toUpperCase();
    if (ticker.length < 2 || ticker.length > 10) {
      status.textContent = ''; status.className = 'add-tx-ticker-validation';
      info.textContent = '';
      return;
    }

    // Check cache first
    if (this.tickerValidationCache[ticker]) {
      const cached = this.tickerValidationCache[ticker];
      status.textContent = cached.valid ? '\u2713' : '\u2717';
      status.className = 'add-tx-ticker-validation ' + (cached.valid ? 'valid' : 'invalid');
      info.textContent = cached.valid ? cached.company + ' \u00B7 ' + cached.sector : '';
      return;
    }

    // Show loading spinner
    status.textContent = '\u27F3'; status.className = 'add-tx-ticker-validation loading';
    info.textContent = '';

    try {
      const r = await API.get('/validate-ticker/' + encodeURIComponent(ticker));
      this.tickerValidationCache[ticker] = r;
      status.textContent = r.valid ? '\u2713' : '\u2717';
      status.className = 'add-tx-ticker-validation ' + (r.valid ? 'valid' : 'invalid');
      info.textContent = r.valid ? r.company + ' \u00B7 ' + r.sector : '';
    } catch (e) {
      status.textContent = '?'; status.className = 'add-tx-ticker-validation invalid';
      info.textContent = '';
    }
  },

  /**
   * Handle add-transaction form submission.
   */
  async _handleAddTransaction() {
    if (!this.activePortfolioId) {
      alert('Please select a portfolio first.');
      return;
    }

    const tickerInput = document.getElementById('add-tx-ticker');
    const qtyInput = document.getElementById('add-tx-qty');
    const priceInput = document.getElementById('add-tx-price');
    const dateInput = document.getElementById('add-tx-date');
    const notesInput = document.getElementById('add-tx-notes');
    const typeBuyBtn = document.getElementById('add-tx-type-buy');

    const ticker = (tickerInput ? tickerInput.value : '').trim();
    const qty = parseFloat(qtyInput ? qtyInput.value : '');
    const price = parseFloat(priceInput ? priceInput.value : '');
    const date = dateInput ? dateInput.value.trim() : '';
    const notes = notesInput ? notesInput.value.trim() : '';
    const type = (typeBuyBtn && typeBuyBtn.classList.contains('active')) ? 'BUY' : 'SELL';

    if (!ticker) {
      alert('Ticker symbol is required.');
      return;
    }
    if (!qty || qty <= 0) {
      alert('Quantity must be greater than 0.');
      return;
    }
    if (!price || price <= 0) {
      alert('Price must be greater than 0.');
      return;
    }
    if (!date) {
      alert('Date is required.');
      return;
    }

    const submitBtn = document.getElementById('add-tx-submit-btn');
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Adding...';
    }

    try {
      await API.post(`/portfolio/${this.activePortfolioId}/transactions`, {
        ticker: ticker.toUpperCase(),
        type,
        qty,
        price,
        date,
        notes,
      });
      this._clearAddForm();
      await this.selectPortfolio(this.activePortfolioId);
    } catch (err) {
      console.error('[Transactions] Failed to add transaction:', err.message);
      alert('Failed to add transaction. Please try again.');
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Add Transaction';
      }
    }
  },

  /**
   * Clear the add-transaction form fields and reset validation state.
   */
  _clearAddForm() {
    const tickerInput = document.getElementById('add-tx-ticker');
    const qtyInput = document.getElementById('add-tx-qty');
    const priceInput = document.getElementById('add-tx-price');
    const dateInput = document.getElementById('add-tx-date');
    const notesInput = document.getElementById('add-tx-notes');
    const status = document.getElementById('add-tx-ticker-validation');
    const info = document.getElementById('add-tx-ticker-info');
    const typeBuyBtn = document.getElementById('add-tx-type-buy');
    const typeSellBtn = document.getElementById('add-tx-type-sell');

    if (tickerInput) tickerInput.value = '';
    if (qtyInput) qtyInput.value = '';
    if (priceInput) priceInput.value = '';
    if (dateInput) {
      const today = new Date().toISOString().substring(0, 10);
      dateInput.value = today;
      const display = document.getElementById('add-tx-date-display');
      if (display) display.textContent = this._formatDate(today);
    }
    if (notesInput) notesInput.value = '';
    if (status) { status.textContent = ''; status.className = 'add-tx-ticker-validation'; }
    if (info) info.textContent = '';
    if (typeBuyBtn) { typeBuyBtn.classList.add('active'); typeBuyBtn.setAttribute('aria-checked', 'true'); }
    if (typeSellBtn) { typeSellBtn.classList.remove('active'); typeSellBtn.setAttribute('aria-checked', 'false'); }
  },

  // ─── HELPERS ────────────────────────────────────────

  /**
   * Escape HTML to prevent XSS.
   * @param {string} str
   * @returns {string}
   */
  _escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  },

  /**
   * Format an ISO date string to a human-readable format.
   * @param {string} dateStr
   * @returns {string}
   */
  _formatDate(dateStr) {
    if (!dateStr) return '--';
    try {
      // If it's a date-only string (YYYY-MM-DD), parse as local time
      // to avoid timezone shifts. new Date(y, m-1, d) = local midnight.
      if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        const [y, m, d] = dateStr.split('-').map(Number);
        return new Date(y, m - 1, d).toLocaleDateString('en-US', {
          month: 'short', day: 'numeric', year: 'numeric',
        });
      }
      // For full timestamps, parse normally
      const dt = new Date(dateStr);
      if (isNaN(dt.getTime())) return dateStr;
      return dt.toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
      });
    } catch {
      return dateStr;
    }
  },

  /**
   * Format a number as currency with $ and commas.
   * @param {number} amount
   * @returns {string}
   */
  _formatCurrency(amount) {
    const abs = Math.abs(amount);
    const formatted = abs.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    return `$${formatted}`;
  },

  /**
   * Format a percentage value.
   * @param {number} pct
   * @returns {string}
   */
  _formatPct(pct) {
    return Math.abs(pct).toFixed(2) + '%';
  },

  /**
   * Render a Best/Worst trade cell: ticker button plus the return pct in
   * two forms — full `(+10.00%)` for desktop and compact `+10%` for mobile,
   * toggled via CSS. The exact figure is kept in the title tooltip.
   * @param {HTMLElement} el
   * @param {Object} trade
   */
  _bestWorstCell(el, trade) {
    const pct = trade.realized_pnl_pct;
    const sign = pct >= 0 ? '+' : '-';
    const abs = Math.abs(pct);
    const full = document.createElement('span');
    full.className = 'pct-full';
    full.textContent = pct == null ? '(—)' : `(${sign}${abs.toFixed(2)}%)`;
    const short = document.createElement('span');
    short.className = 'pct-short';
    short.textContent = pct == null ? '—' : `${sign}${Math.round(abs)}%`;
    el.replaceChildren(
      ChartModal.button(trade.ticker, trade.company),
      document.createTextNode(` ${trade.realized_pnl >= 0 ? '+' : ''}${this._formatCurrency(trade.realized_pnl)} `),
      full,
      short
    );
    el.className = 'stats-bar-value ' + (trade.realized_pnl >= 0 ? 'up' : 'down');
    el.title = `${trade.ticker} · ${trade.sell_date} · ${this._formatCurrency(trade.realized_pnl)} · ${pct == null ? 'Return unavailable' : `${sign}${abs.toFixed(2)}%`} · Ranked by realized dollar P/L`;
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
};

// ES module export for app.js dynamic import
export default Transactions;

// CommonJS fallback (for Node/testing)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = Transactions;
}
