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

from box_office import TRACKED

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


def svg_chart(series, fc, prereg, w=980, h=340):
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
{pre}
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
                rows += (f"<tr><td>{s['date']}</td>"
                         f"<td>{d0.strftime('%a')}</td>"
                         f"<td>${s['gross']/1e6:,.1f}M</td>"
                         f"<td class='hide-m'>{wow}</td>"
                         f"<td>${cume/1e6:,.1f}M</td></tr>")
            prereg = film.get("preregistered")
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
                + svg_chart(series, fc, prereg) +
                "<h3 style='font-size:16px;margin:16px 0 6px'>Daily grosses"
                "</h3>"
                "<table><thead><tr><th>Date</th><th>Day</th><th>Gross</th>"
                "<th class='hide-m'>vs same day last wk</th><th>Cume</th>"
                "</tr></thead><tbody>" + rows + "</tbody></table>")
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
decay fit to recent weeks, 80% band). The gold marker is the pre-registered
forecast, frozen before the projection model existed -- so both the model and
its author stay honest. Updated {ts.strftime('%B %d, %Y %I:%M %p ET')}.</div>
</div></body></html>"""
    with open(OUT, "w") as f:
        f.write(html)
    print("wrote bo.html")


if __name__ == "__main__":
    build()
