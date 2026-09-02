"""
BOX OFFICE PAGE GENERATOR v1.0 -> bo.html (Wins + Dingers)
Daily table + cume chart with projection cone to month-end, plus the
pre-registered forecast overlay for accountability.
Run after box_office.py update:  python make_bo_page.py
"""

import os
import json
import pandas as pd
from datetime import datetime, timedelta, date
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
FORECAST = os.path.join(HERE, "bo_data", "forecast.json")
OUT = os.path.join(HERE, "bo.html")

from box_office import TRACKED, forecast as bo_forecast
import math


def eom_prob_windows(central, cume_now, windows):
    """P(final lands in each window) from N(central, sigma), sigma = 12% of
    the still-unearned dollars (floor $1.5M) -- uncertainty shrinks as the
    month converts from forecast to fact."""
    sigma = max(0.12 * max(central - cume_now, 0), 1.5e6)

    def cdf(x):
        return 0.5 * (1 + math.erf((x - central) / (sigma * 2 ** 0.5)))
    out = []
    for lo, hi in windows:
        p_lo = cdf(lo) if lo is not None else 0.0
        p_hi = cdf(hi) if hi is not None else 1.0
        out.append(max(p_hi - p_lo, 0.0))
    return out


EOM_WINDOWS = {
    # August markets resolved 2026-08-31 (SM <900/900+, Odyssey bands).
    # September bracket probabilities live in the September book section,
    # fed by the daily API journal -- per-day window columns retired.
}

# ── Pre-registered daily forecasts (Claude) -- frozen, never edited ──
# Spider-Man sheet registered 2026-08-09; Odyssey sheet registered 2026-08-10.
# Blank dates (pre-registration) show no Predicted value: honesty over hindsight.
CLAUDE_DAILY = {
 "Spider-Man: Brand New Day": {
  "2026-08-10":14.0e6,"2026-08-11":15.0e6,"2026-08-12":11.0e6,
  "2026-08-13":10.0e6,"2026-08-14":16.5e6,"2026-08-15":25.5e6,
  "2026-08-16":18.5e6,"2026-08-17":6.0e6,"2026-08-18":6.5e6,
  "2026-08-19":4.5e6,"2026-08-20":4.0e6,"2026-08-21":8.5e6,
  "2026-08-22":12.5e6,"2026-08-23":9.0e6,"2026-08-24":3.2e6,
  "2026-08-25":3.6e6,"2026-08-26":2.6e6,"2026-08-27":2.4e6,
  "2026-08-28":5.0e6,"2026-08-29":7.5e6,"2026-08-30":5.5e6,
  "2026-08-31":3.0e6},
 "The Odyssey": {
  "2026-08-10":6.8e6,"2026-08-11":6.2e6,"2026-08-12":5.9e6,
  "2026-08-13":5.0e6,"2026-08-14":6.2e6,"2026-08-15":8.7e6,
  "2026-08-16":7.1e6,"2026-08-17":4.9e6,"2026-08-18":4.5e6,
  "2026-08-19":4.2e6,"2026-08-20":3.6e6,"2026-08-21":4.5e6,
  "2026-08-22":6.3e6,"2026-08-23":5.1e6,"2026-08-24":3.4e6,
  "2026-08-25":3.1e6,"2026-08-26":2.9e6,"2026-08-27":2.5e6,
  "2026-08-28":3.3e6,"2026-08-29":4.6e6,"2026-08-30":3.7e6,
  "2026-08-31":2.5e6},
}
def claude_live(series, sheet):
    """Claude's frozen sheet marked to market daily, by his stated rule:
    weekday deviations apply to future weekdays at full weight; weekends
    inherit only HALF the weekday deviation until real weekend days grade,
    after which observed weekend deviations take over at full weight."""
    from datetime import datetime as _dt
    actual = {s["date"]: s["gross"] for s in series}
    wk_r, we_r = [], []
    for d, pred in sorted(sheet.items()):
        if d in actual and pred:
            r = actual[d] / pred
            (we_r if _dt.strptime(d, "%Y-%m-%d").weekday() >= 4
             else wk_r).append(r)
    w_adj = sum(wk_r[-5:]) / len(wk_r[-5:]) if wk_r else 1.0
    e_adj = (sum(we_r[-3:]) / len(we_r[-3:]) if we_r
             else 1.0 + 0.5 * (w_adj - 1.0))
    cume = sum(actual.values())
    for d, pred in sheet.items():
        if d not in actual:
            wd = _dt.strptime(d, "%Y-%m-%d").weekday()
            cume += pred * (e_adj if wd >= 4 else w_adj)
    return cume, w_adj, e_adj


