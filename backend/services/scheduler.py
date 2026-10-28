"""
scheduler.py — Background scheduler for daily tasks.

Runs daily tasks:
  - 8:30 AM ET: Earnings-today Discord alert (weekdays)
  - 8:30 AM ET: Earnings date refresh before market open (weekdays)
  - 9:10 AM ET: 200 SMA proximity check (weekdays)
  - 9:15 AM ET: Check issuer ETF holdings for new published snapshots (weekdays)
   - 4:15 PM ET: Run momentum and reversal scanners (weekdays)
   - 4:00 PM ET: Snapshot previous scanner trends (weekdays)
  - 4:05 PM ET: Refresh dashboard data via yfinance + snapshot scanner trends
  - 4:30 PM ET: Record daily P/L snapshots for all portfolios (weekdays)
  - 5:00 PM ET: News movers digest — movers + headlines, 12h window (weekdays)
  - 6 PM ET: Check S/R alerts, price threshold alerts
  - 6:05 PM ET: Check avg price crosses
  - 6:10 PM ET: Check portfolio trailing stops
  - Mondays 7 PM ET: Weekly earnings data refresh

Usage:
    from services.scheduler import start_scheduler, stop_scheduler

    # In app startup:
    start_scheduler()

    # In app shutdown:
    stop_scheduler()
"""

import logging
import time
from datetime import datetime

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger

logger = logging.getLogger(__name__)

scheduler = BackgroundScheduler(timezone="America/New_York")


def refresh_dashboard_data():
    """Daily dashboard data refresh at 4:05 PM ET.

    Calls yf_fetcher.fetch_all() to populate the dash_* tables
    that the earnings screen reads from. Retries up to 3 times
    with exponential backoff (30s, 60s) on failure.
    """
    max_attempts = 3
    backoff_seconds = [30, 60]

    for attempt in range(1, max_attempts + 1):
        try:
            from services.yf_fetcher import fetch_all

            logger.info(
                "Starting dashboard data refresh (attempt %d/%d)...",
                attempt, max_attempts,
            )
            result = fetch_all()
            logger.info(
                "Dashboard data refresh complete: status=%s, succeeded=%d, failed=%d",
                result.get("status"),
                result.get("success_count", 0),
                result.get("fail_count", 0),
            )
            return  # success — exit retry loop
        except Exception as e:
            if attempt < max_attempts:
                delay = backoff_seconds[attempt - 1]
                logger.warning(
                    "Dashboard data refresh failed (attempt %d/%d): %s — retrying in %ds",
                    attempt, max_attempts, e, delay,
                )
                time.sleep(delay)
            else:
                logger.error(
                    "Dashboard data refresh failed after %d attempts: %s",
                    max_attempts, e,
                )


def refresh_etf_holdings_job(etfs=None):
    """Check each issuer independently; one failing feed cannot block the others."""
    from services.etf_holdings import ETFS, refresh_holdings
    for etf in (etfs if etfs is not None else ETFS):
        try:
            logger.info("ETF holdings refresh: %s", refresh_holdings(etf))
        except Exception:
            logger.exception("ETF holdings refresh failed: %s", etf)


def refresh_earnings_dates_job():
    """Weekly earnings data refresh — Mondays at 7 PM ET.

    Fetches fresh next-earnings dates and quarterly earnings history from
    yfinance for all tickers in a single pass. Retries up to 3 times with
    exponential backoff.
    """
    max_attempts = 3
    backoff_seconds = [30, 60]

    for attempt in range(1, max_attempts + 1):
        try:
            from services.yf_fetcher import refresh_earnings_data

            logger.info("Starting earnings data refresh (attempt %d/%d)...", attempt, max_attempts)
            result = refresh_earnings_data()
            logger.info(
                "Earnings data refresh complete: dates %d/%d, quarterly %d/%d",
                result.get("earnings_date_success", 0),
                result.get("earnings_date_fail", 0),
                result.get("quarterly_success", 0),
                result.get("quarterly_fail", 0),
            )
            return
        except Exception as e:
            if attempt < max_attempts:
                delay = backoff_seconds[attempt - 1]
                logger.warning(
                    "Earnings data refresh failed (attempt %d/%d): %s — retrying in %ds",
                    attempt, max_attempts, e, delay,
                )
                time.sleep(delay)
            else:
                logger.error(
                    "Earnings data refresh failed after %d attempts: %s",
                    max_attempts, e,
                )



def snapshot_scanner_trends():
    """Snapshot scanner rankings at 4 PM ET for next day's trend comparison.

    Captures current rank positions as previous_rank for both momentum and
    reversal scan types, enabling trend calculation (up/down/flat/new) for
    the next day's scans.
    """
    try:
        from services.rankings import update_trend_snapshots

        logger.info("Snapshotting scanner trends...")
        update_trend_snapshots("momentum")
        update_trend_snapshots("reversal")
        update_trend_snapshots("ytd")
        # Quality Score owns versioned weekly snapshots in its own service.
        logger.info("Scanner trends snapshot complete")
    except Exception as e:
        logger.error("Scanner trends snapshot failed: %s", e)


