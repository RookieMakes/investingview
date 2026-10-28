/** Pure Earnings presentation helpers, independent of the shared chart modules. */
export const isNumber = value => typeof value === 'number' && Number.isFinite(value);

export function signed(value, digits = 1, suffix = '') {
  if (!isNumber(value)) return '—';
  const rounded = Number(value.toFixed(digits));
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(digits)}${suffix}`;
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

export function tone(value, threshold = 0) {
  return !isNumber(value) ? 'missing' : value > threshold ? 'up' : value < -threshold ? 'down' : 'flat';
}

export function heatLevel(value) {
  if (!isNumber(value) || Math.abs(value) <= 0.15) return 0;
  return Math.abs(value) < 1 ? 1 : Math.abs(value) < 3 ? 2 : 3;
}

export function earningsLabel(stock) {
  if (stock.earnings_status === 'unknown') return 'Date unavailable';
  if (stock.earnings_status === 'pending') return 'Awaiting date update';
  return stock.days_to_earnings === 0 ? 'Today' : `In ${stock.days_to_earnings} days`;
}

function descending(a, b, key) {
  const av = a[key], bv = b[key];
  if (!isNumber(av)) return isNumber(bv) ? 1 : 0;
  if (!isNumber(bv)) return -1;
  return bv - av;
}

export function filterStocks(stocks, filters, sort = 'score') {
  const query = (filters.search || '').trim().toLowerCase();
  const rows = stocks.filter(stock => {
    if (filters.earnings === 'unknown') {
      if (!['unknown', 'pending'].includes(stock.earnings_status)) return false;
    } else if (filters.earnings !== 'all') {
      if (!isNumber(stock.days_to_earnings) || stock.days_to_earnings < 0
          || stock.days_to_earnings > Number(filters.earnings)) return false;
    }
    if (filters.sector !== 'all' && stock.sector !== filters.sector) return false;
    if (query && !`${stock.symbol} ${stock.name}`.toLowerCase().includes(query)) return false;
    if (filters.signal === 'positive' && !(isNumber(stock.score) && stock.score > 0)) return false;
    if (filters.signal === 'negative' && !(isNumber(stock.score) && stock.score < 0)) return false;
    if (filters.signal === 'unscored' && isNumber(stock.score)) return false;
    return true;
  });
  return rows.sort((a, b) => {
    if (sort === 'earnings') {
      const ad = isNumber(a.days_to_earnings) && a.days_to_earnings >= 0 ? a.days_to_earnings : Infinity;
      const bd = isNumber(b.days_to_earnings) && b.days_to_earnings >= 0 ? b.days_to_earnings : Infinity;
      if (ad !== bd) return ad - bd;
    } else {
      const order = descending(a, b, sort);
      if (order) return order;
    }
    return descending(a, b, 'score') || descending(a, b, 'rs_10d')
      || descending(a, b, 'return_10d') || a.symbol.localeCompare(b.symbol);
  });
}
