"""
signals.py — Signal tracking and return backfill.

Records signals when scanner alerts fire and tracks subsequent returns.
"""

from datetime import date, timedelta
from models.db import get_connection
from data.fetcher import get_ohlcv


def record_alerts(scan_type: str, alerts: list[dict], session_date: str | None = None):
    """
    Record signals when scanner alerts fire.

    alerts: list of {ticker, conviction, score, price}
    """
    today = session_date or date.today().isoformat()

    with get_connection() as conn:
        for alert in alerts:
            try:
                # Convert numpy types to native Python types for SQLite safety
                score = alert.get("score")
                if score is not None:
                    score = int(score)
                price = alert.get("price")
                if price is not None:
                    price = float(price)
                conviction = alert.get("conviction")
                if conviction is not None:
                    conviction = str(conviction)

                conn.execute("""
                    INSERT OR IGNORE INTO signals (scan_type, signal_date, ticker,
                                                  conviction, score, price_at_signal)
                    VALUES (?, ?, ?, ?, ?, ?)
                """, (scan_type, today, alert["ticker"], conviction,
                      score, price))
            except Exception as e:
                print(f"Error recording signal for {alert['ticker']}: {e}")


def backfill_returns():
    """
    Fetch historical prices for past signals and calculate returns.

    Checks signals from 1, 5, 10, 20 days ago and fetches their current prices.
    """
    today = date.today()

    with get_connection() as conn:
        # Get signals that need backfill
        signals = conn.execute("""
            SELECT id, signal_date, ticker, price_at_signal
            FROM signals
            WHERE price_at_signal IS NOT NULL
        """).fetchall()

        for signal in signals:
            signal_date = date.fromisoformat(signal["signal_date"])
            ticker = signal["ticker"]
            base_price = signal["price_at_signal"]

            # Calculate days since signal
            days_since = (today - signal_date).days

            # Check if we need to fetch returns for this signal
            for offset in [1, 5, 10, 20]:
                if days_since >= offset:
                    # Check if return already exists
                    existing = conn.execute("""
                        SELECT id FROM signal_returns
                        WHERE signal_id = ? AND day_offset = ?
                    """, (signal["id"], offset)).fetchone()

                    if not existing:
                        # Fetch price at offset days after signal
                        target_date = signal_date + timedelta(days=offset)
                        try:
                            candles = get_ohlcv(ticker, period="1mo")
                            # Find the candle closest to target_date
                            price = None
                            for c in candles:
                                if c["date"] >= target_date.isoformat():
                                    price = c["close"]
                                    break

                            if price and base_price:
                                pct_return = ((price - base_price) / base_price) * 100
                                conn.execute("""
                                    INSERT INTO signal_returns (signal_id, day_offset, price, pct_return)
                                    VALUES (?, ?, ?, ?)
                                """, (signal["id"], offset, price, round(pct_return, 2)))
                        except Exception as e:
                            print(f"Error backfilling returns for {ticker}: {e}")
