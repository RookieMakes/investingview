"""Dated issuer holdings snapshots for the Scanner ETF Holdings board."""

import csv
import io
import logging
import math
from datetime import datetime
from zoneinfo import ZoneInfo

import requests
from openpyxl import load_workbook

from models.db import get_connection

log = logging.getLogger(__name__)

ETFS = {
    "XDIV.TO": {
        "name": "iShares Core MSCI Canadian Quality Dividend Index ETF",
        "issuer": "BlackRock",
        "format": "blackrock_csv",
        "minimum_holdings": 15,
        "url": "https://www.blackrock.com/ca/investors/en/products/287823/fund/1464253357814.ajax?fileType=csv&fileName=XDIV_holdings&dataType=fund",
    },
    "SPY": {
        "name": "State Street SPDR S&P 500 ETF Trust",
        "issuer": "State Street",
        "format": "ssga_xlsx",
        "minimum_holdings": 480,
        "url": "https://www.ssga.com/library-content/products/fund-data/etfs/us/holdings-daily-us-en-spy.xlsx",
    },
    "QQQ": {
        "name": "Invesco QQQ ETF",
        "issuer": "Invesco",
        "format": "invesco_json",
        "minimum_holdings": 90,
        "url": "https://dng-api.invesco.com/cache/v1/accounts/en_US/shareclasses/46090E103/holdings/fund?idType=cusip&productType=ETF",
    },
    "SOXX": {
        "name": "iShares Semiconductor ETF",
        "issuer": "BlackRock",
        "format": "blackrock_csv",
        "minimum_holdings": 25,
        "url": "https://www.blackrock.com/us/individual/products/239705/ishares-semiconductor-etf/latest-holdings.csv",
    },
    "ARKK": {
        "name": "ARK Innovation ETF",
        "issuer": "ARK Invest",
        "format": "ark_csv",
        "minimum_holdings": 30,
        "url": "https://assets.ark-funds.com/fund-documents/funds-etf-csv/ARK_INNOVATION_ETF_ARKK_HOLDINGS.csv",
    },
    "DYNF": {
        "name": "iShares U.S. Equity Factor Rotation Active ETF",
        "issuer": "BlackRock",
        "format": "blackrock_csv",
        "minimum_holdings": 150,
        "url": "https://www.ishares.com/us/products/307283/blackrock-u-s-equity-factor-rotation-etf/latest-holdings.csv",
    },
    "DIVO": {
        "name": "Amplify CWP Enhanced Dividend Income ETF",
        "issuer": "Amplify ETFs",
        "format": "amplify_firestore",
        "minimum_holdings": 20,
        "minimum_weight": 90,  # Cash, SOFR, and covered-call positions are omitted.
        "url": "https://firestore.googleapis.com/v1/projects/amplify-etfs-data-feed/databases/(default)/documents/funds/DIVO/holdings?pageSize=1&orderBy=__name__%20desc",
    },
}


def _parse_shares(value):
    """Keep fractional units; missing/invalid issuer quantities must never become zero."""
    if value is None or isinstance(value, bool):
        raise ValueError("Missing or invalid shares held")
    try:
        shares = float(str(value).strip().replace(",", ""))
    except (TypeError, ValueError) as exc:
        raise ValueError("Missing or invalid shares held") from exc
    if not math.isfinite(shares) or shares < 0:
        raise ValueError("Invalid shares held")
    return shares


def _validate_holdings(published, holdings, etf):
    if published > datetime.now(ZoneInfo("America/New_York")).date().isoformat():
        raise ValueError("Holdings date is in the future")
    seen = set()
    for holding in holdings:
        ticker = holding["ticker"]
        weight = holding["weight"]
        if (not ticker or ticker in seen or not holding["name"]
                or not math.isfinite(weight) or weight <= 0):
            raise ValueError("Invalid or duplicate equity holding")
        seen.add(ticker)
    if (len(holdings) < ETFS[etf]["minimum_holdings"]
            or not ETFS[etf].get("minimum_weight", 95) <= sum(h["weight"] for h in holdings) <= 102):
        raise ValueError(f"Incomplete {etf} equity holdings")
    # Issuers already order equal-weight positions by their underlying values.
    # Keep their published order rather than arbitrarily alphabetizing ties.
    holdings.sort(key=lambda item: -item["weight"])
    for rank, holding in enumerate(holdings, 1):
        holding["rank"] = rank
    return published, holdings