def _completed_scan_with_retry(scan, label):
    """Wait for Yahoo's valid close bars; never publish yesterday as today's scan."""
    from datetime import datetime as _dt
    from zoneinfo import ZoneInfo

    session_date = _dt.now(ZoneInfo("America/New_York")).date()
    for attempt in range(3):
        try:
            return scan(force=True, session_date=session_date)
        except RuntimeError as exc:
            if attempt == 2:
                raise
            logger.warning("%s close bars not ready (%s); retrying in 5 minutes", label, exc)
            time.sleep(300)


def run_scheduled_momentum_scan():
    """Run momentum scanner at scheduled times.

    Fetches fresh data (force=True) and runs the full momentum scan pipeline:
    universe, stock data, indices, sectors, earnings filter, scoring.
    Updates rankings leaderboard and persists scan completion timestamp.
    """
    try:
        from datetime import datetime as _dt
        import pytz as _pytz
        from services.scanner import run_momentum_scan
        from services.rankings import (
            update_rankings, update_trend_snapshots,
            set_last_scan_completed_at,
        )
        from services.signals import record_alerts

        logger.info("Running scheduled momentum scan...")
        result = _completed_scan_with_retry(run_momentum_scan, "Momentum")

        est = _pytz.timezone("America/New_York")
        completed_at = _dt.now(est).isoformat()

        update_trend_snapshots("momentum", result["session_date"])
        attempted = set(result.get("attempted_tickers", []))
        update_rankings(result["results"], "momentum", attempted_tickers=attempted,
                        below_threshold=result.get("below_threshold"),
                        session_date=result["session_date"])

        # Record signals for tracking (D+1/D+5/D+10/D+20 follow-through)
        alerts = [
            {
                "ticker": r["ticker"],
                "conviction": r.get("conviction", ""),
                "score": r.get("score"),
                "price": r.get("price"),
            }
            for r in result["results"]
        ]
        if alerts:
            record_alerts("momentum", alerts, session_date=result["session_date"])

        set_last_scan_completed_at("momentum", completed_at)

        logger.info(
            "Momentum scan complete: %d results", result.get("total", 0)
        )
    except Exception as e:
        logger.error("Scheduled momentum scan failed: %s", e)


def run_scheduled_reversal_scan():
    """Run reversal scanner at scheduled times.

    Fetches fresh data (force=True) and runs the full reversal scan pipeline:
    universe, 90-day OHLCV, 5-criterion scoring.
    Updates rankings leaderboard and persists scan completion timestamp.
    """
    try:
        from datetime import datetime as _dt
        import pytz as _pytz
        from services.reversal_scanner import run_reversal_scan
        from services.rankings import (
            update_rankings, update_trend_snapshots,
            set_last_scan_completed_at,
        )
        from services.signals import record_alerts

        logger.info("Running scheduled reversal scan...")
        result = _completed_scan_with_retry(run_reversal_scan, "Reversal")

        est = _pytz.timezone("America/New_York")
        completed_at = _dt.now(est).isoformat()

        update_trend_snapshots("reversal", result["session_date"])
        attempted = set(result.get("attempted_tickers", []))
        update_rankings(result["results"], "reversal", attempted_tickers=attempted,
                        below_threshold=result.get("below_threshold"),
                        session_date=result["session_date"])

        # Record signals for tracking (D+1/D+5/D+10/D+20 follow-through)
        alerts = [
            {
                "ticker": r["ticker"],
                "conviction": r.get("conviction", ""),
                "score": r.get("score"),
                "price": r.get("price"),
            }
            for r in result["results"]
        ]
        if alerts:
            record_alerts("reversal", alerts, session_date=result["session_date"])

        set_last_scan_completed_at("reversal", completed_at)

        logger.info(
            "Reversal scan complete: %d results", result.get("total", 0)
        )
    except Exception as e:
        logger.error("Scheduled reversal scan failed: %s", e)


