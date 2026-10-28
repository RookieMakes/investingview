import { MARKET_TICKER_ENDPOINT, MAX_INSTRUMENTS, SYMBOL_PATTERN, defaultTickerSettings } from './market-ticker.js';

const clone = value => JSON.parse(JSON.stringify(value));
const element = (tag, className, value) => {
  const node = document.createElement(tag); node.className = className; node.textContent = value; return node;
};

/** Owns only the market ticker form; notification inputs and saves are independent. */
export default class MarketTickerSettings {
  constructor() {
    this.root = document.getElementById('market-ticker-settings');
    this.dialog = document.getElementById('market-ticker-dialog');
    this.form = document.getElementById('market-ticker-form');
    this.request = new AbortController();
    this.destroyed = false;
    this.saving = false;
    this.editIndex = null;
  }

  get(id) { return document.getElementById(`market-ticker-${id}`); }

  async init() {
    this.form.addEventListener('submit', event => { event.preventDefault(); this.save(); });
    this.get('enabled').addEventListener('change', event => { this.draft.enabled = event.target.checked; this.changed(); });
    this.get('charts').addEventListener('change', event => { this.draft.charts = event.target.checked; this.changed(); });
    this.get('add').addEventListener('click', () => this.openDialog());
    this.get('retry').addEventListener('click', () => this.load());
    this.get('reset').addEventListener('click', () => {
      this.draft = defaultTickerSettings(); this.render();
      this.setStatus('Defaults restored. Save market ticker to apply.');
    });
    for (const id of ['dialog-close', 'dialog-cancel']) this.get(id).addEventListener('click', () => this.dialog.close());
    this.get('instrument-form').addEventListener('submit', event => { event.preventDefault(); this.applyInstrument(); });
    await this.load();
  }

  async load() {
    this.get('loading').hidden = false;
    this.get('error').hidden = true;
    this.get('retry').hidden = true;
    this.form.hidden = true;
    try {
      const config = await API.get(MARKET_TICKER_ENDPOINT, {}, this.request.signal);
      if (this.destroyed) return;
      this.saved = config; this.draft = clone(config);
      this.form.hidden = false; this.render();
    } catch (error) {
      if (this.destroyed) return;
      this.showError(`Unable to load market ticker settings: ${error.message}`);
      this.get('retry').hidden = false;
    } finally {
      if (!this.destroyed) this.get('loading').hidden = true;
    }
  }

  setStatus(message, type = '') {
    const status = this.get('save-status');
    status.textContent = message;
    status.className = `settings-test-status ${type}`;
  }

  showError(message) { this.get('error').textContent = message; this.get('error').hidden = false; }

  changed() {
    this.get('save').disabled = this.saving || JSON.stringify(this.draft) === JSON.stringify(this.saved);
    this.setStatus(this.get('save').disabled ? '' : 'Unsaved ticker changes.');
    this.get('error').hidden = true;
    this.get('count').textContent = `${this.draft.instruments.filter(item => item.desktop).length} desktop · ${this.draft.instruments.filter(item => item.mobile).length} mobile`;
  }

  render(focusSymbol, action) {
    this.get('enabled').checked = this.draft.enabled;
    this.get('charts').checked = this.draft.charts;
    const list = this.get('list'); list.replaceChildren();
    this.draft.instruments.forEach((item, index) => {
      const row = document.createElement('div'); row.className = 'market-ticker-row'; row.dataset.symbol = item.symbol;
      const order = document.createElement('div'); order.className = 'market-ticker-order';
      for (const [direction, glyph, delta] of [['up', '↑', -1], ['down', '↓', 1]]) {
        const button = element('button', '', glyph); button.type = 'button'; button.dataset.action = direction;
        button.setAttribute('aria-label', `Move ${item.name} ${direction}`);
        button.disabled = index + delta < 0 || index + delta >= this.draft.instruments.length;
        button.addEventListener('click', () => {
          [this.draft.instruments[index], this.draft.instruments[index + delta]] = [this.draft.instruments[index + delta], this.draft.instruments[index]];
          this.render(item.symbol, direction);
        }); order.append(button);
      }
      const identity = document.createElement('button'); identity.type = 'button'; identity.className = 'market-ticker-identity';
      identity.setAttribute('aria-label', `Edit ${item.name}`);
      identity.append(element('span', 'market-ticker-name', item.name), element('span', 'market-ticker-symbol', item.symbol));
      identity.addEventListener('click', () => this.openDialog(index));
      const visibility = document.createElement('div'); visibility.className = 'market-ticker-visibility';
      for (const device of ['desktop', 'mobile']) {
        const label = document.createElement('label'), checkbox = document.createElement('input');
        checkbox.type = 'checkbox'; checkbox.checked = item[device];
        checkbox.setAttribute('aria-label', `Show ${item.name} on ${device}`);
        checkbox.addEventListener('change', () => { item[device] = checkbox.checked; this.changed(); });
        label.append(checkbox, document.createTextNode(device === 'desktop' ? 'Desktop' : 'Mobile')); visibility.append(label);
      }
      const remove = element('button', 'market-ticker-remove', '×'); remove.type = 'button'; remove.dataset.action = 'remove';
      remove.setAttribute('aria-label', `Remove ${item.name}`);
      remove.addEventListener('click', () => {
        this.draft.instruments.splice(index, 1); this.render();
        const next = list.children[Math.min(index, list.children.length - 1)];
        (next?.querySelector('.market-ticker-remove') || this.get('add')).focus();
      });
      row.append(order, identity, visibility, remove); list.append(row);
    });
    this.changed();
    if (focusSymbol) {
      const row = [...list.children].find(node => node.dataset.symbol === focusSymbol);
      const preferred = row?.querySelector(`[data-action="${action}"]`);
      (preferred && !preferred.disabled ? preferred : row?.querySelector('.market-ticker-identity'))?.focus();
    }
  }