def parse_blackrock_csv(text, etf="XDIV.TO"):
    """Reject incomplete/unexpected downloads rather than replacing a good snapshot."""
    lines = text.lstrip("\ufeff").splitlines()
    if not lines:
        raise ValueError("Empty holdings file")
    dates = [row[1] for line in lines[:12]
             if (row := next(csv.reader([line]), [])) and len(row) >= 2
             and row[0].strip() == "Fund Holdings as of"]
    if len(dates) != 1:
        raise ValueError("Missing BlackRock holdings date")
    published = datetime.strptime(dates[0].strip(), "%b %d, %Y").date().isoformat()

    start = next((i for i, line in enumerate(lines) if line.startswith("Ticker,Name,Sector,Asset Class,")), None)
    if start is None:
        raise ValueError("Missing BlackRock holdings columns")
    reader = csv.DictReader(io.StringIO("\n".join(lines[start:])))
    holdings = []
    for row in reader:
        if not row.get("Ticker") or not row["Ticker"].strip():
            continue  # BlackRock's trailing non-breaking-space line
        if row.get("Asset Class") != "Equity":
            continue  # Cash, collateral, and derivatives are not stock holdings
        ticker = row["Ticker"].strip()
        name = (row.get("Name") or "").strip()
        sector = (row.get("Sector") or "").strip()
        weight = float((row.get("Weight (%)") or "").replace(",", ""))
        if etf == "DYNF" and (weight == 0 or ticker == "-"):
            continue  # BlackRock lists tiny residual positions at rounded 0.00%.
        if not sector:
            raise ValueError("Missing equity sector")
        shares = _parse_shares(row.get("Shares") if "Shares" in row else row.get("Quantity"))
        holdings.append({"ticker": ticker, "name": name, "sector": sector, "weight": weight, "shares": shares})
    return _validate_holdings(published, holdings, etf)


def parse_ssga_xlsx(content):
    """State Street's SPY workbook has fund metadata, then holdings, then footnotes."""
    workbook = load_workbook(io.BytesIO(content), read_only=True, data_only=True)
    try:
        sheet = workbook["holdings"]
        rows = sheet.values
        _, ticker, as_of, _, columns = (next(rows) for _ in range(5))
        if (ticker[:2] != ("Ticker Symbol:", "SPY") or as_of[0] != "Holdings:"
                or columns[:7] != ("Name", "Ticker", "Identifier", "SEDOL", "Weight", "Sector", "Shares Held")):
            raise ValueError("Unexpected State Street holdings format")
        published = datetime.strptime(as_of[1].strip(), "As of %d-%b-%Y").date().isoformat()
        holdings = []
        for row in rows:
            if row[0] is None:
                break  # Disclosures after the holdings table
            name, symbol, identifier, _, weight, sector = row[:6]
            # SPY's workbook also includes a contingent-value right (CVR),
            # which is not an equity; zero-weight warrants are omitted below.
            if identifier and "CVR" in str(identifier).upper():
                continue
            if symbol and isinstance(weight, (int, float)) and weight > 0:
                holdings.append({"ticker": str(symbol).strip(), "name": str(name).strip(),
                                 "sector": sector or "-", "weight": float(weight),
                                 "shares": _parse_shares(row[6])})
    finally:
        workbook.close()
    return _validate_holdings(published, holdings, "SPY")


def parse_invesco_json(data):
    """Invesco's QQQ API includes cash and futures alongside equity holdings."""
    if data.get("cusip") != "46090E103" or not isinstance(data.get("holdings"), list):
        raise ValueError("Unexpected Invesco holdings response")
    published = datetime.strptime(data["effectiveDate"], "%Y-%m-%d").date().isoformat()
    holdings = []
    for row in data["holdings"]:
        if row.get("securityTypeCode") not in {"COM", "ADR", "DRNY"}:
            continue
        holdings.append({"ticker": (row.get("ticker") or "").strip(),
                         "name": (row.get("issuerName") or "").strip(), "sector": "-",
                         "weight": float(row["percentageOfTotalNetAssets"]),
                         "shares": _parse_shares(row.get("units"))})
    return _validate_holdings(published, holdings, "QQQ")