def check_sr_alerts():
    """Daily S/R alert check at 6 PM ET.

    For each ticker that has user-drawn S/R levels:
      1. Fetch 3 months of OHLCV data
      2. Query sr_levels table (user-drawn lines, not calculated)
      3. Detect touch patterns on the last 2 candles
      4. Build Discord rich embeds (color-coded per pattern)
      5. Send Discord embed + email text alert
      6. Log to alert_history table (respects cooldown)
    """
    try:
        from services.sr_levels import (
            detect_sr_touch,
            check_cooldown_history,
            log_to_alert_history,
        )
        from services.notifications import (
            send_discord_embed,
            send_sr_email_alert,
            _build_sr_embed,
            _is_email_enabled,
        )
        from data.fetcher import get_ohlcv
        from models.db import get_connection

        logger.info("Starting daily S/R alert check (user-drawn lines)...")

        # Step 1: Get all distinct tickers that have user-drawn S/R levels
        with get_connection() as conn:
            tickers_rows = conn.execute(
                "SELECT DISTINCT ticker FROM sr_levels"
            ).fetchall()
            tickers = [row["ticker"] for row in tickers_rows]

        if not tickers:
            logger.info("No user-drawn S/R levels found. Skipping alert check.")
            return

        alerts_fired = 0

        for ticker in tickers:
            try:
                # Step 2: Fetch candle data
                candles = get_ohlcv(ticker, period="3mo")
                if len(candles) < 10:
                    continue

                # Step 3: Get user-drawn S/R levels for this ticker
                with get_connection() as conn:
                    levels_rows = conn.execute(
                        "SELECT id, price, type FROM sr_levels WHERE ticker = ?",
                        (ticker,),
                    ).fetchall()
                    sr_levels = [dict(row) for row in levels_rows]

                    if not sr_levels:
                        continue

                    # Add ticker to each level (detect_sr_touch expects it)
                    for level in sr_levels:
                        level["ticker"] = ticker

                    # Step 4: Check for touches on recent candles
                    recent_candles = candles[-2:]  # Last 2 days
                    touches = detect_sr_touch(recent_candles, sr_levels)

                    # Step 5: Process touches
                    for touch in touches:
                        pattern = touch.get("pattern")
                        sr_price = touch.get("sr_price")
                        sr_type = touch.get("sr_type")

                        # Check cooldown using alert_history table
                        if check_cooldown_history(conn, ticker, sr_type, sr_price):
                            logger.debug(
                                "S/R alert in cooldown: %s %s $%.2f",
                                ticker, sr_type, sr_price,
                            )
                            continue

                        # Step 6: Log BEFORE sending — if this
                        # INSERT OR IGNORE gets blocked by the unique
                        # index we never send Discord or email.
                        if not log_to_alert_history(
                            conn, ticker, sr_type, sr_price, pattern, ""
                        ):
                            logger.debug(
                                "S/R alert already logged today: %s %s $%.2f",
                                ticker, sr_type, sr_price,
                            )
                            continue

                        # Get the candle data for the embed
                        candle_data = recent_candles[-1] if recent_candles else {}

                        # Step 7: Build and send Discord embed
                        embed = _build_sr_embed(
                            ticker, sr_type, sr_price, pattern, candle_data
                        )
                        discord_ok, discord_err = send_discord_embed(embed)
                        if discord_err:
                            logger.warning(
                                "Discord embed failed for %s: %s",
                                ticker, discord_err,
                            )

                        # Step 8: Send email alert (plain text version)
                        if _is_email_enabled("price"):
                            email_ok, email_err = send_sr_email_alert(
                                ticker, sr_type, sr_price, pattern, candle_data
                            )
                            if email_err:
                                logger.warning(
                                    "Email alert failed for %s: %s",
                                    ticker, email_err,
                                )

                        alerts_fired += 1
                        logger.info(
                            "S/R alert fired: %s — %s $%.2f Pattern %s",
                            ticker, sr_type, sr_price, pattern,
                        )

            except Exception as e:
                logger.warning("Error checking S/R for %s: %s", ticker, e)

        logger.info("S/R alert check complete: %d alerts fired", alerts_fired)

    except Exception as e:
        logger.error("S/R alert check failed: %s", e)


def check_trailing_stops():
    """Daily-close stops: commit each HIT once, then use existing senders."""
    from models.db import get_connection
    from services.trailing_stops import fetch_candles, evaluate_ticker, now_et
    from services.notifications import (
        send_discord_embed, _build_trailing_stop_embed, send_email, _is_email_enabled,
    )

    now = now_et()
    with get_connection() as conn:
        tickers = conn.execute(
            "SELECT ticker, MIN(COALESCE(last_processed_date, reference_date)) AS checkpoint "
            "FROM trailing_stops WHERE state = 'active' GROUP BY ticker"
        ).fetchall()
    for row in tickers:
        try:
            candles = fetch_candles(row["ticker"], now, since=row["checkpoint"])
            events = evaluate_ticker(row["ticker"], candles, now)
        except Exception:
            logger.exception("Trailing stop check deferred for %s", row["ticker"])
            continue
        for event in events:
            channels = []
            try:
                ok, error = send_discord_embed(_build_trailing_stop_embed(event))
                if ok:
                    channels.append("discord")
                if error:
                    logger.warning("Trailing stop Discord failed for %s: %s", event["event_key"], error)
                if _is_email_enabled("price"):
                    ok, error = send_email(
                        f"InvestingView Trailing Stop HIT: {event['ticker']}", event["message"],
                    )
                    if ok:
                        channels.append("email")
                    if error:
                        logger.warning("Trailing stop email failed for %s: %s", event["event_key"], error)
            except Exception:
                logger.exception("Trailing stop delivery failed for %s", event["event_key"])
            with get_connection() as conn:
                conn.execute(
                    "UPDATE alert_history SET channel = ? WHERE event_key = ?",
                    ("+".join(channels) or "none", event["event_key"]),
                )
            logger.info("Trailing stop HIT: %s [%s]", event["event_key"], "+".join(channels) or "none")


