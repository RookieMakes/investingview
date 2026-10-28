/**
 * Trade — Trade analysis screen module.
 *
 * Provides swing and position trade analysis for individual stocks.
 * Renders full multi-factor analysis results including EMAs, patterns,
 * support/resistance, Weinstein stage, fundamentals, and scoring.
 *
 * API endpoints:
 *   POST /api/trade/analyze    — run a trade analysis
 *   GET  /api/trade/history    — list past analyses
 *   DELETE /api/trade/history  — clear all history
 *
 * @example
 *   // Called by App.loadScreen('trade')
 *   Trade.init();
 */

import ChartModal from '../components/chart-modal.js';

const Trade = {
  /** @type {Object|null} Latest analysis result data */
  data: null,

  /** @type {boolean} */
  loading: false,

  /** @type {Array<Object>} Analysis history entries */
  history: [],

  /** @type {string} Active trade type: 'swing' | 'position' */
  tradeType: 'swing',

  /** @type {AbortController|null} For cancelling in-flight requests */
  _abortController: null,

  /** @type {number|null} Loading message interval ID */
  _loadingMsgInterval: null,

  _generation: 0,
  _active: false,
  _historyController: null,

  // ─── LOADING MESSAGES ─────────────────────────────

  /** @type {string[]} Messages to cycle through during loading */
  _loadingMessages: [
    'Fetching price history...',
    'Computing EMAs...',
    'Calculating weekly EMAs...',
    'Detecting candlestick patterns...',
    'Analyzing Weinstein stage...',
    'Scoring multi-factor criteria...',
    'Assembling analysis report...',
  ],

  // ─── INITIALIZATION ───────────────────────────────

  /**
   * Initialize the Trade screen.
   */
  async init() {
    console.log('[Trade] initialized');
    this._generation += 1;
    this._active = true;
    this.setLoading(false);
    this.bindEvents();
    this._syncToggleButton(this.tradeType);
    await this.loadHistory();
  },

  // ─── EVENT BINDING ────────────────────────────────

  /**
   * Bind screen-specific event listeners.
   */
  bindEvents() {
    ChartModal.bind();
    // Analyze button
    const analyzeBtn = document.getElementById('trade-analyze-btn');
    if (analyzeBtn) {
      analyzeBtn.addEventListener('click', () => {
        const input = document.getElementById('trade-ticker-input');
        const ticker = input ? input.value.trim().toUpperCase() : '';
        if (ticker) {
          this.analyze(ticker, this.tradeType);
        } else if (input) {
          input.focus();
        }
      });
    }

    // Ticker input: auto-uppercase, max 6 chars, enter to analyze
    const tickerInput = document.getElementById('trade-ticker-input');
    if (tickerInput) {
      tickerInput.addEventListener('input', (e) => {
        e.target.value = e.target.value.toUpperCase().slice(0, 6);
      });
      tickerInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          const ticker = tickerInput.value.trim().toUpperCase();
          if (ticker) this.analyze(ticker, this.tradeType);
        }
      });
    }

    // Trade type toggle
    const segmentBtns = document.querySelectorAll('#trade-screen .segment-btn');
    segmentBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        segmentBtns.forEach((b) => {
          b.classList.remove('active');
          b.setAttribute('aria-checked', 'false');
        });
        btn.classList.add('active');
        btn.setAttribute('aria-checked', 'true');
        this.tradeType = btn.dataset.type || 'swing';
      });
    });

    // Clear history button
    const clearBtn = document.getElementById('trade-clear-history-btn');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => this.clearHistory());
    }

    // History list delegation: collapse/expand groups and re-analyze clicks
    const historyList = document.getElementById('trade-history-list');
    if (historyList) {
      historyList.addEventListener('click', (e) => {
        // Re-analyze button
        const reanalyzeBtn = e.target.closest('.reanalyze-btn');
        if (reanalyzeBtn) {
          e.stopPropagation();
          const ticker = reanalyzeBtn.dataset.ticker;
          const tradeType = reanalyzeBtn.dataset.tradeType;
          if (ticker) {
            // Set the input and toggle
            const input = document.getElementById('trade-ticker-input');
            if (input) input.value = ticker.toUpperCase();
            this.tradeType = tradeType || 'swing';
            this._syncToggleButton(this.tradeType);
            this.analyze(ticker.toUpperCase(), this.tradeType);
          }
          return;
        }

        // Group header collapse/expand
        const groupHeader = e.target.closest('.history-group-header');
        if (groupHeader) {
          groupHeader.classList.toggle('collapsed');
          groupHeader.querySelectorAll('[aria-expanded]').forEach(button => {
            button.setAttribute('aria-expanded', String(!groupHeader.classList.contains('collapsed')));
          });
          const entries = groupHeader.nextElementSibling;
          if (entries) {
            entries.style.display = groupHeader.classList.contains('collapsed') ? 'none' : '';
          }
        }
      });
    }
  },

  // ─── ANALYSIS ─────────────────────────────────────

  /**
   * Run a trade analysis for the given ticker and type.
   *
   * @param {string} ticker
   * @param {string} tradeType - 'swing' or 'position'
   */
  async analyze(ticker, tradeType) {
    if (this.loading) return;
    if (!ticker) return;

    // Cancel any previous request
    if (this._abortController) {
      this._abortController.abort();
    }
    const controller = new AbortController();
    const generation = this._generation;
    this._abortController = controller;

    this.hideError();
    this.setLoading(true, ticker);

    try {
      const result = await API.post(
        '/trade/analyze',
        { ticker: ticker.toUpperCase(), trade_type: tradeType },
        controller.signal
      );

      if (controller.signal.aborted || generation !== this._generation || !this._active) return;

      this.data = result;
      this.setLoading(false);
      this._setStatus('done', `Analysis complete \u2014 ${ticker.toUpperCase()} (${tradeType === 'swing' ? 'Swing' : 'Position'})`);

      // Render results
      if (tradeType === 'position') {
        this.renderPositionResults(result);
      } else {
        this.renderSwingResults(result);
      }

      // Hide empty state
      const emptyState = document.getElementById('trade-empty-state');
      if (emptyState) emptyState.style.display = 'none';

      // Reload history
      await this.loadHistory();
    } catch (err) {
      if (generation !== this._generation || !this._active) return;
      if (err.message === 'Request cancelled') return;
      this.setLoading(false);
      this._setStatus('error', 'Analysis failed');
      this.showError(err.message || 'Analysis failed. Please try again.');
    } finally {
      if (this._abortController === controller) {
        this._abortController = null;
        this.setLoading(false);
      }
    }
  },

  // ─── RENDER SWING RESULTS ─────────────────────────

  /**
   * Render swing trade analysis results.
   * @param {Object} d - Analysis data from API
   */
  renderSwingResults(d) {
    const container = document.getElementById('trade-results-area');
    if (!container) return;

    d = this._displayData(d);
    const support = this._fieldNumber(d, 'support_price', 'support');
    const resistance = this._fieldNumber(d, 'resistance_price', 'resistance');
    const priceVsSupport = this._fieldNumber(d, 'price_vs_support_pct', 'price_vs_support');
    const closePosition = this._fieldNumber(d, 'close_position_pct', 'close_position');
    const emas = d.daily_emas || this._legacyEmas(d, ['ema_20', 'ema_50', 'ema_200']);

    // Build pattern object from separate name/context fields
    const pattern = d.pattern ? { name: d.pattern, context: d.pattern_context || '', sentiment: d.pattern_sentiment } : null;

    // Build risk factors array from flat fields
    const riskFactors = [];
    if (d.earnings_check) riskFactors.push({ label: 'Earnings', value: d.earnings_check.description, warning: ['unknown', 'upcoming'].includes(d.earnings_check.status) });
    else if (d.earnings_near) riskFactors.push({ label: 'Earnings', value: d.earnings || 'Within holding window', warning: true });
    if (d.key_risk) riskFactors.push({ label: 'Key Risk', value: d.key_risk, warning: true });

    const scorePct = d.max_score > 0 ? Math.round((d.score / d.max_score) * 100) : 0;
    const barPct = Math.max(0, Math.min(100, scorePct));
    const scoreClass = scorePct >= 60 ? 'high' : scorePct >= 40 ? 'medium' : 'low';
    const verdictClass = (d.verdict || '').toUpperCase() === 'YES' ? 'yes'
      : (d.verdict || '').toUpperCase() === 'WATCH' ? 'watch' : 'no';
    const verdictLabel = d.verdict || 'NO';

    const emasHtml = this._renderEmas(emas);
    const patternHtml = this._renderPattern(pattern);
    const levelsHtml = this._renderLevels(support, resistance, priceVsSupport, d.vol_ratio, d.day_range);
    const riskHtml = this._renderRisk(riskFactors);
    const reasonsHtml = this._renderReasons(d.reasons || []);

    container.innerHTML = `
      <!-- Identity Card -->
      <div class="identity-card">
        <div class="identity-left">
          <div>
            <div class="identity-ticker">${ChartModal.button(d.ticker, d.company).outerHTML}</div>
            <div class="identity-company">${this._esc(d.company || '')}</div>
            <div class="identity-sector">${this._esc(d.sector || '')}</div>
            ${this._renderSnapshot(d)}
          </div>
        </div>
        <div class="identity-right">
          <div class="identity-price">${d.current_price || ''}</div>
          <span class="verdict-badge ${verdictClass}" aria-label="Verdict: ${this._esc(verdictLabel)}">${this._esc(verdictLabel)}</span>
        </div>
      </div>

      <!-- Metrics Row -->
      <div class="metrics-row">
        <div class="metric-item">
          <div class="metric-label">Analysis Close</div>
          <div class="metric-value">${d.current_price || '-'}</div>
        </div>
        <div class="metric-item">
          <div class="metric-label">Day %</div>
          <div class="metric-value ${this._pctClass(d.day_pct)}">${this._pctFormat(d.day_pct)}</div>
        </div>
        <div class="metric-item">
          <div class="metric-label">Week %</div>
          <div class="metric-value ${this._pctClass(d.week_pct)}">${this._pctFormat(d.week_pct)}</div>
        </div>
        <div class="metric-item">
          <div class="metric-label">Volume</div>
          <div class="metric-value">${d.vol_today != null ? d.vol_today.toLocaleString() : '-'}</div>
        </div>
        <div class="metric-item">
          <div class="metric-label">52W Range</div>
          <div class="metric-value" style="font-size: var(--font-size-xs);">${d.week_52_range || '-'}</div>
        </div>
        <div class="metric-item">
          <div class="metric-label">Close Position</div>
          <div class="metric-value">${closePosition != null ? closePosition.toFixed(0) + '%' : 'N/A'}</div>
        </div>
      </div>

      <!-- EMA Analysis -->
      <div class="analysis-card">
        <div class="card-header">
          <div class="card-title">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
            EMA Analysis
          </div>
          <span class="trade-type-badge swing">Swing</span>
        </div>
        <div class="card-body">${emasHtml}</div>
      </div>

      <!-- Pattern & Levels -->
      <div class="analysis-card">
        <div class="card-header">
          <div class="card-title">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v18h18"/><rect x="7" y="10" width="2" height="6"/><rect x="11" y="7" width="2" height="9"/><rect x="15" y="9" width="2" height="7"/></svg>
            Pattern &amp; Levels
          </div>
        </div>
        <div class="card-body">${patternHtml}${levelsHtml}${d.levels_basis ? `<div class="ema-note">${this._esc(d.levels_basis)}</div>` : ''}</div>
      </div>

      <!-- Risk Factors -->
      <div class="analysis-card">
        <div class="card-header">
          <div class="card-title">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            Risk Factors
          </div>
        </div>
        <div class="card-body">${riskHtml}</div>
      </div>

      <!-- Multi-Factor Score -->
      <div class="analysis-card">
        <div class="card-header">
          <div class="card-title">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20V10"/><path d="M18 20V4"/><path d="M6 20v-4"/></svg>
            Multi-Factor Setup Score
          </div>
        </div>
        <div class="card-body">
          <div class="score-section">
            <div class="score-header">
              <span class="score-fraction">${d.score || 0} <span style="color: var(--color-text-tertiary); font-weight: var(--font-weight-regular);">/</span> ${d.max_score || 10}</span>
              <span class="score-pct">${scorePct}%</span>
            </div>
            <div class="score-bar-track" role="progressbar" aria-valuenow="${barPct}" aria-valuemin="0" aria-valuemax="100" aria-label="Setup score: ${d.score}/${d.max_score}">
              <div class="score-bar-fill ${scoreClass}" style="width: ${barPct}%;"></div>
            </div>
          </div>
          <div class="reason-pills">${reasonsHtml}</div>
          ${this._renderScoreNote(d)}
        </div>
      </div>

      <!-- Verdict Card -->
      <div class="verdict-card ${verdictClass}">
        <div class="verdict-main ${verdictClass}">${this._esc(verdictLabel)}${verdictLabel.toUpperCase() === 'YES' ? ' \u2014 Entry Rules Met' : verdictLabel.toUpperCase() === 'WATCH' ? ' \u2014 Wait' : ' \u2014 Do Not Trade'}</div>
        <div class="verdict-details">
          ${this._renderEntryDetails(d)}
          <div class="verdict-detail">
            <span class="verdict-detail-label">Target</span>
            <span class="verdict-detail-value">${d.target || '-'}</span>
          </div>
          <div class="verdict-detail">
            <span class="verdict-detail-label">Upside</span>
            <span class="verdict-detail-value" style="color: ${this._pctColor(d.upside_pct)};">${this._pctFormat(d.upside_pct)}</span>
          </div>
          <div class="verdict-detail">
            <span class="verdict-detail-label">Timeframe</span>
            <span class="verdict-detail-value">5\u201315 sessions</span>
          </div>
          <div class="verdict-detail">
            <span class="verdict-detail-label">Key Risk</span>
            <span class="verdict-detail-value" style="color: var(--color-warning);">${this._esc(d.key_risk || '-')}</span>
          </div>
        </div>
        ${this._renderEntryChecks(d)}
        <div class="verdict-note" style="margin-top: 8px; font-size: var(--font-size-xs); color: var(--color-text-secondary); font-style: italic;">${this._esc(d.trade_note || '')}</div>
      </div>
    `;
  },

  // ─── RENDER POSITION RESULTS ──────────────────────

  /**
   * Render position trade analysis results.
   * @param {Object} d - Analysis data from API
   */
  renderPositionResults(d) {
    const container = document.getElementById('trade-results-area');
    if (!container) return;

    d = this._displayData(d);
    const support = this._fieldNumber(d, 'support_price', 'support');
    const resistance = this._fieldNumber(d, 'resistance_price', 'resistance');
    const priceVsSupport = this._fieldNumber(d, 'price_vs_support_pct', 'price_vs_support');
    const weeklyEmas = d.weekly_emas || this._legacyEmas(d, ['wema_50', 'wema_200']);
    const dailyEmas = d.daily_emas || this._legacyEmas(d, ['dema_20', 'dema_50', 'dema_200']);

    // Build weinstein object from flat fields
    const weinstein = {
      stage: d.stage_num || null,
      name: d.stage || 'N/A',
      description: d.stage_conf || '',
      confirmed: d.stage_confirmed === true
    };

    // Build fundamentals object
    const fundamentals = {
      revenue_growth: d.revenue_growth ?? null,
      earnings_growth: d.earnings_growth ?? null,
      profitability: d.profitability || 'N/A',
      balance_sheet: d.balance_sheet || 'N/A',
      institutional_ownership: d.inst_pct || 'N/A',
      profitability_status: d.profitability_status,
      balance_sheet_status: d.balance_sheet_status
    };

    // Build pattern objects from separate name/context fields
    const weeklyPattern = d.wpattern ? { name: d.wpattern, context: d.wpattern_ctx || '' } : null;
    const dailyPattern = d.dpattern ? { name: d.dpattern, context: d.dpattern_ctx || '' } : null;

    const scorePct = d.max_score > 0 ? Math.round((d.score / d.max_score) * 100) : 0;
    const barPct = Math.max(0, Math.min(100, scorePct));
    const scoreClass = scorePct >= 60 ? 'high' : scorePct >= 40 ? 'medium' : 'low';
    const verdictClass = (d.verdict || '').toUpperCase() === 'YES' ? 'yes'
      : (d.verdict || '').toUpperCase() === 'WATCH' ? 'watch' : 'no';
    const verdictLabel = d.verdict || 'NO';

    const weeklyEmasHtml = this._renderEmas(weeklyEmas);
    const dailyEmasHtml = this._renderEmas(dailyEmas);
    const weinsteinHtml = this._renderWeinstein(weinstein);
    const sectorRsHtml = this._renderSectorRs(d);
    const fundamentalsHtml = this._renderFundamentals(fundamentals);
    const srHtml = this._renderLevels(support, resistance, priceVsSupport, d.vol_ratio, d.day_range);
    const reasonsHtml = this._renderReasons(d.reasons || []);

    // Weekly pattern note
    const weeklyPatternNote = weeklyPattern
      ? `<div class="ema-note"><strong>Weekly Pattern:</strong> ${this._esc(weeklyPattern.name)}${weeklyPattern.context ? ' \u2014 ' + this._esc(weeklyPattern.context) : ''}</div>`
      : '';
    const dailyPatternNote = dailyPattern
      ? `<div class="ema-note"><strong>Daily Pattern:</strong> ${this._esc(dailyPattern.name)}${dailyPattern.context ? ' \u2014 ' + this._esc(dailyPattern.context) : ''}</div>`
      : '';

    container.innerHTML = `
      <!-- Identity Card -->
      <div class="identity-card">
        <div class="identity-left">
          <div>
            <div class="identity-ticker">${ChartModal.button(d.ticker, d.company).outerHTML}</div>
            <div class="identity-company">${this._esc(d.company || '')}</div>
            <div class="identity-sector">${this._esc(d.sector || '')}</div>
            ${this._renderSnapshot(d)}
          </div>
        </div>
        <div class="identity-right">
          <div class="identity-price">${d.current_price || ''}</div>
          <span class="verdict-badge ${verdictClass}" aria-label="Verdict: ${this._esc(verdictLabel)}">${this._esc(verdictLabel)}</span>
        </div>
      </div>

      <!-- Metrics Row (Position) -->
      <div class="metrics-row">
        <div class="metric-item">
          <div class="metric-label">Analysis Close</div>
          <div class="metric-value">${d.current_price || '-'}</div>
        </div>
        <div class="metric-item">
          <div class="metric-label">YTD %</div>
          <div class="metric-value ${this._pctClass(d.ytd_pct)}">${this._pctFormat(d.ytd_pct)}</div>
        </div>
        <div class="metric-item">
          <div class="metric-label">RS 1M</div>
          <div class="metric-value ${this._pctClass(d.rs_1m)}">${this._pctFormat(d.rs_1m, 2)}</div>
        </div>
        <div class="metric-item">
          <div class="metric-label">Stage</div>
          <div class="metric-value" style="color: ${weinstein.stage === 2 ? 'var(--color-success)' : 'var(--color-text-primary)'};">${weinstein.name || '-'}</div>
        </div>
        <div class="metric-item">
          <div class="metric-label">52W Range</div>
          <div class="metric-value" style="font-size: var(--font-size-xs);">${d.week_52_range || '-'}</div>
        </div>
        <div class="metric-item">
          <div class="metric-label">Upside %</div>
          <div class="metric-value ${this._pctClass(d.upside_pct)}">${this._pctFormat(d.upside_pct)}</div>
        </div>
      </div>

      <!-- Weekly EMA Analysis -->
      <div class="analysis-card">
        <div class="card-header">
          <div class="card-title">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
            Weekly EMA Analysis
          </div>
          <span class="trade-type-badge position">Position</span>
        </div>
        <div class="card-body">${weeklyEmasHtml}${weeklyPatternNote}</div>
      </div>

      <!-- Daily EMA Analysis -->
      <div class="analysis-card">
        <div class="card-header">
          <div class="card-title">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
            Daily EMA Analysis
          </div>
        </div>
        <div class="card-body">${dailyEmasHtml}${dailyPatternNote}</div>
      </div>

      <!-- Weinstein Stage -->
      <div class="analysis-card">
        <div class="card-header">
          <div class="card-title">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/></svg>
            Weinstein Stage Analysis
          </div>
        </div>
        <div class="card-body">${weinsteinHtml}</div>
      </div>

      <!-- Sector & RS -->
      <div class="analysis-card">
        <div class="card-header">
          <div class="card-title">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>
            Sector &amp; Relative Strength
          </div>
        </div>
        <div class="card-body">${sectorRsHtml}</div>
      </div>

      <!-- Fundamentals -->
      <div class="analysis-card">
        <div class="card-header">
          <div class="card-title">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
            Fundamentals
          </div>
        </div>
        <div class="card-body">${fundamentalsHtml}</div>
      </div>

      <!-- Support & Resistance -->
      <div class="analysis-card">
        <div class="card-header">
          <div class="card-title">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="2" y1="12" x2="22" y2="12"/><polyline points="16 8 22 12 16 16"/></svg>
            Support &amp; Resistance
          </div>
        </div>
        <div class="card-body">${srHtml}${d.levels_basis ? `<div class="ema-note">${this._esc(d.levels_basis)}</div>` : ''}</div>
      </div>

      <!-- Multi-Factor Score -->
      <div class="analysis-card">
        <div class="card-header">
          <div class="card-title">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20V10"/><path d="M18 20V4"/><path d="M6 20v-4"/></svg>
            Multi-Factor Setup Score
          </div>
        </div>
        <div class="card-body">
          <div class="score-section">
            <div class="score-header">
              <span class="score-fraction">${d.score || 0} <span style="color: var(--color-text-tertiary); font-weight: var(--font-weight-regular);">/</span> ${d.max_score || 13}</span>
              <span class="score-pct">${scorePct}%</span>
            </div>
            <div class="score-bar-track" role="progressbar" aria-valuenow="${barPct}" aria-valuemin="0" aria-valuemax="100" aria-label="Setup score: ${d.score}/${d.max_score}">
              <div class="score-bar-fill ${scoreClass}" style="width: ${barPct}%;"></div>
            </div>
          </div>
          <div class="reason-pills">${reasonsHtml}</div>
          ${this._renderScoreNote(d)}
        </div>
      </div>

      <!-- Verdict Card -->
      <div class="verdict-card ${verdictClass}">
        <div class="verdict-main ${verdictClass}">${this._esc(verdictLabel)}${verdictLabel.toUpperCase() === 'YES' ? ' \u2014 ' + this._esc(d.confidence || 'Unrated') + ' Confidence' : verdictLabel.toUpperCase() === 'WATCH' ? ' \u2014 Wait' : ' \u2014 Do Not Trade'}</div>
        <div class="verdict-details">
          ${this._renderEntryDetails(d)}
          <div class="verdict-detail">
            <span class="verdict-detail-label">Target</span>
            <span class="verdict-detail-value">${d.target || '-'}</span>
          </div>
          <div class="verdict-detail">
            <span class="verdict-detail-label">Upside</span>
            <span class="verdict-detail-value" style="color: ${this._pctColor(d.upside_pct)};">${this._pctFormat(d.upside_pct)}</span>
          </div>
          <div class="verdict-detail">
            <span class="verdict-detail-label">Timeframe</span>
            <span class="verdict-detail-value">20\u201350 sessions</span>
          </div>
          <div class="verdict-detail">
            <span class="verdict-detail-label">Key Risk</span>
            <span class="verdict-detail-value" style="color: var(--color-warning);">${this._esc(d.key_risk || '-')}</span>
          </div>
        </div>
        ${this._renderEntryChecks(d)}
        <div class="verdict-note" style="margin-top: 8px; font-size: var(--font-size-xs); color: var(--color-text-secondary); font-style: italic;">${this._esc(d.trade_note || '')}</div>
      </div>
    `;
  },

  // ─── SUB-RENDERERS ────────────────────────────────

  _number(value) {
    if (value == null || value === '' || typeof value === 'boolean') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  },

  _fieldNumber(data, numericKey, legacyKey) {
    if (Object.prototype.hasOwnProperty.call(data, numericKey)) return this._number(data[numericKey]);
    const value = data[legacyKey];
    return value == null ? null : this._number(String(value).replace(/[$,%+]/g, ''));
  },

  _money(value) {
    const n = this._number(value);
    if (n == null) return 'N/A';
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: this._currency || 'USD' }).format(n);
  },

  _displayData(data) {
    this._currency = /^[A-Z]{3}$/.test(data.currency || '') ? data.currency : 'USD';
    if (data.schema_version !== 2) return data;
    return { ...data, current_price: this._money(data.price), target: this._money(data.target_price),
      day_range: `${this._money(data.day_low)} – ${this._money(data.day_high)}`,
      week_52_range: `${this._money(data.low_52w)} – ${this._money(data.high_52w)}` };
  },

  _legacyEmas(data, keys) {
    return keys.map(key => {
      const parts = String(data[key] || 'N/A').split('|').map(s => s.trim());
      const period = key.split('_')[1];
      return { name: key.startsWith('w') ? `${period}W EMA` : `EMA ${period}`,
        value: this._number(parts[0].replace(/[$,]/g, '')), position: parts[1],
        slope: parts[2] === 'declining' ? 'falling' : parts[2] };
    });
  },

  _renderSnapshot(d) {
    if (!d.snapshot) return '';
    return `<div class="identity-sector">As of ${this._esc(d.snapshot.as_of)} · ${this._esc(d.snapshot.price_basis)}</div>`;
  },

  _renderScoreNote(d) {
    const warnings = d.data_quality?.warnings || [];
    return `<div class="ema-note">Setup score, not a probability of success. Entry readiness is checked separately.${warnings.length ? '<br>' + warnings.map(w => this._esc(w)).join(' · ') : ''}</div>`;
  },

  _renderEntryDetails(d) {
    const plan = d.trade_plan;
    if (!plan) return '';
    const ratio = this._number(plan.reward_risk);
    return [
      ['Indicative Entry', this._money(plan.entry)],
      ['Stop', this._money(plan.stop)],
      ['Downside', this._pctFormat(plan.downside_pct)],
      ['Reward : Risk', ratio == null ? 'N/A' : `${ratio.toFixed(2)} : 1`],
    ].map(([label, value]) => `<div class="verdict-detail"><span class="verdict-detail-label">${label}</span><span class="verdict-detail-value">${this._esc(value)}</span></div>`).join('');
  },

  _renderEntryChecks(d) {
    if (!d.entry_readiness) return '';
    const checks = d.entry_readiness.checks || [];
    const event = d.earnings_check;
    return `<div class="ema-note" style="text-align: left;">
      <div class="metric-label">Entry Readiness · ${d.entry_readiness.ready ? 'Rules met' : 'Not ready'}</div>
      <div class="reason-pills">${checks.map(c => `<span class="reason-pill ${c.passed ? 'positive' : 'neutral'}" style="white-space: normal;">${c.passed ? '✓' : '○'} ${this._esc(c.text)}</span>`).join('')}</div>
      ${event ? `<p style="margin-top: var(--space-3);">Earnings window through ${this._esc(event.window_end)} (holding weekdays plus a holiday buffer).</p>` : ''}
      ${d.trade_plan ? `<p style="margin-top: var(--space-3);">${this._esc(d.trade_plan.stop_basis)}. Recheck entry and reward:risk at execution.</p>` : ''}
    </div>`;
  },

  /**
   * Render EMA table from array of EMA objects.
   * @param {Array<Object>} emas - [{name, value, position, slope}]
   * @returns {string} HTML
   */
  _renderEmas(emas) {
    if (!emas.length) return '<p style="color: var(--color-text-tertiary); font-size: var(--font-size-sm);">No EMA data available</p>';

    const rows = emas.map((e) => `
      <tr>
        <td class="ema-name">${this._esc(e.name || '')}</td>
        <td class="ema-value">${this._money(e.value)}</td>
        <td><span class="ema-position ${['above', 'below'].includes(e.position) ? e.position : ''}">${this._esc(e.position || 'N/A')}</span></td>
        <td><span class="ema-slope ${['rising', 'falling', 'flat'].includes(e.slope) ? e.slope : ''}">${this._esc(e.slope || 'N/A')}</span></td>
      </tr>
    `).join('');

    return `
      <table class="ema-table" aria-label="EMA analysis data">
        <thead>
          <tr><th scope="col">EMA</th><th scope="col">Value</th><th scope="col">Position</th><th scope="col">Slope</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  },

  /**
   * Render pattern display.
   * @param {Object|string|undefined} pattern
   * @returns {string} HTML
   */
  _renderPattern(pattern) {
    if (!pattern) return '';
    const name = typeof pattern === 'string' ? pattern : (pattern.name || '');
    const context = typeof pattern === 'string' ? '' : (pattern.context || '');
    const sentiment = typeof pattern === 'object' ? (pattern.sentiment || 'neutral') : 'neutral';
    const iconClass = sentiment === 'bullish' ? 'bullish' : sentiment === 'bearish' ? 'bearish' : 'neutral';

    return `
      <div class="pattern-display" style="margin-bottom: var(--space-5);">
        <div class="pattern-icon ${iconClass}" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>
        </div>
        <div>
          <div class="pattern-name">${this._esc(name)}</div>
          <div class="pattern-context">${this._esc(context)}</div>
        </div>
      </div>
    `;
  },

  /**
   * Render support/resistance levels.
   * @returns {string} HTML
   */
  _renderLevels(support, resistance, priceVsSupport, volumeRatio, dayRange) {
    const rows = [];
    rows.push(`<div class="level-row"><span class="level-label">Support</span><span class="level-value support">${this._money(support)}</span></div>`);
    rows.push(`<div class="level-row"><span class="level-label">Resistance</span><span class="level-value resistance">${this._money(resistance)}</span></div>`);
    rows.push(`<div class="level-row"><span class="level-label">Price vs Support</span><span class="level-value" style="color: ${this._pctColor(priceVsSupport)};">${this._pctFormat(priceVsSupport)}</span></div>`);
    const ratio = this._number(volumeRatio);
    rows.push(`<div class="level-row"><span class="level-label">Volume / Prior 20 Sessions</span><span class="level-value">${ratio == null ? 'N/A' : ratio.toFixed(2) + 'x avg'}</span></div>`);
    if (dayRange) rows.push(`<div class="level-row"><span class="level-label">Session Range</span><span class="level-value">${this._esc(dayRange)}</span></div>`);
    return rows.join('');
  },

  /**
   * Render risk factors grid.
   * @param {Array<Object>} factors - [{label, value, warning?}]
   * @returns {string} HTML
   */
  _renderRisk(factors) {
    if (!factors.length) return '<p style="color: var(--color-text-tertiary); font-size: var(--font-size-sm);">No risk data</p>';
    return '<div class="risk-grid">' + factors.map((f) => `
      <div class="risk-item">
        <span class="risk-label">${this._esc(f.label || '')}</span>
        <span class="risk-value${f.warning ? ' warning' : ''}">${this._esc(f.value || '')}</span>
      </div>
    `).join('') + '</div>';
  },

  /**
   * Render reason pills.
   * @param {Array<Object|string>} reasons
   * @returns {string} HTML
   */
  _renderReasons(reasons) {
    if (!reasons.length) return '';
    return reasons.map((r) => {
      const cls = r.type === 'positive' ? 'positive'
        : r.type === 'negative' ? 'negative'
        : 'neutral';
      const score = r.score;
      let scoreStr = '';
      if (score != null) {
        if (score > 0) {
          scoreStr = `+${score}`;
        } else if (score < 0) {
          scoreStr = `\u2212${Math.abs(score)}`;
        } else {
          scoreStr = '+0';
        }
      }
      const scoreBadge = scoreStr
        ? `<span class="reason-score">${scoreStr}</span>`
        : '';
      return `<span class="reason-pill ${cls}" style="white-space: normal;"><span>${this._esc(r.text || '')}</span>${scoreBadge}</span>`;
    }).join('');
  },

  /**
   * Render Weinstein stage card.
   * @param {Object|undefined} weinstein
   * @returns {string} HTML
   */
  _renderWeinstein(weinstein) {
    if (!weinstein) return '<p style="color: var(--color-text-tertiary); font-size: var(--font-size-sm);">No Weinstein stage data</p>';
    const stage = weinstein.stage || null;
    const name = weinstein.name || 'Unknown';
    const desc = weinstein.description || '';
    const confirmed = weinstein.confirmed === true && stage === 2;

    return `
      <div class="stage-display">
        <div class="stage-number ${stage ? 'stage-' + stage : ''}" aria-hidden="true">${stage || '—'}</div>
        <div class="stage-info">
          <div class="stage-name">${this._esc(name)}</div>
          <div class="stage-description">${this._esc(desc)}</div>
          ${confirmed ? `<div class="stage-confirmation">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            Stage ${stage} confirmed
          </div>` : ''}
        </div>
      </div>
    `;
  },

  /**
   * Render sector and relative strength section.
   * @param {Object} d - Full analysis data
   * @returns {string} HTML
   */
  _renderSectorRs(d) {
    const sector = d.sector || '-';
    const rs1m = this._number(d.rs_1m);
    const rs3m = this._number(d.rs_3m);
    const label = d.rs_label || (rs1m == null ? 'Unknown' : rs1m > 2 ? 'Outperforming' : rs1m < -2 ? 'Underperforming' : 'Neutral');

    let rows = `<div class="level-row"><span class="level-label">Sector</span><span class="level-value">${this._esc(sector)}</span></div>`;
    rows += `<div class="rs-row"><span class="rs-label">RS vs SPY (1 Month)</span><span class="rs-value" style="color: ${this._pctColor(rs1m)};">${this._pctFormat(rs1m, 2)}</span></div>`;
    rows += `<div class="rs-row"><span class="rs-label">RS vs SPY (3 Month)</span><span class="rs-value" style="color: ${this._pctColor(rs3m)};">${this._pctFormat(rs3m, 2)}</span></div>`;
    rows += `<div style="margin-top: var(--space-3); padding-top: var(--space-3); border-top: 1px solid var(--color-divider);">
        <span class="rs-badge ${label === 'Outperforming' ? 'outperforming' : label === 'Underperforming' ? 'underperforming' : ''}">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/></svg>
          ${this._esc(label)} vs SPY
        </span>
      </div>`;
    return rows;
  },

  /**
   * Render fundamentals grid.
   * @param {Object} f - {revenue_growth, earnings_growth, profitability, balance_sheet, institutional_ownership, market_cap}
   * @returns {string} HTML
   */
  _renderFundamentals(f) {
    if (!f || Object.keys(f).length === 0) return '<p style="color: var(--color-text-tertiary); font-size: var(--font-size-sm);">No fundamental data available</p>';

    const items = [];
    const sentiment = value => this._number(value) == null || Number(value) === 0 ? null : Number(value) > 0;
    const profitStatus = f.profitability_status ?? (f.profitability === 'Profitable' ? 'profitable' : f.profitability === 'Pre-profit' ? 'pre_profit' : 'unknown');
    const balanceStatus = f.balance_sheet_status ?? (f.balance_sheet === 'Net cash' ? 'net_cash' : ['Net debt', 'Leveraged'].includes(f.balance_sheet) ? 'net_debt' : 'unknown');
    items.push({ label: 'Revenue Growth', value: this._pctFormat(f.revenue_growth), positive: sentiment(f.revenue_growth) });
    items.push({ label: 'Earnings Growth', value: this._pctFormat(f.earnings_growth), positive: sentiment(f.earnings_growth) });
    if (f.profitability) items.push({ label: 'Profitability', value: f.profitability, positive: profitStatus === 'profitable' ? true : profitStatus === 'pre_profit' ? false : null });
    if (f.balance_sheet) items.push({ label: 'Balance Sheet', value: f.balance_sheet, positive: balanceStatus === 'net_cash' ? true : balanceStatus === 'net_debt' ? false : null });
    if (f.institutional_ownership != null) items.push({ label: 'Institutional Ownership', value: f.institutional_ownership, positive: null });
    if (f.market_cap) items.push({ label: 'Market Cap', value: f.market_cap, positive: null });

    return '<div class="fundamentals-grid">' + items.map((item) => `
      <div class="fundamental-item">
        <span class="fundamental-label">${this._esc(item.label)}</span>
        <span class="fundamental-value${item.positive === true ? ' positive' : item.positive === false ? ' negative' : ''}">${this._esc(item.value)}</span>
      </div>
    `).join('') + '</div>';
  },

  // ─── HISTORY ──────────────────────────────────────

  /**
   * Load analysis history from the API and render it.
   */
  async loadHistory() {
    const generation = this._generation;
    if (this._historyController) this._historyController.abort();
    const controller = new AbortController();
    this._historyController = controller;
    try {
      const resp = await API.get('/trade/history', {}, controller.signal);
      if (controller.signal.aborted || generation !== this._generation || !this._active) return;
      this.history = resp.history || [];
    } catch (err) {
      if (controller.signal.aborted || generation !== this._generation || !this._active) return;
      console.warn('[Trade] Failed to load history:', err.message);
    } finally {
      if (this._historyController === controller) this._historyController = null;
    }
    this.renderHistory();
  },

  /**
   * Render the analysis history grouped by ticker.
   */
  renderHistory() {
    const listEl = document.getElementById('trade-history-list');
    const emptyEl = document.getElementById('trade-history-empty');
    const clearBtn = document.getElementById('trade-clear-history-btn');
    if (!listEl) return;

    if (!Array.isArray(this.history) || this.history.length === 0) {
      listEl.innerHTML = '';
      if (emptyEl) emptyEl.style.display = '';
      if (clearBtn) clearBtn.style.display = 'none';
      return;
    }

    if (emptyEl) emptyEl.style.display = 'none';
    if (clearBtn) clearBtn.style.display = '';

    // Group by ticker
    const groups = {};
    this.history.forEach((entry) => {
      const ticker = (entry.ticker || '').toUpperCase();
      if (!groups[ticker]) groups[ticker] = [];
      groups[ticker].push(entry);
    });

    // Sort tickers alphabetically
    const tickers = Object.keys(groups).sort();

    listEl.innerHTML = tickers.map((ticker) => {
      const entries = groups[ticker];
      const countLabel = entries.length === 1 ? '1 analysis' : `${entries.length} analyses`;

      const entriesHtml = entries.map((e) => {
        const tradeType = e.trade_type || 'swing';
        const verdict = (e.verdict || 'NO').toUpperCase();
        const verdictClass = verdict === 'YES' ? 'yes' : verdict === 'WATCH' ? 'watch' : 'no';
        const score = e.score != null ? e.score : '-';
        const maxScore = e.max_score != null ? e.max_score : (tradeType === 'position' ? 13 : 10);
        const date = e.analyzed_at ? this._formatDate(e.analyzed_at) : '';

        return `
          <div class="history-entry">
            <div class="history-entry-left">
              <span class="trade-type-badge ${tradeType}">${tradeType === 'swing' ? 'Swing' : 'Position'}</span>
              <span class="verdict-badge ${verdictClass}" style="font-size: 11px; padding: 1px 6px;">${this._esc(verdict)}</span>
              <span class="history-entry-score">${score}/${maxScore}</span>
              <span class="history-entry-date">${this._esc(date)}</span>
            </div>
            <button class="reanalyze-btn" data-ticker="${this._esc(ticker)}" data-trade-type="${tradeType}" aria-label="Re-analyze ${this._esc(ticker)} ${tradeType === 'swing' ? 'Swing' : 'Position'}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
              Re-analyze
            </button>
          </div>
        `;
      }).join('');

      return `
        <div class="history-group">
          <div class="history-group-header">
            <button type="button" class="history-group-toggle" aria-expanded="true" aria-label="Toggle analysis history">
              <svg class="history-group-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
            </button>
            ${ChartModal.button(ticker, entries[0]?.company, 'history-group-ticker').outerHTML}
            <button type="button" class="history-group-toggle history-group-count" aria-expanded="true">${countLabel}</button>
          </div>
          <div class="history-entries">${entriesHtml}</div>
        </div>
      `;
    }).join('');
  },

  /**
   * Clear all analysis history.
   */
  async clearHistory() {
    const generation = this._generation;
    if (this._historyController) this._historyController.abort();
    try {
      await API.delete('/trade/history');
    } catch (err) {
      console.warn('[Trade] Failed to clear history server-side:', err.message);
      if (generation === this._generation && this._active) this.showError('Unable to clear history. Please try again.');
      return;
    }
    if (generation !== this._generation || !this._active) return;
    this.history = [];
    this.renderHistory();
  },

  // ─── UI HELPERS ───────────────────────────────────

  /**
   * Show or hide the loading overlay.
   * @param {boolean} on
   * @param {string} [ticker] - Ticker to show in the loading text
   */
  setLoading(on, ticker) {
    this.loading = on;
    const overlay = document.getElementById('trade-loading-overlay');
    const loadingText = document.getElementById('trade-loading-text');
    const loadingMsg = document.getElementById('trade-loading-message');
    const analyzeBtn = document.getElementById('trade-analyze-btn');

    if (on) {
      if (overlay) overlay.classList.add('visible');
      if (loadingText) loadingText.textContent = ticker ? `Analyzing ${ticker.toUpperCase()}` : 'Analyzing...';
      if (loadingMsg) loadingMsg.textContent = this._loadingMessages[0];
      if (analyzeBtn) analyzeBtn.disabled = true;

      // Cycle loading messages
      let idx = 0;
      this._loadingMsgInterval = setInterval(() => {
        idx = (idx + 1) % this._loadingMessages.length;
        if (loadingMsg) loadingMsg.textContent = this._loadingMessages[idx];
      }, 2200);

      this._setStatus('running', 'Analyzing...');
    } else {
      if (overlay) overlay.classList.remove('visible');
      if (analyzeBtn) analyzeBtn.disabled = false;
      if (this._loadingMsgInterval) {
        clearInterval(this._loadingMsgInterval);
        this._loadingMsgInterval = null;
      }
    }
  },

  /**
   * Show an error message in the inline error block.
   * @param {string} msg
   */
  showError(msg) {
    const el = document.getElementById('trade-error-inline');
    const msgEl = document.getElementById('trade-error-message');
    if (msgEl) msgEl.textContent = msg;
    if (el) el.classList.add('visible');
  },

  /**
   * Hide the inline error block.
   */
  hideError() {
    const el = document.getElementById('trade-error-inline');
    if (el) el.classList.remove('visible');
  },

  /**
   * Update the status indicator dot and text.
   * @param {string} state - 'ready' | 'running' | 'done' | 'error'
   * @param {string} text
   */
  _setStatus(state, text) {
    const dot = document.getElementById('trade-status-dot');
    const textEl = document.getElementById('trade-status-text');
    if (dot) {
      dot.className = 'status-dot ' + state;
    }
    if (textEl) textEl.textContent = text;
  },

  /**
   * Sync the toggle button active state to match tradeType.
   * @param {string} type - 'swing' or 'position'
   */
  _syncToggleButton(type) {
    const btns = document.querySelectorAll('#trade-screen .segment-btn');
    btns.forEach((btn) => {
      const isActive = btn.dataset.type === type;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-checked', String(isActive));
    });
  },

  /**
   * Format an ISO date string to a human-readable format.
   * @param {string} isoStr
   * @returns {string}
   */
  _formatDate(isoStr) {
    try {
      const d = new Date(isoStr.endsWith('Z') ? isoStr : isoStr + 'Z');
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
        + ' at ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    } catch {
      return isoStr;
    }
  },

  // ─── FORMATTERS ───────────────────────────────────

  /**
   * Format a percentage value.
   * @param {number|null|undefined} val
   * @returns {string}
   */
  _pctFormat(val, digits = 1) {
    const n = this._number(val);
    if (n == null) return 'N/A';
    return (n > 0 ? '+' : '') + n.toFixed(digits) + '%';
  },

  /**
   * Get the CSS class for a percentage (up/down).
   * @param {number|null|undefined} val
   * @returns {string}
   */
  _pctClass(val) {
    if (this._number(val) == null) return '';
    return Number(val) > 0 ? 'up' : Number(val) < 0 ? 'down' : '';
  },

  /**
   * Get a color for a percentage value.
   * @param {number|null|undefined} val
   * @returns {string}
   */
  _pctColor(val) {
    if (this._number(val) == null) return 'var(--color-text-primary)';
    return Number(val) > 0 ? 'var(--color-success)' : Number(val) < 0 ? 'var(--color-error)' : 'var(--color-text-primary)';
  },

  /**
   * Escape HTML to prevent XSS.
   * @param {string} str
   * @returns {string}
   */
  _esc(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  },

  // ─── CLEANUP ──────────────────────────────────────

  /**
   * Destroy the module, cleaning up intervals and aborting requests.
   */
  destroy() {
    this._active = false;
    this._generation += 1;
    this.setLoading(false);
    if (this._historyController) {
      this._historyController.abort();
      this._historyController = null;
    }
    ChartModal.destroy();
    if (this._loadingMsgInterval) {
      clearInterval(this._loadingMsgInterval);
      this._loadingMsgInterval = null;
    }
    if (this._abortController) {
      this._abortController.abort();
      this._abortController = null;
    }
  },
};

// ES module export for app.js dynamic import
export default Trade;

// CommonJS fallback (for Node/testing)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = Trade;
}
