"""
HR BOARD ASSEMBLER v1.0  (baseballbreakouts)
=============================================
Runs the full composition for every hitter in every posted lineup today:

  talent (vs tonight's SP, odds-ratio)  x  park/temp/wind (his hand)
  -> per-PA rate split starter/bullpen  ->  P(hits HR tonight) by slot

Outputs: hr_board.txt (readable, sorted) and hr_board.csv (for hredge).
Run:  python board.py          then upload hr_board.txt to the chat.
"""

import os
import json
import requests
import pandas as pd
from datetime import date

def baseball_today():
    """The slate date: today in US/Eastern, baseball's clock (UTC servers
    would otherwise roll the date at 8pm ET)."""
    from datetime import datetime
    from zoneinfo import ZoneInfo
    return datetime.now(ZoneInfo("America/New_York")).date()


import park_env
import pa_model
import statcast_talent as st

DIR = st.DIR
OUT_TXT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "hr_board.txt")
OUT_CSV = os.path.join(os.path.dirname(os.path.abspath(__file__)), "hr_board.csv")


def load_tables():
    bat = pd.read_csv(os.path.join(DIR, "talent_batters.csv"))
    pit = pd.read_csv(os.path.join(DIR, "talent_pitchers.csv"))
    league = json.load(open(os.path.join(DIR, "league_baselines.json")))
    if "bats" not in bat.columns:
        raise SystemExit("talent tables predate the `bats` column -- run: "
                         "python statcast_talent.py talent")
    return bat, pit, league


def pitcher_throws(pit, pid):
    # pitcher table is keyed by opposing stand; throws must come from raw store
    return None


def fair_american(p):
    if p <= 0 or p >= 1:
        return "n/a"
    return f"+{round(100*(1-p)/p)}" if p < 0.5 else f"-{round(100*p/(1-p))}"


