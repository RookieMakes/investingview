import TickerMetadata from '../ticker-metadata.js';
import ChartRenderer from './chart-renderer.js';

/** One app-level expanded chart. Screens supply a ticker and optional holding snapshot. */
const ChartModal = {
  _host: null,
  _ready: null,
  _request: 0,
  _trigger: null,
  _binding: null,
  _background: [],
  _overflow: '',
  _newsView: false,
  _newsAbort: null,
  _newsRequest: 0,

  get isOpen() {
    return !!this._host?.querySelector('#chart-modal.open');
  },

  button(ticker, company = '', className = '') {
    const button = document.createElement('button');
    const symbol = TickerMetadata.normalizeTicker(ticker);
    button.type = 'button';
    button.className = `chart-ticker-link ${className}`.trim();
    button.textContent = symbol || '—';
    button.disabled = !symbol;
    button.dataset.chartTicker = symbol;
    button.dataset.chartCompany = TickerMetadata.remember(symbol, company);
    button.setAttribute('aria-label', `View chart for ${symbol}`);
    button.setAttribute('aria-haspopup', 'dialog');
    return button;
  },

  /** Delegated ticker links used by News, Transactions and the retained Trade screen. */
  bind(root = document.getElementById('content')) {
    this.destroy();
    if (!root) return;
    this._binding = new AbortController();
    root.addEventListener('click', event => {
      const button = event.target.closest('[data-chart-ticker]');
      if (!button || !root.contains(button) || button.disabled) return;
      event.preventDefault();
      event.stopPropagation();
      this.open(button.dataset.chartTicker, button.dataset.chartCompany, { trigger: button });
    }, { capture: true, signal: this._binding.signal });
  },

  async _ensureHost() {
    if (!this._ready) {
      this._ready = (async () => {
        const response = await fetch(new URL('../../screens/chart-modal.html', import.meta.url));
        if (!response.ok) throw new Error('Unable to load chart popup');
        const host = document.createElement('div');
        host.id = 'shared-chart-host';
        host.innerHTML = await response.text();
        document.body.appendChild(host);
        this._host = host;
        ChartRenderer._host = host;
        host.querySelector('#chart-view-toggle').addEventListener('click', () => this._toggleNews());
        host.querySelector('#chart-modal').addEventListener('chart-modal-closed', () => this._release());
        document.addEventListener('keydown', event => this._onKeydown(event), { capture: true });
        this._themeObserver = new MutationObserver(() => {
          if (this.isOpen) ChartRenderer._applyThemeToChart();
        });
        this._themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
        window.matchMedia('(max-width: 767px)').addEventListener('change', () => {
          if (this.isOpen) ChartRenderer._onViewportChange();
        });
      })().catch(error => {
        this._ready = null;
        throw error;
      });
    }
    return this._ready;
  },

  /** Market-only by default; holding context never comes from another screen's state. */
  async open(ticker, companyName = '', { trigger = document.activeElement, holding = null } = {}) {
    const symbol = TickerMetadata.normalizeTicker(ticker);
    if (!symbol) return;
    const request = ++this._request;
    trigger?.setAttribute('aria-busy', 'true');
    try {
      await this._ensureHost();
      if (request !== this._request) return;
      if (this.isOpen) ChartRenderer.closeChartModal();
      this._trigger = trigger;
      this._overflow = document.body.style.overflow;
      this._background = [...document.querySelectorAll('#content, .nav')].map(element => [element, element.inert]);
      this._background.forEach(([element]) => { element.inert = true; });
      document.querySelector('.chart-modal-error')?.remove();
      ChartRenderer.openChartModal(symbol, companyName, { holding });
      this._setNewsView(false);
      this._host.querySelector('#chart-modal-close').focus({ preventScroll: true });
    } catch (error) {
      if (request !== this._request) return;
      if (this.isOpen) ChartRenderer.closeChartModal();
      else this._release();
      console.error('[ChartModal]', error);
      const message = document.createElement('div');
      message.className = 'chart-modal-error';
      message.setAttribute('role', 'alert');
      message.textContent = 'Unable to open the chart. Select the ticker to try again.';
      document.getElementById('content')?.prepend(message);
    } finally {
      trigger?.removeAttribute('aria-busy');
    }
  },

  _onKeydown(event) {
    if (!this.isOpen) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (this._newsView) this.close();
      else if (ChartRenderer._vpAnchorMode) ChartRenderer._cancelVpAnchorMode();
      else if (ChartRenderer._trailingEditor) ChartRenderer._cancelTrailingEditor(true);
      else if (this._host.querySelector('#chartSRPicker').style.display !== 'none') ChartRenderer._hideSRPicker();
      else this.close();
    } else if (event.key === 'Tab') {
      const controls = [...this._host.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled), select, iframe, [tabindex="0"]')]
        .filter(element => element.getClientRects().length > 0);
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (!first) return;
      if (!this._host.contains(document.activeElement)
          || (event.shiftKey && document.activeElement === first)
          || (!event.shiftKey && document.activeElement === last)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    }
  },

  _release() {
    this._setNewsView(false);
    this._background.forEach(([element, inert]) => { element.inert = inert; });
    this._background = [];
    document.body.style.overflow = this._overflow;
    const trigger = this._trigger;
    this._trigger = null;
    if (trigger?.isConnected) trigger.focus({ preventScroll: true });
  },

  /** Overlay news without unmounting, resizing, or resetting any chart mode. */
  _setNewsView(show) {
    this._newsAbort?.abort();
    this._newsAbort = null;
    this._newsRequest++;
    this._newsView = show;
    if (!this._host) return;
    const body = this._host.querySelector('#chart-modal > .modal-card > .modal-body');
    // Capture before hiding the mobile toolbar changes the available body height.
    if (show) this._chartBodyScroll = body.scrollTop;
    const modal = this._host.querySelector('#chart-modal');
    modal.classList.toggle('showing-news', show);
    this._host.querySelector('#chart-news-panel').hidden = !show;
    this._host.querySelector('.chart-modal-body').inert = show;
    this._host.querySelector('.chart-toolbar').inert = show;
    this._host.querySelector('#chart-view-label').textContent = show ? 'Get Chart' : 'Get News';
    const toggle = this._host.querySelector('#chart-view-toggle');
    const ticker = ChartRenderer._currentChartTicker || '';
    toggle.setAttribute('aria-pressed', String(show));
    toggle.setAttribute('aria-label', show ? `Return to ${ticker} chart` : `Show news for ${ticker}`);
    toggle.title = show ? 'Return to chart' : 'Show news from the last 8 hours';
    // The mobile body may have been scrolled through S/R before switching views.
    // Start news at the top of the whole available body, not that old offset.
    if (show) {
      body.scrollTop = 0;
    } else if (this._chartBodyScroll != null) {
      body.scrollTop = this._chartBodyScroll;
      this._chartBodyScroll = null;
    }
    if (show) ChartRenderer._hideSRPicker();
  },

  async _toggleNews() {
    if (!this.isOpen) return;
    if (this._newsView) {
      this._setNewsView(false);
      return;
    }
    const ticker = ChartRenderer._currentChartTicker;
    this._setNewsView(true);
    const request = this._newsRequest;
    const panel = this._host.querySelector('#chart-news-panel');
    const status = this._host.querySelector('#chart-news-status');
    const items = this._host.querySelector('#chart-news-items');
    this._host.querySelector('#chart-news-title').textContent = `${ticker} News · Last 8 hours`;
    this._host.querySelector('#chart-news-updated').textContent = '';
    items.replaceChildren();
    status.textContent = 'Loading recent news…';
    panel.setAttribute('aria-busy', 'true');
    panel.scrollTop = 0;
    this._newsAbort = new AbortController();
    try {
      const data = await API.get(`/news/ticker/${encodeURIComponent(ticker)}`, {}, this._newsAbort.signal);
      if (request !== this._newsRequest || !this.isOpen || !this._newsView) return;
      const now = Date.now();
      const recent = (data.items || []).filter(item => {
        const published = Date.parse(item.published);
        return published <= now && published >= now - 8 * 60 * 60 * 1000;
      });
      for (const item of recent) {
        let url;
        try { url = new URL(item.link); } catch { continue; }
        if (!['http:', 'https:'].includes(url.protocol)) continue;
        const article = document.createElement('article');
        article.className = 'chart-news-item';
        const time = document.createElement('time');
        time.className = 'chart-news-time';
        time.dateTime = item.published;
        time.textContent = new Date(item.published).toLocaleString(undefined, {
          month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
        });
        const story = document.createElement('div');
        story.className = 'chart-news-story';
        const link = document.createElement('a');
        link.textContent = item.title;
        link.href = url.href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.setAttribute('aria-label', `${item.title} (opens in a new tab)`);
        const publisher = document.createElement('span');
        publisher.className = 'chart-news-publisher';
        publisher.textContent = item.outlet || '';
        story.append(link, publisher);
        article.append(time, story);
        items.append(article);
      }
      status.textContent = items.childElementCount ? '' : 'No news in the last 8 hours.';
      const updated = new Date(data.fetched_at);
      if (!Number.isNaN(updated.getTime())) {
        this._host.querySelector('#chart-news-updated').textContent = `Updated ${updated.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
      }
    } catch (error) {
      if (request !== this._newsRequest || !this._newsView) return;
      status.textContent = 'Unable to load recent news. Return to the chart and try again.';
    } finally {
      if (request === this._newsRequest) panel.setAttribute('aria-busy', 'false');
    }
  },

  /** Also invalidates opens that are still waiting for the template to load. */
  close() {
    this._request++;
    if (this.isOpen) ChartRenderer.closeChartModal();
  },

  /** Detach screen ticker bindings; the shared host persists across screen navigation. */
  destroy() {
    this.close();
    this._binding?.abort();
    this._binding = null;
  },
};

export default ChartModal;
