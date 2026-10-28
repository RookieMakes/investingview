/** Shared expanded-chart renderer, extracted from the Portfolio reference implementation. */
import TickerMetadata from '../ticker-metadata.js';
import { detectDominantPattern } from './dominant-pattern.mjs';
import { ensureLightCharts, escapeHtml, chartThemeColors } from './chart-utils.js';

function _isAfterTime(t, ref) {
  return typeof t === 'number' && typeof ref === 'number' ? t > ref : String(t) > String(ref);
}

const ChartRenderer = {
  _host: null,
  _earningsDates: {},
  _quarterlyEarnings: {},
  _ensureLightCharts: ensureLightCharts,
  _escapeHtml: escapeHtml,
  /** @type {string|null} Ticker of the currently open chart modal */
  _currentChartTicker: null,

  /** @type {number} Identifies a popup opening, including reopening the same ticker. */
  _chartOpenVersion: 0,

  /** Standalone popups use ticker data without any portfolio overlays. */
  _chartStandalone: false,

  /** Snapshot supplied by Holdings; never overwrites the Portfolio screen's selection. */
  _chartHolding: null,

  _chartRenderVersion: 0,

  _patternEnabled: true,

  _patternLoaded: false,

  _patternCandidate: null,

  _patternSeries: [],

  /** Portfolio context is explicit: this renderer also serves market-only screens. */
  _chartPortfolioId: null,

  _trailingStop: null,

  _trailingLine: null,

  _trailingLoaded: false,

  _trailingEditor: null,

  _trailingRequest: 0,

  _trailingLoadVersion: 0,

  /** @type {Object|null} Series markers plugin for earnings markers */
  _markersPlugin: null,

  /** @type {Object|null} Hover highlight primitive (soft band + close dot, synced with the tracking tooltip) */
  _hoverPrimitive: null,

  /** @type {Array|null} Cached candle data for theme-reactive re-renders */
  _candleDataCache: null,

  /** @type {string|number|null} Time of the last real bar (placeholders sort after it; tooltip suppressed past it) */
  _lastRealTime: null,

  _applyThemeToChart() {
    if (this._tvWidgetMode) {
      this._renderTvWidget(this._currentChartTicker);
      return;
    }
    if (this._positionPnlMode) {
      this._renderPositionPnlChart(this._currentChartTicker);
      return;
    }
    const isDark = document.documentElement.dataset.theme === 'dark';
    const { bgColor, textColor, gridColor } = chartThemeColors();

    if (this._modalLive?.chart) {
      this._modalLive.chart.applyOptions({
        layout: { background: { color: bgColor }, textColor },
        grid: { vertLines: { color: gridColor }, horzLines: { color: gridColor } },
      });
    }

    if (this._chartInstance) {
      try {
        this._chartInstance.applyOptions({
          layout: { background: { color: bgColor }, textColor },
          grid: { vertLines: { color: gridColor, style: LightweightCharts.LineStyle.Dotted }, horzLines: { color: gridColor, style: LightweightCharts.LineStyle.Dotted } },
          rightPriceScale: { borderColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)' },
          timeScale: { borderColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)' },
        });
      } catch {}
    }
    if (this._candleSeries) {
      try {
        this._candleSeries.applyOptions({
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
    if (this._hoverPrimitive && typeof hoverHighlightColors === 'function') {
      try { this._hoverPrimitive.setColors(hoverHighlightColors(isDark)); } catch {}
    }
    if (this._smaSeries) {
      try {
        this._smaSeries.applyOptions({ color: isDark ? '#FF9800' : '#E65100' });
      } catch {}
    }
    if (this._volumeSeries && this._candleDataCache) {
      try {
        const volData = this._candleDataCache.map(c => ({
          time: c.time,
          value: c.volume ?? 0,
          color: isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)',
        }));
        this._volumeSeries.setData(volData);
      } catch {}
    }
    if (this._avgPriceLine && this._candleSeries) {
      try {
        this._candleSeries.removePriceLine(this._avgPriceLine);
        this._avgPriceLine = null;
        if (this._currentChartTicker) {
          this._drawAvgPriceLine(this._currentChartTicker, this._candleSeries);
        }
      } catch {}
    }
    if (this._srLines.length > 0) {
      try { this._renderSRLines(); } catch {}
    }
    for (const series of this._patternSeries) {
      try { series.applyOptions({ color: isDark ? '#83B8EF' : '#2764A2' }); } catch {}
    }
    this._renderTrailingStop();
    // Re-attach % Move primitive with updated theme colors
    if (this._pctMoveEnabled && this._candleSeries && this._candleDataCache) {
      try {
        this._detachPctMove();
        this._attachPctMove();
      } catch {}
    }
    // Re-attach volume profile with updated theme colors
    if (this._vpEnabled && this._candleSeries && this._candleDataCache) {
      try {
        this._detachVP();
        this._attachVP();
      } catch {}
    }
    if (this._currentChartTicker && this._candleSeries && this._candleDataCache) {
      try {
        this._applyAllMarkers(this._currentChartTicker, this._candleSeries, this._candleDataCache);
      } catch {}
    }

  },

  /**
   * Fetch transactions for this chart's explicit portfolio snapshot.
   * Errors are silently ignored — chart works without markers.
   */
  async _fetchTransactions() {
    const holding = this._chartHolding;
    if (!holding || Array.isArray(holding.transactions)) return;
    const openVersion = this._chartOpenVersion;
    try {
      const data = await API.get('/portfolio/' + holding.portfolioId + '/transactions', { per_page: 200 });
      if (openVersion !== this._chartOpenVersion || this._chartHolding !== holding) return;
      holding.transactions = (data.transactions || []).filter(txn => txn.ticker === holding.position.ticker)
        .map(({ type, date, price, qty }) => ({ type, date, price, qty }))
        .sort((a, b) => a.date.localeCompare(b.date));
      if (this._candleSeries && this._candleDataCache) {
        this._applyAllMarkers(holding.position.ticker, this._candleSeries, this._candleDataCache);
      }
    } catch (error) {
      if (openVersion === this._chartOpenVersion) console.info('[Chart] Failed to fetch transactions:', error.message);
    }
  },

  /** Bind the persistent modal controls once for the application lifetime. */
  _bindControls() {
    if (this._controlsBound) return;
    this._controlsBound = true;
    const bind = (id, callback) => this._element(id).addEventListener('click', callback);
    bind('chart-pattern-toggle', () => {
      if (!this._dailyPatternContext()) return;
      this._patternEnabled = !this._patternEnabled;
      this._renderPatternOverlay();
    });
    bind('chart-draw-support', () => this._toggleDrawMode('support'));
    bind('chart-clear-lines', () => this._clearAllSRLines());
    bind('pnl-chart-toggle', () => this._togglePositionPnlChart());
    bind('tv-widget-toggle', () => this._toggleTvWidget());
    bind('live-15m-toggle', () => this._toggleLive15m());
    bind('vp-toggle', () => this._toggleVP());
    for (const [id, type] of [['chartSRPickerSupport', 'support'], ['chartSRPickerResistance', 'resistance']]) {
      bind(id, () => {
        const picker = this._element('chartSRPicker');
        const price = Number(picker.dataset.price);
        if (price > 0 && picker.dataset.ticker) this._addSRLine(picker.dataset.ticker, price, type);
        this._hideSRPicker();
      });
    }
    bind('chartSRPickerCancel', () => this._hideSRPicker());
    this._element('vp-control-row').addEventListener('click', event => {
      const range = event.target.closest('[data-vp-range]');
      if (range) this._setVpRange(range.dataset.vpRange);
      else if (event.target.closest('#vp-anchor-btn')) this._toggleVpAnchorMode();
    });
    this._bindTrailingStopButtons();
    this._setupChartModalCloseHandlers();
  },

  /** Every renderer lookup stays inside its own host, including the S/R picker. */
  _element(id) {
    return this._host?.querySelector('[id="' + id + '"]') || null;
  },

  /** Synchronize the controls already present in the canonical template. */
  _syncVpLayout() {
    this._setVpControlsVisible(!this._modalLive && !this._tvWidgetMode && !this._positionPnlMode);
    this._syncVpButtons();
    this._syncVpControls();
  },

  /** Shared teardown for daily, widget and P/L transitions and modal close. */
  _disposeChart() {
    this._chartResizeHandler?.();
    this._chartResizeHandler = null;
    this._chartTooltip?.destroy();
    this._chartTooltip = null;
    this._removeAvgEdgeIndicator();
    if (this._markersPlugin) {
      try { this._markersPlugin.detach(); } catch {}
      this._markersPlugin = null;
    }
    const canvas = this._element('chart-canvas');
    if (canvas && this._pnlMouseLeaveHandler) canvas.removeEventListener('mouseleave', this._pnlMouseLeaveHandler);
    this._pnlMouseLeaveHandler = null;
    if (this._chartInstance) {
      try { this._chartInstance.remove(); } catch {}
    }
    this._chartInstance = null;
    this._candleSeries = null;
    this._smaSeries = null;
    this._volumeSeries = null;
    this._hoverPrimitive = null;
    this._vpPrimitive = null;
    this._vpPriceLines = [];
  },

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

  // ─── CHART MODAL ──────────────────────────────────────
  _dailyPatternContext() {
    return !!this._element('chart-pattern-toggle')
      && !!this._element('chart-modal')?.classList.contains('open');
  },

  _setPatternControlsVisible(visible) {
    const row = this._element('chart-pattern-row');
    if (row) row.hidden = !visible || !this._patternLoaded;
  },

  _clearPatternOverlay() {
    for (const series of this._patternSeries) {
      try { this._chartInstance?.removeSeries(series); } catch {}
    }
    this._patternSeries = [];
    this._setPatternControlsVisible(false);
  },

  _renderPatternOverlay() {
    this._clearPatternOverlay();
    const button = this._element('chart-pattern-toggle');
    if (button) {
      button.setAttribute('aria-pressed', String(this._patternEnabled));
      const action = button.querySelector('.chart-pattern-action');
      if (action) action.textContent = this._patternEnabled ? 'Hide' : 'Show';
      button.setAttribute('title', this._patternEnabled ? 'Hide pattern' : 'Show pattern');
      button.setAttribute('aria-label', this._patternEnabled ? 'Hide pattern overlay' : 'Show pattern overlay');
    }
    if (!this._patternLoaded || !this._dailyPatternContext() ||
        !this._chartInstance || !this._candleSeries) return;
    this._setPatternControlsVisible(true);
    const label = this._element('chart-pattern-label');
    const found = this._patternCandidate;
    if (label) label.textContent = !this._patternEnabled ? 'Pattern hidden'
      : found ? `${found.name} · ${found.status}` : 'No clear pattern';
    if (!found || !this._patternEnabled) return;
    const isDark = document.documentElement.dataset.theme === 'dark';
    try {
      for (const points of [found.upper, found.lower]) {
        if (!points?.length) continue;
        const series = this._chartInstance.addSeries(LightweightCharts.LineSeries, {
          color: isDark ? '#83B8EF' : '#2764A2', lineWidth: 2,
          lineStyle: LightweightCharts.LineStyle.Dashed,
          priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
        });
        this._patternSeries.push(series);
        series.setData(points);
      }
    } catch (error) {
      console.warn('[Chart] Pattern overlay unavailable:', error);
      this._clearPatternOverlay();
    }
  },

  /**
   * Open chart modal for a ticker.
   * Renders a LightweightCharts candlestick chart inside the modal.
   * @param {string} ticker
   * @param {string} companyName - Optional name supplied by the calling screen.
   * @param {{holding?: Object}} options - Explicit holding context; absent for market-only charts.
   */
  openChartModal(ticker, companyName = '', { holding = null } = {}) {
    const modal = this._element('chart-modal');
    if (!modal) {
      console.warn('[Chart] openChartModal: #chart-modal element not found in DOM');
      return;
    }

    ticker = TickerMetadata.normalizeTicker(ticker);
    if (!ticker) return;
    const openVersion = ++this._chartOpenVersion;
    this._clearPatternOverlay();
    this._patternEnabled = true;
    // Volume profile is opt-in (default off) and desktop-only. The preset and
    // opt-in persist, while a manual anchor is scoped to one modal session.
    this._vpEnabled = false;
    this._vpAnchorTime = null;
    this._vpAnchorMode = false;
    this._vpSensitive = false;
    try {
      this._vpEnabled = localStorage.getItem('chart-vp-enabled') === '1' && this._isVpDesktop();
    } catch { this._vpEnabled = false; }
    try {
      const savedVpRange = localStorage.getItem('chart-vp-range');
      this._vpRange = ['1w', '1m', '3m', '6m', '1y'].includes(savedVpRange) ? savedVpRange : '3m';
    } catch { this._vpRange = '3m'; }
    this._patternLoaded = false;
    this._patternCandidate = null;
    this._resetTrailingStop();
    this._chartHolding = holding?.portfolioId != null && holding.position?.ticker === ticker
      && holding.position.qty > 0 ? {
        ...holding, position: { ...holding.position },
        transactions: Array.isArray(holding.transactions) ? holding.transactions.map(txn => ({ ...txn })) : null,
      } : null;
    this._chartPortfolioId = this._chartHolding?.portfolioId ?? null;
    this._chartStandalone = !this._chartHolding;
    this._element('pnl-chart-toggle').hidden = !this._chartHolding;
    this._element('chart-trailing-stop').hidden = !this._chartHolding;

    // Set synchronously: _renderChartModal is async and only assigns this
    // after awaits, so early Live taps would otherwise see a stale/null ticker.
    this._currentChartTicker = ticker;

    const name = TickerMetadata.remember(ticker, companyName);
    this._setChartCompanyName(ticker, name);

    // Reset daily price pill to loading state; _fetchChartData populates it.
    // Stale-ticker guard lives in _updateModalPrice (checks _currentChartTicker).
    this._resetModalPrice();
    this._setModalPriceVisible(true);

    // Hide static avg badge — the chart line with axis label is the proper indicator
    const avgBadge = this._element('chart-avg-badge');
    if (avgBadge) avgBadge.style.display = 'none';

    // Show modal
    modal.classList.add('open');
    document.body.style.overflow = 'hidden';

    // Preserve embed dimensions so TradingView cannot calculate a zero-duration tape.
    const tickerStrip = document.querySelector('.ticker-strip');
    if (tickerStrip) tickerStrip.style.visibility = 'hidden';

    // All toolbar controls live in the canonical template.
    this._syncVpLayout();

    // Render chart
    this._renderChartModal(ticker);

    if (!name) {
      TickerMetadata.resolve(ticker).then(resolvedName => {
        if (openVersion !== this._chartOpenVersion || this._currentChartTicker !== ticker
            || this._element('chart-modal') !== modal
            || !modal.classList.contains('open')) return;
        this._setChartCompanyName(ticker, resolvedName);
      });
    }

    this._bindControls();
  },

  /** Keep the title and any already-created tooltip in sync with late metadata. */
  _setChartCompanyName(ticker, name) {
    this._currentChartCompanyName = name;
    const titleEl = this._element('chart-modal-title');
    if (titleEl) {
      titleEl.textContent = name ? `${ticker} — ${name}` : ticker;
      titleEl.title = titleEl.textContent;
    }
  },

  /**
   * Close chart modal.
   */
  closeChartModal() {
    this._resetTrailingStop();
    this._chartHolding = null;
    this._chartOpenVersion++;
    this._chartRenderVersion++;
    this._clearPatternOverlay();
    this._patternCandidate = null;
    this._patternLoaded = false;
    this._setPatternControlsVisible(false);
    const modal = this._element('chart-modal');
    if (!modal) return;

    modal.classList.remove('open');
    document.body.style.overflow = '';

    // Show ticker strip
    const tickerStrip = document.querySelector('.ticker-strip');
    if (tickerStrip) tickerStrip.style.visibility = '';

    // Clean up S/R state
    this._hideSRPicker();
    this._drawMode = null;
    this._drawTicker = null;
    this._currentChartTicker = null;
    this._srLines = [];
    this._updateDrawModeUI(false);

    // Show S/R legend (hidden in P/L mode)
    const srLegend = this._host.querySelector('.chart-legend-panel');
    if (srLegend) srLegend.style.display = '';
    const modalBody = this._host.querySelector('.chart-modal-body');
    if (modalBody) modalBody.classList.remove('legend-hidden');

    // Clean up % Move primitive
    this._detachPctMove();
    this._pctMoveEnabled = false;
    const pctBtn = this._element('pct-move-toggle');
    if (pctBtn) pctBtn.classList.remove('active');

    // Clean up volume profile (opt-in pref persists for the next open)
    this._detachVP();
    this._vpAnchorMode = false;
    this._vpAnchorTime = null;
    this._vpSensitive = false;
    this._realCandleCount = 0;
    this._setVpControlsVisible(false);
    this._host.querySelectorAll('.chart-tool-btn.vp').forEach((btn) => {
      btn.classList.remove('active');
      btn.setAttribute('aria-pressed', 'false');
    });

    // Clean up Live 15m mode (legacy flag + modal live stream)
    this._live15mMode = false;
    const liveBtn = this._element('live-15m-toggle');
    if (liveBtn) liveBtn.classList.remove('active');
    try {
      if (this._modalLive) this._exitModalLive(false, 'modal_close');
    } catch {}

    // Clean up P/L chart mode
    this._positionPnlMode = false;
    const pnlBtn = this._element('pnl-chart-toggle');
    if (pnlBtn) pnlBtn.classList.remove('active');

    // Clean up TradingView widget mode
    this._destroyTvWidget();
    this._tvWidgetMode = false;

    // Clean up P/L mouse leave handler
    const pnlCanvas = this._element('chart-canvas');
    if (pnlCanvas && this._pnlMouseLeaveHandler) {
      pnlCanvas.removeEventListener('mouseleave', this._pnlMouseLeaveHandler);
      this._pnlMouseLeaveHandler = null;
    }

    // Clean up tracking tooltip
    if (this._chartTooltip) {
      this._chartTooltip.destroy();
      this._chartTooltip = null;
    }
    this._lastRealTime = null;
    this._currentChartCompanyName = null;
    this._candleDataCache = null;

    // Clean up avg price edge indicator
    this._removeAvgEdgeIndicator();
    this._avgPriceLine = null;
    this._avgPrice = null;

    this._disposeChart();
    this._chartStandalone = false;
    // Bubble after the modal's own release handler restores background focus/inertness.
    modal.dispatchEvent(new CustomEvent('chart-modal-closed', { bubbles: true }));
  },

  /**
   * Setup chart modal close handlers (close button, backdrop click, Escape key).
   * Uses flag properties to prevent duplicate handler registration.
   */
  _setupChartModalCloseHandlers() {
    const modal = this._element('chart-modal');
    const closeBtn = this._element('chart-modal-close');

    if (closeBtn && !closeBtn._hasHandler) {
      closeBtn.addEventListener('click', () => this.closeChartModal());
      closeBtn._hasHandler = true;
    }

    if (modal && !modal._hasClickHandler) {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) this.closeChartModal();
      });
      modal._hasClickHandler = true;
    }
  },

  /**
   * Reset the expanded-modal price pill to its loading state.
   */
  _resetModalPrice() {
    const priceEl = this._host.querySelector('#chart-modal-price [data-role="modal-price"]');
    const chgEl = this._host.querySelector('#chart-modal-price [data-role="modal-change"]');
    if (priceEl) {
      priceEl.textContent = '--';
      priceEl.className = 'price-val';
    }
    if (chgEl) {
      chgEl.textContent = '--';
      chgEl.className = 'price-chg';
    }
  },

  /**
   * Show/hide the daily price pill. Hidden when Live / TradingView / P&L
   * modes take over the canvas (they render their own values).
   * @param {boolean} visible
   */
  _setModalPriceVisible(visible) {
    const pill = this._element('chart-modal-price');
    if (pill) pill.style.display = visible ? '' : 'none';
  },

  /**
   * Populate the expanded-modal pill from the last two REAL daily
   * candles. Yahoo-style: dollar change + percent change only
   * (no absolute price), e.g. "+$20.00 (+20.00%)".
   * Mirrors Charts._updateCardPrice formatting.
   * @param {string} ticker - expected ticker (stale-response guard)
   * @param {number|null} changeAbs - dollar change vs previous real close
   * @param {number|null} changePct - pct vs previous real close
   */
  _updateModalPrice(ticker, changeAbs, changePct) {
    if (ticker && this._currentChartTicker && ticker !== this._currentChartTicker) return;
    const priceEl = this._host.querySelector('#chart-modal-price [data-role="modal-price"]');
    const chgEl = this._host.querySelector('#chart-modal-price [data-role="modal-change"]');
    const hasAbs = changeAbs !== null && changeAbs !== undefined && !isNaN(Number(changeAbs));
    const hasPct = changePct !== null && changePct !== undefined && !isNaN(Number(changePct));
    const basis = hasPct ? Number(changePct) : (hasAbs ? Number(changeAbs) : 0);
    const dir = (hasAbs || hasPct) ? (basis > 0 ? 'up' : basis < 0 ? 'dn' : null) : null;
    if (priceEl && hasAbs) {
      const a = Number(changeAbs);
      priceEl.textContent = `${a > 0 ? '+' : a < 0 ? '-' : ''}$${Math.abs(a).toFixed(2)}`;
      // Tint dollar change green/red with direction.
      priceEl.className = dir ? `price-val ${dir}` : 'price-val';
    }
    if (chgEl && hasPct) {
      const v = Number(changePct);
      chgEl.textContent = `(${v > 0 ? '+' : v < 0 ? '-' : ''}${Math.abs(v).toFixed(2)}%)`;
      chgEl.className = dir ? `price-chg ${dir}` : 'price-chg';
    }
  },

  /**
   * Render chart in modal using LightweightCharts.
   * Dynamically loads the library if not already present.
   * @param {string} ticker
   */
  async _renderChartModal(ticker) {
    this._cancelTrailingEditor();
    this._trailingLine = null;
    const openVersion = this._chartOpenVersion;
    const renderVersion = ++this._chartRenderVersion;
    const canvas = this._element('chart-canvas');
    if (!canvas) return;

    this._disposeChart();

    this._clearPatternOverlay();
    this._patternCandidate = null;
    this._patternLoaded = false;
    this._setPatternControlsVisible(this._dailyPatternContext());
    this._setVpControlsVisible(true);

    canvas.innerHTML = '';

    // Reset P/L mode
    this._positionPnlMode = false;
    const pnlBtn = this._element('pnl-chart-toggle');
    if (pnlBtn) pnlBtn.classList.remove('active');

    // Reset TradingView widget mode
    this._tvWidgetMode = false;
    const tvBtn = this._element('tv-widget-toggle');
    if (tvBtn) tvBtn.classList.remove('active');
    const tvContainer = this._element('tv-widget-container');
    if (tvContainer) tvContainer.remove();

    // Show S/R legend (hidden in P/L mode)
    const srLegend = this._host.querySelector('.chart-legend-panel');
    if (srLegend) srLegend.style.display = '';
    const modalBody = this._host.querySelector('.chart-modal-body');
    if (modalBody) modalBody.classList.remove('legend-hidden');

    // Daily view owns the header pill (Live/TV/P&L hide it while active).
    this._setModalPriceVisible(true);

    // Track the current chart ticker for S/R drawing
    this._currentChartTicker = ticker;
    this._lastRealTime = null;
    this._candleDataCache = null;
    this._realCandleCount = 0;
    // Previous chart's primitive was destroyed with it — drop stale refs
    // (the flag stays as set by openChartModal; _fetchChartData re-attaches).
    this._vpPrimitive = null;
    this._vpPriceLines = [];
    this._syncVpControls();
    this._drawMode = null;
    this._drawTicker = null;
    this._srLines = [];
    this._priceLines = [];
    this._avgPriceLine = null;
    this._avgPrice = null;
    this._avgEdgeIndicator = null;
    this._avgTimeScaleSubscription = null;

    // Reset draw mode UI
    this._updateDrawModeUI(false);

    // Ensure LightweightCharts is loaded
    await this._ensureLightCharts();

    if (openVersion !== this._chartOpenVersion || this._currentChartTicker !== ticker
        || renderVersion !== this._chartRenderVersion
        || this._element('chart-canvas') !== canvas) return;

    if (typeof LightweightCharts === 'undefined') {
      canvas.innerHTML = '<p style="color:var(--color-text-tertiary);font-size:13px;text-align:center;padding:40px;">Chart library not available.</p>';
      return;
    }

    const isDark = document.documentElement.dataset.theme === 'dark';
    const { bgColor, textColor, gridColor } = chartThemeColors();

    const chartHeight = canvas.clientHeight || 460;

    const chart = LightweightCharts.createChart(canvas, {
      width: canvas.clientWidth || 800,
      height: chartHeight,
      layout: {
        background: { type: 'solid', color: bgColor },
        textColor,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: gridColor, style: LightweightCharts.LineStyle.Dotted },
        horzLines: { color: gridColor, style: LightweightCharts.LineStyle.Dotted },
      },
      crosshair: {
        mode: LightweightCharts.CrosshairMode.Normal,
      },
      timeScale: {
        borderColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)',
        timeVisible: false, // daily string scale: date-only axis labels (no 00:00:00)
        rightOffset: 5,
      },
      rightPriceScale: {
        borderColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)',
      },
      handleScroll: { vertTouchDrag: true },
    });

    this._chartInstance = chart;

    this._chartResizeHandler = this._observeChartSize(chart, canvas);

    // Add candlestick series
    const candleSeries = chart.addSeries(LightweightCharts.CandlestickSeries, {
      upColor: '#26a69a',
      downColor: '#ef5350',
      borderUpColor: '#26a69a',
      borderDownColor: '#ef5350',
      wickUpColor: '#26a69a',
      wickDownColor: '#ef5350',
    });

    candleSeries.priceScale().applyOptions({
      scaleMargins: { top: 0.1, bottom: 0.15 },
    });

    this._candleSeries = candleSeries;

    // Hover highlight: soft band + close dot tracking the crosshair in sync
    // with the floating tooltip (driven from subscribeCrosshairMove below).
    // A primitive is used (not markers) so earnings/transaction markers are
    // untouched — createSeriesMarkers() would replace them all.
    this._hoverPrimitive = null;
    if (typeof HoverHighlightPrimitive !== 'undefined') {
      try {
        this._hoverPrimitive = new HoverHighlightPrimitive({ colors: hoverHighlightColors(isDark) });
        candleSeries.attachPrimitive(this._hoverPrimitive);
      } catch (err) { this._hoverPrimitive = null; }
    }

    // Add 200-period SMA overlay
    const smaSeries = chart.addSeries(LightweightCharts.LineSeries, {
      color: isDark ? '#FF9800' : '#E65100',
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });

    this._smaSeries = smaSeries;

    // Add volume histogram overlay (same pane, bottom 15%)
    const volumeSeries = chart.addSeries(LightweightCharts.HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: '',
    });
    volumeSeries.priceScale().applyOptions({
      scaleMargins: { top: 0.85, bottom: 0 },
    });
    this._volumeSeries = volumeSeries;

    // Subscribe to chart clicks for mutually exclusive VP-anchor / S/R modes.
    chart.subscribeClick((param) => {
      if (this._vpAnchorMode) {
        if (param && param.time) this._setVpAnchor(param.time);
        return;
      }
      if (!this._drawMode) return;
      if (!param || !param.point) return;

      const price = candleSeries.coordinateToPrice(param.point.y);
      if (price !== null && price !== undefined && price > 0) {
        if (this._drawMode === 'trailing') {
          this._setTrailingPrice(price);
          return;
        }
        const rect = canvas.getBoundingClientRect();
        this._showSRPicker(price, ticker, rect.left + param.point.x, rect.top + param.point.y);
      }
    });

    // Tracking tooltip for candlestick crosshair
    this._chartTooltip = this._createTrackingTooltip(canvas);
    chart.subscribeCrosshairMove((param) => {
      const side = this._chartTooltip.update(param, candleSeries, volumeSeries, this._lastRealTime);
      // Mirror the tooltip's candle into the hover highlight (band + dot).
      // Clears whenever the tooltip would hide (out of bounds / no data).
      if (this._hoverPrimitive) {
        let hTime = null;
        let hPrice = null;
        let hDir = null;
        let hSide = null;
        if (side && param && param.time && param.point && param.seriesData &&
            param.point.x >= 0 && param.point.y >= 0 &&
            param.point.x <= canvas.clientWidth && param.point.y <= canvas.clientHeight) {
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
        this._hoverPrimitive.setHover(hTime, hPrice, hDir, hSide);
      }
    });
    canvas.addEventListener('mouseleave', () => { if (this._chartTooltip) this._chartTooltip.hide(); if (this._hoverPrimitive) this._hoverPrimitive.setHover(null); });

    // Fetch and render chart data
    this._fetchChartData(ticker, candleSeries);

    // Fetch transactions for marker display (non-blocking)
    this._fetchTransactions();

    // Draw avg price line on the chart
    this._drawAvgPriceLine(ticker, candleSeries);

    // Set up edge indicator for avg price (shows badge when avg is out of view)
    if (this._avgPrice != null && !isNaN(this._avgPrice)) {
      this._createAvgEdgeIndicator(chart, candleSeries, ticker, this._avgPrice);
      this._renderAvgLegend(ticker, this._avgPrice);
    }

    // Load existing S/R lines
    this._loadSRLines(ticker);
    this._loadTrailingStop();
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
   * Fetch chart data for a ticker from the API.
   * Shows error state on failure instead of falling back to demo data.
   * @param {string} ticker
   * @param {object} candleSeries
   */
  async _fetchChartData(ticker, candleSeries) {
    const openVersion = this._chartOpenVersion;
    const isCurrent = () => openVersion === this._chartOpenVersion
      && this._currentChartTicker === ticker && this._candleSeries === candleSeries;
    // Loading overlay: covers the empty grid so the pre-data crosshair has
    // no visible window. Same .card-status + .spinner pattern as the live
    // surfaces (mliveLoading) and grid cards. Removed on first setData;
    // error/empty/stale paths remove it too. Local ref only, so a stale
    // render removing its own (possibly detached) node can't touch a newer
    // render's overlay. Positioned inline: this screen has no generic
    // .card-status rule (only #modal-live-host-scoped ones).
    const hostCanvas = this._element('chart-canvas');
    let loadingEl = null;
    const removeLoading = () => { if (loadingEl) { try { loadingEl.remove(); } catch {} loadingEl = null; } };
    if (hostCanvas) {
      loadingEl = document.createElement('div');
      loadingEl.className = 'card-status';
      loadingEl.setAttribute('role', 'status');
      loadingEl.setAttribute('aria-label', 'Loading chart for ' + ticker);
      loadingEl.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;background:var(--color-bg);z-index:5;';
      const spin = document.createElement('div');
      spin.className = 'spinner';
      spin.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.style.cssText = 'font-size:13px;color:var(--color-text-secondary);';
      label.textContent = 'Loading ' + ticker + '…';
      loadingEl.appendChild(spin);
      loadingEl.appendChild(label);
      hostCanvas.appendChild(loadingEl);
    }
    try {
      // Fire all three fetches concurrently (was: 3 sequential awaits).
      // Candles + SMA + volume render as soon as history resolves; the
      // combined earnings/tx markers re-apply when earnings payloads land.
      const needDates = !this._earningsDates[ticker];
      const needQuarterly = !this._quarterlyEarnings[ticker];
      const datesP = needDates
        ? API.get('/earnings/dates', { tickers: ticker }).then((dates) => {
            if (dates && dates[ticker]) this._earningsDates[ticker] = dates[ticker];
          }).catch(() => {})
        : Promise.resolve();
      const quarterlyP = needQuarterly
        ? API.get('/earnings/history', { tickers: ticker }).then((history) => {
            if (history && history[ticker]) this._quarterlyEarnings[ticker] = history[ticker];
          }).catch(() => {})
        : Promise.resolve();
      const historyP = API.get('/data/history', { ticker, period: '1y' });

      const data = await historyP;
      if (!isCurrent()) { removeLoading(); return; }
      // The shared cache can contain legacy timestamped rows alongside daily
      // bars; only date-only trading sessions belong on this daily chart.
      const candles = (data.history || [])
        .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d.date))
        .map(d => ({
          time: d.date,
          open: d.open,
          high: d.high,
          low: d.low,
          close: d.close,
          volume: d.volume,
        }));
      this._candleDataCache = candles;
      this._realCandleCount = candles.length;

      if (candles.length > 0) {
        // Analyze API candles before earnings adds synthetic future dojis.
        this._patternCandidate = this._dailyPatternContext()
          ? detectDominantPattern(candles) : null;
        // Set 200-period SMA overlay (calculate on real candles before earnings markers)
        const sma200 = this._calculateSMA(candles, 200);
        if (sma200.length > 0 && this._smaSeries) {
          this._smaSeries.setData(sma200);
        }

        // Track how many placeholder candles _addEarningsMarker adds
        const lenBefore = candles.length;
        this._addEarningsMarker(ticker, candleSeries, candles);
        const placeholderCount = candles.length - lenBefore;

        // Apply combined markers (earnings + transactions) — must happen
        // after _addEarningsMarker so future earnings placeholder candles exist
        this._applyAllMarkers(ticker, candleSeries, candles);

        candleSeries.setData(candles);
        this._patternLoaded = true;
        this._renderPatternOverlay();

        // Set volume histogram data
        if (this._volumeSeries) {
          const isDarkPf = document.documentElement.dataset.theme === 'dark';
          const volumeColor = isDarkPf ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)';
          const volumeData = candles
            .filter(c => c.volume != null)
            .map(c => ({
              time: c.time,
              value: c.volume,
              color: volumeColor,
            }));
          this._volumeSeries.setData(volumeData);
        }

        // Track the final API candle before synthetic earnings placeholders.
        const lastRealIdx = candles.length - 1 - placeholderCount;
        this._lastRealTime = (lastRealIdx >= 0 && candles[lastRealIdx]) ? candles[lastRealIdx].time : null;

        // Update header pill from last REAL candle (skip earnings placeholders).
        // Yahoo-style: dollar change + percent change only (no absolute price).
        if (lastRealIdx >= 0 && candles[lastRealIdx]) {
          const lastClose = candles[lastRealIdx].close;
          let changeAbs = null;
          let changePct = null;
          if (lastRealIdx >= 1 && candles[lastRealIdx - 1]) {
            const prevClose = candles[lastRealIdx - 1].close;
            if (prevClose) {
              changeAbs = lastClose - prevClose;
              changePct = (changeAbs / prevClose) * 100;
            }
          }
          this._updateModalPrice(ticker, changeAbs, changePct);
        }

        // Re-attach % Move primitive if it was enabled before data loaded
        if (this._pctMoveEnabled) {
          this._attachPctMove();
        }

        // Volume profile is opt-in: attach when enabled, otherwise just fit
        // the visible range to the selected preset (quick chart-range control).
        if (this._vpEnabled) {
          this._attachVP(true);
        } else {
          this._fitVpRangeOnly();
        }

        removeLoading();
        // Late markers: earnings payloads may land after first paint.
        // Same _applyAllMarkers call as above, re-invocable with cached candles.
        Promise.all([datesP, quarterlyP]).then(() => {
          if (!isCurrent()) return;
          if (!this._candleDataCache || this._candleDataCache.length === 0) return;
          try { this._applyAllMarkers(ticker, candleSeries, this._candleDataCache); } catch {}
        });
      } else {
        // No data available — show empty state in chart
        removeLoading();
        const canvas = this._element('chart-canvas');
        if (canvas) {
          const msg = document.createElement('div');
          msg.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;color:var(--color-text-tertiary);font-size:13px;';
          msg.textContent = 'No chart data available for ' + ticker;
          canvas.appendChild(msg);
        }
      }
    } catch (err) {
      if (!isCurrent()) { removeLoading(); return; }
      console.error('[Chart] Chart data fetch error:', err.message);
      // Show error state in chart container
      removeLoading();
      const canvas = this._element('chart-canvas');
      if (canvas) {
        canvas.innerHTML = '<div class="error-message"><p class="error-text">Unable to load chart data</p><p class="error-description"></p><button type="button" class="retry-btn">Retry</button></div>';
        canvas.querySelector('.error-description').textContent = err.message;
        canvas.querySelector('.retry-btn').addEventListener('click', () => this._renderChartModal(ticker), { once: true });
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
   * Add earnings marker to the chart if earnings is in visible range.
   * @param {string} ticker
   * @param {object} candleSeries
   * @param {Array} candles - Candle data
   */
  _addEarningsMarker(ticker, candleSeries, candles) {
    const earningsInfo = this._earningsDates[ticker];
    const earningsDate = earningsInfo?.next?.date;
    if (!earningsDate) return;

    // Check if in visible range
    if (!this._isInVisibleRange(earningsDate, candles)) return;

    const lastCandleDate = candles[candles.length - 1]?.time;

    // Past earnings (before last candle) — skip
    if (earningsDate < lastCandleDate) return;

    // Theme-aware marker color: volume bar color
    const isDark = document.documentElement.dataset.theme === 'dark';
    const markerColor = isDark ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.9)';

    // Today's earnings — place marker on existing candle
    if (earningsDate === lastCandleDate) {
      try {
        this._markersPlugin = LightweightCharts.createSeriesMarkers(candleSeries, [{
          time: earningsDate,
          position: 'aboveBar',
          color: markerColor,
          shape: 'circle',
          text: 'E',
        }]);
      } catch (err) {
        console.warn('[Chart] Failed to add earnings marker:', err.message);
      }
      return;
    }

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

    // Place marker
    try {
      this._markersPlugin = LightweightCharts.createSeriesMarkers(candleSeries, [{
        time: earningsDate,
        position: 'aboveBar',
        color: markerColor,
        shape: 'circle',
        text: 'E',
      }]);
    } catch (err) {
      console.warn('[Chart] Failed to add earnings marker:', err.message);
    }
  },

  /**
   * Find the candle time closest to (but not after) the given date string.
   * Uses binary search for O(log n) performance.
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
   * @param {object} candleSeries - LightweightCharts series object
   * @param {Array} candles - Candle data
   */
  _applyAllMarkers(ticker, candleSeries, candles) {
    if (!candleSeries) return;

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
    const txns = this._chartHolding?.transactions || [];
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

    // Apply all markers in one call
    if (markers.length > 0) {
      try {
        this._markersPlugin = LightweightCharts.createSeriesMarkers(candleSeries, markers);
      } catch (err) {
        console.warn('[Chart] Failed to add markers:', err.message);
      }
    }
  },

  /**
   * Draw an average price line on the chart for the given ticker.
   * Uses a solid black line to indicate the user's cost basis.
   * @param {string} ticker
   * @param {object} candleSeries
   */
  _getChartPosition(ticker) {
    return this._chartHolding?.position.ticker === ticker ? this._chartHolding.position : null;
  },

  _drawAvgPriceLine(ticker, candleSeries) {
    const position = this._getChartPosition(ticker);
    if (!position) return;

    const avgPrice = position.avg_price;
    if (!avgPrice || isNaN(avgPrice) || avgPrice <= 0) return;

    // Theme-aware: solid white in dark mode, solid black in light mode
    try {
      const isDark = document.documentElement.dataset.theme === 'dark';
      const priceLine = candleSeries.createPriceLine({
        price: avgPrice,
        color: isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)',
        lineWidth: 1,
        lineStyle: 0, // Solid
        axisLabelVisible: true,
        title: 'Avg',
      });
      this._avgPriceLine = priceLine;
      this._avgPrice = avgPrice;
    } catch (err) {
      console.warn('[Chart] Failed to draw avg price line:', err);
    }
  },

  // ─── AVG PRICE EDGE INDICATOR ────────────────────────

  /**
   * Create the avg price edge indicator DOM element.
   * Shows a badge at the top or bottom edge of the chart when avg_price is outside the visible range.
   * @param {object} chart - LightweightCharts chart instance
   * @param {object} candleSeries - Candlestick series
   * @param {string} ticker - Stock ticker symbol
   * @param {number} avgPrice - Average price value
   */
  _createAvgEdgeIndicator(chart, candleSeries, ticker, avgPrice) {
    // Remove existing indicator first
    this._removeAvgEdgeIndicator();

    const container = this._element('chart-canvas');
    if (!container) return;

    const el = document.createElement('div');
    el.className = 'avg-edge-indicator hidden';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-label', 'Average price is off-screen at $' + avgPrice.toFixed(2));
    el.innerHTML = '<span class="avg-edge-badge"><span class="avg-edge-arrow"></span>Avg $' + avgPrice.toFixed(2) + '</span>';
    container.appendChild(el);

    this._avgEdgeIndicator = el;

    // Subscribe to visible range changes to update indicator on scroll/zoom
    this._avgTimeScaleSubscription = chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
      this._updateAvgEdgeIndicator(chart, candleSeries);
    });

    // Initial update after a short delay to let chart finish rendering
    requestAnimationFrame(() => {
      this._updateAvgEdgeIndicator(chart, candleSeries);
    });
  },

  /**
   * Update avg edge indicator visibility based on whether avg price is in the visible range.
   * Called on visible range changes (scroll/zoom) and on initial render.
   * @param {object} chart - LightweightCharts chart instance
   * @param {object} candleSeries - Candlestick series
   */
  _updateAvgEdgeIndicator(chart, candleSeries) {
    if (!this._avgEdgeIndicator || !candleSeries) return;

    const avgPrice = this._avgPrice;
    if (avgPrice == null || isNaN(avgPrice)) {
      this._avgEdgeIndicator.classList.add('hidden');
      return;
    }

    const container = this._element('chart-canvas');
    if (!container) return;

    const height = container.clientHeight;

    // Try to get the Y coordinate of the avg price on the chart
    const y = candleSeries.priceToCoordinate(avgPrice);

    if (y != null && y >= 0 && y <= height) {
      // Avg price is within the visible range — hide the edge indicator
      this._avgEdgeIndicator.classList.add('hidden');
      return;
    }

    // Avg price is out of view — determine if it's above or below the visible range
    const arrowEl = this._avgEdgeIndicator.querySelector('.avg-edge-arrow');

    if (y != null && y < 0) {
      // Above visible range — show indicator at top edge
      this._avgEdgeIndicator.className = 'avg-edge-indicator top';
      if (arrowEl) arrowEl.textContent = '\u25BC'; // ▼
    } else if (y != null && y > height) {
      // Below visible range — show indicator at bottom edge
      this._avgEdgeIndicator.className = 'avg-edge-indicator bottom';
      if (arrowEl) arrowEl.textContent = '\u25B2'; // ▲
    } else {
      // y is null — fallback: use price comparison to determine direction
      try {
        const priceAtTop = candleSeries.coordinateToPrice(0);
        const priceAtBottom = candleSeries.coordinateToPrice(height);

        if (priceAtTop != null && avgPrice > priceAtTop) {
          this._avgEdgeIndicator.className = 'avg-edge-indicator top';
          if (arrowEl) arrowEl.textContent = '\u25BC'; // ▼
        } else if (priceAtBottom != null && avgPrice < priceAtBottom) {
          this._avgEdgeIndicator.className = 'avg-edge-indicator bottom';
          if (arrowEl) arrowEl.textContent = '\u25B2'; // ▲
        } else {
          this._avgEdgeIndicator.classList.add('hidden');
        }
      } catch (_) {
        this._avgEdgeIndicator.classList.add('hidden');
      }
    }
  },

  /**
   * Remove the avg price edge indicator from the chart and unsubscribe from time scale.
   */
  _removeAvgEdgeIndicator() {
    if (this._avgEdgeIndicator) {
      if (this._avgEdgeIndicator.parentNode) {
        this._avgEdgeIndicator.parentNode.removeChild(this._avgEdgeIndicator);
      }
      this._avgEdgeIndicator = null;
    }
    // Unsubscribe from time scale changes
    this._avgTimeScaleSubscription = null;
  },

  /**
   * Remove the avg price line from the chart and clean up edge indicator.
   */
  _removeAvgPriceLine() {
    if (this._avgPriceLine && this._candleSeries) {
      try { this._candleSeries.removePriceLine(this._avgPriceLine); } catch (_) {}
      this._avgPriceLine = null;
    }
    this._avgPrice = null;
    this._removeAvgEdgeIndicator();
  },

  // ─── AVG PRICE CROSS DETECTION ──────────────────────

  /**
   * Check if candle data crosses/touches the average price level.
   * Returns an alert object if cross detected, null otherwise.
   * @param {object} bar - { o, h, l, c }
   * @param {number} avgPrice
   * @param {string} ticker
   * @returns {object|null}
   */
  _detectAvgPriceCross(bar, avgPrice, ticker) {
    if (!bar || avgPrice == null) return null;

    const low = bar.l || bar.low;
    const high = bar.h || bar.high;
    const close = bar.c || bar.close;
    const open = bar.o || bar.open;

    // Touch/cross detection: wick touches avg_price zone
    // Use a 0.3% buffer similar to S/R lines
    const buffer = avgPrice * 0.003;
    const touched = (low <= avgPrice + buffer && high >= avgPrice - buffer);

    if (!touched) return null;

    // Determine pattern: close above or below avg_price
    const closedAbove = close > avgPrice;
    const closedBelow = close < avgPrice;

    // Same-candle cross: open on one side, close on the other
    const sameCandleCross = (open > avgPrice && close < avgPrice) || (open < avgPrice && close > avgPrice);

    if (sameCandleCross) {
      return {
        type: 'cross',
        ticker,
        avgPrice,
        close,
        open,
        high,
        low,
        pattern: close > avgPrice ? 'cross_above' : 'cross_below',
      };
    }

    if (closedAbove) {
      return {
        type: 'touch',
        ticker,
        avgPrice,
        close,
        open,
        high,
        low,
        pattern: 'touch_bullish',
      };
    }

    if (closedBelow) {
      return {
        type: 'touch',
        ticker,
        avgPrice,
        close,
        open,
        high,
        low,
        pattern: 'touch_bearish',
      };
    }

    return null;
  },

  /**
   * Check the latest candle for avg_price crosses when chart is open.
   * Called after chart data loads and on each refresh.
   * @param {string} ticker
   */
  async _checkLiveAvgPriceCrosses(ticker) {
    if (this._chartStandalone) return;
    if (this._currentChartTicker !== ticker) return;

    const position = this._getChartPosition(ticker);
    if (!position) return;

    // Skip ETFs — no avg price alerts for ETFs
    if (position.sector === 'ETF') return;

    const avgPrice = position.avg_price;
    if (avgPrice == null || isNaN(avgPrice) || avgPrice <= 0) return;

    // Try server-side check first
    try {
      await API.post('/alerts/check-avg', { ticker });
      return; // Server handled it
    } catch (_) {
      // Fall through to client-side detection
    }

    // Client-side: use the latest bar from the chart data
    if (!this._candleSeries) return;

    // We need the last bar — fetch it from the API or use cached data
    try {
      const data = await API.get('/data/history', { ticker, period: '1d' });
      const history = data.history || [];
      if (history.length === 0) return;

      const lastBar = history[history.length - 1];
      const alert = this._detectAvgPriceCross(lastBar, avgPrice, ticker);

      if (alert) {
        const message = 'Price ' + (alert.type === 'cross' ? 'crossed' : 'touched') +
          ' average at $' + alert.avgPrice.toFixed(2) +
          '. Close: $' + alert.close.toFixed(2);
        this._showAvgPriceToast(ticker, alert.avgPrice, message, alert.pattern);
      }
    } catch (err) {
      console.info('[Chart] Avg cross check unavailable:', err.message);
    }
  },

  /**
   * Show a toast notification for avg price cross/touch.
   * @param {string} ticker
   * @param {number} avgPrice
   * @param {string} message
   * @param {string} pattern - 'cross_above', 'cross_below', 'touch_bullish', 'touch_bearish'
   */
  _showAvgPriceToast(ticker, avgPrice, message, pattern) {
    const toastId = 'avg-toast-' + Date.now();
    let icon, title;

    switch (pattern) {
      case 'cross_above':
        icon = '\u{1F4C8}';
        title = ticker + ' \u2014 Crossed Above Average';
        break;
      case 'cross_below':
        icon = '\u{1F4C9}';
        title = ticker + ' \u2014 Crossed Below Average';
        break;
      case 'touch_bullish':
        icon = '\u{1F7E2}';
        title = ticker + ' \u2014 Touched Average (Bullish)';
        break;
      case 'touch_bearish':
        icon = '\u{1F534}';
        title = ticker + ' \u2014 Touched Average (Bearish)';
        break;
      default:
        icon = '\u{1F514}';
        title = ticker + ' \u2014 Average Price Alert';
    }

    const toastHtml = '<div id="' + toastId + '" class="avg-toast" role="alert" aria-live="polite">' +
      '<button class="avg-toast-close" title="Dismiss">\u2715</button>' +
      '<div class="avg-toast-title"><span class="avg-toast-icon">' + icon + '</span>' + this._escapeHtml(title) + '</div>' +
      '<div class="avg-toast-body">' + this._escapeHtml(message) + '</div>' +
    '</div>';

    document.body.insertAdjacentHTML('beforeend', toastHtml);

    // Bind close button
    const toastEl = this._element(toastId);
    if (toastEl) {
      const closeBtn = toastEl.querySelector('.avg-toast-close');
      if (closeBtn) {
        closeBtn.addEventListener('click', () => this._dismissAvgToast(toastId));
      }
    }

    // Auto-dismiss after 5 seconds
    setTimeout(() => this._dismissAvgToast(toastId), 5000);
  },

  /**
   * Dismiss a toast notification with animation.
   * @param {string} toastId
   */
  _dismissAvgToast(toastId) {
    const el = this._element(toastId);
    if (!el) return;
    el.classList.add('dismissing');
    setTimeout(() => { if (el.parentNode) el.remove(); }, 300);
  },

  /**
   * Render the avg price tag in the S/R legend container.
   * @param {string} ticker
   * @param {number} avgPrice
   */
  _renderAvgLegend(ticker, avgPrice) {
    const el = this._element('chart-sr-legend');
    if (!el) return;

    // Check if avg tag already exists
    const existing = el.querySelector('.sr-tag.avg');
    if (existing) {
      existing.innerHTML = '&#9679; Avg $' + avgPrice.toFixed(2);
      return;
    }

    // Create avg tag at the beginning
    const avgTag = document.createElement('div');
    avgTag.className = 'sr-tag avg';
    avgTag.innerHTML = '&#9679; Avg $' + avgPrice.toFixed(2);
    el.insertBefore(avgTag, el.firstChild);
  },

  // ─── S/R DRAWING (ported from charts.js) ───────────────

  /** @type {string|null} Current draw mode: 'support', 'resistance', or null */
  _drawMode: null,

  /** @type {string|null} Ticker whose chart is open for S/R drawing */
  _drawTicker: null,

  /** @type {Object|null} Chart instance for the open chart modal */
  _chartInstance: null,

  /** @type {Function|null} Resize handler for the chart modal */
  _chartResizeHandler: null,

  /** @type {Object|null} Candlestick series for the open chart modal */
  _candleSeries: null,

  /** @type {Object|null} SMA 200 series for the open chart modal */
  _smaSeries: null,

  /** @type {Array} Current S/R lines for the open chart */
  _srLines: [],

  /** @type {Array} Tracked price lines for cleanup */
  _priceLines: [],

  /** @type {Object|null} Tracked avg price line for cleanup */
  _avgPriceLine: null,

  /** @type {number|null} Current avg price value for edge indicator */
  _avgPrice: null,

  /** @type {HTMLElement|null} Avg edge indicator DOM element */
  _avgEdgeIndicator: null,

  /** @type {Function|null} Time scale visibility change subscription */
  _avgTimeScaleSubscription: null,

  /** @type {boolean} Whether % Move primitive is currently enabled */
  _pctMoveEnabled: false,

  /** @type {object|null} Currently attached PctMovePrimitive instance */
  _pctMovePrimitive: null,

  /** @type {boolean} Whether the volume profile overlay is enabled (opt-in, persisted) */
  _vpEnabled: false,

  /** @type {object|null} Currently attached VolumeProfilePrimitive instance */
  _vpPrimitive: null,

  /** @type {Array} Tracked POC/VAH/VAL price lines for cleanup */
  _vpPriceLines: [],

  /** @type {'1w'|'1m'|'3m'|'6m'|'1y'} Rolling volume-profile period */
  _vpRange: '3m',

  /** @type {string|null} Manual volume-profile anchor date */
  _vpAnchorTime: null,

  /** @type {boolean} Whether the next chart click selects a VP anchor */
  _vpAnchorMode: false,

  /** @type {boolean} Whether the last profile POC moved across row-size variants */
  _vpSensitive: false,

  /** @type {number} Number of real API candles before earnings placeholders */
  _realCandleCount: 0,

  /** @type {boolean} Whether 15-minute intraday chart mode is active */
  _live15mMode: false,

  /**
   * Modal live-stream state (expand-modal Live button).
   * Single SSE stream for _currentChartTicker; null when inactive.
   * @type {object|null}
   */
  _modalLive: null,

  /** @type {number} Modal-live idle auto-close (user gestures only) */
  _MODAL_LIVE_IDLE_MS: 5 * 60 * 1000,

  /** @type {number} Modal-live REST re-sync interval (correct WS drift) */
  _MODAL_LIVE_RESYNC_MS: 60 * 1000,

  /** @type {boolean} Whether position P/L chart mode is active */
  _positionPnlMode: false,

  /** @type {boolean} Whether TradingView widget view is active */
  _tvWidgetMode: false,

  /** @type {boolean} Whether TradingView widget script has been loaded */
  _tvWidgetScriptLoaded: false,

  /**
   * Toggle S/R draw mode for support or resistance.
   * @param {'support'|'resistance'} type
   */
  _toggleDrawMode(type) {
    this._cancelTrailingEditor();
    this._cancelVpAnchorMode();
    // S/R drawing needs the daily chart: restore it first, user re-taps to draw.
    if (this._modalLive) { this._exitModalLive(true, 'mode_switch'); return; }
    if (this._drawMode === type) {
      // Turn off
      this._drawMode = null;
      this._drawTicker = null;
      this._updateDrawModeUI(false);
    } else {
      this._drawMode = type;
      this._drawTicker = this._currentChartTicker || null;
      this._updateDrawModeUI(true);
    }
  },

  /**
   * Update visual state of the draw mode buttons.
   * @param {boolean} active
   */
  _updateDrawModeUI(active) {
    const supportBtn = this._element('chart-draw-support');
    const canvas = this._element('chart-canvas');

    if (supportBtn) {
      supportBtn.classList.toggle('active', active && this._drawMode !== 'trailing');
    }
    const trailingBtn = this._element('chart-trailing-stop');
    if (trailingBtn) {
      const drawing = active && this._drawMode === 'trailing';
      trailingBtn.classList.toggle('active', drawing);
      trailingBtn.setAttribute('aria-pressed', String(drawing));
    }
    if (canvas) {
      canvas.style.cursor = active ? 'crosshair' : '';
    }
  },

  /**
   * Handle chart click — if in draw mode, show price picker.
   * @param {Object} param - LightweightCharts click parameter
   */
  _handleChartClick(param) {
    if (!this._drawMode) return;
    if (!param || !param.point) return;

    const price = this._candleSeries
      ? this._candleSeries.coordinateToPrice(param.point.y)
      : null;

    if (price !== null && price !== undefined && price > 0) {
      this._showSRPicker(price, this._currentChartTicker);
    }
  },

  /**
   * Show the S/R type picker at the click position.
   * @param {number} price
   * @param {string} ticker
   * @param {number} [clickX] - Optional X coordinate (viewport) to position near
   * @param {number} [clickY] - Optional Y coordinate (viewport) to position near
   */
  _showSRPicker(price, ticker, clickX, clickY) {
    const picker = this._element('chartSRPicker');
    const priceEl = this._element('chartSRPickerPrice');
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
    const picker = this._element('chartSRPicker');
    if (picker) picker.style.display = 'none';
  },

  /**
   * Load S/R lines for a ticker from the backend.
   * @param {string} ticker
   */
  async _loadSRLines(ticker) {
    const openVersion = this._chartOpenVersion;
    const renderVersion = this._chartRenderVersion;
    const isCurrent = () => openVersion === this._chartOpenVersion
      && renderVersion === this._chartRenderVersion && this._currentChartTicker === ticker;
    try {
      const lines = await API.get('/sr/levels', { ticker });
      if (!isCurrent()) return;
      this._srLines = Array.isArray(lines) ? lines : [];
      this._renderSRLines();
      this._renderSRLegend(ticker);
    } catch (err) {
      if (!isCurrent()) return;
      console.warn('[Chart] Failed to load S/R lines:', err.message);
      this._srLines = [];
      this._renderSRLegend(ticker);
    }
  },

  /**
   * Render S/R line markers on the chart.
   */
  _renderSRLines() {
    if (!this._candleSeries) return;

    // Remove existing price lines
    if (this._priceLines) {
      this._priceLines.forEach((pl) => {
        try { this._candleSeries.removePriceLine(pl); } catch {}
      });
    }
    this._priceLines = [];

    const isDark = document.documentElement.dataset.theme === 'dark';

    this._srLines.forEach((line) => {
      const color = line.type === 'support'
        ? (isDark ? '#30D158' : '#34C759')
        : (isDark ? '#FF453A' : '#FF3B30');

      const pl = this._candleSeries.createPriceLine({
        price: line.price,
        color,
        lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Dashed,
        axisLabelVisible: true,
        title: line.type === 'support' ? 'S' : 'R',
      });
      this._priceLines.push(pl);
    });
  },

  /**
   * Render the S/R legend in the chart modal sidebar.
   * @param {string} ticker
   */
  _renderSRLegend(ticker) {
    const legend = this._element('chart-sr-legend');
    if (!legend) return;

    if (this._srLines.length === 0) {
      legend.innerHTML = '<div style="font-size:var(--font-size-xs);color:var(--color-text-tertiary);padding:var(--space-2) 0;">No lines drawn yet.</div>';
      return;
    }

    const isDark = document.documentElement.dataset.theme === 'dark';

    legend.innerHTML = this._srLines
      .sort((a, b) => a.price - b.price)
      .map((line) => {
        const color = line.type === 'support'
          ? (isDark ? '#30D158' : '#34C759')
          : (isDark ? '#FF453A' : '#FF3B30');
        const typeClass = line.type === 'support' ? 'sup' : 'res';
        return `<div class="chart-legend-line ${typeClass}">
          <span class="chart-legend-dot" style="background:${color}"></span>
          <span class="chart-legend-type">${line.type === 'support' ? 'S' : 'R'}</span>
          <span class="chart-legend-price">$${Number(line.price).toFixed(2)}</span>
          <button class="chart-legend-delete" title="Remove line" aria-label="Remove ${line.type} line at $${Number(line.price).toFixed(2)}" data-line-id="${line.id}" data-ticker="${ticker}">
            <svg viewBox="0 0 12 12" fill="none"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
          </button>
        </div>`;
      })
      .join('');

    // Bind delete buttons
    legend.querySelectorAll('.chart-legend-delete').forEach((btn) => {
      btn.addEventListener('click', () => {
        const lineId = Number(btn.dataset.lineId);
        const lineTicker = btn.dataset.ticker;
        this._deleteSRLine(lineId, lineTicker);
      });
    });
  },

  /**
   * Add an S/R line via API and refresh the chart.
   * @param {string} ticker
   * @param {number} price
   * @param {string} type - 'support' | 'resistance'
   */
  async _addSRLine(ticker, price, type) {
    try {
      await API.post('/sr/levels', { ticker, price, type });
      await this._loadSRLines(ticker);
    } catch (err) {
      console.warn('[Chart] Failed to add S/R line:', err.message);
    }
  },

  /**
   * Delete an S/R line via API and refresh the chart.
   * @param {number} lineId
   * @param {string} ticker
   */
  async _deleteSRLine(lineId, ticker) {
    try {
      await API.delete(`/sr/levels/${lineId}`);
      await this._loadSRLines(ticker);
    } catch (err) {
      console.warn('[Chart] Failed to delete S/R line:', err.message);
    }
  },

  /**
   * Clear all S/R lines on the current chart (delete via API).
   */
  async _clearAllSRLines() {
    if (!this._srLines || this._srLines.length === 0) return;
    if (!confirm('Remove all Support/Resistance lines?')) return;

    const ticker = this._currentChartTicker;
    try {
      for (const line of this._srLines) {
        await API.delete(`/sr/levels/${line.id}`);
      }
      if (ticker) await this._loadSRLines(ticker);
    } catch (err) {
      console.warn('[Chart] Failed to clear S/R lines:', err.message);
    }
  },

  // ─── PORTFOLIO TRAILING STOP ─────────────────────────
  _trailingContext() {
    if (!this._chartPortfolioId || this._chartStandalone || !this._currentChartTicker) return null;
    const portfolioId = this._chartPortfolioId;
    const ticker = this._currentChartTicker;
    const open = this._chartOpenVersion;
    const render = this._chartRenderVersion;
    return {
      path: `/portfolio/${portfolioId}/trailing-stops/${encodeURIComponent(ticker)}`,
      current: () => portfolioId === this._chartPortfolioId && ticker === this._currentChartTicker
        && open === this._chartOpenVersion && render === this._chartRenderVersion
        && !!this._element('chart-modal')?.classList.contains('open'),
    };
  },

  _trailingManageAllowed() {
    // Desktop browser only (matches the max-width: 767px mobile CSS).
    // Mobile still loads and renders the read-only TS line; it just
    // cannot open the editor or manage actions.
    try {
      if (window.matchMedia && window.matchMedia('(max-width: 767px)').matches) return false;
    } catch {}
    if (typeof window.innerWidth === 'number' && window.innerWidth <= 767) return false;
    const btn = this._element('chart-trailing-stop');
    if (btn && typeof getComputedStyle === 'function') {
      try { if (getComputedStyle(btn).display === 'none') return false; } catch {}
    }
    return true;
  },

  _bindTrailingStopButtons() {
    const button = this._element('chart-trailing-stop');
    if (button && !button._hasTSHandler) {
      button.addEventListener('click', () => this._beginTrailingStop());
      button._hasTSHandler = true;
    }
    const section = this._element('chart-ts-section');
    if (!section || section._hasTSHandler) return;
    section._hasTSHandler = true;
    section.addEventListener('click', (event) => {
      const action = event.target.closest('[data-ts-action]')?.dataset.tsAction;
      if (action === 'remove') this._removeTrailingStop();
      if (action === 'rearm') this._beginTrailingStop(true);
      if (action === 'retry') this._loadTrailingStop();
    });
    this._element('chart-ts-editor').addEventListener('submit', (event) => {
      event.preventDefault();
      this._saveTrailingStop();
    });
    this._element('chart-ts-price').addEventListener('input', () => this._updateTrailingDistance());
    this._element('chart-ts-cancel').addEventListener('click', () => this._cancelTrailingEditor(true));
  },

  _setTrailingStatus(message = '', error = false) {
    const status = this._element('chart-ts-status');
    if (status) {
      status.textContent = message;
      status.classList.toggle('ts-error', error);
    }
  },

  _resetTrailingStop() {
    this._cancelTrailingEditor();
    this._trailingLoadVersion++;
    if (this._trailingLine && this._candleSeries) {
      try { this._candleSeries.removePriceLine(this._trailingLine); } catch {}
    }
    this._trailingLine = null;
    this._trailingStop = null;
    this._trailingLoaded = false;
    this._chartPortfolioId = null;
    this._setTrailingStatus();
    const details = this._element('chart-ts-details');
    if (details) details.innerHTML = '';
    const section = this._element('chart-ts-section');
    if (section) section.hidden = true;
  },

  _cancelTrailingEditor(focus = false) {
    this._trailingRequest++;
    this._trailingEditor = null;
    if (this._drawMode === 'trailing') {
      this._drawMode = null;
      this._drawTicker = null;
      this._updateDrawModeUI(false);
    }
    const editor = this._element('chart-ts-editor');
    if (editor) {
      editor.hidden = true;
      editor.reset();
      editor.querySelectorAll('button, input').forEach(el => { el.disabled = false; });
    }
    const button = this._element('chart-trailing-stop');
    if (button) {
      button.disabled = false;
      if (focus) button.focus();
    }
    this._setTrailingStatus();
  },

  async _loadTrailingStop() {
    const context = this._trailingContext();
    const section = this._element('chart-ts-section');
    if (section) section.hidden = !context;
    if (!context) return false;
    const request = ++this._trailingLoadVersion;
    this._setTrailingStatus('Loading…');
    try {
      const data = await API.get(context.path);
      if (!context.current() || request !== this._trailingLoadVersion) return false;
      this._trailingStop = data.stop;
      this._trailingLoaded = true;
      this._setTrailingStatus();
      this._renderTrailingStop();
      return true;
    } catch (error) {
      if (context.current() && request === this._trailingLoadVersion) {
        this._trailingLoaded = false;
        this._setTrailingStatus(error.message, true);
        this._renderTrailingStop();
      }
      return false;
    }
  },

  _renderTrailingStop() {
    const section = this._element('chart-ts-section');
    const details = this._element('chart-ts-details');
    if (!section || !details) return;
    const context = this._trailingContext();
    section.hidden = !context;
    if (!context) return;
    const stop = this._trailingStop;
    const native = !this._modalLive && !this._tvWidgetMode && !this._positionPnlMode;
    if (native && this._candleSeries) {
      if (this._trailingLine) {
        try { this._candleSeries.removePriceLine(this._trailingLine); } catch {}
        this._trailingLine = null;
      }
      if (stop) {
        const token = stop.state === 'hit' ? '--color-error' : '--color-warning';
        const color = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
        this._trailingLine = this._candleSeries.createPriceLine({
          price: stop.stop_price, color, lineWidth: 1,
          lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true,
          title: stop.state === 'hit' ? 'TS HIT' : 'TS',
        });
      }
    }
    // Mobile is read-only: line renders above, but no section, placeholder,
    // retry, or manage controls. Desktop behavior below is unchanged.
    if (!this._trailingManageAllowed()) {
      if (this._trailingEditor || this._drawMode === 'trailing') this._cancelTrailingEditor();
      section.hidden = true;
      return;
    }
    if (!this._trailingLoaded) {
      details.innerHTML = '<button type="button" class="chart-tool-btn clear" data-ts-action="retry">Retry</button>';
      return;
    }
    if (!stop) {
      details.innerHTML = '<div class="ts-help">Select Trailing Stop to place a line or enter a stop price.</div>';
      return;
    }
    const hit = stop.state === 'hit';
    const dateText = hit ? `Hit: ${stop.hit_date}` : stop.last_processed_date
      ? `Last checked: ${stop.last_processed_date}` : `First full session on or after ${stop.eligible_from}`;
    details.innerHTML = `
      <div class="ts-price ${hit ? 'hit' : ''}">${hit ? 'TS HIT' : 'TS'} $${Number(stop.stop_price).toFixed(2)} <span class="ts-state">${hit ? 'HIT' : 'ACTIVE'}</span></div>
      <div class="ts-help">Trail distance: $${Number(stop.trail_amount).toFixed(2)}</div>
      <div class="ts-help">${this._escapeHtml(dateText)}</div>
      ${hit ? `<div class="ts-help">Low: $${Number(stop.hit_low).toFixed(2)} · Close: $${Number(stop.hit_close).toFixed(2)}</div>` : ''}
      <div class="ts-actions">
        ${hit ? '<button type="button" class="chart-tool-btn trailing-stop" data-ts-action="rearm">Re-arm</button>' : ''}
        <button type="button" class="chart-tool-btn clear" data-ts-action="remove">Remove</button>
      </div>`;
  },

  async _beginTrailingStop(rearm = false) {
    if (!this._trailingContext()) return;
    if (!this._trailingManageAllowed()) return;
    if (this._trailingEditor) {
      this._cancelTrailingEditor(true);
      return;
    }
    // Drawing always uses the native daily-price scale.
    if (this._modalLive || this._tvWidgetMode || this._positionPnlMode) {
      if (this._modalLive) this._exitModalLive(false, 'mode_trailing_stop');
      this._exitModalModesSilent();
      await this._renderChartModal(this._currentChartTicker);
    }
    const context = this._trailingContext();
    if (!context?.current()) return;
    const request = ++this._trailingRequest;
    const button = this._element('chart-trailing-stop');
    if (button) button.disabled = true;
    this._hideSRPicker();
    this._drawMode = null;
    this._updateDrawModeUI(false);
    this._setTrailingStatus('Loading setup…');
    try {
      const data = await API.get(context.path, { reference: 'true' });
      if (!context.current() || request !== this._trailingRequest) return;
      this._trailingLoadVersion++;
      this._trailingStop = data.stop;
      this._trailingLoaded = true;
      this._renderTrailingStop();
      this._setTrailingStatus();
      if (data.stop && (!rearm || data.stop.state !== 'hit')) {
        this._element('chart-ts-title')?.focus();
        return;
      }
      this._trailingEditor = { ...data, context, rearm, saving: false };
      const editor = this._element('chart-ts-editor');
      editor.hidden = false;
      this._element('chart-ts-reference').textContent =
        `Reference close: $${Number(data.reference.close).toFixed(2)} · ${data.reference.date}`;
      this._element('chart-ts-effective').textContent =
        `First full trading session on or after ${data.eligible_from}. Checked after market close.`;
      this._element('chart-ts-error').textContent = '';
      this._element('chart-ts-save').textContent = rearm ? 'Re-arm' : 'Save';
      this._cancelVpAnchorMode();
      this._drawMode = 'trailing';
      this._drawTicker = this._currentChartTicker;
      this._updateDrawModeUI(true);
      this._updateTrailingDistance();
      this._element('chart-ts-price').focus({ preventScroll: true });
    } catch (error) {
      if (context.current() && request === this._trailingRequest) this._setTrailingStatus(error.message, true);
    } finally {
      if (context.current() && request === this._trailingRequest && button) button.disabled = false;
    }
  },

  _setTrailingPrice(value) {
    if (!this._trailingEditor || this._trailingEditor.saving) return;
    const input = this._element('chart-ts-price');
    input.value = Number(value).toFixed(2);
    this._updateTrailingDistance();
  },

  _updateTrailingDistance() {
    const editor = this._trailingEditor;
    if (!editor) return;
    const input = this._element('chart-ts-price');
    const value = Number(input.value);
    const distance = Math.round((editor.reference.close - value) * 100) / 100;
    const valid = Number.isFinite(value) && value > 0 && distance > 0;
    input.setCustomValidity(input.value && !valid ? 'Enter a positive stop below the reference close.' : '');
    this._element('chart-ts-distance').textContent = valid
      ? `Trail distance: $${distance.toFixed(2)}` : 'Click the chart or enter a price below the reference close.';
    this._element('chart-ts-save').disabled = !valid || editor.saving;
  },

  async _saveTrailingStop() {
    const editor = this._trailingEditor;
    if (!editor || editor.saving || !editor.context.current()) return;
    if (!this._trailingManageAllowed()) { this._cancelTrailingEditor(); return; }
    const form = this._element('chart-ts-editor');
    if (!form.reportValidity()) return;
    const value = Number(this._element('chart-ts-price').value);
    const request = ++this._trailingRequest;
    editor.saving = true;
    form.querySelectorAll('button, input').forEach(el => { el.disabled = true; });
    this._element('chart-ts-error').textContent = '';
    try {
      const data = await API.post(editor.context.path + (editor.rearm ? '/rearm' : ''), {
        stop_price: value, reference_date: editor.reference.date, reference_close: editor.reference.close,
        stop_id: editor.stop?.id, cycle: editor.stop?.cycle,
      });
      if (!editor.context.current() || request !== this._trailingRequest) return;
      this._trailingLoadVersion++;
      this._cancelTrailingEditor(true);
      this._trailingStop = data.stop;
      this._trailingLoaded = true;
      this._renderTrailingStop();
    } catch (error) {
      if (editor.context.current() && this._trailingEditor === editor) {
        this._element('chart-ts-error').textContent = error.status === 409
          ? `${error.message} Cancel and select Trailing Stop to reload.` : error.message;
      }
    } finally {
      if (editor.context.current() && this._trailingEditor === editor) {
        editor.saving = false;
        form.querySelectorAll('button, input').forEach(el => { el.disabled = false; });
        this._updateTrailingDistance();
      }
    }
  },

  async _removeTrailingStop() {
    const context = this._trailingContext();
    const stop = this._trailingStop;
    if (!context || !stop) return;
    if (!this._trailingManageAllowed()) return;
    this._cancelTrailingEditor();
    const request = ++this._trailingRequest;
    this._setTrailingStatus('Removing…');
    try {
      await API.delete(`${context.path}?stop_id=${stop.id}&cycle=${stop.cycle}`);
      if (!context.current() || request !== this._trailingRequest) return;
      this._trailingLoadVersion++;
      this._trailingStop = null;
      this._trailingLoaded = true;
      this._setTrailingStatus();
      this._renderTrailingStop();
    } catch (error) {
      if (context.current() && request === this._trailingRequest) this._setTrailingStatus(error.message, true);
    }
  },

  // ─── LIVE 15-MINUTE CHART ────────────────────────────

  /**
   * Toggle between 15-minute intraday chart and daily chart.
   * Fetches today's 15m candles from the backend and re-renders the chart.
   */
  /**
   * Bind the modal Live toggle to the current DOM (once per element).
   * Skips when bindEvents() already owns the button (Portfolio screen).
   */
  _onViewportChange() {
    if (!this._isVpDesktop()) {
      this._detachVP();
      this._cancelVpAnchorMode();
      this._cancelTrailingEditor();
    } else if (this._vpEnabled && this._candleSeries && this._candleDataCache) {
      this._attachVP(false);
    }
    this._syncVpLayout();
  },

  /**
   * Toggle the modal live stream (expand-modal "Live" button).
   * Click Live -> full live card (timeframes + price + badge + SSE candles).
   * Click Live again, any other toolbar button, or close -> stream destroyed
   * and the daily chart is restored.
   */
  _toggleLive15m() {
    if (this._modalLive) {
      this._exitModalLive(true);
      return;
    }
    // Leave other modal modes without re-rendering; live entry builds its own view.
    this._exitModalModesSilent();
    this._enterModalLive();
  },

  /**
   * Silently leave TV / P&L / %Move / draw modes (no re-render).
   * Used before entering modal-live so modes stay mutually exclusive.
   */
  _exitModalModesSilent() {
    this._cancelTrailingEditor();
    this._trailingLine = null;
    try { this._destroyTvWidget(); } catch {}
    if (this._positionPnlMode) {
      this._positionPnlMode = false;
      const pnlBtn = this._element('pnl-chart-toggle');
      if (pnlBtn) pnlBtn.classList.remove('active');
      const canvas = this._element('chart-canvas');
      if (canvas && this._pnlMouseLeaveHandler) {
        try { canvas.removeEventListener('mouseleave', this._pnlMouseLeaveHandler); } catch {}
        this._pnlMouseLeaveHandler = null;
      }
    }
    if (this._pctMoveEnabled) {
      try { this._detachPctMove(); } catch {}
      this._pctMoveEnabled = false;
      const pctBtn = this._element('pct-move-toggle');
      if (pctBtn) pctBtn.classList.remove('active');
    }
    // Volume profile: detach from the torn-down daily chart but stay enabled
    // so the daily restore re-attaches automatically. Buttons show inactive
    // while another mode owns the canvas.
    try { this._detachVP(); } catch {}
    this._host.querySelectorAll('.chart-tool-btn.vp').forEach((btn) => {
      btn.classList.remove('active');
      btn.setAttribute('aria-pressed', 'false');
    });
    this._drawMode = null;
    this._drawTicker = null;
    try { this._updateDrawModeUI(false); } catch {}
    this._live15mMode = false;
  },

  /** New per-session stream id (correlates SSE open/close/hint server logs). */
  _modalLiveNewSid() {
    try { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
    catch { return String(Date.now()); }
  },

  /**
   * Advisory teardown hint: at most once per session, and only when a
   * stream was actually opened. The SSE-disconnect server path owns real
   * demand state; this is just fast reclaim + attribution.
   */
  _modalLiveSendUnsub(L, reason) {
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

  /** Live timeframe defs for the modal (intraday only, mirrors Charts tab). */
  _modalLiveTFS() {
    return [
      { id: '1m', label: '1m', period: '1d', interval: '1m', bucket: 60 },
      { id: '5m', label: '5m', period: '5d', interval: '5m', bucket: 300 },
      { id: '15m', label: '15m', period: '5d', interval: '15m', bucket: 900 },
    ];
  },

  _modalLiveTfDef(interval) {
    return this._modalLiveTFS().find(t => t.id === interval) || this._modalLiveTFS()[2];
  },

  _modalLiveDefaultInterval() {
    try {
      const v = localStorage.getItem('liveChart.interval') || '15m';
      if (this._modalLiveTFS().some(t => t.id === v)) return v;
    } catch {}
    return '15m';
  },

  /**
   * Enter modal-live: tear down the daily chart, render the live card
   * (no ticker input — the modal title already shows the ticker), seed
   * history, then open the SSE stream.
   */
  async _enterModalLive() {
    const openVersion = this._chartOpenVersion;
    const renderVersion = ++this._chartRenderVersion;
    const ticker = this._currentChartTicker;
    const area = this._host.querySelector('.chart-area');
    const canvas = this._element('chart-canvas');
    this._setVpControlsVisible(false);
    if (!ticker || !area || !canvas) {
      console.warn('[Chart] Live unavailable: missing ticker/canvas context');
      if (area && !this._element('modal-live-host')) {
        const note = document.createElement('div');
        note.id = 'modal-live-host';
        note.innerHTML = '<div class="live-card"><div class="live-toolbar"><span class="live-badge off">○ ERROR</span>'
          + '<span style="font-size:12px;color:var(--color-text-secondary);">Live chart unavailable here — reopen the chart and retry.</span></div></div>';
        area.appendChild(note);
        setTimeout(() => { try { note.remove(); } catch {} }, 4000);
      }
      const liveBtn = this._element('live-15m-toggle');
      if (liveBtn) liveBtn.classList.remove('active');
      return;
    }

    await this._ensureLightCharts();
    if (openVersion !== this._chartOpenVersion || renderVersion !== this._chartRenderVersion
        || this._element('chart-canvas') !== canvas) return;
    if (typeof LightweightCharts === 'undefined') {
      console.warn('[Chart] Live unavailable: chart library failed to load');
      return;
    }

    this._clearPatternOverlay();
    this._setPatternControlsVisible(false);
    this._setVpControlsVisible(false);

    // Reset modal drawing/avg state (mirrors _renderTvWidget teardown).
    this._drawMode = null;
    this._drawTicker = null;
    this._srLines = [];
    this._priceLines = [];
    this._avgPriceLine = null;
    this._avgPrice = null;
    this._avgEdgeIndicator = null;
    this._avgTimeScaleSubscription = null;
    try { this._updateDrawModeUI(false); } catch {}
    if (this._chartTooltip) {
      try { this._chartTooltip.destroy(); } catch {}
      this._chartTooltip = null;
    }
    try { this._removeAvgEdgeIndicator(); } catch {}
    const avgBadge = this._element('chart-avg-badge');
    if (avgBadge) avgBadge.style.display = 'none';

    // Hide S/R legend (live has its own toolbar, like P/L mode).
    const srLegend = this._host.querySelector('.chart-legend-panel');
    if (srLegend) srLegend.style.display = 'none';
    const modalBody = this._host.querySelector('.chart-modal-body');
    if (modalBody) modalBody.classList.add('legend-hidden');

    this._disposeChart();
    canvas.style.display = 'none';

    // Live has its own mlivePrice/mliveChg header — hide the daily pill.
    this._setModalPriceVisible(false);

    // Build the live host (mlive* ids — never collide with the tab's live* ids).
    let host = this._element('modal-live-host');
    if (host) host.remove();
    host = document.createElement('div');
    host.id = 'modal-live-host';
    area.appendChild(host);

    const interval = this._modalLiveDefaultInterval();
    this._modalLive = {
      ticker, interval,
      chart: null, candleSeries: null, volumeSeries: null, container: null,
      eventSource: null, status: 'LOADING', gen: 0,
      candles: [], lastBucket: null, lastDayVolume: 0,
      idleTimer: null, resyncTimer: null, visHandler: null, actHandler: null,
      price: null, changeAbs: null, changePct: null,
      sid: this._modalLiveNewSid(), streamOpened: false, unsubSent: false,
      shade: null, shadeDayKey: null,
      autoSR: [], autoSRPending: null, autoSRDay: null, autoSRDaily: null, autoSRThrottle: 0, autoSRHidden: false, autoSRLevels: [],
    };
    try {
      localStorage.setItem('liveChart.ticker', ticker);
      localStorage.setItem('liveChart.interval', interval);
    } catch {}
    this._renderModalLiveHost();
    const liveBtn = this._element('live-15m-toggle');
    if (liveBtn) liveBtn.classList.add('active');
    const liveSession = this._modalLive;
    await this._modalLiveLoadHistory();
    if (this._modalLive !== liveSession) return;
    this._modalLiveStartStream();
    this._modalLiveArmIdle();
    this._modalLiveWatchVisibility();
  },

  _renderModalLiveHost() {
    const host = this._element('modal-live-host');
    const L = this._modalLive;
    if (!host || !L) return;
    const tfs = this._modalLiveTFS().map(t =>
      `<button class="time-interval-btn${t.id === L.interval ? ' active' : ''}" data-mlive-tf="${t.id}">${t.label}</button>`
    ).join('');
    host.innerHTML = `
      <div class="live-card">
        <div class="live-toolbar">
          <div class="time-interval-bar" role="tablist" aria-label="Live timeframe">${tfs}</div>
          <div class="price-block">
            <span class="price-val" id="mlivePrice">--</span>
            <span class="price-chg" id="mliveChg">--</span>
          </div>
          <span class="live-badge off" id="mliveBadge">…</span>
        </div>
        <div class="live-chart-body">
          <div class="tv-chart-wrap" id="mliveChartCanvas"></div>
          <button type="button" class="live-sr-toggle" id="mliveSRtoggle" hidden
                  aria-pressed="true" aria-label="Hide S/R lines" title="Hide S/R lines">
            <svg class="eye-open" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M2 10s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><circle cx="10" cy="10" r="2.3" stroke="currentColor" stroke-width="1.4"/></svg>
            <svg class="eye-closed" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M3 7.4C4.5 6 6.8 5 10 5c5 0 8 5 8 5-.6 1-1.4 2-2.5 2.9M4.5 13C2.9 11.6 2 10 2 10m5.2 4.5A9 9 0 0 0 10 15c1.1 0 2.1-.2 3-.5M2.5 2.5l15 15" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <div class="card-status" id="mliveLoading"><div class="spinner"></div><span style="font-size:13px;color:var(--color-text-secondary);">Loading ${L.ticker}…</span></div>
          <div class="card-status hidden" id="mliveError" role="alert"><span style="font-size:13px;color:var(--color-error);" id="mliveErrorMsg">Unable to load</span></div>
          <div class="live-resume-overlay" id="mliveResume"><span style="font-size:13px;color:#fff;">Paused — socket closed after 5 min idle</span><button class="live-resume-btn" id="mliveResumeBtn">Resume live</button></div>
        </div>
      </div>`;
    host.querySelectorAll('[data-mlive-tf]').forEach(btn => {
      btn.addEventListener('click', () => this._modalLiveSwitchInterval(btn.dataset.mliveTf));
    });
    const resume = host.querySelector('#mliveResumeBtn');
    if (resume) resume.addEventListener('click', () => this._modalLiveResume());
    const srToggle = host.querySelector('#mliveSRtoggle');
    if (srToggle) srToggle.addEventListener('click', () => this._modalLiveToggleAutoSR());
  },

  _modalLiveSetBadge(status) {
    const badge = this._element('mliveBadge');
    if (!badge) return;
    if (this._modalLive) this._modalLive.status = status;
    badge.className = 'live-badge ' + (status === 'LIVE' || status === 'PRE' || status === 'POST'
      ? 'on' : status === 'PAUSED' ? 'paused' : 'off');
    badge.textContent = status === 'LIVE' ? '● LIVE'
      : status === 'PRE' ? '● PRE'
      : status === 'POST' ? '● POST'
      : status === 'PAUSED' ? '○ PAUSED'
      : status === 'LOADING' ? '…'
      : '○ ' + status;
  },

  _modalLiveUpdateHeader(changeAbs, chgPct) {
    const p = this._element('mlivePrice');
    const c = this._element('mliveChg');
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

  _modalLiveChangeAbs(price, pct) {
    // Derive dollar change from price + pct vs prior close (guard pct=-100%).
    const p = Number(price);
    const v = Number(pct);
    if (!isNaN(p) && p > 0 && !isNaN(v) && v > -100) {
      const prev = p / (1 + v / 100);
      return p - prev;
    }
    return null;
  },

  _initModalLiveChart() {
    const L = this._modalLive;
    if (!L || typeof LightweightCharts === 'undefined') return;
    const container = this._element('mliveChartCanvas');
    if (!container) return;
    if (L.chart) { try { L.chart.remove(); } catch {} L.chart = null; }
    const isDark = document.documentElement.dataset.theme === 'dark';
    const { bgColor, textColor, gridColor } = chartThemeColors();
    const chart = LightweightCharts.createChart(container, {
      width: container.clientWidth || 800,
      height: container.clientHeight || 460,
      layout: { background: { type: 'solid', color: bgColor }, textColor, attributionLogo: false },
      localization: (typeof etTimeFormatter === 'function')
        ? { timeFormatter: etTimeFormatter }
        : undefined,
      grid: { vertLines: { color: gridColor, style: LightweightCharts.LineStyle.Dotted }, horzLines: { color: gridColor, style: LightweightCharts.LineStyle.Dotted } },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
      rightPriceScale: { borderColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)' },
      timeScale: {
        borderColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)',
        timeVisible: true, secondsVisible: false, rightOffset: 5,
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
   * (Re)build pre/post session shading for the modal live chart.
   * Detach + re-attach forces a redraw. Chart removal destroys primitives.
   */
  _modalLiveUpdateShades() {
    const L = this._modalLive;
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
        bucketSec: (this._modalLiveTfDef(L.interval) || {}).bucket || 900,
      });
      L.candleSeries.attachPrimitive(L.shade);
      L.shadeDayKey = (typeof etDateKey === 'function') ? etDateKey(times[times.length - 1]) : null;
      try {
        console.info('[Chart] shade: %d bands (%d pre/%d post)', bands.length,
          bands.filter((b) => b.kind !== 'post').length,
          bands.filter((b) => b.kind === 'post').length);
      } catch {}
    } catch {}
  },

  /**
   * Initial auto S/R draw for modal-live (frozen-snapshot semantics).
   * PDH/PDL come from regular-session daily bars; PMH/PML (04:00-09:30 ET)
   * and ORBH/ORBL (09:30-09:45 ET) come from the seeded intraday candles.
   * Pairs whose window hasn't closed yet stay pending and finalize via
   * _modalLiveUpdatePendingAutoSR. Ephemeral: never touches /sr/levels.
   */
  async _modalLiveDrawAutoSR(gen) {
    const L = this._modalLive;
    if (!L || typeof computeLiveAutoSR !== 'function') return;
    try {
      const daily = await API.get('/data/history', { ticker: L.ticker, period: '5d', interval: '1d' });
      if (this._modalLive !== L || (gen !== undefined && L.gen !== gen)) return;
      L.autoSRDaily = (daily && daily.history) || [];
      this._modalLiveApplyAutoSR(L);
    } catch (err) {
      // Daily fetch failed: still draw PM/ORB from intraday, PD via fallback.
      if (this._modalLive !== L) return;
      L.autoSRDaily = null;
      try { this._modalLiveApplyAutoSR(L); } catch (e) {}
    }
  },

  _modalLiveApplyAutoSR(L) {
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
      this._modalLiveUpdateAutoSRToggle();
    } catch (e) {}
  },

  /**
   * Toggle auto S/R line visibility (eye button in the live canvas).
   * Session-scoped: hide is visual-only — developing pairs keep finalizing
   * silently so unhiding always shows current levels.
   */
  _modalLiveToggleAutoSR() {
    const L = this._modalLive;
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
    this._modalLiveUpdateAutoSRToggle();
  },

  /** Sync the eye button: hidden until levels exist (mirrors grid toggle). */
  _modalLiveUpdateAutoSRToggle() {
    const L = this._modalLive;
    const btn = this._element('mliveSRtoggle');
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
  _modalLiveUpdatePendingAutoSR() {
    const L = this._modalLive;
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
        this._modalLiveUpdateAutoSRToggle();
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

  _modalLiveClearAutoSR(L) {
    if (!L) return;
    try {
      if (L.candleSeries && L.autoSR && L.autoSR.length) removeLiveAutoSR(L.candleSeries, L.autoSR);
    } catch (e) {}
    L.autoSR = []; L.autoSRPending = null; L.autoSRDay = null; L.autoSRDaily = null; L.autoSRThrottle = 0; L.autoSRHidden = false; L.autoSRLevels = [];
  },

  async _modalLiveLoadHistory() {
    const L = this._modalLive;
    if (!L) return;
    const gen = ++L.gen;
    const loading = this._element('mliveLoading');
    const errBox = this._element('mliveError');
    if (loading) loading.classList.remove('hidden');
    if (errBox) errBox.classList.add('hidden');
    this._modalLiveSetBadge('LOADING');
    try {
      const tf = this._modalLiveTfDef(L.interval);
      // prepost=true: live surfaces show extended-hours candles (daily callers unaffected).
      const data = await API.get('/data/history', { ticker: L.ticker, period: tf.period, interval: tf.interval, prepost: 'true' });
      if (this._modalLive !== L || L.gen !== gen) return;
      const history = (data && data.history) || [];
      if (!history.length) throw new Error('No data available');
      const candles = history.map(d => ({
        time: Math.floor(new Date(d.date).getTime() / 1000),
        open: d.open, high: d.high, low: d.low, close: d.close, volume: d.volume || 0,
      })).filter(c => c.close > 0 && c.time);
      candles.sort((a, b) => (a.time > b.time ? 1 : -1));
      L.candles = candles;
      if (!L.chart) this._initModalLiveChart();
      if (!L.candleSeries) throw new Error('Chart unavailable');
      L.candleSeries.setData(candles.map(({ volume, ...c }) => c));
      const isDark = document.documentElement.dataset.theme === 'dark';
      const vc = isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)';
      L.volumeSeries.setData(candles.map(c => ({ time: c.time, value: c.volume || 0, color: vc })));
      this._modalLiveUpdateShades();
      this._modalLiveDrawAutoSR(gen);
      const last = candles[candles.length - 1];
      L.lastBucket = last ? last.time : null;
      L.lastDayVolume = 0;
      L.price = last ? last.close : null;
      // Badge basis = prior regular-session close (stable across bucket/timeframe
      // changes). Falls back to bucket-vs-bucket only if quotes are unavailable.
      let seeded = false;
      try {
        const q = await API.get('/data/quotes', { tickers: L.ticker });
        if (this._modalLive !== L) return;
        const quote = q && q.quotes && q.quotes.find((x) => x.ticker === L.ticker);
        if (quote && quote.price != null && quote.change_pct != null) {
          L.changePct = Number(quote.change_pct);
          L.changeAbs = this._modalLiveChangeAbs(quote.price, L.changePct);
          this._modalLiveUpdateHeader(L.changeAbs, L.changePct);
          seeded = true;
        }
      } catch {}
      if (!seeded) {
        if (candles.length >= 2) {
          const prev = candles[candles.length - 2];
          L.changeAbs = prev.close ? last.close - prev.close : 0;
          L.changePct = prev.close ? ((last.close - prev.close) / prev.close) * 100 : 0;
          this._modalLiveUpdateHeader(L.changeAbs, L.changePct);
        } else if (last) {
          L.changeAbs = 0;
          this._modalLiveUpdateHeader(0, 0);
        }
      }
      try { L.chart.timeScale().scrollToRealTime(); } catch {}
      if (loading) loading.classList.add('hidden');
    } catch (err) {
      if (this._modalLive !== L || L.gen !== gen) return;
      if (loading) loading.classList.add('hidden');
      const msg = this._element('mliveErrorMsg');
      if (msg) msg.textContent = (err && err.message) || 'Unable to load chart data';
      if (errBox) errBox.classList.remove('hidden');
      this._modalLiveSetBadge('ERROR');
    }
  },

  _modalLiveStartStream() {
    const L = this._modalLive;
    if (!L || L.eventSource) return;
    API.get('/stream/status', { ticker: L.ticker }).then(st => {
      if (!this._modalLive || this._modalLive !== L) return;
      const status = (st && st.status) || 'CLOSED';
      if (!st || st.is_open === false) {
        this._modalLiveSetBadge(status || 'CLOSED');
        return; // frozen history + badge, no socket
      }
      this._modalLiveSetBadge(status);
      try {
        const es = new EventSource('/api/stream/prices?tickers=' + encodeURIComponent(L.ticker) + '&sid=' + encodeURIComponent(L.sid || ''));
        L.eventSource = es;
        L.streamOpened = true;
        es.onmessage = (ev) => {
          try {
            const msg = JSON.parse(ev.data);
            if (msg.type === 'bye') { this._modalLivePause(true, 'max_age'); return; }
            if (msg.type === 'status') {
              if (msg.status) this._modalLiveSetBadge(msg.status);
              const seed = msg.ticks && msg.ticks[L.ticker];
              if (seed && seed.price) this._modalLiveApplyTick(seed);
              return;
            }
            if (msg.ticker && msg.ticker !== L.ticker) return;
            if (msg.price) this._modalLiveApplyTick(msg);
          } catch {}
        };
        es.onerror = () => { if (this._modalLive === L) this._modalLiveSetBadge('RETRY'); };
      } catch {
        this._modalLiveSetBadge('ERROR');
      }
      clearInterval(L.resyncTimer);
      L.resyncTimer = setInterval(() => {
        if (this._modalLive === L && !document.hidden && L.status !== 'PAUSED') this._modalLiveResync();
      }, this._MODAL_LIVE_RESYNC_MS);
    }).catch(() => { if (this._modalLive === L) this._modalLiveSetBadge('ERROR'); });
  },

  _modalLiveBucketFor(ts) {
    const tf = this._modalLiveTfDef(this._modalLive.interval);
    return Math.floor(ts / tf.bucket) * tf.bucket;
  },

  _modalLiveApplyTick(tick) {
    const L = this._modalLive;
    if (!L || !L.candleSeries || !L.candles.length) return;
    const price = Number(tick.price);
    if (!price || price <= 0) return;
    const ts = Number(tick.ts || Date.now() / 1000);
    // SSE tick carries dollar `change` + `change_pct`; derive abs if only pct present.
    let abs = tick.change != null && !isNaN(Number(tick.change)) ? Number(tick.change) : null;
    const pct = tick.change_pct != null && !isNaN(Number(tick.change_pct)) ? Number(tick.change_pct) : L.changePct;
    if (abs === null && pct !== null && pct !== undefined) abs = this._modalLiveChangeAbs(price, pct);
    this._modalLiveUpdateHeader(abs !== null ? abs : L.changeAbs, pct);
    if (tick.change_pct != null) L.changePct = Number(tick.change_pct);
    if (abs !== null) L.changeAbs = abs;
    L.price = price;
    const bucket = this._modalLiveBucketFor(ts);
    const last = L.candles[L.candles.length - 1];
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
          this._modalLiveUpdatePendingAutoSR();
        }
      } catch (e) {}
    } else {
      const candle = { time: bucket, open: price, high: price, low: price, close: price, volume: delta };
      L.candles.push(candle);
      if (L.candles.length > 2000) L.candles.splice(0, L.candles.length - 2000);
      L.lastBucket = bucket;
      // New ET day (e.g. pre-market open) needs fresh session bands.
      try {
        if (typeof etDateKey === 'function' && etDateKey(bucket) !== L.shadeDayKey) this._modalLiveUpdateShades();
      } catch {}
      try {
        L.candleSeries.update({ time: candle.time, open: candle.open, high: candle.high, low: candle.low, close: candle.close });
        if (L.volumeSeries) L.volumeSeries.update({ time: candle.time, value: candle.volume || 0 });
      } catch {}
      L.autoSRThrottle = Date.now();
      try { this._modalLiveUpdatePendingAutoSR(); } catch (e) {}
    }
  },

  async _modalLiveResync() {
    const L = this._modalLive;
    if (!L || !L.candleSeries) return;
    try {
      const tf = this._modalLiveTfDef(L.interval);
      const data = await API.get('/data/history', { ticker: L.ticker, period: tf.period, interval: tf.interval, prepost: 'true' });
      if (!this._modalLive || this._modalLive !== L) return;
      const history = (data && data.history) || [];
      if (!history.length) return;
      const fresh = history.map(d => ({
        time: Math.floor(new Date(d.date).getTime() / 1000),
        open: d.open, high: d.high, low: d.low, close: d.close, volume: d.volume || 0,
      })).filter(c => c.close > 0 && c.time);
      fresh.sort((a, b) => (a.time > b.time ? 1 : -1));
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
      this._modalLiveUpdateShades();
      this._modalLiveUpdatePendingAutoSR();
    } catch {}
  },

  _modalLiveSwitchInterval(id) {
    const L = this._modalLive;
    if (!L || L.interval === id || L.status === 'LOADING') return;
    if (!this._modalLiveTFS().some(t => t.id === id)) return;
    try { if (L.eventSource) L.eventSource.close(); } catch {}
    this._modalLiveSendUnsub(L, 'tf_switch');
    clearTimeout(L.idleTimer);
    clearInterval(L.resyncTimer);
    if (L.visHandler) document.removeEventListener('visibilitychange', L.visHandler);
    const host = this._element('modal-live-host');
    if (host && L.actHandler) {
      host.removeEventListener('pointerdown', L.actHandler);
      host.removeEventListener('wheel', L.actHandler);
    }
    if (L._resizeObserver) { try { L._resizeObserver.disconnect(); } catch {} }
    this._modalLiveClearAutoSR(L);
    if (L.chart) { try { L.chart.remove(); } catch {} }
    this._modalLive = { ticker: L.ticker, interval: id, chart: null, candleSeries: null, volumeSeries: null, container: null, eventSource: null, status: 'LOADING', gen: 0, candles: [], lastBucket: null, lastDayVolume: 0, idleTimer: null, resyncTimer: null, visHandler: null, actHandler: null, price: null, changeAbs: null, changePct: null, sid: this._modalLiveNewSid(), streamOpened: false, unsubSent: false, shade: null, shadeDayKey: null, autoSR: [], autoSRPending: null, autoSRDay: null, autoSRDaily: null, autoSRThrottle: 0, autoSRHidden: false, autoSRLevels: [] };
    try { localStorage.setItem('liveChart.interval', id); } catch {}
    this._renderModalLiveHost();
    const liveSession = this._modalLive;
    this._modalLiveLoadHistory().then(() => {
      if (this._modalLive === liveSession) this._modalLiveStartStream();
    });
    this._modalLiveArmIdle();
    this._modalLiveWatchVisibility();
  },

  _modalLivePause(showOverlay, reason = 'idle_pause') {
    const L = this._modalLive;
    if (!L) return;
    try { if (L.eventSource) L.eventSource.close(); } catch {}
    L.eventSource = null;
    clearInterval(L.resyncTimer); L.resyncTimer = null;
    this._modalLiveSetBadge('PAUSED');
    const ov = this._element('mliveResume');
    if (ov && showOverlay !== false) ov.classList.add('visible');
    this._modalLiveSendUnsub(L, reason);
  },

  _modalLiveResume() {
    const L = this._modalLive;
    if (!L) return;
    const ov = this._element('mliveResume');
    if (ov) ov.classList.remove('visible');
    this._modalLiveArmIdle();
    this._modalLiveResync().finally(() => {
      if (this._modalLive === L) this._modalLiveStartStream();
    });
  },

  _modalLiveArmIdle() {
    const L = this._modalLive;
    if (!L) return;
    clearTimeout(L.idleTimer);
    const host = this._element('modal-live-host');
    if (L.actHandler && host) {
      host.removeEventListener('pointerdown', L.actHandler);
      host.removeEventListener('wheel', L.actHandler);
    }
    L.actHandler = () => {
      if (!this._modalLive) return;
      clearTimeout(this._modalLive.idleTimer);
      this._modalLive.idleTimer = setTimeout(() => this._modalLivePause(true, 'idle_pause'), this._MODAL_LIVE_IDLE_MS);
    };
    if (host && L.actHandler) {
      host.addEventListener('pointerdown', L.actHandler);
      host.addEventListener('wheel', L.actHandler, { passive: true });
    }
    L.idleTimer = setTimeout(() => this._modalLivePause(true, 'idle_pause'), this._MODAL_LIVE_IDLE_MS);
  },

  _modalLiveWatchVisibility() {
    const L = this._modalLive;
    if (!L) return;
    if (L.visHandler) document.removeEventListener('visibilitychange', L.visHandler);
    L.visHandler = () => {
      if (!this._modalLive) return;
      if (document.hidden) {
        this._modalLivePause(false, 'visibility_hidden');
      } else if (this._modalLive.status === 'PAUSED' && !this._element('mliveResume')?.classList.contains('visible')) {
        this._modalLiveResume();
      }
    };
    document.addEventListener('visibilitychange', L.visHandler);
  },

  /**
   * Exit modal-live. With restore=true (default) the daily chart is rebuilt
   * via _renderChartModal. Returns true if a stream was active.
   */
  _exitModalLive(restore = true, reason = 'toggle_off') {
    const L = this._modalLive;
    if (!L) return false;
    try { if (L.eventSource) L.eventSource.close(); } catch {}
    clearTimeout(L.idleTimer);
    clearInterval(L.resyncTimer);
    if (L.visHandler) { try { document.removeEventListener('visibilitychange', L.visHandler); } catch {} }
    if (L._resizeObserver) { try { L._resizeObserver.disconnect(); } catch {} }
    this._modalLiveClearAutoSR(L);
    if (L.chart) { try { L.chart.remove(); } catch {} }
    this._modalLiveSendUnsub(L, reason);
    const host = this._element('modal-live-host');
    if (host) host.remove();
    const canvas = this._element('chart-canvas');
    if (canvas) canvas.style.display = '';
    const liveBtn = this._element('live-15m-toggle');
    if (liveBtn) liveBtn.classList.remove('active');
    const ticker = L.ticker;
    this._modalLive = null;
    if (restore && ticker) this._renderChartModal(ticker);
    return true;
  },

  /**
   * Render chart with 15-minute intraday candles for the current trading day.
   * Destroys existing LightweightCharts instance and recreates with intraday data.
   * @param {string} ticker
   */
  _observeChartSize(chart, container) {
    const resize = () => {
      if (container.clientWidth > 0 && container.clientHeight > 0) {
        chart.applyOptions({ width: container.clientWidth, height: container.clientHeight });
      }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    resize();
    return () => observer.disconnect();
  },

  // ─── PERCENTAGE MOVE LINE ────────────────────────────

  /**
   * Toggle the Percentage Move primitive on/off.
   * When enabled, attaches a diagonal line from a slope-change pivot to today's
   * candle with a % change label.
   */
  _togglePctMove() {
    // %Move overlays the daily chart: restore it first, user re-taps to enable.
    if (this._modalLive) { this._exitModalLive(true, 'mode_switch'); return; }
    // If widget mode is active, destroy widget and restore candlestick first
    if (this._tvWidgetMode) {
      this._destroyTvWidget();
      this._renderChartModal(this._currentChartTicker);
      // P/L mode will be applied on next toggle
      return;
    }

    this._pctMoveEnabled = !this._pctMoveEnabled;
    const btn = this._element('pct-move-toggle');
    if (btn) btn.classList.toggle('active', this._pctMoveEnabled);

    if (this._pctMoveEnabled) {
      this._attachPctMove();
    } else {
      this._detachPctMove();
    }
  },

  _togglePositionPnlChart() {
    this._cancelTrailingEditor();
    this._trailingLine = null;
    if (this._chartStandalone) return;
    // Modal-live is mutually exclusive: leave it (P&L builds its own view).
    if (this._modalLive) this._exitModalLive(false, 'mode_pnl');
    // If widget mode is active, destroy widget first
    if (this._tvWidgetMode) {
      this._destroyTvWidget();
    }

    if (this._positionPnlMode) {
      // Switch back to Price view
      // Clean up P/L mouse leave handler
      const canvas = this._element('chart-canvas');
      if (canvas && this._pnlMouseLeaveHandler) {
        canvas.removeEventListener('mouseleave', this._pnlMouseLeaveHandler);
        this._pnlMouseLeaveHandler = null;
      }
      this._positionPnlMode = false;
      const pnlBtn = this._element('pnl-chart-toggle');
      if (pnlBtn) pnlBtn.classList.remove('active');
      this._renderChartModal(this._currentChartTicker);
    } else {
      // Switch to P/L view
      this._positionPnlMode = true;
      const pnlBtn = this._element('pnl-chart-toggle');
      if (pnlBtn) pnlBtn.classList.add('active');
      this._renderPositionPnlChart(this._currentChartTicker);
    }
  },

  /**
   * Destroy the TradingView widget iframe and reset widget state.
   */
  _destroyTvWidget() {
    const container = this._element('tv-widget-container');
    if (container) container.remove();
    this._tvWidgetMode = false;
    const btn = this._element('tv-widget-toggle');
    if (btn) btn.classList.remove('active');
  },

  /**
   * Convert a ticker symbol from Yahoo Finance format to TradingView format.
   * - Exchange suffixes (.TO, .L, etc.) become prefixes (TSX:, LSE:, etc.)
   * - Hyphens in class shares become dots (BRK-B → BRK.B)
   * - US stocks without exchange suffix get NASDAQ: prefix
   * @param {string} ticker - Yahoo Finance format ticker (e.g. "BRK-B", "RY.TO")
   * @returns {string} TradingView format symbol (e.g. "NYSE:BRK.B", "TSX:RY")
   */
  _convertTickerForTradingView(ticker) {
    if (!ticker) return ticker;

    // Exchange suffix → TradingView prefix mapping
    const exchangeMap = {
      '.TO': 'TSX:',
      '.L': 'LSE:',
      '.V': 'TSXV:',
      '.HK': 'HKEX:',
      '.T': 'TSE:',
      '.AX': 'ASX:',
      '.SA': 'B3:',
      '.DE': 'XETRA:',
      '.MI': 'MILAN:',
      '.PA': 'EURONEXT:',
      '.SW': 'SWISS:',
      '.NSE': 'NSE:',
      '.BO': 'BSE:',
    };

    // Check for exchange suffix (longest match first)
    const sortedSuffixes = Object.keys(exchangeMap).sort((a, b) => b.length - a.length);
    for (const suffix of sortedSuffixes) {
      if (ticker.endsWith(suffix)) {
        return exchangeMap[suffix] + ticker.slice(0, -suffix.length);
      }
    }

    // US stocks: convert hyphens to dots (BRK-B → BRK.B)
    if (ticker.includes('-')) {
      return ticker.replace(/-/g, '.');
    }

    // Return ticker as-is — TradingView auto-resolves to correct exchange
    return ticker;
  },

  /**
   * Toggle between TradingView widget view and LightweightCharts candlestick view.
   */
  _toggleTvWidget() {
    this._cancelTrailingEditor();
    this._trailingLine = null;
    // Modal-live is mutually exclusive: leave it (no daily restore — TV builds its own view).
    if (this._modalLive) this._exitModalLive(false, 'mode_tv');
    if (this._tvWidgetMode) {
      // Switch back to candlestick view
      this._destroyTvWidget();
      this._renderChartModal(this._currentChartTicker);
    } else {
      // Switch to TradingView widget view
      this._positionPnlMode = false;
      this._element('pnl-chart-toggle').classList.remove('active');
      this._tvWidgetMode = true;
      const btn = this._element('tv-widget-toggle');
      if (btn) btn.classList.add('active');
      this._renderTvWidget(this._currentChartTicker);
    }
  },

  /**
   * Render a TradingView Advanced Chart widget in the chart modal canvas.
   * Destroys any existing LightweightCharts instance first.
   * @param {string} ticker
   */
  async _renderTvWidget(ticker) {
    const openVersion = this._chartOpenVersion;
    const renderVersion = ++this._chartRenderVersion;
    const canvas = this._element('chart-canvas');
    if (!canvas) return;
    this._clearPatternOverlay();
    this._setPatternControlsVisible(false);
    this._setVpControlsVisible(false);
    this._disposeChart();

    // Reset all chart-modal state (same as _renderChartModal)
    this._drawMode = null;
    this._drawTicker = null;
    this._srLines = [];
    this._priceLines = [];
    this._avgPriceLine = null;
    this._avgPrice = null;
    this._avgEdgeIndicator = null;
    this._avgTimeScaleSubscription = null;
    this._updateDrawModeUI(false);

    // Hide S/R legend (TradingView has its own)
    const srLegend = this._host.querySelector('.chart-legend-panel');
    if (srLegend) srLegend.style.display = 'none';
    const modalBody = this._host.querySelector('.chart-modal-body');
    if (modalBody) modalBody.classList.add('legend-hidden');

    // Hide avg badge
    const avgBadge = this._element('chart-avg-badge');
    if (avgBadge) avgBadge.style.display = 'none';

    // chart.remove() below destroys the attached volume profile with it.
    // Keep the flag so switching back re-attaches automatically.
    this._vpPrimitive = null;
    this._vpPriceLines = [];

    // TradingView shows its own scale — hide the daily pill.
    this._setModalPriceVisible(false);

    // Clear canvas
    canvas.innerHTML = '';

    // Create widget container
    const widgetDiv = document.createElement('div');
    widgetDiv.id = 'tv-widget-container';
    widgetDiv.style.width = '100%';
    widgetDiv.style.height = '100%';
    canvas.appendChild(widgetDiv);

    // Load TradingView widget script if not loaded
    if (!this._tvWidgetScriptLoaded) {
      try {
        await new Promise((resolve, reject) => {
          if (typeof TradingView !== 'undefined' && TradingView.widget) {
            this._tvWidgetScriptLoaded = true;
            resolve();
            return;
          }
          const script = document.createElement('script');
          script.src = 'https://s3.tradingview.com/tv.js';
          script.onload = () => {
            this._tvWidgetScriptLoaded = true;
            resolve();
          };
          script.onerror = () => reject(new Error('Failed to load TradingView widget'));
          document.head.appendChild(script);
        });
      } catch (error) {
        if (openVersion === this._chartOpenVersion && renderVersion === this._chartRenderVersion) {
          widgetDiv.textContent = 'Unable to load TradingView. Select TradingView again to return to the chart.';
        }
        return;
      }
    }

    if (openVersion !== this._chartOpenVersion || renderVersion !== this._chartRenderVersion
        || this._element('tv-widget-container') !== widgetDiv) return;

    // Determine theme
    const isDark = document.documentElement.dataset.theme === 'dark';

    // Initialize TradingView widget
    /* global TradingView */
    new TradingView.widget({
      container_id: 'tv-widget-container',
      symbol: this._convertTickerForTradingView(ticker),
      theme: isDark ? 'dark' : 'light',
      style: '1',
      autosize: true,
      timezone: 'America/New_York',
      locale: 'en',

      // Toolbars
      hide_top_toolbar: false,
      hide_side_toolbar: true,
      allow_symbol_change: true,
      save_image: false,

      // UI
      details: true,
      hide_legend: false,
      hide_volume: false,
      withdateranges: true,

    });
  },

  async _renderPositionPnlChart(ticker) {
    if (this._chartStandalone) return;
    const openVersion = this._chartOpenVersion;
    const renderVersion = ++this._chartRenderVersion;
    const portfolioId = this._chartPortfolioId;
    const current = () => openVersion === this._chartOpenVersion && renderVersion === this._chartRenderVersion
      && this._currentChartTicker === ticker && this._chartPortfolioId === portfolioId;
    const canvas = this._element('chart-canvas');
    if (!canvas) return;
    this._clearPatternOverlay();
    this._setPatternControlsVisible(false);
    this._setVpControlsVisible(false);

    this._disposeChart();

    canvas.innerHTML = '';

    // Reset chart-modal state (same as _renderChartModal)
    this._drawMode = null;
    this._drawTicker = null;
    this._srLines = [];
    this._priceLines = [];
    this._avgPriceLine = null;
    this._avgPrice = null;
    this._avgEdgeIndicator = null;
    this._avgTimeScaleSubscription = null;
    this._updateDrawModeUI(false);

    // Hide S/R legend in P/L mode
    const srLegend = this._host.querySelector('.chart-legend-panel');
    if (srLegend) srLegend.style.display = 'none';
    const modalBody = this._host.querySelector('.chart-modal-body');
    if (modalBody) modalBody.classList.add('legend-hidden');

    // Hide avg badge
    const avgBadge = this._element('chart-avg-badge');
    if (avgBadge) avgBadge.style.display = 'none';

    // chart.remove() below destroys the attached volume profile with it.
    // Keep the flag so switching back re-attaches automatically.
    this._vpPrimitive = null;
    this._vpPriceLines = [];

    // P&L shows its own values — hide the daily close pill.
    this._setModalPriceVisible(false);

    // Ensure LightweightCharts is loaded
    await this._ensureLightCharts();
    if (!current()) return;
    if (typeof LightweightCharts === 'undefined') {
      canvas.innerHTML = '<p style="color:var(--color-text-tertiary);font-size:13px;text-align:center;padding:40px;">Chart library not available.</p>';
      return;
    }

    // Show loading state
    canvas.innerHTML = '<p style="color:var(--color-text-tertiary);font-size:13px;text-align:center;padding:40px;">Loading P/L data...</p>';

    // Fetch position P/L history
    if (!this._chartPortfolioId || !ticker) {
      canvas.innerHTML = '<p style="color:var(--color-text-tertiary);font-size:13px;text-align:center;padding:40px;">No position data available.</p>';
      return;
    }

    let data;
    try {
      data = await API.get(`/portfolio/${portfolioId}/position-pnl-history/${encodeURIComponent(ticker)}`);
      if (!current()) return;
    } catch (err) {
      if (!current()) return;
      console.warn('[Chart] Failed to load position P/L history:', err.message);
      canvas.innerHTML = '<p style="color:var(--color-text-tertiary);font-size:13px;text-align:center;padding:40px;">Unable to load P/L history.</p>';
      return;
    }

    const snapshots = data.snapshots || [];
    if (snapshots.length === 0) {
      canvas.innerHTML = '<p style="color:var(--color-text-tertiary);font-size:13px;text-align:center;padding:40px;">No P/L history yet. Data will appear after a few days of tracking.</p>';
      return;
    }

    // Clear loading text
    canvas.innerHTML = '';

    const isDark = document.documentElement.dataset.theme === 'dark';
    const { bgColor, textColor, gridColor } = chartThemeColors();

    const chartHeight = canvas.clientHeight || 460;

    const chart = LightweightCharts.createChart(canvas, {
      width: canvas.clientWidth || 800,
      height: chartHeight,
      layout: {
        background: { type: 'solid', color: bgColor },
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
      timeScale: {
        borderColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)',
        timeVisible: false,
        rightOffset: 2,
      },
      rightPriceScale: {
        borderColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)',
      },
      handleScroll: { vertTouchDrag: true },
    });

    this._chartInstance = chart;

    this._chartResizeHandler = this._observeChartSize(chart, canvas);

    // Determine line color based on latest P/L
    const latestPct = snapshots[snapshots.length - 1].pct;
    const lineColor = latestPct >= 0 ? (isDark ? '#34C77B' : '#0E7A3D') : (isDark ? '#F25555' : '#C81E1E');

    // Add line series for P/L percentage
    const lineSeries = chart.addSeries(LightweightCharts.LineSeries, {
      color: lineColor,
      lineWidth: 2,
      priceFormat: { type: 'custom', formatter: (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%` },
      lastValueVisible: true,
      priceLineVisible: false,
    });

    lineSeries.applyOptions({
      lastValueVisible: true,
      priceLineVisible: false,
    });

    // Convert data to chart format
    const chartData = snapshots.map(s => ({
      time: s.date,
      value: s.pct,
    }));

    lineSeries.setData(chartData);
    chart.timeScale().fitContent();

    // Custom tooltip via crosshair move
    chart.subscribeCrosshairMove((param) => {
      const tooltip = canvas.querySelector('#position-pnl-tooltip') || this._createPnlTooltip();
      const dateEl = tooltip.querySelector('.pnl-tooltip-date');
      const valueEl = tooltip.querySelector('.pnl-tooltip-value');

      if (!param || !param.time || !param.point ||
          param.point.x < 0 || param.point.y < 0 ||
          param.point.x > canvas.clientWidth || param.point.y > canvas.clientHeight) {
        tooltip.style.display = 'none';
        return;
      }
      if (!param.seriesData) {
        tooltip.style.display = 'none';
        return;
      }

      const snapshot = snapshots.find(s => s.date === param.time);
      if (!snapshot) {
        tooltip.style.display = 'none';
        return;
      }

      dateEl.textContent = formatChartDateDDMONYY(snapshot.date);

      const pctSign = snapshot.pct >= 0 ? '+' : '';
      const dollarSign = snapshot.pnl >= 0 ? '+$' : '-$';
      const dollar = Math.abs(snapshot.pnl).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      valueEl.textContent = `${pctSign}${snapshot.pct.toFixed(2)}% (${dollarSign}${dollar})`;
      valueEl.className = 'pnl-tooltip-value ' + (snapshot.pnl >= 0 ? 'up' : 'down');

      // Floating tooltip: anchor to datapoint via series.priceToCoordinate
      const rect = canvas.getBoundingClientRect();
      const seriesData = param.seriesData.get(lineSeries);
      if (!seriesData) { tooltip.style.display = 'none'; return; }

      tooltip.style.display = 'block';
      const coordinate = (seriesData.value != null) ? lineSeries.priceToCoordinate(seriesData.value) : null;
      if (coordinate === null || coordinate === undefined) { tooltip.style.display = 'none'; return; }
      const tooltipW = tooltip.offsetWidth || 150;
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
    this._pnlMouseLeaveHandler = () => {
      const tooltip = this._element('chart-canvas')?.querySelector('#position-pnl-tooltip');
      if (tooltip) tooltip.style.display = 'none';
    };
    canvas.addEventListener('mouseleave', this._pnlMouseLeaveHandler);
  },

  _createPnlTooltip() {
    const container = this._element('chart-canvas');
    let tooltip = container.querySelector('#position-pnl-tooltip');
    if (tooltip) return tooltip;

    tooltip = document.createElement('div');
    tooltip.id = 'position-pnl-tooltip';
    tooltip.className = 'pnl-tooltip';
    tooltip.setAttribute('role', 'tooltip');
    tooltip.style.display = 'none';
    tooltip.innerHTML = '<div class="pnl-tooltip-date"></div><div class="pnl-tooltip-value"></div>';
    container.style.position = 'relative';
    container.appendChild(tooltip);
    return tooltip;
  },

  /**
   * Attach the PctMovePrimitive to the candlestick series.
   * Uses slope-change detection to find a direction-reversal pivot in the
   * cached candle data, then draws diagonal lines from pivot(s) to today
   * with % change labels. Optionally draws a second line extending further
   * back to a second pivot. No-ops if no valid pivot found.
   */
  _attachPctMove() {
    this._detachPctMove();
    if (!this._candleSeries || !this._candleDataCache) return;
    if (this._candleDataCache.length < 15) return;

    const realCandles = this._candleDataCache.filter(c =>
      !(c.open === c.high && c.high === c.low && c.low === c.close)
    );
    const result = findPivotBySlopeChange(realCandles);
    if (!result) return;

    const isDark = document.documentElement.dataset.theme === 'dark';
    this._pctMovePrimitive = new PctMovePrimitive({
      today: result.today,
      pivots: result.pivots,
      isDark,
    });
    this._candleSeries.attachPrimitive(this._pctMovePrimitive);
  },

  /**
   * Detach the PctMovePrimitive from the candlestick series.
   */
  _detachPctMove() {
    if (this._pctMovePrimitive && this._candleSeries) {
      try { this._candleSeries.detachPrimitive(this._pctMovePrimitive); } catch {}
      this._pctMovePrimitive = null;
    }
  },

  // ─── VOLUME PROFILE (opt-in, desktop-only, 3M default + anchor) ───────

  /** VP is desktop-only, matching the app's 767px mobile breakpoint. */
  _isVpDesktop() {
    try {
      return !!(window.matchMedia && !window.matchMedia('(max-width: 767px)').matches);
    } catch { return true; }
  },

  /**
   * Resolve the profile palette from UI theme tokens so the histogram uses
   * existing neutrals (text-primary) with the warning accent for POC — no
   * hardcoded hues. Falls back to theme-matched constants when tokens are
   * unavailable (e.g. unit-test context).
   */
  _vpPalette() {
    const css = (name, fallback) => {
      try {
        const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
        return v || fallback;
      } catch { return fallback; }
    };
    const withAlpha = (hex, alpha) => {
      const m = /^#([0-9a-fA-F]{6})$/.exec(hex || '');
      if (!m) return hex;
      const n = parseInt(m[1], 16);
      return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
    };
    const ink = css('--color-text-primary', '#111111');
    return {
      base: withAlpha(ink, 0.30),
      valueArea: withAlpha(ink, 0.52),
      poc: css('--color-warning', '#8A6D00'),
      startLine: withAlpha(ink, 0.45),
      vah: css('--color-text-tertiary', '#8E8E8E'),
      val: css('--color-text-tertiary', '#8E8E8E'),
    };
  },

  /** Synchronize the canonical VP toggle with the chart state. */
  _syncVpButtons() {
    this._host.querySelectorAll('.chart-tool-btn.vp').forEach((btn) => {
      btn.classList.toggle('active', !!this._vpEnabled);
      btn.setAttribute('aria-pressed', String(!!this._vpEnabled));
    });
  },

  /** Return API candles only, excluding future earnings placeholders by index. */
  _vpRealCandles() {
    if (!Array.isArray(this._candleDataCache)) return [];
    const count = Math.min(this._realCandleCount || this._candleDataCache.length, this._candleDataCache.length);
    return this._candleDataCache.slice(0, count).filter(c => /^\d{4}-\d{2}-\d{2}$/.test(c.time));
  },

  /** Resolve the fixed calculation window independently from chart zoom. */
  _vpSelection() {
    const all = this._vpRealCandles();
    if (typeof selectVolumeProfileCandles !== 'function') return null;
    const selected = selectVolumeProfileCandles(all, {
      period: this._vpRange,
      anchorTime: this._vpAnchorTime,
    });
    return selected ? { all, ...selected } : null;
  },

  _formatVpDate(value) {
    try {
      return new Date(value + 'T00:00:00Z').toLocaleDateString(undefined, {
        month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
      });
    } catch { return value; }
  },

  /** Keep preset, anchor, and provenance label states synchronized. */
  _syncVpControls(selection = null, message = '') {
    const controls = this._element('vp-control-row');
    if (!controls) return;
    controls.querySelectorAll('[data-vp-range]').forEach((btn) => {
      const active = !this._vpAnchorTime && btn.dataset.vpRange === this._vpRange;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
    });
    const anchorBtn = this._element('vp-anchor-btn');
    if (anchorBtn) {
      // Anchoring only applies with the overlay on; the row otherwise acts
      // as a plain chart-range control.
      anchorBtn.style.display = this._vpEnabled ? '' : 'none';
      anchorBtn.classList.toggle('active', !!this._vpAnchorTime || this._vpAnchorMode);
      anchorBtn.classList.toggle('selecting', this._vpAnchorMode);
      anchorBtn.setAttribute('aria-pressed', String(!!this._vpAnchorTime || this._vpAnchorMode));
      anchorBtn.textContent = this._vpAnchorMode ? 'Click candle…' : (this._vpAnchorTime ? 'Anchored' : 'Anchor');
    }
    const label = this._element('vp-context');
    if (!label) return;
    if (message) { label.textContent = message; return; }
    if (!this._vpEnabled) {
      const rangeOnly = this._vpSelection();
      label.textContent = rangeOnly
        ? `${this._vpRange.toUpperCase()} · ${this._formatVpDate(rangeOnly.startTime)}–${this._formatVpDate(rangeOnly.endTime)} · ${rangeOnly.candles.length} sessions · VP off`
        : `VP off · ${this._vpRange.toUpperCase()} selected`;
      return;
    }
    const current = selection || this._vpSelection();
    if (!current) {
      label.textContent = 'VP · Waiting for daily data';
      return;
    }
    const scope = current.anchored
      ? `Since ${this._formatVpDate(current.startTime)}`
      : this._vpRange.toUpperCase();
    const fragile = this._vpSensitive ? ' · row-sensitive' : '';
    label.textContent = `VP · ${scope} · ${this._formatVpDate(current.startTime)}–${this._formatVpDate(current.endTime)} · ${current.candles.length} sessions · Daily estimate${fragile}`;
  },

  _setVpControlsVisible(visible) {
    const controls = this._element('vp-control-row');
    if (controls) controls.hidden = !visible || !this._isVpDesktop();
  },

  _setVpRange(range) {
    if (!['1w', '1m', '3m', '6m', '1y'].includes(range)) return;
    this._vpRange = range;
    this._vpAnchorTime = null;
    this._cancelVpAnchorMode();
    try { localStorage.setItem('chart-vp-range', range); } catch {}
    if (this._vpEnabled) this._attachVP(true);
    else this._fitVpRangeOnly();
  },

  /** Fit the chart to the selected preset without computing a profile. */
  _fitVpRangeOnly() {
    this._vpSensitive = false;
    const selection = this._vpSelection();
    if (selection) this._fitVpSelection(selection);
    else if (this._chartInstance) {
      try { this._chartInstance.timeScale().fitContent(); } catch {}
    }
    this._syncVpControls(selection);
  },

  _toggleVpAnchorMode() {
    if (!this._vpEnabled) return;
    if (!this._candleSeries || !this._vpRealCandles().length) return;
    this._cancelTrailingEditor();
    this._vpAnchorMode = !this._vpAnchorMode;
    if (this._vpAnchorMode) {
      this._drawMode = null;
      this._drawTicker = null;
      this._updateDrawModeUI(false);
    }
    const canvas = this._element('chart-canvas');
    if (canvas) canvas.style.cursor = this._vpAnchorMode ? 'crosshair' : '';
    this._syncVpControls();
  },

  _cancelVpAnchorMode() {
    if (!this._vpAnchorMode) return;
    this._vpAnchorMode = false;
    const canvas = this._element('chart-canvas');
    if (canvas && !this._drawMode) canvas.style.cursor = '';
    this._syncVpControls();
  },

  _setVpAnchor(time) {
    const key = typeof time === 'string' ? time : (time && time.year
      ? `${time.year}-${String(time.month).padStart(2, '0')}-${String(time.day).padStart(2, '0')}` : '');
    const all = this._vpRealCandles();
    const index = all.findIndex(c => c.time === key);
    if (index < 0) {
      this._syncVpControls(null, 'Choose a real daily candle inside the chart history');
      return;
    }
    this._vpAnchorTime = all[index].time;
    this._vpAnchorMode = false;
    const canvas = this._element('chart-canvas');
    if (canvas) canvas.style.cursor = '';
    this._attachVP(true);
  },

  _fitVpSelection(selection) {
    if (!selection || !this._chartInstance) return;
    const count = selection.candles.length;
    const rightBars = Math.max(8, Math.min(55, Math.ceil(count * 0.22)));
    try {
      this._chartInstance.timeScale().setVisibleLogicalRange({
        from: Math.max(-2, selection.startIndex - 1),
        to: selection.all.length - 1 + rightBars,
      });
    } catch {}
  },

  /** Attach the selected profile and its POC/VAH/VAL price lines. */
  _attachVP(fitRange = false) {
    this._detachVP();
    if (!this._isVpDesktop()) return;
    if (!this._candleSeries || !this._lastRealTime) return;
    if (typeof computeVolumeProfile !== 'function' || typeof VolumeProfilePrimitive === 'undefined') return;
    const selection = this._vpSelection();
    if (!selection) { this._syncVpControls(); return; }
    const profile = computeVolumeProfile(selection.candles, { rows: 30, valueAreaPct: 0.7 });
    if (!profile) return;
    this._vpSensitive = !!(profile.sensitivity && !profile.sensitivity.stable);

    const isDark = document.documentElement.dataset.theme === 'dark';
    const palette = this._vpPalette();
    try {
      this._vpPrimitive = new VolumeProfilePrimitive({
        profile,
        startTime: selection.startTime,
        showStartLine: selection.anchored,
        isDark,
        colors: { base: palette.base, valueArea: palette.valueArea, poc: palette.poc, startLine: palette.startLine },
      });
      this._candleSeries.attachPrimitive(this._vpPrimitive);
    } catch (err) {
      this._vpPrimitive = null;
      return;
    }

    try {
      const mk = (price, color, style, title) => this._candleSeries.createPriceLine({
        price, color, lineWidth: 1, lineStyle: style,
        axisLabelVisible: true, title,
      });
      this._vpPriceLines = [
        mk(profile.pocPrice, palette.poc, LightweightCharts.LineStyle.Solid, 'POC'),
        mk(profile.vah, palette.vah, LightweightCharts.LineStyle.Dashed, 'VAH'),
        mk(profile.val, palette.val, LightweightCharts.LineStyle.Dashed, 'VAL'),
      ];
    } catch (err) {
      this._removeVpPriceLines();
    }
    if (fitRange) this._fitVpSelection(selection);
    this._syncVpControls(selection);
    this._syncVpButtons();
  },

  /**
   * Detach the volume profile primitive and remove its price lines.
   */
  _detachVP() {
    this._removeVpPriceLines();
    if (this._vpPrimitive && this._candleSeries) {
      try { this._candleSeries.detachPrimitive(this._vpPrimitive); } catch {}
    }
    this._vpPrimitive = null;
  },

  /**
   * Remove tracked POC/VAH/VAL price lines from the candlestick series.
   */
  _removeVpPriceLines() {
    if (this._vpPriceLines && this._vpPriceLines.length && this._candleSeries) {
      for (const pl of this._vpPriceLines) {
        try { this._candleSeries.removePriceLine(pl); } catch {}
      }
    }
    this._vpPriceLines = [];
  },

  /**
   * Toggle the volume profile on/off.
   * When another modal mode owns the canvas, restores the daily chart
   * first (user re-taps to toggle), mirroring _togglePctMove.
   */
  _toggleVP() {
    if (this._modalLive) { this._exitModalLive(true, 'mode_switch'); return; }
    if (this._tvWidgetMode) {
      this._destroyTvWidget();
      this._renderChartModal(this._currentChartTicker);
      return;
    }
    if (this._positionPnlMode) {
      this._togglePositionPnlChart();
      return;
    }

    this._vpEnabled = !this._vpEnabled;
    if (!this._vpEnabled) this._cancelVpAnchorMode();
    try { localStorage.setItem('chart-vp-enabled', this._vpEnabled ? '1' : '0'); } catch {}
    this._syncVpButtons();
    if (this._vpEnabled) this._attachVP(true);
    else { this._detachVP(); this._syncVpControls(); }
  },

};

export default ChartRenderer;
