"""
news_movers.py — Movers news digest service (news-only, free only).

EOD digest explaining *why* prices moved, grouped Finviz-style by mover.
Pipeline: universe (DB live) -> movers (quotes.change_pct) ->
Google News RSS per mover (12h default, 24h debug fallback) ->
filter + cross-ticker dedup -> news_movers / news_digest tables.

Schedule: 5pm ET daily (see REQUIREMENTS-news-movers.md). No polling,
no SEC parsing, no DB writes outside the two news tables.
"""

import logging
import re
import time
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from threading import Lock
from urllib.parse import quote
from urllib.request import Request, urlopen

log = logging.getLogger(__name__)

DEFAULT_WINDOW = "12h"
DEBUG_WINDOW = "24h"
ALLOWED_WINDOWS = {"1h", "8h", "12h", "24h", "48h", "7d"}
DEFAULT_MOVER_PCT = 3.0
RETENTION_DAYS = 7
_ticker_cache = {}
_ticker_cache_lock = Lock()
TICKER_CACHE_SECONDS = 300

# Tickers whose symbol alone is too ambiguous for a news query
# ("V stock", "MA stock" return sports/weather junk). These plus
# short symbols, .TO listings and ETFs use company-name-only queries.
SHORT_TICKERS = {
    "V", "MA", "C", "F", "T", "GE", "KO", "BA", "CAT", "DE", "CL",
    "GM", "NKE", "DIS", "AXP", "BKNG", "CB", "DELL",
}
_STOP_WORDS = {
    "inc", "corp", "corporation", "company", "holdings", "group", "ltd",
    "limited", "plc", "etf", "ishares", "vanguard", "index",
    # Articles / prepositions — otherwise "The Toronto-Dominion Bank"
    # yields token "the" which matches every English headline.
    "the", "a", "an", "and", "of", "for", "with", "from", "to", "in",
    "on", "at", "by", "or", "as",
    # Generic finance words — otherwise "Bank of America" yields "bank"
    # and "Manulife Financial Corporation" yields "financial".
    "bank", "banks", "banking", "financial", "finance", "financials",
    "services", "service",
}


def build_query(ticker, company, window=DEFAULT_WINDOW):
    """Build a Google News RSS query string for a ticker.

    Ambiguous symbols (.TO, ETFs, short tickers) use company-name-only
    queries; everything else uses "Company TICKER stock".
    """
    t = (ticker or "").strip().upper()
    name = (company or t).strip()
    lowered = name.lower()
    is_etf = "etf" in lowered or "index" in lowered
    if t.endswith(".TO") or is_etf or t in SHORT_TICKERS or len(t) <= 2:
        q = f"{name} stock when:{window}"
    else:
        q = f"{name} {t} stock when:{window}"
    return q


def fetch_news(query, timeout=15):
    """Fetch Google News RSS items for a query string.

    Returns [{title, link, published, outlet}]. Raises RuntimeError
    if feedparser is not installed.
    """
    try:
        import feedparser
    except ImportError:
        raise RuntimeError(
            "feedparser is required for news fetch "
            "(pip install -r backend/requirements.txt)"
        )
    url = (
        "https://news.google.com/rss/search?q="
        f"{quote(query)}&hl=en-US&gl=US&ceid=US:en"
    )
    with urlopen(Request(url, headers={"User-Agent": "InvestingView/1.0"}), timeout=timeout) as response:
        feed = feedparser.parse(response.read())
    if feed.get("bozo") and not feed.entries:
        raise RuntimeError("News feed is temporarily unavailable")
    rows = []
    for entry in feed.entries:
        title = (entry.get("title") or "").strip()
        if not title:
            continue
        rows.append({
            "title": title,
            "link": entry.get("link", ""),
            "published": entry.get("published", ""),
            "outlet": title.rsplit(" - ", 1)[-1] if " - " in title else "",
        })
    return rows


