"""
PREDICTION TRACKER v1.0  (baseballbreakouts calibration database)
==================================================================
Joins each day's frozen board snapshot (predictions/DATE.csv) with what
actually happened (home_run events in the Statcast store) and maintains
the honest ledger: results_log.csv (every prediction scored) and a
rolling calibration report.

  python track_results.py score              score yesterday
  python track_results.py score 2026-08-03   score a specific date
  python track_results.py report             rolling calibration summary

Run AFTER the day's store update (python statcast_talent.py update).
"""

import os
import sys
import pandas as pd
from datetime import date, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
PRED_DIR = os.path.join(HERE, "predictions")
LOG = os.path.join(HERE, "results_log.csv")

import statcast_talent as st

BUCKETS = [(0.00, 0.10), (0.10, 0.15), (0.15, 0.20), (0.20, 0.25), (0.25, 1.0)]


def outcomes_for(day):
    df = st.load_store(min_date=day)
    df = df[df["game_date"] == day]
    if df.empty:
        return None
    hr = df[df["events"] == "home_run"].groupby("batter").size()
    played = set(df[df["events"].notna()]["batter"].unique())
    return hr.to_dict(), played


def score(day):
    pred_path = os.path.join(PRED_DIR, f"{day}.csv")
    if not os.path.exists(pred_path):
        # No frozen snapshot for this date. NEVER fall back onto hr_board.csv
        # if the ledger already holds scored rows for the day -- hr_board.csv
        # mutates daily, and a stale fallback must not overwrite good data.
        if os.path.exists(LOG):
            existing = pd.read_csv(LOG)
            if (existing["date"] == day).any():
                print(f"{day}: no snapshot, but ledger already has "
                      f"{int((existing['date'] == day).sum())} scored rows -- "
                      f"keeping them untouched")
                return
        fallback = os.path.join(HERE, "hr_board.csv")
        if os.path.exists(fallback):
            print(f"[note] no snapshot for {day}; using hr_board.csv "
                  f"(only valid if it was generated on {day})")
            pred_path = fallback
        else:
            print(f"no prediction snapshot for {day}")
            return
    preds = pd.read_csv(pred_path)
    res = outcomes_for(day)
    if res is None:
        print(f"store has no rows for {day} -- run "
              f"`python statcast_talent.py update` first")
        return
    hr_by_batter, played = res

    join_on_id = "batter_id" in preds.columns
    store_day = None
    if not join_on_id:
        store_day = st.load_store(min_date=day)
        store_day = store_day[store_day["game_date"] == day]
    rows = []
    for _, r in preds.iterrows():
        if join_on_id:
            bid = int(r["batter_id"])
            hit = int(hr_by_batter.get(bid, 0) > 0)
            appeared = bid in played
        else:
            # name join for the pre-id snapshot (Aug 3) -- store loaded once above
            sub = store_day[store_day["player_name"] == str(r["player"])]
            appeared = not sub.empty
            hit = int((sub["events"] == "home_run").any()) if appeared else 0
        rows.append({"date": day, "player": r["player"],
                     "p_hr": float(r["p_hr_tonight"]),
                     "appeared": int(appeared), "hr": hit})
    out = pd.DataFrame(rows)
    out = out[out["appeared"] == 1]   # scratched players don't count
    if out.empty:
        print("no scored rows (no predicted players appeared?)")
        return

    if os.path.exists(LOG):
        log = pd.read_csv(LOG)
        log = log[log["date"] != day]          # idempotent re-scoring
        log = pd.concat([log, out])
    else:
        log = out
    log.to_csv(LOG, index=False)

    n, hrs = len(out), int(out["hr"].sum())
    brier = float(((out["p_hr"] - out["hr"]) ** 2).mean())
    pbar = float(out["p_hr"].mean())
    base = float(((pbar - out["hr"]) ** 2).mean())   # constant-forecast Brier
    verdict = "model BEATS it" if brier < base else "model behind it"
    print(f"\n{day}: scored {n} predictions -- {hrs} homered "
          f"(predicted {out['p_hr'].sum():.1f} expected HRs)")
    print(f"Brier score: {brier:.4f} vs same-number-for-everyone baseline "
          f"{base:.4f} -- {verdict}")
    top10 = out.nlargest(10, "p_hr")
    print(f"top-10 board: {int(top10['hr'].sum())}/10 homered "
          f"(expected {top10['p_hr'].sum():.1f})")
    for lo, hi in BUCKETS:
        b = out[(out["p_hr"] >= lo) & (out["p_hr"] < hi)]
        if len(b):
            print(f"  {lo:.0%}-{hi:.0%}: {len(b):>3} preds, "
                  f"predicted {b['p_hr'].mean():.1%}, realized "
                  f"{b['hr'].mean():.1%}")


def report():
    if not os.path.exists(LOG):
        print("no results yet -- score some days first")
        return
    log = pd.read_csv(LOG)
    n, hrs = len(log), int(log["hr"].sum())
    days = log["date"].nunique()
    brier = float(((log["p_hr"] - log["hr"]) ** 2).mean())
    pbar = float(log["p_hr"].mean())
    base = float(((pbar - log["hr"]) ** 2).mean())
    print(f"CALIBRATION -- {days} days, {n} predictions, {hrs} HRs")
    print(f"overall: predicted {log['p_hr'].mean():.2%} vs realized "
          f"{log['hr'].mean():.2%} | Brier {brier:.4f} vs constant-forecast "
          f"baseline {base:.4f} ({'beating it' if brier < base else 'behind it'})")
    print("reliability by bucket (predicted -> realized):")
    for lo, hi in BUCKETS:
        b = log[(log["p_hr"] >= lo) & (log["p_hr"] < hi)]
        if len(b):
            gap = b["hr"].mean() - b["p_hr"].mean()
            print(f"  {lo:.0%}-{hi:.0%}: n={len(b):>4}  "
                  f"{b['p_hr'].mean():.1%} -> {b['hr'].mean():.1%}  "
                  f"({gap:+.1%})")


if __name__ == "__main__":
    a = sys.argv[1:]
    if a and a[0] == "score":
        day = a[1] if len(a) > 1 else str(date.today() - timedelta(days=1))
        score(day)
    elif a and a[0] == "report":
        report()
    else:
        print(__doc__)