def check_price_alerts():
    """Daily price threshold alert check at 6 PM ET.

    Queries armed price_above/price_below alerts from the alerts table,
    fetches live quotes, evaluates thresholds, sends Discord embed + email,
    logs to alert_history with cooldown gating.
    """
    try:
        from services.alert_evaluators import (
            evaluate_price_alerts,
            check_price_alert_cooldown,
            log_price_alert_to_history,
        )
        from services.notifications import (
            send_discord_embed,
            send_price_email_alert,
            _build_price_alert_embed,
            _is_email_enabled,
        )
        from models.db import get_connection

        logger.info("Starting daily price alert check...")

        with get_connection() as conn:
            fired_alerts = evaluate_price_alerts(conn)

            alerts_sent = 0
            for fa in fired_alerts:
                alert_id = fa["alert_id"]
                ticker = fa["ticker"]

                if check_price_alert_cooldown(conn, alert_id):
                    logger.debug(
                        "Price alert in cooldown: %s alert_id=%d",
                        ticker, alert_id,
                    )
                    continue

                embed = _build_price_alert_embed(
                    ticker, fa["type"], fa["threshold"],
                    fa["current_price"], fa["change_pct"],
                )
                discord_ok, discord_err = send_discord_embed(embed)
                if discord_err:
                    logger.warning(
                        "Discord embed failed for %s: %s",
                        ticker, discord_err,
                    )

                if _is_email_enabled("price"):
                    email_ok, email_err = send_price_email_alert(
                        ticker, fa["type"], fa["threshold"], fa["current_price"],
                    )
                    if email_err:
                        logger.warning(
                            "Email alert failed for %s: %s",
                            ticker, email_err,
                        )
                else:
                    email_ok = False

                channels = []
                if discord_ok:
                    channels.append("discord")
                if email_ok:
                    channels.append("email")
                channel_str = "+".join(channels) if channels else "none"

                log_price_alert_to_history(
                    conn, alert_id, ticker, fa["type"],
                    fa["threshold"], fa["current_price"], channel_str,
                )

                alerts_sent += 1
                logger.info(
                    "Price alert fired: %s %s threshold=$%.2f current=$%.2f [%s]",
                    ticker, fa["type"], fa["threshold"],
                    fa["current_price"], channel_str,
                )

        logger.info("Price alert check complete: %d alerts sent", alerts_sent)

    except Exception as e:
        logger.error("Price alert check failed: %s", e)


def check_avg_price_crosses_scheduled():
    """Daily avg price cross/touch check at 6:05 PM ET.

    Reuses evaluate_avg_price_crosses() and adds Discord + email
    notifications (the on-demand endpoint only logs to DB).

    Dedup: Only ONE alert fires per position per day.
    cross_above + touch_bullish both map to "avg_price_bullish"
    cross_below + touch_bearish both map to "avg_price_bearish"
    """
    try:
        from services.alert_evaluators import evaluate_avg_price_crosses
        from services.notifications import (
            send_discord_embed,
            send_avg_price_email_alert,
            _build_avg_price_embed,
            _is_email_enabled,
        )
        from models.db import get_connection

        logger.info("Starting daily avg price cross check...")

        with get_connection() as conn:
            fired = evaluate_avg_price_crosses(conn)

            alerts_sent = 0
            for event in fired:
                ticker = event["ticker"]
                pattern = event["pattern"]
                direction = event["direction"]
                avg_price = event["avgPrice"]
                qty = event["qty"]
                portfolio_name = event.get("portfolio_name")

                # Dedup by position: skip if already logged for this
                # ticker+direction+avg_price today
                direction_type = f"avg_price_{direction}"
                existing = conn.execute(
                    "SELECT COUNT(*) FROM alert_history "
                    "WHERE ticker = ? AND type = ? AND avg_price = ? "
                    "AND date(fired_at) = date('now')",
                    (ticker, direction_type, avg_price),
                ).fetchone()
                if existing[0] > 0:
                    continue

                candle = {
                    "open": event["open"],
                    "high": event["high"],
                    "low": event["low"],
                    "close": event["close"],
                }

                embed = _build_avg_price_embed(
                    ticker, avg_price, pattern, candle,
                    qty=qty, portfolio_name=portfolio_name,
                )
                discord_ok, discord_err = send_discord_embed(embed)
                if discord_err:
                    logger.warning(
                        "Discord embed failed for %s: %s",
                        ticker, discord_err,
                    )

                if _is_email_enabled("price"):
                    email_ok, email_err = send_avg_price_email_alert(
                        ticker, avg_price, pattern, candle,
                    )
                    if email_err:
                        logger.warning(
                            "Email alert failed for %s: %s",
                            ticker, email_err,
                        )
                else:
                    email_ok = False

                channels = []
                if discord_ok:
                    channels.append("discord")
                if email_ok:
                    channels.append("email")
                channel_str = "+".join(channels) if channels else "none"

                # Preserve specific pattern in message for context
                pattern_label = pattern.replace("_", " ").title()
                message = (
                    f"{pattern_label}: Price {event['type']}d average at "
                    f"${avg_price:.2f}. "
                    f"Close: ${event['close']:.2f}"
                )
                conn.execute(
                    "INSERT OR IGNORE INTO alert_history "
                    "(alert_id, ticker, type, message, channel, avg_price) "
                    "VALUES (NULL, ?, ?, ?, ?, ?)",
                    (ticker, direction_type, message, channel_str, avg_price),
                )

                alerts_sent += 1
                logger.info(
                    "Avg price alert fired: %s %s (dir=%s) avg=$%.2f [%s]",
                    ticker, pattern, direction, avg_price, channel_str,
                )

        logger.info("Avg price cross check complete: %d alerts sent", alerts_sent)

    except Exception as e:
        logger.error("Avg price cross check failed: %s", e)


