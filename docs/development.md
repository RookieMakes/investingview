# Development and API notes

[Back to the README](../README.md)

## Source layout

```text
investingview/
├── backend/
│   ├── app.py             # Flask factory, blueprint registration, startup
│   ├── config.py          # Database path, default universe, analysis constants
│   ├── data/              # Market-data adapters and SQLite-backed caching
│   ├── models/            # Schema, connections, and startup migrations
│   ├── routes/            # HTTP API blueprints
│   ├── services/          # Portfolio analysis, scans, news, notifications, jobs
│   ├── tests/             # Existing pytest suite
│   └── requirements.txt   # Python runtime dependencies
├── frontend/
│   ├── index.html         # Application shell and navigation
│   ├── screens/           # Dynamically loaded screen templates
│   ├── js/
│   │   ├── app.js         # Router, screen lifecycle, theme, global alerts
│   │   ├── api.js         # Same-origin API client
│   │   ├── modules/       # Screen-specific behavior
│   │   └── components/    # Shared charts, ticker, activity calendar, controls
│   ├── css/               # Shared and feature-specific styling
│   ├── assets/            # Static assets and app icons
│   ├── manifest.json      # Installable web app metadata
│   └── sw.js              # Static-asset caching; API requests bypass it
├── docs/                  # Usage, operations, development, screenshots
├── data/                  # Runtime SQLite storage, not source fixtures
├── logs/                  # Runtime log directory
├── Dockerfile
├── docker-compose.yml
└── docker-compose.preview.yml
```

## Application flow

### Backend

`create_app()` registers the active Flask blueprints and serves the frontend.
The browser uses the same origin for HTML/assets, JSON API requests, and
server-sent events.

`startup()` is a distinct lifecycle step:

1. Initialize SQLite tables and apply incremental migrations.
2. Seed the default stock universe.
3. Check stored dashboard data and request an initial fetch when needed.
4. Populate earnings dates if the table is empty.
5. Register and start APScheduler jobs.

The script entry point calls startup in the serving reloader child to avoid
starting duplicate schedulers. Calling the factory alone, as a test or isolated
UI preview does, deliberately omits startup work. A custom server entry point
must handle that distinction.

`models/db.py` provides context-managed connections with foreign keys and WAL
enabled, commits on successful exit, and rolls back on exceptions. Services and
routes own domain operations. The scheduler invokes service functions rather
than making loopback HTTP calls.

The live-price service owns a process-wide Yahoo WebSocket and forwards ticks
to active browser EventSource connections. Subscription demand and caches are
in memory; quote persistence is throttled. Daily candle history remains separate
from the live tick stream.

### Frontend

`frontend/js/app.js` maps screen keys to HTML templates and dynamically imported
modules. The active module is torn down when navigating away, allowing charts,
event listeners, timers, and streams to be cleaned up. Navigation does not use
server-side screen URLs or browser-path routing.

The active screens are Portfolio, Alerts, Charts, Scanner, Earnings, Universe,
Transactions, News, and Settings. Documentation describes these registered
screens and their connected features.

There is no bundler, npm install, or frontend compilation step. JavaScript
modules are served directly. The chart library and TradingView widgets are
loaded externally by the browser.

### Shared expanded chart

Use the app-level chart component rather than adding per-screen modal copies:

```js
import ChartModal from '../components/chart-modal.js';

// A market-only chart.
ChartModal.open(ticker, companyName);

// A chart associated with a particular holding.
ChartModal.open(ticker, companyName, {
  trigger: tickerButton,
  holding: {
    portfolioId,
    name,
    currency,
    position,
    transactions,
  },
});
```

Holding context is explicit. Omitting `transactions` lets the component load them
for that portfolio. The renderer uses the supplied context for P/L, average-price
and transaction overlays, and trailing stops.

