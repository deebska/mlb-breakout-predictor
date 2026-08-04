"""
PARK + WEATHER ENVIRONMENT LAYER v1.0  (baseballbreakouts HR board)
====================================================================
Turns neutral talent HR rates into tonight's-conditions rates:

    hr_pa_tonight = matchup_rate x park[stand] x temp_mult x wind_mult

Park HR factors are handedness-specific; weather comes from Open-Meteo
(the weather bot's plumbing, repointed); wind is projected onto each
park's center-field azimuth so only the out-blowing component counts.
Roofed parks get neutral weather.

All park constants are TRANSPARENT APPROXIMATIONS seeded from public
3-yr Statcast park effects and stadium bearings -- tune freely in the
PARKS table; empirical recalibration from our own store is the planned
upgrade once home_team accrues in the pulls.

Commands:
  python park_env.py check COL          today's env at Coors
  python park_env.py slate              env multipliers for today's slate
"""

import sys
import math
import json
import requests
from datetime import date, datetime

def baseball_today():
    """The slate date: today in US/Eastern, baseball's clock (UTC servers
    would otherwise roll the date at 8pm ET)."""
    from datetime import datetime
    from zoneinfo import ZoneInfo
    return datetime.now(ZoneInfo("America/New_York")).date()


# ── Park table ────────────────────────────────────────────────────
# azimuth: compass bearing (deg) from home plate toward center field
# hr_L / hr_R: HR park factor for LHB / RHB (1.00 = neutral)
# roof: True = dome/retractable (weather neutralized)
PARKS = {
 "LAA": {"name":"Angel Stadium",        "lat":33.800,"lon":-117.883,"az": 46,"roof":False,"hr_L":1.02,"hr_R":1.04},
 "HOU": {"name":"Daikin Park",          "lat":29.757,"lon": -95.356,"az": 20,"roof":True, "hr_L":1.06,"hr_R":1.05},
 "OAK": {"name":"Sutter Health (A's)",  "lat":38.580,"lon":-121.513,"az": 35,"roof":False,"hr_L":1.03,"hr_R":1.02},
 "TOR": {"name":"Rogers Centre",        "lat":43.641,"lon": -79.389,"az":  0,"roof":True, "hr_L":1.08,"hr_R":1.06},
 "ATL": {"name":"Truist Park",          "lat":33.891,"lon": -84.468,"az": 30,"roof":False,"hr_L":1.04,"hr_R":1.05},
 "MIL": {"name":"Am. Family Field",     "lat":43.028,"lon": -87.971,"az":128,"roof":True, "hr_L":1.06,"hr_R":1.04},
 "STL": {"name":"Busch Stadium",        "lat":38.623,"lon": -90.193,"az": 62,"roof":False,"hr_L":0.94,"hr_R":0.95},
 "CHC": {"name":"Wrigley Field",        "lat":41.948,"lon": -87.656,"az": 37,"roof":False,"hr_L":1.03,"hr_R":1.05},
 "ARI": {"name":"Chase Field",          "lat":33.445,"lon":-112.067,"az": 25,"roof":True, "hr_L":1.02,"hr_R":1.01},
 "LAD": {"name":"Dodger Stadium",       "lat":34.074,"lon":-118.240,"az": 26,"roof":False,"hr_L":1.05,"hr_R":1.06},
 "SF":  {"name":"Oracle Park",          "lat":37.778,"lon":-122.389,"az": 87,"roof":False,"hr_L":0.84,"hr_R":0.94},
 "CLE": {"name":"Progressive Field",    "lat":41.496,"lon": -81.685,"az":  0,"roof":False,"hr_L":1.02,"hr_R":0.98},
 "SEA": {"name":"T-Mobile Park",        "lat":47.591,"lon":-122.332,"az": 49,"roof":True, "hr_L":0.92,"hr_R":0.93},
 "MIA": {"name":"loanDepot park",       "lat":25.778,"lon": -80.220,"az": 40,"roof":True, "hr_L":0.90,"hr_R":0.92},
 "NYM": {"name":"Citi Field",           "lat":40.757,"lon": -73.846,"az": 13,"roof":False,"hr_L":0.97,"hr_R":0.96},
 "WSH": {"name":"Nationals Park",       "lat":38.873,"lon": -77.007,"az": 28,"roof":False,"hr_L":1.00,"hr_R":1.01},
 "BAL": {"name":"Camden Yards",         "lat":39.284,"lon": -76.622,"az": 31,"roof":False,"hr_L":1.04,"hr_R":0.96},
 "SD":  {"name":"Petco Park",           "lat":32.707,"lon":-117.157,"az":  0,"roof":False,"hr_L":0.95,"hr_R":0.96},
 "PHI": {"name":"Citizens Bank Park",   "lat":39.906,"lon": -75.166,"az":  9,"roof":False,"hr_L":1.08,"hr_R":1.07},
 "PIT": {"name":"PNC Park",             "lat":40.447,"lon": -80.006,"az":115,"roof":False,"hr_L":0.94,"hr_R":0.93},
 "TEX": {"name":"Globe Life Field",     "lat":32.747,"lon": -97.083,"az": 14,"roof":True, "hr_L":1.01,"hr_R":1.00},
 "TB":  {"name":"Steinbrenner Field",   "lat":27.980,"lon": -82.507,"az": 57,"roof":False,"hr_L":1.06,"hr_R":1.02},
 "BOS": {"name":"Fenway Park",          "lat":42.346,"lon": -71.097,"az": 52,"roof":False,"hr_L":0.96,"hr_R":0.98},
 "CIN": {"name":"Great American",       "lat":39.097,"lon": -84.507,"az":122,"roof":False,"hr_L":1.12,"hr_R":1.10},
 "COL": {"name":"Coors Field",          "lat":39.756,"lon":-104.994,"az":  4,"roof":False,"hr_L":1.10,"hr_R":1.12},
 "DET": {"name":"Comerica Park",        "lat":42.339,"lon": -83.049,"az":145,"roof":False,"hr_L":0.94,"hr_R":0.92},
 "KC":  {"name":"Kauffman Stadium",     "lat":39.051,"lon": -94.480,"az": 45,"roof":False,"hr_L":0.90,"hr_R":0.91},
 "MIN": {"name":"Target Field",         "lat":44.982,"lon": -93.278,"az": 90,"roof":False,"hr_L":1.00,"hr_R":1.01},
 "NYY": {"name":"Yankee Stadium",       "lat":40.829,"lon": -73.926,"az": 75,"roof":False,"hr_L":1.18,"hr_R":1.02},
 "CWS": {"name":"Rate Field",           "lat":41.830,"lon": -87.634,"az":127,"roof":False,"hr_L":1.06,"hr_R":1.07},
}

