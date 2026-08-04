"""
STATCAST TALENT MODULE v1.1  (baseballbreakouts HR board -- upstream brain)
===========================================================================
Regressed xHR/PA talent for every batter and pitcher, split by handedness,
from raw Statcast pitch data. hredge turns these into edges downstream.

v1.1 fixes (after live backfill exposed both):
  - true pitch identity (game_pk + at_bat_number + pitch_number): dedup can
    no longer eat identical-looking pitches (v1.0 lost ~30% of rows, PA
    undercounted, every rate silently inflated)
  - 2-day pull chunks + hard tripwire under Savant's ~25,000-row silent
    truncation ceiling (proven live: a 6-day chunk returned exactly 25,000)
  - PA counted by distinct at-bats, immune to any residual duplication

Commands:
  python statcast_talent.py check                  quick pipe check
  python statcast_talent.py build --start DATE     backfill (resumable)
  python statcast_talent.py update                 nightly incremental
  python statcast_talent.py talent                 recompute tables only
  python statcast_talent.py matchup BAT_ID PIT_ID  worked example
"""

import os
import sys
import io
import time
import json
import math
import requests
import pandas as pd
from datetime import date, datetime, timedelta

DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "mlb_talent_data")
SEARCH_URL = "https://baseballsavant.mlb.com/statcast_search/csv"

KEEP = ["game_date", "game_pk", "at_bat_number", "pitch_number",
        "batter", "pitcher", "stand", "p_throws", "events",
        "type", "bb_type", "launch_speed", "launch_angle",
        "launch_speed_angle", "hc_x", "hc_y", "player_name",
        "release_speed", "pitch_type",   # accruing for the velo-trend signal
        "home_team"]                     # accruing for empirical park factors

# True pitch identity -- dedup on these, never on value columns
UNIQ = ["game_pk", "at_bat_number", "pitch_number"]

PA_EVENTS = {"single", "double", "triple", "home_run", "field_out",
             "strikeout", "strikeout_double_play", "walk", "intent_walk",
             "hit_by_pitch", "force_out", "grounded_into_double_play",
             "double_play", "triple_play", "sac_fly", "sac_bunt",
             "sac_fly_double_play", "field_error", "fielders_choice",
             "fielders_choice_out", "catcher_interf", "truncated_pa"}

STAB_BAT_BBE   = 60.0
STAB_PIT_BBE   = 180.0
HR_PER_BARREL  = 0.575
SOLID_AIR_HR   = 0.018


# ── Pulling ───────────────────────────────────────────────────────

def fetch_range(start, end):
    params = {
        "all": "true", "type": "details", "player_type": "batter",
        "game_date_gt": start, "game_date_lt": end,
        "hfSea": "", "hfGT": "R|",
        "min_pitches": 0, "min_results": 0, "group_by": "name",
        "sort_col": "pitches", "player_event_sort": "api_p_release_speed",
        "sort_order": "desc",
    }
    r = requests.get(SEARCH_URL, params=params, timeout=90,
                     headers={"User-Agent": "Mozilla/5.0"})
    r.raise_for_status()
    df = pd.read_csv(io.StringIO(r.text), low_memory=False)
    if df.empty:
        return df
    if len(df) >= 24500:
        raise RuntimeError(f"chunk returned {len(df)} rows -- at Savant's "
                           f"silent truncation ceiling; shrink the range")
    cols = [c for c in KEEP if c in df.columns]
    return df[cols]


def month_file(ym):
    return os.path.join(DIR, f"statcast_{ym}.csv.gz")


def save_month(df):
    os.makedirs(DIR, exist_ok=True)
    df = df.copy()
    df["ym"] = df["game_date"].str[:7]
    for ym, chunk in df.groupby("ym"):
        path = month_file(ym)
        chunk = chunk.drop(columns=["ym"])
        if os.path.exists(path):
            old = pd.read_csv(path, low_memory=False)
            chunk = pd.concat([old, chunk])
        before = len(chunk)
        chunk = chunk.drop_duplicates(subset=UNIQ, keep="last")
        dropped = before - len(chunk)
        chunk.to_csv(path, index=False, compression="gzip")
        note = f" ({dropped:,} overlap rows merged)" if dropped else ""
        print(f"    {ym}: store now {len(chunk):,} rows{note}")


