# Using InvestingView

[Back to the README](../README.md)

## Portfolios, positions, and cash

The Portfolio screen is the main entry point. Create separate portfolios for
different accounts or strategies, selecting **USD** or **CAD** for each. Portfolio
order is shared with the Transactions screen. The overview includes CAD-converted
figures using a fetched USD/CAD exchange rate.

Use **BUY** and **SELL** for normal trade entry. A buy creates or increases a
position and adds a BUY ledger record. A sell reduces or closes a position and
adds a SELL record. Partial sales are supported, and the trade date can be entered
explicitly.

### Cash behavior

- Cash is a manually adjustable balance for each portfolio, stored in integer
  cents.
- A Portfolio buy subtracts its rounded trade value, with the balance floored at
  zero. Insufficient recorded cash does not reject the buy.
- A Portfolio sell adds the rounded sale proceeds.
- Direct position edits, moves, and deletions are holding-management operations;
  they do not represent cash transfers or new trades.
- Cash is maintained separately from holdings-based market value and P/L.

The application does not infer deposits, withdrawals, or a complete cash-flow
history from the current balance.

### Understanding the holdings table

| Field | Meaning |
| --- | --- |
| Average price | The position's stored average purchase price; additional buys recalculate it from remaining investment and the new purchase. |
| Cost basis | Quantity × stored average price. |
| Market value / holding value | Quantity × available current price. |
| Unrealized P/L | Market value minus cost basis. |
| Unrecovered capital | Current-cycle purchase outlay minus sale proceeds, floored at zero. |
| Realized P/L | Realized result derived from the current holding cycle's ledger entries. |
| Breakeven price | Unrecovered purchase outlay divided by remaining shares; fully recovered capital can produce a **FREE** designation. |

A holding cycle begins after the ticker's previous ledger quantity returned to
zero, within that portfolio. It is separate from lifetime ticker statistics.
Missing prices are represented as unavailable rather than substituted with the
purchase price; totals can therefore be incomplete when quotes are missing.

The P/L History chart uses recorded daily snapshots. It is not a reconstruction
of every historical account valuation from the day a portfolio was created.

## Transactions and realized P/L

The Transactions screen combines the trade ledger, ticker-level realized P/L,
sale-time snapshots, monthly P/L, and a trading-activity calendar.

### Portfolio trades and manual ledger corrections

Normal trade entry belongs on the Portfolio screen. **Add Transaction**, editing,
and deleting on the Transactions screen change the ledger only: they do not
recalculate holdings or cash. Use them for ledger corrections with that
distinction in mind. Ledger-derived analytics will reflect those corrections.

### Two views of realized results

**Realized P/L by Ticker** uses the lifetime ledger's average purchase price for
each symbol in the selected portfolio:

```text
average buy price = total purchase value / total shares bought
realized P/L = total sale proceeds − (total shares sold × average buy price)
```

**Realized P/L by Trade** stores a separate snapshot for each sale made through
the Portfolio sell action:

- It records the position's average price immediately before the sale, quantity
  sold, proceeds, and realized result.
- The holding change, cash update, SELL ledger entry, and snapshot are committed
  together.
- Later buys or ledger edits do not rewrite an existing snapshot. Deleting its
  ledger record removes the link but preserves the snapshot.
- Historical and manually entered ledger sales are not backfilled.
- A backdated Portfolio sale captures the position's current average at submission;
  it does not reconstruct the position on the entered historical date.
- Best/Worst Trade uses these snapshots across all pages of the selected portfolio,
  ranked by dollar P/L.

The ticker summary and sale snapshots use different bases, so their totals can
differ. Neither view is a FIFO or tax-lot accounting report.

### Trading activity

The calendar counts distinct days with BUY or SELL entries, scoped to the selected
portfolio and year. Daily details include the number of buys and sells. Activity
is calculated from the full ledger, independently of transaction-table pagination.

## Charts

Use the global **Search Chart** control or a ticker link to open the shared
expanded chart. A chart opened from a holding carries that portfolio's position
and transaction context. A market-only lookup does not borrow another portfolio's
cost basis or stop settings.

The daily chart includes volume, a 200-day moving average, earnings markers,
support/resistance levels, and a detected pattern overlay when available. Drawn
levels persist and can be used by the scheduled support/resistance checks.

Additional modes and controls include:

- **Live:** intraday candles and a live price overlay when the provider and session
  allow it. Streaming is gated to weekdays, 04:00–20:00 Eastern Time.
- **TradingView:** the externally hosted chart widget.
- **P/L:** a holding-context view of unrealized profit over time.
- **VP:** desktop volume profile with selectable periods and an anchor.
- **Trailing Stop:** desktop setup for a particular portfolio holding.
- **Get News / Get Chart:** recent ticker headlines in the same modal. The chart
  remains mounted while switching views, preserving its state.

The Charts screen organizes a grid into custom tabs. Its derived tabs surface
holdings for a selected portfolio, earnings tickers, 200 SMA candidates, and a
standalone Live Chart. Normal daily-grid navigation reads stored candles;
explicit refreshes can request fresh provider data.

Mobile uses the shared expanded chart with a responsive layout. Volume-profile
controls and trailing-stop editing are desktop-only; an existing stop line can
still be displayed on mobile.

