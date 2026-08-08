"""
AARON BROWN 5-FACTOR NFL SYSTEM v1.0  (faithful implementation)
================================================================
Rules exactly as published at eraider.com/nfl-picks (2006, unmodified):

Per team:
  LGT:  +1 if net GIVEAWAYS in its last game, -1 if net takeaways, 0 even
  STDC: +1 if covered fewer times than failed this season, -1 if more, 0 tie
Shared:
  MOVE: +1 to the team the line has moved AGAINST since first posting
Total (home perspective) = home LGT + home STDC + MOVE(home)
                         - away LGT - away STDC - MOVE(away-signed)
Bet home if Total >= +3, away if <= -3, else PASS.

Data: nflverse games.csv (schedule/results/closing spreads, free) +
ESPN public API (turnovers, current lines). Line movement measured against
our own snapshot history (nfl_data/line_history.json).

  python nfl_system.py check     validate data pipes on last season
  python nfl_system.py update    compute current week's picks -> nfl_picks.csv
"""

import os
import json
import requests
import pandas as pd
from datetime import datetime, date
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "nfl_data")
GAMES_CSV = "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv"
ESPN_SB = ("https://site.api.espn.com/apis/site/v2/sports/football/nfl/"
           "scoreboard")
ESPN_SUM = ("https://site.api.espn.com/apis/site/v2/sports/football/nfl/"
            "summary")
LINE_HISTORY = os.path.join(DATA, "line_history.json")
OUT = os.path.join(HERE, "nfl_picks.csv")

UA = {"User-Agent": "Mozilla/5.0"}


def now_et():
    return datetime.now(ZoneInfo("America/New_York"))


def load_games():
    df = pd.read_csv(GAMES_CSV, low_memory=False)
    return df


def current_season(df):
    played = df[df["result"].notna()]
    upcoming = df[df["result"].isna()]
    if upcoming.empty:
        return int(played["season"].max()), None
    season = int(upcoming["season"].min())
    wk = int(upcoming[upcoming["season"] == season]["week"].min())
    return season, wk


def season_covers(df, season, before_week):
    """STDC state: per team, covers minus fails, regular season to date."""
    g = df[(df["season"] == season) & (df["week"] < before_week)
           & (df["game_type"] == "REG") & df["result"].notna()
           & df["spread_line"].notna()]
    rec = {}
    for _, r in g.iterrows():
        # result = home score - away score; spread_line = home spread
        # (positive = home favored, per nflverse convention)
        margin = float(r["result"])
        line = float(r["spread_line"])
        if margin == line:
            continue  # push: no cover either way
        home_cov = margin > line
        for team, cov in ((r["home_team"], home_cov),
                          (r["away_team"], not home_cov)):
            rec.setdefault(team, [0, 0])
            rec[team][0 if cov else 1] += 1
    return rec


def stdc_point(rec, team):
    c, f = rec.get(team, [0, 0])
    if c < f:
        return 1
    if c > f:
        return -1
    return 0


def last_game_espn_id(df, season, team, before_week):
    """Most recent completed game (REG or POST, incl. prior season)."""
    g = df[df["result"].notna()
           & ((df["home_team"] == team) | (df["away_team"] == team))]
    g = g[(g["season"] < season)
          | ((g["season"] == season) & (g["week"] < before_week))]
    if g.empty:
        return None
    r = g.sort_values(["season", "week"]).iloc[-1]
    return r.get("espn"), r


def turnovers_for(espn_id):
    """Per-team turnovers from the ESPN boxscore. Returns {abbr: int}."""
    r = requests.get(ESPN_SUM, params={"event": int(espn_id)},
                     headers=UA, timeout=20)
    r.raise_for_status()
    out = {}
    for t in r.json().get("boxscore", {}).get("teams", []):
        abbr = t.get("team", {}).get("abbreviation", "")
        for s in t.get("statistics", []):
            if s.get("name") == "turnovers":
                try:
                    out[abbr] = int(s.get("displayValue"))
                except Exception:
                    pass
    return out


