"""Offline-only chronological Trade replay. Not imported by the running app.

Usage (CSV columns: Date, Open, High, Low, Close, Volume; consistent adjustment):
  python -m services.trade_validation prices.csv --snapshots snapshots.json

Snapshots are keyed by signal-session YYYY-MM-DD, each containing `known_at`,
`info`, and `calendar`. They must be point-in-time observations, not today's
fundamentals projected backwards. Missing snapshots remain unknown and usually
prevent entries. Optional benchmark CSV enables position RS. No network or DB.

This is fixed-rule out-of-sample execution replay, not parameter optimization.
Reported statistics describe supplied data only; they do not calibrate confidence.
"""

import argparse
import json

import pandas as pd

from services.trade_analyzer import analyze_snapshot, prepare_history, HOLD_SESSIONS, MIN_REWARD_RISK, MIN_UPSIDE


def walk_forward(hist, snapshots, trade_type="swing", benchmark=None, cost_bps=10,
                 initial_equity=10000, risk_fraction=.01, start_index=205):
    """One long position at a time, next-open fills, risk-sized without leverage.

    Stops are checked before targets on ambiguous OHLC bars. Stop gaps execute at
    the open, targets conservatively at the target. Costs apply on both sides.
    Mark-to-market drawdown is measured at each close (not intraday drawdown).
    Require a complete possible holding horizon to avoid censored final trades.
    """
    if trade_type not in HOLD_SESSIONS or not 0 <= cost_bps < 10000:
        raise ValueError("Invalid trade type or execution cost")
    if initial_equity <= 0 or not 0 < risk_fraction <= 1 or start_index < 20:
        raise ValueError("Invalid equity, risk fraction or starting index")
    if hist.empty:
        raise ValueError("Price history is required")
    hist = prepare_history(hist, pd.Timestamp(hist.index.max()) + pd.Timedelta(days=1))
    if hist.empty or hist.attrs.get("invalid_bars"):
        raise ValueError("Replay requires valid, finite OHLC history")
    benchmark = benchmark if benchmark is not None else pd.DataFrame()
    equity = peak = float(initial_equity)
    drawdown = 0.0
    trades = []
    evaluated = skipped_entries = unknown_snapshots = 0
    cost = cost_bps / 10000
    hold = HOLD_SESSIONS[trade_type]
    i = start_index - 1
    while i + hold < len(hist):
        day = hist.index[i]
        cutoff = day + pd.Timedelta(days=1)
        snapshot = snapshots.get(day.date().isoformat(), {})
        known_at = pd.Timestamp(snapshot["known_at"]) if snapshot.get("known_at") else None
        if known_at is not None and known_at.tzinfo:
            known_at = known_at.tz_convert("UTC").tz_localize(None)
        if known_at is None or known_at >= cutoff:
            snapshot = {}
            unknown_snapshots += 1
        past = hist.iloc[:i + 1]
        weekly = past.resample("W-MON", label="left", closed="left").agg(
            {"Open": "first", "High": "max", "Low": "min", "Close": "last", "Volume": "sum"}).dropna()
        report = analyze_snapshot("REPLAY", snapshot.get("info", {}), past, weekly, trade_type,
                                  calendar=snapshot.get("calendar"), as_of=cutoff, benchmark=benchmark)
        evaluated += 1
        if report["verdict"] != "YES":
            i += 1
            continue
        plan = report["trade_plan"]
        stop, target = plan["stop"], plan["target"]
        entry = float(hist["Open"].iloc[i + 1]) * (1 + cost)
        risk = entry - stop * (1 - cost)
        reward = target * (1 - cost) - entry
        # A gap can invalidate a sound close-based plan; recheck at execution.
        if not stop < entry < target or risk <= 0 or reward / risk < MIN_REWARD_RISK or reward / entry * 100 < MIN_UPSIDE[trade_type]:
            skipped_entries += 1
            i += 1
            continue
        qty = min(equity * risk_fraction / risk, equity / entry)
        cash = equity - qty * entry
        entry_day = hist.index[i + 1]
        for j in range(i + 1, i + hold + 1):
            bar = hist.iloc[j]
            exit_price, reason = None, None
            if bar["Open"] <= stop:
                exit_price, reason = float(bar["Open"]), "stop_gap"
            elif bar["Low"] <= stop:
                exit_price, reason = stop, "stop"
            elif bar["High"] >= target:
                exit_price, reason = target, "target"
            elif j == i + hold:
                exit_price, reason = float(bar["Close"]), "holding_limit"
            mark = cash + qty * (exit_price if exit_price is not None else float(bar["Close"])) * (1 - cost)
            peak = max(peak, mark)
            drawdown = max(drawdown, (peak - mark) / peak * 100)
            if exit_price is not None:
                pnl = mark - equity
                trades.append({"signal_date": day.date().isoformat(), "entry_date": entry_day.date().isoformat(),
                               "exit_date": hist.index[j].date().isoformat(), "entry": entry,
                               "exit": exit_price * (1 - cost), "reason": reason, "shares": qty,
                               "pnl": pnl, "return_pct": (exit_price * (1 - cost) / entry - 1) * 100})
                equity = mark
                i = j
                break
    wins = sum(t["pnl"] > 0 for t in trades)
    return {"trade_type": trade_type, "evaluated_sessions": evaluated, "unknown_snapshots": unknown_snapshots,
            "skipped_gap_entries": skipped_entries, "trades": trades, "trade_count": len(trades),
            "win_rate_pct": wins / len(trades) * 100 if trades else None,
            "net_return_pct": (equity / initial_equity - 1) * 100, "final_equity": equity,
            "max_close_drawdown_pct": drawdown, "cost_bps_per_side": cost_bps,
            "note": "Supplied-data replay only; point-in-time input quality and survivorship bias require independent validation."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("prices")
    parser.add_argument("--snapshots", required=True)
    parser.add_argument("--benchmark")
    parser.add_argument("--trade-type", choices=tuple(HOLD_SESSIONS), default="swing")
    parser.add_argument("--cost-bps", type=float, default=10)
    args = parser.parse_args()
    hist = pd.read_csv(args.prices, index_col="Date", parse_dates=True)
    benchmark = pd.read_csv(args.benchmark, index_col="Date", parse_dates=True) if args.benchmark else None
    with open(args.snapshots, encoding="utf-8") as source:
        snapshots = json.load(source)
    print(json.dumps(walk_forward(hist, snapshots, args.trade_type, benchmark, args.cost_bps), indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