def parse_ark_csv(text):
    """ARK publishes private positions without tickers; keep their CUSIPs for history."""
    reader = csv.DictReader(io.StringIO(text.lstrip("\ufeff")))
    if not reader.fieldnames or reader.fieldnames[:5] != ["date", "fund", "company", "ticker", "cusip"]:
        raise ValueError("Unexpected ARK holdings columns")
    holdings = []
    dates = set()
    for row in reader:
        if row.get("fund") != "ARKK":
            continue  # Footer and other funds must not enter this snapshot.
        dates.add(datetime.strptime(row["date"], "%m/%d/%Y").date().isoformat())
        name = (row.get("company") or "").strip()
        ticker = (row.get("ticker") or "").strip()
        cusip = (row.get("cusip") or "").strip()
        if not ticker:
            if not cusip.startswith("PP"):  # Exclude unlisted warrants and money market cash.
                continue
            ticker = f"PRIVATE:{cusip}"
        elif ticker.endswith(" UQ"):
            ticker = ticker[:-3]  # Bloomberg's UQ exchange suffix is not part of the ticker.
        weight = float((row.get("weight (%)") or "").strip().rstrip("%"))
        holdings.append({"ticker": ticker, "name": name, "sector": "-", "weight": weight,
                         "shares": _parse_shares(row.get("shares"))})
    if len(dates) != 1:
        raise ValueError("Missing or inconsistent ARK holdings date")
    return _validate_holdings(dates.pop(), holdings, "ARKK")


def _firestore_value(value):
    """Decode Firestore's public REST representation used by Amplify's site."""
    if "stringValue" in value:
        return value["stringValue"]
    if "doubleValue" in value:
        return float(value["doubleValue"])
    if "integerValue" in value:
        return int(value["integerValue"])
    if "booleanValue" in value:
        return value["booleanValue"]
    if "nullValue" in value:
        return None
    if "mapValue" in value:
        return {key: _firestore_value(field) for key, field in value["mapValue"].get("fields", {}).items()}
    if "arrayValue" in value:
        return [_firestore_value(item) for item in value["arrayValue"].get("values", [])]
    raise ValueError("Unknown Amplify holdings field type")


def parse_amplify_firestore(data):
    """Read the same latest dated DIVO document as Amplify's holdings page."""
    documents = data.get("documents", [])
    if len(documents) != 1:
        raise ValueError("Missing latest Amplify holdings document")
    document = documents[0]
    prefix = "projects/amplify-etfs-data-feed/databases/(default)/documents/funds/DIVO/holdings/"
    if not document.get("name", "").startswith(prefix):
        raise ValueError("Unexpected Amplify holdings document")
    published = datetime.strptime(document["name"][len(prefix):], "%Y-%m-%d").date().isoformat()
    fields = {key: _firestore_value(field) for key, field in document.get("fields", {}).items()}
    if fields.get("asOfDate") != published or not isinstance(fields.get("holdings"), list):
        raise ValueError("Inconsistent Amplify holdings date")
    holdings = []
    for row in fields["holdings"]:
        if row.get("holding_type") != "equity":
            continue  # Covered calls, SOFR, money market, and cash are not ranked.
        raw_weight = row.get("Weightings")
        if not isinstance(raw_weight, str) or not raw_weight.endswith("%"):
            raise ValueError("Unexpected Amplify holdings weight")
        weight = float(raw_weight.rstrip("%"))
        if weight == 0:
            continue  # Amplify also lists residual positions rounded to 0.00%.
        holdings.append({"ticker": str(row.get("StockTicker") or "").strip(),
                         "name": str(row.get("SecurityName") or "").strip(), "sector": "-",
                         "weight": weight, "shares": _parse_shares(row.get("Shares"))})
    return _validate_holdings(published, holdings, "DIVO")