def claude_day_ahead(hist, sheet, d):
    """Claude-live's one-day-ahead call for date d, using only data
    strictly before d: the frozen sheet value for d, scaled by the
    weekday/weekend adjustment learned from everything graded so far."""
    if d not in sheet:
        return None
    from datetime import datetime as _dt
    _, w_adj, e_adj = claude_live(hist, sheet)
    wd = _dt.strptime(d, "%Y-%m-%d").weekday()
    return sheet[d] * (e_adj if wd >= 4 else w_adj)


def model_day_ahead(hist, film, d):
    """The momentum model's one-day-ahead call for date d: same
    weekday-anchor * decay^weeks step its projection uses, computed on
    only data strictly before d."""
    if len(hist) < 8:
        return None
    tdf = pd.DataFrame([{"film": film["name"], "date": x["date"],
                         "daily": x["gross"], "reported_cume": None}
                        for x in hist])
    fc = bo_forecast(tdf, film)
    if not fc:
        return None
    decay = fc["weekly_decay"]
    days = {x["date"]: x["gross"] for x in hist}
    d0 = datetime.strptime(d, "%Y-%m-%d").date()
    back, weeks = d0 - timedelta(days=7), 1
    while weeks <= 6:
        if str(back) in days:
            return days[str(back)] * (decay ** weeks)
        back -= timedelta(days=7)
        weeks += 1
    return None


SEPT_JOURNAL = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "bo_data",
    "claude_sept.jsonl")
SEPT_BRACKETS = ["<940", "940-950", "950-960", "960-970", "970+"]


def sept_book_html(film_name, latest_data_date):
    """Spider-Man September market section: live-Claude daily bracket
    reads from the API journal. Empty string for other films/no data."""
    if film_name != "Spider-Man: Brand New Day":
        return ""
    if not os.path.exists(SEPT_JOURNAL):
        return ("<h3 style='font-size:15px;margin:18px 0 6px;"
                "color:var(--gold)'>September book (resolves Sep 30)</h3>"
                "<div style='color:var(--dim);font-size:13px'>Awaiting "
                "first live-Claude read -- needs ANTHROPIC_API_KEY secret "
                "and the claude_daily workflow step.</div>")
    reads = [json.loads(x) for x in open(SEPT_JOURNAL) if x.strip()]
    if not reads:
        return ""
    cur = reads[-1]
    stale = cur.get("data_through") != latest_data_date
    head = "".join(f"<th>{b}</th>" for b in SEPT_BRACKETS)
    cells = "".join(
        f"<td style='font-weight:700;color:"
        f"{'var(--gold)' if cur['brackets'][b]==max(cur['brackets'].values()) else 'inherit'}'>"
        f"{cur['brackets'][b]*100:.0f}%</td>" for b in SEPT_BRACKETS)
    hist = ""
    for r in reads[-14:][::-1]:
        hist += ("<tr><td>" + r.get("data_through", "?") + "</td>"
                 + f"<td>${r['sept30_central_musd']:,.0f}M</td>"
                 + "".join(f"<td>{r['brackets'][b]*100:.0f}%</td>"
                           for b in SEPT_BRACKETS)
                 + "</tr>")
    news = "".join(f"<li>{n}</li>" for n in cur.get("news", []))
    return (
        "<h3 style='font-size:15px;margin:18px 0 6px;color:var(--gold)'>"
        "September book (resolves Sep 30) -- live Claude, fresh reasoning "
        "daily</h3>"
        + ("<div style='color:#ff6b6b;font-size:12px'>STALE: last read "
           f"used data through {cur.get('data_through')}; newer days have "
           "landed.</div>" if stale else "")
        + "<div class='stat'><div class='lab'>Sep 30 central "
        f"(read of {cur.get('data_through')})</div><div class='big'>"
        f"${cur['sept30_central_musd']:,.0f}M</div></div>"
        + "<table><thead><tr>" + head + "</tr></thead><tbody><tr>"
        + cells + "</tr></tbody></table>"
        + (f"<div style='color:var(--dim);font-size:12px;margin:6px 0'>"
           f"News scan: <ul style='margin:2px 0 0 16px'>{news}</ul></div>"
           if news else "")
        + f"<div style='color:var(--dim);font-size:12px;margin:4px 0'>"
        + cur.get("rationale", "") + "</div>"
        + "<h3 style='font-size:14px;margin:12px 0 4px;color:var(--dim)'>"
        "Read history</h3><table><thead><tr><th>Data thru</th>"
        "<th>Central</th>" + head + "</tr></thead><tbody>"
        + hist + "</tbody></table>")


