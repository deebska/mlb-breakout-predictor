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

    def p_to_american(p):
        if p <= 0 or p >= 1:
            return ""
        return f"+{round(100*(1-p)/p)}" if p < 0.5 else f"-{round(100*p/(1-p))}"

    # board rank = position within that day's full scored slate by model P(HR)
    ranked = d.sort_values("p_hr", ascending=False).reset_index(drop=True)
    rank_of = {row["player"]: i + 1 for i, row in ranked.iterrows()}

    # only trust snapshot context if a true frozen snapshot exists for the day
    snap_ok = os.path.exists(os.path.join(PRED_DIR, f"{day}.csv"))

    hr_rows = ""
    hrs = d[d["hr"] == 1].sort_values("p_hr", ascending=False)
    for _, r in hrs.iterrows():
        park = ""
        if snap_ok:
            ctx = snap[snap["player"] == r["player"]]
            if not ctx.empty:
                park = ctx.iloc[0].get("park", "")
        hr_rows += (f"<tr class='hr'><td>#{rank_of.get(r['player'], '?')} "
                    f"of {len(d)}</td>"
                    f"<td><b>{r['player']}</b></td>"
                    f"<td>{park}</td>"
                    f"<td>{r['p_hr']:.1%}</td>"
                    f"<td>{p_to_american(float(r['p_hr']))}</td></tr>")

    exp, act = d["p_hr"].sum(), int(d["hr"].sum())
    day_buckets = ""
    for lo, hi in BUCKETS:
        b = d[(d["p_hr"] >= lo) & (d["p_hr"] < hi)]
        if len(b):
            day_buckets += (f"<tr><td>{lo:.0%}-{hi:.0%}</td><td>{len(b)}</td>"
                            f"<td>{b['p_hr'].mean():.1%}</td>"
                            f"<td>{b['hr'].mean():.1%}</td></tr>")

    # current-era aggregate (the newest model version's record since inception)
    if "model_ver" not in log.columns:
        log["model_ver"] = "v1.0-legacy"
    log["model_ver"] = log["model_ver"].fillna("v1.0-legacy")
    latest_day = log.sort_values("date")["date"].iloc[-1]
    cur_ver = log[log["date"] == latest_day]["model_ver"].iloc[-1]
    legacy = log[log["model_ver"] != cur_ver]
    log = log[log["model_ver"] == cur_ver]
    era_start = log["date"].min()
    legacy_note = (f"Previous model versions: {len(legacy):,} predictions, "
                   f"predicted {legacy['p_hr'].mean():.1%} vs realized "
                   f"{legacy['hr'].mean():.1%} -- retired after the level "
                   f"recalibration. " if len(legacy) else "")
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
<title>Wins + Dingers -- Results</title><style>{CSS}</style></head>
<body><div class="wrap">
<div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:18px"><div style="font-size:24px;font-weight:800;letter-spacing:-.02em">Wins <span style="color:#3ddc84">+</span> Dingers</div><div style="display:flex;gap:6px"><a href="/hrboard.html" style="padding:7px 14px;border-radius:9px;color:var(--accent);text-decoration:none;font-weight:600">HR Board</a> <a href="/results.html" style="padding:7px 14px;border-radius:9px;background:#1c2a47;color:#e8eef7;text-decoration:none;font-weight:600">Results</a> <a href="/nfl.html" style="padding:7px 14px;border-radius:9px;color:var(--accent);text-decoration:none;font-weight:600">NFL System</a><a href="/bo.html" style="padding:7px 14px;border-radius:9px;color:var(--accent);text-decoration:none;font-weight:600">Box Office</a></div></div>
<h1 style="font-size:22px">Results</h1>

<h2>Who homered -- {day}</h2>
<table><thead><tr><th>Board rank</th><th>Player</th><th>Park</th>
<th>Model P(HR)</th><th>Fair odds</th></tr>
</thead><tbody>{hr_rows}</tbody></table>
<div class="sub" style="margin-top:8px">Board rank is where the model placed
the player among all {len(d)} scored hitters that day -- low numbers were
called; high numbers were surprises.</div>

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

<h2>Model scoreboard -- current version ({cur_ver}, since {era_start})</h2>
<div class="stat"><div class="lab">Days tracked</div>
<div class="big">{days_n}</div></div>
<div class="stat"><div class="lab">Predictions</div>
<div class="big">{n:,}</div></div>
<div class="stat"><div class="lab">Predicted / realized HR rate</div>
<div class="big">{pred_rate:.1%} / {real_rate:.1%}</div></div>
<div class="stat"><div class="lab">Model bias vs reality</div>
<div class="big">{(pred_rate/real_rate-1)*100 if real_rate else 0:+.1f}%</div></div>
<div class="stat"><div class="lab">Top-10 picks: HRs vs expected</div>
<div class="big">{int(top['hr'].sum())} / {top['p_hr'].sum():.1f}</div></div>
<table style="margin-top:12px"><thead><tr><th>Bucket</th><th>N</th>
<th>Predicted</th><th>Realized</th></tr></thead>
<tbody>{agg_buckets}</tbody></table>
<div class="foot">{legacy_note}Brier score {brier:.4f} vs constant-forecast baseline
{base:.4f} ({edge_word} it -- lower is better). "Model bias vs reality" is the running gap between what the model
predicted and what happened -- positive means the model runs hot; it needs
roughly two weeks of days before it stabilizes into a trustworthy number.
Every prediction is frozen
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
