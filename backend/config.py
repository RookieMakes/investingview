"""
config.py — Constants: universe, company names, sector ETFs, and configuration.
"""

import os

# ── Unified ticker universe ─────────────────────────────────────────────────
# MERGED_UNIVERSE is the single source of truth for all default tickers.
# It is the union of the former DEFAULT_UNIVERSE (78 tickers) and the
# former TICKER_UNIVERSE from yf_fetcher.py (84 tickers).  The result is
# 90 unique symbols — every ticker that was previously in either list.
#
# SECTOR_MAP maps each ticker to a short sector label used throughout the
# app (dashboard, scanners, earnings).
# ────────────────────────────────────────────────────────────────────────────

MERGED_UNIVERSE = [
    # ── Technology / Semis ───────────────────────────────────────────
    "AAPL", "MSFT", "NVDA", "GOOGL", "GOOG", "META", "AVGO", "ORCL",
    "ADBE", "CRM", "NOW", "INTU", "IBM", "DELL", "AMD", "INTC",
    "QCOM", "MU", "ADI", "TXN", "ARM", "TSM",
    # ── Consumer ─────────────────────────────────────────────────────
    "AMZN", "TSLA", "WMT", "COST", "HD", "MCD", "NKE", "SBUX",
    "PG", "KO", "PEP", "ABNB", "TGT", "CSCO",
    # ── Finance ──────────────────────────────────────────────────────
    "JPM", "BAC", "WFC", "C", "GS", "MS", "BLK", "SCHW", "AXP",
    "V", "MA", "CME", "PYPL", "HOOD",
    # ── Healthcare ───────────────────────────────────────────────────
    "JNJ", "UNH", "LLY", "MRK", "ABT", "AMGN", "ISRG", "BSX", "PFE",
    # ── Energy ───────────────────────────────────────────────────────
    "XOM", "CVX",
    # ── Industrial / Transport ───────────────────────────────────────
    "CAT", "DE", "GE", "HON", "ETN", "BA", "MMM", "UPS", "FDX",
    # ── Telecom / Media / Travel / Other ─────────────────────────────
    "T", "VZ", "NFLX", "PLTR", "PANW", "NET", "DIS",
    "GM", "F", "BKNG", "ACN", "ADP", "SNOW", "UBER",
    # ── Tickers from original DEFAULT_UNIVERSE not in yf_fetcher ─────
    "BRK-B", "CL", "CB", "FISV", "SNDK", "IVZ",
]

UNIVERSE_SECTORS = {
    # Technology (GICS: Information Technology)
    "AAPL": "Technology", "MSFT": "Technology", "NVDA": "Technology",
    "GOOGL": "Technology", "GOOG": "Technology", "META": "Technology",
    "AVGO": "Technology", "ORCL": "Technology", "ADBE": "Technology",
    "CRM": "Technology", "NOW": "Technology", "INTU": "Technology",
    "IBM": "Technology", "DELL": "Technology", "AMD": "Technology",
    "INTC": "Technology", "QCOM": "Technology", "MU": "Technology",
    "ADI": "Technology", "TXN": "Technology", "ARM": "Technology",
    "TSM": "Technology", "CSCO": "Technology", "PLTR": "Technology",
    "PANW": "Technology", "NET": "Technology", "SNOW": "Technology",
    # Consumer Discretionary (GICS)
    "AMZN": "Consumer Discretionary", "TSLA": "Consumer Discretionary",
    "HD": "Consumer Discretionary", "MCD": "Consumer Discretionary",
    "NKE": "Consumer Discretionary", "SBUX": "Consumer Discretionary",
    "ABNB": "Consumer Discretionary", "TGT": "Consumer Discretionary",
    "BKNG": "Consumer Discretionary", "GM": "Consumer Discretionary",
    "F": "Consumer Discretionary", "UBER": "Consumer Discretionary",
    # Consumer Staples (GICS)
    "WMT": "Consumer Staples", "COST": "Consumer Staples",
    "PG": "Consumer Staples", "KO": "Consumer Staples",
    "PEP": "Consumer Staples", "CL": "Consumer Staples",
    # Financials (GICS)
    "JPM": "Financials", "BAC": "Financials", "WFC": "Financials",
    "C": "Financials", "GS": "Financials", "MS": "Financials",
    "BLK": "Financials", "SCHW": "Financials", "AXP": "Financials",
    "V": "Financials", "MA": "Financials", "CME": "Financials",
    "PYPL": "Financials", "HOOD": "Financials", "BRK-B": "Financials",
    "CB": "Financials", "FISV": "Financials", "IVZ": "Financials",
    # Health Care (GICS)
    "JNJ": "Health Care", "UNH": "Health Care", "LLY": "Health Care",
    "MRK": "Health Care", "ABT": "Health Care", "AMGN": "Health Care",
    "ISRG": "Health Care", "BSX": "Health Care", "PFE": "Health Care",
    # Energy (GICS)
    "XOM": "Energy", "CVX": "Energy",
    # Industrials (GICS)
    "CAT": "Industrials", "DE": "Industrials", "GE": "Industrials",
    "HON": "Industrials", "ETN": "Industrials", "BA": "Industrials",
    "MMM": "Industrials", "UPS": "Industrials", "FDX": "Industrials",
    "ACN": "Industrials", "ADP": "Industrials",
    # Communication Services (GICS)
    "T": "Communication Services", "VZ": "Communication Services",
    "NFLX": "Communication Services", "DIS": "Communication Services",
    # Legacy tickers
    "SNDK": "Technology",
}

