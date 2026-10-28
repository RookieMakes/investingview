# Running and maintaining an instance

[Back to the README](../README.md)

## Configuration and storage

Run commands from the repository root unless stated otherwise.

| Setting | Current behavior |
| --- | --- |
| HTTP port | `9000`, defined by `APP_PORT` in `backend/config.py`; Compose maps host port 9000 to container port 9000. |
| `DATABASE_PATH` | SQLite file path. Defaults to `data/investingview.db` relative to the working directory; Docker sets `/data/investingview.db`. |
| `TZ` | Compose and the Docker image set `America/New_York`. Scheduled jobs use explicit Eastern/Toronto time zones as described below. |
| `FLASK_ENV` | Compose sets `production`, but this does not override the entry point's explicit `debug=True`. |
| Notification settings | Saved through the Settings UI in the SQLite `settings` table. |
| Market ticker | Instrument selection, ordering, per-device visibility, and desktop mini-chart preference are saved through Settings. |
| Browser preferences | Theme and some display preferences are held in browser storage. |

There is no required environment-file setup. The supplied `.env.example` contains
notes, not secrets or a required configuration template. The application does not
load a dotenv file itself.

### Docker persistence

The main Compose service uses these bind mounts:

| Host path | Container path | Purpose |
| --- | --- | --- |
| `./data` | `/data` | SQLite database and its WAL/shared-memory companion files. |
| `./logs` | `/app/logs` | Location available for application file logs. |

Operational Python output is also available through `docker compose logs`.
Database tables and incremental migrations are applied at startup. A fresh
database starts with the default ticker universe and no personal portfolios.

Settings, including notification credentials, are part of the database. Treat
database backups as private instance data.

## Runtime and network access

The supplied entry point is `python backend/app.py`. It uses Flask's development
server with debug/reloader enabled and binds to `0.0.0.0:9000`. The Compose port
mapping publishes that port on all host interfaces.

There is no built-in authentication or per-user access separation. The same API
serves portfolio editing, settings, and administrative operations. The current
configuration suits a trusted single-user environment; a public repository does
not imply a public, unauthenticated hosted service.

For a host-local instance, change the Compose port mapping to:

```yaml
ports:
  - "127.0.0.1:9000:9000"
```

Remote access and a non-development server require deployment configuration
appropriate to the host. Any replacement entry point must account for both
`create_app()` and `startup()`: importing the Flask factory alone does not run
database initialization, initial fetches, or the scheduler. Background jobs and
live-price subscriptions are process-local, so multiple application workers are
not a drop-in scaling configuration.

## Starting, updating, and stopping

```bash
docker compose up -d --build
docker compose logs -f investingview
```

On a first start, initialization may spend several minutes fetching market data
and earnings dates before the serving process is ready. A health check can fail
temporarily during that period. If provider requests fail, the application can
start with empty research data and populate it on a later refresh.

For an update, back up the database, update the checked-out source, then rebuild:

```bash
docker compose up -d --build investingview
docker compose ps
curl http://localhost:9000/api/health
```

Stop with:

```bash
docker compose down
```

Stopping/removing the container does not delete the bind-mounted data directory.
Startup migrations may change the database, so use a matching database backup
when rolling back to an older source version.

## Backups and restore

SQLite runs in WAL mode. To back up a running instance, use SQLite's backup API
rather than copying only the main `.db` file while writes may be active.

The following creates a consistent backup inside the existing `./data` bind
mount. It reads the configured database and writes a new timestamped file:

```bash
docker compose exec -T investingview python - <<'PY'
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

source = Path(os.environ["DATABASE_PATH"]).resolve()
stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
destination = source.parent / f"investingview-backup-{stamp}.db"
with sqlite3.connect(source.as_uri() + "?mode=ro", uri=True) as src:
    with sqlite3.connect(destination) as dst:
        src.backup(dst)
print(f"Backup created: {destination}")
PY
```

Copy the resulting backup to your preferred private backup location.

To restore:

1. Stop the service with `docker compose down`.
2. Preserve the current `data` directory separately, including any `-wal` and
   `-shm` files, so there is a recovery copy.
3. Restore the chosen consistent backup as `data/investingview.db` in a clean
   data directory. Do not pair it with WAL/SHM files from a different database.
4. Start with `docker compose up -d` and verify portfolios, settings, and health.

## Scheduled work

Jobs run inside the application process while it is running. The schedule below
reflects registered jobs, not UI labels or historical behavior. Times are local
Eastern Time (`America/New_York`), with the ETF check explicitly using
`America/Toronto`, which follows the same current seasonal clock changes.