  openDialog(index = null) {
    if (index === null && this.draft.instruments.length >= MAX_INSTRUMENTS) {
      this.showError(`Choose up to ${MAX_INSTRUMENTS} instruments.`); return;
    }
    this.editIndex = index;
    const item = index === null ? null : this.draft.instruments[index];
    this.get('instrument-form').reset();
    this.get('dialog-title').textContent = item ? 'Edit Instrument' : 'Add Instrument';
    this.get('dialog-submit').textContent = item ? 'Apply changes' : 'Add instrument';
    this.get('symbol').value = item?.symbol || '';
    this.get('name').value = item?.name || '';
    this.get('instrument-desktop').checked = item?.desktop ?? true;
    this.get('instrument-mobile').checked = item?.mobile ?? false;
    this.get('dialog-error').hidden = true;
    this.dialog.showModal();
    this.get('symbol').focus();
  }

  applyInstrument() {
    const item = {
      symbol: this.get('symbol').value.trim().toUpperCase(), name: this.get('name').value.trim(),
      desktop: this.get('instrument-desktop').checked, mobile: this.get('instrument-mobile').checked,
    };
    let error = '';
    if (!SYMBOL_PATTERN.test(item.symbol)) error = 'Use a TradingView symbol such as NASDAQ:AAPL.';
    else if (this.draft.instruments.some((existing, index) => index !== this.editIndex && existing.symbol === item.symbol)) error = 'That symbol is already in your list.';
    else if (!item.name) error = 'Enter a display name.';
    else if (!item.desktop && !item.mobile) error = 'Select desktop, mobile, or both.';
    if (error) { this.get('dialog-error').textContent = error; this.get('dialog-error').hidden = false; return; }
    if (this.editIndex === null) this.draft.instruments.push(item);
    else this.draft.instruments[this.editIndex] = item;
    this.dialog.close();
    this.render(item.symbol, 'edit');
  }

  async save() {
    if (this.saving) return;
    if (this.draft.enabled && (!this.draft.instruments.some(item => item.desktop) || !this.draft.instruments.some(item => item.mobile))) {
      this.showError('Select at least one desktop and one mobile instrument, or turn the ticker off.'); return;
    }
    // Snapshot the ticker alone. No notification fields are read or submitted.
    const config = clone(this.draft);
    this.saving = true;
    this.get('save').disabled = true;
    this.get('save').textContent = 'Saving…';
    this.setStatus(''); this.get('error').hidden = true;
    try {
      const saved = await API.put(MARKET_TICKER_ENDPOINT, config, this.request.signal);
      if (this.destroyed) return;
      this.saved = saved;
      window.dispatchEvent(new CustomEvent('market-ticker-settings-changed', { detail: saved }));
      this.setStatus('Market ticker saved.', 'success');
    } catch (error) {
      if (!this.destroyed) this.showError(`Ticker save failed: ${error.message}`);
    } finally {
      this.saving = false;
      if (!this.destroyed) {
        this.get('save').textContent = 'Save market ticker';
        this.get('save').disabled = JSON.stringify(this.draft) === JSON.stringify(this.saved);
        if (!this.get('save').disabled && this.get('error').hidden) this.setStatus('Saved. You have additional unsaved ticker changes.');
      }
    }
  }

  destroy() {
    this.destroyed = true;
    this.request.abort();
    if (this.dialog.open) this.dialog.close();
  }
}