| File | Responsibility |
| --- | --- |
| `frontend/screens/chart-modal.html` | Canonical modal markup and controls. |
| `frontend/css/chart-modal.css` | Shared desktop/mobile presentation. |
| `frontend/js/components/chart-modal.js` | Modal host, opening/closing, focus handling, screen ticker links. |
| `frontend/js/components/chart-renderer.js` | Data loading, chart modes, overlays, streams, and cleanup. |
| `frontend/js/components/chart-utils.js` | Shared library loading, theme colors, and text escaping. |

The host lives outside routed screen content. Navigation closes its chart and
live stream. Charts-grid drawing uses its own level-type picker.

## Data boundaries

- **Holdings and ledger:** Portfolio buys/sells update both. Direct position edits
  and transaction corrections intentionally do not synchronize the two datasets.
- **Realized sale snapshots:** captures of Portfolio sell-time basis, separate from
  lifetime-average ledger summaries.
- **Research history:** rankings, scanner sessions, score histories, ETF snapshots,
  and P/L snapshots persist in SQLite.
- **Earnings Watchlist:** a read-only projection over stored daily prices and
  earnings dates. Its service uses a read-only SQLite connection.
- **Market providers:** Yahoo-derived quote/candle paths have feature-specific
  caches. The TradingView ticker fetches its own data in the browser.
- **Browser storage:** theme and selected UI preferences are distinct from
  database-persisted settings.

Changing formulas or data ownership should include a review of the corresponding
analytics, scheduled jobs, API consumers, and usage documentation. Trend Quality
model revisions are versioned so incompatible scores do not share a history
series.

## Representative API endpoints

Paths below are relative to the app origin. The API uses JSON for ordinary
requests/responses; `/api/stream/prices` uses an event stream. This is a map of
useful entry points, not a complete versioned API specification. The registered
blueprints remain the authoritative definitions.

| Area | Method and path | Purpose |
| --- | --- | --- |
| Health | `GET /api/health` | Basic service liveness. |
| Portfolios | `GET`, `POST /api/portfolio` | List or create portfolios. |
| Portfolio | `GET`, `PUT`, `DELETE /api/portfolio/<id>` | Read, update, or delete a portfolio. |
| Ordering | `PUT /api/portfolio/order` | Save portfolio order. |
| Cash | `GET`, `PUT /api/portfolio/<id>/cash` | Read/set `cash_cents`. |
| Positions | `GET`, `POST /api/portfolio/<id>/positions` | List or directly add a position. |
| Buy / sell | `POST /api/portfolio/<id>/positions/buy` or `/sell` | Record a Portfolio trade and associated changes. |
| Ledger | `GET`, `POST /api/portfolio/<id>/transactions` | Paginated ledger or standalone correction entry. |
| Sale snapshots | `GET /api/portfolio/<id>/realized-trades` | Immutable sale-time results and portfolio-wide best/worst trades. |
| Profit summary | `GET /api/portfolio/<id>/profit-summary` | Lifetime-average realized P/L by ticker. |
| Activity | `GET /api/portfolio/<id>/trading-activity?year=2026` | Full-ledger daily activity and monthly day totals. |
| P/L history | `GET /api/portfolio/<id>/pnl-history` | Recorded portfolio P/L snapshots. |
| Stops | `GET`, `POST`, `DELETE /api/portfolio/<id>/trailing-stops/<ticker>` | Read, create, or delete a holding's stop. |
| Quotes | `GET /api/data/quotes?tickers=AAPL,MSFT` | Yahoo-derived quote data. |
| History | `GET /api/data/history?ticker=AAPL&period=1y&interval=1d` | Provider/cache-backed OHLCV history. |
| Stored history | `GET /api/data/history/stored?ticker=AAPL` | Daily candles already in SQLite; no provider fetch. |
| Live status | `GET /api/stream/status?ticker=AAPL` | Streaming/session diagnostics. |
| Live ticks | `GET /api/stream/prices?tickers=AAPL` | Server-sent price events. |
| Earnings | `GET /api/earnings/watchlist` | Completed-session research scores and metadata. |
| Refresh | `POST /api/refresh` | Run the dashboard's price-data refresh. |
| Status | `GET /api/status` | Dashboard fetch timestamps and schedule information. |
| Scanner rankings | `GET /api/scanner/ranking?type=momentum` | Saved Momentum/Reversal rankings. |
| ETF holdings | `GET /api/scanner/etf-holdings?etf=SPY` | Latest published holdings board. |
| ETF history | `GET /api/scanner/etf-holdings/history?etf=SPY&ticker=AAPL` | Dated holdings history for a symbol. |
| Swing / ORB | `GET /api/scanner/swing` or `/api/scanner/orb` | Stored-data research boards. |
| Chart tabs | `GET`, `POST /api/tabs` | Load or save the chart workspace. |
| S/R | `GET`, `POST /api/sr/levels` | Read or create support/resistance levels. |
| Alerts | `GET`, `POST /api/alerts` | List or create configured alerts. |
| Alert history | `GET /api/alerts/history` | Fired-event history. |
| Watchlists | `GET`, `POST /api/watchlists` | List or create watchlists. |
| Universe | `GET`, `POST /api/universe` | List the universe or add a custom symbol. |
| News | `GET /api/news/ticker/<symbol>` | Recent ticker headlines. |
| Movers | `GET /api/news/movers`; `POST /api/news/movers/refresh` | Read or rebuild the saved digest. |
| Settings | `GET`, `PUT /api/settings` | Load or update persisted settings. |
| Market ticker | `GET`, `PUT /api/settings/market-ticker` | Load or save ticker configuration. |