CLAUDE_EOM = {
 "Spider-Man: Brand New Day": {"date": "2026-08-09", "central": 850e6,
                               "p80_lo": 825e6, "p80_hi": 875e6},
 "The Odyssey": {"date": "2026-08-10", "central": 565e6,
                 "p80_lo": 550e6, "p80_hi": 585e6},
}

CSS = """
:root{--bg:#0b1220;--card:#121b2e;--row:#0f1728;--txt:#e8eef7;--dim:#8b97ab;
--green:#3ddc84;--accent:#4da3ff;--line:#1e2a44;--warm:#ffb020}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--txt);
font:15px/1.45 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}
.wrap{max-width:1060px;margin:0 auto;padding:28px 16px 60px}
h1{font-size:26px;margin:0 0 4px}h2{font-size:19px;margin:26px 0 8px}
.sub{color:var(--dim);margin-bottom:18px;font-size:14px}
a{color:var(--accent);text-decoration:none}
table{width:100%;border-collapse:collapse;background:var(--card);
border-radius:12px;overflow:hidden}
th{background:#16223b;text-align:left;padding:9px 10px;font-size:12px;
letter-spacing:.04em;text-transform:uppercase;color:var(--dim)}
td{padding:8px 10px;border-top:1px solid var(--line);
font-variant-numeric:tabular-nums}
tr:nth-child(even) td{background:var(--row)}
.stat{display:inline-block;background:var(--card);border-radius:12px;
padding:14px 18px;margin:4px 8px 4px 0;min-width:150px}
.stat .lab{color:var(--dim);font-size:12px;text-transform:uppercase}
.big{font-size:26px;font-weight:800;color:var(--green)}
.foot{color:var(--dim);font-size:13px;margin-top:22px;line-height:1.7}
@media(max-width:720px){.hide-m{display:none}}
"""

NAV = ('<div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;'
       'margin-bottom:18px">'
       '<div style="font-size:24px;font-weight:800;letter-spacing:-.02em">'
       'Wins <span style="color:#3ddc84">+</span> Dingers</div>'
       '<div style="display:flex;gap:6px">'
       '<a href="/hrboard.html" style="padding:7px 14px;border-radius:9px;'
       'color:var(--accent);text-decoration:none;font-weight:600">HR Board</a>'
       '<a href="/results.html" style="padding:7px 14px;border-radius:9px;'
       'color:var(--accent);text-decoration:none;font-weight:600">Results</a>'
       '<a href="/nfl.html" style="padding:7px 14px;border-radius:9px;'
       'color:var(--accent);text-decoration:none;font-weight:600">NFL System</a>'
       '<a href="/bo.html" style="padding:7px 14px;border-radius:9px;'
       'background:#1c2a47;color:#e8eef7;text-decoration:none;'
       'font-weight:600">Box Office</a>'
       '</div></div>')


