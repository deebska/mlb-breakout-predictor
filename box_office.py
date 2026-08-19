"""
BOX OFFICE TRACKER v1.0 (Wins + Dingers)
=========================================
Pulls daily domestic grosses from The-Numbers daily charts for tracked
films, stores them, and projects the end-of-month cume with confidence
bands via per-weekday geometric decay.

  python box_office.py check     validate the parser on one live chart day
  python box_office.py update    pull missing days -> bo_data/dailies.csv
                                 + bo_data/forecast.json
"""

import os
import io
import re
import json
import math
import requests
import pandas as pd
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "bo_data")
DAILIES = os.path.join(DATA, "dailies.csv")
FORECAST = os.path.join(DATA, "forecast.json")
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}

TRACKED = [{
    "name": "Spider-Man: Brand New Day",
    "match": r"spider.?man.*brand.?new.?day",
    "release": "2026-07-31",
    # pre-registered forecast (Claude, 2026-08-09) for accountability overlay
    "preregistered": {"date": "2026-08-09", "central": 850e6,
                      "p80_lo": 825e6, "p80_hi": 875e6},
}, {
    "name": "The Odyssey",
    "match": r"^the odyssey$|\bthe odyssey\b",
    "release": "2026-07-17",
    "preregistered": None,
}]


def today_et():
    return datetime.now(ZoneInfo("America/New_York")).date()


def chart_url(d):
    return (f"https://www.the-numbers.com/box-office-chart/daily/"
            f"{d.year}/{d.month:02d}/{d.day:02d}")


def bom_url(d):
    return f"https://www.boxofficemojo.com/date/{d.isoformat()}/"


def parse_chart(html, match_rx):
    """Find the tracked film's daily gross + reported cume in a daily chart."""
    try:
        tables = pd.read_html(io.StringIO(html))
    except ValueError:
        return None
    rx = re.compile(match_rx, re.I)
    for t in tables:
        cols = {c: str(c).lower() for c in t.columns}
        if not any(("gross" in v) or ("daily" in v) for v in cols.values()):
            continue
        # locate movie-name column
        name_col = None
        for c in t.columns:
            if t[c].astype(str).str.contains(rx).any():
                name_col = c
                break
        if name_col is None:
            continue
        row = t[t[name_col].astype(str).str.contains(rx)]
        if row.empty:
            continue
        row = row.iloc[0]

        def money(v):
            s = re.sub(r"[^0-9]", "", str(v))
            return int(s) if s else None
        # daily column: "Daily" (BOM) or first "Gross" (The-Numbers)
        daily_col = next((c for c, v in cols.items() if "daily" in v), None) \
            or next((c for c, v in cols.items() if "gross" in v), None)
        # cumulative column: "To Date" (BOM) or last "Gross"-family column (TN)
        cume_col = next((c for c, v in cols.items()
                         if "to date" in v or "total" in v), None)
        if cume_col is None:
            gcols = [c for c, v in cols.items() if "gross" in v]
            cume_col = gcols[-1] if len(gcols) > 1 else None
        daily = money(row[daily_col]) if daily_col is not None else None
        cume = money(row[cume_col]) if cume_col is not None else None
        if daily:
            return {"daily": daily, "reported_cume": cume}
    return None


def fetch_day(d, match_rx):
    r = requests.get(chart_url(d), headers=UA, timeout=25)
    if r.status_code != 200:
        return None
    return parse_chart(r.text, match_rx)


def load_dailies():
    if os.path.exists(DAILIES):
        return pd.read_csv(DAILIES)
    return pd.DataFrame(columns=["film", "date", "daily", "reported_cume"])


