"""
schema.py — Table definitions for all InvestingView tables.

Each entry in CREATE_TABLES is a self-contained CREATE TABLE IF NOT EXISTS
statement. Order matters only for foreign key dependencies; here most are
independent, so the list is organized by domain for readability.
"""

CREATE_TABLES = [
    # ── Universe ──────────────────────────────────────────────────────
    """
    CREATE TABLE IF NOT EXISTS universe (
        ticker TEXT PRIMARY KEY,
        company_name TEXT,
        source TEXT CHECK(source IN ('default', 'custom')),
        sector TEXT,
        added_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    """,

    # ── Quotes (real-time price snapshot) ─────────────────────────────
    """
    CREATE TABLE IF NOT EXISTS quotes (
        ticker TEXT PRIMARY KEY,
        price REAL,
        change_pct REAL,
        volume INTEGER,
        avg_volume_30d INTEGER,
        market_state TEXT,
        fetched_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    """,

    # ── Candles (OHLCV historical data) ──────────────────────────────
    """
    CREATE TABLE IF NOT EXISTS candles (
        ticker TEXT,
        date TEXT,
        open REAL,
        high REAL,
        low REAL,
        close REAL,
        volume INTEGER,
        PRIMARY KEY (ticker, date)
    );
    """,

    # ── Support / Resistance levels ──────────────────────────────────
    """
    CREATE TABLE IF NOT EXISTS sr_levels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticker TEXT NOT NULL,
        price REAL NOT NULL,
        type TEXT CHECK(type IN ('support', 'resistance')),
        strength INTEGER DEFAULT 1,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    """,

    # ── S/R alert log ────────────────────────────────────────────────
    """
    CREATE TABLE IF NOT EXISTS sr_alert_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticker TEXT NOT NULL,
        sr_price REAL NOT NULL,
        sr_type TEXT NOT NULL,
        pattern TEXT CHECK(pattern IN ('A', 'B', 'C', 'D')),
        alerted_date TEXT NOT NULL,
        alerted_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    """,

    # ── Portfolios ───────────────────────────────────────────────────
    """
    CREATE TABLE IF NOT EXISTS portfolios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        currency TEXT DEFAULT 'USD',
        sort_order INTEGER NOT NULL DEFAULT 0,
        cash_cents INTEGER NOT NULL DEFAULT 0 CHECK (cash_cents >= 0),
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    """,

    # ── Positions (portfolio holdings) ───────────────────────────────
    """
    CREATE TABLE IF NOT EXISTS positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        portfolio_id INTEGER REFERENCES portfolios(id),
        ticker TEXT NOT NULL,
        qty REAL NOT NULL,
        avg_price REAL NOT NULL,
        total_investment REAL NOT NULL DEFAULT 0,
        notes TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    """,

    # ── Portfolio trailing stops (one current cycle per holding) ─────
    """
    CREATE TABLE IF NOT EXISTS trailing_stops (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        portfolio_id INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
        position_id INTEGER NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
        ticker TEXT NOT NULL,
        initial_stop REAL NOT NULL CHECK(initial_stop > 0),
        reference_close REAL NOT NULL,
        reference_date TEXT NOT NULL,
        trail_amount REAL NOT NULL CHECK(trail_amount > 0),
        stop_price REAL NOT NULL CHECK(stop_price > 0),
        state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active', 'hit')),
        cycle INTEGER NOT NULL DEFAULT 1,
        activated_at TEXT NOT NULL,
        eligible_from TEXT NOT NULL,
        last_processed_date TEXT,
        hit_date TEXT,
        hit_open REAL,
        hit_high REAL,
        hit_low REAL,
        hit_close REAL,
        hit_at TEXT,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(portfolio_id, ticker)
    );
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_trailing_stops_active ON trailing_stops(state, ticker);
    """,

    # ── Transactions (portfolio trade log) ───────────────────────────
    """
    CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        portfolio_id INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
        ticker TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('BUY', 'SELL')),
        qty REAL NOT NULL,
        price REAL NOT NULL,
        total REAL NOT NULL,
        date TEXT NOT NULL,
        notes TEXT DEFAULT '',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_transactions_portfolio ON transactions(portfolio_id);
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_transactions_ticker ON transactions(ticker);
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date DESC);
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(type);
    """,

    # Immutable Portfolio sell-time snapshots; ledger corrections are independent.
    """
    CREATE TABLE IF NOT EXISTS realized_trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        transaction_id INTEGER UNIQUE REFERENCES transactions(id) ON DELETE SET NULL,
        portfolio_id INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
        ticker TEXT NOT NULL,
        sell_date TEXT NOT NULL,
        qty_before_sale REAL NOT NULL,
        avg_buy_price REAL NOT NULL,
        qty_sold REAL NOT NULL,
        sell_price REAL NOT NULL,
        cost_basis REAL NOT NULL,
        sale_proceeds REAL NOT NULL,
        realized_pnl REAL NOT NULL,
        realized_pnl_pct REAL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_realized_trades_portfolio_date
    ON realized_trades(portfolio_id, sell_date DESC, id DESC);
    """,

    # ── Portfolio P/L snapshots ───────────────────────────────────────
    """
    CREATE TABLE IF NOT EXISTS portfolio_pnl_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        portfolio_id INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
        date TEXT NOT NULL,
        pnl REAL NOT NULL,
        market_value REAL NOT NULL,
        cost_basis REAL NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(portfolio_id, date)
    );
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_pnl_snapshots_portfolio ON portfolio_pnl_snapshots(portfolio_id);
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_pnl_snapshots_date ON portfolio_pnl_snapshots(date DESC);
    """,

    # ── Position P/L snapshots ───────────────────────────────────────
    """
    CREATE TABLE IF NOT EXISTS position_pnl_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        portfolio_id INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
        ticker TEXT NOT NULL,
        date TEXT NOT NULL,
        pnl REAL NOT NULL,
        market_value REAL NOT NULL,
        cost_basis REAL NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(portfolio_id, ticker, date)
    );
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_pos_pnl_portfolio_ticker ON position_pnl_snapshots(portfolio_id, ticker);
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_pos_pnl_date ON position_pnl_snapshots(date DESC);
    """,

    # ── Alerts ───────────────────────────────────────────────────────
    """
    CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticker TEXT NOT NULL,
        type TEXT CHECK(type IN ('price_above', 'price_below', 'vol_spike', 'sr_touch')),
        threshold REAL,
        multiplier REAL,
        watchlist TEXT,
        armed INTEGER DEFAULT 1,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    """,

    # ── Alert history ────────────────────────────────────────────────
    """
    CREATE TABLE IF NOT EXISTS alert_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        alert_id INTEGER REFERENCES alerts(id),
        ticker TEXT NOT NULL,
        type TEXT NOT NULL,
        message TEXT,
        channel TEXT,
        event_key TEXT,
        fired_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    """,

    # ── Scan results ─────────────────────────────────────────────────
    """
    CREATE TABLE IF NOT EXISTS scan_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scan_type TEXT CHECK(scan_type IN ('momentum', 'reversal')),
        ticker TEXT NOT NULL,
        score INTEGER,
        conviction TEXT,
        criteria_json TEXT,
        scanned_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    """,

    # ── Rankings (persistent scanner leaderboard) ────────────────────
    """
    CREATE TABLE IF NOT EXISTS rankings (
        scan_type TEXT NOT NULL,
        ticker TEXT NOT NULL,
        company TEXT,
        sector TEXT,
        conviction TEXT,
        scan_score INTEGER,
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        days_on_board INTEGER DEFAULT 1,
        qualified_streak INTEGER DEFAULT 0,
        last_qualified_date TEXT,
        tie_breaker REAL DEFAULT 0,
        rank_score REAL DEFAULT 0,
        current_rank INTEGER DEFAULT 0,
        exit_date TEXT,
        previous_rank INTEGER,
        trend_updated_at TEXT,
        PRIMARY KEY (scan_type, ticker)
    );
    """,

    # One row per scanner tracks successful sessions and once-per-day snapshots.
    """
    CREATE TABLE IF NOT EXISTS scanner_sessions (
        scan_type TEXT PRIMARY KEY,
        last_session TEXT,
        snapshot_session TEXT,
        last_completed_at TEXT
    );
    """,

    # ── Signals ──────────────────────────────────────────────────────
    """
    CREATE TABLE IF NOT EXISTS signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scan_type TEXT NOT NULL,
        signal_date TEXT NOT NULL,
        ticker TEXT NOT NULL,
        conviction TEXT,
        score INTEGER,
        price_at_signal REAL,
        criteria_json TEXT,
        UNIQUE (scan_type, signal_date, ticker)
    );
    """,

    # ── Signal returns (back-test tracking) ──────────────────────────
    """
    CREATE TABLE IF NOT EXISTS signal_returns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        signal_id INTEGER REFERENCES signals(id),
        day_offset INTEGER NOT NULL,
        price REAL,
        pct_return REAL,
        fetched_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (signal_id, day_offset)
    );
    """,

    # ── Settings (key-value store) ───────────────────────────────────
    """
    CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    """,

    # ── Tabs config (chart tab persistence) ──────────────────────────
    """
    CREATE TABLE IF NOT EXISTS tabs_config (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        data TEXT NOT NULL
    );
    """,

    # ── Auto-generated S/R levels ────────────────────────────────────
    """
    CREATE TABLE IF NOT EXISTS auto_sr_levels (
        ticker TEXT PRIMARY KEY,
        r1_price REAL,
        s1_price REAL,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    """,

    # ── Watchlists ───────────────────────────────────────────────────
    """
    CREATE TABLE IF NOT EXISTS watchlists (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    """,

    # ── Watchlist tickers ────────────────────────────────────────────
    """
    CREATE TABLE IF NOT EXISTS watchlist_tickers (
        watchlist_id TEXT NOT NULL,
        ticker TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        added_at TEXT DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (watchlist_id, ticker),
        FOREIGN KEY (watchlist_id) REFERENCES watchlists(id) ON DELETE CASCADE
    );
    """,

    # ── User preferences (key-value store) ───────────────────────────
    """
    CREATE TABLE IF NOT EXISTS user_prefs (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
    """,

    # ════════════════════════════════════════════════════════════════════
    # DASHBOARD — Earnings Momentum feature tables
    # These mirror the reference project schema for the dashboard API.
    # ════════════════════════════════════════════════════════════════════

    # ── Dashboard stocks ──────────────────────────────────────────────
    """
    CREATE TABLE IF NOT EXISTS dash_stocks (
        symbol TEXT PRIMARY KEY,
        name TEXT,
        sector TEXT
    );
    """,

    # ── Dashboard price data ──────────────────────────────────────────
    """
    CREATE TABLE IF NOT EXISTS dash_prices (
        symbol TEXT,
        date TEXT,
        open REAL,
        high REAL,
        low REAL,
        close REAL,
        volume INTEGER,
        pct_change REAL,
        PRIMARY KEY (symbol, date)
    );
    """,

    # ── Dashboard earnings dates ──────────────────────────────────────
    """
    CREATE TABLE IF NOT EXISTS dash_earnings (
        symbol TEXT PRIMARY KEY,
        earnings_date TEXT,
        days_to_earnings INTEGER
    );
    """,

    # ── Quarterly earnings history (EPS beat/miss) ────────────────────
    """
    CREATE TABLE IF NOT EXISTS quarterly_earnings (
        symbol TEXT,
        earnings_date TEXT,
        eps_actual REAL,
        eps_estimate REAL,
        surprise_pct REAL,
        PRIMARY KEY (symbol, earnings_date)
    );
    """,

    # ── Historical earnings announcements (announcement-date indexed) ─
    """
    CREATE TABLE IF NOT EXISTS earnings_announcements (
        symbol TEXT,
        announcement_date TEXT,
        quarter_end_date TEXT,
        eps_actual REAL,
        eps_estimate REAL,
        surprise_pct REAL,
        PRIMARY KEY (symbol, announcement_date)
    );
    """,

    # ── Dashboard momentum scores ─────────────────────────────────────
    """
    CREATE TABLE IF NOT EXISTS dash_momentum (
        symbol TEXT PRIMARY KEY,
        rank_score INTEGER,
        streak INTEGER,
        last_updated TEXT,
        sp500_rs REAL
    );
    """,

    # ── Dashboard last fetch timestamp ────────────────────────────────
    """
    CREATE TABLE IF NOT EXISTS dash_last_fetch (
        id INTEGER PRIMARY KEY,
        fetched_at TEXT
    );
    """,

    # ── Trade Analysis History ──────────────────────────────────────
    """
    CREATE TABLE IF NOT EXISTS trade_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticker TEXT NOT NULL,
        company TEXT,
        trade_type TEXT CHECK(trade_type IN ('swing', 'position')),
        verdict TEXT CHECK(verdict IN ('YES', 'WATCH', 'NO')),
        score INTEGER NOT NULL,
        max_score INTEGER NOT NULL,
        target_price REAL,
        upside_pct REAL,
        sector TEXT,
        analyzed_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_trade_history_ticker ON trade_history(ticker);
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_trade_history_date ON trade_history(analyzed_at DESC);
    """,

    # ── 200 SMA Proximity Scan ─────────────────────────────────────────
    """
    CREATE TABLE IF NOT EXISTS sma200_scan (
        ticker TEXT PRIMARY KEY,
        sma_200 REAL,
        price REAL,
        pct_from_sma REAL,
        above_sma INTEGER,
        scanned_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    """,

    # ── YTD Return Scan ────────────────────────────────────────────────
    """
    CREATE TABLE IF NOT EXISTS ytd_scan (
        ticker TEXT PRIMARY KEY,
        ytd_pct REAL,
        price REAL,
        year_start_close REAL,
        scanned_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    """,

    # ── YTD Scan Snapshots (daily history) ────────────────────────────
    """
    CREATE TABLE IF NOT EXISTS ytd_scan_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticker TEXT NOT NULL,
        date TEXT NOT NULL,
        ytd_pct REAL NOT NULL,
        price REAL NOT NULL,
        rank INTEGER,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(ticker, date)
    );
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_ytd_snap_ticker ON ytd_scan_snapshots(ticker);
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_ytd_snap_date ON ytd_scan_snapshots(date DESC);
    """,

    # ── ETF holdings: dated rank, weight and shares-held history ──
    """
    CREATE TABLE IF NOT EXISTS etf_holding_snapshots (
        etf TEXT NOT NULL,
        date TEXT NOT NULL,
        ticker TEXT NOT NULL,
        name TEXT NOT NULL,
        sector TEXT NOT NULL,
        weight REAL NOT NULL,
        shares REAL,
        rank INTEGER NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (etf, date, ticker)
    );
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_etf_holdings_latest ON etf_holding_snapshots(etf, date DESC, rank);
    """,

    # ── Quality Score Scan ─────────────────────────────────────────────
    """
    CREATE TABLE IF NOT EXISTS quality_score_scan (
        ticker TEXT PRIMARY KEY,
        score REAL,
        momentum_12_1 REAL,
        r_1m REAL,
        r_3m REAL,
        r_6m REAL,
        r_12m REAL,
        sigma_raw REAL,
        sigma_1y REAL,
        price REAL,
        insufficient_data INTEGER DEFAULT 0,
        scanned_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    """,

    # ── Quality Score Scan Snapshots (daily history) ───────────────────
    """
    CREATE TABLE IF NOT EXISTS quality_score_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticker TEXT NOT NULL,
        date TEXT NOT NULL,
        score REAL NOT NULL,
        price REAL NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(ticker, date)
    );
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_qs_snap_ticker ON quality_score_snapshots(ticker);
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_qs_snap_date ON quality_score_snapshots(date DESC);
    """,

    # ── Volume profile (EOD POC/VAH/VAL, 3m + 6m, latest-only) ──
    """
    CREATE TABLE IF NOT EXISTS volume_profile (
        ticker TEXT NOT NULL,
        range TEXT NOT NULL DEFAULT '3m',
        poc REAL,
        vah REAL,
        val REAL,
        max_volume REAL,
        total_volume REAL,
        step REAL,
        grid_min REAL,
        grid_max REAL,
        value_area_coverage REAL,
        stable INTEGER DEFAULT 1,
        poc_spread REAL,
        session_date TEXT,
        candle_count INTEGER,
        insufficient_data INTEGER DEFAULT 0,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (ticker, range)
    );
    """,

    # ── ORB breakout (Trade tab: 09:30-09:45 range + 10:15-10:30 close) ──
    """
    CREATE TABLE IF NOT EXISTS orb_breakout (
        ticker TEXT NOT NULL,
        session_date TEXT NOT NULL,
        orb_high REAL,
        orb_low REAL,
        confirm_close REAL,
        confirm_time TEXT,
        day_high REAL,
        day_low REAL,
        last_price REAL,
        signal TEXT CHECK(signal IN ('long', 'short', 'none')),
        insufficient_data INTEGER DEFAULT 0,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (ticker, session_date)
    );
    """,

    # ── ORB checkpoint decisions (Trade tab Criteria 2: 11:35 reassessment) ──
    """
    CREATE TABLE IF NOT EXISTS orb_decisions (
        ticker TEXT NOT NULL,
        session_date TEXT NOT NULL,
        checkpoint TEXT NOT NULL CHECK(checkpoint IN ('10:30', '11:00', '11:15')),
        setup TEXT CHECK(setup IN ('continuation', 'reversal', 'none')),
        direction TEXT CHECK(direction IN ('long', 'short', 'none')),
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (ticker, session_date, checkpoint)
    );
    """,

    # ── News movers digest (EOD, 7-day history) ────────────────────────
    """
    CREATE TABLE IF NOT EXISTS news_movers (
        run_date TEXT NOT NULL,
        ticker TEXT NOT NULL,
        company TEXT,
        move_pct REAL,
        direction TEXT,
        last_price REAL,
        window TEXT DEFAULT '12h',
        PRIMARY KEY (run_date, ticker)
    );
    """,
    """
    CREATE TABLE IF NOT EXISTS news_digest (
        run_date TEXT NOT NULL,
        ticker TEXT NOT NULL,
        move_pct REAL,
        direction TEXT,
        title TEXT NOT NULL,
        link TEXT,
        published TEXT,
        outlet TEXT,
        fetched_at TEXT DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (run_date, ticker, title)
    );
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_news_digest_date ON news_digest(run_date DESC);
    """,
]
