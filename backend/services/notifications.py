"""
notifications.py — Discord and Email notification senders.
"""

import smtplib
import requests
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart


def _get_setting(key: str, default: str = "") -> str:
    """
    Read a single setting value from the database.

    Args:
        key: The setting key
        default: Fallback value if not found

    Returns:
        The setting value, or default if not found
    """
    try:
        from models.db import get_connection
        with get_connection() as conn:
            row = conn.execute(
                "SELECT value FROM settings WHERE key = ?", (key,)
            ).fetchone()
            return row["value"] if row else default
    except Exception:
        return default


# Maps alert_type to the corresponding email toggle setting key.
_EMAIL_SETTING_MAP = {
    "price": "email_price_alerts",
    "earnings": "email_earnings_alerts",
    "weekly_digest": "email_weekly_digest",
}


def _is_email_enabled(alert_type: str) -> bool:
    """
    Check whether email alerts are enabled for the given alert type.

    Reads the corresponding setting from the database. Returns False by
    default when the setting does not exist (new users get no emails).

    Args:
        alert_type: One of "price", "earnings", or "weekly_digest".

    Returns:
        True only if the setting value is "true" or "1".
    """
    setting_key = _EMAIL_SETTING_MAP.get(alert_type, "")
    if not setting_key:
        return False
    value = _get_setting(setting_key, default="")
    return value.lower() in ("true", "1")


def send_discord(message: str, webhook_url: str = None) -> tuple[bool, str | None]:
    """
    Send a message to Discord via webhook.

    Args:
        message: Message content
        webhook_url: Discord webhook URL (reads from DB if not provided)

    Returns:
        (success, error_message)
    """
    webhook_url = webhook_url or _get_setting("discord_webhook_url")
    if not webhook_url:
        return False, "Discord webhook URL not configured"
    try:
        resp = requests.post(
            webhook_url,
            json={"content": message},
            timeout=10,
        )
        if resp.ok:
            return True, None
        return False, resp.text
    except Exception as e:
        return False, str(e)


def send_email(subject: str, body: str,
               sender: str = None,
               app_password: str = None,
               recipient: str = None) -> tuple[bool, str | None]:
    """
    Send an email via Gmail SMTP SSL.

    Args:
        subject: Email subject
        body: Email body (plain text)
        sender: Gmail address (reads from DB if not provided)
        app_password: Gmail app password (reads from DB if not provided)
        recipient: Recipient email (reads from DB if not provided)

    Returns:
        (success, error_message)
    """
    sender = sender or _get_setting("email_sender")
    app_password = app_password or _get_setting("email_app_password")
    recipient = recipient or _get_setting("email_recipient")

    if not sender or not app_password or not recipient:
        return False, "Email credentials not configured"

    try:
        msg = MIMEMultipart()
        msg["From"] = sender
        msg["To"] = recipient
        msg["Subject"] = subject
        msg.attach(MIMEText(body, "plain"))

        with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=15) as server:
            server.login(sender, app_password)
            server.sendmail(sender, recipient, msg.as_string())
        return True, None
    except Exception as e:
        return False, str(e)


def send_notification(message: str, channels: list[str] = None) -> dict[str, tuple[bool, str | None]]:
    """
    Send notification to multiple channels.

    Args:
        message: Message to send
        channels: List of channels to use ('discord', 'email'). Defaults to both.

    Returns:
        Dict of {channel: (success, error)}
    """
    if channels is None:
        channels = ["discord", "email"]

    results = {}
    if "discord" in channels:
        results["discord"] = send_discord(message)
    if "email" in channels:
        results["email"] = send_email("InvestingView Alert", message)

    return results


def send_discord_embed(embed: dict, webhook_url: str = None) -> tuple[bool, str | None]:
    """
    Send a Discord rich embed to a webhook.

    Args:
        embed: Discord embed object dict with title, description, color, fields, etc.
        webhook_url: Discord webhook URL (reads from DB if not provided)

    Returns:
        (success, error_message)
    """
    webhook_url = webhook_url or _get_setting("discord_webhook_url")
    if not webhook_url:
        return False, "Discord webhook URL not configured"
    try:
        resp = requests.post(
            webhook_url,
            json={"embeds": [embed]},
            timeout=10,
        )
        if resp.ok:
            return True, None
        return False, resp.text
    except Exception as e:
        return False, str(e)