# Weather physics (transparent, tunable)
TEMP_BASE_C   = 21.0     # ~70F neutral
TEMP_PCT_PER_C = 0.015   # ~+1.5% HR per +1C (~0.85%/F)
WIND_PCT_PER_MPH = 0.016 # per mph of out-blowing component at 10m
WIND_CAP = 0.35          # never adjust more than +/-35% for wind
MPH_PER_KMH = 0.621371

STATSAPI = "https://statsapi.mlb.com/api/v1/schedule"
METEO    = "https://api.open-meteo.com/v1/forecast"

# statsapi venue name -> park code (for slate mode)
VENUE_TO_CODE = {p["name"]: code for code, p in PARKS.items()}
VENUE_ALIASES = {"Minute Maid Park": "HOU", "Oakland Coliseum": "OAK",
                 "George M. Steinbrenner Field": "TB",
                 "Guaranteed Rate Field": "CWS",
                 "Great American Ball Park": "CIN",
                 "American Family Field": "MIL",
                 "Sutter Health Park": "OAK"}


def fetch_weather(lat, lon, game_hour_local=19):
    r = requests.get(METEO, params={
        "latitude": lat, "longitude": lon,
        "hourly": "temperature_2m,wind_speed_10m,wind_direction_10m",
        "forecast_days": 2, "timezone": "auto"}, timeout=15)
    r.raise_for_status()
    h = r.json()["hourly"]
    today = str(baseball_today())
    idx = next((i for i, t in enumerate(h["time"])
                if t.startswith(today) and int(t[11:13]) == game_hour_local),
               None)
    if idx is None:
        idx = min(19, len(h["time"]) - 1)
    return {"temp_c": h["temperature_2m"][idx],
            "wind_kmh": h["wind_speed_10m"][idx],
            "wind_from_deg": h["wind_direction_10m"][idx]}