# Backward-compatible alias — existing code that imports DEFAULT_UNIVERSE
# will continue to work unchanged.
DEFAULT_UNIVERSE = MERGED_UNIVERSE

COMPANY_NAMES = {
    "AAPL":"Apple","MSFT":"Microsoft","NVDA":"NVIDIA",
    "AMZN":"Amazon","GOOGL":"Alphabet","GOOG":"Alphabet",
    "META":"Meta","TSLA":"Tesla","BRK-B":"Berkshire Hathaway",
    "AVGO":"Broadcom","LLY":"Eli Lilly","JPM":"JPMorgan Chase",
    "V":"Visa","UNH":"United Health Group","XOM":"Exxon Mobil",
    "MA":"Mastercard","COST":"Costco","HD":"Home Depot",
    "PG":"Procter & Gamble","WMT":"Walmart","NFLX":"Netflix",
    "CRM":"Salesforce","BAC":"Bank of America","ORCL":"Oracle",
    "CVX":"Chevron","MRK":"Merck","KO":"Coca-Cola",
    "PEP":"PepsiCo", "ACN":"Accenture",
    "MCD":"McDonald's","CSCO":"Cisco","ABT":"Abbott Laboratories",
    "WFC":"Wells Fargo", "NOW":"ServiceNow","TXN":"Texas Instruments",
    "ISRG":"Intuitive Surgical", "IBM":"International Business Machines",
    "GS":"Goldman Sachs", "GE":"GE Aerospace",
    "AMGN":"Amgen","BLK":"BlackRock","AXP":"American Express",
    "BKNG":"Booking Holdings", "ADI":"Analog Devices",
    "SCHW":"Charles Schwab","PLTR":"Palantir Technologies","C":"Citi",
    "DE":"Deere","CB":"Chubb",
    "MU":"Micron","PANW":"Palo Alto",
    "ETN":"Eaton plc", "BSX":"Boston Scientific",
    "CME":"CME", "CL":"Colgate",
    "CAT":"Caterpillar","UPS":"United Parcel Service",
    "FDX":"Fedex","BA":"Boeing",
    "HON":"Honeywell","MMM":"3M",
    "ARM":"ARM Holdings","AMD":"Advanced Micro Devices",
    "NKE":"Nike","QCOM":"Qualcomm","INTC":"Intel",
    "ADBE":"Adobe","PYPL":"PayPal Holdings","T":"AT&T",
    "VZ":"Verizon","SBUX":"Starbucks",
    "TGT":"Target","DELL":"Dell",
    "F":"Ford Motor","GM":"General Motors",
    "FISV":"Fiserv","ADP":"Automatic Data Processing",
    "INTU":"Intuit","JNJ":"Johnson & Johnson","NET":"Cloudflare",
    "SNDK":"Sandisk","IVZ":"Invesco",
    # Tickers from former yf_fetcher TICKER_UNIVERSE
    "TSM":"Taiwan Semiconductor","MS":"Morgan Stanley",
    "HOOD":"Robinhood Markets","ABNB":"Airbnb",
    "DIS":"Disney","PFE":"Pfizer","SNOW":"Snowflake",
    "UBER":"Uber Technologies",
}

