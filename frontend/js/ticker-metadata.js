/**
 * Shared company-name cache for chart callers, independent of portfolio state.
 * Reuses screen metadata before fetching the universe or validating a ticker.
 */
const TickerMetadata = {
  _names: new Map(),
  _pending: new Map(),
  _missingUntil: new Map(),
  _universeRequest: null,
  _universeExpiresAt: 0,
  _UNIVERSE_TTL: 5 * 60 * 1000,
  _RETRY_DELAY: 60 * 1000,

  normalizeTicker(ticker) {
    return typeof ticker === 'string' ? ticker.trim().toUpperCase() : '';
  },

  get(ticker) {
    return this._names.get(this.normalizeTicker(ticker)) || '';
  },

  /** Cache a usable name, preserving an existing name when metadata is empty. */
  remember(ticker, metadata) {
    const symbol = this.normalizeTicker(ticker);
    if (!symbol) return '';
    const candidates = typeof metadata === 'string'
      ? [metadata]
      : [metadata?.company, metadata?.company_name, metadata?.name, metadata?.companyName];
    const name = candidates
      .filter(value => typeof value === 'string')
      .map(value => value.trim())
      .find(value => value && value.toUpperCase() !== symbol
        && !['—', '--', '-', 'N/A', 'UNKNOWN'].includes(value.toUpperCase()));
    if (name) {
      this._names.set(symbol, name);
      this._missingUntil.delete(symbol);
    }
    return this.get(symbol);
  },

  /** A filtered universe response must not mark the full universe as loaded. */
  seed(records, { completeUniverse = false } = {}) {
    if (!Array.isArray(records)) return;
    records.forEach(record => this.remember(record?.ticker || record?.symbol, record));
    if (completeUniverse) this._universeExpiresAt = Date.now() + this._UNIVERSE_TTL;
  },

  resolve(ticker, metadata = '') {
    const symbol = this.normalizeTicker(ticker);
    const name = this.remember(symbol, metadata);
    if (!symbol || name) return Promise.resolve(name);
    if (this._pending.has(symbol)) return this._pending.get(symbol);
    if ((this._missingUntil.get(symbol) || 0) > Date.now()) return Promise.resolve('');

    const request = this._resolveMissing(symbol).finally(() => this._pending.delete(symbol));
    this._pending.set(symbol, request);
    return request;
  },

  async _loadUniverse() {
    if (this._universeExpiresAt > Date.now()) return;
    if (this._universeRequest) return this._universeRequest;
    this._universeRequest = (async () => {
      try {
        const records = await API.get('/universe');
        if (!Array.isArray(records)) throw new Error('Invalid universe response');
        this.seed(records, { completeUniverse: true });
      } catch {
        // Metadata failure must not stop a chart or cause a request per card.
        this._universeExpiresAt = Date.now() + this._RETRY_DELAY;
      }
    })();
    try {
      await this._universeRequest;
    } finally {
      this._universeRequest = null;
    }
  },

  async _resolveMissing(ticker) {
    await this._loadUniverse();
    if (this.get(ticker)) return this.get(ticker);
    try {
      const result = await API.get('/validate-ticker/' + encodeURIComponent(ticker));
      // A screen may have supplied a name while validation was in flight.
      if (!this.get(ticker) && result?.valid) this.remember(ticker, result);
    } catch {
      // Leave the ticker visible and allow a later retry.
    }
    const name = this.get(ticker);
    if (!name) this._missingUntil.set(ticker, Date.now() + this._RETRY_DELAY);
    return name;
  },
};

export default TickerMetadata;