def get_ticker_news(ticker):
    """On-demand news, isolated from the daily digest; strictly the last 8 hours."""
    from models.db import get_connection

    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(hours=8)
    with _ticker_cache_lock:
        cached = _ticker_cache.get(ticker)
    if cached and time.monotonic() - cached[0] < TICKER_CACHE_SECONDS:
        payload = cached[1]
    else:
        with get_connection() as conn:
            row = conn.execute(
                "SELECT company_name FROM universe WHERE ticker = ?", (ticker,),
            ).fetchone()
        company = (row["company_name"] if row else None) or ticker
        rows = fetch_news(build_query(ticker, company, window="8h"))
        now = datetime.now(timezone.utc)
        cutoff = now - timedelta(hours=8)
        items = []
        seen = set()
        for row in rows:
            try:
                published = parsedate_to_datetime(row.get("published", ""))
                if published.tzinfo is None:
                    published = published.replace(tzinfo=timezone.utc)
                published = published.astimezone(timezone.utc)
            except (ValueError, TypeError, OverflowError):
                continue
            if not cutoff <= published <= now or not keep_row(row["title"], ticker, company):
                continue
            key = norm_title(row["title"])
            if key in seen:
                continue
            seen.add(key)
            items.append({**row, "published": published.isoformat()})
        items.sort(key=lambda item: item["published"], reverse=True)
        payload = {"ticker": ticker, "company": company, "window": "8h",
                   "fetched_at": datetime.now(timezone.utc).isoformat(), "items": items}
        with _ticker_cache_lock:
            if len(_ticker_cache) >= 256:
                oldest = min(_ticker_cache, key=lambda key: _ticker_cache[key][0])
                del _ticker_cache[oldest]
            _ticker_cache[ticker] = (time.monotonic(), payload)
    # Even cached stories must not age beyond the requested window.
    return {**payload, "items": [item for item in payload["items"]
                                if cutoff <= datetime.fromisoformat(item["published"]) <= now]}


def company_token(company):
    """First significant word of a company name, for relevance filtering.

    Original logic returned the first len>=3 non-stop word, which fails
    for "The Toronto-Dominion Bank" (token "the" matches every headline)
    and "Bank of America" (token "bank" is too generic). With the expanded
    _STOP_WORDS above, the first remaining word is distinctive: toronto,
    america, manulife, etc. Order is preserved (not longest) so "Uber
    Technologies" -> uber and "Taiwan Semiconductor" -> taiwan instead of
    a generic longest word.

    len>=4 is preferred (skips "Eli"/"One"/"AT" substrings like "eli" in
    "believe"); len>=3 is the fallback (e.g. "CME"); digit-containing
    len>=2 covers "3M". Pure numbers and stop words are never returned.
    Returns "" when nothing distinctive remains (e.g. "AT&T") so
    keep_row() falls back to ticker-only instead of matching everything.
    """
    words = re.split(r"\W+", company or "")
    for min_len in (4, 3):
        for word in words:
            lowered = word.lower()
            if len(word) < min_len:
                continue
            if lowered in _STOP_WORDS:
                continue
            if word.isdigit():
                continue
            return lowered
    for word in words:  # e.g. "3M" — short but digit-qualified, specific
        lowered = word.lower()
        if word.isdigit():
            continue
        if len(word) >= 2 and any(ch.isdigit() for ch in word):
            if lowered not in _STOP_WORDS:
                return lowered
    return ""


def keep_row(title, ticker, company):
    """Drop junk headlines mentioning neither the ticker nor the company.

    Tickers match only as standalone tokens ($TICKER or word-boundary),
    never as substrings — otherwise "NET" matches "nets" and "V"
    matches every other word. Company token is the fallback.

    Listings with a suffix (TD.TO, BRK-B) also match their base symbol
    (TD, BRK) since headlines say "TD Bank", not "TD.TO".
    """
    text = (title or "").upper()
    tick = (ticker or "").strip().upper()
    candidates = {tick}
    if "." in tick:
        candidates.add(tick.split(".")[0])
    if "-" in tick:
        candidates.add(tick.split("-")[0])
    for cand in candidates:
        if cand and re.search(r"(?:\$|\b)" + re.escape(cand) + r"\b", text):
            return True
    token = company_token(company)
    return bool(token) and token in (title or "").lower()


