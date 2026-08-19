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
 "Spider-Man: Brand New Day": [("&lt;900", (None, 900e6)),
                               ("900+", (900e6, None))],
 "The Odyssey": [("530-550", (530e6, 550e6)),
                 ("550-570", (550e6, 570e6)),
                 ("570+", (570e6, None))],
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
Aug 31 projection, day by day</text>
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

    cume, pts = 0.0, []
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
            traj = {}
            if sheet_start:
                hist = []
                for s in series:
                    hist.append(s)
                    if s["date"] < sheet_start:
                        continue
                    tdf = pd.DataFrame([{"film": film["name"], "date": x["date"],
                                         "daily": x["gross"],
                                         "reported_cume": None} for x in hist])
                    fc_d = bo_forecast(tdf, film)
                    cl_d, _, _ = claude_live(hist, sheet)
                    cume_d = sum(x["gross"] for x in hist)
                    probs = eom_prob_windows(cl_d, cume_d,
                                             [w for _, w in wins])
                    traj[s["date"]] = (cl_d,
                                       fc_d["central"] if fc_d else None,
                                       probs)
            rows = ""
            cume = 0.0
            for s in series:
                cume += s["gross"]
                d0 = datetime.strptime(s["date"], "%Y-%m-%d").date()
                wow = ""
                prev = [x for x in series
                        if x["date"] == str(d0 - timedelta(days=7))]
                if prev:
                    wow = f"{(s['gross']/prev[0]['gross']-1)*100:+.0f}%"
                pred = CLAUDE_DAILY.get(film["name"], {}).get(s["date"])
                if pred:
                    dv = (s["gross"] / pred - 1) * 100
                    dcol = ("#3ddc84" if abs(dv) <= 15 else
                            "#ffb020" if abs(dv) <= 30 else "#ff6b6b")
                    pcell = (f"<td>${pred/1e6:,.1f}M</td>"
                             f"<td style='color:{dcol};font-weight:600'>"
                             f"{dv:+.0f}%</td>")
                else:
                    pcell = "<td></td><td></td>"
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
            prereg = CLAUDE_EOM.get(film["name"])
            have_dates = {s["date"] for s in series}
            fut = [(d, v) for d, v in
                   sorted(CLAUDE_DAILY.get(film["name"], {}).items())
                   if d not in have_dates]
            future_rows_html = ""
            if fut:
                frows = "".join(
                    f"<tr><td>{d}</td>"
                    f"<td>{datetime.strptime(d,'%Y-%m-%d').strftime('%a')}</td>"
                    f"<td style='color:var(--dim)'>--</td>"
                    f"<td>${v/1e6:,.1f}M</td><td></td>"
                    f"<td class='hide-m'></td><td></td></tr>"
                    for d, v in fut)
                future_rows_html = (
                    "<h3 style='font-size:15px;margin:14px 0 6px;"
                    "color:var(--dim)'>Upcoming days -- Claude's frozen sheet"
                    "</h3><table><thead><tr><th>Date</th><th>Day</th>"
                    "<th>Gross</th><th>Claude pred</th><th>&Delta;</th>"
                    "<th class='hide-m'></th><th></th></tr></thead><tbody>"
                    + frows + "</tbody></table>")
            ce = CLAUDE_EOM.get(film["name"])
            live_val = None
            sheet = CLAUDE_DAILY.get(film["name"], {})
            if sheet and any(s["date"] in sheet for s in series):
                live_val, w_adj, e_adj = claude_live(series, sheet)
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
                + claude_card
                + proj_chart(traj, ce, wins) +
                "<h3 style='font-size:16px;margin:16px 0 6px'>Daily grosses"
                "</h3>"
                "<table><thead><tr><th>Date</th><th>Day</th><th>Gross</th>"
                "<th>Claude pred</th><th>&Delta;</th>"
                "<th>Claude proj</th><th>Model proj</th>"
                + "".join(f"<th>{lab}</th>" for lab, _ in wins)
                + "<th class='hide-m'>vs same day last wk</th><th>Cume</th>"
                "</tr></thead><tbody>" + rows + "</tbody></table>"
                + future_rows_html)
        body = "<hr style='border:0;border-top:1px solid #1e2a44;"               "margin:30px 0'>".join(sections)
    html = f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Wins + Dingers -- Box Office</title><style>{CSS}</style></head>
<body><div class="wrap">{NAV}
<h1 style="font-size:22px">Box Office Tracker</h1>
{body}
<div class="foot">Daily grosses from The-Numbers, pulled automatically each
morning. The green line is actual cumulative domestic gross; the blue dashed
line and cone are the model's projection to month-end (per-weekday geometric
decay fit to recent weeks, 80% band). The chart traces each forecaster's August-31 projection
day by day -- gold is Claude-live, blue is the momentum model, each
recomputed on only that day's available data; convergence means agreement,
jumps mean that day's actual moved someone. The dashed gold horizontal is
the pre-registered forecast, frozen forever. (Legacy note: "Claude live" -- the same
sheet marked to market daily by a fixed rule (observed weekday deviations
apply fully to future weekdays, half-transfer to weekends until real
weekend data arrives). Three forecasters, one chart: the momentum model,
the frozen human call, and the human's disciplined daily update. The daily
table's "Claude proj" and "Model proj" columns replay each forecaster on
only the data available through that date -- how each day's actual moved
each August-31 projection. The outcome-window percentages come from the
Claude-live projection with a mechanical uncertainty band (12% of
still-unearned dollars), so they move only when the data moves. Updated {ts.strftime('%B %d, %Y %I:%M %p ET')}.</div>
</div></body></html>"""
    with open(OUT, "w") as f:
        f.write(html)
    print("wrote bo.html")


if __name__ == "__main__":
    build()