For example:

```bash
curl http://localhost:9000/api/health
curl 'http://localhost:9000/api/data/history/stored?ticker=AAPL'
curl 'http://localhost:9000/api/earnings/watchlist'
```

The sale-snapshot endpoint supports `page`, `per_page` (up to 200), and `sort`
in `<column>:asc` / `<column>:desc` form. Trade-entry bodies use `ticker`, `qty`,
`price`, and optional `date` in `YYYY-MM-DD` form. See route validation before
building an integration; some scan endpoints perform computation and persistence
despite using GET.

## Tests

Install application dependencies as shown in the README, then install `pytest`.
Keep test databases independent from a working application's database:

```bash
python -m pip install pytest
DATABASE_PATH="$(mktemp -d)/investingview-tests.db" \
  PYTHONPATH=backend python -m pytest backend/tests -q
```

This command uses a POSIX shell and creates a disposable database directory.
`pytest` is a development dependency; it is not listed in the runtime requirements.
Several fixtures patch the database path themselves, but the explicit environment
override also protects tests that use the configured path.

Existing tests cover average-price checks, ETF feed parsing/snapshot history,
trading activity, trailing-stop calculations, holding lifecycle, migrations,
concurrent hit handling, and notification integration. Some route paths can
attempt Yahoo lookups, so the full suite is not guaranteed to be offline-only.
Use verbose output to identify a slow provider-dependent test:

```bash
DATABASE_PATH="$(mktemp -d)/investingview-tests.db" \
  PYTHONPATH=backend python -m pytest backend/tests -vv
```

For frontend changes, exercise the affected screen in both desktop and mobile
layouts, check browser errors, and verify dark mode and cleanup on navigation
when relevant. Screenshots in `docs/screenshots` demonstrate the UI; they are not
an automated visual regression suite.

## Contributing

For a bug report, include the affected screen, steps to reproduce, expected and
actual behavior, relevant application logs, and browser/device details where
applicable. Use synthetic examples for portfolio data and omit credentials.

For a pull request:

1. Keep the change focused and follow the existing Flask blueprint/service and
   frontend module/component boundaries.
2. Preserve explicit portfolio ownership for holding-related charts, analytics,
   and trailing stops.
3. Use additive startup migrations for schema changes and verify existing-data
   behavior as well as a fresh database.
4. Add or update meaningful tests when changing domain behavior, and state what
   was verified.
5. Update the relevant usage or operations documentation when behavior changes.

There is no prescribed formatter, frontend package build, or CI workflow defined
by this documentation.
