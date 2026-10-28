# Screenshot gallery

These images show the application running with synthetic demonstration data.
Portfolio names, holdings, trades, prices, returns, and earnings dates are
illustrative; they are not a live account or a record of market performance.

Screenshots were captured in Chromium at desktop (1600 × 1000) and mobile
(390 × 844, touch-enabled) viewport sizes. Mobile images demonstrate the responsive
web layout, rather than a native application or a physical-device capture.

The capture instance used a dedicated Docker container with an in-memory SQLite
database and temporary logs. It did not mount or copy a live database. Market
responses needed for the demonstration were supplied from synthetic fixtures;
the TradingView market-ticker embed loaded its own provider quotes. The
application UI was rendered by the existing frontend. Background jobs and
outbound notifications were not started. The temporary container was removed
after capture.

## Images

| View | Desktop | Mobile |
| --- | --- | --- |
| Portfolio | [Light](portfolio-desktop.png) · [Dark](portfolio-desktop-dark.png) | [Overview](portfolio-mobile.png) · [Holdings](portfolio-mobile-holdings.png) |
| Earnings | [Watchlist](earnings-desktop.png) | [Summary](earnings-mobile.png) · [Research cards](earnings-mobile-details.png) |
| Expanded chart | [Chart](chart-desktop.png) | [Chart](chart-mobile.png) |
| Transactions | [Analytics](transactions-desktop.png) | [Analytics](transactions-mobile.png) |
| Scanner | [Momentum board](scanner-desktop.png) | — |