def proj_chart(traj, prereg, windows, w=980, h=340):
    """Daily evolution of both forecasters' Aug-31 projections: gold =
    Claude-live, blue = model."""
    if not traj:
        return ""
    dates = sorted(traj)
    cl = [traj[d][0] for d in dates]
    mo = [traj[d][1] for d in dates]
    vals = [v for v in cl + mo if v] + \
           ([prereg["central"]] if prereg else [])
    bounds = sorted({b for _, wpair in windows for b in wpair
                     if b is not None})
    near = [b for b in bounds if min(vals) - 25e6 <= b <= max(vals) + 25e6]
    lo = min(vals + near) - 8e6
    hi = max(vals + near) + 8e6

    def X(i):
        return 70 + i / max(len(dates) - 1, 1) * (w - 110)

    def Y(v):
        return (h - 36) - (v - lo) / (hi - lo) * (h - 72)

    grid, labels = "", ""
    for b in near:
        gy = Y(b)
        grid += (f'<line x1="70" y1="{gy:.0f}" x2="{w-40}" y2="{gy:.0f}" '
                 f'stroke="#2a3a5c" stroke-width="1" stroke-dasharray="3 4"/>')
        labels += (f'<text x="6" y="{gy+4:.0f}" fill="#8b97ab" '
                   f'font-size="11">${b/1e6:.0f}M</text>')
    pre = ""
    if prereg:
        py = Y(prereg["central"])
        pre = (f'<line x1="70" y1="{py:.0f}" x2="{w-40}" y2="{py:.0f}" '
               f'stroke="#ffb020" stroke-width="1.5" stroke-dasharray="7 6" '
               f'opacity="0.55"/>'
               f'<text x="{w-38}" y="{py+4:.0f}" fill="#ffb020" '
               f'font-size="10" opacity="0.8">frozen</text>')
    cl_line = " ".join(f"{X(i):.1f},{Y(v):.1f}" for i, v in enumerate(cl))
    mo_pts = [(X(i), Y(v)) for i, v in enumerate(mo) if v]
    mo_line = " ".join(f"{x:.1f},{y:.1f}" for x, y in mo_pts)
    end_lbl = (f'<text x="{X(len(dates)-1)-4:.0f}" y="{Y(cl[-1])-9:.0f}" '
               f'fill="#ffb020" font-size="12" font-weight="700" '
               f'text-anchor="end">Claude ${cl[-1]/1e6:.0f}M</text>')
    if mo[-1]:
        end_lbl += (f'<text x="{X(len(dates)-1)-4:.0f}" '
                    f'y="{Y(mo[-1])+16:.0f}" fill="#4da3ff" font-size="12" '
                    f'font-weight="700" text-anchor="end">Model '
                    f'${mo[-1]/1e6:.0f}M</text>')
    x0, x1 = dates[0], dates[-1]
    return f"""<svg viewBox="0 0 {w} {h}" style="width:100%;background:#121b2e;
border-radius:12px">{grid}{labels}{pre}
<polyline points="{mo_line}" stroke="#4da3ff" stroke-width="2.5" fill="none"
 opacity="0.9"/>
<polyline points="{cl_line}" stroke="#ffb020" stroke-width="2.5" fill="none"/>
{"".join(f'<circle cx="{X(i):.1f}" cy="{Y(v):.1f}" r="3" fill="#ffb020"/>'
         for i, v in enumerate(cl))}
{end_lbl}
<text x="70" y="{h-8}" fill="#8b97ab" font-size="11">{x0}</text>
<text x="{w-40}" y="{h-8}" fill="#8b97ab" font-size="11"
 text-anchor="end">{x1}</text>
<text x="{w/2:.0f}" y="18" fill="#8b97ab" font-size="11" text-anchor="middle">
Month-end projection, day by day</text>
</svg>"""


