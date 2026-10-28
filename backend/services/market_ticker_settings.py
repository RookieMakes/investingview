"""Validated, independently persisted portfolio market ticker preferences."""

import copy
import json
import re

from models.db import get_connection

SETTING_KEY = "market_ticker"
MAX_INSTRUMENTS = 30
SYMBOL_PATTERN = re.compile(r"[A-Z0-9_]+:[A-Z0-9_.!^/=-]+", re.ASCII)
DEFAULTS = {
    "enabled": True,
    "charts": True,
    "instruments": [
        {"symbol": "FOREXCOM:SPXUSD", "name": "S&P 500", "desktop": True, "mobile": True},
        {"symbol": "FOREXCOM:NSXUSD", "name": "Nasdaq 100", "desktop": True, "mobile": True},
        {"symbol": "FOREXCOM:DJI", "name": "Dow Jones", "desktop": True, "mobile": True},
        {"symbol": "SAXO:CADUSD", "name": "CAD/USD", "desktop": True, "mobile": True},
        {"symbol": "AMEX:GLD", "name": "Gold", "desktop": True, "mobile": False},
        {"symbol": "NASDAQ:SOXX", "name": "Semiconductors", "desktop": True, "mobile": False},
    ],
}


def validate_settings(data):
    """Return a canonical config, rejecting invalid or ambiguous device lists."""
    if not isinstance(data, dict) or type(data.get("enabled")) is not bool or type(data.get("charts")) is not bool:
        raise ValueError("Ticker visibility and chart preferences must be booleans.")
    instruments = data.get("instruments")
    if not isinstance(instruments, list) or len(instruments) > MAX_INSTRUMENTS:
        raise ValueError(f"Choose up to {MAX_INSTRUMENTS} instruments.")
    result, seen = [], set()
    for item in instruments:
        if not isinstance(item, dict):
            raise ValueError("Each instrument must include a symbol and display name.")
        symbol, name = item.get("symbol"), item.get("name")
        if not isinstance(symbol, str) or not isinstance(name, str):
            raise ValueError("Each instrument must include a symbol and display name.")
        symbol, name = symbol.strip().upper(), name.strip()
        if len(symbol) > 100 or not SYMBOL_PATTERN.fullmatch(symbol):
            raise ValueError("Use a TradingView symbol such as NASDAQ:AAPL.")
        if not name or len(name) > 50:
            raise ValueError("Display names must contain between 1 and 50 characters.")
        if symbol in seen:
            raise ValueError("Each symbol may appear only once.")
        if type(item.get("desktop")) is not bool or type(item.get("mobile")) is not bool:
            raise ValueError("Select desktop and mobile visibility for each instrument.")
        seen.add(symbol)
        result.append({"symbol": symbol, "name": name, "desktop": item["desktop"], "mobile": item["mobile"]})
    if data["enabled"] and (not any(item["desktop"] for item in result) or not any(item["mobile"] for item in result)):
        raise ValueError("Select at least one desktop and one mobile instrument, or turn the ticker off.")
    return {"enabled": data["enabled"], "charts": data["charts"], "instruments": result}


def get_settings():
    with get_connection() as conn:
        row = conn.execute("SELECT value FROM settings WHERE key = ?", (SETTING_KEY,)).fetchone()
    if row:
        try:
            return validate_settings(json.loads(row["value"]))
        except (ValueError, TypeError):
            pass
    return copy.deepcopy(DEFAULTS)


def save_settings(data):
    config = validate_settings(data)
    value = json.dumps(config)
    with get_connection() as conn:
        conn.execute("""
            INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
        """, (SETTING_KEY, value))
    return config