| When | Work |
| --- | --- |
| Weekdays, 08:30 | Refresh earnings dates; separately send the earnings-today Discord message. |
| Weekdays, 09:10 | Run the 200 SMA proximity check and notify Discord when candidates exist. |
| Weekdays, 09:15 | Check ETF issuers for newly published holdings snapshots. |
| Weekdays, 10:45 | Store opening-range breakout classifications. |
| Weekdays, 11:35 | Store ORB continuation/reversal checkpoint decisions. |
| Weekdays, 16:00 | Snapshot prior scanner ranks. |
| Weekdays, 16:05 | Refresh dashboard price data. |
| Weekdays, 16:15 | Run Momentum and Reversal scans on completed-session data. |
| Weekdays, 16:20 | Compute provisional 3-month/6-month volume-profile levels from stored candles. |
| Weekdays, 16:30 | Record portfolio and position P/L snapshots. |
| Weekdays, 17:00 | Build and save the movers news digest. |
| Weekdays, 18:00 | Check drawn support/resistance patterns and price thresholds. |
| Weekdays, 18:05 | Check holding-average price crosses/touches. |
| Weekdays, 18:10 | Evaluate portfolio trailing stops. |
| Weekdays, 19:30 | Run the YTD scan. |
| Fridays, 19:30 | Repair candle history used by Trend Quality. |
| Fridays, 19:35 | Run Trend Quality v2. |
| Weekdays, 19:40 | Recompute final volume-profile levels from settled/repaired data. |
| Mondays, 19:00 | Refresh earnings dates and quarterly results. |

The scheduler also bootstraps ETFs that have no saved holdings snapshots. Most
cron triggers are weekday-based rather than a full exchange-holiday calendar.
Individual services apply their own completed-session and data-validity checks.
Do not assume every missed cron job is replayed after downtime; P/L history, in
particular, is based on snapshots actually recorded.

## An isolated preview

`docker-compose.preview.yml` mounts `./data` from the directory in which that
Compose file lives. A different container name or port does **not** isolate the
database if that mount points at a working instance's data.

To inspect the UI without using an existing instance's data, build a separate
image and run it with disposable in-memory storage:

```bash
docker build -t investingview-preview-local .

docker run --rm -d \
  --name investingview-preview-local \
  --publish 127.0.0.1:9001:9000 \
  --tmpfs /data \
  --tmpfs /app/logs \
  --env DATABASE_PATH=/data/investingview-preview.db \
  investingview-preview-local \
  python -c "from app import create_app; from models.db import init_db; from services.universe import seed_default_universe; init_db(); seed_default_universe(); create_app().run(host='0.0.0.0', port=9000, debug=False, threaded=True)"
```

Open <http://localhost:9001>. This starts with an empty disposable database, seeds
the universe, and skips normal initial fetches and background jobs. Interacting
with data-dependent controls can still make on-demand provider requests. No host
data/log directories are mounted, and settings/edits belong only to this preview.

Remove it when finished:

```bash
docker stop investingview-preview-local
docker image rm investingview-preview-local
```

Because `--rm` is set, stopping removes the container. Its tmpfs data is discarded.
The published README screenshots were created with a similar isolated runtime
and synthetic fixtures; those fixtures are not part of normal application startup.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Port 9000 is occupied | Choose a free host port in Compose, for example `9002:9000`; the container still listens on 9000. |
| Container is initially unhealthy | Check logs for initialization and provider fetches. The basic health endpoint is available once the serving process is ready. |
| Earnings or scanner views are empty | Check `/api/status`, data timestamps, the weekday schedule, required history, and provider availability. Not every board is populated at first startup. |
| Weekend refresh leaves prices empty | The dashboard fetch skips weekends. A fresh weekend install can have no stored dashboard history until a weekday refresh. |
| A quote, chart, or exchange rate is unavailable | Check outbound access to Yahoo Finance and provider errors/rate limits. Different endpoints have different caches and fallbacks. |
| TradingView widgets or the chart library fail to load | Allow the relevant TradingView domains and `unpkg.com`; browser content blockers can affect embeds. |
| Notifications are missing | Save and test credentials in Settings, check the relevant job time and logs, and verify the specific notification type has a registered delivery job. |
| Settings URL returns 404 | Use the app's gear icon. Navigation loads screen templates without standalone `/settings` routes. |
| UI appears stale after an update | Reload the page. If needed, clear this origin's service-worker/site cache and reopen the app. |
| Data disappears after changing launch commands | Verify `DATABASE_PATH`, the working directory for local runs, and the container's data mount. |

`GET /api/health` is an HTTP liveness response. It does not check database
integrity, provider connectivity, data freshness, or successful job completion.