def svg_chart(series, fc, prereg, live_val=None, w=980, h=340):
    """Cume line to date + projection cone + preregistered marker, inline SVG."""
    days = [(datetime.strptime(s["date"], "%Y-%m-%d").date(), s["gross"])
            for s in series]
    start = days[0][0]
    end = datetime.strptime(fc["target_date"], "%Y-%m-%d").date()
    span = (end - start).days or 1
    top = max(fc["p80_hi"], prereg["p80_hi"] if prereg else 0) * 1.06

    def X(d): return 60 + (d - start).days / span * (w - 90)
    def Y(v): return (h - 40) - v / top * (h - 80)

    cume, pts = float(fc.get("cume_drift") or 0), []
    for d, g in days:
        cume += g
        pts.append((X(d), Y(cume), d, cume))
    line = " ".join(f"{x:.1f},{y:.1f}" for x, y, *_ in pts)
    lx, ly = pts[-1][0], pts[-1][1]

    # projection cone: linear taper from current cume to lo/hi/central at end
    Xe = X(end)
    cone = (f"M {lx:.1f},{ly:.1f} L {Xe:.1f},{Y(fc['p80_hi']):.1f} "
            f"L {Xe:.1f},{Y(fc['p80_lo']):.1f} Z")
    central = (f"M {lx:.1f},{ly:.1f} L {Xe:.1f},{Y(fc['central']):.1f}")

    gridlines, labels = "", ""
    step = 100e6 if top > 400e6 else 50e6
    v = step
    while v < top:
        gy = Y(v)
        gridlines += (f'<line x1="60" y1="{gy:.0f}" x2="{w-30}" y2="{gy:.0f}" '
                      f'stroke="#1e2a44" stroke-width="1"/>')
        labels += (f'<text x="8" y="{gy+4:.0f}" fill="#8b97ab" '
                   f'font-size="11">${v/1e6:.0f}M</text>')
        v += step

    pre = ""
    if prereg:
        py, plo, phi = Y(prereg["central"]), Y(prereg["p80_lo"]), Y(prereg["p80_hi"])
        pre = (f'<line x1="{Xe-14:.0f}" y1="{phi:.0f}" x2="{Xe-14:.0f}" '
               f'y2="{plo:.0f}" stroke="#ffb020" stroke-width="3" opacity="0.8"/>'
               f'<circle cx="{Xe-14:.0f}" cy="{py:.0f}" r="5" fill="#ffb020"/>'
               f'<text x="{Xe-190:.0f}" y="{phi-8:.0f}" fill="#ffb020" '
               f'font-size="11">pre-registered {prereg["date"]}: '
               f'${prereg["central"]/1e6:.0f}M</text>')

    live = ""
    if live_val:
        ly2 = Y(live_val)
        live = (f'<circle cx="{Xe-14:.0f}" cy="{ly2:.0f}" r="6" '
                f'fill="none" stroke="#ffb020" stroke-width="2.5"/>'
                f'<text x="{Xe-118:.0f}" y="{ly2+4:.0f}" fill="#ffb020" '
                f'font-size="11">live ${live_val/1e6:.0f}M</text>')
    return f"""<svg viewBox="0 0 {w} {h}" style="width:100%;background:#121b2e;
border-radius:12px">{gridlines}{labels}
<path d="{cone}" fill="#4da3ff" opacity="0.16"/>
<path d="{central}" stroke="#4da3ff" stroke-width="2" stroke-dasharray="6 5"
 fill="none"/>
<polyline points="{line}" stroke="#3ddc84" stroke-width="3" fill="none"/>
<circle cx="{lx:.1f}" cy="{ly:.1f}" r="4" fill="#3ddc84"/>
<text x="{lx-40:.0f}" y="{ly-10:.0f}" fill="#3ddc84" font-size="12"
 font-weight="700">${pts[-1][3]/1e6:.0f}M</text>
<text x="{Xe-52:.0f}" y="{Y(fc['central'])-8:.0f}" fill="#4da3ff"
 font-size="12" font-weight="700">${fc['central']/1e6:.0f}M</text>
{pre}{live}
<text x="60" y="{h-8}" fill="#8b97ab" font-size="11">{start}</text>
<text x="{Xe-60:.0f}" y="{h-8}" fill="#8b97ab" font-size="11">{end}</text>
</svg>"""