def check_earnings_today():
    """Daily earnings-today check and Discord alert."""
    try:
        from services.notifications import send_discord_embed, _build_earnings_today_embed, _get_earnings_today

        logger.info("Starting earnings-today check...")
        tickers = _get_earnings_today()

        embed = _build_earnings_today_embed(tickers)
        success, error = send_discord_embed(embed)
        if success:
            logger.info("Earnings-today alert sent to Discord (%d tickers)", len(tickers))
        else:
            logger.warning("Earnings-today Discord send failed: %s", error)
    except Exception as e:
        logger.error("Earnings-today check failed: %s", e)


def check_sma200_proximity():
    """Daily 200 SMA proximity check and Discord alert."""
    try:
        from services.sma200_scanner import run_sma200_scan
        from services.notifications import send_discord_embed, _build_sma200_embed
        from config import SMA200_PROXIMITY_PCT

        logger.info("Starting 200 SMA proximity check...")
        result = run_sma200_scan(force=True)

        tickers = result.get("results", [])
        if tickers:
            embed = _build_sma200_embed(tickers, SMA200_PROXIMITY_PCT)
            success, error = send_discord_embed(embed)
            if success:
                logger.info("200 SMA proximity alert sent to Discord (%d tickers)", len(tickers))
            else:
                logger.warning("200 SMA Discord send failed: %s", error)
        else:
            logger.info("No stocks within 200 SMA threshold")
    except Exception as e:
        logger.error("200 SMA proximity check failed: %s", e)


def run_scheduled_ytd_scan():
    """Run YTD return scanner at scheduled time.

    Fetches fresh data (force=True) and runs the full YTD scan pipeline:
    universe, candle data, YTD return calculation, rankings update.
    """
    try:
        from services.ytd_scanner import run_ytd_scan, record_ytd_snapshots
        from services.rankings import needs_trend_snapshot, update_trend_snapshots

        logger.info("Running scheduled YTD return scan...")
        result = run_ytd_scan(force=True)

        # Record daily snapshot history
        record_ytd_snapshots(result.get("results", []))

        # Snapshot trend after scan (first scan of day check is inside run_ytd_scan)
        if needs_trend_snapshot("ytd"):
            update_trend_snapshots("ytd")

        logger.info(
            "YTD return scan complete: %d results", result.get("total", 0)
        )
    except Exception as e:
        logger.error("Scheduled YTD return scan failed: %s", e)


def run_candle_repair_job():
    """Weekly candle repair (Fridays): backfill gaps, re-check recent bars.

    Contained to the Quality Score feature's input table (candles). Runs
    before the Trend Quality scan so settlement revisions and single-day
    fetch holes are repaired before scoring.
    """
    try:
        from services.quality_score_scanner import repair_candle_data

        logger.info("Starting weekly candle data repair...")
        report = repair_candle_data()
        logger.info(
            "Candle repair complete: %d tickers repaired, %d with unrepaired gaps",
            len(report.get("repaired", {})), len(report.get("unrepaired", {})),
        )
        for ticker, gaps in (report.get("unrepaired") or {}).items():
            logger.warning("Candle repair unrepaired %s: %s", ticker, gaps)
    except Exception as e:
        logger.error("Candle repair failed: %s", e)


def run_scheduled_quality_score_scan():
    """Weekly candle-based Trend Quality scan using completed stored history."""
    try:
        from services.quality_score_scanner import run_quality_score_scan

        logger.info("Running scheduled Quality Score scan...")
        result = run_quality_score_scan(force=True)

        logger.info(
            "Quality Score scan complete: %d results", result.get("total", 0)
        )
    except Exception as e:
        logger.error("Scheduled Quality Score scan failed: %s", e)


def run_pnl_snapshot():
    """Daily P/L snapshot at 4:30 PM ET (weekdays only).

    Calls record_all_portfolios_snapshots() to compute and persist
    end-of-day P/L snapshots for all portfolios.
    """
    try:
        from services.pnl_snapshot import record_all_portfolios_snapshots

        logger.info("Starting P/L snapshot recording...")
        result = record_all_portfolios_snapshots()
        logger.info(
            "P/L snapshot complete: total=%d success=%d failed=%d",
            result.get("total", 0),
            result.get("success", 0),
            result.get("failed", 0),
        )
    except Exception as e:
        logger.error("P/L snapshot failed: %s", e, exc_info=True)


