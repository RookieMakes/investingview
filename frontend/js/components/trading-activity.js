/** Portfolio trading calendar. Counts come from the complete ledger, not a page. */
export default class TradingActivity {
  constructor(root) {
    this.root = root;
    this.viewport = root.querySelector('.trading-activity-viewport');
    this.months = root.querySelector('.trading-activity-months');
    this.year = null;
    this.portfolioId = null;
    this.requestId = 0;
    this.targetMonth = new Date().getMonth();
    this.onClick = (event) => {
      const action = event.target.closest('[data-activity-action]')?.dataset.activityAction;
      if (action === 'prev') this.load(this.portfolioId, this.year - 1);
      if (action === 'next') this.load(this.portfolioId, this.year + 1);
      if (action === 'retry') this.load(this.portfolioId, this.year);
      this.showDay(event.target.closest('[data-date]'));
    };
    this.onFocus = (event) => this.showDay(event.target.closest('[data-date]'));
    this.onKey = (event) => this.moveFocus(event);
    root.addEventListener('click', this.onClick);
    root.addEventListener('focusin', this.onFocus);
    root.addEventListener('pointerover', this.onFocus);
    root.addEventListener('keydown', this.onKey);
    this.onScroll = () => {
      if (this.viewport.scrollWidth <= this.viewport.clientWidth + 1) return;
      const center = this.viewport.scrollLeft + this.viewport.clientWidth / 2;
      let closest = Infinity;
      this.months.querySelectorAll('.trading-activity-month').forEach((month, index) => {
        const distance = Math.abs(month.offsetLeft + month.offsetWidth / 2 - center);
        if (distance < closest) {
          closest = distance;
          this.targetMonth = index;
        }
      });
    };
    this.viewport.addEventListener('scroll', this.onScroll, { passive: true });
    this.resizeObserver = new ResizeObserver(() => this.centerMonth());
    this.resizeObserver.observe(this.viewport);
  }

  destroy() {
    this.requestId += 1;
    this.controller?.abort();
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    this.root.removeEventListener('click', this.onClick);
    this.root.removeEventListener('focusin', this.onFocus);
    this.root.removeEventListener('pointerover', this.onFocus);
    this.root.removeEventListener('keydown', this.onKey);
    this.viewport.removeEventListener('scroll', this.onScroll);
  }

  async load(portfolioId, year = this.year) {
    const changedPortfolio = portfolioId !== this.portfolioId;
    const preserveScroll = this.renderedPortfolioId === portfolioId && this.renderedYear === year;
    const scrollLeft = this.viewport.scrollLeft;
    if (changedPortfolio) {
      year = null;
      this.targetMonth = new Date().getMonth();
    }
    this.portfolioId = portfolioId;
    this.year = year;
    const requestId = ++this.requestId;
    this.controller?.abort();
    this.controller = new AbortController();
    this.root.setAttribute('aria-busy', 'true');
    this.root.querySelector('.trading-activity-total').textContent = 'Loading trading days…';
    this.root.querySelector('.trading-activity-year').textContent = year ?? '—';
    this.root.querySelector('.trading-activity-detail').textContent = '';
    this.root.querySelector('[data-activity-action="retry"]').hidden = true;
    this.root.querySelectorAll('.year-nav-btn').forEach((button) => { button.disabled = true; });
    this.months.style.visibility = 'hidden';
    try {
      const data = await API.get(`/portfolio/${portfolioId}/trading-activity`, { year }, this.controller.signal);
      if (requestId !== this.requestId) return;
      this.year = data.year;
      this.root.querySelector('.trading-activity-year').textContent = data.year;
      this.root.querySelector('.trading-activity-total').textContent =
        `Trading Days : ${data.year_total} trading ${data.year_total === 1 ? 'day' : 'days'}`;
      this.root.querySelector('[data-activity-action="prev"]').disabled = data.year <= data.min_year;
      this.root.querySelector('[data-activity-action="next"]').disabled = data.year >= data.max_year;
      this.render(data);
      this.renderedPortfolioId = portfolioId;
      this.renderedYear = data.year;
      this.months.style.visibility = '';
      this.root.querySelector('.trading-activity-detail').textContent = data.year_total
        ? 'Hover, tap or focus a day for trade details.' : 'No trading activity recorded for this year.';
      cancelAnimationFrame(this.frame);
      this.frame = requestAnimationFrame(() => {
        if (preserveScroll) this.viewport.scrollLeft = scrollLeft;
        else this.centerMonth();
      });
    } catch (error) {
      if (requestId !== this.requestId) return;
      this.root.querySelector('.trading-activity-total').textContent = 'Unable to load trading days.';
      this.root.querySelector('[data-activity-action="retry"]').hidden = false;
    } finally {
      if (requestId === this.requestId) this.root.setAttribute('aria-busy', 'false');
    }
  }

