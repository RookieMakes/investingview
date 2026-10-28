/** TradingView portfolio strip; independent of holdings prices and CAD conversion. */
export const MARKET_TICKER_ENDPOINT = '/settings/market-ticker';
export const MAX_INSTRUMENTS = 30;
export const SYMBOL_PATTERN = /^[A-Z0-9_]+:[A-Z0-9_.!^/=-]+$/;
export const defaultTickerSettings = () => ({ enabled: true, charts: true, instruments: [
  { symbol: 'FOREXCOM:SPXUSD', name: 'S&P 500', desktop: true, mobile: true },
  { symbol: 'FOREXCOM:NSXUSD', name: 'Nasdaq 100', desktop: true, mobile: true },
  { symbol: 'FOREXCOM:DJI', name: 'Dow Jones', desktop: true, mobile: true },
  { symbol: 'SAXO:CADUSD', name: 'CAD/USD', desktop: true, mobile: true },
  { symbol: 'AMEX:GLD', name: 'Gold', desktop: true, mobile: false },
  { symbol: 'NASDAQ:SOXX', name: 'Semiconductors', desktop: true, mobile: false },
] });

let chartModule;
function loadChartModule() {
  chartModule ??= import('https://widgets.tradingview-widget.com/w/en/tv-ticker-tape.js')
    .catch(error => { chartModule = null; throw error; });
  return chartModule;
}

export default class MarketTicker {
  constructor(root) {
    this.root = root;
    this.host = root.querySelector('.market-ticker-widget');
    this.status = root.querySelector('.market-ticker-status');
    this.content = document.getElementById('content');
    this.config = defaultTickerSettings();
    this.request = new AbortController();
    this.version = 0;
    this.key = '';
    this.destroyed = false;
    this.media = matchMedia('(max-width: 767px)');
    this.onBreakpoint = () => this.render();
    this.onSettings = event => { this.config = event.detail; this.render(); };
    this.onChartClosed = () => this.restartCompactAfterModal();
    this.themeObserver = new MutationObserver(() => this.render());
  }

  async init() {
    this.media.addEventListener('change', this.onBreakpoint);
    window.addEventListener('market-ticker-settings-changed', this.onSettings);
    window.addEventListener('chart-modal-closed', this.onChartClosed);
    this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    try {
      this.config = await API.get(MARKET_TICKER_ENDPOINT, {}, this.request.signal);
    } catch (error) {
      if (!this.destroyed) console.warn('[MarketTicker] Using default preferences:', error.message);
    }
    if (!this.destroyed) this.render();
  }

  clearPending() {
    clearTimeout(this.loadTimer);
    this.iframeObserver?.disconnect();
    this.iframeObserver = null;
  }

  restartCompactAfterModal() {
    if (this.destroyed || !this.root.isConnected || this.root.hidden) return;
    // iOS can leave an iframe's CSS timeline suspended even with dimensions intact.
    // A fresh compact embed avoids depending on cross-origin animation recovery.
    if (!this.media.matches && !this.host.querySelector('iframe')) return;
    cancelAnimationFrame(this.resumeFrame);
    this.resumeFrame = requestAnimationFrame(() => {
      this.resumeFrame = requestAnimationFrame(() => {
        if (this.destroyed || !this.root.isConnected || this.root.hidden) return;
        this.key = '';
        this.render();
      });
    });
  }