def norm_title(title):
    """Normalized title for cross-ticker dedup (outlet suffix stripped)."""
    text = (title or "").lower()
    text = text.rsplit(" - ", 1)[0] if " - " in text else text
    text = re.sub(r"[^a-z0-9 ]", "", text)
    return re.sub(r"\s+", " ", text).strip()


def get_movers(mover_pct=DEFAULT_MOVER_PCT):
    """Movers from the quotes table (|change_pct| >= threshold).

    Uses cached quotes (populated by the price layer) — no yfinance
    calls here. Tickers without a change_pct are skipped.
    Returns [{ticker, company, sector, pct, direction, last}], |pct| desc.
    """
    from data.fetcher import get_quotes
    from services.universe import get_merged_universe_with_metadata

    universe = get_merged_universe_with_metadata()
    quotes = {q["ticker"]: q for q in get_quotes([u["ticker"] for u in universe])}
    movers = []
    for row in universe:
        ticker = row["ticker"]
        quote_row = quotes.get(ticker) or {}
        pct = quote_row.get("change_pct")
        if pct is None:
            continue
        try:
            pct = float(pct)
        except (TypeError, ValueError):
            continue
        if abs(pct) >= mover_pct:
            movers.append({
                "ticker": ticker,
                "company": row.get("company_name") or ticker,
                "sector": row.get("sector") or "",
                "pct": round(pct, 2),
                "direction": "up" if pct > 0 else "down",
                "last": quote_row.get("price"),
            })
    movers.sort(key=lambda m: abs(m["pct"]), reverse=True)
    return movers


def fetch_digest(movers, window=DEFAULT_WINDOW, pause_sec=1.0):
    """Fetch + filter + attribute news for an explicit mover list.

    Two passes: (1) fetch and relevance-filter per mover; (2) attribute
    each unique story to EVERY mover it mentions (ticker or company
    token match), so a shared headline like "CRWD, PANW, NET, ZS: ..."
    appears under each mover group instead of only the first-processed
    ticker. Dedup applies within a ticker only.

    Returns {mover_ticker: [rows]}. Continues per-ticker on error.
    """
    per_ticker = {}
    for mover in movers:
        ticker = mover["ticker"]
        query = build_query(ticker, mover.get("company", ticker), window)
        try:
            rows = fetch_news(query)
        except Exception as exc:  # per-ticker isolation
            log.warning("news.fetch.error ticker=%s: %s", ticker, exc)
            rows = []
        kept = [
            row for row in rows
            if keep_row(row["title"], ticker, mover.get("company", ticker))
        ]
        per_ticker[ticker] = kept
        log.info("news.fetch ticker=%s raw=%d kept=%d", ticker, len(rows), len(kept))
        if pause_sec:
            time.sleep(pause_sec)

    # Pass 2: attribute shared stories to all mentioned movers.
    by_mover = {m["ticker"]: m for m in movers}
    unique = {}
    for ticker, rows in per_ticker.items():
        for row in rows:
            unique.setdefault(norm_title(row["title"]), row)
    items = {ticker: [] for ticker in per_ticker}
    seen_keys = {ticker: set() for ticker in per_ticker}
    for key, row in unique.items():
        for ticker, mover in by_mover.items():
            if key in seen_keys[ticker]:
                continue
            if keep_row(row["title"], ticker, mover.get("company", ticker)):
                items[ticker].append(row)
                seen_keys[ticker].add(key)
    for ticker in items:
        log.info("news.attribute ticker=%s stories=%d", ticker, len(items[ticker]))
    return items