### Trailing stops

A stop belongs to one portfolio/ticker holding and starts from a completed daily
close. The initial distance between that close and the chosen stop is a fixed
price amount.

When processing a completed session, the evaluator first checks whether the day's
low touched the existing stop. If it survives, the close may raise the next stop;
the stop does not move down. This is daily-candle evaluation, not continuous
intraday execution. A hit is recorded once per stop cycle and can generate
notifications. A hit stop can be re-armed as a new cycle.

Closing, deleting, moving, or changing the ticker of a holding cancels its stop.
Changing quantity or cost, adding shares, and partial sales preserve it. No sell
order is placed automatically.

## Scanner panels

The scanner uses the editable stock universe. Results depend on available price
history and the relevant refresh jobs; an empty board can mean no qualifying
results or no completed data yet.

| Panel | What it shows |
| --- | --- |
| Momentum | Scored uptrend candidates, with qualification streaks and rank movement. |
| Reversal | Scored bounce/reversal candidates and persistent rankings. |
| 200 SMA | Stocks near their 200-day simple moving average; the configured proximity is ±3%. |
| YTD Return | Year-to-date performance rankings and recorded daily history. |
| Earnings | Stocks reporting today or in the upcoming window. |
| Quality Score | **Trend Quality v2**, a candle-based trend score with component details, classifications, exclusions, and versioned history. |
| Swing | Completed-session touches of 3-month/6-month volume-profile value-area high (VAH) and value-area low (VAL), classified by direction. |
| Trade | Opening-range breakout (ORB) long/short boards and later continuation/reversal checkpoint decisions. |
| ETF Holdings | Top 15 published equity holdings by weight, with share quantities and dated rank/weight/share history. |

**Run Scan** requests Momentum, Reversal, 200 SMA, YTD, and Quality Score scans.
The other boards have separate data flows; it is not a universal refresh of every
panel. Momentum and Reversal rank qualified scores of at least three and can also
display below-threshold rows.

Trend Quality v2 requires at least 253 valid daily candles and combines returns,
consistency, downside behavior, momentum, and benchmark-relative performance.
It is a price-trend model, not a company-fundamentals rating. Benchmark matching
uses SPY for unsuffixed symbols and XIC.TO for `.TO` / `.V` listings; unavailable
or unmatched benchmark inputs can make a score provisional.

ETF Holdings supports **XDIV.TO, SPY, QQQ, SOXX, ARKK, DYNF, and DIVO**. Snapshot
dates are issuer publication dates. The first snapshot establishes a baseline;
movement and share-change history need additional publications. Missing historical
share quantities remain unknown rather than inferred from weights.

## Earnings Watchlist

The main Earnings screen is a research view over stored, completed daily sessions.
Filter by announcement window, company/ticker, sector, or momentum direction, and
sort by score, earnings date, return, or relative strength.

The signed momentum score ranges from −100 to +100 and combines:

- 40% ten-session momentum;
- 25% three-session momentum;
- 25% outperformance versus SPY;
- 10% directional consistency.

The model scales return factors by volatility and applies a direction-change
penalty. It needs 21 valid stock closes and 11 matching SPY closes. Today's session
becomes eligible at 16:05 ET; missing required sessions leave a stock unscored.
Earnings proximity adds no score points.

Tap a score for its breakdown or a daily tile for price/volume details. The screen
reloads stored data every five minutes; **Refresh prices** requests the backend's
dashboard refresh, which follows its own weekday rules.

## Alerts and notifications

The Alerts screen manages configured alerts, watchlists, and recent activity.
The global bell panel displays fired-event history.

Implemented scheduled checks include price-above/below thresholds, drawn
support/resistance patterns, holding-average crosses/touches, and portfolio
trailing stops. They run after market close; viewing a live chart does not make
these checks continuous. See the [schedule](operations.md#scheduled-work).

Discord webhook and Gmail sender/app-password/recipient settings are managed from
the gear-icon **Settings** screen, with test-delivery controls. Email delivery for
the supported price-related checks uses the Price Alerts setting. The scheduler
also sends earnings-today and 200 SMA proximity messages to Discord when configured.

The alert form also allows saving a Volume Spike type, but the registered
scheduler does not evaluate volume-spike alerts. Likewise, settings for a daily
summary, weekly digest, and earnings email preferences do not by themselves
establish corresponding scheduled delivery jobs.

## News, universe, and preferences

- **News:** a saved movers digest uses the universe's cached daily price change,
  with a default ±3% mover threshold, a 12-hour headline window, and seven-day
  retention. The screen supports manual refresh and saved-date selection.
- **Chart news:** on-demand Google News RSS headlines use an eight-hour window,
  relevance filtering, deduplication, newest-first order, and a five-minute
  in-memory cache. There is no older-news fallback when the window is empty.
- **Universe:** add and manage custom symbols and company/sector metadata used
  across research views. A fresh database is seeded with the default universe.
- **Market ticker:** select and order TradingView instruments, choose desktop and
  mobile visibility independently, and enable desktop mini charts. These widget
  prices are separate from Yahoo-derived portfolio valuations.
- **Appearance:** light/dark preference is stored in the browser. Supported
  browsers can install the app to the home screen. Static caching does not make
  the database, news, or market-data APIs available offline.
