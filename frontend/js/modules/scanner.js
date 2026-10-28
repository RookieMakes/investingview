/**
 * Scanner — 2-Column Ranking Board screen module.
 *
 * Fetches momentum and reversal scan results, displays them in a
 * JIRA-style dual-column ranking board with trend data.
 *
 * API endpoints consumed:
 *   GET /api/scanner/momentum?force=true  — run momentum scan
 *   GET /api/scanner/reversal?force=true  — run reversal scan
 *   GET /api/scanner/ranking?type=momentum — get momentum rankings
 *   GET /api/scanner/ranking?type=reversal — get reversal rankings
 *   GET /api/universe                      — get universe count
 *
 * @example
 *   // Called by App.loadScreen('scanner')
 *   Scanner.init();
 */

import TickerMetadata from '../ticker-metadata.js';
import ChartModal from '../components/chart-modal.js';
import { QUALITY_MODEL, renderQualityTable, renderQualityStatus, toggleQualityDetails } from './quality-score-view.js';

const Scanner = {
  /** @type {Array<Object>} Current momentum rankings (qualified, score >= 3) */
  momentumRankings: [],

  /** @type {Array<Object>} Momentum below-threshold rows (grey, score < 3) */
  momentumBelow: [],

  /** @type {Array<Object>} Current reversal rankings (qualified, score >= 3) */
  reversalRankings: [],

  /** @type {Array<Object>} Reversal below-threshold rows (grey, score < 3) */
  reversalBelow: [],

  /** @type {Array<Object>} Current 200 SMA proximity rankings */
  sma200Rankings: [],

  /** @type {Array<Object>} Current YTD rankings */
  ytdRankings: [],

  /** @type {Array<Object>} Current Quality Score rankings */
  qualityScoreRankings: [],
  qualityScoreMeta: null,
  qualityScoreError: null,

  /** @type {Array<Object>} Current earnings today data */
  earningsTodayData: [],

  /** @type {Array<Object>} Current upcoming earnings data */
  earningsWeekData: [],

  /** @type {Array<Object>} Current Swing VAH touches */
  swingVahData: [],

  /** @type {Array<Object>} Current Swing VAL touches */
  swingValData: [],

  /** @type {Object|null} Swing board meta (session_date, counts) */
  swingMeta: null,

  /** @type {Object} Client-side Swing filters per table — never sent to the API */
  swingFilter: {
    vah: { range: 'ALL', signal: 'ALL' },
    val: { range: 'ALL', signal: 'ALL' },
  },

  /** @type {Object} Mobile disclosure state per Swing filter bar */
  _swingFiltersOpen: { vah: false, val: false },

  /** @type {Array<Object>} Current Trade ORB long breakouts */
  tradeLongData: [],

  /** @type {Array<Object>} Current Trade ORB short breakdowns */
  tradeShortData: [],

  /** @type {Object|null} Trade board meta (session_date, counts) */
  tradeMeta: null,

  etfHoldings: [],
  etfHoldingsMeta: null,
  _etfHistoryChartInstance: null,
  _etfHistorySnapshots: null,
  _etfHistoryTicker: null,
  _etfHistoryRequestId: 0,
  _etfRefreshTimer: null,

  /** @type {Object} Client-side Trade status filter per table — never sent to the API */
  tradeFilter: {
    long: { status: 'ALL' },
    short: { status: 'ALL' },
  },

  /** @type {Object} Mobile disclosure state per Trade filter bar */
  _tradeFiltersOpen: { long: false, short: false },

  /** @type {number} Universe size (total tickers scanned) */
  universeSize: 0,

  /** @type {boolean} Whether a scan is in progress */
  loading: false,

  /** @type {string|null} ISO timestamp of last scan completion (EST) */
  lastScanCompletedAt: null,

  /** @type {string} localStorage key for cached rankings */
  _cacheKey: 'scanner_ranking_cache',

  /** Current ET date for clearing the Trade board at the next day. */
  _tradeDate: null,
  _tradeDayTimer: null,

  _todayET() {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date());
    const value = (type) => parts.find((p) => p.type === type).value;
    return `${value('year')}-${value('month')}-${value('day')}`;
  },

  /** @type {AbortController|null} For cancelling in-flight requests */
  _controller: null,

  /** @type {object|null} LightweightCharts instance for YTD history modal */
  _ytdHistoryChartInstance: null,

  /** @type {object|null} LightweightCharts line series for YTD history modal */
  _ytdHistoryLineSeries: null,

  /** @type {object|null} LightweightCharts instance for Quality Score history modal */
  _qsHistoryChartInstance: null,

  /** @type {object|null} LightweightCharts line series for Quality Score history modal */
  _qsHistoryLineSeries: null,

  /** @type {Array|null} Quality Score history snapshots for crosshair tooltip */
  _qsHistorySnapshots: null,

  /** @type {string|null} Ticker for the open Quality Score history modal */
  _qsHistoryTicker: null,

  /** @type {MutationObserver|null} Observer for data-theme attribute changes */
  _themeObserver: null,

  /**
   * Minimum scan score required for a ticker to be ranked.
   * Must match backend MIN_DISPLAY_SCORE in services/rankings.py.
   * Tickers below this threshold are shown as grey unranked rows pinned
   * at the bottom of the board (below_threshold flag from the API).
   * @type {number}
   */
  _MIN_DISPLAY_SCORE: 3,

  /**
   * Split a ranking payload into qualified rows and grey below-threshold rows.
   * Prefers the backend `below_threshold` flag, falling back to the score
   * threshold for stale caches / legacy responses.
   * @param {Array} rankings
   * @returns {{qualified: Array, below: Array}}
   */
  _splitBoard(rankings) {
    const qualified = [];
    const below = [];
    for (const item of (Array.isArray(rankings) ? rankings : [])) {
      const isBelow = item.below_threshold === true || item.below_threshold === 1 || (() => {
        const score = item.scan_score != null ? Number(item.scan_score) : (item.score != null ? Number(item.score) : null);
        return score != null && score < this._MIN_DISPLAY_SCORE;
      })();
      (isBelow ? below : qualified).push(item);
    }
    return { qualified, below };
  },

  // ─── INITIALIZATION ──────────────────────────────────

  /**
   * Initialize the Scanner screen.
   */
  async init() {
    console.log('[Scanner] initialized');
    this.bindEvents();

    this._themeObserver = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.attributeName === 'data-theme') {
          this._onThemeChange();
          break;
        }
      }
    });
    this._themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    const momentumPanel = document.querySelector('.ranking-panel.momentum');
    if (momentumPanel) momentumPanel.classList.add('active');

    await this.loadInitialData();
    this._etfRefreshTimer = setInterval(() => {
      if (document.querySelector('.ranking-panel.etf-holdings.active')) this.loadEtfHoldings();
    }, 5 * 60 * 1000);
    this._tradeDate = this._todayET();
    this._tradeDayTimer = setInterval(() => {
      const today = this._todayET();
      if (today !== this._tradeDate) {
        this._tradeDate = today;
        this.tradeLongData = [];
        this.tradeShortData = [];
        this.tradeMeta = null;
        this.renderTradeTable('long');
        this.renderTradeTable('short');
        this.updatePanelCounts();
        this.loadTradeData();
      }
    }, 60000);
  },

  /**
   * Clean up event listeners when navigating away from Scanner screen.
   * Called by App.loadScreen() before loading a different screen.
   */
  destroy() {
    clearInterval(this._etfRefreshTimer);
    this._etfRefreshTimer = null;
    this._etfBoardRequestId = (this._etfBoardRequestId || 0) + 1;
    clearInterval(this._tradeDayTimer);
    this._tradeDayTimer = null;
    if (this._docKeyHandler) {
      document.removeEventListener('keydown', this._docKeyHandler);
      this._docKeyHandler = null;
    }
    if (this._themeObserver) {
      this._themeObserver.disconnect();
      this._themeObserver = null;
    }
    this._closeYtdHistoryModal();
    this._closeQualityScoreHistoryModal();
    this._closeEtfHistoryModal();
  },

  // ─── EVENT BINDING ───────────────────────────────────

  /**
   * Bind all screen-specific event listeners.
   */
  bindEvents() {
    // Run scan button
    const runBtn = document.getElementById('runScanBtn');
    if (runBtn) {
      runBtn.addEventListener('click', () => this.runScan());
    }

    // Retry button
    const retryBtn = document.getElementById('retryBtn');
    if (retryBtn) {
      retryBtn.addEventListener('click', () => {
        this.hideError();
        this.runScan();
      });
    }

    // Empty state scan button
    const emptyBtn = document.getElementById('emptyScanBtn');
    if (emptyBtn) {
      emptyBtn.addEventListener('click', () => {
        this.hideEmpty();
        this.runScan();
      });
    }

    // Ticker click handlers — open chart modal via Portfolio module
    this._bindTickerClickHandlers();

    // Escape key closes chart modal and YTD history modal
    this._docKeyHandler = (e) => {
      if (e.key === 'Escape') {
        const qsModal = document.getElementById('quality-score-history-modal');
        if (qsModal && qsModal.classList.contains('open')) {
          this._closeQualityScoreHistoryModal();
          return;
        }
        if (document.getElementById('etf-history-modal')?.classList.contains('open')) {
          this._closeEtfHistoryModal();
          return;
        }
        const ytdModal = document.getElementById('ytd-history-modal');
        if (ytdModal && ytdModal.classList.contains('open')) {
          this._closeYtdHistoryModal();
          return;
        }
        const modal = document.getElementById('chart-modal');
        if (modal && modal.classList.contains('open')) {
          this._closeChartModal();
        }
      }
    };
    document.addEventListener('keydown', this._docKeyHandler);

    // Mobile scanner tabs
    const tabsContainer = document.getElementById('scannerTabs');
    if (tabsContainer) {
      tabsContainer.addEventListener('click', (e) => {
        const tab = e.target.closest('.scanner-tab');
        if (!tab) return;
        const panel = tab.dataset.panel;

        // Update tab active state
        tabsContainer.querySelectorAll('.scanner-tab').forEach(t => {
          t.classList.remove('active');
          t.setAttribute('aria-selected', 'false');
        });
        tab.classList.add('active');
        tab.setAttribute('aria-selected', 'true');

        // Hide all panels
        document.querySelectorAll('.ranking-board > .ranking-panel, .ranking-board > .right-column > .ranking-panel').forEach(el => {
          el.classList.remove('active');
        });

        // Show the selected panel
        if (panel === 'momentum') {
          document.querySelector('.ranking-panel.momentum')?.classList.add('active');
        } else if (panel === 'reversal') {
          document.querySelector('.ranking-panel.reversal')?.classList.add('active');
        } else if (panel === 'sma200') {
          document.querySelector('.ranking-panel.sma200')?.classList.add('active');
        } else if (panel === 'ytd') {
          document.querySelector('.ranking-panel.ytd')?.classList.add('active');
        } else if (panel === 'earnings') {
          document.querySelector('.ranking-panel.earnings')?.classList.add('active');
        } else if (panel === 'quality-score') {
          document.querySelector('.ranking-panel.quality-score')?.classList.add('active');
        } else if (panel === 'swing') {
          document.querySelector('.ranking-panel.swing')?.classList.add('active');
        } else if (panel === 'trade') {
          document.querySelector('.ranking-panel.trade')?.classList.add('active');
        } else if (panel === 'etf-holdings') {
          this.hideEmpty();
          document.querySelector('.ranking-panel.etf-holdings')?.classList.add('active');
          this.loadEtfHoldings();
        }
      });
    }

    document.getElementById('ytdBody')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.ytd-chart-btn');
      if (btn) {
        e.preventDefault();
        e.stopPropagation();
        this._openYtdHistoryModal(btn.dataset.ticker);
      }
    });

    document.getElementById('qualityScoreBody')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.qs-chart-btn');
      if (btn) {
        e.preventDefault();
        e.stopPropagation();
        this._openQualityScoreHistoryModal(btn.dataset.ticker);
        return;
      }
      // Ticker links open the price chart via _bindTickerClickHandlers — don't toggle details.
      if (e.target.closest('a')) return;
      toggleQualityDetails(e);
    });

    this._initEtfSelector();
    document.getElementById('etfHoldingsSelect')?.addEventListener('change', (e) => this._setSelectedEtf(e.target.value));
    document.getElementById('etfHoldingsBody')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.etf-history-btn');
      if (btn) {
        e.preventDefault();
        e.stopPropagation();
        this._openEtfHistoryModal(btn.dataset.ticker);
      }
    });
  },

  // ─── CHART MODAL ────────────────────────────────────

  /**
   * Bind delegated click handlers on both ranking tables.
   * Clicking a ticker link opens the shared chart modal.
   */
  _bindTickerClickHandlers() {
    const momentumBody = document.getElementById('momentumBody');
    const reversalBody = document.getElementById('reversalBody');
    const sma200Body = document.getElementById('sma200Body');
    const ytdBody = document.getElementById('ytdBody');
    const qualityScoreBody = document.getElementById('qualityScoreBody');
    const etfHoldingsBody = document.getElementById('etfHoldingsBody');

    const handleClick = (e) => {
      // History icon buttons are handled by their own listeners — never treat as ticker open.
      if (e.target.closest('.ytd-chart-btn, .qs-chart-btn, .etf-history-btn')) return;
      const link = e.target.closest('a');
      if (!link) return;
      e.preventDefault();
      e.stopPropagation();
      const row = link.closest('tr');
      if (!row) return;
      const ticker = row.dataset.ticker;
      if (ticker) {
        this._openChartModal(ticker);
      }
    };

    if (momentumBody) momentumBody.addEventListener('click', handleClick);
    if (reversalBody) reversalBody.addEventListener('click', handleClick);
    if (sma200Body) sma200Body.addEventListener('click', handleClick);
    if (ytdBody) ytdBody.addEventListener('click', handleClick);
    if (qualityScoreBody) qualityScoreBody.addEventListener('click', handleClick);
    if (etfHoldingsBody) etfHoldingsBody.addEventListener('click', handleClick);

    const earningsTodayBody = document.getElementById('earningsTodayBody');
    const earningsWeekBody = document.getElementById('earningsWeekBody');
    if (earningsTodayBody) earningsTodayBody.addEventListener('click', handleClick);
    if (earningsWeekBody) earningsWeekBody.addEventListener('click', handleClick);

    const swingVahBody = document.getElementById('swingVahBody');
    const swingValBody = document.getElementById('swingValBody');
    if (swingVahBody) swingVahBody.addEventListener('click', handleClick);
    if (swingValBody) swingValBody.addEventListener('click', handleClick);

    const tradeLongBody = document.getElementById('tradeLongBody');
    const tradeShortBody = document.getElementById('tradeShortBody');
    if (tradeLongBody) tradeLongBody.addEventListener('click', handleClick);
    if (tradeShortBody) tradeShortBody.addEventListener('click', handleClick);
  },

  /**
   * Open chart modal for a ticker.
   * Uses the app-level chart component, independent of Portfolio initialization.
   *
   * @param {string} ticker
   */
  _openChartModal(ticker) {
    ChartModal.open(ticker, TickerMetadata.get(ticker));
  },

  /**
   * Close chart modal.
   */
  _closeChartModal() {
    ChartModal.close();
  },

  // ─── YTD HISTORY MODAL ──────────────────────────────

  _onThemeChange() {
    const ytdModal = document.getElementById('ytd-history-modal');
    if (ytdModal && ytdModal.classList.contains('open') && this._ytdHistoryChartInstance && this._ytdHistoryLineSeries) {
      const snapshots = this._ytdHistorySnapshots;
      const ticker = this._ytdHistoryTicker;
      if (snapshots && ticker) {
        this._renderYtdHistoryChart(snapshots, ticker);
      }
    }
    const qsModal = document.getElementById('quality-score-history-modal');
    if (qsModal && qsModal.classList.contains('open') && this._qsHistoryChartInstance && this._qsHistorySnapshots && this._qsHistoryTicker) {
      this._doRenderQualityScoreChart(document.getElementById('qsHistoryChart'), this._qsHistorySnapshots, this._qsHistoryTicker);
    }
    if (document.getElementById('etf-history-modal')?.classList.contains('open') && this._etfHistorySnapshots?.length) {
      this._renderEtfHistoryChart(this._etfHistorySnapshots);
    }
  },

  async _openYtdHistoryModal(ticker) {
    const modal = document.getElementById('ytd-history-modal');
    const title = document.getElementById('ytd-history-title');
    const chartEl = document.getElementById('ytd-history-chart');
    const emptyEl = document.getElementById('ytd-history-empty');
    if (!modal) return;

    title.textContent = `${ticker} — YTD Return History`;
    chartEl.innerHTML = '';
    emptyEl.style.display = 'none';
    chartEl.style.display = '';
    modal.classList.add('open');
    document.body.style.overflow = 'hidden';

    const closeBtn = document.getElementById('ytd-history-close');
    closeBtn.onclick = () => this._closeYtdHistoryModal();
    modal.onclick = (e) => { if (e.target === modal) this._closeYtdHistoryModal(); };

    try {
      const data = await API.get(`/scanner/ytd-history/${ticker}`);
      const snapshots = data.snapshots || [];
      this._ytdHistorySnapshots = snapshots;
      this._ytdHistoryTicker = ticker;
      if (snapshots.length === 0) {
        chartEl.style.display = 'none';
        emptyEl.style.display = '';
        return;
      }
      this._renderYtdHistoryChart(snapshots, ticker);
    } catch (err) {
      console.error('[Scanner] YTD history load failed:', err);
      chartEl.style.display = 'none';
      emptyEl.style.display = '';
    }
  },

  async _renderYtdHistoryChart(snapshots, ticker) {
    const container = document.getElementById('ytd-history-chart');
    if (!container) return;

    container.innerHTML = '';

    if (typeof LightweightCharts === 'undefined') {
      const existing = document.querySelector('script[src*="lightweight-charts"]');
      if (existing) {
        await new Promise((resolve) => {
          existing.addEventListener('load', () => resolve(), { once: true });
          existing.addEventListener('error', () => resolve(), { once: true });
        });
      } else {
        await new Promise((resolve) => {
          const script = document.createElement('script');
          script.src = 'https://unpkg.com/lightweight-charts@5.2.0/dist/lightweight-charts.standalone.production.js';
          script.async = true;
          script.onload = () => resolve();
          script.onerror = () => {
            console.error('[Scanner] Failed to load LightweightCharts');
            resolve();
          };
          document.head.appendChild(script);
        });
      }
    }

    if (typeof LightweightCharts === 'undefined') {
      container.innerHTML = '<div class="ytd-history-empty">Chart library failed to load.</div>';
      return;
    }

    this._doRenderYtdHistoryChart(container, snapshots, ticker);
  },

  _doRenderYtdHistoryChart(container, snapshots, ticker) {
    if (this._ytdHistoryChartInstance) {
      this._ytdHistoryChartInstance.remove();
      this._ytdHistoryChartInstance = null;
    }

    const hasRank = snapshots.some(s => s.rank != null);

    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const bgColor = isDark ? '#0E0E0E' : '#F4F4F4';
    const textColor = isDark ? '#A3A3A3' : '#5C5C5C';
    const gridColor = isDark ? 'rgba(255,255,255,0.20)' : 'rgba(0,0,0,0.20)';
    const crosshairColor = isDark ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.3)';

    const chart = LightweightCharts.createChart(container, {
      autoSize: true,
      layout: { background: { color: bgColor }, textColor, fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font').trim(), attributionLogo: false },
      grid: { vertLines: { color: gridColor, style: 2 }, horzLines: { color: gridColor, style: 2 } },
      crosshair: {
        mode: LightweightCharts.CrosshairMode.Normal,
      },
      timeScale: { timeVisible: false, rightOffset: 5 },
      rightPriceScale: { scaleMargins: { top: 0.15, bottom: 0.15 } },
      leftPriceScale: { visible: hasRank, invertScale: hasRank, scaleMargins: { top: 0.1, bottom: 0.1 } },
    });

    const latestPct = snapshots[snapshots.length - 1]?.ytd_pct || 0;
    const lineColor = latestPct >= 0 ? (isDark ? '#34C77B' : '#0E7A3D') : (isDark ? '#F25555' : '#C81E1E');

    const lineSeries = chart.addSeries(LightweightCharts.LineSeries, {
      color: lineColor,
      lineWidth: 2,
      priceFormat: { type: 'custom', formatter: (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%` },
      crosshairMarkerVisible: true,
      crosshairMarkerRadius: 4,
    });

    const data = snapshots.map(s => ({ time: s.date, value: s.ytd_pct }));
    lineSeries.setData(data);

    if (hasRank) {
      const rankSeries = chart.addSeries(LightweightCharts.LineSeries, {
        priceScaleId: 'left',
        color: isDark ? '#F59E0B' : '#B45309',
        lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Dashed,
        priceFormat: { type: 'custom', formatter: (v) => `#${Math.round(v)}` },
        crosshairMarkerVisible: true,
        crosshairMarkerRadius: 3,
      });
      rankSeries.setData(snapshots
        .filter(s => s.rank != null)
        .map(s => ({ time: s.date, value: s.rank })));
    }

    const tooltip = document.createElement('div');
    tooltip.style.cssText = `
      position: absolute; display: none; padding: 8px 12px;
      background: ${isDark ? '#0E0E0E' : '#F4F4F4'}; border: 1px solid ${isDark ? '#262626' : '#E2E2E2'};
      border-radius: 6px; font-family: var(--font-mono); font-size: 11px; line-height: 1.25; pointer-events: none;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15); z-index: 10; white-space: nowrap;
      color: ${textColor};
    `;
    container.style.position = 'relative';
    container.appendChild(tooltip);

    chart.subscribeCrosshairMove((param) => {
      if (!param.time || !param.seriesData || param.seriesData.size === 0 ||
          !param.point || param.point.x < 0 || param.point.y < 0 ||
          param.point.x > container.clientWidth || param.point.y > container.clientHeight) {
        tooltip.style.display = 'none';
        return;
      }
      const point = param.seriesData.get(lineSeries);
      if (!point) { tooltip.style.display = 'none'; return; }

      const snap = snapshots.find(s => s.date === param.time);
      const pct = point.value;
      const price = snap?.price || '—';
      const snapIndex = snapshots.findIndex(s => s.date === param.time);
      const prevSnap = snapIndex > 0 ? snapshots[snapIndex - 1] : null;
      let rankHtml = '';
      if (snap?.rank != null) {
        let changeHtml = '';
        if (prevSnap?.rank != null && prevSnap.rank !== snap.rank) {
          const diff = prevSnap.rank - snap.rank;
          changeHtml = diff > 0 ? ` (↑${diff})` : ` (↓${Math.abs(diff)})`;
        }
        rankHtml = `<div>Rank: #${snap.rank}${changeHtml}</div>`;
      }
      tooltip.innerHTML = `<div><strong>${formatChartDateDDMONYY(param.time)}</strong></div><div>YTD: ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%</div><div>Price: $${price}</div>${rankHtml}`;
      tooltip.style.display = 'block';

      const coordinate = (point.value != null) ? lineSeries.priceToCoordinate(point.value) : null;
      if (coordinate === null || coordinate === undefined) { tooltip.style.display = 'none'; return; }

      const rect = container.getBoundingClientRect();
      const tipW = tooltip.offsetWidth || 180;
      const tipH = tooltip.offsetHeight || 80;
      let left = param.point.x - tipW / 2;
      left = Math.max(8, Math.min(left, rect.width - tipW - 8));
      let top = coordinate - tipH - 15;
      if (top <= 0) top = coordinate + 15;
      top = Math.max(0, Math.min(top, rect.height - tipH));
      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${top}px`;
    });

    this._ytdHistoryChartInstance = chart;
    this._ytdHistoryLineSeries = lineSeries;
  },

  _closeYtdHistoryModal() {
    const modal = document.getElementById('ytd-history-modal');
    if (modal) modal.classList.remove('open');
    if (this._ytdHistoryChartInstance) {
      this._ytdHistoryChartInstance.remove();
      this._ytdHistoryChartInstance = null;
      this._ytdHistoryLineSeries = null;
    }
    this._ytdHistorySnapshots = null;
    this._ytdHistoryTicker = null;
    if (!document.getElementById('quality-score-history-modal')?.classList.contains('open')) {
      document.body.style.overflow = '';
    }
  },

  // ─── QUALITY SCORE HISTORY MODAL ────────────────────

  _openQualityScoreHistoryModal(ticker) {
    const modal = document.getElementById('quality-score-history-modal');
    const title = document.getElementById('qsHistoryTitle');
    if (!modal || !title) return;
    // Reset DOM/chart without consuming a generation — then start a fresh one.
    this._closeQualityScoreHistoryModal(false);
    this._qsHistoryRequestId = (this._qsHistoryRequestId || 0) + 1;
    this._qsHistoryTicker = ticker;
    const requestId = this._qsHistoryRequestId;
    title.textContent = `Trend Quality v2 — ${ticker}`;
    modal.classList.add('open');
    document.body.style.overflow = 'hidden';
    document.getElementById('qsHistoryChart').textContent = 'Loading weekly score history…';

    const closeBtn = document.getElementById('closeQsHistoryModal');
    closeBtn.onclick = () => this._closeQualityScoreHistoryModal();
    modal.onclick = (e) => { if (e.target === modal) this._closeQualityScoreHistoryModal(); };

    API.get(`/scanner/quality-score-history/${encodeURIComponent(ticker)}`).then(data => {
      if (this._qsHistoryRequestId !== requestId || this._qsHistoryTicker !== ticker) return;
      const snapshots = data.model_version === QUALITY_MODEL ? (data.snapshots || []) : [];
      if (!snapshots.some(s => Number.isFinite(s.score))) {
        document.getElementById('qsHistoryChart').textContent = 'No v2 scores yet. History starts with this model and builds with completed scans.';
        return;
      }
      this._qsHistorySnapshots = snapshots;
      return this._renderQualityScoreChart(snapshots, ticker, requestId);
    }).catch(err => {
      if (this._qsHistoryRequestId !== requestId) return;
      document.getElementById('qsHistoryChart').textContent = 'Could not load score history. Please try again.';
      console.error('[Scanner] Failed to load QS history:', err.message);
    });
  },

  async _renderQualityScoreChart(snapshots, ticker, requestId) {
    const container = document.getElementById('qsHistoryChart');
    if (!container) return;
    container.innerHTML = '';

    if (typeof LightweightCharts === 'undefined') {
      const existing = document.querySelector('script[src*="lightweight-charts"]');
      if (existing) {
        await new Promise((resolve) => {
          const done = () => {
            clearTimeout(timer);
            existing.removeEventListener('load', done);
            existing.removeEventListener('error', done);
            resolve();
          };
          const timer = setTimeout(done, 10000);
          existing.addEventListener('load', done, { once: true });
          existing.addEventListener('error', done, { once: true });
        });
      } else {
        await new Promise((resolve) => {
          const script = document.createElement('script');
          script.src = 'https://unpkg.com/lightweight-charts@5.2.0/dist/lightweight-charts.standalone.production.js';
          script.async = true;
          const timer = setTimeout(resolve, 10000);
          script.onload = () => { clearTimeout(timer); resolve(); };
          script.onerror = () => {
            clearTimeout(timer);
            console.error('[Scanner] Failed to load LightweightCharts');
            resolve();
          };
          document.head.appendChild(script);
        });
      }
    }

    if (this._qsHistoryRequestId !== requestId || this._qsHistoryTicker !== ticker) return;
    if (typeof LightweightCharts === 'undefined') {
      container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:200px;color:var(--color-text-tertiary);font-size:var(--font-size-sm);">Chart library failed to load.</div>';
      return;
    }

    this._doRenderQualityScoreChart(container, snapshots, ticker);
  },

  _doRenderQualityScoreChart(container, snapshots, ticker) {
    if (this._qsHistoryChartInstance) {
      this._qsHistoryChartInstance.remove();
      this._qsHistoryChartInstance = null;
    }

    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const bgColor = isDark ? '#0E0E0E' : '#F4F4F4';
    const textColor = isDark ? '#A3A3A3' : '#5C5C5C';
    const gridColor = isDark ? 'rgba(255,255,255,0.20)' : 'rgba(0,0,0,0.20)';
    const crosshairColor = isDark ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.3)';

    const chart = LightweightCharts.createChart(container, {
      autoSize: true,
      layout: { background: { color: bgColor }, textColor, fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font').trim(), attributionLogo: false },
      grid: { vertLines: { color: gridColor, style: 2 }, horzLines: { color: gridColor, style: 2 } },
      crosshair: {
        mode: LightweightCharts.CrosshairMode.Normal,
      },
      timeScale: { timeVisible: false, rightOffset: 5 },
      rightPriceScale: { scaleMargins: { top: 0.15, bottom: 0.15 } },
    });

    const lineColor = isDark ? '#34C77B' : '#0E7A3D';

    const lineSeries = chart.addSeries(LightweightCharts.LineSeries, {
      color: lineColor,
      lineWidth: 2,
      priceFormat: { type: 'custom', formatter: (v) => `${v.toFixed(1)}/100` },
      autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }),
      crosshairMarkerVisible: true,
      crosshairMarkerRadius: 4,
    });

    const data = snapshots.map(s => Number.isFinite(s.score) ? { time: s.date, value: s.score } : { time: s.date });
    lineSeries.setData(data);
    chart.timeScale().fitContent();

    const tooltip = document.createElement('div');
    tooltip.style.cssText = `
      position: absolute; display: none; padding: 8px 12px;
      background: ${isDark ? '#0E0E0E' : '#F4F4F4'}; border: 1px solid ${isDark ? '#262626' : '#E2E2E2'};
      border-radius: 6px; font-family: var(--font-mono); font-size: 11px; line-height: 1.25; pointer-events: none;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15); z-index: 10; white-space: nowrap;
      color: ${textColor};
    `;
    container.style.position = 'relative';
    container.appendChild(tooltip);

    chart.subscribeCrosshairMove((param) => {
      if (!param.time || !param.seriesData || param.seriesData.size === 0 ||
          !param.point || param.point.x < 0 || param.point.y < 0 ||
          param.point.x > container.clientWidth || param.point.y > container.clientHeight) {
        tooltip.style.display = 'none';
        return;
      }
      const point = param.seriesData.get(lineSeries);
      if (!point || !Number.isFinite(point.value)) { tooltip.style.display = 'none'; return; }

      const snap = snapshots.find(s => s.date === param.time);
      const score = point.value;
      const price = Number.isFinite(snap?.price) ? snap.price.toFixed(2) : '—';
      tooltip.innerHTML = `<div><strong>${formatChartDateDDMONYY(param.time)}</strong></div><div>Score: ${score.toFixed(1)}/100${snap?.provisional ? ' · Provisional' : ''}</div><div>Close: ${price} (listing currency)</div>`;
      tooltip.style.display = 'block';

      const coordinate = (point.value != null) ? lineSeries.priceToCoordinate(point.value) : null;
      if (coordinate === null || coordinate === undefined) { tooltip.style.display = 'none'; return; }

      const rect = container.getBoundingClientRect();
      const tipW = tooltip.offsetWidth || 200;
      const tipH = tooltip.offsetHeight || 80;
      let left = param.point.x - tipW / 2;
      left = Math.max(8, Math.min(left, rect.width - tipW - 8));
      let top = coordinate - tipH - 15;
      if (top <= 0) top = coordinate + 15;
      top = Math.max(0, Math.min(top, rect.height - tipH));
      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${top}px`;
    });

    this._qsHistoryChartInstance = chart;
    this._qsHistoryLineSeries = lineSeries;
  },

  _closeQualityScoreHistoryModal(invalidate = true) {
    if (invalidate) this._qsHistoryRequestId = (this._qsHistoryRequestId || 0) + 1;
    const modal = document.getElementById('quality-score-history-modal');
    if (modal) modal.classList.remove('open');
    if (this._qsHistoryChartInstance) {
      this._qsHistoryChartInstance.remove();
      this._qsHistoryChartInstance = null;
      this._qsHistoryLineSeries = null;
    }
    this._qsHistorySnapshots = null;
    this._qsHistoryTicker = null;
    if (!document.getElementById('ytd-history-modal')?.classList.contains('open')) {
      document.body.style.overflow = '';
    }
  },

  // ─── ETF SHARES HELD HISTORY (ticker links still open price charts) ───
  _formatEtfShares(shares) {
    return Number.isFinite(shares) ? shares.toLocaleString('en-US', { maximumFractionDigits: 6 }) : '—';
  },

  async _openEtfHistoryModal(ticker) {
    const modal = document.getElementById('etf-history-modal');
    const container = document.getElementById('etf-history-chart');
    if (!modal || !container) return;
    this._closeEtfHistoryModal();
    const requestId = ++this._etfHistoryRequestId;
    const etf = this._getSelectedEtf();
    this._etfHistoryTicker = ticker;
    const holding = this.etfHoldings.find(h => h.ticker === ticker);
    document.getElementById('etf-history-title').textContent = `${etf} · ${holding?.name || ticker} — Shares Held History`;
    container.textContent = 'Loading shares held history…';
    modal.classList.add('open');
    document.body.style.overflow = 'hidden';
    document.getElementById('etf-history-close').onclick = () => this._closeEtfHistoryModal();
    modal.onclick = (e) => { if (e.target === modal) this._closeEtfHistoryModal(); };
    try {
      const data = await API.get('/scanner/etf-holdings/history', { etf, ticker });
      if (requestId !== this._etfHistoryRequestId) return;
      this._etfHistorySnapshots = data.snapshots || [];
      if (this._etfHistorySnapshots.filter(s => Number.isFinite(s.shares)).length < 2) {
        this._renderEtfHistoryChart(this._etfHistorySnapshots);
        return;
      }
      await this._ensureEtfChartLibrary();
      if (requestId === this._etfHistoryRequestId) this._renderEtfHistoryChart(this._etfHistorySnapshots);
    } catch (err) {
      if (requestId === this._etfHistoryRequestId) container.textContent = 'Could not load shares held history. Please try again.';
      console.error('[Scanner] ETF shares held history failed:', err);
    }
  },

  async _ensureEtfChartLibrary() {
    if (typeof LightweightCharts !== 'undefined') return;
    let script = document.querySelector('script[src*="lightweight-charts"]');
    if (!script) {
      script = document.createElement('script');
      script.src = 'https://unpkg.com/lightweight-charts@5.2.0/dist/lightweight-charts.standalone.production.js';
      script.async = true;
      const loading = new Promise((resolve) => {
        script.addEventListener('load', resolve, { once: true });
        script.addEventListener('error', resolve, { once: true });
      });
      document.head.appendChild(script);
      await loading;
      return;
    }
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 10000);
      const finish = () => { clearTimeout(timer); resolve(); };
      script.addEventListener('load', finish, { once: true });
      script.addEventListener('error', finish, { once: true });
    });
  },

  _renderEtfHistoryChart(snapshots) {
    const container = document.getElementById('etf-history-chart');
    if (!container) return;
    if (this._etfHistoryChartInstance) this._etfHistoryChartInstance.remove();
    this._etfHistoryChartInstance = null;
    const observations = snapshots.filter(s => Number.isFinite(s.shares));
    if (observations.length < 2) {
      const point = observations[0];
      container.textContent = point
        ? `${point.date}: ${this._formatEtfShares(point.shares)} shares held. History builds with each new published snapshot.`
        : 'No shares held history yet. Quantities will be recorded on the next holdings refresh.';
      return;
    }
    if (typeof LightweightCharts === 'undefined') {
      container.textContent = 'Chart library failed to load.';
      return;
    }
    container.replaceChildren();
    const dark = document.documentElement.dataset.theme === 'dark';
    const chart = LightweightCharts.createChart(container, {
      autoSize: true,
      layout: { background: { color: dark ? '#0E0E0E' : '#F4F4F4' }, textColor: dark ? '#A3A3A3' : '#5C5C5C', fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font').trim(), attributionLogo: false },
      grid: { vertLines: { color: dark ? '#262626' : '#E2E2E2' }, horzLines: { color: dark ? '#262626' : '#E2E2E2' } },
      timeScale: { timeVisible: false, rightOffset: 5 },
    });
    const series = chart.addSeries(LightweightCharts.LineSeries, {
      color: dark ? '#34C77B' : '#0E7A3D', lineWidth: 2,
      priceFormat: { type: 'custom', formatter: v => this._formatEtfShares(v), minMove: 0.000001 },
      crosshairMarkerVisible: true,
    });
    // Pre-upgrade snapshots have no quantity; represent them as gaps, never zero.
    series.setData(snapshots.map(s => Number.isFinite(s.shares)
      ? { time: s.date, value: s.shares } : { time: s.date }));
    chart.timeScale().fitContent();
    const tooltip = document.createElement('div');
    tooltip.className = 'lc-tracking-tooltip';
    container.appendChild(tooltip);
    chart.subscribeCrosshairMove((param) => {
      const point = param.seriesData?.get(series);
      if (!param.time || !point || !param.point || param.point.x < 0 || param.point.x > container.clientWidth) {
        tooltip.style.display = 'none';
        return;
      }
      const snapshot = snapshots.find(s => s.date === param.time);
      tooltip.textContent = `${param.time} · ${this._formatEtfShares(point.value)} shares held · rank #${snapshot?.rank ?? '—'}`;
      tooltip.style.display = 'block';
      tooltip.style.left = `${Math.max(8, Math.min(param.point.x + 12, container.clientWidth - tooltip.offsetWidth - 8))}px`;
      tooltip.style.top = `${Math.max(8, Math.min(param.point.y - 36, container.clientHeight - tooltip.offsetHeight - 8))}px`;
    });
    this._etfHistoryChartInstance = chart;
  },

  _closeEtfHistoryModal() {
    ++this._etfHistoryRequestId;
    document.getElementById('etf-history-modal')?.classList.remove('open');
    if (this._etfHistoryChartInstance) this._etfHistoryChartInstance.remove();
    this._etfHistoryChartInstance = null;
    this._etfHistorySnapshots = null;
    this._etfHistoryTicker = null;
    if (!document.getElementById('ytd-history-modal')?.classList.contains('open') &&
        !document.getElementById('quality-score-history-modal')?.classList.contains('open')) {
      document.body.style.overflow = '';
    }
  },

  // ─── DATA LOADING ────────────────────────────────────

  /**
   * Load initial data on screen open.
   * Restores cached rankings if available, then fetches fresh data.
   */
  async loadInitialData() {
    // Try to restore cached rankings first for instant display
    const cached = this._restoreCache();
    if (cached) {
      this.renderMomentumTable();
      this.renderReversalTable();
      this.renderSma200Table();
      this.renderYtdTable();
      this.renderQualityScoreTable();
      this.renderEarningsTable('today');
      this.renderEarningsTable('week');
      this.renderSwingTable('vah');
      this.renderSwingTable('val');
      this.renderTradeTable('long');
      this.renderTradeTable('short');
      this.updateUniverseBadge();
      this.updatePanelCounts();
    }

    // Fetch fresh data from API (both momentum + reversal rankings + universe)
    await Promise.allSettled([
      this.loadRankings('momentum'),
      this.loadRankings('reversal'),
      this.loadSma200Rankings(),
      this.loadYtdRankings(),
      this.loadQualityScoreRankings(),
      this.loadUniverseCount(),
      this.loadEarningsData(),
      this.loadSwingData(),
      this.loadTradeData(),
      this.loadEtfHoldings(),
    ]);

    this.updateLastScanTime();
  },

  /**
   * Load universe stock count from the universe endpoint.
   */
  async loadUniverseCount() {
    try {
      const data = await API.get('/universe');
      if (Array.isArray(data)) {
        TickerMetadata.seed(data, { completeUniverse: true });
        this.universeSize = data.length;
      } else if (data && data.tickers) {
        this.universeSize = data.tickers.length;
      }
    } catch (err) {
      console.error('[Scanner] Failed to load universe count:', err.message);
    }
    this.updateUniverseBadge();
  },

  /**
   * Load rankings for a specific scan type.
   *
   * @param {'momentum'|'reversal'} type
   */
  async loadRankings(type) {
    try {
      const data = await API.get('/scanner/ranking', { type, limit: 50, include_below: 'true', grey_limit: 25 });
      const rankings = data.rankings || [];

      // Split into ranked qualifiers + grey below-threshold rows pinned below.
      const { qualified, below } = this._splitBoard(rankings);

      if (type === 'momentum') {
        this.momentumRankings = qualified;
        this.momentumBelow = below;
        this.renderMomentumTable();
      } else {
        this.reversalRankings = qualified;
        this.reversalBelow = below;
        this.renderReversalTable();
      }

      // Read scan completion timestamp from the ranking endpoint response.
      // Always keep the most recent timestamp across momentum/reversal.
      if (data.completed_at) {
        if (!this.lastScanCompletedAt || data.completed_at > this.lastScanCompletedAt) {
          this.lastScanCompletedAt = data.completed_at;
        }
      }

      this.updatePanelCounts();
      this._saveCache();
    } catch (err) {
      console.error(`[Scanner] Failed to load ${type} rankings:`, err.message);
      if (type === 'momentum') {
        this.momentumRankings = [];
        this.momentumBelow = [];
        this.renderMomentumTable();
      } else {
        this.reversalRankings = [];
        this.reversalBelow = [];
        this.renderReversalTable();
      }
      this.updatePanelCounts();
    }
  },

  /**
   * Load 200 SMA proximity rankings.
   */
  async loadSma200Rankings() {
    try {
      const data = await API.get('/scanner/sma200/ranking');
      const rankings = data.rankings || [];
      this.sma200Rankings = rankings;
      this.renderSma200Table();
      this.updatePanelCounts();
    } catch (err) {
      console.error('[Scanner] Failed to load 200 SMA rankings:', err.message);
      this.sma200Rankings = [];
      this.renderSma200Table();
      this.updatePanelCounts();
    }
  },

  /**
   * Load YTD return rankings.
   */
  async loadYtdRankings() {
    try {
      const data = await API.get('/scanner/ytd/ranking');
      const rankings = data.rankings || [];
      this.ytdRankings = rankings;
      this.renderYtdTable();
      this.updatePanelCounts();
    } catch (err) {
      console.error('[Scanner] Failed to load YTD rankings:', err.message);
      this.ytdRankings = [];
      this.renderYtdTable();
      this.updatePanelCounts();
    }
  },

  async loadQualityScoreRankings() {
    try {
      const data = await API.get('/scanner/quality-score/ranking');
      const rankings = data.model_version === QUALITY_MODEL ? (data.rankings || []) : [];
      TickerMetadata.seed(rankings);
      this.qualityScoreRankings = rankings;
      this.qualityScoreMeta = data.model_version === QUALITY_MODEL ? data : null;
      this.renderQualityScoreTable();
      this.updatePanelCounts();
      renderQualityStatus(this.qualityScoreMeta, this.qualityScoreError);
      this._saveCache();
    } catch (err) {
      console.error('[Scanner] Failed to load Quality Score rankings:', err.message);
      this.qualityScoreError = 'Could not refresh Trend Quality. Any displayed results are from the last successful scan.';
      this.renderQualityScoreTable();
      this.updatePanelCounts();
      renderQualityStatus(this.qualityScoreMeta, this.qualityScoreError);
    }
  },

  /**
   * Load earnings data (today and upcoming).
   */
  async loadEarningsData() {
    try {
      const [todayResult, weekResult] = await Promise.allSettled([
        API.get('/scanner/earnings', { window: 'today' }),
        API.get('/scanner/earnings', { window: 'week' }),
      ]);
      
      if (todayResult.status === 'fulfilled') {
        this.earningsTodayData = todayResult.value.earnings || [];
      } else {
        console.error('[Scanner] Failed to load today earnings:', todayResult.reason?.message);
        this.earningsTodayData = [];
      }
      
      if (weekResult.status === 'fulfilled') {
        this.earningsWeekData = weekResult.value.earnings || [];
      } else {
        console.error('[Scanner] Failed to load upcoming earnings:', weekResult.reason?.message);
        this.earningsWeekData = [];
      }
      
      TickerMetadata.seed(this.earningsTodayData);
      TickerMetadata.seed(this.earningsWeekData);
      this.renderEarningsTable('today');
      this.renderEarningsTable('week');
      this.updatePanelCounts();
    } catch (err) {
      console.error('[Scanner] Failed to load earnings data:', err.message);
      this.earningsTodayData = [];
      this.earningsWeekData = [];
      this.renderEarningsTable('today');
      this.renderEarningsTable('week');
      this.updatePanelCounts();
    }
  },

  /**
   * Load Swing VAH/VAL touches (DB-only, fresh after 4:30 PM ET).
   */
  async loadSwingData() {
    try {
      const data = await API.get('/scanner/swing');
      this.swingVahData = data.vah || [];
      this.swingValData = data.val || [];
      this.swingMeta = data;
      TickerMetadata.seed(this.swingVahData.map((r) => ({ ticker: r.ticker, company_name: r.company })));
      TickerMetadata.seed(this.swingValData.map((r) => ({ ticker: r.ticker, company_name: r.company })));
      this.renderSwingTable('vah');
      this.renderSwingTable('val');
      this.updatePanelCounts();
      this._saveCache();
    } catch (err) {
      console.error('[Scanner] Failed to load Swing data:', err.message);
      this.swingVahData = [];
      this.swingValData = [];
      this.renderSwingTable('vah');
      this.renderSwingTable('val');
      this.updatePanelCounts();
    }
  },

  /**
   * Load Trade ORB breakouts (DB-only, fresh after 10:45 AM ET).
   */
  async loadTradeData() {
    try {
      const data = await API.get('/scanner/orb');
      const current = data.session_date === this._todayET();
      this.tradeLongData = current ? (data.long || []) : [];
      this.tradeShortData = current ? (data.short || []) : [];
      this.tradeMeta = current ? data : null;
      TickerMetadata.seed(this.tradeLongData.map((r) => ({ ticker: r.ticker, company_name: r.company })));
      TickerMetadata.seed(this.tradeShortData.map((r) => ({ ticker: r.ticker, company_name: r.company })));
      this.renderTradeTable('long');
      this.renderTradeTable('short');
      this.updatePanelCounts();
      this._saveCache();
    } catch (err) {
      console.error('[Scanner] Failed to load Trade data:', err.message);
      this.tradeLongData = [];
      this.tradeShortData = [];
      this.renderTradeTable('long');
      this.renderTradeTable('short');
      this.updatePanelCounts();
    }
  },

  _getSelectedEtf() {
    if (this._selectedEtf) return this._selectedEtf;
    return document.getElementById('etfHoldingsSelect')?.value || 'XDIV.TO';
  },

  _syncEtfControls() {
    const etf = this._getSelectedEtf();
    const select = document.getElementById('etfHoldingsSelect');
    if (select && select.value !== etf) select.value = etf;
    document.querySelectorAll('#etfHoldingsPills .etf-pill').forEach((pill) => {
      const active = pill.dataset.etf === etf;
      pill.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  },

  _setSelectedEtf(etf) {
    if (!etf) return;
    this._selectedEtf = etf;
    this._syncEtfControls();
    this.loadEtfHoldings();
  },

  _initEtfSelector() {
    const select = document.getElementById('etfHoldingsSelect');
    const pills = document.getElementById('etfHoldingsPills');
    if (!select || !pills) return;
    if (!this._selectedEtf) this._selectedEtf = select.value || 'XDIV.TO';
    if (!pills.children.length) {
      Array.from(select.options).forEach((opt) => {
        const pill = document.createElement('button');
        pill.type = 'button';
        pill.className = 'etf-pill';
        pill.dataset.etf = opt.value;
        pill.textContent = opt.textContent || opt.value;
        pill.setAttribute('aria-pressed', 'false');
        pill.setAttribute('aria-label', `Show ${opt.value} holdings`);
        pills.appendChild(pill);
      });
      pills.addEventListener('click', (e) => {
        const pill = e.target.closest('.etf-pill');
        if (!pill || pill.getAttribute('aria-pressed') === 'true') return;
        this._setSelectedEtf(pill.dataset.etf);
      });
    }
    this._syncEtfControls();
  },

  async loadEtfHoldings() {
    const etf = this._getSelectedEtf();
    const requestId = this._etfBoardRequestId = (this._etfBoardRequestId || 0) + 1;
    try {
      const data = await API.get('/scanner/etf-holdings', { etf });
      if (requestId !== this._etfBoardRequestId) return;
      this.etfHoldings = data.holdings || [];
      this.etfHoldingsMeta = data;
      if (data.etf) {
        this._selectedEtf = data.etf;
        this._syncEtfControls();
      }
      TickerMetadata.seed(this.etfHoldings.filter(h => !h.ticker.startsWith('PRIVATE:')).map(h => ({
        ticker: etf === 'XDIV.TO' ? `${h.ticker}.TO` : h.ticker.replace(/[./\s]+/g, '-'),
        name: h.name,
      })));
      this.renderEtfHoldings();
    } catch (err) {
      if (requestId !== this._etfBoardRequestId) return;
      console.error('[Scanner] ETF holdings load failed:', err);
      if (!this.etfHoldingsMeta || this.etfHoldingsMeta.etf !== etf) {
        this.etfHoldings = [];
        this.etfHoldingsMeta = null;
      }
      this.renderEtfHoldings('Could not refresh holdings. Showing the last available snapshot.');
    }
  },

  /**
   * Run both momentum and reversal scans.
   * Fetches fresh data from the backend and updates rankings.
   */
  async runScan() {
    // Cancel any in-flight request
    if (this._controller) this._controller.abort();
    this._controller = new AbortController();

    this.loading = true;
    this.showLoading();
    this.hideError();
    this.hideEmpty();

    // Update button state
    const runBtn = document.getElementById('runScanBtn');
    const scanBtnText = document.getElementById('scanBtnText');
    if (runBtn) runBtn.disabled = true;
    if (scanBtnText) scanBtnText.textContent = 'Scanning...';

    try {
      // Run both scans in parallel
      const [momentumResult, reversalResult, sma200Result, ytdResult, qualityScoreResult] = await Promise.allSettled([
        API.get('/scanner/momentum', { force: 'true' }, this._controller.signal),
        API.get('/scanner/reversal', { force: 'true' }, this._controller.signal),
        API.get('/scanner/sma200', { force: 'true' }, this._controller.signal),
        API.get('/scanner/ytd', { force: 'true' }, this._controller.signal),
        API.get('/scanner/quality-score', { force: 'true' }, this._controller.signal),
      ]);

      // Handle momentum scan result
      if (momentumResult.status === 'fulfilled') {
        const data = momentumResult.value;
        if (data.universe_size) this.universeSize = data.universe_size;
        if (data.completed_at) this.lastScanCompletedAt = data.completed_at;
      } else {
        const err = momentumResult.reason;
        if (err.message !== 'Request cancelled') {
          this.hideLoading();
          this.showError(err.message || 'Failed to fetch momentum scan results from yfinance');
          return;
        }
      }

      // Handle reversal scan result
      if (reversalResult.status === 'fulfilled') {
        const data = reversalResult.value;
        if (data.universe_size) this.universeSize = data.universe_size;
        if (data.completed_at) this.lastScanCompletedAt = data.completed_at;
      } else {
        const err = reversalResult.reason;
        if (err.message !== 'Request cancelled') {
          this.hideLoading();
          this.showError(err.message || 'Failed to fetch reversal scan results from yfinance');
          return;
        }
      }

      // Handle 200 SMA scan result
      if (sma200Result.status === 'fulfilled') {
        const data = sma200Result.value;
        if (data.completed_at) this.lastScanCompletedAt = data.completed_at;
      } else {
        const err = sma200Result.reason;
        if (err.message !== 'Request cancelled') {
          console.error('[Scanner] 200 SMA scan failed:', err.message);
        }
      }

      // Handle YTD scan result
      if (ytdResult.status === 'fulfilled') {
        const data = ytdResult.value;
        if (data.completed_at) this.lastScanCompletedAt = data.completed_at;
      } else {
        const err = ytdResult.reason;
        if (err.message !== 'Request cancelled') {
          console.error('[Scanner] YTD scan failed:', err.message);
        }
      }

      // Handle Quality Score scan result
      if (qualityScoreResult.status === 'fulfilled') {
        this.qualityScoreError = null;
      } else {
        const err = qualityScoreResult.reason;
        if (err.message !== 'Request cancelled') {
          console.error('[Scanner] Quality Score scan failed:', err.message);
          this.qualityScoreError = `Trend Quality scan failed: ${err.message}. Showing the last successful results.`;
        }
      }

      // Reload rankings after scans complete — backend persists results to rankings table
      await Promise.allSettled([
        this.loadRankings('momentum'),
        this.loadRankings('reversal'),
        this.loadSma200Rankings(),
        this.loadYtdRankings(),
        this.loadQualityScoreRankings(),
        this.loadEarningsData(),
        this.loadSwingData(),
        this.loadTradeData(),
      ]);

      this.updateUniverseBadge();
      this.updateLastScanTime();

      this.hideLoading();

      // Check if all rankings are empty (grey below-threshold rows count as content)
      const momentumEmpty = this.momentumRankings.length === 0 && (this.momentumBelow || []).length === 0;
      const reversalEmpty = this.reversalRankings.length === 0 && (this.reversalBelow || []).length === 0;
      if (momentumEmpty && reversalEmpty && this.sma200Rankings.length === 0 && this.ytdRankings.length === 0 && this.qualityScoreRankings.length === 0 && this.etfHoldings.length === 0) {
        this.showEmpty();
      }
    } catch (err) {
      if (err.message !== 'Request cancelled') {
        this.hideLoading();
        this.showError(err.message || 'Failed to fetch data from yfinance');
      }
    } finally {
      this.loading = false;
      if (runBtn) runBtn.disabled = false;
      if (scanBtnText) scanBtnText.textContent = 'Run Scan';
    }
  },

  // ─── RENDERING ───────────────────────────────────────

  /**
   * Render a single board row. Grey rows (below threshold) are unranked —
   * rank cell shows '—' and the row carries .is-below-threshold styling.
   */
  _boardRowHtml(item, i, grey) {
    const rank = grey ? '—' : (item.current_rank || (i + 1));
    const ticker = this._esc(item.ticker || '—');
    const score = item.scan_score != null ? Number(item.scan_score) : (item.score != null ? Number(item.score) : null);
    const streak = grey ? '—' : (item.qualified_streak ?? 1);
    const trendHtml = this._renderTrend(item);

    const scorePct = score != null ? Math.min(100, Math.max(0, score * 10)) : 0;
    const scoreClass = score != null ? (score >= 7 ? 'high' : score >= 5 ? 'medium' : 'low') : 'low';
    const rowClass = grey ? ' class="is-below-threshold"' : '';
    const title = grey ? ` title="${ticker} is below the 3.0 threshold — watching"` : '';

    return `
      <tr${rowClass} data-ticker="${ticker}" data-score="${score ?? 0}"${title}>
        <td class="rank-cell">${rank}</td>
        <td class="ticker-cell"><a href="#" title="View ${ticker} details">${ticker}</a></td>
        <td>
          <div class="score-cell">
            <div class="score-bar-track"><div class="score-bar-fill ${scoreClass} animate" style="width:${scorePct}%"></div></div>
            <span class="score-value">${score != null ? score.toFixed(1) : '—'}</span>
          </div>
        </td>
        <td class="days-cell" title="First seen: ${this._esc(item.first_seen || '—')}"><span class="days-pill">${streak}${grey ? '' : 'd'}</span></td>
        <td class="trend-cell">${trendHtml}</td>
      </tr>
    `;
  },

  /**
   * Combine ranked qualifiers + grey below-threshold rows pinned at the bottom,
   * separated by a labeled divider row.
   */
  _boardRowsHtml(qualified, below) {
    const q = (Array.isArray(qualified) ? qualified : []).map((item, i) => this._boardRowHtml(item, i, false)).join('');
    const grey = Array.isArray(below) ? below : [];
    if (grey.length === 0) return q;
    const sep = `
      <tr class="below-separator" aria-hidden="true">
        <td colspan="5">Below 3.0 — watching</td>
      </tr>
    `;
    return q + sep + grey.map((item) => this._boardRowHtml(item, 0, true)).join('');
  },

  /**
   * Render the momentum ranking table.
   */
  renderMomentumTable() {
    const tbody = document.getElementById('momentumBody');
    if (!tbody) return;

    const qualified = Array.isArray(this.momentumRankings) ? this.momentumRankings : [];
    const below = Array.isArray(this.momentumBelow) ? this.momentumBelow : [];
    if (qualified.length === 0 && below.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="5" style="text-align: center; padding: var(--space-8); color: var(--color-text-tertiary);">
            No momentum rankings available. Run a scan to populate.
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = this._boardRowsHtml(qualified, below);
  },

  /**
   * Render the reversal ranking table.
   */
  renderReversalTable() {
    const tbody = document.getElementById('reversalBody');
    if (!tbody) return;

    const qualified = Array.isArray(this.reversalRankings) ? this.reversalRankings : [];
    const below = Array.isArray(this.reversalBelow) ? this.reversalBelow : [];
    if (qualified.length === 0 && below.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="5" style="text-align: center; padding: var(--space-8); color: var(--color-text-tertiary);">
            No reversal rankings available. Run a scan to populate.
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = this._boardRowsHtml(qualified, below);
  },

  /**
   * Render the 200 SMA proximity table.
   */
  renderSma200Table() {
    const tbody = document.getElementById('sma200Body');
    if (!tbody) return;

    if (!Array.isArray(this.sma200Rankings) || this.sma200Rankings.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="6" style="text-align: center; padding: var(--space-8); color: var(--color-text-tertiary);">
            No 200 SMA proximity data available. Run a scan to populate.
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = this.sma200Rankings.map((item, i) => {
      const rank = i + 1;
      const ticker = this._esc(item.ticker || '—');
      const price = item.price != null ? item.price.toFixed(2) : '—';
      const sma200 = item.sma_200 != null ? item.sma_200.toFixed(2) : '—';
      const pctFromSma = item.pct_from_sma != null ? item.pct_from_sma : null;
      const aboveSma = item.above_sma;
      
      // Format percentage with sign
      const pctStr = pctFromSma != null ? `${pctFromSma >= 0 ? '+' : ''}${pctFromSma.toFixed(1)}%` : '—';
      const pctClass = pctFromSma != null ? (pctFromSma >= 0 ? 'pct-above' : 'pct-below') : '';
      
      // Position badge
      const positionClass = aboveSma ? 'above' : 'below';
      const positionText = aboveSma ? 'Above' : 'Below';
      const positionIcon = aboveSma ? '↑' : '↓';
      
      // Highlight stocks very close to SMA (within 1%)
      const isHot = pctFromSma != null && Math.abs(pctFromSma) <= 1;
      const rowClass = isHot ? 'proximity-hot' : '';
      
      return `
        <tr data-ticker="${ticker}" class="${rowClass}">
          <td class="rank-cell">${rank}</td>
          <td class="ticker-cell"><a href="#" title="View ${ticker} details">${ticker}</a></td>
          <td class="price-cell">$${price}</td>
          <td class="sma-cell">$${sma200}</td>
          <td class="pct-cell ${pctClass}">${pctStr}</td>
          <td><span class="position-badge ${positionClass}">${positionIcon} ${positionText}</span></td>
        </tr>
      `;
    }).join('');
  },

  /**
   * Render the YTD return ranking table.
   */
  renderYtdTable() {
    const tbody = document.getElementById('ytdBody');
    if (!tbody) return;

    if (!Array.isArray(this.ytdRankings) || this.ytdRankings.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="5" style="text-align: center; padding: var(--space-8); color: var(--color-text-tertiary);">
            No YTD return data available. Run a scan to populate.
          </td>
        </tr>
      `;
      return;
    }

    // Find max absolute YTD for bar scaling
    const maxAbsYtd = Math.max(...this.ytdRankings.map(r => Math.abs(r.ytd_pct || 0)), 1);

    tbody.innerHTML = this.ytdRankings.map((item, i) => {
      const rank = i + 1;
      const ticker = this._esc(item.ticker || '—');
      const ytdPct = item.ytd_pct != null ? item.ytd_pct : 0;
      const isPositive = ytdPct >= 0;
      
      // Bar width: proportional to max YTD, capped at 100%
      const barPct = Math.min(100, (Math.abs(ytdPct) / maxAbsYtd) * 100);
      const barClass = isPositive ? '' : 'negative';
      
      // Value formatting
      const valueClass = isPositive ? 'ytd-positive' : 'ytd-negative';
      const valueStr = `${isPositive ? '+' : ''}${ytdPct.toFixed(1)}%`;
      
      return `
        <tr data-ticker="${ticker}">
          <td class="rank-cell">${rank}</td>
          <td class="ticker-cell"><a href="#" title="View ${ticker} details">${ticker}</a></td>
          <td class="ytd-bar-cell">
            <div class="ytd-bar-track">
              <div class="ytd-bar-fill ${barClass}" style="width: ${barPct}%"></div>
            </div>
          </td>
          <td class="ytd-value-cell ${valueClass}">${valueStr}</td>
          <td class="trend-cell">${this._renderTrend(item)}<button class="ytd-chart-btn" data-ticker="${ticker}" aria-label="View ${ticker} YTD history chart" title="View YTD history"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M7 16l4-8 4 4 4-6"/></svg></button></td>
        </tr>
      `;
    }).join('');
  },

  renderQualityScoreTable() {
    renderQualityTable(this.qualityScoreRankings, item => this._renderTrend(item));
    renderQualityStatus(this.qualityScoreMeta, this.qualityScoreError);
  },

  renderEtfHoldings(error = '') {
    const body = document.getElementById('etfHoldingsBody');
    const status = document.getElementById('etfHoldingsStatus');
    const count = document.getElementById('etfHoldingsCount');
    if (!body || !status || !count) return;
    const meta = this.etfHoldingsMeta;
    const holdings = this.etfHoldings || [];
    count.textContent = `${holdings.length} holdings`;
    status.textContent = meta?.as_of
      ? `${meta.issuer || 'Issuer'} · Holdings as of ${meta.as_of}${meta.previous_as_of ? ` · Compared with ${meta.previous_as_of}` : ' · History begins here'}${error ? ` · ${error}` : ''}`
      : (error || 'Waiting for the first published holdings snapshot.');
    if (!holdings.length) {
      body.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:var(--space-8);color:var(--color-text-tertiary);">No ETF holdings available yet.</td></tr>';
      return;
    }
    body.innerHTML = holdings.map(h => {
      const ticker = this._esc(h.ticker);
      const isPrivate = h.ticker.startsWith('PRIVATE:');
      const chartTicker = isPrivate ? '' : this._esc(meta.etf === 'XDIV.TO' ? `${h.ticker}.TO` : h.ticker.replace(/[./\s]+/g, '-'));
      const name = this._esc(h.name);
      const weight = Number(h.weight);
      const prior = h.previous_weight == null ? null : Number(h.previous_weight);
      // Use displayed precision for the direction so a 0.00% visual change never gets an arrow.
      const delta = prior == null ? null : Math.round(weight * 100) - Math.round(prior * 100);
      const weightClass = delta > 0 ? 'etf-up' : delta < 0 ? 'etf-down' : '';
      const weightTrend = delta == null ? '' : delta > 0 ? ' <span class="etf-up" aria-label="Weight increased">↑</span>' : delta < 0 ? ' <span class="etf-down" aria-label="Weight decreased">↓</span>' : '';
      const weightTitle = prior == null ? 'No previous snapshot' : `Previous weight ${prior.toFixed(2)}% · ${delta > 0 ? '+' : ''}${(delta / 100).toFixed(2)} percentage points`;
      const sharesChange = h.shares_change;
      const sharesClass = sharesChange > 0 ? 'etf-up' : sharesChange < 0 ? 'etf-down' : '';
      const sharesTrend = sharesChange > 0 ? ' <span class="etf-up" aria-label="Shares held increased">↑</span>'
        : sharesChange < 0 ? ' <span class="etf-down" aria-label="Shares held decreased">↓</span>' : '';
      const sharesTitle = !Number.isFinite(h.shares) ? 'Shares held were not recorded in this snapshot'
        : !Number.isFinite(sharesChange) ? `${this._formatEtfShares(h.shares)} shares held · No previous quantity available`
        : `Previous: ${this._formatEtfShares(h.previous_shares)} · Change: ${sharesChange > 0 ? '+' : ''}${this._formatEtfShares(sharesChange)} shares`;
      const change = h.rank_change;
      const trend = change == null ? (meta?.previous_as_of ? '<span class="trend-new">NEW</span>' : '<span class="etf-flat">—</span>')
        : change > 0 ? `<span class="etf-up" aria-label="Up ${change} ranks">↑ ${change}</span>`
        : change < 0 ? `<span class="etf-down" aria-label="Down ${-change} ranks">↓ ${-change}</span>`
        : '<span class="etf-flat" aria-label="Rank unchanged">—</span>';
      return `<tr data-ticker="${chartTicker}">
        <td class="rank-cell">${h.rank}</td>
        <td title="${name}">${name}</td>
        <td class="ticker-cell">${isPrivate ? '<span class="etf-flat" title="Private holding: no public price chart">Private</span>' : `<a href="#" title="View ${ticker} price chart">${ticker}</a>`}</td>
        <td class="etf-weight ${weightClass}" title="${this._esc(weightTitle)}">${weight.toFixed(2)}%${weightTrend}</td>
        <td class="etf-shares ${sharesClass}" title="${this._esc(sharesTitle)}">${this._formatEtfShares(h.shares)}${sharesTrend}</td>
        <td class="etf-change-cell">${trend}<button class="etf-history-btn" type="button" data-ticker="${ticker}" title="View ${name} shares held history" aria-label="View ${name} shares held history"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v18h18M7 16l4-8 4 4 4-6"/></svg></button></td>
      </tr>`;
    }).join('');
  },

  /**
   * Render earnings table for today or upcoming.
   * @param {'today'|'week'} window
   */
  renderEarningsTable(window) {
    const data = window === 'today' ? this.earningsTodayData : this.earningsWeekData;
    const tbodyId = window === 'today' ? 'earningsTodayBody' : 'earningsWeekBody';
    const tbody = document.getElementById(tbodyId);
    if (!tbody) return;

    if (!Array.isArray(data) || data.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="4" style="text-align: center; padding: var(--space-8); color: var(--color-text-tertiary);">
            ${window === 'today' ? 'No earnings scheduled for today.' : 'No upcoming earnings in the next 10 trading days.'}
          </td>
        </tr>
      `;
      return;
    }

    // Calculate days to earnings from date
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    tbody.innerHTML = data.map(item => {
      const ticker = this._esc(item.symbol || '—');
      const company = this._esc(item.name || '—');
      const earningsDate = item.earnings_date || '—';
      
      // Calculate days to earnings dynamically
      let daysToEarnings = 0;
      try {
        const earningsDateObj = new Date(earningsDate + 'T00:00:00');
        const diffTime = earningsDateObj.getTime() - today.getTime();
        daysToEarnings = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
      } catch {}
      
      // Format date nicely
      let formattedDate = earningsDate;
      try {
        const dateObj = new Date(earningsDate + 'T00:00:00');
        formattedDate = dateObj.toLocaleDateString('en-US', { 
          month: 'short', day: 'numeric', year: 'numeric' 
        });
      } catch {}
      
      // Days pill class
      let daysClass = 'later';
      if (daysToEarnings === 0) daysClass = 'today';
      else if (daysToEarnings <= 3) daysClass = 'soon';
      
      return `
        <tr data-ticker="${ticker}">
          <td class="ticker-cell"><a href="#" title="View ${ticker} details">${ticker}</a></td>
          <td class="company-cell">${company}</td>
          <td class="date-cell">${formattedDate}</td>
          <td class="days-cell"><span class="days-pill ${daysClass}">${daysToEarnings === 0 ? 'Today' : daysToEarnings + 'd'}</span></td>
        </tr>
      `;
    }).join('');
  },

  /**
   * Whether a Swing row passes its table's active client-side filters.
   * @param {Object} item - board row with range/signal enum
   * @param {'vah'|'val'} kind - which table the row is rendered in
   */
  _swingVisible(item, kind) {
    const f = (this.swingFilter && this.swingFilter[kind]) || { range: 'ALL', signal: 'ALL' };
    if (f.range !== 'ALL' && (item.range || '3M') !== f.range) return false;
    if (f.signal !== 'ALL' && (item.signal || '') !== f.signal) return false;
    return true;
  },

  /** Signal pill text for Swing signal enums. */
  _swingSignalText(signal) {
    return {
      'crossed-above': 'Crossed above', 'held-above': 'Held above',
      'crossed-below': 'Crossed below', 'held-below': 'Held below',
      bounced: 'Bounced',
    }[signal] || 'Bounced';
  },

  /**
   * Render one table's Swing filter bar (range + its own 4 signals),
   * mirroring the quality-score filter bar pattern.
   * @param {'vah'|'val'} kind
   */
  renderSwingFilterBar(kind) {
    const isVah = kind !== 'val';
    const bar = document.getElementById(isVah ? 'swingVahFilters' : 'swingValFilters');
    if (!bar) return;
    const rows = isVah
      ? (Array.isArray(this.swingVahData) ? this.swingVahData : [])
      : (Array.isArray(this.swingValData) ? this.swingValData : []);
    if (!rows.length) { bar.innerHTML = ''; bar.classList.remove('open'); return; }

    const f = this.swingFilter[kind];
    const signals = isVah
      ? ['crossed-above', 'held-above', 'crossed-below', 'bounced']
      : ['crossed-below', 'held-below', 'crossed-above', 'bounced'];
    const rangeCount = { '3M': 0, '6M': 0 };
    const sigCount = {};
    for (const r of rows) {
      rangeCount[r.range || '3M'] = (rangeCount[r.range || '3M'] || 0) + 1;
      sigCount[r.signal] = (sigCount[r.signal] || 0) + 1;
    }
    const chip = (group, value, label, n) => {
      if (!n) return '';
      const active = f[group] === value;
      return `<button class="qs-chip" data-swing-kind="${kind}" data-swing-group="${group}" data-swing-value="${value}" aria-pressed="${active}"`
        + ` aria-label="Show only ${label}">${label} <b>${n}</b></button>`;
    };
    const visible = rows.filter((r) => this._swingVisible(r, kind)).length;
    const activeCount = (f.range !== 'ALL' ? 1 : 0) + (f.signal !== 'ALL' ? 1 : 0);
    const open = !!this._swingFiltersOpen[kind];
    bar.innerHTML = `<button class="qs-filter-toggle" data-swing-toggle="${kind}" aria-expanded="${open}" aria-controls="swingFilterOptions-${kind}">`
      + `<span>Filters <span class="qs-filter-count${activeCount ? '' : ' is-zero'}">${activeCount}</span></span>`
      + `<svg class="qs-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg></button>`
      + `<span class="qs-showing">Showing ${visible} of ${rows.length}</span>`
      + `<div class="qs-filter-options" id="swingFilterOptions-${kind}"><span class="qs-filter-label">Show:</span>`
      + `${chip('range', '3M', '3M', rangeCount['3M'] || 0)}${chip('range', '6M', '6M', rangeCount['6M'] || 0)}`
      + `${signals.map((s) => chip('signal', s, this._swingSignalText(s), sigCount[s] || 0)).join('')}`
      + `${activeCount ? '<button class="qs-chip qs-chip-reset" data-swing-reset>Reset</button>' : ''}</div>`;
    bar.classList.toggle('open', open);
    if (!bar.dataset.bound) {
      bar.dataset.bound = 'true';
      bar.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;
        const k = btn.dataset.swingKind || kind;
        if (btn.hasAttribute('data-swing-toggle')) {
          this._swingFiltersOpen[k] = !this._swingFiltersOpen[k];
          bar.classList.toggle('open', this._swingFiltersOpen[k]);
          btn.setAttribute('aria-expanded', String(this._swingFiltersOpen[k]));
          return;
        }
        if (btn.hasAttribute('data-swing-reset')) {
          this.swingFilter[k] = { range: 'ALL', signal: 'ALL' };
        } else if (btn.dataset.swingGroup) {
          const g = btn.dataset.swingGroup;
          const v = btn.dataset.swingValue;
          this.swingFilter[k][g] = this.swingFilter[k][g] === v ? 'ALL' : v;
        } else {
          return;
        }
        this.renderSwingTable(k);
      });
    }
  },

  /**
   * Render Swing table for VAH or VAL touches.
   * @param {'vah'|'val'} kind
   */
  renderSwingTable(kind) {
    const isVah = kind !== 'val';
    const data = isVah ? this.swingVahData : this.swingValData;
    const tbody = document.getElementById(isVah ? 'swingVahBody' : 'swingValBody');
    if (!tbody) return;
    this.renderSwingFilterBar(kind);

    if (!Array.isArray(data) || data.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="5" style="text-align: center; padding: var(--space-8); color: var(--color-text-tertiary);">
            ${isVah ? 'No VAH touches today.' : 'No VAL touches today.'}
          </td>
        </tr>
      `;
      return;
    }

    const visible = data.filter((item) => this._swingVisible(item, kind));
    if (!visible.length) {
      tbody.innerHTML = `
        <tr>
          <td colspan="5" style="text-align: center; padding: var(--space-8); color: var(--color-text-tertiary);">
            No ${isVah ? 'VAH' : 'VAL'} touches match the current filters.
            <button class="qs-chip qs-chip-reset" data-swing-empty-reset>Reset filters</button>
          </td>
        </tr>
      `;
      tbody.querySelector('[data-swing-empty-reset]')?.addEventListener('click', () => {
        this.swingFilter[kind] = { range: 'ALL', signal: 'ALL' };
        this.renderSwingTable(kind);
      }, { once: true });
      return;
    }

    const fmt = (n) => (Number.isFinite(Number(n)) ? Number(n).toFixed(2) : '—');
    tbody.innerHTML = visible.map((item) => {
      const ticker = this._esc(item.ticker || '—');
      const company = this._esc(item.company || '—');
      const level = fmt(item.level);
      const rangeText = this._esc(item.range || '3M');
      // Outcome-based color, same above/below convention as 200 SMA:
      // bullish outcomes (close beyond level to the upside) green.
      const pillClass = isVah
        ? (Number(item.close) > Number(item.level) ? 'above' : 'below')
        : (Number(item.close) < Number(item.level) ? 'below' : 'above');
      const pillText = this._swingSignalText(item.signal);
      const range = `${fmt(item.high)} / ${fmt(item.low)} / ${fmt(item.close)}`;
      return `
        <tr data-ticker="${ticker}">
          <td class="ticker-cell"><a href="#" title="View ${ticker} details">${ticker}</a></td>
          <td class="company-cell">${company}</td>
          <td class="date-cell">$${level}<span class="range-pill">${rangeText}</span></td>
          <td class="days-cell"><span class="position-badge ${pillClass}">${pillText}</span></td>
          <td class="date-cell" title="High / Low / Close">${range}</td>
        </tr>
      `;
    }).join('');
  },

  /**
   * Canonical Status for a Trade row: {key, text} where key is the
   * filterable status ('10:45' pre-reassessment, else the change flag).
   * @param {Object} item - board row with change/setup enums
   */
  _tradeStatusOf(item) {
    const change = item.change || 'held';
    const setup = item.setup || 'strict';
    if (setup === 'strict') return { key: '10:45', text: '10:45' };
    const abbr = setup === 'reversal' ? 'REV' : (setup === 'continuation' ? 'CONT' : '');
    if (change === 'removed') return { key: 'removed', text: 'REMOVED' };
    return { key: change, text: `${change.toUpperCase()}${abbr ? ' · ' + abbr : ''}` };
  },

  /**
   * Whether a Trade row passes its table's active status filter.
   * @param {Object} item - board row
   * @param {'long'|'short'} kind - which table the row is rendered in
   */
  _tradeVisible(item, kind) {
    const f = (this.tradeFilter && this.tradeFilter[kind]) || { status: 'ALL' };
    if (f.status !== 'ALL' && this._tradeStatusOf(item).key !== f.status) return false;
    return true;
  },

  /** Label text for Trade status filter keys. */
  _tradeStatusLabel(key) {
    return { '10:45': '10:45', new: 'New', held: 'Held', flipped: 'Flipped', removed: 'Removed' }[key] || key;
  },

  /**
   * Render one table's Trade filter bar (status chips with counts),
   * mirroring the Swing filter bar pattern.
   * @param {'long'|'short'} kind
   */
  renderTradeFilterBar(kind) {
    const isLong = kind !== 'short';
    const bar = document.getElementById(isLong ? 'tradeLongFilters' : 'tradeShortFilters');
    if (!bar) return;
    const rows = isLong
      ? (Array.isArray(this.tradeLongData) ? this.tradeLongData : [])
      : (Array.isArray(this.tradeShortData) ? this.tradeShortData : []);
    if (!rows.length) { bar.innerHTML = ''; bar.classList.remove('open'); return; }

    const f = this.tradeFilter[kind];
    const order = ['10:45', 'new', 'held', 'flipped', 'removed'];
    const statusCount = {};
    for (const r of rows) {
      const k = this._tradeStatusOf(r).key;
      statusCount[k] = (statusCount[k] || 0) + 1;
    }
    const chip = (value) => {
      const n = statusCount[value] || 0;
      if (!n) return '';
      const active = f.status === value;
      const label = this._tradeStatusLabel(value);
      return `<button class="qs-chip" data-trade-kind="${kind}" data-trade-value="${value}" aria-pressed="${active}"`
        + ` aria-label="Show only ${label}">${label} <b>${n}</b></button>`;
    };
    const visible = rows.filter((r) => this._tradeVisible(r, kind)).length;
    const activeCount = f.status !== 'ALL' ? 1 : 0;
    const open = !!this._tradeFiltersOpen[kind];
    bar.innerHTML = `<button class="qs-filter-toggle" data-trade-toggle="${kind}" aria-expanded="${open}" aria-controls="tradeFilterOptions-${kind}">`
      + `<span>Filters <span class="qs-filter-count${activeCount ? '' : ' is-zero'}">${activeCount}</span></span>`
      + `<svg class="qs-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg></button>`
      + `<span class="qs-showing">Showing ${visible} of ${rows.length}</span>`
      + `<div class="qs-filter-options" id="tradeFilterOptions-${kind}"><span class="qs-filter-label">Show:</span>`
      + `${order.map(chip).join('')}`
      + `${activeCount ? '<button class="qs-chip qs-chip-reset" data-trade-reset>Reset</button>' : ''}</div>`;
    bar.classList.toggle('open', open);
    if (!bar.dataset.bound) {
      bar.dataset.bound = 'true';
      bar.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;
        const k = btn.dataset.tradeKind || kind;
        if (btn.hasAttribute('data-trade-toggle')) {
          this._tradeFiltersOpen[k] = !this._tradeFiltersOpen[k];
          bar.classList.toggle('open', this._tradeFiltersOpen[k]);
          btn.setAttribute('aria-expanded', String(this._tradeFiltersOpen[k]));
          return;
        }
        if (btn.hasAttribute('data-trade-reset')) {
          this.tradeFilter[k] = { status: 'ALL' };
        } else if (btn.dataset.tradeValue) {
          const v = btn.dataset.tradeValue;
          this.tradeFilter[k].status = this.tradeFilter[k].status === v ? 'ALL' : v;
        } else {
          return;
        }
        this.renderTradeTable(k);
      });
    }
  },

  /**
   * Render Trade table for ORB long breakouts or short breakdowns.
   * Columns: Ticker | Company | ORBH/ORBL | 10:30 Close | Status.
   * Status shows the 10:45 baseline vs 11:35 checkpoint change
   * (10:45 before the reassessment lands; NEW/HELD/FLIPPED/REMOVED
   * with REV/CONT setup after). Removed rows render dimmed.
   * @param {'long'|'short'} kind
   */
  renderTradeTable(kind) {
    const isLong = kind !== 'short';
    const data = isLong ? this.tradeLongData : this.tradeShortData;
    const tbody = document.getElementById(isLong ? 'tradeLongBody' : 'tradeShortBody');
    if (!tbody) return;
    this.renderTradeFilterBar(kind);

    if (!Array.isArray(data) || data.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="5" style="text-align: center; padding: var(--space-8); color: var(--color-text-tertiary);">
            ${isLong ? 'No ORB longs today.' : 'No ORB shorts today.'}
          </td>
        </tr>
      `;
      return;
    }

    const visible = data.filter((item) => this._tradeVisible(item, kind));
    if (!visible.length) {
      tbody.innerHTML = `
        <tr>
          <td colspan="5" style="text-align: center; padding: var(--space-8); color: var(--color-text-tertiary);">
            No ORB ${isLong ? 'longs' : 'shorts'} match the current filters.
            <button class="qs-chip qs-chip-reset" data-trade-empty-reset>Reset filters</button>
          </td>
        </tr>
      `;
      tbody.querySelector('[data-trade-empty-reset]')?.addEventListener('click', () => {
        this.tradeFilter[kind] = { status: 'ALL' };
        this.renderTradeTable(kind);
      }, { once: true });
      return;
    }

    const fmt = (n) => (Number.isFinite(Number(n)) ? Number(n).toFixed(2) : '—');
    tbody.innerHTML = visible.map((item) => {
      const ticker = this._esc(item.ticker || '—');
      const company = this._esc(item.company || '—');
      const level = fmt(isLong ? item.orb_high : item.orb_low);
      const confirm = fmt(item.confirm_close);
      const status = this._tradeStatusOf(item).text;
      const change = this._esc(item.change || 'held');
      return `
        <tr data-ticker="${ticker}" data-change="${change}">
          <td class="ticker-cell"><a href="#" title="View ${ticker} details">${ticker}</a></td>
          <td class="company-cell">${company}</td>
          <td class="date-cell">$${level}</td>
          <td class="days-cell">$${confirm}</td>
          <td class="days-cell"><span class="trade-status">${this._esc(status)}</span></td>
        </tr>
      `;
    }).join('');
  },

  /**
   * Render trend indicator HTML for a ranking item.
   *
   * @param {Object} item - Ranking item with trend_direction and trend_change
   * @returns {string} HTML string for the trend cell
   */
  _renderTrend(item) {
    const direction = item.trend_direction || 'new';
    const change = item.trend_change || 0;

    switch (direction) {
      case 'up':
        return `
          <span class="trend-up">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="18 15 12 9 6 15"/></svg>
            ${change}
          </span>
        `;
      case 'down':
        return `
          <span class="trend-down">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
            ${change}
          </span>
        `;
      case 'flat':
        return `<span class="trend-flat">flat</span>`;
      case 'new':
      default:
        return `<span class="trend-new">NEW</span>`;
    }
  },

  /**
   * Update the stock count displayed in each panel header.
   */
  updatePanelCounts() {
    const momentumCount = document.getElementById('momentumCount');
    const reversalCount = document.getElementById('reversalCount');
    const sma200Count = document.getElementById('sma200Count');

    if (momentumCount) {
      const totalRows = this.momentumRankings.length;
      const belowRows = (this.momentumBelow || []).length;
      momentumCount.textContent = `${totalRows} stock${totalRows !== 1 ? 's' : ''}` + (belowRows > 0 ? ` + ${belowRows} below` : '');
    }

    if (reversalCount) {
      const totalRows = this.reversalRankings.length;
      const belowRows = (this.reversalBelow || []).length;
      reversalCount.textContent = `${totalRows} stock${totalRows !== 1 ? 's' : ''}` + (belowRows > 0 ? ` + ${belowRows} below` : '');
    }

    if (sma200Count) {
      const totalRows = this.sma200Rankings.length;
      sma200Count.textContent = `${totalRows} stock${totalRows !== 1 ? 's' : ''}`;
    }

    const ytdCount = document.getElementById('ytdCount');
    if (ytdCount) {
      const totalRows = this.ytdRankings.length;
      ytdCount.textContent = `${totalRows} stock${totalRows !== 1 ? 's' : ''}`;
    }

    const qualityScoreCount = document.getElementById('qualityScoreCount');
    if (qualityScoreCount) {
      const scored = this.qualityScoreRankings.filter(r => Number.isFinite(r.score) && !r.insufficient_data).length;
      const excluded = this.qualityScoreRankings.length - scored;
      qualityScoreCount.textContent = `${scored} scored${excluded ? ` · ${excluded} N/A` : ''}`;
    }

    const earningsTodayCount = document.getElementById('earningsTodayCount');
    if (earningsTodayCount) {
      const totalRows = this.earningsTodayData.length;
      earningsTodayCount.textContent = `${totalRows} stock${totalRows !== 1 ? 's' : ''}`;
    }

    const earningsWeekCount = document.getElementById('earningsWeekCount');
    if (earningsWeekCount) {
      const totalRows = this.earningsWeekData.length;
      earningsWeekCount.textContent = `${totalRows} stock${totalRows !== 1 ? 's' : ''}`;
    }

    const swingVahCount = document.getElementById('swingVahCount');
    if (swingVahCount) {
      const totalRows = (this.swingVahData || []).length;
      swingVahCount.textContent = `${totalRows} stock${totalRows !== 1 ? 's' : ''}`;
    }

    const swingValCount = document.getElementById('swingValCount');
    if (swingValCount) {
      const totalRows = (this.swingValData || []).length;
      swingValCount.textContent = `${totalRows} stock${totalRows !== 1 ? 's' : ''}`;
    }

    const swingStatus = document.getElementById('swingStatus');
    if (swingStatus) {
      const session = this.swingMeta && this.swingMeta.session_date;
      swingStatus.textContent = session
        ? `Fresh daily after 4:30 PM ET · as of ${session} · 3m + 6m levels`
        : 'Fresh daily after 4:30 PM ET · 3m + 6m levels';
    }

    const tradeLongCount = document.getElementById('tradeLongCount');
    if (tradeLongCount) {
      const totalRows = (this.tradeLongData || []).length;
      tradeLongCount.textContent = `${totalRows} stock${totalRows !== 1 ? 's' : ''}`;
    }

    const tradeShortCount = document.getElementById('tradeShortCount');
    if (tradeShortCount) {
      const totalRows = (this.tradeShortData || []).length;
      tradeShortCount.textContent = `${totalRows} stock${totalRows !== 1 ? 's' : ''}`;
    }

    const tradeStatus = document.getElementById('tradeStatus');
    if (tradeStatus) {
      const session = this.tradeMeta && this.tradeMeta.session_date;
      const counts = (this.tradeMeta && this.tradeMeta.counts) || {};
      let text = session
        ? `Fresh daily after 10:45 AM ET · as of ${session} · ORB 9:30–9:45 + 10:15–10:30 close`
        : 'Fresh daily after 10:45 AM ET · ORB 9:30–9:45 + 10:15–10:30 close';
      text += counts.decided ? ' · 11:35 checkpoints assessed' : ' · 11:35 reassessment pending';
      if (counts.removed) text += ` · ${counts.removed} removed since 10:45`;
      tradeStatus.textContent = text;
    }
  },

  // ─── CACHE ───────────────────────────────────────────

  /**
   * Save current rankings to localStorage cache.
   */
  _saveCache() {
    try {
      const cache = {
        momentumRankings: this.momentumRankings,
        momentumBelow: this.momentumBelow,
        reversalRankings: this.reversalRankings,
        reversalBelow: this.reversalBelow,
        sma200Rankings: this.sma200Rankings,
        ytdRankings: this.ytdRankings,
        qualityScoreRankings: this.qualityScoreRankings,
        qualityScoreModel: QUALITY_MODEL,
        qualityScoreMeta: this.qualityScoreMeta,
        earningsTodayData: this.earningsTodayData,
        earningsWeekData: this.earningsWeekData,
        swingVahData: this.swingVahData,
        swingValData: this.swingValData,
        swingMeta: this.swingMeta,
        tradeLongData: this.tradeLongData,
        tradeShortData: this.tradeShortData,
        tradeMeta: this.tradeMeta,
        universeSize: this.universeSize,
        lastScanCompletedAt: this.lastScanCompletedAt,
        timestamp: Date.now(),
      };
      localStorage.setItem(this._cacheKey, JSON.stringify(cache));
    } catch (e) { /* quota exceeded or private browsing */ }
  },

  /**
   * Restore rankings from localStorage cache.
   * @returns {boolean} true if cache was restored
   */
  _restoreCache() {
    try {
      const raw = localStorage.getItem(this._cacheKey);
      if (!raw) return false;
      const cache = JSON.parse(raw);
      if (!cache) return false;

      // Split cached rows into qualified + grey below-threshold sections.
      // Legacy caches predate the below_threshold flag — fall back to the
      // score threshold so old entries still split correctly.
      const splitCached = (rankings, below) => {
        if (Array.isArray(below)) {
          return {
            qualified: Array.isArray(rankings) ? rankings : [],
            below,
          };
        }
        return this._splitBoard(rankings);
      };

      const momentum = splitCached(cache.momentumRankings, cache.momentumBelow);
      this.momentumRankings = momentum.qualified;
      this.momentumBelow = momentum.below;
      const reversal = splitCached(cache.reversalRankings, cache.reversalBelow);
      this.reversalRankings = reversal.qualified;
      this.reversalBelow = reversal.below;
      this.sma200Rankings = cache.sma200Rankings || [];
      this.ytdRankings = cache.ytdRankings || [];
      this.qualityScoreRankings = cache.qualityScoreModel === QUALITY_MODEL ? (cache.qualityScoreRankings || []) : [];
      this.qualityScoreMeta = cache.qualityScoreModel === QUALITY_MODEL ? (cache.qualityScoreMeta || null) : null;
      this.earningsTodayData = cache.earningsTodayData || [];
      this.earningsWeekData = cache.earningsWeekData || [];
      this.swingVahData = cache.swingVahData || [];
      this.swingValData = cache.swingValData || [];
      this.swingMeta = cache.swingMeta || null;
      const currentTrade = cache.tradeMeta?.session_date === this._todayET();
      this.tradeLongData = currentTrade ? (cache.tradeLongData || []) : [];
      this.tradeShortData = currentTrade ? (cache.tradeShortData || []) : [];
      this.tradeMeta = currentTrade ? cache.tradeMeta : null;
      this.universeSize = cache.universeSize || 0;
      this.lastScanCompletedAt = cache.lastScanCompletedAt || null;

      return (this.momentumRankings.length > 0 || this.reversalRankings.length > 0 || this.sma200Rankings.length > 0 || this.ytdRankings.length > 0 || this.qualityScoreRankings.length > 0);
    } catch (e) { return false; }
  },

  // ─── UI UPDATES ──────────────────────────────────────

  /**
   * Update the universe count display in the controls bar.
   */
  updateUniverseBadge() {
    const universeCount = document.getElementById('universeCount');
    if (universeCount) {
      universeCount.textContent = this.universeSize > 0 ? this.universeSize : '--';
    }
  },

  /**
   * Update the "Last scan" timestamp display.
   * Uses the actual scan completion timestamp from the API response,
   * falling back to cache timestamp if available.
   */
  updateLastScanTime() {
    const el = document.getElementById('lastScanText');
    if (!el) return;

    // Prefer the scan completion timestamp from the API response
    if (this.lastScanCompletedAt) {
      try {
        const scanDate = new Date(this.lastScanCompletedAt);
        const timeStr = scanDate.toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
          timeZone: 'America/New_York',
        });
        el.textContent = `Last scan: Today, ${timeStr} EST`;
      } catch {
        // Invalid date — fall back to cache timestamp
        this._updateLastScanTimeFromCache(el);
      }
      return;
    }

    // Fallback: try to use the cache timestamp (when loaded from localStorage)
    this._updateLastScanTimeFromCache(el);
  },

  /**
   * Fallback: show "Last scan" time from the localStorage cache timestamp.
   * @param {HTMLElement} el
   */
  _updateLastScanTimeFromCache(el) {
    try {
      const raw = localStorage.getItem(this._cacheKey);
      if (raw) {
        const cache = JSON.parse(raw);
        if (cache && cache.timestamp) {
          const cacheDate = new Date(cache.timestamp);
          const timeStr = cacheDate.toLocaleTimeString('en-US', {
            hour: 'numeric',
            minute: '2-digit',
            hour12: true,
            timeZone: 'America/New_York',
          });
          el.textContent = `Last scan: Today, ${timeStr} EST`;
          return;
        }
      }
    } catch {
      // Ignore parse errors
    }

    // No scan data available
    el.textContent = 'Last scan: Never';
  },

  // ─── UI HELPERS ──────────────────────────────────────

  showLoading() {
    const momentumLoading = document.getElementById('momentumLoading');
    const reversalLoading = document.getElementById('reversalLoading');
    const sma200Loading = document.getElementById('sma200Loading');
    const ytdLoading = document.getElementById('ytdLoading');
    const qualityScoreLoading = document.getElementById('qualityScoreLoading');
    const earningsTodayLoading = document.getElementById('earningsTodayLoading');
    const earningsWeekLoading = document.getElementById('earningsWeekLoading');
    if (momentumLoading) momentumLoading.classList.add('visible');
    if (reversalLoading) reversalLoading.classList.add('visible');
    if (sma200Loading) sma200Loading.classList.add('visible');
    if (ytdLoading) ytdLoading.classList.add('visible');
    if (qualityScoreLoading) qualityScoreLoading.classList.add('visible');
    if (earningsTodayLoading) earningsTodayLoading.classList.add('visible');
    if (earningsWeekLoading) earningsWeekLoading.classList.add('visible');
    const swingVahLoading = document.getElementById('swingVahLoading');
    const swingValLoading = document.getElementById('swingValLoading');
    if (swingVahLoading) swingVahLoading.classList.add('visible');
    if (swingValLoading) swingValLoading.classList.add('visible');
    const tradeLongLoading = document.getElementById('tradeLongLoading');
    const tradeShortLoading = document.getElementById('tradeShortLoading');
    if (tradeLongLoading) tradeLongLoading.classList.add('visible');
    if (tradeShortLoading) tradeShortLoading.classList.add('visible');
  },

  hideLoading() {
    const momentumLoading = document.getElementById('momentumLoading');
    const reversalLoading = document.getElementById('reversalLoading');
    const sma200Loading = document.getElementById('sma200Loading');
    const ytdLoading = document.getElementById('ytdLoading');
    const qualityScoreLoading = document.getElementById('qualityScoreLoading');
    const earningsTodayLoading = document.getElementById('earningsTodayLoading');
    const earningsWeekLoading = document.getElementById('earningsWeekLoading');
    if (momentumLoading) momentumLoading.classList.remove('visible');
    if (reversalLoading) reversalLoading.classList.remove('visible');
    if (sma200Loading) sma200Loading.classList.remove('visible');
    if (ytdLoading) ytdLoading.classList.remove('visible');
    if (qualityScoreLoading) qualityScoreLoading.classList.remove('visible');
    if (earningsTodayLoading) earningsTodayLoading.classList.remove('visible');
    if (earningsWeekLoading) earningsWeekLoading.classList.remove('visible');
    const swingVahLoading = document.getElementById('swingVahLoading');
    const swingValLoading = document.getElementById('swingValLoading');
    if (swingVahLoading) swingVahLoading.classList.remove('visible');
    if (swingValLoading) swingValLoading.classList.remove('visible');
    const tradeLongLoading = document.getElementById('tradeLongLoading');
    const tradeShortLoading = document.getElementById('tradeShortLoading');
    if (tradeLongLoading) tradeLongLoading.classList.remove('visible');
    if (tradeShortLoading) tradeShortLoading.classList.remove('visible');
  },

  showError(message) {
    const banner = document.getElementById('errorBanner');
    const title = document.getElementById('errorTitle');
    const desc = document.getElementById('errorDesc');
    if (banner) banner.classList.add('visible');
    if (title) title.textContent = 'Scan failed';
    if (desc) desc.textContent = message || 'An error occurred while running the scan.';
  },

  hideError() {
    const banner = document.getElementById('errorBanner');
    if (banner) banner.classList.remove('visible');
  },

  showEmpty() {
    const empty = document.getElementById('emptyState');
    const board = document.getElementById('rankingBoard');
    if (empty) empty.classList.add('visible');
    if (board) board.style.display = 'none';
  },

  hideEmpty() {
    const empty = document.getElementById('emptyState');
    const board = document.getElementById('rankingBoard');
    if (empty) empty.classList.remove('visible');
    if (board) board.style.display = '';
  },

  // ─── UTILITY ─────────────────────────────────────────

  /**
   * Escape HTML to prevent XSS.
   *
   * @param {string} str
   * @returns {string}
   */
  _esc(str) {
    if (typeof str !== 'string') return String(str);
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  },
};

// ES module export for app.js dynamic import
export default Scanner;

// CommonJS fallback (for Node/testing)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = Scanner;
}