def load_store(min_date=None):
    if not os.path.isdir(DIR):
        return pd.DataFrame()
    frames = []
    for f in sorted(os.listdir(DIR)):
        if f.startswith("statcast_") and f.endswith(".csv.gz"):
            frames.append(pd.read_csv(os.path.join(DIR, f), low_memory=False))
    if not frames:
        return pd.DataFrame()
    df = pd.concat(frames, ignore_index=True)
    if min_date:
        df = df[df["game_date"] >= min_date]
    return df


def store_last_date():
    df = load_store()
    return df["game_date"].max() if not df.empty else None


def pull_span(start, end):
    cur = datetime.strptime(start, "%Y-%m-%d").date()
    stop = datetime.strptime(end, "%Y-%m-%d").date()
    while cur <= stop:
        chunk_end = min(cur + timedelta(days=1), stop)   # 2-day chunks
        print(f"  pulling {cur} -> {chunk_end} ...")
        try:
            df = fetch_range(str(cur), str(chunk_end))
            print(f"    {len(df):,} pitches")
            if not df.empty:
                save_month(df)
        except Exception as e:
            print(f"    FAILED ({e}) -- rerun the same command to resume")
            return False
        cur = chunk_end + timedelta(days=1)
        time.sleep(2.5)
    return True


# ── Aggregation ───────────────────────────────────────────────────

def spray_angle(df):
    return ((df["hc_x"] - 125.42) / (198.27 - df["hc_y"]).clip(lower=1)
            ).apply(math.atan) * 180 / math.pi


def aggregate(df, who):
    df = df.copy()
    df = df[df["events"].notna() | (df["type"] == "X")]
    key = ["batter", "p_throws"] if who == "batter" else ["pitcher", "stand"]

    df["ab_key"] = df["game_pk"].astype(str) + ":" + df["at_bat_number"].astype(str)
    df["is_pa"]  = df["events"].isin(PA_EVENTS)
    df["is_hr"]  = df["events"] == "home_run"
    df["is_bbe"] = df["launch_speed_angle"].notna()
    df["is_barrel"] = df["launch_speed_angle"] == 6
    df["is_air"] = df["bb_type"].isin(["fly_ball", "line_drive"])
    sa = spray_angle(df)
    pulled = ((df["stand"] == "R") & (sa < -12)) | ((df["stand"] == "L") & (sa > 12))
    df["is_pull_air"] = df["is_air"] & pulled & ~df["is_barrel"]
    df["air_ev"] = df["launch_speed"].where(df["is_air"])

    pa_ct = (df[df["is_pa"]].groupby(key)["ab_key"].nunique()
             .rename("pa").reset_index())
    g = df.groupby(key).agg(
        hr=("is_hr", "sum"), bbe=("is_bbe", "sum"),
        barrels=("is_barrel", "sum"), pull_air=("is_pull_air", "sum"),
        air_ev=("air_ev", "mean"),
        name=("player_name", "first"),
        bats=("stand", lambda s: s.mode().iloc[0] if len(s.mode()) else "R"),
    ).reset_index()
    g = g.merge(pa_ct, on=key, how="left")
    g["pa"] = g["pa"].fillna(0)
    g = g[g["pa"] > 0]
    g["barrel_rate"]   = g["barrels"] / g["bbe"].clip(lower=1)
    g["pull_air_rate"] = g["pull_air"] / g["bbe"].clip(lower=1)
    g["bbe_per_pa"]    = g["bbe"] / g["pa"]
    return g


def xhr_per_pa(g):
    xhr_bbe = HR_PER_BARREL * g["barrel_rate"] + SOLID_AIR_HR * g["pull_air_rate"]
    return xhr_bbe * g["bbe_per_pa"]


def regress(g, league_rate, stab):
    w = g["bbe"] / (g["bbe"] + stab)
    g = g.copy()
    g["xhr_pa_raw"] = xhr_per_pa(g)
    g["talent_hr_pa"] = w * g["xhr_pa_raw"] + (1 - w) * league_rate
    g["regression_w"] = w.round(3)
    return g


