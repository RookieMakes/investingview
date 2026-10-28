/**
 * Settings — Application settings and notification configuration screen.
 *
 * Manages user preferences, API keys, and notification channels (Discord, email).
 *
 * API endpoints:
 *   GET  /api/settings                    — get all settings
 *   PUT  /api/settings                    — update settings
 *   POST /api/settings/test-discord       — test Discord webhook
 *   POST /api/settings/test-email         — test email delivery
 *
 * @example
 *   // Called by App.loadScreen('settings')
 *   Settings.init();
 */

import MarketTickerSettings from '../components/market-ticker-settings.js';

const Settings = {
  /** @type {Object|null} Current settings object */
  data: null,

  /** @type {boolean} */
  loading: false,

  // ─── INITIALIZATION ──────────────────────────────────

  /**
   * Initialize the Settings screen.
   */
  async init() {
    console.log('[Settings] initialized');
    this.bindEvents();
    this._marketTickerSettings = new MarketTickerSettings();
    await Promise.all([this.loadSettings(), this._marketTickerSettings.init()]);
  },

  destroy() {
    this._marketTickerSettings?.destroy();
    this._marketTickerSettings = null;
  },

  // ─── EVENT BINDING ───────────────────────────────────

  /**
   * Bind screen-specific event listeners.
   */
  bindEvents() {
    // Test Discord button
    const testDiscordBtn = document.getElementById('settings-test-discord-btn');
    if (testDiscordBtn) {
      testDiscordBtn.addEventListener('click', () => this.handleTestDiscord());
    }

    // Test email button
    const testEmailBtn = document.getElementById('settings-test-email-btn');
    if (testEmailBtn) {
      testEmailBtn.addEventListener('click', () => this.handleTestEmail());
    }

    // Save Discord webhook button
    const saveWebhookBtn = document.getElementById('settings-save-webhook-btn');
    if (saveWebhookBtn) {
      saveWebhookBtn.addEventListener('click', () => this.handleSaveWebhook());
    }

    // Save email credentials button
    const saveEmailBtn = document.getElementById('settings-save-email-btn');
    if (saveEmailBtn) {
      saveEmailBtn.addEventListener('click', () => this.handleSaveEmail());
    }
  },

  // ─── DATA LOADING ────────────────────────────────────

  /**
   * Load current settings from API.
   */
  async loadSettings() {
    this.loading = true;
    this.showLoading();

    try {
      this.data = await API.get('/settings');
      this.hideLoading();
      this.render();
    } catch (err) {
      this.showError(err.message);
    } finally {
      this.loading = false;
    }
  },

  // ─── USER ACTIONS ────────────────────────────────────

  /**
   * Test the Discord webhook configuration.
   */
  async handleTestDiscord() {
    const btn = document.getElementById('settings-test-discord-btn');
    const statusEl = document.getElementById('settings-discord-status');

    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Testing...';
    }

    try {
      await API.post('/settings/test-discord');
      if (statusEl) {
        statusEl.textContent = 'Discord test sent successfully.';
        statusEl.className = 'settings-test-status success';
        statusEl.classList.remove('hidden');
      }
    } catch (err) {
      if (statusEl) {
        statusEl.textContent = `Discord test failed: ${err.message}`;
        statusEl.className = 'settings-test-status error';
        statusEl.classList.remove('hidden');
      }
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Test Discord';
      }
    }
  },

  /**
   * Test the email delivery configuration.
   * Passes current form values (or DB values) to the test-email endpoint.
   */
  async handleTestEmail() {
    const btn = document.getElementById('settings-test-email-btn');
    const statusEl = document.getElementById('settings-email-status');

    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Testing...';
    }

    try {
      // Gather credentials from form inputs, falling back to DB values
      const sender = document.getElementById('email-sender')?.value.trim()
        || this.data?.email_sender || '';
      const appPassword = document.getElementById('email-app-password')?.value.trim()
        || this.data?.email_app_password || '';
      const recipient = document.getElementById('email-address')?.value.trim()
        || this.data?.email_recipient || '';

      await API.post('/settings/test-email', {
        sender,
        app_password: appPassword,
        recipient,
      });
      if (statusEl) {
        statusEl.textContent = 'Test email sent successfully.';
        statusEl.className = 'settings-test-status success';
        statusEl.classList.remove('hidden');
      }
    } catch (err) {
      if (statusEl) {
        statusEl.textContent = `Email test failed: ${err.message}`;
        statusEl.className = 'settings-test-status error';
        statusEl.classList.remove('hidden');
      }
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Test Email';
      }
    }
  },

  // ─── RENDERING ───────────────────────────────────────

  /**
   * Render the settings form with current values.
   */
  render() {
    const body = document.getElementById('settings-body');
    if (!body || !this.data) return;

    // Restore input values
    this._setInputValue('discord-webhook', this.data.discord_webhook_url || '');
    this._setInputValue('email-sender', this.data.email_sender || '');
    this._setInputValue('email-app-password', this.data.email_app_password || '');
    this._setInputValue('email-address', this.data.email_recipient || '');

    // Restore toggle states from DB settings
    this._setCheckboxValue('discord-alerts-enabled', this._toBool(this.data.discord_alerts_enabled, true));
    this._setCheckboxValue('discord-daily-summary', this._toBool(this.data.discord_daily_summary, false));
    this._setCheckboxValue('email-price-alerts', this._toBool(this.data.email_price_alerts, false));
    this._setCheckboxValue('email-earnings-alerts', this._toBool(this.data.email_earnings_alerts, false));
    this._setCheckboxValue('email-weekly-digest', this._toBool(this.data.email_weekly_digest, false));

    // Show the content body
    this.hideLoading();
  },

  /**
   * Set an input element's value safely.
   *
   * @param {string} id
   * @param {string} value
   * @private
   */
  _setInputValue(id, value) {
    const el = document.getElementById(id);
    if (el) el.value = value;
  },

  /**
   * Set a checkbox element's checked state safely.
   *
   * @param {string} id
   * @param {boolean} checked
   * @private
   */
  _setCheckboxValue(id, checked) {
    const el = document.getElementById(id);
    if (el) el.checked = checked;
  },

  /**
   * Convert a DB setting value (string "true"/"false" or boolean) to boolean.
   *
   * @param {*} value - The raw value from the API
   * @param {boolean} defaultValue - Fallback if value is undefined/null
   * @returns {boolean}
   * @private
   */
  _toBool(value, defaultValue = false) {
    if (value === undefined || value === null) return defaultValue;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') return value.toLowerCase() === 'true' || value === '1';
    return defaultValue;
  },

  // ─── WEBHOOK SAVE ──────────────────────────────────────

  /**
   * Save just the Discord webhook URL to the backend.
   */
  async handleSaveWebhook() {
    const btn = document.getElementById('settings-save-webhook-btn');
    const webhookInput = document.getElementById('discord-webhook');

    if (!webhookInput) return;
    const webhookUrl = webhookInput.value.trim();

    if (!webhookUrl) {
      this._showWebhookStatus('Please enter a webhook URL.', 'error');
      return;
    }

    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Saving...';
    }

    try {
      await API.put('/settings', { discord_webhook_url: webhookUrl });
      this.data = this.data || {};
      this.data.discord_webhook_url = webhookUrl;
      this._showWebhookStatus('Webhook URL saved.', 'success');
    } catch (err) {
      this._showWebhookStatus(`Save failed: ${err.message}`, 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Save';
      }
    }
  },

  /**
   * Show a temporary status message near the webhook save button.
   *
   * @param {string} message
   * @param {'success'|'error'} type
   * @private
   */
  _showWebhookStatus(message, type) {
    const statusEl = document.getElementById('settings-discord-status');
    if (!statusEl) return;
    statusEl.textContent = message;
    statusEl.className = `settings-test-status ${type}`;
    statusEl.classList.remove('hidden');
    setTimeout(() => statusEl.classList.add('hidden'), 4000);
  },

  // ─── EMAIL SAVE ───────────────────────────────────────

  /**
   * Save email credentials (sender, app password, recipient) to the backend.
   */
  async handleSaveEmail() {
    const btn = document.getElementById('settings-save-email-btn');
    const senderInput = document.getElementById('email-sender');
    const appPasswordInput = document.getElementById('email-app-password');
    const recipientInput = document.getElementById('email-address');

    const sender = senderInput?.value.trim() || '';
    const appPassword = appPasswordInput?.value.trim() || '';
    const recipient = recipientInput?.value.trim() || '';

    if (!sender || !appPassword || !recipient) {
      this._showEmailStatus('All three fields are required (sender, app password, recipient).', 'error');
      return;
    }

    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Saving...';
    }

    try {
      await API.put('/settings', {
        email_sender: sender,
        email_app_password: appPassword,
        email_recipient: recipient,
      });
      this.data = this.data || {};
      this.data.email_sender = sender;
      this.data.email_app_password = appPassword;
      this.data.email_recipient = recipient;
      this._showEmailStatus('Email settings saved.', 'success');
    } catch (err) {
      this._showEmailStatus(`Save failed: ${err.message}`, 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Save';
      }
    }
  },

  /**
   * Show a temporary status message near the email save/test button.
   *
   * @param {string} message
   * @param {'success'|'error'} type
   * @private
   */
  _showEmailStatus(message, type) {
    const statusEl = document.getElementById('settings-email-status');
    if (!statusEl) return;
    statusEl.textContent = message;
    statusEl.className = `settings-test-status ${type}`;
    statusEl.classList.remove('hidden');
    setTimeout(() => statusEl.classList.add('hidden'), 4000);
  },

  // ─── UI HELPERS ──────────────────────────────────────

  showLoading() {
    const loading = document.getElementById('settings-loading');
    const body = document.getElementById('settings-body');
    if (loading) loading.classList.remove('hidden');
    if (body) body.classList.add('hidden');
  },

  hideLoading() {
    const loading = document.getElementById('settings-loading');
    const body = document.getElementById('settings-body');
    if (loading) loading.classList.add('hidden');
    if (body) body.classList.remove('hidden');
  },

  showError(message) {
    const error = document.getElementById('settings-error');
    const body = document.getElementById('settings-body');
    if (error) {
      const msgEl = error.querySelector('.error-message');
      if (msgEl) msgEl.textContent = message;
      error.classList.remove('hidden');
    }
    if (body) body.classList.add('hidden');
  },

  hideError() {
    const error = document.getElementById('settings-error');
    if (error) error.classList.add('hidden');
  },
};

// ES module export for app.js dynamic import
export default Settings;

// CommonJS fallback (for Node/testing)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = Settings;
}