# nflverse team codes -> ESPN boxscore abbreviations (divergences only)
TO_ESPN = {"LA": "LAR", "WAS": "WSH"}


def lgt_point(df, season, team, before_week, cache):
    """+1 net giveaways last game, -1 net takeaways, 0 even/unknown."""
    got = last_game_espn_id(df, season, team, before_week)
    if not got or pd.isna(got[0]):
        return 0
    espn_id, row = got
    if espn_id not in cache:
        try:
            cache[espn_id] = turnovers_for(espn_id)
        except Exception:
            cache[espn_id] = {}
    tos = cache[espn_id]
    me = TO_ESPN.get(team, team)
    opp_team = row["away_team"] if row["home_team"] == team else row["home_team"]
    opp = TO_ESPN.get(opp_team, opp_team)
    if me not in tos or opp not in tos:
        return 0
    if tos[me] > tos[opp]:
        return 1        # gave it away more: underrated now
    if tos[me] < tos[opp]:
        return -1
    return 0


def current_lines():
    """Upcoming games with spreads from ESPN scoreboard."""
    r = requests.get(ESPN_SB, headers=UA, timeout=20)
    r.raise_for_status()
    lines = {}
    for ev in r.json().get("events", []):
        comp = (ev.get("competitions") or [{}])[0]
        odds = (comp.get("odds") or [{}])[0]
        spread = odds.get("spread")     # negative = home favored (ESPN)
        home = away = None
        for c in comp.get("competitors", []):
            ab = c.get("team", {}).get("abbreviation")
            if c.get("homeAway") == "home":
                home = ab
            else:
                away = ab
        if home and away and spread is not None:
            lines[f"{away}@{home}"] = float(spread)
    return lines


def move_points(key, cur_spread, hist):
    """+1 to the team the line moved against (>=0.5pt) since first snapshot.
    ESPN spread is home-based negative-favored: spread rising toward/above 0
    = moved against HOME; falling = moved against AWAY.
    Returns (home_move, away_move) as +1/0 each (mutually exclusive)."""
    first = hist.get(key)
    if first is None:
        return 0, 0
    d = cur_spread - float(first)
    if d >= 0.5:
        return 1, 0     # against home
    if d <= -0.5:
        return 0, 1     # against away
    return 0, 0


def compute_picks():
    os.makedirs(DATA, exist_ok=True)
    df = load_games()
    season, week = current_season(df)
    if week is None:
        print("no upcoming games in schedule data")
        return None
    upcoming = df[(df["season"] == season) & (df["week"] == week)
                  & df["result"].isna()]
    covers = season_covers(df, season, week)
    lines = {}
    try:
        lines = current_lines()
    except Exception as e:
        print(f"line fetch failed: {e}")
    hist = {}
    if os.path.exists(LINE_HISTORY):
        hist = json.load(open(LINE_HISTORY))
    to_cache, rows = {}, []
    for _, g in upcoming.iterrows():
        home, away = g["home_team"], g["away_team"]
        key = f"{TO_ESPN.get(away, away)}@{TO_ESPN.get(home, home)}"
        spread = lines.get(key)
        if spread is not None and key not in hist:
            hist[key] = spread          # first sighting = reference
        h_lgt = lgt_point(df, season, home, week, to_cache)
        a_lgt = lgt_point(df, season, away, week, to_cache)
        h_std = stdc_point(covers, home)
        a_std = stdc_point(covers, away)
        h_mv, a_mv = move_points(key, spread, hist) if spread is not None \
            else (0, 0)
        total = (h_lgt + h_std + h_mv) - (a_lgt + a_std + a_mv)
        pick = home if total >= 3 else (away if total <= -3 else "PASS")
        rows.append({"season": season, "week": week,
                     "game": f"{away} @ {home}", "spread_home": spread,
                     "home_lgt": h_lgt, "away_lgt": a_lgt,
                     "home_stdc": h_std, "away_stdc": a_std,
                     "home_move": h_mv, "away_move": a_mv,
                     "total": total, "pick": pick,
                     "gameday": g.get("gameday", "")})
    json.dump(hist, open(LINE_HISTORY, "w"))
    out = pd.DataFrame(rows)
    out.to_csv(OUT, index=False)
    # immutable weekly snapshot -- the grading ledger's prediction side
    snap = os.path.join(DATA, f"picks_{season}_wk{week:02d}.csv")
    if not os.path.exists(snap):
        out.to_csv(snap, index=False)
    else:
        # refresh only lines/factors for games still PASS-able; keep locked bets
        old_snap = pd.read_csv(snap)
        locked = old_snap[old_snap["pick"] != "PASS"]["game"].tolist()
        merged = out.copy()
        for gm in locked:
            merged.loc[merged["game"] == gm] =                 old_snap[old_snap["game"] == gm].iloc[0]
        merged.to_csv(snap, index=False)
    bets = out[out["pick"] != "PASS"]
    print(f"{season} week {week}: {len(out)} games, {len(bets)} bets")
    for _, b in bets.iterrows():
        print(f"  BET {b['pick']}: {b['game']} (total {b['total']:+d})")
    return out


