/**
 * Alerts — Price alert management screen module.
 *
 * Create, arm/disarm, view history, manage watchlists,
 * and manage watchlists for price alerts.
 *
 * API endpoints:
 *   GET  /api/alerts          — list alerts
 *   POST /api/alerts          — create alert
 *   PUT  /api/alerts/:id/arm  — toggle arm state
 *   DEL  /api/alerts/:id      — delete alert
 *   GET  /api/alerts/history  — alert trigger history
 *
 * @example
 *   // Called by App.loadScreen('alerts')
 *   Alerts.init();
 */

import ChartModal from '../components/chart-modal.js';

const Alerts = {
  // ─── STATE ──────────────────────────────────────────

  /** @type {Array<Object>|null} */
  data: null,

  /** @type {Array<Object>|null} */
  history: null,

  /** @type {boolean} */
  loading: false,

  /** @type {string} Current sort column */
  sortColumn: 'created',

  /** @type {string} Sort direction: 'asc' or 'desc' */
  sortDirection: 'desc',

  /** @type {number} Current page */
  currentPage: 1,

  /** @type {number} Items per page */
  pageSize: 10,

  /** @type {number|null} Alert ID pending deletion */
  pendingDeleteId: null,

  /** @type {Array} Watchlist ticker data */
  watchlistTickers: [],

  /** @type {string|null} Active watchlist ID (UUID from API) */
  activeWatchlist: null,

  /** @type {Array} Activity log entries */
  activityLog: [],

  /** @type {Object} Cache for validated tickers: { [ticker]: { valid, company, sector } } */
  tickerValidationCache: {},

  /** @type {number|null} Debounce timeout for ticker validation */
  _tickerValidationDebounce: null,

  /** @type {number|null} Debounce timeout for alert creation ticker validation */
  _alertTickerValidationDebounce: null,

  // ─── INITIALIZATION ──────────────────────────────────

  /**
   * Initialize the Alerts screen.
   */
  async init() {
    console.log('[Alerts] initialized');
    this.bindEvents();
    this.renderActivityLog();
    await this.loadAlerts();
    await this.loadHistory();
    await this.loadWatchlist();
  },

  /**
   * Clean up event listeners when screen is torn down.
   */
  destroy() {
    if (this._escapeKeyHandler) {
      document.removeEventListener('keydown', this._escapeKeyHandler);
      this._escapeKeyHandler = null;
    }
    clearTimeout(this._tickerValidationDebounce);
  },

  // ─── EVENT BINDING ───────────────────────────────────

  /**
   * Bind screen-specific event listeners.
   */
  bindEvents() {
    // Create alert button → scroll to form
    const createBtn = document.getElementById('createAlertBtn');
    if (createBtn) {
      createBtn.addEventListener('click', () => {
        document.getElementById('createFormCard').scrollIntoView({ behavior: 'smooth' });
      });
    }

    // Empty state create button
    const emptyCreateBtn = document.getElementById('emptyCreateBtn');
    if (emptyCreateBtn) {
      emptyCreateBtn.addEventListener('click', () => {
        document.getElementById('createFormCard').scrollIntoView({ behavior: 'smooth' });
      });
    }

    // Refresh button
    const refreshBtn = document.getElementById('refreshBtn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => this.handleRefresh());
    }

    // Alert form submit
    const form = document.getElementById('alertForm');
    if (form) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        this.handleCreateAlert();
      });
    }

    // Cancel form button
    const cancelBtn = document.getElementById('cancelFormBtn');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => this.resetForm());
    }

    // Table sort headers
    const thead = document.querySelector('.alert-table thead');
    if (thead) {
      thead.addEventListener('click', (e) => {
        const th = e.target.closest('th[data-sort]');
        if (th) {
          this.handleSort(th.dataset.sort);
        }
      });
    }

    // Table action delegation + row click → chart modal
    const tbody = document.getElementById('alertTableBody');
    if (tbody) {
      tbody.addEventListener('click', (e) => {
        // Handle action buttons (arm, delete, chart)
        const actionBtn = e.target.closest('.action-btn');
        if (actionBtn) {
          const row = actionBtn.closest('tr');
          const alertId = Number(row.dataset.alertId);

          if (actionBtn.classList.contains('delete')) {
            this.handleDeleteClick(alertId);
          } else if (actionBtn.dataset.action === 'arm') {
            this.handleToggleArm(alertId);
          }
          return;
        }

        // Click anywhere else on the row → open chart modal for that ticker
        const row = e.target.closest('tr[data-ticker]');
        if (!row) return;

        const ticker = row.dataset.ticker;
        if (!ticker) return;

        ChartModal.open(ticker, this.tickerValidationCache[ticker]?.company || '');
      });
    }

    // Confirm dialog
    const confirmDeleteBtn = document.getElementById('confirmDeleteBtn');
    const confirmCancelBtn = document.getElementById('confirmCancelBtn');
    if (confirmDeleteBtn) {
      confirmDeleteBtn.addEventListener('click', () => this.handleConfirmDelete());
    }
    if (confirmCancelBtn) {
      confirmCancelBtn.addEventListener('click', () => this.hideConfirmDialog());
    }

    var watchlistSideTab = document.getElementById('watchlistSideTab');
    var watchlistBackdrop = document.getElementById('watchlistBackdrop');
    if (watchlistSideTab) {
      watchlistSideTab.addEventListener('click', () => {
        var rc = document.getElementById('rightCol');
        if (rc) rc.classList.add('open');
        if (watchlistBackdrop) watchlistBackdrop.classList.add('open');
        watchlistSideTab.style.display = 'none';
      });
    }
    if (watchlistBackdrop) {
      watchlistBackdrop.addEventListener('click', () => {
        var rc = document.getElementById('rightCol');
        if (rc) rc.classList.remove('open');
        watchlistBackdrop.classList.remove('open');
        if (watchlistSideTab) watchlistSideTab.style.display = '';
      });
    }

    // Retry button
    const retryBtn = document.getElementById('retryBtn');
    if (retryBtn) {
      retryBtn.addEventListener('click', () => this.loadAlerts());
    }

    // Watchlist select
    const wlSelect = document.getElementById('watchlistSelect');
    if (wlSelect) {
      wlSelect.addEventListener('change', () => {
        this.activeWatchlist = wlSelect.value;
        this.loadWatchlist();
      });
    }

    // New watchlist button
    const newWLBtn = document.getElementById('newWLBtn');
    if (newWLBtn) {
      newWLBtn.addEventListener('click', () => this.showCreateWLModal());
    }

    // Manage watchlist button
    const manageWLBtn = document.getElementById('manageWLBtn');
    if (manageWLBtn) {
      manageWLBtn.addEventListener('click', () => this.showManageWLModal());
    }

    // Create watchlist modal
    const createWLSubmit = document.getElementById('createWLSubmitBtn');
    const createWLCancel = document.getElementById('createWLCancelBtn');
    if (createWLSubmit) {
      createWLSubmit.addEventListener('click', () => this.handleCreateWatchlist());
    }
    if (createWLCancel) {
      createWLCancel.addEventListener('click', () => this.hideCreateWLModal());
    }

    // Manage watchlist modal — close button and × button
    const manageWLClose = document.getElementById('manageWLCloseBtn');
    if (manageWLClose) {
      manageWLClose.addEventListener('click', () => this.hideManageWLModal());
    }
    const manageWLCloseX = document.getElementById('manageWLCloseX');
    if (manageWLCloseX) {
      manageWLCloseX.addEventListener('click', () => this.hideManageWLModal());
    }
    // Close on Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        var modal = document.getElementById('manageWLModal');
        if (modal && modal.classList.contains('visible')) {
          this.hideManageWLModal();
        }
      }
    });
    // Close on overlay backdrop click
    const manageWLModal = document.getElementById('manageWLModal');
    if (manageWLModal) {
      manageWLModal.addEventListener('click', (e) => {
        if (e.target === manageWLModal) {
          this.hideManageWLModal();
        }
      });
    }

    // Ticker search autocomplete + validation
    const searchInput = document.getElementById('tickerSearchInput');
    if (searchInput) {
      searchInput.addEventListener('input', () => {
        // Auto-uppercase
        const pos = searchInput.selectionStart;
        searchInput.value = searchInput.value.toUpperCase();
        searchInput.setSelectionRange(pos, pos);
        // Clear validation state on edit
        this._clearTickerValidation();
      });
      searchInput.addEventListener('blur', () => {
        // Delay to allow autocomplete click to fire first
        this._tickerValidationDebounce = setTimeout(() => {
          this._validateTickerOnBlur();
        }, 150);
      });
      searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this._handleAddTickerFromInput();
        }
      });
    }

    // Alert creation ticker input — auto-uppercase + blur validation
    const alertTickerInput = document.getElementById('tickerInput');
    if (alertTickerInput) {
      alertTickerInput.addEventListener('input', () => {
        // Auto-uppercase while preserving cursor position
        const pos = alertTickerInput.selectionStart;
        alertTickerInput.value = alertTickerInput.value.toUpperCase();
        alertTickerInput.setSelectionRange(pos, pos);
        // Clear submit-time error on edit
        this.clearFieldError('tickerInput', 'tickerError');
        // Clear company info while typing
        const company = document.getElementById('tickerCompany');
        if (company) { company.textContent = ''; company.classList.remove('visible'); }
      });
      alertTickerInput.addEventListener('blur', () => {
        // Debounced backend validation on blur
        this._alertTickerValidationDebounce = setTimeout(() => {
          this._validateTickerInputOnBlur();
        }, 150);
      });
    }

    // Add ticker button
    const addTickerBtn = document.getElementById('addTickerBtn');
    if (addTickerBtn) {
      addTickerBtn.addEventListener('click', () => this._handleAddTickerFromInput());
    }

    // Watchlist ticker list delegation
    const wlTickers = document.getElementById('watchlistTickers');
    if (wlTickers) {
      wlTickers.addEventListener('click', (e) => {
        // Handle remove button
        const removeBtn = e.target.closest('.ticker-remove');
        if (removeBtn) {
          const row = removeBtn.closest('.ticker-row');
          const ticker = row.dataset.ticker;
          row.style.transition = 'opacity 0.3s, transform 0.3s';
          row.style.opacity = '0';
          row.style.transform = 'translateX(20px)';
          setTimeout(() => row.remove(), 300);
          // Persist removal via API
          if (this.activeWatchlist && ticker) {
            API.delete('/watchlists/' + this.activeWatchlist + '/tickers/' + ticker)
              .then(() => this.loadWatchlist())
              .catch((err) => {
                console.error('[Alerts] Failed to remove ticker:', err);
                this.showToast('Failed to remove ' + ticker);
                this.loadWatchlist();
              });
          }
          return;
        }

        // Click on ticker row → open chart modal
        const row = e.target.closest('.ticker-row');
        if (!row) return;

        const ticker = row.dataset.ticker;
        if (!ticker) return;

        ChartModal.open(ticker, this.tickerValidationCache[ticker]?.company || '');
      });
    }

    // Close modals on ESC
    this._escapeKeyHandler = (e) => {
      if (e.key === 'Escape') {
        this.hideConfirmDialog();
        this.hideCreateWLModal();
        this.hideManageWLModal();
        const rc = document.getElementById('rightCol');
        if (rc) rc.classList.remove('open');
        var bd = document.getElementById('watchlistBackdrop');
        if (bd) bd.classList.remove('open');
        var st = document.getElementById('watchlistSideTab');
        if (st) st.style.display = '';

      }
    };
    document.addEventListener('keydown', this._escapeKeyHandler);

    // Form type change → update threshold label
    const alertType = document.getElementById('alertType');
    if (alertType) {
      alertType.addEventListener('change', () => this.updateThresholdLabel());
    }
  },

  // ─── DATA LOADING ────────────────────────────────────

  /**
   * Load all alerts from API.
   */
  async loadAlerts() {
    this.loading = true;
    this.showLoading();

    try {
      var alerts = await API.get('/alerts');

      // Fetch current prices for all alert tickers
      var tickers = [...new Set(alerts.map(function(a) { return a.ticker; }))];
      if (tickers.length > 0) {
        var quotesData = await API.get('/data/quotes?tickers=' + tickers.join(','));
        var quotesMap = {};
        (quotesData.quotes || []).forEach(function(q) { quotesMap[q.ticker] = q.price; });
        alerts.forEach(function(a) { a.current_price = quotesMap[a.ticker] || 0; });
      }

      this.data = alerts;
      this.hideLoading();
      this.render();
    } catch (err) {
      this.showError(err.message || 'Unable to load alerts');
    } finally {
      this.loading = false;
    }
  },

  /**
   * Load alert trigger history.
   */
  async loadHistory() {
    try {
      this.history = await API.get('/alerts/history');
      this.renderActivityLog();
    } catch (err) {
      console.warn('[Alerts] Failed to load history:', err);
    }
  },

  // ─── HISTORY HELPERS ────────────────────────────────

  /**
   * Get the last triggered date for an alert from history.
   * @param {number} alertId
   * @returns {string|null} ISO date string or null
   */
  _getLastTriggeredForAlert(alertId) {
    if (!this.history || !this.history.length) return null;
    var latest = null;
    for (var i = 0; i < this.history.length; i++) {
      var entry = this.history[i];
      if (entry.alert_id === alertId) {
        var firedAt = entry.fired_at || null;
        if (firedAt && (!latest || new Date(firedAt) > new Date(latest))) {
          latest = firedAt;
        }
      }
    }
    return latest;
  },

  /**
   * Count alerts that have been triggered today.
   * @param {Array} alerts
   * @returns {number}
   */
  _countFiredToday(alerts) {
    if (!this.history || !this.history.length) return 0;
    var today = new Date();
    var todayStr = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
    var firedIds = {};
    for (var i = 0; i < this.history.length; i++) {
      var entry = this.history[i];
      var firedAt = entry.fired_at || '';
      if (firedAt && firedAt.substring(0, 10) === todayStr) {
        firedIds[entry.alert_id] = true;
      }
    }
    return alerts.filter(function(a) { return firedIds[a.id]; }).length;
  },

  // ─── USER ACTIONS ────────────────────────────────────

  /**
   * Handle create alert form submission.
   */
  async handleCreateAlert() {
    const tickerInput = document.getElementById('tickerInput');
    const typeSelect = document.getElementById('alertType');
    const thresholdInput = document.getElementById('thresholdInput');

    const ticker = tickerInput ? tickerInput.value.trim().toUpperCase() : '';
    const type = typeSelect ? typeSelect.value : '';
    const threshold = thresholdInput ? Number(thresholdInput.value) : 0;

    // Validate
    let valid = true;
    if (!ticker || ticker.length < 1 || ticker.length > 5) {
      this.showFieldError('tickerInput', 'tickerError');
      valid = false;
    } else {
      this.clearFieldError('tickerInput', 'tickerError');
    }
    if (!type) {
      valid = false;
    }
    if (!threshold || threshold <= 0) {
      this.showFieldError('thresholdInput', 'thresholdError');
      valid = false;
    } else {
      this.clearFieldError('thresholdInput', 'thresholdError');
    }

    if (!valid) return;

    try {
      await API.post('/alerts', {
        ticker,
        type,
        threshold: threshold,
      });
      this.resetForm();
      this.showToast('Alert for ' + ticker + ' created');
      await this.loadAlerts();
    } catch (err) {
      this.showToast(err.message || 'Failed to create alert');
    }
  },

  /**
   * Toggle arm state for an alert.
   * @param {number} alertId
   */
  async handleToggleArm(alertId) {
    try {
      await API.put('/alerts/' + alertId + '/arm');
      const alert = this.data ? this.data.find(function(a) { return a.id === alertId; }) : null;
      const ticker = alert ? alert.ticker : '';
      this.showToast('Alert for ' + ticker + ' ' + (alert && alert.armed ? 'disarmed' : 'armed'));
      await this.loadAlerts();
    } catch (err) {
      this.showToast(err.message || 'Failed to toggle alert');
    }
  },

  /**
   * Show delete confirmation dialog.
   * @param {number} alertId
   */
  handleDeleteClick(alertId) {
    this.pendingDeleteId = alertId;
    const alert = this.data ? this.data.find(function(a) { return a.id === alertId; }) : null;
    const ticker = alert ? alert.ticker : '';
    const msg = document.getElementById('confirmMessage');
    if (msg) {
      msg.textContent = 'Are you sure you want to delete the alert for ' + ticker + '? This action cannot be undone.';
    }
    document.getElementById('confirmOverlay').classList.add('visible');
  },

  /**
   * Confirm and execute alert deletion.
   */
  async handleConfirmDelete() {
    if (this.pendingDeleteId === null) return;
    const id = this.pendingDeleteId;
    this.hideConfirmDialog();

    try {
      await API.delete('/alerts/' + id);
      this.showToast('Alert deleted');
      await this.loadAlerts();
    } catch (err) {
      this.showToast(err.message || 'Failed to delete alert');
    }
    this.pendingDeleteId = null;
  },



  /**
   * Handle table column sort.
   * @param {string} column
   */
  handleSort(column) {
    if (this.sortColumn === column) {
      this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
    } else {
      this.sortColumn = column;
      this.sortDirection = 'asc';
    }
    this.currentPage = 1;
    this.renderTable();

    // Update sort arrow visuals
    document.querySelectorAll('.alert-table th').forEach(function(th) {
      th.classList.remove('sorted');
      var arrow = th.querySelector('.sort-arrow');
      if (arrow) arrow.innerHTML = '&#9650;';
    });
    var activeTh = document.querySelector('.alert-table th[data-sort="' + column + '"]');
    if (activeTh) {
      activeTh.classList.add('sorted');
      var arrow = activeTh.querySelector('.sort-arrow');
      if (arrow) arrow.innerHTML = this.sortDirection === 'asc' ? '&#9650;' : '&#9660;';
    }
  },

  /**
   * Handle refresh button click.
   */
  async handleRefresh() {
    var btn = document.getElementById('refreshBtn');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="animation:spin 1s linear infinite"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg> Refreshing...';
    }
    await this.loadAlerts();
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg> Refresh';
    }
    this.showToast('Alerts refreshed');
  },

  // ─── RENDERING ───────────────────────────────────────

  /**
   * Render the full screen: stats, table, form visibility.
   */
  render() {
    if (!this.data) return;

    var alerts = Array.isArray(this.data) ? this.data : [];

    // Show/hide states
    var statsRow = document.getElementById('statsRow');
    var mainContent = document.getElementById('mainContent');
    var emptyState = document.getElementById('emptyState');
    var tableCard = document.getElementById('alertTableCard');
    var formCard = document.getElementById('createFormCard');

    if (alerts.length === 0) {
      if (statsRow) statsRow.classList.add('hidden');
      // Keep mainContent visible so the empty state, form, watchlist panel
      // and activity log are all reachable.
      if (mainContent) mainContent.style.display = '';
      if (emptyState) emptyState.classList.add('visible');
      if (tableCard) tableCard.style.display = 'none';
      if (formCard) formCard.style.display = '';
      return;
    }

    if (statsRow) statsRow.classList.remove('hidden');
    if (mainContent) mainContent.style.display = '';
    if (emptyState) emptyState.classList.remove('visible');
    if (tableCard) tableCard.style.display = '';
    if (formCard) formCard.style.display = '';

    this.renderStats(alerts);
    this.renderTable();
  },

  /**
   * Render stats cards.
   * @param {Array} alerts
   */
  renderStats(alerts) {
    var total = alerts.length;
    var armed = alerts.filter(function(a) { return a.armed; }).length;
    var fired = this._countFiredToday(alerts);

    var totalEl = document.getElementById('statTotal');
    var armedEl = document.getElementById('statArmed');
    var firedEl = document.getElementById('statFired');
    var firedCard = document.getElementById('statFiredCard');
    var badge = document.getElementById('statTotalBadge');

    if (totalEl) totalEl.textContent = total;
    if (armedEl) armedEl.textContent = armed;
    if (firedEl) firedEl.textContent = fired;
    if (badge) badge.textContent = total;
    if (firedCard && fired > 0) {
      firedCard.classList.add('triggered');
    } else if (firedCard) {
      firedCard.classList.remove('triggered');
    }
  },

  /**
   * Render the alert table with sorting and pagination.
   */
  renderTable() {
    var tbody = document.getElementById('alertTableBody');
    if (!tbody || !this.data) return;

    var alerts = Array.isArray(this.data) ? this.data.slice() : [];

    // Sort
    var col = this.sortColumn;
    var dir = this.sortDirection === 'asc' ? 1 : -1;
    alerts.sort(function(a, b) {
      var va, vb;
      switch (col) {
        case 'ticker':
          va = a.ticker || '';
          vb = b.ticker || '';
          return va.localeCompare(vb) * dir;
        case 'type':
          va = a.type || '';
          vb = b.type || '';
          return va.localeCompare(vb) * dir;
        case 'price':
          return ((Number(a.current_price) || 0) - (Number(b.current_price) || 0)) * dir;
        case 'status':
          va = a.armed ? 1 : 0;
          vb = b.armed ? 1 : 0;
          return (va - vb) * dir;
        case 'created':
          va = new Date(a.created_at || 0).getTime();
          vb = new Date(b.created_at || 0).getTime();
          return (va - vb) * dir;
        case 'triggered':
          va = new Date(Alerts._getLastTriggeredForAlert(a.id) || 0).getTime();
          vb = new Date(Alerts._getLastTriggeredForAlert(b.id) || 0).getTime();
          return (va - vb) * dir;
        default:
          return 0;
      }
    });

    // Paginate
    var total = alerts.length;
    var totalPages = Math.max(1, Math.ceil(total / this.pageSize));
    if (this.currentPage > totalPages) this.currentPage = totalPages;
    var start = (this.currentPage - 1) * this.pageSize;
    var page = alerts.slice(start, start + this.pageSize);

    if (page.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:var(--space-8);color:var(--color-text-tertiary);">No alerts match the current filter.</td></tr>';
    } else {
      tbody.innerHTML = page.map(function(a) {
        return Alerts.renderAlertRow(a);
      }).join('');
    }

    // Pagination info
    var infoEl = document.getElementById('paginationInfo');
    var btnsEl = document.getElementById('paginationBtns');
    if (infoEl) {
      var end = Math.min(start + this.pageSize, total);
      infoEl.textContent = 'Showing ' + (total > 0 ? start + 1 : 0) + '-' + end + ' of ' + total + ' alerts';
    }
    if (btnsEl) {
      var html = '';
      html += '<button class="pagination-btn" data-page="prev"' + (this.currentPage <= 1 ? ' disabled' : '') + '>&#8249;</button>';
      for (var i = 1; i <= totalPages; i++) {
        if (totalPages > 7 && i > 2 && i < totalPages - 1 && Math.abs(i - this.currentPage) > 1) {
          if (i === 3 || i === totalPages - 2) html += '<button class="pagination-btn" disabled>...</button>';
          continue;
        }
        html += '<button class="pagination-btn' + (i === this.currentPage ? ' active' : '') + '" data-page="' + i + '">' + i + '</button>';
      }
      html += '<button class="pagination-btn" data-page="next"' + (this.currentPage >= totalPages ? ' disabled' : '') + '>&#8250;</button>';
      btnsEl.innerHTML = html;

      btnsEl.onclick = function(e) {
        var btn = e.target.closest('.pagination-btn');
        if (!btn || btn.disabled) return;
        var pg = btn.dataset.page;
        if (pg === 'prev') Alerts.currentPage--;
        else if (pg === 'next') Alerts.currentPage++;
        else Alerts.currentPage = Number(pg);
        Alerts.renderTable();
      };
    }
  },

  /**
   * Render a single alert table row.
   * @param {Object} a - Alert object
   * @returns {string} HTML string
   */
  renderAlertRow(a) {
    var lastTriggered = this._getLastTriggeredForAlert(a.id);
    var statusClass = a.armed ? 'armed' : (lastTriggered ? 'triggered' : 'disabled');
    var statusText = a.armed ? 'Armed' : (lastTriggered ? 'Triggered' : 'Disarmed');
    var type = a.type || 'price_above';
    var typeBadge = this.getTypeBadge(type);
    var conditionText = this.getConditionText(a);
    var currentPrice = a.current_price ? Number(a.current_price) : 0;
    var priceClass = currentPrice >= (Number(a.threshold) || 0) ? 'price-up' : 'price-down';
    var created = a.created_at ? this.formatDate(a.created_at) : '—';
    var triggered = lastTriggered ? this.formatDate(lastTriggered) : null;

    var ticker = a.ticker || '';

    return '<tr data-alert-id="' + a.id + '" data-ticker="' + ticker + '" data-type="' + type + '">' +
      '<td><span class="status-badge"><span class="status-dot ' + statusClass + '"></span> ' + statusText + '</span></td>' +
      '<td><span class="ticker-badge">' + ticker + '</span></td>' +
      '<td>' + typeBadge + '</td>' +
      '<td><span class="condition-text">' + conditionText + '</span></td>' +
      '<td class="text-right"><span class="price-mono ' + priceClass + '">$' + currentPrice.toFixed(2) + '</span></td>' +
      '<td><span class="date-text">' + created + '</span></td>' +
      '<td>' + (triggered ? '<span class="date-text">' + triggered + '</span>' : '<span class="never-text">Never</span>') + '</td>' +
      '<td class="text-right"><div class="action-btns">' +
        '<button class="action-btn" data-action="arm" title="' + (a.armed ? 'Pause alert' : 'Arm alert') + '" aria-label="' + (a.armed ? 'Pause' : 'Arm') + ' ' + ticker + ' alert"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + (a.armed ? '<rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect>' : '<polygon points="5 3 19 12 5 21 5 3"></polygon>') + '</svg></button>' +
        '<button class="action-btn delete" title="Delete alert" aria-label="Delete ' + ticker + ' alert"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg></button>' +
      '</div></td>' +
    '</tr>';
  },

  /**
   * Get type badge HTML.
   * @param {string} type
   * @returns {string}
   */
  getTypeBadge(type) {
    switch (type) {
      case 'price_above':
      case 'price_below':
        return '<span class="type-badge price">Price ' + (type === 'price_above' ? 'Above' : 'Below') + '</span>';
      case 'vol_spike':
        return '<span class="type-badge volume">Volume Spike</span>';
      case 'sr_touch':
        return '<span class="type-badge sr">S/R Pattern</span>';
      default:
        return '<span class="type-badge price">Price</span>';
    }
  },

  /**
   * Get condition display text.
   * @param {Object} a
   * @returns {string}
   */
  getConditionText(a) {
    var type = a.type || '';
    var price = a.threshold ? Number(a.threshold).toFixed(2) : '0.00';
    switch (type) {
      case 'price_above': return '$' + price;
      case 'price_below': return '$' + price;
      case 'vol_spike': return (a.multiplier || '2.0') + 'x avg';
      case 'sr_touch':
        var srType = a.sr_type || 'Support';
        return srType + ' $' + (a.sr_price || price);
      default: return '$' + price;
    }
  },

  /**
   * Render activity log in right column.
   */
  renderActivityLog() {
    var logEl = document.getElementById('alertLog');
    if (!logEl) return;

    // Use history data if available, otherwise show empty state
    var entries = this.history && this.history.length > 0 ? this.history : [];

    if (!Array.isArray(entries) || entries.length === 0) {
      logEl.innerHTML = '<div class="empty-state" style="padding:var(--space-6);text-align:center;color:var(--color-text-tertiary);font-size:var(--font-size-sm);">' +
        '<p>No recent alert activity</p>' +
        '<p style="margin-top:var(--space-2);font-size:var(--font-size-xs);">Alert triggers will appear here</p>' +
      '</div>';
      return;
    }

    logEl.innerHTML = entries.map(function(entry) {
      var type = entry.type || 'price';
      var indicatorClass = type;
      var message = entry.message || '';
      var time = entry.fired_at || entry.time || entry.created_at || '';

      // Detect S/R alerts and add pattern-based icon + styling
      var icon = '';
      if (type === 'sr_touch') {
        // Parse "TICKER — Support/Resistance $PRICE — Pattern X"
        var match = message.match(/(\w+)\s*—\s*(\w+)\s*\$(\d+\.?\d*)\s*—\s*Pattern\s+([A-D])/i);
        if (match) {
          var srType = match[2].toLowerCase();
          var pattern = match[4].toUpperCase();
          // A/B = bounce/reject (green/red), C/D = break/breakout (orange/blue)
          var isBreak = pattern === 'C' || pattern === 'D';
          if (srType === 'support') {
            icon = isBreak ? '⚠️' : '🟢';
            indicatorClass = isBreak ? 'sr-break' : 'support';
          } else {
            icon = isBreak ? '🚀' : '🔴';
            indicatorClass = isBreak ? 'sr-break' : 'resistance';
          }
        } else {
          icon = '📊';
          indicatorClass = 'sr_touch';
        }
      }

      return '<div class="log-entry">' +
        '<div class="log-indicator ' + indicatorClass + '" aria-hidden="true"></div>' +
        '<div class="log-content">' +
          '<div class="log-message">' + (icon ? icon + ' ' : '') + Alerts._escapeHtml(message) + '</div>' +
          '<div class="log-time">' + Alerts._formatLogTime(time) + '</div>' +
        '</div>' +
      '</div>';
    }).join('');

    // Update bell icon badge count
    this._updateAlertBadge();
  },

  /**
   * Format log time as relative time (e.g., "5m ago", "2h ago").
   */
  _formatLogTime(timeStr) {
    if (!timeStr) return '';
    try {
      var d = new Date(timeStr.endsWith('Z') ? timeStr : timeStr + 'Z');
      var now = new Date();
      var diffMs = now - d;
      var diffMins = Math.floor(diffMs / 60000);
      if (diffMins < 1) return 'Just now';
      if (diffMins < 60) return diffMins + 'm ago';
      var diffHours = Math.floor(diffMins / 60);
      if (diffHours < 24) return diffHours + 'h ago';
      var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      return months[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0');
    } catch (e) {
      return timeStr;
    }
  },

  /**
   * Escape HTML to prevent XSS.
   */
  _escapeHtml(str) {
    if (!str) return '';
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  },

  /**
   * Update bell icon badge with today's alert count.
   */
  _updateAlertBadge() {
    var badge = document.getElementById('alertBadge');
    if (!badge) return;

    if (!this.history || this.history.length === 0) {
      badge.hidden = true;
      badge.classList.remove('visible');
      return;
    }

    // Count alerts fired today
    var today = new Date();
    var todayStr = today.getFullYear() + '-' +
      String(today.getMonth() + 1).padStart(2, '0') + '-' +
      String(today.getDate()).padStart(2, '0');

    var count = 0;
    for (var i = 0; i < this.history.length; i++) {
      var firedAt = this.history[i].fired_at || '';
      if (firedAt && firedAt.substring(0, 10) === todayStr) {
        count++;
      }
    }

    if (count > 0) {
      badge.textContent = count > 99 ? '99+' : String(count);
      badge.hidden = false;
      // Use rAF to ensure hidden=false renders before adding visible class
      requestAnimationFrame(function() {
        badge.classList.add('visible');
      });
    } else {
      badge.hidden = true;
      badge.classList.remove('visible');
    }
  },

  /**
   * Load watchlist tickers from the API with live quotes.
   */
  async loadWatchlist() {
    try {
      // Get watchlist IDs and names
      const watchlists = await API.get('/watchlists');

      // Populate the watchlist select dropdown
      var select = document.getElementById('watchlistSelect');
      if (select) {
        select.innerHTML = '';
        if (Array.isArray(watchlists) && watchlists.length > 0) {
          watchlists.forEach(function(wl) {
            var opt = document.createElement('option');
            opt.value = wl.id;
            opt.textContent = wl.name + ' (' + (wl.ticker_count || 0) + ')';
            select.appendChild(opt);
          });
        }
      }

      // If no watchlists exist, show empty state
      if (!watchlists || watchlists.length === 0) {
        this.watchlistTickers = [];
        this.renderWatchlist();
        return;
      }

      // Use first watchlist if activeWatchlist not set
      if (!this.activeWatchlist) {
        this.activeWatchlist = watchlists[0].id;
      }

      // Sync the select dropdown with the active watchlist
      if (select) {
        select.value = this.activeWatchlist;
      }

      // Get tickers for the active watchlist
      const tickers = await API.get(`/watchlists/${this.activeWatchlist}/tickers`);
      
      if (!tickers || tickers.length === 0) {
        this.watchlistTickers = [];
        this.renderWatchlist();
        return;
      }

      // Get live quotes for the tickers
      const tickerList = tickers.map(t => t.ticker).join(',');
      const quotesData = await API.get(`/data/quotes?tickers=${tickerList}`);
      
      // Combine ticker data with quotes
      this.watchlistTickers = tickers.map(t => {
        const quote = quotesData.quotes.find(q => q.ticker === t.ticker);
        if (quote) {
          const price = quote.price || 0;
          const change = quote.change_pct || 0;
          const changeStr = (change >= 0 ? '+' : '') + change.toFixed(2) + '%';
          return {
            ticker: t.ticker,
            price: '$' + price.toFixed(2),
            change: changeStr,
            pos: change >= 0
          };
        }
        // Fallback if no quote data
        return {
          ticker: t.ticker,
          price: '--',
          change: '--',
          pos: true
        };
      });

      this.renderWatchlist();
    } catch (err) {
      console.error('[Alerts] Failed to load watchlist:', err);
      this.watchlistTickers = [];
      this.renderWatchlist();
      this._showInlineError('watchlistTickers', 'Unable to load watchlist data', () => this.loadWatchlist());
    }
  },

  /**
   * Render watchlist ticker list.
   */
  renderWatchlist() {
    var container = document.getElementById('watchlistTickers');
    if (!container) return;

    var header = '<div class="ticker-list-header">' +
      '<span class="ticker-col-label">Ticker</span>' +
      '<span class="ticker-col-label">Price</span>' +
      '<span class="ticker-col-label">Change</span>' +
      '<span class="ticker-col-spacer"></span>' +
    '</div>';

    var sortedTickers = this.watchlistTickers.slice().sort(function(a, b) {
      return a.ticker.localeCompare(b.ticker, undefined, { sensitivity: 'base' });
    });

    var rows = sortedTickers.map(function(t) {
      return '<div class="ticker-row" data-ticker="' + t.ticker + '">' +
        '<span class="ticker-symbol">' + t.ticker + '</span>' +
        '<span class="ticker-price">' + t.price + '</span>' +
        '<span class="ticker-change ' + (t.pos ? 'pos' : 'neg') + '">' + t.change + '</span>' +
        '<button class="ticker-remove" title="Remove ' + t.ticker + '" aria-label="Remove ' + t.ticker + ' from watchlist">&times;</button>' +
      '</div>';
    }).join('');

    container.innerHTML = header + rows;

    // Update select option count
    var select = document.getElementById('watchlistSelect');
    if (select) {
      var opt = select.querySelector('option[value="' + this.activeWatchlist + '"]');
      if (opt) {
        var name = opt.textContent.replace(/\s*\(\d+\)$/, '');
        opt.textContent = name + ' (' + this.watchlistTickers.length + ')';
      }
    }
  },

  // ─── WATCHLIST MANAGEMENT ────────────────────────────

  /**
   * Clear ticker validation status icon and info line.
   */
  _clearTickerValidation() {
    clearTimeout(this._tickerValidationDebounce);
    const status = document.getElementById('wl-ticker-validation');
    const info = document.getElementById('wl-ticker-info');
    if (status) { status.textContent = ''; status.className = 'ticker-validation'; }
    if (info) info.textContent = '';
  },

  /**
   * Validate ticker on blur — calls backend endpoint, shows status inline.
   * Uses cache to avoid redundant API calls. Matches portfolio validation exactly.
   */
  async _validateTickerOnBlur() {
    const status = document.getElementById('wl-ticker-validation');
    const info = document.getElementById('wl-ticker-info');
    const tickerInput = document.getElementById('tickerSearchInput');
    if (!status || !info || !tickerInput) return;

    clearTimeout(this._tickerValidationDebounce);

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

  /**
   * Validate alert creation ticker on blur — calls backend endpoint,
   * shows company name in #tickerCompany or error state.
   * Uses the shared tickerValidationCache.
   */
  async _validateTickerInputOnBlur() {
    const tickerInput = document.getElementById('tickerInput');
    const company = document.getElementById('tickerCompany');
    if (!tickerInput) return;

    clearTimeout(this._alertTickerValidationDebounce);

    let ticker = (tickerInput.value || '').trim();
    if (!ticker) {
      this.clearFieldError('tickerInput', 'tickerError');
      if (company) { company.textContent = ''; company.classList.remove('visible'); }
      return;
    }
    ticker = ticker.toUpperCase();
    if (ticker.length < 1 || ticker.length > 5) {
      this.clearFieldError('tickerInput', 'tickerError');
      if (company) { company.textContent = ''; company.classList.remove('visible'); }
      return;
    }

    // Check cache first
    if (this.tickerValidationCache[ticker]) {
      const cached = this.tickerValidationCache[ticker];
      if (cached.valid) {
        this.clearFieldError('tickerInput', 'tickerError');
        if (company) {
          company.textContent = cached.company + (cached.sector ? ' \u00B7 ' + cached.sector : '');
          company.classList.add('visible');
        }
      } else {
        this.showFieldError('tickerInput', 'tickerError');
        if (company) { company.textContent = ''; company.classList.remove('visible'); }
      }
      return;
    }

    // Show loading state — clear error while fetching
    this.clearFieldError('tickerInput', 'tickerError');
    if (company) { company.textContent = 'Checking\u2026'; company.classList.add('visible'); }

    try {
      const r = await API.get('/validate-ticker/' + encodeURIComponent(ticker));
      this.tickerValidationCache[ticker] = r;
      if (r.valid) {
        this.clearFieldError('tickerInput', 'tickerError');
        if (company) {
          company.textContent = r.company + (r.sector ? ' \u00B7 ' + r.sector : '');
          company.classList.add('visible');
        }
      } else {
        this.showFieldError('tickerInput', 'tickerError');
        if (company) { company.textContent = ''; company.classList.remove('visible'); }
      }
    } catch (e) {
      this.showFieldError('tickerInput', 'tickerError');
      if (company) { company.textContent = ''; company.classList.remove('visible'); }
    }
  },

  /**
   * Handle Add button / Enter key press for ticker input.
   * Only adds if validation passed (status has 'valid' class).
   */
  _handleAddTickerFromInput() {
    const tickerInput = document.getElementById('tickerSearchInput');
    const status = document.getElementById('wl-ticker-validation');
    if (!tickerInput) return;

    const ticker = (tickerInput.value || '').trim().toUpperCase();
    if (!ticker) return;

    // Check if validation passed
    if (status && status.classList.contains('valid')) {
      this.handleAddTickerToWatchlist(ticker);
      this._clearTickerValidation();
      return;
    }

    // Not validated — show feedback
    // Shake the input
    tickerInput.classList.remove('shake');
    void tickerInput.offsetWidth; // reflow trigger
    tickerInput.classList.add('shake');
    setTimeout(() => tickerInput.classList.remove('shake'), 350);
    this.showToast('Enter a valid ticker first (e.g. NVDA)');
  },

  /**
   * Add ticker to current watchlist.
   * Fetches live price from API and persists the addition.
   * @param {string} ticker
   */
  async handleAddTickerToWatchlist(ticker) {
    // Check if already in watchlist
    var exists = this.watchlistTickers.some(function(t) { return t.ticker === ticker; });
    if (exists) {
      this.showToast(ticker + ' is already in this watchlist');
      this._clearWatchlistInput();
      return;
    }

    // Persist addition via API
    if (this.activeWatchlist) {
      try {
        await API.post('/watchlists/' + this.activeWatchlist + '/tickers', { ticker: ticker });
      } catch (err) {
        console.error('[Alerts] Failed to add ticker to watchlist:', err);
        this.showToast('Failed to add ' + ticker + ' to watchlist');
        return;
      }
    }

    // Refresh watchlist from API (which includes live quotes)
    await this.loadWatchlist();

    this._clearWatchlistInput();
    this.showToast(ticker + ' added to watchlist');
  },

  /**
   * Clear the watchlist input, validation status, and info line.
   */
  _clearWatchlistInput() {
    var searchInput = document.getElementById('tickerSearchInput');
    if (searchInput) searchInput.value = '';
    this._clearTickerValidation();
  },

  /**
   * Show create watchlist modal.
   */
  showCreateWLModal() {
    document.getElementById('createWLModal').classList.add('visible');
    var input = document.getElementById('createWLInput');
    if (input) {
      input.value = '';
      setTimeout(function() { input.focus(); }, 100);
    }
  },

  /**
   * Hide create watchlist modal.
   */
  hideCreateWLModal() {
    document.getElementById('createWLModal').classList.remove('visible');
  },

  /**
   * Handle creating a new watchlist.
   * Persists the watchlist to the database via API.
   */
  async handleCreateWatchlist() {
    var input = document.getElementById('createWLInput');
    var name = input ? input.value.trim() : '';
    if (!name) return;

    try {
      var result = await API.post('/watchlists', { name: name });
      var watchlistId = result.id;

      // Add option to the select
      var select = document.getElementById('watchlistSelect');
      if (select) {
        var opt = document.createElement('option');
        opt.value = watchlistId;
        opt.textContent = name + ' (0)';
        select.appendChild(opt);
        select.value = watchlistId;
      }
      this.activeWatchlist = watchlistId;

      this.hideCreateWLModal();
      this.watchlistTickers = [];
      this.renderWatchlist();
      this.showToast('Watchlist "' + name + '" created');
    } catch (err) {
      console.error('[Alerts] Failed to create watchlist:', err);
      this.showToast('Failed to create watchlist');
    }
  },

  /**
   * Show manage watchlists modal.
   * Renders each watchlist with rename (pencil) and delete (trash) icon buttons,
   * matching the design mockup's inline edit / delete confirmation pattern.
   */
  showManageWLModal() {
    var modal = document.getElementById('manageWLModal');
    var list = document.getElementById('manageWLList');
    if (!modal || !list) return;

    var select = document.getElementById('watchlistSelect');
    var options = select ? Array.from(select.options) : [];
    var activeId = this.activeWatchlist;

    // Build each manage-item with: name, edit-wrap, badge, confirm, btns
    list.innerHTML = options.map(function(opt) {
      var isActive = opt.value === activeId;
      var watchlistName = opt.textContent.replace(/\s*\(\d+\)$/, '');
      var tickerCount = (opt.textContent.match(/\((\d+)\)$/)||[])[1] || '0';

      return '<div class="manage-item' + (isActive ? ' active' : '') + '" role="listitem" data-key="' + opt.value + '">' +
        '<div class="manage-name-wrap"><div class="manage-name">' + Alerts._escapeHtml(watchlistName) + '</div></div>' +
        '<div class="manage-edit-wrap">' +
          '<input type="text" class="manage-edit-input" value="' + Alerts._escapeHtml(watchlistName) + '" maxlength="30" autocomplete="off">' +
          '<div class="manage-edit-error">Name cannot be empty</div>' +
          '<div class="manage-edit-actions">' +
            '<button class="manage-edit-save" data-rename-save="' + opt.value + '">Save</button>' +
            '<button class="manage-edit-cancel" data-rename-cancel="' + opt.value + '">Cancel</button>' +
          '</div>' +
        '</div>' +
        '<span class="manage-badge">' + tickerCount + ' tickers</span>' +
        '<div class="manage-confirm">' +
          '<span class="manage-confirm-text">Delete?</span>' +
          '<button class="manage-confirm-delete" data-confirm-delete="' + opt.value + '">Delete</button>' +
          '<button class="manage-confirm-cancel" data-cancel-delete="' + opt.value + '">Cancel</button>' +
        '</div>' +
        '<div class="manage-btns">' +
          '<button class="manage-icon-btn" data-manage-rename="' + opt.value + '" title="Rename" aria-label="Rename ' + Alerts._escapeHtml(watchlistName) + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg></button>' +
          '<button class="manage-icon-btn delete" data-manage-delete="' + opt.value + '" title="Delete" aria-label="Delete ' + Alerts._escapeHtml(watchlistName) + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg></button>' +
        '</div>' +
      '</div>';
    }).join('');

    if (options.length === 0) {
      list.innerHTML = '<div class="manage-empty">No watchlists yet. Create one to get started.</div>';
    }

    // ── Rename (pencil) button handlers ──
    list.querySelectorAll('[data-manage-rename]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        // Close any other editing/deleting items first
        list.querySelectorAll('.manage-item.editing').forEach(function(i) { i.classList.remove('editing'); });
        list.querySelectorAll('.manage-item.deleting').forEach(function(i) { i.classList.remove('deleting'); });
        var item = btn.closest('.manage-item');
        item.classList.add('editing');
        var input = item.querySelector('.manage-edit-input');
        var nameEl = item.querySelector('.manage-name');
        input.value = nameEl.textContent;
        input.focus();
        input.select();
      });
    });

    // ── Rename save button handlers ──
    list.querySelectorAll('[data-rename-save]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var item = btn.closest('.manage-item');
        var key = item.dataset.key;
        var input = item.querySelector('.manage-edit-input');
        var newName = input.value.trim();
        if (!newName) {
          item.querySelector('.manage-edit-error').classList.add('visible');
          return;
        }
        item.querySelector('.manage-edit-error').classList.remove('visible');

        // Persist via API
        API.put('/watchlists/' + key, { name: newName }).then(function() {
          // Update the name in the UI
          item.querySelector('.manage-name').textContent = newName;
          item.classList.remove('editing');

          // Update the select dropdown option text
          var sel = document.getElementById('watchlistSelect');
          if (sel) {
            var opt = sel.querySelector('option[value="' + key + '"]');
            if (opt) {
              var match = opt.textContent.match(/\((\d+)\)$/);
              opt.textContent = newName + (match ? ' ' + match[0] : '');
            }
          }
          Alerts.showToast('Watchlist renamed to "' + newName + '"');
        }).catch(function(err) {
          console.error('[Alerts] Failed to rename watchlist:', err);
          Alerts.showToast('Failed to rename watchlist');
          item.classList.remove('editing');
        });
      });
    });

    // ── Rename cancel button handlers ──
    list.querySelectorAll('[data-rename-cancel]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var item = btn.closest('.manage-item');
        item.classList.remove('editing');
        item.querySelector('.manage-edit-error').classList.remove('visible');
      });
    });

    // ── Rename input: Enter to save, Escape to cancel ──
    list.querySelectorAll('.manage-edit-input').forEach(function(input) {
      input.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          var item = input.closest('.manage-item');
          var saveBtn = item.querySelector('[data-rename-save]');
          if (saveBtn) saveBtn.click();
        } else if (e.key === 'Escape') {
          var item = input.closest('.manage-item');
          item.classList.remove('editing');
          item.querySelector('.manage-edit-error').classList.remove('visible');
        }
      });
    });

    // ── Delete (trash) button handlers → show confirmation ──
    list.querySelectorAll('[data-manage-delete]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        list.querySelectorAll('.manage-item.editing').forEach(function(i) { i.classList.remove('editing'); });
        list.querySelectorAll('.manage-item.deleting').forEach(function(i) { i.classList.remove('deleting'); });
        var item = btn.closest('.manage-item');
        item.classList.add('deleting');
      });
    });

    // ── Delete confirm button handlers ──
    list.querySelectorAll('[data-confirm-delete]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var key = btn.dataset.confirmDelete;
        var item = btn.closest('.manage-item');
        var nameEl = item.querySelector('.manage-name');
        var name = nameEl ? nameEl.textContent : '';

        API.delete('/watchlists/' + key).then(function() {
          // Animate removal
          item.style.transition = 'opacity 0.3s, max-height 0.3s';
          item.style.opacity = '0';
          item.style.maxHeight = '0';
          item.style.overflow = 'hidden';
          setTimeout(function() {
            item.remove();
            // Remove from the select dropdown
            var sel = document.getElementById('watchlistSelect');
            if (sel) {
              var opt = sel.querySelector('option[value="' + key + '"]');
              if (opt) opt.remove();
            }
            // If deleted the active watchlist, switch to the first remaining one
            if (Alerts.activeWatchlist === key) {
              var sel = document.getElementById('watchlistSelect');
              Alerts.activeWatchlist = sel && sel.options.length > 0 ? sel.options[0].value : null;
              Alerts.loadWatchlist();
            }
          }, 300);
          Alerts.showToast('Watchlist "' + name + '" deleted');
        }).catch(function(err) {
          console.error('[Alerts] Failed to delete watchlist:', err);
          Alerts.showToast('Failed to delete watchlist');
          item.classList.remove('deleting');
        });
      });
    });

    // ── Delete cancel button handlers ──
    list.querySelectorAll('[data-cancel-delete]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var item = btn.closest('.manage-item');
        item.classList.remove('deleting');
      });
    });

    modal.classList.add('visible');
  },

  /**
   * Hide manage watchlists modal.
   */
  hideManageWLModal() {
    document.getElementById('manageWLModal').classList.remove('visible');
  },

  // ─── FORM HELPERS ────────────────────────────────────

  /**
   * Reset the create alert form.
   */
  resetForm() {
    var form = document.getElementById('alertForm');
    if (form) form.reset();
    this.clearFieldError('tickerInput', 'tickerError');
    this.clearFieldError('thresholdInput', 'thresholdError');
    var company = document.getElementById('tickerCompany');
    if (company) { company.textContent = ''; company.classList.remove('visible'); }
    clearTimeout(this._alertTickerValidationDebounce);
  },

  /**
   * Update threshold label based on alert type.
   */
  updateThresholdLabel() {
    var type = document.getElementById('alertType');
    var label = document.getElementById('thresholdLabel');
    var hint = document.getElementById('thresholdHint');
    if (!type || !label) return;

    switch (type.value) {
      case 'vol_spike':
        label.textContent = 'Volume Multiplier (x)';
        if (hint) hint.textContent = 'Enter multiplier relative to average volume (e.g. 2.0)';
        break;
      case 'sr_touch':
        label.textContent = 'S/R Price Level ($)';
        if (hint) hint.textContent = 'Enter the support or resistance price level';
        break;
      default:
        label.textContent = 'Threshold Price ($)';
        if (hint) hint.textContent = 'Enter the price level to monitor';
    }
  },

  /**
   * Show field validation error.
   * @param {string} inputId
   * @param {string} errorId
   */
  showFieldError(inputId, errorId) {
    var input = document.getElementById(inputId);
    var error = document.getElementById(errorId);
    if (input) input.classList.add('error');
    if (error) error.classList.add('visible');
  },

  /**
   * Clear field validation error.
   * @param {string} inputId
   * @param {string} errorId
   */
  clearFieldError(inputId, errorId) {
    var input = document.getElementById(inputId);
    var error = document.getElementById(errorId);
    if (input) input.classList.remove('error');
    if (error) error.classList.remove('visible');
  },

  // ─── UI HELPERS ──────────────────────────────────────

  showLoading() {
    var loading = document.getElementById('loadingState');
    var mainContent = document.getElementById('mainContent');
    var statsRow = document.getElementById('statsRow');
    if (loading) loading.classList.add('visible');
    if (mainContent) mainContent.style.display = 'none';
    if (statsRow) statsRow.classList.add('hidden');
  },

  hideLoading() {
    var loading = document.getElementById('loadingState');
    if (loading) loading.classList.remove('visible');
  },

  showError(message) {
    this.hideLoading();
    var banner = document.getElementById('errorBanner');
    var msgEl = document.getElementById('errorBannerMsg');
    if (banner) banner.classList.add('visible');
    if (msgEl) msgEl.textContent = message;
  },

  hideError() {
    var banner = document.getElementById('errorBanner');
    if (banner) banner.classList.remove('visible');
  },

  /**
   * Show an inline error message inside a container element.
   * @param {string} containerId - ID of the container to show error in
   * @param {string} message - Error message to display
   * @param {Function|null} retryFn - Optional retry function
   */
  _showInlineError(containerId, message, retryFn) {
    var container = document.getElementById(containerId);
    if (!container) return;

    var retryId = 'retry-' + containerId + '-' + Date.now();
    container.innerHTML = '<div class="error-message" role="alert">' +
      '<p class="error-text">' + this._escapeHtml(message) + '</p>' +
      (retryFn ? '<button class="retry-btn" id="' + retryId + '">Retry</button>' : '') +
    '</div>';

    if (retryFn) {
      var retryBtn = document.getElementById(retryId);
      if (retryBtn) {
        retryBtn.addEventListener('click', function() {
          container.innerHTML = '';
          retryFn();
        });
      }
    }
  },

  /**
   * Escape HTML special characters.
   * @param {string} str
   * @returns {string}
   */
  _escapeHtml(str) {
    if (!str) return '';
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  },

  showConfirmDialog() {
    document.getElementById('confirmOverlay').classList.add('visible');
  },

  hideConfirmDialog() {
    document.getElementById('confirmOverlay').classList.remove('visible');
    this.pendingDeleteId = null;
  },

  /**
   * Format a date string for display.
   * @param {string} dateStr
   * @returns {string}
   */
  formatDate(dateStr) {
    if (!dateStr) return '—';
    try {
      var d = new Date(dateStr);
      var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      return months[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
    } catch (e) {
      return dateStr;
    }
  },

  /**
   * Show a toast notification.
   * @param {string} message
   */
  showToast(message) {
    var toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(function() {
      toast.style.transition = 'opacity 0.3s';
      toast.style.opacity = '0';
      setTimeout(function() { toast.remove(); }, 300);
    }, 2500);
  },
};

// ES module export for app.js dynamic import
export default Alerts;

// CommonJS fallback (for Node/testing)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = Alerts;
}
