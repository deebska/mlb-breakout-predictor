"""
PA DISTRIBUTION MODULE v1.0  (baseballbreakouts HR board)
==========================================================
Converts per-PA HR rates into the number the props market quotes:
P(player hits >= 1 HR tonight), via expected plate appearances by
lineup slot, split between the opposing starter and the bullpen.

  python pa_model.py lineups            today's confirmed lineups + E[PA]
  python pa_model.py calc 0.055 3 away  quick P(HR) for rate/slot/side
"""

import sys
import requests
from datetime import date

def baseball_today():
    """The slate date: today in US/Eastern, baseball's clock (UTC servers
    would otherwise roll the date at 8pm ET)."""
    from datetime import datetime
    from zoneinfo import ZoneInfo
    return datetime.now(ZoneInfo("America/New_York")).date()


# Expected PA by lineup slot, away team (9 full innings of offense).
# Home team bats ~0.10 fewer (skipped 9th when leading). League-standard values.
SLOT_PA_AWAY = {1: 4.65, 2: 4.55, 3: 4.44, 4: 4.33, 5: 4.22,
                6: 4.11, 7: 4.00, 8: 3.89, 9: 3.77}
HOME_ADJ = -0.10

STARTER_PA_DEFAULT = 2.60   # ~2.4 times through the order for slots 1-5-ish

STATSAPI = "https://statsapi.mlb.com/api/v1/schedule"


def slot_pa(slot, home):
    base = SLOT_PA_AWAY.get(int(slot), 4.1)
    return base + (HOME_ADJ if home else 0.0)


def p_hr_game(hr_pa, slot, home):
    """Single blended rate over all expected PA."""
    n = slot_pa(slot, home)
    return 1.0 - (1.0 - hr_pa) ** n


def p_hr_game_split(rate_vs_starter, rate_vs_pen, slot, home,
                    starter_pa=STARTER_PA_DEFAULT):
    """Starter/bullpen split: the assembler's preferred path.
    rate_vs_starter comes from the odds-ratio matchup; rate_vs_pen is the
    batter's talent vs a league-average opposite-ish arm."""
    n = slot_pa(slot, home)
    n_st = min(starter_pa, n)
    n_pen = max(n - n_st, 0.0)
    p_none = ((1.0 - rate_vs_starter) ** n_st) * ((1.0 - rate_vs_pen) ** n_pen)
    return 1.0 - p_none


def fetch_lineups():
    r = requests.get(STATSAPI, params={
        "sportId": 1, "date": str(baseball_today()),
        "hydrate": "lineups,probablePitcher"}, timeout=15)
    r.raise_for_status()
    return [g for d in r.json().get("dates", []) for g in d.get("games", [])]


def mode_lineups():
    games = fetch_lineups()
    if not games:
        print("no games today")
        return
    for g in games:
        teams = g.get("teams", {})
        away = teams.get("away", {}).get("team", {}).get("name", "?")
        home = teams.get("home", {}).get("team", {}).get("name", "?")
        lu = g.get("lineups", {}) or {}
        print(f"\n{away} @ {home}")
        for side, key, is_home in (("away", "awayPlayers", False),
                                   ("home", "homePlayers", True)):
            players = lu.get(key) or []
            pp = teams.get(side, {}).get("probablePitcher", {}).get("fullName")
            tag = f" (SP: {pp})" if pp else ""
            if not players:
                print(f"  {side}{tag}: lineup not posted yet")
                continue
            print(f"  {side}{tag}:")
            for i, p in enumerate(players, start=1):
                name = p.get("fullName", "?")
                pid = p.get("id", "?")
                print(f"    {i}. {name:<24} id={pid:<8} E[PA]={slot_pa(i, is_home):.2f}")


def main():
    a = sys.argv[1:]
    if a and a[0] == "lineups":
        mode_lineups()
    elif a and a[0] == "calc" and len(a) >= 3:
        rate, slot = float(a[1]), int(a[2])
        home = len(a) > 3 and a[3].lower() == "home"
        p = p_hr_game(rate, slot, home)
        print(f"HR/PA {rate:.4f}, slot {slot}, {'home' if home else 'away'} "
              f"-> E[PA] {slot_pa(slot, home):.2f} -> P(HR tonight) = {p:.3f} "
              f"({p:.1%})")
    else:
        print(__doc__)


if __name__ == "__main__":
    main()