def build():
    ts = datetime.now(ZoneInfo("America/New_York"))
    if not os.path.exists(FORECAST):
        body = "<div class='sub'>No data yet -- first update pending.</div>"
    else:
        fc_all = json.load(open(FORECAST))
        sections = []
        for film in TRACKED:
            fc = fc_all.get(film["name"])
            if not fc:
                sections.append(f"<h2>{film['name']}</h2>"
                                "<div class='sub'>Collecting first days..."
                                "</div>")
                continue
            series = fc["daily_series"]
            wins = EOM_WINDOWS.get(film["name"], [])
            sheet = CLAUDE_DAILY.get(film["name"], {})
            sheet_start = min(sheet) if sheet else None
            jmap = {}
            if film["name"] == "Spider-Man: Brand New Day" and \
                    os.path.exists(SEPT_JOURNAL):
                for _ln in open(SEPT_JOURNAL):
                    if _ln.strip():
                        _r = json.loads(_ln)
                        _nd = _r.get("next_day") or {}
                        if _nd.get("date"):
                            jmap[str(_nd["date"])] = \
                                float(_nd["gross_musd"]) * 1e6
            jcen = {}
            if film["name"] == "Spider-Man: Brand New Day" and \
                    os.path.exists(SEPT_JOURNAL):
                for _ln in open(SEPT_JOURNAL):
                    if _ln.strip():
                        _r = json.loads(_ln)
                        if _r.get("data_through"):
                            jcen[str(_r["data_through"])] = \
                                float(_r["sept30_central_musd"]) * 1e6
            traj = {}
            dayahead = {}
            if sheet_start:
                hist = []
                for s in series:
                    if s["date"] >= sheet_start:
                        dayahead[s["date"]] = (
                            claude_day_ahead(hist, sheet, s["date"])
                            or jmap.get(s["date"]),
                            model_day_ahead(hist, film, s["date"]))
                    hist.append(s)
                    if s["date"] < sheet_start:
                        continue
                    tdf = pd.DataFrame([{"film": film["name"], "date": x["date"],
                                         "daily": x["gross"],
                                         "reported_cume": None} for x in hist])
                    fc_d = bo_forecast(tdf, film)
                    cl_d, _, _ = claude_live(hist, sheet)
                    if s["date"] >= "2026-09-01" and jcen:
                        _past = [v for k, v in sorted(jcen.items())
                                 if k <= s["date"]]
                        cl_d = _past[-1] if _past else None
                    cume_d = sum(x["gross"] for x in hist)
                    probs = eom_prob_windows(cl_d, cume_d,
                                             [w for _, w in wins])
                    traj[s["date"]] = (cl_d,
                                       fc_d["central"] if fc_d else None,
                                       probs)
            rows = ""
            cume = float(fc.get("cume_drift") or 0)
            for s in series:
                cume += s["gross"]
                d0 = datetime.strptime(s["date"], "%Y-%m-%d").date()
                wow = ""
                prev = [x for x in series
                        if x["date"] == str(d0 - timedelta(days=7))]
                if prev:
                    wow = f"{(s['gross']/prev[0]['gross']-1)*100:+.0f}%"
                da = dayahead.get(s["date"], (None, None))
                pcell = ""
                for pv in da:
                    if pv:
                        dv = (s["gross"] / pv - 1) * 100
                        dcol = ("#3ddc84" if abs(dv) <= 15 else
                                "#ffb020" if abs(dv) <= 30 else "#ff6b6b")
                        pcell += (f"<td>${pv/1e6:,.1f}M</td>"
                                  f"<td style='color:{dcol};font-weight:600'>"
                                  f"{dv:+.0f}%</td>")
                    else:
                        pcell += "<td></td><td></td>"
                tcells = ""
                if wins:
                    t = traj.get(s["date"])
                    if t:
                        cl_d, mo_d, probs = t
                        tcells = (f"<td style='color:#ffb020'>"
                                  f"${cl_d/1e6:,.0f}M</td>"
                                  f"<td style='color:var(--accent)'>"
                                  + (f"${mo_d/1e6:,.0f}M" if mo_d else "--")
                                  + "</td>"
                                  + "".join(f"<td>{p:.0%}</td>" for p in probs))
                    else:
                        tcells = "<td></td><td></td>" +                                  "<td></td>" * len(wins)
                rows += (f"<tr><td>{s['date']}</td>"
                         f"<td>{d0.strftime('%a')}</td>"
                         f"<td>${s['gross']/1e6:,.1f}M</td>"
                         + pcell + tcells +
                         f"<td class='hide-m'>{wow}</td>"
                         f"<td>${cume/1e6:,.1f}M</td></tr>")
            model_path_html = ""
            fut = fc.get("future_path") or []
            if fut:
                frows = ""
                run = float(fc.get("cume_to_date") or
                            sum(s["gross"] for s in series))
                for x in fut:
                    run += x["gross"]
                    dd = datetime.strptime(x["date"], "%Y-%m-%d")
                    wknd = dd.weekday() >= 4
                    frows += (
                        f"<tr><td>{x['date']}</td>"
                        f"<td>{dd.strftime('%a')}</td>"
                        f"<td style='{'font-weight:600' if wknd else ''}"
                        f"color:var(--accent)'>${x['gross']/1e6:,.1f}M</td>"
                        f"<td style='color:var(--dim)'>"
                        f"${run/1e6:,.1f}M</td></tr>")
                model_path_html = (
                    "<h3 style='font-size:15px;margin:14px 0 6px;"
                    "color:var(--dim)'>Upcoming days -- model path "
                    "(re-derived every run, not frozen)</h3>"
                    "<table><thead><tr><th>Date</th><th>Day</th>"
                    "<th>Model est.</th><th>Proj. cume</th></tr></thead>"
                    f"<tbody>{frows}</tbody></table>")
            sept_prereg = None
            sept_cards = ""
            if jcen:
                _k0 = sorted(jcen)[0]
                sept_prereg = jcen[_k0]
                sept_cards = (
                    "<div class='stat'><div class='lab'>Claude Sept "
                    f"pre-reg (read of {_k0})</div><div class='big' "
                    "style='color:var(--gold)'>"
                    f"${sept_prereg/1e6:,.0f}M</div></div>")
            _mo_path = os.path.join(HERE, "bo_data",
                                    "model_sept_open.json")
            if fc.get("target_date") == "2026-09-30":
                if not os.path.exists(_mo_path):
                    json.dump({"film": film["name"],
                               "central": fc["central"],
                               "captured": str(date.today())},
                              open(_mo_path, "w"))
                try:
                    _mo = json.load(open(_mo_path))
                    if _mo.get("film") == film["name"]:
                        sept_cards += (
                            "<div class='stat'><div class='lab'>Model "
                            f"Sept opening ({_mo['captured']})</div>"
                            "<div class='big'>"
                            f"${_mo['central']/1e6:,.0f}M</div></div>")
                except Exception:
                    pass
            sept_html = sept_book_html(
                film["name"], series[-1]["date"])
            prereg = CLAUDE_EOM.get(film["name"])
            # single forward look: tomorrow only, from each forecaster's
            # CURRENT thinking (frozen daily sheet retired from display --
            # its record lives on in the graded D-1 columns and the chart)
            future_rows_html = ""
            next_d = str(datetime.strptime(series[-1]["date"],
                                           "%Y-%m-%d").date()
                         + timedelta(days=1))
            cl_n = (claude_day_ahead(series, sheet, next_d)
                    if sheet else None) or jmap.get(next_d)
            mo_n = model_day_ahead(series, film, next_d)
            if cl_n or mo_n:
                nd = datetime.strptime(next_d, "%Y-%m-%d")
                future_rows_html = (
                    "<h3 style='font-size:15px;margin:14px 0 6px;"
                    "color:var(--dim)'>Tomorrow -- one-day-ahead calls "
                    "(graded when the actual lands)</h3>"
                    "<table><thead><tr><th>Date</th><th>Day</th>"
                    "<th>Claude D-1</th><th>Model D-1</th></tr></thead>"
                    f"<tbody><tr><td>{next_d}</td>"
                    f"<td>{nd.strftime('%a')}</td>"
                    "<td style='color:#ffb020;font-weight:600'>"
                    + (f"${cl_n/1e6:,.1f}M" if cl_n else "--") +
                    "</td><td style='color:var(--accent);font-weight:600'>"
                    + (f"${mo_n/1e6:,.1f}M" if mo_n else "--") +
                    "</td></tr></tbody></table>")
            # running one-day-ahead scoreboard: median |error| per forecaster
            actual_by_d = {s["date"]: s["gross"] for s in series}
            cl_errs, mo_errs = [], []
            for d, (cp, mp) in dayahead.items():
                if d in actual_by_d:
                    if cp:
                        cl_errs.append(abs(actual_by_d[d] / cp - 1))
                    if mp:
                        mo_errs.append(abs(actual_by_d[d] / mp - 1))
            score_card = ""
            if cl_errs or mo_errs:
                med = lambda v: sorted(v)[len(v) // 2]
                score_card = (
                    "<div class='stat'><div class='lab'>1-day-ahead "
                    "median |error|</div><div class='big' "
                    "style='font-size:20px'>"
                    "<span style='color:#ffb020'>Claude "
                    + (f"{med(cl_errs):.0%}" if cl_errs else "--")
                    + "</span> &nbsp;<span style='color:var(--accent)'>"
                    "Model "
                    + (f"{med(mo_errs):.0%}" if mo_errs else "--")
                    + f"</span></div><div style='color:var(--dim);"
                    f"font-size:12px'>{max(len(cl_errs), len(mo_errs))} "
                    "graded days</div></div>")
            ce = CLAUDE_EOM.get(film["name"])
            live_val = None
            sheet = CLAUDE_DAILY.get(film["name"], {})
            if sheet and any(s["date"] in sheet for s in series):
                live_val, w_adj, e_adj = claude_live(series, sheet)
            live_val += float(fc.get("cume_drift") or 0)
            claude_card = ""
            if live_val:
                claude_card += (
                    f"<div class='stat'><div class='lab'>Claude live "
                    f"(marked to market daily)</div>"
                    f"<div class='big' style='color:#ffb020'>"
                    f"${live_val/1e6:,.0f}M</div>"
                    f"<div style='color:var(--dim);font-size:12px'>"
                    f"weekdays x{w_adj:.2f}, weekends x{e_adj:.2f} vs frozen "
                    f"sheet</div></div>")
            if ce:
                claude_card = (
                    f"<div class='stat'><div class='lab'>Claude "
                    f"(pre-reg {ce['date']})</div>"
                    f"<div class='big' style='color:#ffb020'>"
                    f"${ce['central']/1e6:,.0f}M</div>"
                    f"<div style='color:var(--dim);font-size:12px'>80%: "
                    f"${ce['p80_lo']/1e6:,.0f}-{ce['p80_hi']/1e6:,.0f}M"
                    f"</div></div>")
            sections.append(
                f"<h2>{film['name']}</h2>"
                f"<div class='stat'><div class='lab'>Domestic to date "
                f"({fc['as_of']})</div><div class='big'>"
                f"${fc['cume_to_date']/1e6:,.0f}M</div></div>"
                f"<div class='stat'><div class='lab'>Model forecast "
                f"{fc['target_date']}</div><div class='big'>"
                f"${fc['central']/1e6:,.0f}M</div></div>"
                f"<div class='stat'><div class='lab'>80% range</div>"
                f"<div class='big' style='font-size:20px'>"
                f"${fc['p80_lo']/1e6:,.0f}-{fc['p80_hi']/1e6:,.0f}M</div></div>"
                + claude_card + sept_cards + score_card
                + proj_chart(traj, ({"central": sept_prereg}
                                    if sept_prereg else ce), wins) +
                "<h3 style='font-size:16px;margin:16px 0 6px'>Daily grosses"
                "</h3>"
                "<table><thead><tr><th>Date</th><th>Day</th><th>Gross</th>"
                "<th>Claude D-1</th><th>&Delta;</th>"
                "<th>Model D-1</th><th>&Delta;</th>"
                "<th>Claude proj</th><th>Model proj</th>"
                + "".join(f"<th>{lab}</th>" for lab, _ in wins)
                + "<th class='hide-m'>vs same day last wk</th><th>Cume</th>"
                "</tr></thead><tbody>" + rows + "</tbody></table>"
                + future_rows_html + model_path_html + sept_html)
        body = "<hr style='border:0;border-top:1px solid #1e2a44;"               "margin:30px 0'>".join(sections)
    rumors_html = ""
    rpath = os.path.join(HERE, "bo_data", "rumors.json")
    rumor_rows = ""
    if os.path.exists(rpath):
        try:
            rstate = json.load(open(rpath))
            for it in reversed(rstate.get("items", [])):
                rumor_rows += (
                    f"<tr><td style='white-space:nowrap'>{it['seen'][5:16]}"
                    f"</td><td>{it['film'].split(':')[0]}</td>"
                    f"<td>{it['snippet']}</td>"
                    f"<td><a href='{it['url']}' style='color:var(--accent)'>"
                    f"{it['source'][:40]}</a></td></tr>")
        except Exception:
            pass
    rumors_html = (
        "<h2 style='color:var(--warm)'>Rumor Board</h2>"
        "<div class='sub'>Unverified early reads scraped from trade coverage "
        "-- estimates, leaks, and in-progress numbers. <b>Display only:</b> "
        "nothing here touches the models, projections, or probabilities. "
        "The board wipes itself the moment finalized numbers land in the "
        "tables above.</div>"
        + ("<table><thead><tr><th>Seen</th><th>Film</th><th>What was said"
           "</th><th>Source</th></tr></thead><tbody>" + rumor_rows +
           "</tbody></table>" if rumor_rows else
           "<div class='sub' style='color:var(--dim)'>No unconfirmed reads "
           "right now -- the board is clean.</div>"))
    html = f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Wins + Dingers -- Box Office</title><style>{CSS}</style></head>
<body><div class="wrap">{NAV}
<h1 style="font-size:22px">Box Office Tracker</h1>
{body}
{rumors_html}
<div class="foot">Daily grosses pulled automatically (Box Office Mojo first,
The-Numbers fallback; hand-verified overrides when both garble). The chart
traces each forecaster's August-31 projection day by day -- gold is
Claude-live (the frozen daily sheet marked to market by a fixed rule:
weekday deviations apply fully to future weekdays, half-transfer to
weekends until real weekend data arrives), blue is the momentum model,
each recomputed on only that day's available data. Convergence means
agreement; jumps mean that day's actual moved someone. The dashed gold
horizontal is the pre-registered forecast, frozen forever. Daily grading
is one-day-ahead: each morning's Claude D-1 and Model D-1 are what each
forecaster said <i>yesterday</i> about <i>today</i>, on yesterday's data
-- latest thinking, not first thinking. The frozen sheet is retired from
daily display but still steers Claude-live's weekday shape. The table's
outcome-window percentages come from the Claude-live projection with a
mechanical band (12% of still-unearned dollars), so they move only when
the data moves. Updated {ts.strftime('%B %d, %Y %I:%M %p ET')}.</div>
</div></body></html>"""
    with open(OUT, "w") as f:
        f.write(html)
    print("wrote bo.html")


if __name__ == "__main__":
    build()
