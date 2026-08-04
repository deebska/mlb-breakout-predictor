"""
RESULTS PAGE GENERATOR v1.0 (baseballbreakouts.com/results.html)
Yesterday's homers (board format, green), the day's expected-vs-actual,
and the all-time aggregate scoreboard from results_log.csv.
Run after track_results.py score:  python make_results_page.py
"""

import os
import pandas as pd
from datetime import datetime
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
LOG = os.path.join(HERE, "results_log.csv")
PRED_DIR = os.path.join(HERE, "predictions")
OUT = os.path.join(HERE, "results.html")

BUCKETS = [(0.00, 0.10), (0.10, 0.15), (0.15, 0.20), (0.20, 0.25), (0.25, 1.0)]

CSS = """
:root{--bg:#0b1220;--card:#121b2e;--row:#0f1728;--txt:#e8eef7;--dim:#8b97ab;
--green:#3ddc84;--accent:#4da3ff;--line:#1e2a44}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--txt);
font:15px/1.45 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}
.wrap{max-width:1060px;margin:0 auto;padding:28px 16px 60px}
h1{font-size:26px;margin:0 0 4px}h2{font-size:19px;margin:26px 0 8px}
.sub{color:var(--dim);margin-bottom:18px;font-size:14px}
a{color:var(--accent);text-decoration:none}
table{width:100%;border-collapse:collapse;background:var(--card);
border-radius:12px;overflow:hidden}
th{background:#16223b;text-align:left;padding:10px;font-size:12px;
letter-spacing:.04em;text-transform:uppercase;color:var(--dim)}
td{padding:9px 10px;border-top:1px solid var(--line);
font-variant-numeric:tabular-nums}
tr:nth-child(even) td{background:var(--row)}
.hr td{color:var(--green);font-weight:600}
.big{font-size:30px;font-weight:800;color:var(--green)}
.stat{display:inline-block;background:var(--card);border-radius:12px;
padding:14px 18px;margin:4px 8px 4px 0;min-width:150px}
.stat .lab{color:var(--dim);font-size:12px;text-transform:uppercase}
.foot{color:var(--dim);font-size:13px;margin-top:22px;line-height:1.6}
@media(max-width:720px){.hide-m{display:none}}
"""


def fmt_odds(v):
    s = str(v)
    if s.lstrip("-").isdigit() and not s.startswith(("-", "+")):
        s = "+" + s
    return s


def build():
    if not os.path.exists(LOG):
        print("no results_log.csv yet -- run track_results.py score first")
        return False
    log = pd.read_csv(LOG)
    if log.empty:
        return False
    day = sorted(log["date"].unique())[-1]
    d = log[log["date"] == day]

    # join back to that day's board snapshot for full row context
    snap_path = os.path.join(PRED_DIR, f"{day}.csv")
    if not os.path.exists(snap_path):
        snap_path = os.path.join(HERE, "hr_board.csv")
    snap = pd.read_csv(snap_path) if os.path.exists(snap_path) else pd.DataFrame()

    hr_rows = ""
    hrs = d[d["hr"] == 1].sort_values("p_hr", ascending=False)
    for i, (_, r) in enumerate(hrs.iterrows(), start=1):
        ctx = snap[snap["player"] == r["player"]]
        c = ctx.iloc[0] if not ctx.empty else {}
        hr_rows += (f"<tr class='hr'><td>{i}</td><td><b>{r['player']}</b></td>"
                    f"<td>{c.get('park','')}</td>"
                    f"<td class='hide-m'>{c.get('vs_sp','')}</td>"
                    f"<td>{r['p_hr']:.1%}</td>"
                    f"<td>{fmt_odds(c.get('fair_odds',''))}</td></tr>")

    exp, act = d["p_hr"].sum(), int(d["hr"].sum())
    day_buckets = ""
    for lo, hi in BUCKETS:
        b = d[(d["p_hr"] >= lo) & (d["p_hr"] < hi)]
        if len(b):
            day_buckets += (f"<tr><td>{lo:.0%}-{hi:.0%}</td><td>{len(b)}</td>"
                            f"<td>{b['p_hr'].mean():.1%}</td>"
                            f"<td>{b['hr'].mean():.1%}</td></tr>")

    # all-time aggregate
    n, tot_hr = len(log), int(log["hr"].sum())
    days_n = log["date"].nunique()
    pred_rate, real_rate = log["p_hr"].mean(), log["hr"].mean()
    brier = float(((log["p_hr"] - log["hr"]) ** 2).mean())
    base = float(((pred_rate - log["hr"]) ** 2).mean())
    edge_word = "beating" if brier < base else "behind"
    agg_buckets = ""
    for lo, hi in BUCKETS:
        b = log[(log["p_hr"] >= lo) & (log["p_hr"] < hi)]
        if len(b):
            agg_buckets += (f"<tr><td>{lo:.0%}-{hi:.0%}</td><td>{len(b)}</td>"
                            f"<td>{b['p_hr'].mean():.1%}</td>"
                            f"<td>{b['hr'].mean():.1%}</td></tr>")
    top = log.sort_values("p_hr", ascending=False).groupby("date").head(10)

    html = f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Results -- Baseball Breakouts</title><style>{CSS}</style></head>
<body><div class="wrap">
<h1>Results</h1>
<div class="sub"><a href="/hrboard.html">&larr; back to tonight's board</a></div>

<h2>Who homered -- {day}</h2>
<table><thead><tr><th>#</th><th>Player</th><th>Park</th>
<th class="hide-m">Opposing SP</th><th>Model P(HR)</th><th>Fair odds</th></tr>
</thead><tbody>{hr_rows}</tbody></table>

<h2>The day vs the model</h2>
<div class="stat"><div class="lab">Model expected</div>
<div class="big">{exp:.1f}</div></div>
<div class="stat"><div class="lab">Actually homered</div>
<div class="big">{act}</div></div>
<div class="stat"><div class="lab">Predictions scored</div>
<div class="big">{len(d)}</div></div>
<table style="margin-top:12px"><thead><tr><th>Bucket</th><th>N</th>
<th>Predicted</th><th>Realized</th></tr></thead>
<tbody>{day_buckets}</tbody></table>

<h2>All-time model scoreboard</h2>
<div class="stat"><div class="lab">Days tracked</div>
<div class="big">{days_n}</div></div>
<div class="stat"><div class="lab">Predictions</div>
<div class="big">{n:,}</div></div>
<div class="stat"><div class="lab">Predicted / realized HR rate</div>
<div class="big">{pred_rate:.1%} / {real_rate:.1%}</div></div>
<div class="stat"><div class="lab">Top-10 picks: HRs vs expected</div>
<div class="big">{int(top['hr'].sum())} / {top['p_hr'].sum():.1f}</div></div>
<table style="margin-top:12px"><thead><tr><th>Bucket</th><th>N</th>
<th>Predicted</th><th>Realized</th></tr></thead>
<tbody>{agg_buckets}</tbody></table>
<div class="foot">Brier score {brier:.4f} vs constant-forecast baseline
{base:.4f} ({edge_word} it -- lower is better). Every prediction is frozen
at publish time and scored against Statcast the next morning; scratched
players are excluded. Small samples early -- calibration takes weeks.</div>
</div></body></html>"""
    with open(OUT, "w") as f:
        f.write(html)
    print(f"wrote results.html ({day}: {act} HRs from {len(d)} scored; "
          f"all-time n={n})")
    return True


if __name__ == "__main__":
    build()