  render(data) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const fragment = document.createDocumentFragment();
    const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    for (let month = 0; month < 12; month += 1) {
      const first = new Date(data.year, month, 1);
      const label = first.toLocaleDateString('en-US', { month: 'long' });
      const block = document.createElement('section');
      block.className = 'trading-activity-month';
      block.setAttribute('aria-label', `${label} ${data.year}: ${data.monthly_totals[month]} trading days`);
      const heading = document.createElement('h3');
      heading.textContent = label.slice(0, 3);
      if (data.year === today.getFullYear() && month === today.getMonth()) block.classList.add('current');
      const total = document.createElement('div');
      total.className = 'trading-activity-month-total';
      const future = first > today && !data.monthly_totals[month];
      const count = data.monthly_totals[month];
      total.textContent = future ? '—' : `${count} ${count === 1 ? 'day' : 'days'}`;
      const grid = document.createElement('div');
      grid.className = 'trading-activity-grid';
      weekdays.forEach((weekday) => {
        const cell = document.createElement('span');
        cell.className = 'trading-activity-weekday';
        cell.textContent = weekday[0];
        cell.title = weekday;
        grid.append(cell);
      });
      const offset = (first.getDay() + 6) % 7;
      const daysInMonth = new Date(data.year, month + 1, 0).getDate();
      for (let slot = 0; slot < 42; slot += 1) {
        const day = slot - offset + 1;
        if (day < 1 || day > daysInMonth) {
          const blank = document.createElement('span');
          blank.setAttribute('aria-hidden', 'true');
          grid.append(blank);
          continue;
        }
        const date = new Date(data.year, month, day);
        const key = `${data.year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const activity = data.days[key];
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'trading-activity-day';
        cell.dataset.date = key;
        cell.tabIndex = -1;
        if (activity) cell.classList.add('traded');
        if (date > today && !activity) cell.classList.add('future');
        if (+date === +today) {
          cell.classList.add('today');
          cell.setAttribute('aria-current', 'date');
        }
        const fullDate = date.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
        const trades = activity ? activity.buys + activity.sells : 0;
        const detail = activity
          ? `${trades} ${trades === 1 ? 'transaction' : 'transactions'} · ${activity.buys} buys, ${activity.sells} sells`
          : date > today ? 'Future date' : 'No trades';
        cell.dataset.detail = `${fullDate} — ${detail}`;
        cell.setAttribute('aria-label', cell.dataset.detail);
        cell.title = cell.dataset.detail;
        grid.append(cell);
      }
      block.append(heading, total, grid);
      fragment.append(block);
    }
    this.months.replaceChildren(fragment);
    const entry = this.months.querySelector('.today') || this.months.querySelector('[data-date]');
    if (entry) entry.tabIndex = 0;
  }

  centerMonth() {
    const month = this.months.children[this.targetMonth];
    if (!month || !this.viewport.clientWidth) return;
    this.viewport.scrollLeft = month.offsetLeft - (this.viewport.clientWidth - month.offsetWidth) / 2;
  }

  showDay(cell) {
    if (!cell) return;
    this.root.querySelector('.trading-activity-detail').textContent = cell.dataset.detail;
    if (document.activeElement === cell) {
      this.months.querySelector('[tabindex="0"]')?.setAttribute('tabindex', '-1');
      cell.tabIndex = 0;
    }
  }

  moveFocus(event) {
    const cell = event.target.closest('[data-date]');
    const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key];
    if (!cell || !delta) return;
    event.preventDefault();
    const date = new Date(`${cell.dataset.date}T12:00:00`);
    date.setDate(date.getDate() + delta);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const next = this.months.querySelector(`[data-date="${key}"]`);
    if (next) {
      next.focus({ preventScroll: true });
      this.targetMonth = date.getMonth();
      this.centerMonth();
    }
  }
}
