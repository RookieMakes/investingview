"""Trading-day totals must use the full portfolio ledger, not transaction pages."""

from datetime import date, timedelta

import pytest
from flask import Flask

from models import db as database
from routes import transaction_routes as routes


@pytest.fixture
def client(tmp_path, monkeypatch):
    class Today(date):
        @classmethod
        def today(cls):
            return cls(2026, 10, 20)

    monkeypatch.setattr(routes, "date", Today)
    monkeypatch.setattr(database, "DATABASE_PATH", str(tmp_path / "activity.db"))
    database.init_db()
    with database.get_connection() as conn:
        conn.execute("INSERT INTO portfolios (id, name) VALUES (1, 'Main'), (2, 'Other')")
    app = Flask(__name__)
    app.register_blueprint(routes.transaction_bp)
    app.config["TESTING"] = True
    return app.test_client()


def insert(day, kind="BUY", portfolio=1, ticker="AAPL"):
    with database.get_connection() as conn:
        conn.execute(
            "INSERT INTO transactions (portfolio_id, ticker, type, qty, price, total, date) "
            "VALUES (?, ?, ?, 1, 100, 100, ?)", (portfolio, ticker, kind, day),
        )


def activity(client, year=None, portfolio=1):
    suffix = f"?year={year}" if year else ""
    response = client.get(f"/api/portfolio/{portfolio}/trading-activity{suffix}")
    assert response.status_code == 200
    return response.get_json()


def test_unique_days_both_sides_tickers_and_portfolio_scope(client):
    insert("2026-01-01")
    insert("2026-01-01", "SELL")
    insert("2026-01-01", ticker="MSFT")
    insert("2026-01-31")
    insert("2026-02-01", "SELL")
    insert("2026-03-01", portfolio=2)
    result = activity(client)
    assert result["year"] == 2026
    assert result["year_total"] == 3
    assert result["monthly_totals"] == [2, 1] + [0] * 10
    assert result["days"]["2026-01-01"] == {"buys": 2, "sells": 1}
    assert activity(client, portfolio=2)["year_total"] == 1


def test_complete_history_beyond_transaction_page_cap(client):
    start = date(2025, 1, 1)
    with database.get_connection() as conn:
        conn.executemany(
            "INSERT INTO transactions (portfolio_id, ticker, type, qty, price, total, date) "
            "VALUES (1, 'AAPL', 'BUY', 1, 100, 100, ?)",
            [((start + timedelta(days=i)).isoformat(),) for i in range(250)],
        )
    insert("2024-12-31")
    result = activity(client)
    assert result["year"] == 2025
    assert result["min_year"] == 2024 and result["max_year"] == 2026
    assert result["year_total"] == len(result["days"]) == 250
    assert result["monthly_totals"][0] == 31
    assert activity(client, 2024)["year_total"] == 1
    assert activity(client, 2026)["year_total"] == 0


def test_leap_dates_and_invalid_legacy_dates(client):
    for day in ["2024-02-29", "2024-12-31", "2025-01-01", "2025-02-29", "2026-02-30", "bad"]:
        insert(day)
    assert activity(client, 2024)["monthly_totals"][1] == 1
    assert activity(client, 2024)["year_total"] == 2
    assert activity(client, 2025)["year_total"] == 1
    assert activity(client, 2026)["year_total"] == 0


def test_empty_portfolio_and_invalid_request(client):
    result = activity(client)
    assert result["year"] == result["min_year"] == result["max_year"] == 2026
    assert result["year_total"] == 0 and result["monthly_totals"] == [0] * 12
    assert client.get("/api/portfolio/999/trading-activity").status_code == 404
    for value in ["abc", "2026.5", "1899", "2101", ""]:
        assert client.get(f"/api/portfolio/1/trading-activity?year={value}").status_code == 400


def test_activity_reflects_create_date_edit_and_delete(client):
    body = {"ticker": "AAPL", "type": "BUY", "qty": 1, "price": 100, "date": "2026-01-01"}
    response = client.post("/api/portfolio/1/transactions", json=body)
    assert response.status_code == 201
    url = f"/api/portfolio/1/transactions/{response.get_json()['id']}"
    assert activity(client)["monthly_totals"][0] == 1
    assert client.put(url, json={"date": "2025-12-31"}).status_code == 200
    assert activity(client, 2026)["year_total"] == 0
    assert activity(client, 2025)["monthly_totals"][11] == 1
    assert client.delete(url).status_code == 200
    assert activity(client)["year_total"] == 0
