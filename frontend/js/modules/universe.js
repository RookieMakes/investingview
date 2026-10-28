/**
 * Universe — Stock universe management screen module.
 *
 * Manage the list of tracked stocks. Add, remove, and view the universe.
 * Renders stock cards in a grid layout.
 *
 * API endpoints:
 *   GET    /api/universe       — list universe stocks
 *   POST   /api/universe       — add stock to universe
 *   DELETE /api/universe/:ticker — remove stock from universe
 *
 * @example
 *   // Called by App.loadScreen('universe')
 *   Universe.init();
 */

import TickerMetadata from '../ticker-metadata.js';
import ChartModal from '../components/chart-modal.js';

const Universe = {
  /** @type {Array<Object>|null} */
  data: null,

  /** @type {boolean} */
  loading: false,

  /** @type {string} Current source filter */
  sourceFilter: 'all',

  /** @type {Array<string>} Available sector options */
  sectorOptions: [],

  /** @type {Object} Cache for validated tickers: { [ticker]: { valid, company, sector } } */
  tickerValidationCache: {},

  // ─── INITIALIZATION ──────────────────────────────────

  /**
   * Initialize the Universe screen.
   */
  async init() {
    console.log('[Universe] initialized');
    this.bindEvents();
    await this.loadUniverse();
    await this.loadSectors();
  },

  // ─── EVENT BINDING ───────────────────────────────────

  /**
   * Bind screen-specific event listeners.
   */
  bindEvents() {
    // Add stock button
    const addBtn = document.getElementById('universe-add-btn');
    if (addBtn) {
      addBtn.addEventListener('click', () => this.handleAddStock());
    }

    // Ticker input validation + enter key (mirrors portfolio pattern)
    const tickerInput = document.getElementById('universe-ticker-input');
    if (tickerInput) {
      tickerInput.addEventListener('input', (e) => {
        e.target.value = e.target.value.toUpperCase();
        clearTimeout(this._tickerValidationTimeout);
        const status = document.getElementById('universe-ticker-validation');
        const info = document.getElementById('universe-ticker-info');
        if (status) { status.textContent = ''; status.className = 'ticker-validation'; }
        if (info) { info.textContent = ''; }
      });
      tickerInput.addEventListener('blur', () => this._validateTickerOnBlur());
      tickerInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          this.handleAddStock();
        }
      });
    }

    // Universe list delegation (remove)
    const list = document.getElementById('universe-list');
    if (list) {
      list.addEventListener('click', (e) => {
        const removeBtn = e.target.closest('[data-remove-ticker]');
        if (removeBtn) {
          e.stopPropagation();
          this.handleRemoveStock(removeBtn.dataset.removeTicker);
        }
      });
    }

    // Search / filter
    const searchInput = document.getElementById('universe-search-input');
    if (searchInput) {
      searchInput.addEventListener('input', () => {
        // Auto-uppercase (preserves cursor position)
        const pos = searchInput.selectionStart;
        searchInput.value = searchInput.value.toUpperCase();
        searchInput.setSelectionRange(pos, pos);
        this.filterList(searchInput.value);
      });
    }

    // Sector edit delegation
    if (list) {
      list.addEventListener('click', (e) => {
        const editBtn = e.target.closest('.sector-edit-btn');
        if (editBtn) {
          e.stopPropagation();
          this._showSectorDropdown(editBtn);
        }
      });
    }

    // Ticker click → open chart modal
    if (list) {
      list.addEventListener('click', (e) => {
        if (e.target.closest('button') || e.target.closest('a')) return;
        const card = e.target.closest('.stock-card[data-universe-ticker]');
        if (!card) return;
        const ticker = card.dataset.universeTicker;
        const company = card.dataset.universeCompany || '';
        if (!ticker) return;
        ChartModal.open(ticker, company);
      });
    }

    // Source filter chips
    const filterChips = document.querySelectorAll('.universe-filters .filter-chip');
    filterChips.forEach(chip => {
      chip.tabIndex = chip.getAttribute('aria-checked') === 'true' ? 0 : -1;
      chip.addEventListener('click', () => {
        filterChips.forEach(c => {
          c.classList.remove('active');
          c.setAttribute('aria-checked', 'false');
          c.tabIndex = -1;
        });
        chip.classList.add('active');
        chip.setAttribute('aria-checked', 'true');
        chip.tabIndex = 0;
        this.sourceFilter = chip.dataset.source || 'all';
        // Re-fetch filtered data from the API (not just re-render cached data)
        this.loadUniverse();
      });
      chip.addEventListener('keydown', (e) => {
        const index = [...filterChips].indexOf(chip);
        let next;
        if (e.key === 'ArrowRight') next = (index + 1) % filterChips.length;
        else if (e.key === 'ArrowLeft') next = (index - 1 + filterChips.length) % filterChips.length;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = filterChips.length - 1;
        else return;
        e.preventDefault();
        filterChips[next].focus();
        filterChips[next].click();
      });
    });
  },

  // ─── DATA LOADING ────────────────────────────────────

  /**
   * Load the full stock universe.
   */
  async loadUniverse() {
    this.loading = true;
    this.hideError();
    this.showLoading();

    try {
      const params = {};
      if (this.sourceFilter !== 'all') {
        params.source = this.sourceFilter;
      }
      this.data = await API.get('/universe', params);
      TickerMetadata.seed(this.data, { completeUniverse: !params.source });
      this.hideLoading();
      this.render();

      // Re-apply the current search filter after re-rendering
      const searchInput = document.getElementById('universe-search-input');
      if (searchInput && searchInput.value) {
        this.filterList(searchInput.value);
      }
    } catch (err) {
      this.showError(err.message);
    } finally {
      this.loading = false;
    }
  },

  /**
   * Load available sector options from the API.
   */
  async loadSectors() {
    try {
      this.sectorOptions = await API.get('/universe/sectors');
    } catch (err) {
      console.warn('[Universe] Failed to load sectors:', err.message);
      this.sectorOptions = [];
    }
  },

  // ─── TICKER VALIDATION ───────────────────────────────

  /**
   * Validate the ticker on blur — mirrors portfolio pattern.
   * User types "NVDA", tabs away → calls GET /api/validate-ticker/NVDA
   * → shows ✓ NVIDIA · Technology
   */
  async _validateTickerOnBlur() {
    const status = document.getElementById('universe-ticker-validation');
    const info = document.getElementById('universe-ticker-info');
    const tickerInput = document.getElementById('universe-ticker-input');
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

    if (this.tickerValidationCache[ticker]) {
      const cached = this.tickerValidationCache[ticker];
      status.textContent = cached.valid ? '\u2713' : '\u2717';
      status.className = 'ticker-validation ' + (cached.valid ? 'valid' : 'invalid');
      info.textContent = cached.valid ? cached.company + ' \u00B7 ' + cached.sector : '';
      return;
    }

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

  // ─── USER ACTIONS ────────────────────────────────────

  /**
   * Handle adding a stock to the universe.
   */
  async handleAddStock() {
    const tickerInput = document.getElementById('universe-ticker-input');
    const ticker = tickerInput ? tickerInput.value.trim().toUpperCase() : '';

    if (!ticker) {
      if (tickerInput) tickerInput.focus();
      return;
    }

    let companyName = '';

    if (this.tickerValidationCache[ticker] && this.tickerValidationCache[ticker].valid) {
      companyName = this.tickerValidationCache[ticker].company;
    } else {
      try {
        const r = await API.get('/validate-ticker/' + encodeURIComponent(ticker));
        this.tickerValidationCache[ticker] = r;
        if (r.valid) {
          companyName = r.company;
        } else {
          this.showError('Ticker not found — cannot add to universe');
          return;
        }
      } catch (e) {
        this.showError('Failed to validate ticker: ' + e.message);
        return;
      }
    }

    try {
      await API.post('/universe', { ticker, company_name: companyName || ticker });
      if (tickerInput) tickerInput.value = '';
      const status = document.getElementById('universe-ticker-validation');
      const info = document.getElementById('universe-ticker-info');
      if (status) { status.textContent = ''; status.className = 'ticker-validation'; }
      if (info) { info.textContent = ''; }
      delete this.tickerValidationCache[ticker];
      await this.loadUniverse();
    } catch (err) {
      this.showError(err.message);
    }
  },

  /**
   * Handle removing a stock from the universe.
   *
   * @param {string} ticker
   */
  async handleRemoveStock(ticker) {
    try {
      await API.delete(`/universe/${encodeURIComponent(ticker)}`);
      await this.loadUniverse();
    } catch (err) {
      this.showError(err.message);
    }
  },

  // ─── FILTERING ───────────────────────────────────────

  /**
   * Filter the displayed universe list by search term.
   *
   * @param {string} query
   */
  filterList(query) {
    if (!this.data) return;

    const normalizedQuery = query.trim().toUpperCase();
    const items = document.querySelectorAll('[data-universe-ticker]');

    items.forEach((item) => {
      const ticker = item.dataset.universeTicker || '';
      const company = (item.dataset.universeCompany || '').toUpperCase();
      const matches = !normalizedQuery || ticker.includes(normalizedQuery) || company.includes(normalizedQuery);
      item.style.display = matches ? '' : 'none';
    });

    // Update visible count
    this._updateVisibleCount(query);
  },

  _updateVisibleCount(query) {
    const countEl = document.getElementById('universe-count');
    if (!countEl || !this.data) return;

    if (!query || !query.trim()) {
      countEl.textContent = `${this.data.length} stocks in universe`;
      return;
    }

    const visible = document.querySelectorAll('[data-universe-ticker]:not([style*="display: none"])').length;
    countEl.textContent = `${visible} of ${this.data.length} stocks`;
  },

  // ─── SECTOR EDITING ─────────────────────────────────

  /**
   * Show an inline sector dropdown next to the edit button.
   * @param {HTMLElement} btn - The pencil button element
   */
  _showSectorDropdown(btn) {
    // Close any existing dropdown
    this._hideSectorDropdown();

    const ticker = btn.dataset.ticker;
    const currentSector = btn.dataset.sector;

    // Create dropdown
    const dropdown = document.createElement('div');
    dropdown.className = 'sector-dropdown';
    dropdown.id = 'sector-dropdown-active';

    const options = this.sectorOptions.length > 0
      ? this.sectorOptions
      : ['Technology', 'Health Care', 'Financials', 'Energy', 'Consumer Discretionary', 'Industrials', 'Communication Services', 'Consumer Staples', 'Materials', 'Real Estate', 'Utilities', 'ETF'];

    dropdown.innerHTML = options
      .map(s => `<button class="sector-option${s === currentSector ? ' active' : ''}" data-sector="${this._esc(s)}">${this._esc(s)}</button>`)
      .join('');

    // Position below the button
    btn.parentElement.style.position = 'relative';
    btn.parentElement.appendChild(dropdown);

    // Handle option click
    dropdown.addEventListener('click', async (e) => {
      const option = e.target.closest('.sector-option');
      if (option) {
        const newSector = option.dataset.sector;
        await this._updateSector(ticker, newSector);
        this._hideSectorDropdown();
      }
    });

    // Close on outside click (delayed to avoid catching the current click)
    setTimeout(() => {
      document.addEventListener('click', this._sectorDropdownCloseHandler = (e) => {
        if (!e.target.closest('.sector-dropdown') && !e.target.closest('.sector-edit-btn')) {
          this._hideSectorDropdown();
        }
      });
    }, 0);
  },

  /**
   * Hide the active sector dropdown.
   */
  _hideSectorDropdown() {
    const existing = document.getElementById('sector-dropdown-active');
    if (existing) existing.remove();
    if (this._sectorDropdownCloseHandler) {
      document.removeEventListener('click', this._sectorDropdownCloseHandler);
      this._sectorDropdownCloseHandler = null;
    }
  },

  /**
   * Update a stock's sector via the API.
   * @param {string} ticker
   * @param {string} sector
   */
  async _updateSector(ticker, sector) {
    try {
      await API.put(`/universe/${encodeURIComponent(ticker)}`, { sector });
      await this.loadUniverse();
    } catch (err) {
      this.showError(err.message);
    }
  },

  // ─── RENDERING ───────────────────────────────────────

  /**
   * Render the universe list as stock cards.
   */
  render() {
    const body = document.getElementById('universe-body');
    if (!body) return;

    const list = document.getElementById('universe-list');
    if (!list) return;

    const countEl = document.getElementById('universe-count');

    if (!Array.isArray(this.data) || this.data.length === 0) {
      list.innerHTML = '<div class="empty-state" style="grid-column:1/-1;text-align:center;padding:var(--space-8);color:var(--color-text-tertiary)">Universe is empty. Add stocks to get started.</div>';
      if (countEl) countEl.textContent = '0 stocks in universe';
      return;
    }

    if (countEl) countEl.textContent = `${this.data.length} stocks in universe`;

    list.innerHTML = this.data
      .map((stock) => {
        const source = stock.source || 'default';
        const sourceLabel = source === 'custom' ? 'Custom' : 'Default';
        const ticker = stock.ticker || '';
        const company = stock.company_name || '';
        const sector = stock.sector || '';

        return `
        <div class="stock-card" role="listitem" tabindex="0"
             data-universe-ticker="${this._esc(ticker)}"
             data-universe-company="${this._esc(company)}"
             aria-label="${this._esc(ticker)}${company ? ' — ' + this._esc(company) : ''}">
          <div class="stock-card-header">
            <span class="stock-card-ticker">${this._esc(ticker)}</span>
            <span class="stock-card-source ${source}">${sourceLabel}</span>
          </div>
          <div class="stock-card-company">${this._esc(company)}</div>
          <div class="stock-card-footer">
            <span class="stock-card-sector">${this._esc(sector)}${source === 'custom' ? `<button class="sector-edit-btn" data-ticker="${this._esc(ticker)}" data-sector="${this._esc(sector)}" title="Edit sector" aria-label="Edit sector for ${this._esc(ticker)}"><svg width="10" height="10" viewBox="0 0 12 12" fill="none"><path d="M8.5 1.5l2 2M1 8l5-5 2 2-5 5H1V8z" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>` : ''}</span>
            ${source === 'custom' ? `
            <button class="stock-card-remove" data-remove-ticker="${this._esc(ticker)}"
                    aria-label="Remove ${this._esc(ticker)} from universe"
                    title="Remove from universe">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3.5 3.5l7 7M10.5 3.5l-7 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
            </button>` : ''}
          </div>
        </div>`;
      })
      .join('');
  },

  // ─── UI HELPERS ──────────────────────────────────────

  showLoading() {
    const loading = document.getElementById('universe-loading');
    const body = document.getElementById('universe-body');
    if (loading) loading.classList.remove('hidden');
    if (body) body.classList.add('hidden');
  },

  hideLoading() {
    const loading = document.getElementById('universe-loading');
    const body = document.getElementById('universe-body');
    if (loading) loading.classList.add('hidden');
    if (body) body.classList.remove('hidden');
  },

  showError(message) {
    const error = document.getElementById('universe-error');
    const body = document.getElementById('universe-body');
    const loading = document.getElementById('universe-loading');
    if (loading) loading.classList.add('hidden');
    if (error) {
      const msgEl = error.querySelector('.error-message');
      if (msgEl) msgEl.textContent = message;
      error.classList.remove('hidden');
    }
    if (body) body.classList.add('hidden');
  },

  hideError() {
    const error = document.getElementById('universe-error');
    if (error) error.classList.add('hidden');
  },

  /**
   * Destroy the Universe screen — clean up event listeners.
   * Called by app.js on screen transitions.
   */
  destroy() {
    if (this._escapeKeyHandler) {
      document.removeEventListener('keydown', this._escapeKeyHandler);
      this._escapeKeyHandler = null;
    }
    this._hideSectorDropdown();
  },

  _esc(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  },
};

// ES module export for app.js dynamic import
export default Universe;

// CommonJS fallback (for Node/testing)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = Universe;
}
