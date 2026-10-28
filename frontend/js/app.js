/**
 * App — Tab router, theme manager, and shared application state.
 *
 * Responsibilities:
 *   - Listen for nav-tab clicks and load screen HTML templates
 *   - Initialize screen-specific JS modules after template injection
 *   - Persist and toggle dark/light theme
 *   - Expose shared state (currentScreen, theme)
 *
 * @example
 *   // After DOMContentLoaded, App.init() runs automatically.
 *   // To programmatically navigate:
 *   App.loadScreen('charts');
 */

const App = {
  /** @type {string} Currently active screen key */
  currentScreen: 'portfolio',

  /** Discard responses from a screen that is no longer selected. */
  _loadGeneration: 0,

  /** @type {Object|null} Current screen module instance (for destroy() lifecycle) */
  _currentModule: null,

  /** Shared chart lifecycle stays independent of the current screen module. */
  _chartModal: null,

  _chartSearch: null,

  /** @type {Object<string, {template: string, module?: () => Promise}>} */
  // Trade screen hidden: screens/trade.html + modules/trade.js retained but not routed.
  routes: {
    portfolio: {
      template: 'screens/portfolio.html',
      module: () => import('./modules/portfolio.js'),
    },
    alerts: {
      template: 'screens/alerts.html',
      module: () => import('./modules/alerts.js'),
    },
    charts: {
      template: 'screens/charts.html',
      module: () => import('./modules/charts.js'),
    },
    scanner: {
      template: 'screens/scanner.html',
      module: () => import('./modules/scanner.js'),
    },
    earnings: {
      template: 'screens/earnings.html',
      module: () => import('./modules/earnings.js'),
    },
    universe: {
      template: 'screens/universe.html',
      module: () => import('./modules/universe.js'),
    },
    // Trade screen hidden: template/module files retained but not routed.
    transactions: {
      template: 'screens/transactions.html',
      module: () => import('./modules/transactions.js'),
    },
    news: {
      template: 'screens/news.html',
      module: () => import('./modules/news.js'),
    },
    settings: {
      template: 'screens/settings.html',
      module: () => import('./modules/settings.js'),
    },
  },

  // ─── INITIALIZATION ──────────────────────────────────

  /**
   * Bootstrap the application: bind events, restore state, load initial screen.
   */
  async init() {
    this._chartModal = (await import('./components/chart-modal.js')).default;
    this._chartSearch = (await import('./components/chart-search.js')).default;
    this._chartSearch.init(this._chartModal);
    this._bindNavEvents();
    this._bindHamburger();
    this._bindThemeToggle();
    this._bindAlertsPanel();
    this._restoreTheme();
    await this._loadAlerts();
    this.loadScreen('portfolio');
  },

  // ─── NAVIGATION ──────────────────────────────────────

  /**
   * Bind click handlers on all .nav-tab buttons.
   * @private
   */
  _bindNavEvents() {
    const tabs = document.querySelectorAll('.nav-tab');
    tabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        const screen = tab.dataset.screen;
        if (screen) this.loadScreen(screen);
      });

      // Keyboard navigation: Enter/Space to activate
      tab.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          tab.click();
        }
      });
    });

    // Desktop tab bar: support the expected roving arrow/Home/End keys.
    const desktopTabs = [...document.querySelectorAll('.nav-tabs .nav-tab')];
    document.querySelector('.nav-tabs')?.addEventListener('keydown', (e) => {
      const index = desktopTabs.indexOf(e.target.closest('.nav-tab'));
      if (index < 0) return;
      let next;
      if (e.key === 'ArrowRight') next = (index + 1) % desktopTabs.length;
      else if (e.key === 'ArrowLeft') next = (index - 1 + desktopTabs.length) % desktopTabs.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = desktopTabs.length - 1;
      else return;
      e.preventDefault();
      desktopTabs[next].focus();
      desktopTabs[next].click();
    });

    // Settings icon button (moved from nav-tabs to nav-right)
    const settingsBtn = document.getElementById('settings-btn');
    if (settingsBtn) {
      settingsBtn.addEventListener('click', () => this.loadScreen('settings'));
    }
    document.getElementById('mobile-settings-btn')?.addEventListener('click', () => {
      this._closeMobileMenu();
      this.loadScreen('settings');
    });

    // Close mobile menu when any tab is selected (desktop or mobile)
    const allTabs = document.querySelectorAll('.nav-tab');
    allTabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        this._closeMobileMenu();
      });
    });
  },

  // ─── HAMBURGER MENU ──────────────────────────────────

  /**
   * Bind the hamburger button and mobile menu interactions.
   * @private
   */
  _bindHamburger() {
    const hamburger = document.getElementById('hamburger-btn');
    if (!hamburger) return;

    hamburger.addEventListener('click', () => {
      this._toggleMobileMenu();
    });

    document.getElementById('mobile-menu-close')?.addEventListener('click', () => this._closeMobileMenu());
    document.getElementById('mobile-menu-backdrop')?.addEventListener('click', () => this._closeMobileMenu());

    // Close on outside click
    document.addEventListener('click', (e) => {
      const menu = document.getElementById('mobile-menu');
      if (!menu || !menu.classList.contains('is-open')) return;

      const isClickInsideNav = e.target.closest('.nav');
      if (!isClickInsideNav) {
        this._closeMobileMenu();
      }
    });

    // Close on Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this._closeMobileMenu();
      }
      if (e.key !== 'Tab') return;
      const menu = document.getElementById('mobile-menu');
      if (!menu?.classList.contains('is-open')) return;
      const items = [...menu.querySelectorAll('button:not([disabled])')];
      if (e.shiftKey && document.activeElement === items[0]) {
        e.preventDefault();
        items[items.length - 1].focus();
      } else if (!e.shiftKey && document.activeElement === items[items.length - 1]) {
        e.preventDefault();
        items[0].focus();
      }
    });

    window.addEventListener('resize', () => {
      if (window.innerWidth > 767) this._closeMobileMenu();
    });
  },

  /**
   * Toggle the mobile menu open/closed.
   * @private
   */
  _toggleMobileMenu() {
    const hamburger = document.getElementById('hamburger-btn');
    const menu = document.getElementById('mobile-menu');
    if (!hamburger || !menu) return;

    const isOpen = menu.classList.toggle('is-open');
    document.getElementById('mobile-menu-backdrop')?.classList.toggle('is-open', isOpen);
    document.body.classList.toggle('nav-drawer-open', isOpen);
    menu.inert = !isOpen;
    menu.setAttribute('aria-hidden', String(!isOpen));
    hamburger.setAttribute('aria-expanded', String(isOpen));
    hamburger.setAttribute(
      'aria-label',
      isOpen ? 'Close navigation menu' : 'Open navigation menu'
    );

    // Swap hamburger ↔ close icon
    const hamburgerIcon = hamburger.querySelector('.hamburger-icon');
    const closeIcon = hamburger.querySelector('.hamburger-close-icon');
    if (hamburgerIcon) hamburgerIcon.style.display = isOpen ? 'none' : '';
    if (closeIcon) closeIcon.style.display = isOpen ? '' : 'none';
    if (isOpen) document.getElementById('mobile-menu-close')?.focus();
  },

  /**
   * Close the mobile menu if it is open.
   * @private
   */
  _closeMobileMenu() {
    const hamburger = document.getElementById('hamburger-btn');
    const menu = document.getElementById('mobile-menu');
    if (!hamburger || !menu) return;

    const wasOpen = menu.classList.contains('is-open');
    if (wasOpen && menu.contains(document.activeElement)) hamburger.focus();
    menu.classList.remove('is-open');
    document.getElementById('mobile-menu-backdrop')?.classList.remove('is-open');
    document.body.classList.remove('nav-drawer-open');
    menu.inert = true;
    menu.setAttribute('aria-hidden', 'true');
    hamburger.setAttribute('aria-expanded', 'false');
    hamburger.setAttribute('aria-label', 'Open navigation menu');

    const hamburgerIcon = hamburger.querySelector('.hamburger-icon');
    const closeIcon = hamburger.querySelector('.hamburger-close-icon');
    if (hamburgerIcon) hamburgerIcon.style.display = '';
    if (closeIcon) closeIcon.style.display = 'none';
  },

  /**
   * Update which tab has aria-selected="true".
   * @param {string} screenKey - The screen to mark active
   * @private
   */
  _setActiveTab(screenKey) {
    const tabs = document.querySelectorAll('.nav-tab');
    tabs.forEach((tab) => {
      const isActive = tab.dataset.screen === screenKey;
      tab.setAttribute('aria-selected', String(isActive));
      tab.tabIndex = tab.classList.contains('nav-mobile-tab') ? 0
        : (isActive || (screenKey === 'settings' && tab.dataset.screen === 'portfolio') ? 0 : -1);
      if (tab.classList.contains('nav-mobile-tab')) {
        if (isActive) tab.setAttribute('aria-current', 'page');
        else tab.removeAttribute('aria-current');
      }
    });
    const mobileSettings = document.getElementById('mobile-settings-btn');
    if (mobileSettings) {
      if (screenKey === 'settings') mobileSettings.setAttribute('aria-current', 'page');
      else mobileSettings.removeAttribute('aria-current');
    }
    const settingsBtn = document.getElementById('settings-btn');
    if (settingsBtn) {
      if (screenKey === 'settings') settingsBtn.setAttribute('aria-current', 'page');
      else settingsBtn.removeAttribute('aria-current');
    }
  },

  // ─── THEME ───────────────────────────────────────────

  /**
   * Bind the dark mode toggle button.
   * @private
   */
  _bindThemeToggle() {
    const toggle = document.getElementById('theme-toggle');
    if (!toggle) return;

    toggle.addEventListener('click', () => {
      const html = document.documentElement;
      const next = html.dataset.theme === 'light' ? 'dark' : 'light';
      this._setTheme(next);
    });
  },

  /**
   * Restore the user's saved theme or default to system preference.
   * @private
   */
  _restoreTheme() {
    const saved = localStorage.getItem('investingview-theme');
    if (saved) {
      this._setTheme(saved);
    } else {
      // Respect system preference
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      this._setTheme(prefersDark ? 'dark' : 'light');
    }
  },

  /**
   * Apply a theme and persist it.
   * @param {'light' | 'dark'} theme
   * @private
   */
  _setTheme(theme) {
    const html = document.documentElement;
    html.dataset.theme = theme;
    html.style.colorScheme = theme;
    localStorage.setItem('investingview-theme', theme);
    this._updateThemeIcon(theme);
  },

  /**
   * Swap the sun/moon icon in the toggle button.
   * @param {'light' | 'dark'} theme
   * @private
   */
  _updateThemeIcon(theme) {
    const toggle = document.getElementById('theme-toggle');
    if (!toggle) return;
    const sun = toggle.querySelector('.icon-sun');
    const moon = toggle.querySelector('.icon-moon');
    if (sun) sun.style.display = theme === 'light' ? '' : 'none';
    if (moon) moon.style.display = theme === 'dark' ? '' : 'none';
    toggle.setAttribute('aria-label', theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
  },

  // ─── SCREEN LOADING ─────────────────────────────────

  /**
   * Load a screen template and initialize its module.
   *
   * @param {string} screenKey - Route key (e.g. 'portfolio')
   */
  async loadScreen(screenKey) {
    // Trade screen hidden: block direct access, fall back to portfolio.
    if (screenKey === 'trade') {
      console.warn('App.loadScreen: "trade" screen is hidden');
      if (this.currentScreen !== 'portfolio') return this.loadScreen('portfolio');
      return;
    }
    const route = this.routes[screenKey];
    if (!route) {
      console.warn(`App.loadScreen: unknown screen "${screenKey}"`);
      return;
    }
    const generation = ++this._loadGeneration;
    this._chartSearch?.close();

    // Stop chart requests/streams before navigation, including a pending first open.
    this._chartModal?.close();

    // Destroy previous screen's module to clean up listeners
    if (this._currentModule && typeof this._currentModule.destroy === 'function') {
      try {
        this._currentModule.destroy();
      } catch (err) {
        console.warn('App.loadScreen: destroy() failed:', err);
      }
    }
    this._currentModule = null;

    // Update UI state
    this.currentScreen = screenKey;
    this._setActiveTab(screenKey);

    const content = document.getElementById('content');
    if (!content) return;

    // Show loading state
    content.innerHTML = `
      <div class="loading-state">
        <div class="spinner" aria-hidden="true"></div>
        <p>Loading ${screenKey}...</p>
      </div>
    `;

    try {
      // Fetch HTML template
      const resp = await fetch(route.template);
      if (!resp.ok) {
        throw new Error(`Template not found: ${resp.status}`);
      }
      const html = await resp.text();
      if (generation !== this._loadGeneration) return;
      content.innerHTML = html;

      // Initialize screen module (dynamic import)
      if (route.module) {
        try {
          const mod = await route.module();
          if (generation !== this._loadGeneration) return;
          const module = mod.default || mod;
          if (module && typeof module.init === 'function') {
            module.init();
            this._currentModule = module;
          }
        } catch (modErr) {
          if (generation !== this._loadGeneration) return;
          // Module not yet implemented — screen template still renders
          console.info(
            `App.loadScreen: module for "${screenKey}" not yet available (${modErr.message})`
          );
        }
      }

      // Announce to screen readers
      this._announce(`Loaded ${screenKey} screen`);
    } catch (err) {
      if (generation !== this._loadGeneration) return;
      content.innerHTML = `
        <div class="error-state" role="alert">
          <div class="error-state-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10"/>
              <path d="M12 8v4M12 16h.01"/>
            </svg>
          </div>
          <div class="error-state-title">Unable to load ${screenKey}</div>
          <div class="error-state-message">${err.message}</div>
          <button class="btn-primary" onclick="App.loadScreen('${screenKey}')">
            Try Again
          </button>
        </div>
      `;
    }
  },

  // ─── ALERTS PANEL (Global) ────────────────────────────

  /**
   * Bind the bell icon, close button, backdrop, and action buttons
   * for the global alerts slide-in panel.
   * Called once at init — persists across screen navigations.
   * @private
   */
  _bindAlertsPanel() {
    const toggle = document.getElementById('alerts-toggle');
    const close = document.getElementById('alerts-close');
    const backdrop = document.getElementById('alerts-backdrop');
    const clearBtn = document.getElementById('alerts-clear');

    if (toggle) {
      toggle.addEventListener('click', () => {
        const panel = document.getElementById('alerts-panel');
        if (panel && panel.classList.contains('open')) {
          this._closeAlertsPanel();
        } else {
          this._openAlertsPanel();
        }
      });
    }
    if (close) {
      close.addEventListener('click', () => this._closeAlertsPanel());
    }
    if (backdrop) {
      backdrop.addEventListener('click', () => this._closeAlertsPanel());
    }
    if (clearBtn) {
      clearBtn.addEventListener('click', () => this._clearAlerts());
    }

    // Close on Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const panel = document.getElementById('alerts-panel');
        if (panel && panel.classList.contains('open')) {
          this._closeAlertsPanel();
        }
      }
    });
  },

  /** @type {Array<Object>} Cached alerts data */
  _alertsData: [],

  /**
   * Open the alerts slide-in panel.
   * Accessible globally from any screen via the bell icon.
   */
  async _openAlertsPanel() {
    const panel = document.getElementById('alerts-panel');
    const backdrop = document.getElementById('alerts-backdrop');
    if (panel) panel.classList.add('open');
    if (backdrop) backdrop.classList.add('open');
    await this._loadAlerts();
  },

  /**
   * Close the alerts slide-in panel.
   */
  _closeAlertsPanel() {
    const panel = document.getElementById('alerts-panel');
    const backdrop = document.getElementById('alerts-backdrop');
    if (panel) panel.classList.remove('open');
    if (backdrop) backdrop.classList.remove('open');
  },

  /**
   * Load fired alert history from the API and render into the global panel.
   * Uses /api/alerts/history which returns recent fired alerts with timestamps.
   */
  async _loadAlerts() {
    const body = document.getElementById('alerts-panel-body');
    const emptyState = document.getElementById('alerts-empty');
    if (!body) return;

    // Remove previous status messages
    body.querySelectorAll('.alerts-status-msg').forEach(el => el.remove());

    try {
      const data = await API.get('/alerts/history', { limit: 30 });
      this._alertsData = Array.isArray(data) ? data : [];
    } catch (err) {
      console.info('[App] Alerts history API unavailable:', err.message);
      // Fallback: try /api/alerts
      try {
        const data = await API.get('/alerts');
        this._alertsData = Array.isArray(data) ? data : [];
      } catch {
        this._alertsData = [];
      }
    }

    if (this._alertsData.length === 0) {
      if (emptyState) emptyState.style.display = '';
      body.querySelectorAll('.alert-item-history, .alert-item').forEach(el => el.remove());
      return;
    }

    if (emptyState) emptyState.style.display = 'none';

    const alertsHtml = this._alertsData.slice(0, 30).map((alert) => {
      const isHistory = alert.alerted_at || alert.fired_at;
      const timeRaw = alert.alerted_at || alert.fired_at || alert.last_triggered;

      if (isHistory && timeRaw) {
        const ts = new Date(timeRaw.endsWith('Z') ? timeRaw : timeRaw + 'Z')
          .toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

        const pattern = alert.pattern || alert.type || '';
        const srType = alert.sr_type || '';
        const isUp = pattern.includes('above') || pattern.includes('bullish') || pattern === 'cross_above' || pattern === 'touch_bullish';
        const isDown = pattern.includes('below') || pattern.includes('bearish') || pattern === 'cross_below' || pattern === 'touch_bearish';
        const accentClass = isUp ? 'up' : (isDown ? 'down' : '');

        let icon = '\u{1F514}';
        let label = '';
        if (srType === 'avg' || srType === 'average') {
          icon = isUp ? '\u{1F4C8}' : (isDown ? '\u{1F4C9}' : '\u{1F514}');
          label = pattern.replace(/_/g, ' ');
        } else {
          icon = isUp ? '\u{1F7E2}' : (isDown ? '\u{1F534}' : '\u{1F514}');
          label = (srType === 'sup' ? 'Support' : srType === 'res' ? 'Resistance' : srType)
            + ' ' + pattern.replace(/_/g, ' ');
        }

        const priceAt = alert.price_at_alert ? `$${Number(alert.price_at_alert).toFixed(2)}` : '';
        const srPrice = alert.sr_price ? ` @ $${Number(alert.sr_price).toFixed(2)}` : '';
        const desc = `${label}${srPrice}${priceAt ? ` (price: ${priceAt})` : ''}`;

        return `<div class="alert-item-history ${accentClass}">
          <span class="alert-item-icon">${icon}</span>
          <div class="alert-item-info">
            <div class="alert-item-ticker" style="color:${isUp ? 'var(--color-stock-up)' : isDown ? 'var(--color-stock-down)' : 'var(--color-text-primary)'}">${this._escapeHtml(alert.ticker || '')}</div>
            <div class="alert-item-desc">${this._escapeHtml(desc)}</div>
          </div>
          <span class="alert-item-time">${ts}</span>
        </div>`;
      }

      // Fallback: render as a live alert config item
      const dotClass = alert.armed ? 'active' : (alert.last_triggered ? 'triggered' : '');
      const desc = alert.condition
        ? `${alert.ticker} ${alert.condition} $${Number(alert.target_price || alert.threshold || 0).toFixed(2)}`
        : alert.ticker;
      const timeText = alert.last_triggered
        ? new Date(alert.last_triggered).toLocaleDateString()
        : (alert.armed ? 'Monitoring' : 'Paused');

      return `<div class="alert-item">
        <span class="alert-item-dot ${dotClass}"></span>
        <div class="alert-item-content">
          <div class="alert-item-ticker">${this._escapeHtml(alert.ticker || '')}</div>
          <div class="alert-item-desc">${this._escapeHtml(desc)}</div>
        </div>
        <span class="alert-item-time">${timeText}</span>
      </div>`;
    }).join('');

    // Remove old items, insert new
    body.querySelectorAll('.alert-item-history, .alert-item').forEach(el => el.remove());
    if (emptyState) {
      emptyState.insertAdjacentHTML('afterend', alertsHtml);
    } else {
      body.insertAdjacentHTML('beforeend', alertsHtml);
    }

    // Update badge with the count of loaded alerts
    this._updateAlertBadge();
  },

  /**
   * Clear all notifications from the alerts panel.
   * Persists the deletion server-side via DELETE /api/alerts/history,
   * then removes rendered items and shows the empty state.
   * Gracefully degrades if the API call fails — the UI is always cleared.
   */
  async _clearAlerts() {
    const body = document.getElementById('alerts-panel-body');
    const emptyState = document.getElementById('alerts-empty');
    if (!body) return;

    // Persist deletion server-side
    try {
      await API.delete('/alerts/history');
    } catch (err) {
      console.info('[App] Failed to clear alerts server-side:', err.message);
    }

    // Always clear the UI regardless of API outcome
    body.querySelectorAll('.alert-item-history, .alert-item, .alerts-status-msg').forEach(el => el.remove());
    this._alertsData = [];
    if (emptyState) emptyState.style.display = '';

    // Update the notification badge — count is now 0
    this._updateAlertBadge();

    this._announce('All notifications cleared');
  },

  /**
   * Update the global notification badge with the count of today's alerts.
   * Filters _alertsData to only count items fired today (capped at 99+).
   * Hides the badge when no alerts fired today.
   * The badge is the #alertBadge element in the nav bar (index.html).
   *
   * @private
   */
  _updateAlertBadge() {
    const badge = document.getElementById('alertBadge');
    if (!badge) return;

    const today = new Date();
    const todayStr = today.getFullYear() + '-' +
      String(today.getMonth() + 1).padStart(2, '0') + '-' +
      String(today.getDate()).padStart(2, '0');

    const count = this._alertsData.filter(function(item) {
      const firedAt = item.fired_at || item.alerted_at || '';
      return firedAt && firedAt.substring(0, 10) === todayStr;
    }).length;

    if (count > 0) {
      badge.textContent = count > 99 ? '99+' : String(count);
      badge.hidden = false;
      // Use rAF to ensure hidden=false renders before adding visible class
      requestAnimationFrame(() => {
        badge.classList.add('visible');
      });
    } else {
      badge.textContent = '';
      badge.hidden = true;
      badge.classList.remove('visible');
    }
  },

  /**
   * Escape HTML to prevent XSS when rendering user-supplied strings.
   * @param {string} str
   * @returns {string}
   * @private
   */
  _escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  },

  // ─── ACCESSIBILITY ───────────────────────────────────

  /**
   * Announce a message to screen readers via an aria-live region.
   * Creates the region on first call.
   *
   * @param {string} message
   * @private
   */
  _announce(message) {
    let region = document.getElementById('aria-live-region');
    if (!region) {
      region = document.createElement('div');
      region.id = 'aria-live-region';
      region.setAttribute('role', 'status');
      region.setAttribute('aria-live', 'polite');
      region.setAttribute('aria-atomic', 'true');
      region.classList.add('sr-only');
      document.body.appendChild(region);
    }
    region.textContent = message;
  },
};

// ─── BOOT ──────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => App.init());