  async render() {
    if (this.destroyed || !this.root.isConnected) return;
    const theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
    const device = this.media.matches ? 'mobile' : 'desktop';
    const items = this.config.instruments.filter(item => item[device]);
    const charts = device === 'desktop' && this.config.charts;
    const key = JSON.stringify([this.config.enabled, items, charts, theme]);
    if (key === this.key) return;
    this.key = key;
    const version = ++this.version;
    this.clearPending();
    this.host.replaceChildren();
    const enabled = this.config.enabled && items.length > 0;
    this.root.hidden = !enabled;
    this.content.style.setProperty('--market-ticker-height', enabled ? '84px' : '0px');
    if (!enabled) return;
    this.host.setAttribute('aria-busy', 'true');
    this.status.textContent = 'Loading market quotes…';
    this.showMessage('Loading market quotes…');
    if (!charts) { this.mountCompact(items, theme, version); return; }
    try {
      await Promise.race([
        loadChartModule(),
        new Promise((_, reject) => { this.loadTimer = setTimeout(() => reject(new Error('Chart component timed out')), 15000); }),
      ]);
      if (this.destroyed || version !== this.version) return;
      this.clearPending();
      const ticker = document.createElement('tv-ticker-tape');
      ticker.setAttribute('symbol-titles', JSON.stringify(Object.fromEntries(items.map(item => [item.symbol, item.name]))));
      ticker.setAttribute('symbols', items.map(item => item.symbol).join(','));
      ticker.setAttribute('direction', 'horizontal');
      ticker.setAttribute('item-size', 'normal');
      ticker.setAttribute('line-chart-type', 'Area');
      ticker.setAttribute('theme', theme);
      ticker.setAttribute('aria-label', 'Market quotes with area charts');
      this.host.replaceChildren(ticker);
      this.host.setAttribute('aria-busy', 'false');
      this.status.textContent = 'Market ticker loaded.';
    } catch (error) {
      if (!this.destroyed && version === this.version) {
        console.warn('[MarketTicker] Chart component unavailable; using compact quotes:', error.message);
        this.mountCompact(items, theme, version);
      }
    }
  }

  showMessage(message, retry = false) {
    const wrapper = document.createElement('div');
    wrapper.className = 'market-ticker-message';
    const text = document.createElement('span'); text.textContent = message; wrapper.append(text);
    if (retry) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'btn-ghost'; button.textContent = 'Retry';
      button.onclick = () => { this.key = ''; this.render(); }; wrapper.append(button);
    }
    this.host.replaceChildren(wrapper);
  }

  mountCompact(items, theme, version) {
    this.clearPending();
    const container = document.createElement('div');
    container.className = 'tradingview-widget-container';
    const target = document.createElement('div'); target.className = 'tradingview-widget-container__widget';
    const script = document.createElement('script');
    script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-ticker-tape.js';
    script.async = true;
    script.textContent = JSON.stringify({
      symbols: items.map(item => ({ proName: item.symbol, title: item.name })),
      showSymbolLogo: true, isTransparent: false, displayMode: 'compact', colorTheme: theme, locale: 'en',
    });
    container.append(target);
    this.host.replaceChildren(container);
    const fail = () => {
      if (this.destroyed || version !== this.version) return;
      this.clearPending();
      this.host.setAttribute('aria-busy', 'false');
      this.status.textContent = 'Market quotes could not load.';
      this.showMessage('Market quotes unavailable.', true);
    };
    script.onerror = fail;
    this.iframeObserver = new MutationObserver(() => {
      const iframe = container.querySelector('iframe');
      if (!iframe) return;
      iframe.title = 'Market ticker';
      iframe.addEventListener('load', () => {
        if (this.destroyed || version !== this.version) return;
        this.clearPending();
        this.host.setAttribute('aria-busy', 'false');
        this.status.textContent = 'Market ticker loaded.';
      }, { once: true });
      this.iframeObserver?.disconnect();
    });
    this.iframeObserver.observe(container, { childList: true, subtree: true });
    this.loadTimer = setTimeout(fail, 20000);
    container.append(script);
  }

  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.resumeFrame);
    this.version++;
    this.request.abort();
    this.clearPending();
    this.media.removeEventListener('change', this.onBreakpoint);
    window.removeEventListener('market-ticker-settings-changed', this.onSettings);
    window.removeEventListener('chart-modal-closed', this.onChartClosed);
    this.themeObserver.disconnect();
    this.host.replaceChildren();
    this.content.style.removeProperty('--market-ticker-height');
  }
}