def run_volume_profile_job(label="provisional"):
    """Daily volume-profile levels (weekdays only).

    DB-only: reads ``candles`` (fresh after the 4:05 dashboard job),
    computes 3m + 6m POC/VAH/VAL per ticker, upserts ``volume_profile``.
    Zero yfinance calls. Runs twice daily: a 4:20 PM provisional pass and
    a 7:40 PM final pass on settled (+ Friday repaired) data.
    """
    try:
        from services.volume_profile import run_volume_profile_scan

        logger.info("Starting volume profile EOD computation (%s)...", label)
        result = run_volume_profile_scan()
        logger.info(
            "Volume profile (%s) complete: updated=%d skipped=%d session=%s",
            label,
            result.get("updated", 0),
            result.get("skipped", 0),
            result.get("session_date"),
        )
    except Exception as e:
        logger.error("Volume profile job (%s) failed: %s", label, e, exc_info=True)


def run_orb_scan_job():
    """Daily ORB breakout scan at 10:45 AM ET (weekdays only).

    Batch-fetches 15m bars for the merged universe, classifies the
    09:30-09:45 range vs the 10:15-10:30 close, and upserts one row
    per ticker into ``orb_breakout``. Runs once per session; at 10:45
    the confirmation bar is past yfinance's intraday lag.
    """
    try:
        from services.orb_scanner import run_orb_scan

        logger.info("Starting ORB breakout scan...")
        result = run_orb_scan()
        logger.info(
            "ORB breakout scan complete: session=%s long=%d short=%d none=%d insufficient=%d",
            result.get("session_date"),
            result.get("long", 0),
            result.get("short", 0),
            result.get("none", 0),
            result.get("insufficient", 0),
        )
    except Exception as e:
        logger.error("ORB breakout scan failed: %s", e, exc_info=True)


def run_orb_decisions_job():
    """Daily ORB checkpoint reassessment at 11:35 AM ET (weekdays only).

    Single fetch covering 09:30-11:15 bars; evaluates the 10:30 / 11:00 /
    11:15 continuation/reversal checkpoints and upserts into
    ``orb_decisions``. The Trade tab merges these with the 10:45 strict
    baseline (baseline + change flag). Also logs the latest bar time
    as a yfinance-lag check.
    """
    try:
        from services.orb_scanner import run_orb_decisions

        logger.info("Starting ORB checkpoint reassessment...")
        result = run_orb_decisions()
        logger.info(
            "ORB checkpoint reassessment complete: session=%s tickers=%d",
            result.get("session_date"),
            result.get("decided", 0),
        )
    except Exception as e:
        logger.error("ORB checkpoint reassessment failed: %s", e, exc_info=True)


def refresh_news_movers_digest():
    """Daily news movers digest at 5:00 PM ET (weekdays only).

    Runs after the 4:05 PM dashboard refresh and 4:30 PM P/L snapshot so
    quotes.change_pct is fresh, then computes movers, fetches Google News
    RSS per mover (12h window), and saves the digest. Idempotent per
    run_date — safe to re-run manually via POST /api/news/movers/refresh.
    """
    try:
        from zoneinfo import ZoneInfo

        from services import news_movers as svc

        run_date = datetime.now(ZoneInfo("America/New_York")).date().isoformat()
        logger.info("Starting news movers digest (run_date=%s)...", run_date)
        movers = svc.get_movers(mover_pct=svc.DEFAULT_MOVER_PCT)
        items = svc.fetch_digest(movers, window=svc.DEFAULT_WINDOW)
        svc.save_digest(run_date, movers, items, window=svc.DEFAULT_WINDOW)
        svc.purge_old_digest()
        total = sum(len(items.get(m["ticker"], [])) for m in movers)
        logger.info(
            "News movers digest complete: run_date=%s movers=%d stories=%d",
            run_date, len(movers), total,
        )
    except Exception as e:
        logger.error("News movers digest failed: %s", e, exc_info=True)


def refresh_earnings_morning():
    """Morning earnings data refresh at 8:30 AM ET (weekdays).

    Fetches fresh next-earnings dates from yfinance for all universe
    tickers before market open so the Earnings scanner tab has current
    data for the trading day.  Retries up to 3 times with exponential
    backoff on failure.

    This is separate from the 8:30 AM earnings-today Discord alert job
    (check_earnings_today) — that job sends notifications, while this
    one refreshes the underlying data.
    """
    max_attempts = 3
    backoff_seconds = [30, 60]

    for attempt in range(1, max_attempts + 1):
        try:
            from services.yf_fetcher import refresh_earnings_dates

            logger.info(
                "Starting morning earnings date refresh (attempt %d/%d)...",
                attempt, max_attempts,
            )
            result = refresh_earnings_dates()
            logger.info(
                "Morning earnings date refresh complete: %d succeeded, %d failed",
                result.get("success_count", 0),
                result.get("fail_count", 0),
            )
            return
        except Exception as e:
            if attempt < max_attempts:
                delay = backoff_seconds[attempt - 1]
                logger.warning(
                    "Morning earnings date refresh failed (attempt %d/%d): %s — retrying in %ds",
                    attempt, max_attempts, e, delay,
                )
                time.sleep(delay)
            else:
                logger.error(
                    "Morning earnings date refresh failed after %d attempts: %s",
                    max_attempts, e,
                )


