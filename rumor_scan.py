"""
RUMOR SCANNER v1.0 (Wins + Dingers box office -- display-only tier)
====================================================================
Scans recent Deadline box-office coverage for early/leaked numbers about
tracked films (their prose carries the X-sphere and Rentrak-leak tiers).
Findings go to bo_data/rumors.json for the page's Rumor Board -- NEVER
into models, charts, or projections.

Wipe rule: when a new day's finalized number lands in dailies.csv, all
previously-seen rumors are cleared (hard data evicts soft data), and the
same run rescans so only post-finalization chatter remains.

  python rumor_scan.py           scan + maintain rumors.json
"""

import os
import re
import json
import hashlib
import requests
from datetime import datetime
from zoneinfo import ZoneInfo

import pandas as pd
from box_office import TRACKED, DAILIES, DATA

RUMORS = os.path.join(DATA, "rumors.json")
CATEGORY = "https://deadline.com/category/box-office/"
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}

# looser aliases than the chart parser -- prose says "Spidey", "Brand New Day"
ALIASES = {
    "Spider-Man: Brand New Day":
        r"brand new day|spider-?man|spidey",
    "The Odyssey":
        r"the odyssey|nolan['\u2019]?s?\s+(?:greek\s+)?epic",
}
MONEY_RX = re.compile(r"\$[\d,.]+\s*(?:million|m\b|billion|b\b|k\b)?", re.I)
TAG_RX = re.compile(r"<[^>]+>")


def now_iso():
    return datetime.now(ZoneInfo("America/New_York")).isoformat(timespec="minutes")


JUNK_RX = re.compile(r"must read|sign up|related storie|newslett|"
                     r"hide articles|rundown:", re.I)


def article_urls(html, limit=5):
    now = datetime.now(ZoneInfo("America/New_York"))
    months = {f"{now.year}/{now.month:02d}"}
    prev_m, prev_y = (now.month - 1 or 12), now.year - (now.month == 1)
    months.add(f"{prev_y}/{prev_m:02d}")
    urls = re.findall(r'href="(https://deadline\.com/(2\d{3}/\d{2})/'
                      r'[a-z0-9\-]+-\d+/)"', html)
    urls = [u for u, ym in urls if ym in months]
    seen, out = set(), []
    for u in urls:
        if u not in seen:
            seen.add(u)
            out.append(u)
        if len(out) >= limit:
            break
    return out


def sentences(html):
    text = TAG_RX.sub(" ", html)
    text = re.sub(r"\s+", " ", text)
    return re.split(r"(?<=[.!?])\s+", text)


def scan():
    found = []
    try:
        cat = requests.get(CATEGORY, headers=UA, timeout=20).text
    except Exception as e:
        print(f"category fetch failed: {e}")
        return found
    import time
    for url in article_urls(cat):
        try:
            html = requests.get(url, headers=UA, timeout=20).text
        except Exception:
            continue
        title_m = re.search(r"<title>(.*?)</title>", html, re.S)
        title = TAG_RX.sub("", title_m.group(1)).strip()[:90] if title_m else url
        for sent in sentences(html):
            if len(sent) > 400 or not MONEY_RX.search(sent):
                continue
            if JUNK_RX.search(sent):
                continue
            for film, alias_rx in ALIASES.items():
                if re.search(alias_rx, sent, re.I):
                    snippet = sent.strip()[:240]
                    found.append({"film": film, "snippet": snippet,
                                  "source": title, "url": url,
                                  "seen": now_iso(),
                                  "id": hashlib.md5(
                                      snippet[:120].encode()).hexdigest()[:10]})
                    break
        time.sleep(1.0)
    return found


def main():
    os.makedirs(DATA, exist_ok=True)
    max_date = ""
    if os.path.exists(DAILIES):
        df = pd.read_csv(DAILIES)
        if not df.empty:
            max_date = str(df["date"].max())
    state = {"as_of_maxdate": "", "items": []}
    if os.path.exists(RUMORS):
        try:
            state = json.load(open(RUMORS))
        except Exception:
            pass
    if max_date and max_date > state.get("as_of_maxdate", ""):
        wiped = len(state.get("items", []))
        state = {"as_of_maxdate": max_date, "items": []}
        if wiped:
            print(f"hard data through {max_date} landed -- wiped {wiped} "
                  f"stale rumors")
    have = {it["id"] for it in state["items"]}
    fresh = [it for it in scan() if it["id"] not in have]
    state["items"] = (state["items"] + fresh)[-20:]   # keep the latest 20
    state["as_of_maxdate"] = max_date or state["as_of_maxdate"]
    json.dump(state, open(RUMORS, "w"), indent=1)
    print(f"rumor board: {len(state['items'])} items ({len(fresh)} new)")


if __name__ == "__main__":
    main()