def _build_trailing_stop_embed(event: dict) -> dict:
    """Same rich-embed delivery as S/R, with portfolio and hit-candle context."""
    from datetime import datetime, timezone

    return {
        "title": f"🔴 {event['ticker']} — Trailing Stop HIT",
        "description": "Daily candle touched or crossed the trailing stop.",
        "color": 0xFF4D6D,
        "fields": [
            {"name": "Portfolio", "value": f"{event['portfolio_name']} (#{event['portfolio_id']})", "inline": False},
            {"name": "Stop", "value": f"${event['stop_price']:,.2f}", "inline": True},
            {"name": "Trail distance", "value": f"${event['trail_amount']:,.2f}", "inline": True},
            {"name": "Hit session", "value": event["hit_date"], "inline": True},
            {"name": "Candle (O / H / L / C)", "value": " / ".join(
                f"${event['hit_' + field]:,.2f}" for field in ("open", "high", "low", "close")
            ), "inline": False},
        ],
        "footer": {"text": "InvestingView · Trailing Stop Alert"},
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


def _build_sr_embed(ticker: str, sr_type: str, sr_price: float,
                     pattern: str, candle: dict) -> dict:
    """
    Build a Discord rich embed for an S/R alert.

    Color scheme:
      - Pattern A/B (bounce/reject): Green (support) / Red (resistance)
      - Pattern C/D (break/breakout): Orange (support) / Blue (resistance)

    Args:
        ticker: Stock ticker symbol
        sr_type: 'support' or 'resistance'
        sr_price: The S/R price level
        pattern: Alert pattern letter ('A', 'B', 'C', or 'D')
        candle: Dict with keys: date, open, high, low, close

    Returns:
        Discord embed dict ready to POST.
    """
    from datetime import datetime, timezone

    pattern_info = {
        "A": {
            "desc": "Same-candle bounce/rejection — level holds",
            "support": ("Bounced off Support", 0x00D4AA, "🟢"),
            "resistance": ("Rejected at Resistance", 0xFF4D6D, "🔴"),
        },
        "B": {
            "desc": "Two-candle confirmed bounce/rejection — level holds",
            "support": ("Bounced off Support", 0x00D4AA, "🟢"),
            "resistance": ("Rejected at Resistance", 0xFF4D6D, "🔴"),
        },
        "C": {
            "desc": "Same-candle break/breakout — level fails (no prior touch)",
            "support": ("Support Broken", 0xFFA500, "⚠️"),
            "resistance": ("Resistance Broken", 0x00BFFF, "🚀"),
        },
        "D": {
            "desc": "Two-candle confirmed break/breakout — level fails (prior touch)",
            "support": ("Support Broken", 0xFFA500, "⚠️"),
            "resistance": ("Resistance Broken", 0x00BFFF, "🚀"),
        },
    }

    info = pattern_info.get(pattern, pattern_info["A"])
    title_text, color, emoji = info[sr_type]
    description = info["desc"]

    o = candle.get("open", 0)
    h = candle.get("high", 0)
    l = candle.get("low", 0)
    c = candle.get("close", 0)

    embed = {
        "title": f"{emoji} {ticker} — {title_text}",
        "description": description,
        "color": color,
        "fields": [
            {
                "name": f"{sr_type.title()} Level",
                "value": f"${sr_price:,.2f}",
                "inline": True,
            },
            {
                "name": "Close",
                "value": f"${c:,.2f}",
                "inline": True,
            },
            {
                "name": "Candle (O / H / L / C)",
                "value": f"${o:,.2f} / ${h:,.2f} / ${l:,.2f} / ${c:,.2f}",
                "inline": False,
            },
        ],
        "footer": {"text": "InvestingView · S/R Alert"},
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }

    return embed


def send_sr_email_alert(ticker: str, sr_type: str, sr_price: float,
                         pattern: str, candle: dict) -> tuple[bool, str | None]:
    """
    Send a formatted email alert for an S/R pattern detection.

    Args:
        ticker: Stock ticker symbol
        sr_type: 'support' or 'resistance'
        sr_price: The S/R price level
        pattern: Alert pattern letter
        candle: Dict with keys: date, open, high, low, close

    Returns:
        (success, error_message)
    """
    pattern_labels = {
        "A": "Same-candle bounce/rejection",
        "B": "Two-candle confirmed bounce/rejection",
        "C": "Same-candle break/breakout",
        "D": "Two-candle confirmed break/breakout",
    }
    label = pattern_labels.get(pattern, f"Pattern {pattern}")
    sr_label = sr_type.title()

    subject = f"InvestingView S/R Alert: {ticker} — {sr_label} ${sr_price:.2f} (Pattern {pattern})"

    body = (
        f"S/R Alert — {ticker}\n"
        f"{'=' * 40}\n\n"
        f"Type:       {sr_label}\n"
        f"Level:      ${sr_price:,.2f}\n"
        f"Pattern:    {pattern} — {label}\n\n"
        f"Latest Candle ({candle.get('date', 'N/A')}):\n"
        f"  Open:  ${candle.get('open', 0):,.2f}\n"
        f"  High:  ${candle.get('high', 0):,.2f}\n"
        f"  Low:   ${candle.get('low', 0):,.2f}\n"
        f"  Close: ${candle.get('close', 0):,.2f}\n\n"
        f"{'=' * 40}\n"
        f"InvestingView · S/R Alert\n"
    )

    return send_email(subject, body)


# ── Price alert embeds ─────────────────────────────────────────────────────


def _build_price_alert_embed(ticker: str, alert_type: str, threshold: float,
                              current_price: float, change_pct: float) -> dict:
    """Build a Discord rich embed for a price threshold alert.

    Color scheme:
      - price_above (bullish): green (0x00D4AA)
      - price_below (bearish): red (0xFF4D6D)

    Args:
        ticker: Stock ticker symbol.
        alert_type: "price_above" or "price_below".
        threshold: The alert threshold price.
        current_price: Current market price.
        change_pct: Daily % change.

    Returns:
        Discord embed dict ready to POST.
    """
    from datetime import datetime, timezone

    is_above = alert_type == "price_above"
    emoji = "📈" if is_above else "📉"
    title_text = "Price Above Threshold" if is_above else "Price Below Threshold"
    color = 0x00D4AA if is_above else 0xFF4D6D
    direction = "above" if is_above else "below"

    embed = {
        "title": f"{emoji} {ticker} — {title_text}",
        "description": f"Price crossed {direction} your alert threshold",
        "color": color,
        "fields": [
            {
                "name": "Threshold",
                "value": f"${threshold:,.2f}",
                "inline": True,
            },
            {
                "name": "Current Price",
                "value": f"${current_price:,.2f}",
                "inline": True,
            },
            {
                "name": "Daily Change",
                "value": f"{change_pct:+.2f}%",
                "inline": True,
            },
        ],
        "footer": {"text": "InvestingView · Price Alert"},
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    return embed


def _build_avg_price_embed(ticker: str, avg_price: float, pattern: str,
                            candle: dict, qty: float = None,
                            portfolio_name: str = None) -> dict:
    """Build a Discord rich embed for an average price cross/touch.

    Color scheme:
      - cross_above / touch_bullish: green (0x00D4AA)
      - cross_below / touch_bearish: red (0xFF4D6D)

    Args:
        ticker: Stock ticker symbol.
        avg_price: The position's average cost basis.
        pattern: One of cross_above, cross_below, touch_bullish, touch_bearish.
        candle: Dict with open, high, low, close.
        qty: Number of shares held (optional, for P&L display).
        portfolio_name: Name of the portfolio (optional).

    Returns:
        Discord embed dict ready to POST.
    """
    from datetime import datetime, timezone

    bullish = pattern in ("cross_above", "touch_bullish")
    color = 0x00D4AA if bullish else 0xFF4D6D
    is_cross = "cross" in pattern
    emoji = "🟢" if bullish else "🔴"

    if is_cross:
        title_text = "Price Crossed Average"
        desc = f"{'Above' if bullish else 'Below'} your cost basis"
    else:
        title_text = "Price Touched Average"
        desc = f"Wick {'above' if bullish else 'below'} cost basis (no close confirm)"

    o = candle.get("open", 0)
    h = candle.get("high", 0)
    l = candle.get("low", 0)
    c = candle.get("close", 0)

    fields = [
        {
            "name": "Avg Price",
            "value": f"${avg_price:,.2f}",
            "inline": True,
        },
        {
            "name": "Close",
            "value": f"${c:,.2f}",
            "inline": True,
        },
    ]

    # Add position context if available
    if qty is not None:
        market_value = qty * c
        cost_basis = qty * avg_price
        pnl_dollar = market_value - cost_basis
        pnl_pct = ((c - avg_price) / avg_price * 100) if avg_price else 0
        pnl_sign = "+" if pnl_dollar >= 0 else ""

        fields.append({
            "name": "Shares",
            "value": f"{qty:,.4g}",
            "inline": True,
        })
        fields.append({
            "name": "Market Value",
            "value": f"${market_value:,.2f}",
            "inline": True,
        })
        fields.append({
            "name": "Unrealized P&L",
            "value": f"{pnl_sign}${pnl_dollar:,.2f} ({pnl_sign}{pnl_pct:.1f}%)",
            "inline": True,
        })

    if portfolio_name:
        fields.append({
            "name": "Portfolio",
            "value": portfolio_name,
            "inline": True,
        })

    fields.append({
        "name": "Candle (O / H / L / C)",
        "value": f"${o:,.2f} / ${h:,.2f} / ${l:,.2f} / ${c:,.2f}",
        "inline": False,
    })

    embed = {
        "title": f"{emoji} {ticker} — {title_text}",
        "description": desc,
        "color": color,
        "fields": fields,
        "footer": {"text": "InvestingView · Avg Price Alert"},
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    return embed


def send_price_email_alert(ticker: str, alert_type: str, threshold: float,
                            current_price: float) -> tuple[bool, str | None]:
    """Send email for a price threshold alert.

    Args:
        ticker: Stock ticker symbol.
        alert_type: "price_above" or "price_below".
        threshold: The alert threshold price.
        current_price: Price at time of firing.

    Returns:
        (success, error_message)
    """
    direction = "above" if alert_type == "price_above" else "below"
    subject = (
        f"InvestingView Price Alert: {ticker} "
        f"${current_price:.2f} (threshold ${threshold:.2f})"
    )
    body = (
        f"Price Alert — {ticker}\n"
        f"{'=' * 40}\n\n"
        f"Type:       Price {direction.title()} threshold\n"
        f"Threshold:  ${threshold:,.2f}\n"
        f"Current:    ${current_price:,.2f}\n\n"
        f"{'=' * 40}\n"
        f"InvestingView · Price Alert\n"
    )
    return send_email(subject, body)


def send_avg_price_email_alert(ticker: str, avg_price: float,
                                pattern: str, candle: dict) -> tuple[bool, str | None]:
    """Send email for an avg price cross/touch event.

    Args:
        ticker: Stock ticker symbol.
        avg_price: The position's average cost basis.
        pattern: One of cross_above, cross_below, touch_bullish, touch_bearish.
        candle: Dict with open, high, low, close.

    Returns:
        (success, error_message)
    """
    labels = {
        "cross_above": "Crossed Above Average",
        "cross_below": "Crossed Below Average",
        "touch_bullish": "Touched Average (Bullish)",
        "touch_bearish": "Touched Average (Bearish)",
    }
    label = labels.get(pattern, pattern)
    subject = f"InvestingView Avg Price Alert: {ticker} — {label}"
    body = (
        f"Average Price Alert — {ticker}\n"
        f"{'=' * 40}\n\n"
        f"Pattern:    {label}\n"
        f"Avg Price:  ${avg_price:,.2f}\n\n"
        f"Latest Candle:\n"
        f"  Open:  ${candle.get('open', 0):,.2f}\n"
        f"  High:  ${candle.get('high', 0):,.2f}\n"
        f"  Low:   ${candle.get('low', 0):,.2f}\n"
        f"  Close: ${candle.get('close', 0):,.2f}\n\n"
        f"{'=' * 40}\n"
        f"InvestingView · Avg Price Alert\n"
    )
    return send_email(subject, body)


def _build_sma200_embed(tickers: list[dict], threshold_pct: float) -> dict:
    """
    Build Discord embed for 200 SMA proximity alert.

    Args:
        tickers: List of dicts with ticker, price, sma_200, pct_from_sma, above_sma
        threshold_pct: The proximity threshold used

    Returns:
        Discord embed dict ready to POST.
    """
    from datetime import datetime, timezone

    above = [t for t in tickers if t["above_sma"]]
    below = [t for t in tickers if not t["above_sma"]]

    # Build description
    lines = []

    if above:
        lines.append("**🟢 ABOVE SMA**")
        for t in above[:10]:  # Limit to top 10
            lines.append(
                f"  {t['ticker']} — ${t['price']:.2f} "
                f"(SMA: ${t['sma_200']:.2f}, {t['pct_from_sma']:+.1f}%)"
            )
        if len(above) > 10:
            lines.append(f"  ... and {len(above) - 10} more")
        lines.append("")

    if below:
        lines.append("**🔴 BELOW SMA**")
        for t in below[:10]:  # Limit to top 10
            lines.append(
                f"  {t['ticker']} — ${t['price']:.2f} "
                f"(SMA: ${t['sma_200']:.2f}, {t['pct_from_sma']:+.1f}%)"
            )
        if len(below) > 10:
            lines.append(f"  ... and {len(below) - 10} more")
        lines.append("")

    lines.append(f"**Total: {len(tickers)} stocks within {threshold_pct}% of 200 SMA**")

    description = "\n".join(lines)

    # Color: Gold if mixed, Green if mostly above, Red if mostly below
    if len(above) > len(below):
        color = 0x00D4AA  # Green
    elif len(below) > len(above):
        color = 0xFF4D6D  # Red
    else:
        color = 0xFFD700  # Gold

    return {
        "title": "📊 200 SMA Proximity Alert",
        "description": description,
        "color": color,
        "footer": {"text": "InvestingView • 200 SMA Scanner"},
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


def _get_earnings_today() -> list[str]:
    """
    Query the database for tickers reporting earnings today.

    Returns:
        List of ticker symbols with earnings on today's date.
    """
    from datetime import date
    from models.db import get_connection

    today = date.today().isoformat()
    try:
        with get_connection() as conn:
            rows = conn.execute(
                "SELECT symbol FROM dash_earnings WHERE earnings_date = ?",
                (today,),
            ).fetchall()
            return [row["symbol"] for row in rows]
    except Exception:
        return []


def _build_earnings_today_embed(tickers: list[str]) -> dict:
    """
    Build Discord embed for daily earnings alert.

    Args:
        tickers: List of ticker symbols reporting earnings today

    Returns:
        Discord embed dict ready to POST.
    """
    from datetime import datetime, timezone

    if not tickers:
        description = "No stocks reporting earnings today."
        color = 0x808080  # Gray
    else:
        lines = [f"  **{t}**" for t in sorted(tickers)]
        lines.append("")
        lines.append(f"**Total: {len(tickers)} stock{'s' if len(tickers) != 1 else ''} reporting today**")
        description = "\n".join(lines)
        color = 0xFFD700  # Gold

    return {
        "title": "📅 Earnings Today",
        "description": description,
        "color": color,
        "footer": {"text": "InvestingView • Earnings Calendar"},
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