def build_talent(current_min_date=None):
    df = load_store(min_date=current_min_date)
    if df.empty:
        print("store is empty -- run build/update first")
        return None
    bat = aggregate(df, "batter")
    pit = aggregate(df, "pitcher")

    league = {}
    for split in ("R", "L"):
        sub = bat[bat["p_throws"] == split]
        league[f"hr_pa_vs_{split}"] = float(sub["hr"].sum() / max(sub["pa"].sum(), 1))
    league["hr_pa"] = float(bat["hr"].sum() / max(bat["pa"].sum(), 1))

    bat = pd.concat([
        regress(bat[bat["p_throws"] == s], league[f"hr_pa_vs_{s}"], STAB_BAT_BBE)
        for s in ("R", "L")])
    pit = pd.concat([
        regress(pit[pit["stand"] == s], league["hr_pa"], STAB_PIT_BBE)
        for s in ("R", "L")])

    os.makedirs(DIR, exist_ok=True)
    bat.to_csv(os.path.join(DIR, "talent_batters.csv"), index=False)
    pit.to_csv(os.path.join(DIR, "talent_pitchers.csv"), index=False)
    json.dump(league, open(os.path.join(DIR, "league_baselines.json"), "w"),
              indent=1)
    print(f"talent tables written: {len(bat)} batter-splits, "
          f"{len(pit)} pitcher-splits")
    print(f"league HR/PA: {league['hr_pa']:.4f} "
          f"(vs R {league['hr_pa_vs_R']:.4f} / vs L {league['hr_pa_vs_L']:.4f})")
    return bat, pit, league


# ── Odds-ratio matchup combine ────────────────────────────────────

def odds(p):
    return p / (1 - p)


def combine_matchup(b_rate, p_rate, league_rate):
    if min(b_rate, p_rate, league_rate) <= 0:
        return league_rate
    o = odds(b_rate) * odds(p_rate) / odds(league_rate)
    return o / (1 + o)


def matchup(batter_id, pitcher_id):
    bat = pd.read_csv(os.path.join(DIR, "talent_batters.csv"))
    pit = pd.read_csv(os.path.join(DIR, "talent_pitchers.csv"))
    league = json.load(open(os.path.join(DIR, "league_baselines.json")))
    for hand in ("R", "L"):
        b = bat[(bat["batter"] == int(batter_id)) & (bat["p_throws"] == hand)]
        for stand in ("R", "L"):
            p = pit[(pit["pitcher"] == int(pitcher_id)) & (pit["stand"] == stand)]
            if b.empty or p.empty:
                continue
            base = league[f"hr_pa_vs_{hand}"]
            hr_pa = combine_matchup(float(b["talent_hr_pa"].iloc[0]),
                                    float(p["talent_hr_pa"].iloc[0]), base)
            print(f"batter vs {hand}HP x pitcher vs {stand}HB: "
                  f"HR/PA = {hr_pa:.4f} "
                  f"(bat {float(b['talent_hr_pa'].iloc[0]):.4f} | "
                  f"pit {float(p['talent_hr_pa'].iloc[0]):.4f} | lg {base:.4f})")


# ── Modes ─────────────────────────────────────────────────────────

def mode_check():
    end = date.today() - timedelta(days=1)
    start = end - timedelta(days=2)
    print(f"CHECK: pulling {start} -> {end} from Statcast search CSV...")
    frames = []
    cur = start
    while cur <= end:
        ce = min(cur + timedelta(days=1), end)
        frames.append(fetch_range(str(cur), str(ce)))
        cur = ce + timedelta(days=1)
        time.sleep(1.5)
    df = pd.concat(frames, ignore_index=True).drop_duplicates(subset=UNIQ)
    print(f"  {len(df):,} pitches, key columns present: "
          f"{all(c in df.columns for c in UNIQ)}")
    if df.empty:
        return
    bat = aggregate(df, "batter")
    top = bat.sort_values("barrels", ascending=False).head(8)
    print("\n  top barrel counts in window (sanity check vs Savant):")
    for _, r in top.iterrows():
        print(f"    {str(r['name'])[:24]:<26} vs {r['p_throws']}HP: "
              f"{int(r['pa'])} PA, {int(r['bbe'])} BBE, "
              f"{int(r['barrels'])} barrels, {int(r['hr'])} HR")


def main():
    args = sys.argv[1:]
    if not args or args[0] == "check":
        mode_check()
    elif args[0] == "build":
        start = args[args.index("--start") + 1] if "--start" in args \
            else f"{date.today().year}-03-20"
        if pull_span(start, str(date.today() - timedelta(days=1))):
            build_talent()
    elif args[0] == "update":
        last = store_last_date()
        if last is None:
            print("no store yet -- run build first"); return
        start = datetime.strptime(last, "%Y-%m-%d").date() + timedelta(days=1)
        yday = date.today() - timedelta(days=1)
        if start > yday:
            print("store already current")
        else:
            pull_span(str(start), str(yday))
        build_talent()
    elif args[0] == "talent":
        build_talent()
    elif args[0] == "matchup" and len(args) >= 3:
        matchup(args[1], args[2])
    else:
        print(__doc__)


if __name__ == "__main__":
    main()