def refresh_holdings(etf="XDIV.TO"):
    """Fetch and atomically save a new issuer date; repeated runs are idempotent."""
    if etf not in ETFS:
        raise ValueError("Unsupported ETF")
    response = requests.get(ETFS[etf]["url"], timeout=30, headers={"User-Agent": "InvestingView/1.0"})
    response.raise_for_status()
    kind = ETFS[etf]["format"]
    if kind == "blackrock_csv":
        published, holdings = parse_blackrock_csv(response.text, etf)
    elif kind == "ssga_xlsx":
        published, holdings = parse_ssga_xlsx(response.content)
    elif kind == "invesco_json":
        published, holdings = parse_invesco_json(response.json())
    elif kind == "ark_csv":
        published, holdings = parse_ark_csv(response.text)
    elif kind == "amplify_firestore":
        published, holdings = parse_amplify_firestore(response.json())
    else:
        raise ValueError("Unsupported ETF holdings format")
    with get_connection() as conn:
        latest = conn.execute(
            "SELECT MAX(date) FROM etf_holding_snapshots WHERE etf = ?", (etf,)
        ).fetchone()[0]
        if published == latest:
            # Enrich the current pre-upgrade snapshot if the issuer still publishes
            # that date. Never rewrite its ranks/weights or invent earlier quantities.
            cursor = conn.executemany(
                "UPDATE etf_holding_snapshots SET shares = ? "
                "WHERE etf = ? AND date = ? AND ticker = ? AND shares IS NULL",
                [(h["shares"], etf, published, h["ticker"]) for h in holdings],
            )
            return {"status": "enriched" if cursor.rowcount else "unchanged", "date": latest}
        if latest is not None and published < latest:
            return {"status": "unchanged", "date": latest}
        conn.executemany(
            "INSERT INTO etf_holding_snapshots (etf, date, ticker, name, sector, weight, shares, rank) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [(etf, published, h["ticker"], h["name"], h["sector"], h["weight"], h["shares"], h["rank"])
             for h in holdings],
        )
    log.info("ETF holdings saved: %s %s (%d equities)", etf, published, len(holdings))
    return {"status": "updated", "date": published, "count": len(holdings)}


def get_holdings(etf="XDIV.TO", limit=15):
    if etf not in ETFS:
        raise ValueError("Unsupported ETF")
    with get_connection() as conn:
        dates = conn.execute(
            "SELECT DISTINCT date FROM etf_holding_snapshots WHERE etf = ? ORDER BY date DESC LIMIT 2", (etf,)
        ).fetchall()
        if not dates:
            return {"etf": etf, "name": ETFS[etf]["name"], "issuer": ETFS[etf]["issuer"], "as_of": None,
                    "previous_as_of": None, "holdings": []}
        current_date = dates[0]["date"]
        previous_date = dates[1]["date"] if len(dates) > 1 else None
        current = conn.execute(
            "SELECT ticker, name, sector, weight, shares, rank FROM etf_holding_snapshots "
            "WHERE etf = ? AND date = ? ORDER BY rank LIMIT ?", (etf, current_date, limit),
        ).fetchall()
        previous = {}
        if previous_date:
            previous = {row["ticker"]: row for row in conn.execute(
                "SELECT ticker, rank, weight, shares FROM etf_holding_snapshots WHERE etf = ? AND date = ?",
                (etf, previous_date),
            ).fetchall()}

    holdings = []
    for row in current:
        prior = previous.get(row["ticker"])
        holdings.append({
            "ticker": row["ticker"], "name": row["name"], "sector": row["sector"],
            "weight": row["weight"], "rank": row["rank"],
            "previous_rank": prior["rank"] if prior else None,
            "rank_change": prior["rank"] - row["rank"] if prior else None,
            "previous_weight": prior["weight"] if prior else None,
            "weight_change": row["weight"] - prior["weight"] if prior else None,
            "shares": row["shares"],
            "previous_shares": prior["shares"] if prior else None,
            "shares_change": (row["shares"] - prior["shares"]
                              if prior and prior["shares"] is not None and row["shares"] is not None else None),
        })
    return {"etf": etf, "name": ETFS[etf]["name"], "issuer": ETFS[etf]["issuer"], "as_of": current_date,
            "previous_as_of": previous_date, "holdings": holdings}


def get_holdings_history(etf, ticker):
    if etf not in ETFS:
        raise ValueError("Unsupported ETF")
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT date, weight, shares, rank FROM etf_holding_snapshots "
            "WHERE etf = ? AND ticker = ? ORDER BY date", (etf, ticker),
        ).fetchall()
    return {"etf": etf, "ticker": ticker,
             "snapshots": [{"date": row["date"], "weight": row["weight"], "shares": row["shares"], "rank": row["rank"]}
                          for row in rows]}