def update():
    os.makedirs(DATA, exist_ok=True)
    df = load_dailies()
    yday = today_et() - timedelta(days=1)
    import time
    # union of dates any tracked film is missing; each chart page covers all
    needed = set()
    for film in TRACKED:
        have = set(df[df["film"] == film["name"]]["date"].astype(str))
        d = datetime.strptime(film["release"], "%Y-%m-%d").date()
        while d <= yday:
            if str(d) not in have:
                needed.add(d)
            d += timedelta(days=1)
    for i, d in enumerate(sorted(needed)):
        if i >= 12:                    # politeness cap; resumes next run
            print(f"  ({len(needed)-12} more days queued for next run)")
            break
        html = None
        for src, url in (("BOM", bom_url(d)), ("TN", chart_url(d))):
            try:
                r = requests.get(url, headers=UA, timeout=25)
                if r.status_code == 200 and len(r.text) > 20000:
                    if any(parse_chart(r.text, f["match"]) for f in TRACKED):
                        html = r.text
                        print(f"  {d}: using {src}")
                        break
            except Exception as e:
                print(f"  {d}: {src} fetch failed ({e})")
        if not html:
            print(f"  {d}: no source has this day yet")
            time.sleep(1.5); continue
        for film in TRACKED:
            have = set(df[df["film"] == film["name"]]["date"].astype(str))
            rel = datetime.strptime(film["release"], "%Y-%m-%d").date()
            if str(d) in have or d < rel:
                continue
            got = parse_chart(html, film["match"])
            if got:
                df.loc[len(df)] = [film["name"], str(d),
                                   got["daily"], got["reported_cume"]]
                print(f"  {d} {film['name'][:24]}: ${got['daily']:,}")
        time.sleep(1.5)
    df = df.sort_values(["film", "date"]).drop_duplicates(["film", "date"],
                                                          keep="last")
    df.to_csv(DAILIES, index=False)
    fc = {f["name"]: forecast(df, f) for f in TRACKED}
    json.dump(fc, open(FORECAST, "w"), indent=1)
    for name, v in fc.items():
        if v:
            print(f"{name}: cume ${v['cume_to_date']/1e6:.1f}M -> "
                  f"{v['target_date']}: ${v['central']/1e6:.0f}M "
                  f"(80%: {v['p80_lo']/1e6:.0f}-{v['p80_hi']/1e6:.0f}M)")


def forecast(df, film):
    """Per-weekday geometric decay projection to end of current month."""
    sub = df[df["film"] == film["name"]].sort_values("date")
    if len(sub) < 8:
        return None
    days = {r["date"]: float(r["daily"]) for _, r in sub.iterrows()}
    cume = float(sub["daily"].sum())
    last_date = datetime.strptime(sub["date"].iloc[-1], "%Y-%m-%d").date()
    eom = date(last_date.year, last_date.month, 28)
    while (eom + timedelta(days=1)).month == eom.month:
        eom += timedelta(days=1)

    # weekly decay: median of same-weekday ratios over the last 2 pairs
    ratios = []
    for ds, v in days.items():
        d0 = datetime.strptime(ds, "%Y-%m-%d").date()
        prev = str(d0 - timedelta(days=7))
        if prev in days and days[prev] > 0:
            ratios.append(v / days[prev])
    if not ratios:
        return None
    recent = sorted(ratios)[-6:]
    decay = float(pd.Series(recent).median())
    decay = min(max(decay, 0.25), 0.95)
    lo_decay, hi_decay = max(decay - 0.09, 0.20), min(decay + 0.09, 0.98)

    def project(k):
        total, d = 0.0, last_date + timedelta(days=1)
        while d <= eom:
            anchor, weeks = None, 1
            back = d - timedelta(days=7)
            while weeks <= 6:
                if str(back) in days:
                    anchor = days[str(back)]
                    break
                back -= timedelta(days=7)
                weeks += 1
            total += (anchor * (k ** weeks)) if anchor else 0.0
            d += timedelta(days=1)
        return total

    central = cume + project(decay)
    lo = cume + project(lo_decay)
    hi = cume + project(hi_decay)
    return {"cume_to_date": cume, "as_of": str(last_date),
            "target_date": str(eom), "central": central,
            "p80_lo": lo, "p80_hi": hi, "weekly_decay": round(decay, 3),
            "daily_series": [{"date": ds, "gross": days[ds]}
                             for ds in sorted(days)]}


def mode_check():
    d = today_et() - timedelta(days=1)
    film = TRACKED[0]
    print(f"CHECK: Box Office Mojo -- {bom_url(d)}")
    try:
        rb = requests.get(bom_url(d), headers=UA, timeout=25)
        gb = parse_chart(rb.text, film["match"]) if rb.status_code == 200 else None
        print(f"  BOM: {'$'+format(gb['daily'],',') if gb else 'not found'}")
    except Exception as e:
        print(f"  BOM failed: {e}")
    print(f"CHECK: The-Numbers -- {chart_url(d)}")
    got = fetch_day(d, film["match"])
    if got:
        print(f"  {film['name']} on {d}: daily ${got['daily']:,} | "
              f"reported cume ${got['reported_cume']:,}" if got["reported_cume"]
              else f"  daily ${got['daily']:,}")
        print("parser OK")
    else:
        d2 = d - timedelta(days=1)
        print(f"  not found for {d}; trying {d2}...")
        got = fetch_day(d2, film["match"])
        print(f"  {d2}: ${got['daily']:,} -- parser OK (yesterday's chart "
              f"just isn't posted yet)" if got else
              "  PARSER FAILED on both days -- tell Claude, format shifted")


if __name__ == "__main__":
    import sys
    if "check" in sys.argv:
        mode_check()
    else:
        update()