def main():
    bat, pit, league = load_tables()
    games = pa_model.fetch_lineups()
    if not games:
        print("no games today")
        return

    # pitcher throws lookup from the raw store (modal p_throws per pitcher id)
    store = st.load_store()
    throws = (store.groupby("pitcher")["p_throws"]
              .agg(lambda s: s.mode().iloc[0] if len(s.mode()) else "R")
              .to_dict())

    rows = []
    game_tally = {}
    for g in games:
        teams = g.get("teams", {})
        venue = g.get("venue", {}).get("name", "")
        code = (park_env.VENUE_TO_CODE.get(venue)
                or park_env.VENUE_ALIASES.get(venue))
        if not code:
            print(f"[skip] unmapped venue: {venue}")
            continue
        try:
            env = park_env.game_env(code)
        except Exception as e:
            print(f"[skip] env failed for {code}: {e}")
            continue
        lu = g.get("lineups", {}) or {}
        for side, key, is_home in (("away", "awayPlayers", False),
                                   ("home", "homePlayers", True)):
            players = lu.get(key) or []
            opp = "home" if side == "away" else "away"
            sp = teams.get(opp, {}).get("probablePitcher", {})
            sp_id, sp_name = sp.get("id"), sp.get("fullName", "?")
            if not players or not sp_id:
                continue
            p_th = throws.get(sp_id, "R")
            for slot, pl in enumerate(players, start=1):
                bid = pl.get("id")
                b = bat[(bat["batter"] == bid) & (bat["p_throws"] == p_th)]
                if b.empty:
                    continue
                brow = b.iloc[0]
                base = league[f"hr_pa_vs_{p_th}"]
                # starter leg: odds-ratio vs this SP's talent vs this stand
                prow = pit[(pit["pitcher"] == sp_id)
                           & (pit["stand"] == brow["bats"])]
                p_rate = float(prow["talent_hr_pa"].iloc[0]) if not prow.empty \
                    else league["hr_pa"]
                rate_st = st.combine_matchup(float(brow["talent_hr_pa"]),
                                             p_rate, base)
                # bullpen leg: batter talent vs RHP (league pens skew R) at league arm
                bpen = bat[(bat["batter"] == bid) & (bat["p_throws"] == "R")]
                rate_pen = float(bpen["talent_hr_pa"].iloc[0]) if not bpen.empty \
                    else float(brow["talent_hr_pa"])
                # environment for his hand
                mult = env["env_mult_L"] if brow["bats"] == "L" else env["env_mult_R"]
                rate_st_env = min(rate_st * mult, 0.25)
                rate_pen_env = min(rate_pen * mult, 0.25)
                p_hr = pa_model.p_hr_game_split(rate_st_env, rate_pen_env,
                                                slot, is_home)
                n_pa = pa_model.slot_pa(slot, is_home)
                n_st = min(pa_model.STARTER_PA_DEFAULT, n_pa)
                e_hr = rate_st_env * n_st + rate_pen_env * (n_pa - n_st)
                gkey = f"{teams.get('away',{}).get('team',{}).get('name','?')} @ " \
                       f"{teams.get('home',{}).get('team',{}).get('name','?')}"
                game_tally.setdefault(gkey, {"park": code, "e_hr": 0.0})
                game_tally[gkey]["e_hr"] += e_hr
                rows.append({
                    "batter_id": bid,
                    "player": brow["name"], "bats": brow["bats"], "slot": slot,
                    "team_side": side, "park": code,
                    "vs_sp": sp_name, "sp_throws": p_th,
                    "talent_hr_pa": round(float(brow["talent_hr_pa"]), 4),
                    "matchup_rate": round(rate_st, 4),
                    "env_mult": mult,
                    "rate_tonight": round(rate_st_env, 4),
                    "p_hr_tonight": round(p_hr, 4),
                    "fair_odds": fair_american(p_hr),
                    "bbe_sample": int(brow["bbe"]),
                })

    if not rows:
        print("no composed rows -- lineups may not be posted yet; rerun closer "
              "to game time")
        import sys
        sys.exit(3)   # signal 'nothing to publish' so automation skips the page
    df = pd.DataFrame(rows).sort_values("p_hr_tonight", ascending=False)
    df.to_csv(OUT_CSV, index=False)
    if game_tally:
        import math as _m
        grows = []
        for gkey, gv in game_tally.items():
            lam = gv["e_hr"]
            p_le_2 = _m.exp(-lam) * (1 + lam + lam * lam / 2)
            grows.append({"game": gkey, "park": gv["park"],
                          "exp_hr": round(lam, 2),
                          "p_over_2_5": round(1 - p_le_2, 3)})
        gdf = pd.DataFrame(grows).sort_values("exp_hr", ascending=False)
        gdf.to_csv(os.path.join(os.path.dirname(OUT_CSV), "hr_games.csv"),
                   index=False)
        print(f"game totals written: {len(gdf)} games -> hr_games.csv")
    # immutable dated snapshot -- the calibration database's prediction side
    snap_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                            "predictions")
    os.makedirs(snap_dir, exist_ok=True)
    df.to_csv(os.path.join(snap_dir, f"{baseball_today()}.csv"), index=False)
    with open(OUT_TXT, "w") as f:
        f.write(f"HR BOARD -- {baseball_today()} -- {len(df)} hitters composed\n")
        f.write(f"{'player':<24}{'bats':<5}{'slot':<5}{'park':<5}"
                f"{'vs SP':<22}{'talent':<8}{'matchup':<9}{'env':<6}"
                f"{'tonight':<9}{'P(HR)':<8}{'fair':<7}{'BBE':<5}\n")
        for _, r in df.iterrows():
            f.write(f"{str(r['player'])[:22]:<24}{r['bats']:<5}{r['slot']:<5}"
                    f"{r['park']:<5}{str(r['vs_sp'])[:20]:<22}"
                    f"{r['talent_hr_pa']:<8.4f}{r['matchup_rate']:<9.4f}"
                    f"{r['env_mult']:<6.2f}{r['rate_tonight']:<9.4f}"
                    f"{r['p_hr_tonight']:<8.3f}{str(r['fair_odds']):<7}"
                    f"{r['bbe_sample']:<5}\n")
    print(f"board written: {len(df)} hitters -> hr_board.txt / hr_board.csv")
    print("top 5:")
    for _, r in df.head(5).iterrows():
        print(f"  {str(r['player'])[:22]:<24} {r['p_hr_tonight']:.1%}  "
              f"fair {r['fair_odds']}  ({r['park']}, slot {r['slot']}, "
              f"vs {str(r['vs_sp'])[:18]})")


if __name__ == "__main__":
    main()
