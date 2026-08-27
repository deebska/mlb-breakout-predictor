"""claude_daily.py -- the September book's morning brain.

Once per new data day, packages the complete Spider-Man state (full daily
ledger, weekday/weekend hold structure, anchored cume, event calendar)
and asks Claude -- fresh, with web search enabled for news -- for:
  - tomorrow's gross prediction
  - a Sept-30 domestic cume central
  - % on each market bracket: <940, 940-950, 950-960, 960-970, 970+
Response is validated (probabilities renormalized, cume sanity-checked)
and appended immutably to bo_data/claude_sept.jsonl. Failures never
fabricate: on any error the journal is left alone and the page shows the
last good read with its date.

Needs ANTHROPIC_API_KEY in the environment (repo secret). Without it,
prints a note and exits 0 so the workflow never breaks.
"""
import json
import os
import sys
from datetime import datetime, timedelta

import pandas as pd
import requests

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "bo_data")
JOURNAL = os.path.join(DATA, "claude_sept.jsonl")
FILM = "Spider-Man: Brand New Day"
BRACKETS = ["<940", "940-950", "950-960", "960-970", "970+"]

EVENT_CALENDAR = """
Known September 2026 calendar (verify/extend via web search):
- Labor Day weekend Sep 4-7: holiday Monday plays like a weekend day
- Post-Labor-Day weekday cliff: comp = Oppenheimer Sep 2023 weekdays
  fell to $400-600K range at scale ~1/2.4 of this film
- Watch for: Sony re-release/extended-cut announcements (No Way Home
  "More Fun Stuff" precedent), National Cinema Day-style discount events,
  IMAX/PLF screen handoffs, major September wide releases taking screens
- Market resolves on the film's reported domestic cume through Sep 30
"""


def build_context(df):
    sub = df[df["film"] == FILM].sort_values("date")
    days = [{"date": r.date,
             "dow": datetime.strptime(r.date, "%Y-%m-%d").strftime("%a"),
             "gross": round(float(r.daily) / 1e6, 2)}
            for r in sub.itertuples()]
    rep = sub.dropna(subset=["reported_cume"])
    cume = (float(rep.reported_cume.iloc[-1]) +
            float(sub[sub.date > rep.date.iloc[-1]].daily.sum())
            if len(rep) else float(sub.daily.sum()))
    # weekly holds, split by regime, most recent 3 weeks
    holds = []
    dmap = {r.date: float(r.daily) for r in sub.itertuples()}
    for d, g in list(dmap.items())[-21:]:
        prior = (datetime.strptime(d, "%Y-%m-%d") -
                 timedelta(days=7)).strftime("%Y-%m-%d")
        if prior in dmap and dmap[prior] > 0:
            wd = datetime.strptime(d, "%Y-%m-%d").weekday()
            holds.append({"date": d, "regime": "wkend" if wd >= 4 else "wkday",
                          "wow": round(g / dmap[prior] - 1, 3)})
    return days, cume, holds


def call_claude(key, days, cume, holds):
    today = datetime.utcnow().strftime("%Y-%m-%d")
    prompt = f"""You are the daily box office forecaster for a tracking
site. Today is {today}. Film: {FILM} (domestic).

Anchored cume to date: ${cume/1e6:.1f}M
Full daily ledger (millions): {json.dumps(days)}
Recent weekly holds by regime: {json.dumps(holds)}
{EVENT_CALENDAR}

First, use web search to check for material news from the last few days:
re-releases, discount events, screen changes, September competition, any
early daily numbers not in the ledger. Then reason from ALL of it --
treat weekdays and weekends as separate decay regimes (weekday errors
are serially correlated; weekends carry independent event risk), and
weight uncertainty by the composition of remaining dollars.

Respond with ONLY a JSON object, no markdown fences, no other text:
{{"next_day": {{"date": "YYYY-MM-DD", "gross_musd": <number>}},
 "sept30_central_musd": <number>,
 "brackets": {{"<940": <0-1>, "940-950": <0-1>, "950-960": <0-1>,
              "960-970": <0-1>, "970+": <0-1>}},
 "news": ["<any material findings, or empty list>"],
 "rationale": "<under 120 words>"}}"""
    r = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={"x-api-key": key, "anthropic-version": "2023-06-01",
                 "content-type": "application/json"},
        json={"model": "claude-sonnet-4-6", "max_tokens": 2000,
              "tools": [{"type": "web_search_20250305",
                         "name": "web_search", "max_uses": 4}],
              "messages": [{"role": "user", "content": prompt}]},
        timeout=180)
    r.raise_for_status()
    text = "".join(b.get("text", "") for b in r.json().get("content", [])
                   if b.get("type") == "text")
    start, end = text.find("{"), text.rfind("}")
    return json.loads(text[start:end + 1])


def validate(out, cume):
    b = {k: max(0.0, float(out["brackets"].get(k, 0))) for k in BRACKETS}
    s = sum(b.values())
    if s <= 0:
        raise ValueError("bracket probabilities all zero")
    b = {k: round(v / s, 4) for k, v in b.items()}
    central = float(out["sept30_central_musd"])
    if not (cume / 1e6 - 1) <= central <= 1200:
        raise ValueError(f"central {central} fails sanity vs cume")
    nd = out["next_day"]
    return {"asof": datetime.utcnow().strftime("%Y-%m-%dT%H:%MZ"),
            "data_through": None,  # filled by caller
            "next_day": {"date": str(nd["date"]),
                         "gross_musd": round(float(nd["gross_musd"]), 2)},
            "sept30_central_musd": round(central, 1),
            "brackets": b,
            "news": [str(x)[:200] for x in out.get("news", [])][:5],
            "rationale": str(out.get("rationale", ""))[:800]}


def main():
    key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if not key:
        print("claude_daily: no ANTHROPIC_API_KEY set; skipping")
        return 0
    df = pd.read_csv(os.path.join(DATA, "dailies.csv"))
    sub = df[df["film"] == FILM]
    if sub.empty:
        print("claude_daily: no film rows"); return 0
    latest = sub["date"].max()
    if os.path.exists(JOURNAL):
        last = [json.loads(x) for x in open(JOURNAL) if x.strip()]
        if last and last[-1].get("data_through") == latest \
                and "--force" not in sys.argv:
            print(f"claude_daily: already journaled for {latest}; skipping")
            return 0
    days, cume, holds = build_context(df)
    try:
        out = validate(call_claude(key, days, cume, holds), cume)
    except Exception as e:
        print(f"claude_daily: FAILED ({e}); journal untouched")
        return 0
    out["data_through"] = latest
    with open(JOURNAL, "a") as f:
        f.write(json.dumps(out) + "\n")
    print(f"claude_daily: journaled read for data through {latest}: "
          f"central ${out['sept30_central_musd']}M, "
          f"brackets {out['brackets']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
