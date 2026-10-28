/**
 * API — Typed HTTP client for backend communication.
 *
 * All backend calls go through this layer. Components never fetch directly.
 * Handles JSON serialization, error normalization, and request cancellation.
 *
 * @example
 *   const portfolio = await API.get('/portfolio');
 *   const trade = await API.post('/trades', { ticker: 'AAPL', qty: 10 });
 */

const API = {
  baseUrl: '/api',

  /**
   * Internal fetch wrapper with error handling.
   *
   * @param {string} url - Full URL to fetch
   * @param {RequestInit} options - Fetch options
   * @param {AbortSignal} [signal] - Optional abort signal for cancellation
   * @returns {Promise<any>} Parsed JSON response
   * @throws {Error} On non-OK response or network failure
   */
  async _request(url, options = {}, signal = null) {
    const config = { ...options, signal };

    try {
      const resp = await fetch(url, config);

      if (!resp.ok) {
        let errorMessage = `API error: ${resp.status}`;
        try {
          const body = await resp.json();
          if (body.error || body.message) errorMessage = body.error || body.message;
        } catch {
          // Response body not JSON — use status text
          errorMessage = `API error: ${resp.status} ${resp.statusText}`;
        }
        const err = new Error(errorMessage);
        err.status = resp.status;
        throw err;
      }

      // Handle 204 No Content
      if (resp.status === 204) return null;

      return resp.json();
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new Error('Request cancelled');
      }
      throw err;
    }
  },

  /**
   * GET request.
   *
   * @param {string} path - API path (e.g. '/portfolio')
   * @param {Object} [params] - Query parameters
   * @param {AbortSignal} [signal] - Abort signal
   * @returns {Promise<any>}
   */
  async get(path, params = {}, signal = null) {
    const url = new URL(this.baseUrl + path, window.location.origin);
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    });
    return this._request(url.toString(), { method: 'GET' }, signal);
  },

  /**
   * POST request.
   *
   * @param {string} path - API path
   * @param {Object} data - Request body (JSON-serialized)
   * @param {AbortSignal} [signal] - Abort signal
   * @returns {Promise<any>}
   */
  async post(path, data = {}, signal = null) {
    return this._request(
      this.baseUrl + path,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      },
      signal
    );
  },

  /**
   * PUT request.
   *
   * @param {string} path - API path
   * @param {Object} data - Request body (JSON-serialized)
   * @param {AbortSignal} [signal] - Abort signal
   * @returns {Promise<any>}
   */
  async put(path, data = {}, signal = null) {
    return this._request(
      this.baseUrl + path,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      },
      signal
    );
  },

  /**
   * PATCH request.
   *
   * @param {string} path - API path
   * @param {Object} data - Request body (JSON-serialized)
   * @param {AbortSignal} [signal] - Abort signal
   * @returns {Promise<any>}
   */
  async patch(path, data = {}, signal = null) {
    return this._request(
      this.baseUrl + path,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      },
      signal
    );
  },

  /**
   * DELETE request.
   *
   * @param {string} path - API path
   * @param {AbortSignal} [signal] - Abort signal
   * @returns {Promise<any>}
   */
  async delete(path, signal = null) {
    return this._request(
      this.baseUrl + path,
      { method: 'DELETE' },
      signal
    );
  },

  /**
   * Open a same-origin SSE live-price stream (Live Chart tab).
   * @param {string} ticker - Single ticker (e.g. 'AAPL')
   * @param {function(Object):void} onMsg - Parsed JSON per event
   * @param {function():void} [onError]
   * @returns {EventSource|null}
   */
  streamPrices(ticker, onMsg, onError = null) {
    try {
      const url = new URL(this.baseUrl + '/stream/prices', window.location.origin);
      url.searchParams.set('tickers', String(ticker || '').toUpperCase());
      const es = new EventSource(url.toString());
      es.onmessage = (ev) => {
        try { onMsg(JSON.parse(ev.data)); } catch {}
      };
      if (onError) es.onerror = onError;
      return es;
    } catch {
      return null;
    }
  },
};