SECTOR_ETFS = {
    "Technology":"XLK","Health Care":"XLV","Financials":"XLF","Energy":"XLE",
    "Consumer Discretionary":"XLY","Industrials":"XLI","Communication Services":"XLC",
    "Consumer Staples":"XLP","Materials":"XLB","Real Estate":"XLRE","Utilities":"XLU",
}

INDEX_TICKERS = {"SP500":"^GSPC","Nasdaq":"^IXIC","Dow":"^DJI","Russell":"^RUT"}

EARNINGS_WINDOW_DAYS = 5
CACHE_TTL = 86400  # seconds (1 day)

# Database — respect DATABASE_PATH env var (set in Docker to /data/investingview.db)
DATABASE_PATH = os.environ.get("DATABASE_PATH", "data/investingview.db")

# Server
APP_PORT = 9000

# Cache TTLs (seconds)
QUOTE_CACHE_TTL = 300      # 5 minutes
OHLCV_CACHE_TTL = 3600     # 1 hour
SR_CACHE_TTL = 86400       # 24 hours
SECTOR_CACHE_TTL = 21600   # 6 hours

# S/R Alert Constants
SR_TOUCH_BUFFER = 0.003    # 0.3% wick tolerance
SR_COOLDOWN_DAYS = 3       # suppress same line for N days

# Price Alert Constants
PRICE_ALERT_COOLDOWN_DAYS = 1  # re-fire price alerts after 1 day

# Scanner
CHUNK_SIZE = 20            # yfinance batch chunk size

# ── Sub-sector → full sector name mapping ─────────────────────────────────────
# UNIVERSE_SECTORS returns short labels ("Tech", "Semis", "Consumer", ...).
# sector_perf is keyed by full GICS-style names ("Technology", "Health Care").
# This bridge maps one to the other.
SUB_SECTOR_MAP = {
    "Tech": "Technology", "Semis": "Technology", "SaaS": "Technology",
    "Hardware": "Technology",
    "Consumer": "Consumer Discretionary", "EV": "Consumer Discretionary",
    "Finance": "Financials", "Fintech": "Financials", "Insurance": "Financials",
    "Healthcare": "Health Care",
    "Energy": "Energy",
    "Industrial": "Industrials", "Transport": "Industrials",
    "Telecom": "Communication Services", "Media": "Communication Services",
    "AI/Data": "Technology", "Cybersecurity": "Technology",
    "Travel": "Consumer Discretionary", "Consulting": "Industrials",
    "HR Tech": "Industrials", "Auto": "Consumer Discretionary",
    # Identity mappings for GICS full names already used by UNIVERSE_SECTORS
    "Technology": "Technology", "Health Care": "Health Care",
    "Financials": "Financials", "Energy": "Energy",
    "Industrials": "Industrials", "Communication Services": "Communication Services",
    "Consumer Discretionary": "Consumer Discretionary",
    "Consumer Staples": "Consumer Staples",
}

# 200 SMA Scanner
SMA200_PROXIMITY_PCT = 3.0    # within +/- 3% of SMA 200
SMA200_SCAN_CACHE_TTL = 1800  # 30 minutes

# ── Quality Score Scanner ──────────────────────────────────────────────
QUALITY_SCORE_SIGMA_FLOOR = 0.05
QUALITY_SCORE_MIN_CLOSE = 3.0
QUALITY_SCORE_MIN_DOLLAR_VOL = 1_000_000
QUALITY_SCORE_FROZEN_THRESHOLD = 0.02
QUALITY_SCORE_STALE_DAYS = 5
QUALITY_SCORE_MIN_COVERAGE = 0.95
QUALITY_SCORE_EWMA_LAMBDA = 0.94
QUALITY_SCORE_EWMA_BLEND = 0.5
QUALITY_SCORE_SHRINK_WEIGHT = 0.5
QUALITY_SCORE_RISK_FREE_ANNUAL = 0.05