def wind_multiplier(park, wind_kmh, wind_from_deg):
    """Project wind onto the CF azimuth: only the out-blowing component
    moves the needle. wind_from_deg = direction wind ORIGINATES from."""
    wind_to = (wind_from_deg + 180) % 360
    angle = math.radians(wind_to - park["az"])
    out_mph = wind_kmh * MPH_PER_KMH * math.cos(angle)
    adj = max(-WIND_CAP, min(WIND_CAP, WIND_PCT_PER_MPH * out_mph))
    return 1.0 + adj, out_mph


def temp_multiplier(temp_c):
    return 1.0 + TEMP_PCT_PER_C * (temp_c - TEMP_BASE_C)


def game_env(code, game_hour_local=19):
    park = PARKS[code]
    out = {"park": code, "name": park["name"],
           "park_mult_L": park["hr_L"], "park_mult_R": park["hr_R"]}
    if park["roof"]:
        out.update({"roof": True, "temp_mult": 1.0, "wind_mult": 1.0,
                    "out_wind_mph": 0.0, "temp_c": None})
    else:
        wx = fetch_weather(park["lat"], park["lon"], game_hour_local)
        wm, out_mph = wind_multiplier(park, wx["wind_kmh"], wx["wind_from_deg"])
        out.update({"roof": False, "temp_c": wx["temp_c"],
                    "temp_mult": round(temp_multiplier(wx["temp_c"]), 3),
                    "wind_mult": round(wm, 3),
                    "out_wind_mph": round(out_mph, 1)})
    out["env_mult_L"] = round(out["park_mult_L"] * out["temp_mult"] * out["wind_mult"], 3)
    out["env_mult_R"] = round(out["park_mult_R"] * out["temp_mult"] * out["wind_mult"], 3)
    return out


def fmt(e):
    wxs = "ROOF" if e["roof"] else (f"{e['temp_c']:.0f}C, out-wind "
                                    f"{e['out_wind_mph']:+.0f}mph")
    return (f"{e['park']:<4} {e['name'][:22]:<24} {wxs:<26} "
            f"env x{e['env_mult_L']:.2f}(L) x{e['env_mult_R']:.2f}(R)")


def mode_check(code):
    print(fmt(game_env(code)))


def mode_slate():
    r = requests.get(STATSAPI, params={"sportId": 1, "date": str(baseball_today())},
                     timeout=15)
    r.raise_for_status()
    games = [g for d in r.json().get("dates", []) for g in d.get("games", [])]
    if not games:
        print("no games today")
        return
    print(f"{len(games)} games today -- environment multipliers:\n")
    rows = []
    for g in games:
        venue = g.get("venue", {}).get("name", "")
        code = VENUE_TO_CODE.get(venue) or VENUE_ALIASES.get(venue)
        if not code:
            print(f"  [unmapped venue: {venue}] -- add to VENUE_ALIASES")
            continue
        try:
            hour = int(g.get("gameDate", "")[11:13])
        except Exception:
            hour = 19
        try:
            e = game_env(code)
            rows.append(e)
            away = g.get("teams", {}).get("away", {}).get("team", {}).get("name", "?")
            home = g.get("teams", {}).get("home", {}).get("team", {}).get("name", "?")
            print(f"  {away[:18]:>18} @ {fmt(e)}")
        except Exception as ex:
            print(f"  {venue}: env failed ({ex})")
    if rows:
        hot = max(rows, key=lambda e: e["env_mult_R"])
        cold = min(rows, key=lambda e: e["env_mult_R"])
        print(f"\n  hottest park tonight: {hot['park']} x{hot['env_mult_R']:.2f} | "
              f"coldest: {cold['park']} x{cold['env_mult_R']:.2f}")


if __name__ == "__main__":
    a = sys.argv[1:]
    if a and a[0] == "check" and len(a) > 1:
        mode_check(a[1].upper())
    elif a and a[0] == "slate":
        mode_slate()
    else:
        print(__doc__)