def save_digest(run_date, movers, items, window=DEFAULT_WINDOW):
    """Persist a digest run (movers + stories). Idempotent per run_date."""
    from models.db import get_connection

    now = datetime.now(timezone.utc).isoformat()
    with get_connection() as conn:
        for mover in movers:
            conn.execute(
                """INSERT OR REPLACE INTO news_movers
                   (run_date, ticker, company, move_pct, direction, last_price, window)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (run_date, mover["ticker"], mover.get("company", ""),
                 mover.get("pct"), mover.get("direction", ""),
                 mover.get("last"), window),
            )
            for row in items.get(mover["ticker"], []):
                conn.execute(
                    """INSERT OR IGNORE INTO news_digest
                       (run_date, ticker, move_pct, direction, title, link,
                        published, outlet, fetched_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (run_date, mover["ticker"], mover.get("pct"),
                     mover.get("direction", ""), row["title"], row.get("link", ""),
                     row.get("published", ""), row.get("outlet", ""), now),
                )


def load_digest(run_date):
    """Load a saved digest run with stories grouped by ticker.

    Returns {run_date, window, movers, items, fetched_at, universe_count}
    where fetched_at is the latest story fetch timestamp of the run and
    universe_count is the live universe size (for the header meta).
    """
    from models.db import get_connection
    from services.universe import get_merged_universe

    with get_connection() as conn:
        mover_rows = conn.execute(
            "SELECT ticker, company, move_pct, direction, last_price, window "
            "FROM news_movers WHERE run_date = ? ORDER BY ABS(move_pct) DESC",
            (run_date,),
        ).fetchall()
        story_rows = conn.execute(
            "SELECT ticker, move_pct, direction, title, link, published, outlet "
            "FROM news_digest WHERE run_date = ?",
            (run_date,),
        ).fetchall()
        fetched_at = conn.execute(
            "SELECT MAX(fetched_at) AS fetched_at FROM news_digest "
            "WHERE run_date = ?",
            (run_date,),
        ).fetchone()["fetched_at"]
    movers = [dict(r) for r in mover_rows]
    window = movers[0]["window"] if movers else DEFAULT_WINDOW
    items = {m["ticker"]: [] for m in movers}
    for story in story_rows:
        items.setdefault(story["ticker"], []).append({
            "title": story["title"], "link": story["link"],
            "published": story["published"], "outlet": story["outlet"],
        })
    try:
        universe_count = len(get_merged_universe())
    except Exception:
        universe_count = None
    return {"run_date": run_date, "window": window,
            "movers": movers, "items": items,
            "fetched_at": fetched_at, "universe_count": universe_count}


def list_digest_dates(limit=RETENTION_DAYS):
    """Most recent digest run dates with mover/story counts (history pills)."""
    from models.db import get_connection

    with get_connection() as conn:
        rows = conn.execute(
            """SELECT m.run_date,
                      COUNT(DISTINCT m.ticker) AS movers,
                      COUNT(d.title) AS stories
               FROM news_movers m
               LEFT JOIN news_digest d
                 ON d.run_date = m.run_date AND d.ticker = m.ticker
               GROUP BY m.run_date
               ORDER BY m.run_date DESC
               LIMIT ?""",
            (limit,),
        ).fetchall()
    return [dict(r) for r in rows]


def purge_old_digest(retention_days=RETENTION_DAYS):
    """Delete digest runs older than the retention window. Returns rows cut."""
    from models.db import get_connection

    with get_connection() as conn:
        conn.execute(
            "DELETE FROM news_digest WHERE run_date < "
            "date((SELECT MAX(run_date) FROM news_movers), ?)",
            (f"-{int(retention_days)} days",),
        )
        cur = conn.execute(
            "DELETE FROM news_movers WHERE run_date < "
            "date((SELECT MAX(run_date) FROM news_movers), ?)",
            (f"-{int(retention_days)} days",),
        )
        return cur.rowcount