def start_scheduler():
    """Start the background scheduler.

    Registers cron jobs:
      - Weekdays (Mon-Fri):
        - 8:30 AM ET: Earnings-today Discord alert
         - 8:30 AM ET: Earnings date refresh (pre-market data for scanner)
         - 9:10 AM ET: 200 SMA proximity check
         - 9:15 AM ET: ETF holdings publication check
        - 10:45 AM ET: ORB breakout scan (Trade tab)
        - 11:35 AM ET: ORB checkpoint reassessment (Trade tab)
         - 4:15 PM ET: Momentum + reversal scanner
       - 4 PM ET: Previous-day scanner trend snapshot
      - 4:05 PM ET: Dashboard data refresh (yfinance fetch_all)
      - 4:20 PM ET: Volume profile provisional (DB-only)
      - 4:30 PM ET: P/L snapshot for all portfolios
      - 5 PM ET: News movers digest
      - 6 PM ET: S/R alert check, price threshold alerts
        - 6:05 PM ET: Avg price cross check
        - 6:10 PM ET: Portfolio trailing stops
        - 7:30 PM ET: YTD return scan
        - 7:40 PM ET: Volume profile final on settled data (DB-only)
      - Fridays only:
        - 7:35 PM ET: Trend Quality scan
      - Mondays only:
        - 7:00 PM ET: Earnings data refresh (dates + quarterly in one pass)

    Call this during application startup.
    """
    # One completed-session momentum and reversal scan at 4:15 PM ET.
    scheduler.add_job(
        run_scheduled_momentum_scan,
        CronTrigger(hour=16, minute=15, day_of_week="mon-fri"),
        id="momentum_scan_close",
        name="Momentum scan (4:15 PM ET)",
    )
    scheduler.add_job(
        run_scheduled_reversal_scan,
        CronTrigger(hour=16, minute=15, day_of_week="mon-fri"),
        id="reversal_scan_close",
        name="Reversal scan (4:15 PM ET)",
    )

    # Snapshot yesterday's positions before today's close scan updates ranks.
    scheduler.add_job(
        snapshot_scanner_trends,
        CronTrigger(hour=16, minute=0, day_of_week="mon-fri"),
        id="scanner_trend_snapshot",
        name="Daily scanner trend snapshot",
    )

    # Dashboard data refresh at 4:05 PM ET (5 min after scanners to avoid yfinance rate limiting)
    scheduler.add_job(
        refresh_dashboard_data,
        CronTrigger(hour=16, minute=5, day_of_week="mon-fri"),
        id="dashboard_data_refresh",
        name="Daily dashboard data refresh",
    )

    # Earnings data refresh — Mondays at 7 PM ET (dates + quarterly in one pass)
    scheduler.add_job(
        refresh_earnings_dates_job,
        CronTrigger(hour=19, minute=0, day_of_week="mon"),
        id="earnings_data_refresh",
        name="Weekly earnings data refresh",
    )

    # S/R alert check at 6 PM ET
    scheduler.add_job(
        check_sr_alerts,
        CronTrigger(hour=18, minute=0, day_of_week="mon-fri"),
        id="sr_alert_check",
        name="Daily S/R alert check",
    )

    # Price threshold alerts at 6 PM ET
    scheduler.add_job(
        check_price_alerts,
        CronTrigger(hour=18, minute=0, day_of_week="mon-fri"),
        id="price_alert_check",
        name="Daily price threshold alert check",
    )

    # Avg price cross/touch at 6:05 PM ET (staggered from S/R)
    scheduler.add_job(
        check_avg_price_crosses_scheduled,
        CronTrigger(hour=18, minute=5, day_of_week="mon-fri"),
        id="avg_price_cross_check",
        name="Daily avg price cross check",
    )

    # Daily trailing-stop check, staggered from S/R and avg-price checks.
    scheduler.add_job(
        check_trailing_stops,
        CronTrigger(hour=18, minute=10, day_of_week="mon-fri", timezone="America/New_York"),
        id="trailing_stop_check",
        name="Daily portfolio trailing stop check",
        replace_existing=True,
        max_instances=1,
        coalesce=True,
    )

    # Earnings-today alert at 8:30 AM ET (before market open)
    scheduler.add_job(
        check_earnings_today,
        CronTrigger(
            day_of_week="mon-fri",
            hour=8, minute=30,
            timezone="America/New_York",
        ),
        id="earnings_today_alert",
        name="Daily earnings-today alert",
        replace_existing=True,
    )

    # Morning earnings date refresh at 8:30 AM ET (before market open)
    # Separate from the earnings-today Discord alert — refreshes data
    # so the Earnings scanner tab has current dates for the trading day.
    scheduler.add_job(
        refresh_earnings_morning,
        CronTrigger(
            day_of_week="mon-fri",
            hour=8, minute=30,
            timezone="America/New_York",
        ),
        id="earnings_morning_refresh",
        name="Morning earnings date refresh",
        replace_existing=True,
    )

    # 200 SMA proximity check at 9:10 AM ET (before market open)
    scheduler.add_job(
        check_sma200_proximity,
        CronTrigger(
            day_of_week="mon-fri",
            hour=9, minute=10,
            timezone="America/New_York",
        ),
        id="sma200_proximity_check",
        name="Daily 200 SMA proximity check",
        replace_existing=True,
    )

    # ORB breakout scan at 10:45 AM ET (after the 10:15-10:30
    # confirmation bar is past yfinance's intraday lag, weekdays only)
    scheduler.add_job(
        run_orb_scan_job,
        CronTrigger(hour=10, minute=45, day_of_week="mon-fri", timezone="America/New_York"),
        id="orb_breakout_scan",
        name="Daily ORB breakout scan (10:45am ET)",
        replace_existing=True,
    )

    # ORB checkpoint reassessment at 11:35 AM ET (single fetch covering
    # the 10:30 / 11:00 / 11:15 decisions, weekdays only)
    scheduler.add_job(
        run_orb_decisions_job,
        CronTrigger(hour=11, minute=35, day_of_week="mon-fri", timezone="America/New_York"),
        id="orb_decisions_scan",
        name="Daily ORB checkpoint reassessment (11:35am ET)",
        replace_existing=True,
    )

    # Volume profile levels at 4:20 PM ET (after 4:05 candles refresh,
    # before 4:30 P/L snapshot). DB-only, no yfinance.
    scheduler.add_job(
        run_volume_profile_job,
        CronTrigger(hour=16, minute=20, day_of_week="mon-fri", timezone="America/New_York"),
        id="volume_profile_eod",
        name="Daily volume profile levels (4:20pm ET)",
        replace_existing=True,
        kwargs={"label": "provisional"},
    )

    # Final volume profile pass at 7:40 PM ET on settled (+ Friday repaired)
    # data. Same idempotent upsert — corrects rows like pre-settlement
    # partials captured by the 4:20 provisional run.
    scheduler.add_job(
        run_volume_profile_job,
        CronTrigger(hour=19, minute=40, day_of_week="mon-fri", timezone="America/New_York"),
        id="volume_profile_eod_final",
        name="Daily volume profile final (7:40pm ET)",
        replace_existing=True,
        kwargs={"label": "final"},
    )

    # P/L snapshot at 4:30 PM ET (30 min after market close, weekdays only)
    scheduler.add_job(
        run_pnl_snapshot,
        CronTrigger(hour=16, minute=30, day_of_week="mon-fri", timezone="America/New_York"),
        id="pnl_snapshot",
        name="Daily P/L Snapshot",
        replace_existing=True,
    )

    # News movers digest at 5:00 PM ET (after P/L snapshot, weekdays only)
    scheduler.add_job(
        refresh_news_movers_digest,
        CronTrigger(hour=17, minute=0, day_of_week="mon-fri", timezone="America/New_York"),
        id="news_movers_refresh",
        name="Daily news movers digest (5pm ET)",
        replace_existing=True,
    )

    # YTD return scan at 7:30 PM ET (after market close, weekdays only)
    scheduler.add_job(
        run_scheduled_ytd_scan,
        CronTrigger(hour=19, minute=30, day_of_week="mon-fri", timezone="America/New_York"),
        id="ytd_scan",
        name="Daily YTD return scan",
        replace_existing=True,
    )

    # Check issuers once each weekday morning. If a file has not been
    # updated yet, the next morning's check will pick up the newer date.
    scheduler.add_job(
        refresh_etf_holdings_job,
        CronTrigger(hour=9, minute=15, day_of_week="mon-fri", timezone="America/Toronto"),
        id="etf_holdings_refresh",
        name="Check published ETF holdings",
        replace_existing=True,
        max_instances=1,
        coalesce=True,
    )

    # Bootstrap newly added ETFs even when other funds already have snapshots.
    from models.db import get_connection
    from services.etf_holdings import ETFS
    with get_connection() as conn:
        populated = {row[0] for row in conn.execute("SELECT DISTINCT etf FROM etf_holding_snapshots")}
    missing = tuple(etf for etf in ETFS if etf not in populated)
    if missing:
        scheduler.add_job(refresh_etf_holdings_job, id="etf_holdings_bootstrap", kwargs={"etfs": missing})

    # Quality Score only: weekly candle repair Friday 19:30, then the
    # Trend Quality scan at 19:35 on the repaired history.
    scheduler.add_job(
        run_candle_repair_job,
        CronTrigger(hour=19, minute=30, day_of_week="fri", timezone="America/New_York"),
        id="quality_candle_repair",
        name="Weekly candle repair for Trend Quality",
        replace_existing=True,
    )
    scheduler.add_job(
        run_scheduled_quality_score_scan,
        CronTrigger(hour=19, minute=35, day_of_week="fri", timezone="America/New_York"),
        id="quality_score_scan",
        name="Weekly Trend Quality scan",
        replace_existing=True,
    )

    scheduler.start()
    logger.info("Background scheduler started")


def stop_scheduler():
    """Stop the background scheduler.

    Call this during application shutdown to cleanly terminate
    all scheduled jobs.
    """
    if scheduler.running:
        scheduler.shutdown()
        logger.info("Background scheduler stopped")
