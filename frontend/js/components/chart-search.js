import TickerMetadata from '../ticker-metadata.js';

/** Header-only chart shortcut. Suggestions come from saved app data, never a market search. */
const ChartSearch = {
  _symbols: new Map(),
  _validations: new Map(),
  _catalogPromise: null,
  _catalogExpiresAt: 0,
  _catalogFailed: false,
  _results: [],
  _active: -1,
  _request: 0,
  _busy: false,

  init(modal) {
    this._modal = modal;
    this._form = document.getElementById('chart-search');
    this._input = document.getElementById('chart-search-input');
    this._clear = document.getElementById('chart-search-clear');
    this._panel = document.getElementById('chart-search-results');
    this._list = document.getElementById('chart-search-options');
    this._status = document.getElementById('chart-search-status');
    if (!this._input) return;

    this._input.addEventListener('focus', () => {
      this._loadCatalog();
      this._render();
    });
    this._input.addEventListener('input', () => {
      const normalized = this._input.value.toUpperCase();
      if (normalized !== this._input.value) this._input.value = normalized;
      this._cancelValidation();
      this._render();
    });
    this._input.addEventListener('keydown', event => {
      if (event.isComposing) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this.close();
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (this._panel.hidden) this._render();
        if (!this._results.length) return;
        this._active = (this._active + (event.key === 'ArrowDown' ? 1 : -1) + this._results.length) % this._results.length;
        this._syncActive();
      }
    });
    this._form.addEventListener('submit', event => {
      event.preventDefault();
      if (this._panel.hidden) this._render();
      const result = this._results[this._active < 0 ? 0 : this._active];
      if (result) this._choose(result);
    });
    this._clear.addEventListener('click', () => {
      this._input.value = '';
      this.close();
      this._clear.hidden = true;
      this._input.focus();
    });
    // Keep focus on the combobox until selection, including when the keyboard is open.
    this._list.addEventListener('pointerdown', event => {
      if (event.target.closest('[role="option"]')) event.preventDefault();
    });
    this._list.addEventListener('click', event => {
      const option = event.target.closest('[role="option"]');
      if (option) this._choose(this._results[Number(option.dataset.index)]);
    });
    document.addEventListener('pointerdown', event => {
      if (!this._form.contains(event.target) && !this._panel.contains(event.target)) this.close();
    });
    this._form.addEventListener('focusout', () => {
      queueMicrotask(() => {
        if (!this._form.contains(document.activeElement) && !this._panel.contains(document.activeElement)) this.close();
      });
    });
    window.addEventListener('resize', () => this._position());
    window.addEventListener('scroll', () => this._position(), { passive: true });
    window.visualViewport?.addEventListener('resize', () => this._position());
  },

  _seed(records) {
    if (!Array.isArray(records)) return;
    for (const record of records) {
      const ticker = TickerMetadata.normalizeTicker(typeof record === 'string' ? record : record?.ticker || record?.symbol);
      if (!ticker) continue;
      const name = TickerMetadata.remember(ticker, record);
      this._symbols.set(ticker, name || this._symbols.get(ticker) || '');
    }
  },

  async _loadCatalog() {
    if (this._catalogPromise || Date.now() < this._catalogExpiresAt) return;
    this._catalogFailed = false;
    this._catalogPromise = Promise.allSettled([
      API.get('/universe').then(records => this._seed(records)),
      API.get('/tabs').then(response => {
        for (const tab of response?.data?.tabs || []) this._seed(tab.tickers);
      }),
      API.get('/portfolio').then(portfolios => {
        for (const portfolio of portfolios || []) this._seed(portfolio.positions);
      }),
    ]);
    const results = await this._catalogPromise;
    this._catalogFailed = results.some(result => result.status === 'rejected');
    this._catalogExpiresAt = Date.now() + (this._catalogFailed ? 30_000 : 300_000);
    this._catalogPromise = null;
    if (document.activeElement === this._input && !this._busy && !this._panel.hidden) this._render({ preserveActive: true });
  },

  _query() {
    return TickerMetadata.normalizeTicker(this._input.value);
  },

  _render({ preserveActive = false } = {}) {
    const activeTicker = preserveActive ? this._results[this._active]?.ticker : null;
    const query = this._query();
    this._clear.hidden = !this._input.value;
    this._list.replaceChildren();
    this._results = [];
    this._active = -1;
    if (!query) {
      this.close();
      return;
    }
    if (!/^[A-Z0-9^][A-Z0-9.^=\-]{0,9}$/.test(query)) {
      this._status.textContent = 'Enter a ticker symbol, such as AAPL or RY.TO.';
    } else {
      const matches = [...this._symbols.keys()].filter(ticker => ticker.includes(query));
      const rank = ticker => ticker === query ? 0 : ticker.startsWith(query) ? 1 : 2;
      matches.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
      this._results = matches.slice(0, 6).map(ticker => ({ ticker, name: this._symbols.get(ticker) }));
      if (!this._symbols.has(query)) this._results.push({ ticker: query, name: 'Check this exact symbol', unverified: true });
      for (const [index, result] of this._results.entries()) {
        const option = document.createElement('div');
        option.id = `chart-search-option-${index}`;
        option.className = 'nav-search-option';
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', 'false');
        option.dataset.index = String(index);
        const text = document.createElement('span');
        text.className = 'nav-search-option-text';
        const symbol = document.createElement('strong');
        symbol.textContent = result.ticker;
        text.append(symbol);
        if (result.name) {
          const name = document.createElement('span');
          name.className = 'nav-search-company';
          name.textContent = result.name;
          text.append(name);
        }
        const action = document.createElement('span');
        action.className = 'nav-search-option-action';
        action.textContent = result.unverified ? 'Look up' : 'View chart';
        option.append(text, action);
        this._list.append(option);
      }
      this._status.textContent = this._catalogPromise ? 'Loading saved symbols…'
        : this._catalogFailed ? 'Some saved symbols are unavailable. Exact lookup is still available.'
          : matches.length ? 'Select a symbol to view its chart.' : 'No saved matches. Look up this exact ticker.';
    }
    if (activeTicker) this._active = this._results.findIndex(result => result.ticker === activeTicker);
    this._panel.hidden = false;
    this._input.setAttribute('aria-expanded', 'true');
    this._syncActive();
    this._position();
  },

  _syncActive() {
    [...this._list.children].forEach((option, index) => option.setAttribute('aria-selected', String(index === this._active)));
    const option = this._list.children[this._active];
    if (option) {
      this._input.setAttribute('aria-activedescendant', option.id);
      option.scrollIntoView({ block: 'nearest' });
    } else this._input.removeAttribute('aria-activedescendant');
  },

  _position() {
    if (this._panel.hidden) return;
    const field = this._form.getBoundingClientRect();
    const viewport = document.documentElement.clientWidth;
    const width = Math.min(viewport - 24, window.innerWidth < 768 ? viewport - 24 : Math.max(320, field.width));
    this._panel.style.width = `${width}px`;
    this._panel.style.left = `${Math.max(12, Math.min(field.left, viewport - width - 12))}px`;
    this._panel.style.top = `${field.bottom + 8}px`;
    const bottom = window.visualViewport ? window.visualViewport.offsetTop + window.visualViewport.height : window.innerHeight;
    this._panel.style.maxHeight = `${Math.max(80, Math.min(384, bottom - field.bottom - 20))}px`;
  },

  _cancelValidation() {
    this._request++;
    this._validationController?.abort();
    this._validationController = null;
    this._busy = false;
    this._form.removeAttribute('aria-busy');
  },

  close() {
    this._cancelValidation();
    this._panel.hidden = true;
    this._input.setAttribute('aria-expanded', 'false');
    this._input.removeAttribute('aria-activedescendant');
  },

  async _choose(result) {
    if (!result || this._busy) return;
    const request = ++this._request;
    let name = result.name;
    if (result.unverified) {
      this._busy = true;
      this._form.setAttribute('aria-busy', 'true');
      this._status.textContent = `Checking ${result.ticker}…`;
      const controller = new AbortController();
      this._validationController = controller;
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        const cached = this._validations.get(result.ticker);
        const validation = cached?.expiresAt > Date.now() ? cached.value
          : await API.get('/validate-ticker/' + encodeURIComponent(result.ticker), {}, controller.signal);
        if (request !== this._request) return;
        this._validations.set(result.ticker, { value: validation, expiresAt: Date.now() + (validation?.valid ? 300_000 : 60_000) });
        if (!validation?.valid) {
          this._status.textContent = `No chart found for ${result.ticker}. Check the ticker and try again.`;
          return;
        }
        name = TickerMetadata.remember(result.ticker, validation);
        this._symbols.set(result.ticker, name);
      } catch {
        if (request === this._request) this._status.textContent = 'Unable to check this ticker. Please try again.';
        return;
      } finally {
        clearTimeout(timeout);
        if (request === this._request) {
          this._busy = false;
          this._validationController = null;
          this._form.removeAttribute('aria-busy');
        }
      }
    }
    if (request !== this._request) return;
    this.close();
    this._input.blur();
    // Restore focus to the search region on close without reopening the mobile keyboard.
    await this._modal.open(result.ticker, name, { trigger: this._form });
  },
};

export default ChartSearch;
