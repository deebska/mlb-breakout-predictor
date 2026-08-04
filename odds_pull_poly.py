"""
HR PROP ODDS -- POLYMARKET EDITION v2.0 (free, keyless, tradeable)
===================================================================
Polymarket's daily HR props live INSIDE each game event (slug
mlb-{away}-{home}-{date}) under a Home Runs tab, as Over/Under 0.5
markets per player. This puller builds today's slugs from the MLB
schedule, fetches each event from the Gamma API, and extracts every
player's Over-0.5 price into odds_today.csv for board.py.

  python odds_pull_poly.py --probe    per-game discovery report (run FIRST)
  python odds_pull_poly.py            write odds_today.csv
"""

import os
import re
import sys
import json
import unicodedata
import requests
import pandas as pd
from datetime import datetime
from zoneinfo import ZoneInfo

GAMMA = "https://gamma-api.polymarket.com"
STATSAPI = "https://statsapi.mlb.com/api/v1/schedule"
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "odds_today.csv")

# player name from the market rules text
DESC_RX = re.compile(
    r'resolve to [\'"]Over[\'"] if (.+?) records more than 0\.5 home runs', re.I)
# fallback: question-style phrasings
Q_RX = re.compile(r'^(?:will )?(.+?)(?:[:,]| to)? (?:record|hit)', re.I)

# statsapi team id -> polymarket slug code (statsapi abbreviations, lowered,
# with known divergences aliased)
ABBR_FIX = {"az": "ari", "wsn": "wsh", "ath": "oak"}


def norm_name(s):
    s = unicodedata.normalize("NFKD", str(s))
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    if "," in s:
        last, first = s.split(",", 1)
        s = f"{first.strip()} {last.strip()}"
    for junk in (" jr", " sr", " ii", " iii", ".", "'"):
        s = s.replace(junk, "")
    return " ".join(s.split())


def prob_to_american(p):
    if p <= 0 or p >= 1:
        return 0
    return round(100 * (1 - p) / p) if p < 0.5 else -round(100 * p / (1 - p))


def todays_slugs():
    today = datetime.now(ZoneInfo("America/New_York")).date()
    r = requests.get(STATSAPI, params={
        "sportId": 1, "date": str(today),
        "hydrate": "team"}, timeout=15)
    r.raise_for_status()
    games = [g for d in r.json().get("dates", []) for g in d.get("games", [])]
    slugs = []
    for g in games:
        try:
            away = g["teams"]["away"]["team"]["abbreviation"].lower()
            home = g["teams"]["home"]["team"]["abbreviation"].lower()
            away = ABBR_FIX.get(away, away)
            home = ABBR_FIX.get(home, home)
            slugs.append((f"mlb-{away}-{home}-{today}",
                          f"{away.upper()} @ {home.upper()}"))
        except Exception:
            continue
    return slugs


def fetch_event(slug):
    r = requests.get(f"{GAMMA}/events", params={"slug": slug}, timeout=20)
    if r.status_code != 200:
        return None
    js = r.json()
    return js[0] if isinstance(js, list) and js else None


def jload(v):
    if isinstance(v, str):
        try:
            return json.loads(v)
        except Exception:
            return None
    return v


def extract_hr_markets(ev):
    """Yield (player, over_prob) for every Over/Under-0.5 HR market."""
    for mk in (ev.get("markets") or []):
        desc = mk.get("description", "") or ""
        m = DESC_RX.search(desc)
        if not m:
            continue
        player = m.group(1).strip()
        outcomes = jload(mk.get("outcomes")) or []
        prices = jload(mk.get("outcomePrices")) or []
        over_p = None
        for o, p in zip(outcomes, prices):
            if str(o).lower() == "over":
                try:
                    over_p = float(p)
                except Exception:
                    pass
        if over_p is not None:
            yield player, over_p, mk.get("question", "")


def main():
    probe = "--probe" in sys.argv or "--probe-quiet" in sys.argv
    slugs = todays_slugs()
    print(f"{len(slugs)} games today")
    recs = []
    for slug, label in slugs:
        ev = fetch_event(slug)
        if ev is None:
            print(f"  {label}: event NOT FOUND (slug {slug}) -- abbrev mismatch?")
            continue
        found = list(extract_hr_markets(ev))
        # HR tab may live as a sibling event -- try known suffixes when empty
        if not found:
            for suffix in ("-home-runs", "-hr", "-player-home-runs"):
                sib = fetch_event(slug + suffix)
                if sib:
                    found = list(extract_hr_markets(sib))
                    if probe:
                        print(f"  {label}: sibling event {slug+suffix} -> "
                              f"{len(found)} props")
                    if found:
                        break
        if probe:
            print(f"  {label}: {len(found)} HR props")
            for player, p, q in found[:4]:
                print(f"      {player}: over 0.5 @ {p:.2f}   [{q[:50]}]")
            if not found and ev:
                mks = ev.get("markets") or []
                print(f"      RAW: event has {len(mks)} markets; first few:")
                for mk in mks[:8]:
                    print(f"        Q: {str(mk.get('question',''))[:64]}")
                    print(f"        D: {str(mk.get('description',''))[:90]}")
                probe_one = sys.argv.count("--probe")  # only dump first game fully
                if probe_one:
                    sys.argv.remove("--probe"); sys.argv.append("--probe-quiet")
            continue
        for player, p, _ in found:
            if not (0.005 < p < 0.95):
                continue
            recs.append({"name_key": norm_name(player), "player_book": player,
                         "mkt_prob": round(p, 4), "books": 1,
                         "best_over_odds": prob_to_american(p)})
    if probe:
        return
    if not recs:
        print("no priced HR props extracted -- run --probe to inspect")
        sys.exit(0)
    df = pd.DataFrame(recs).drop_duplicates("name_key")
    df["date"] = str(datetime.now(ZoneInfo("America/New_York")).date())
    df.to_csv(OUT, index=False)
    print(f"wrote odds_today.csv: {len(df)} players priced from Polymarket "
          f"(median {df['mkt_prob'].median():.1%})")


if __name__ == "__main__":
    main()