def mode_check():
    print("checking data pipes on completed games...")
    df = load_games()
    last_season = int(df[df["result"].notna()]["season"].max())
    rec = season_covers(df, last_season, 99)
    some = sorted(rec.items(), key=lambda kv: kv[1][0]-kv[1][1])[:3]
    print(f"  covers computed for {len(rec)} teams in {last_season} "
          f"(worst: {', '.join(f'{t} {c}-{f}' for t,(c,f) in some)})")
    g = df[(df["season"] == last_season) & df["result"].notna()
           & df["espn"].notna()].iloc[-1]
    tos = turnovers_for(g["espn"])
    print(f"  turnovers for {g['away_team']} @ {g['home_team']} "
          f"({g['gameday']}): {tos}")
    try:
        lines = current_lines()
        print(f"  ESPN current lines: {len(lines)} games with spreads")
    except Exception as e:
        print(f"  ESPN lines: {e}")
    print("pipes OK" if tos else "TURNOVER PARSE FAILED -- tell Claude")


NFL_LOG = os.path.join(HERE, "nfl_results_log.csv")


def grade():
    """Score every snapshotted bet whose game has a result. Idempotent."""
    if not os.path.isdir(DATA):
        print("no snapshots yet")
        return
    df = load_games()
    done = df[df["result"].notna() & df["spread_line"].notna()]
    rows = []
    import glob
    for snap in sorted(glob.glob(os.path.join(DATA, "picks_*.csv"))):
        p = pd.read_csv(snap)
        for _, r in p[p["pick"] != "PASS"].iterrows():
            away, home = r["game"].split(" @ ")
            g = done[(done["season"] == r["season"]) & (done["week"] == r["week"])
                     & (done["home_team"] == home) & (done["away_team"] == away)]
            if g.empty or pd.isna(r["spread_home"]):
                continue
            margin = float(g.iloc[0]["result"])       # home - away
            line = -float(r["spread_home"])           # ESPN home-neg -> nflverse
            if margin == line:
                res = "PUSH"
            else:
                home_cov = margin > line
                res = "WIN" if ((r["pick"] == home) == home_cov) else "LOSS"
            rows.append({"season": int(r["season"]), "week": int(r["week"]),
                         "game": r["game"], "pick": r["pick"],
                         "line_at_pick": float(r["spread_home"]),
                         "total": int(r["total"]), "result": res})
    if not rows:
        print("no gradable bets yet")
        return
    log = pd.DataFrame(rows).drop_duplicates(["season", "week", "game"])
    log.to_csv(NFL_LOG, index=False)
    w = int((log["result"] == "WIN").sum())
    l = int((log["result"] == "LOSS").sum())
    pu = int((log["result"] == "PUSH").sum())
    pct = w / (w + l) * 100 if (w + l) else 0
    print(f"graded: {w}-{l}-{pu} ({pct:.1f}%)")


if __name__ == "__main__":
    import sys
    if "check" in sys.argv:
        mode_check()
    elif "grade" in sys.argv:
        grade()
    else:
        compute_picks()
        grade()
