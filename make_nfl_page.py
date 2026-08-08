"""
NFL SYSTEM PAGE GENERATOR v1.0 -> nfl.html
Renders the Aaron Brown 5-factor picks table (or the off-season/armed
state), with the system's rules and running record.
Run after nfl_system.py update:  python make_nfl_page.py
"""

import os
import pandas as pd
from datetime import datetime
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
PICKS = os.path.join(HERE, "nfl_picks.csv")
NFL_LOG = os.path.join(HERE, "nfl_results_log.csv")
OUT = os.path.join(HERE, "nfl.html")

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
th{background:#16223b;text-align:left;padding:10px;font-size:12px;
letter-spacing:.04em;text-transform:uppercase;color:var(--dim)}
td{padding:9px 10px;border-top:1px solid var(--line);
font-variant-numeric:tabular-nums}
tr:nth-child(even) td{background:var(--row)}
.bet td{color:var(--green);font-weight:700}
.foot{color:var(--dim);font-size:13px;margin-top:22px;line-height:1.7}
.badge{display:inline-block;background:#1c2a47;border-radius:8px;
padding:8px 14px;margin:4px 6px 4px 0;color:var(--warm);font-weight:600}
@media(max-width:720px){.hide-m{display:none}}
"""

RULES = """
<h2>The system (Aaron Brown, 2006 -- implemented verbatim)</h2>
<div class="foot" style="margin-top:6px">
Three factors from public data, scored per game:<br>
<b>1. Last-game turnovers:</b> +1 to a team with net giveaways in its last
game, &minus;1 with net takeaways. Turnovers are mostly luck; last week's
sloppy team is underrated, last week's opportunist is overrated.<br>
<b>2. Season-to-date covers:</b> +1 to a team that has covered less often
than not, &minus;1 to a chronic coverer. Books shade lines against popular
winners so their fans lose slowly.<br>
<b>3. Line movement:</b> +1 to the team the market has moved against since
the line first posted. Bettors over-react to news.<br><br>
Home total minus away total: <b>+3 or more, bet home; &minus;3 or less, bet
away; anything between, pass.</b> Historical record as published by Brown:
522-414 (55.8%) over 2006-2016, unmodified. This page runs those exact
rules on live data -- no additions, no tuning. Original write-up:
<a href="https://www.eraider.com/nfl-picks">eraider.com/nfl-picks</a>.</div>
"""


def build():
    ts = datetime.now(ZoneInfo("America/New_York"))
    if os.path.exists(PICKS):
        df = pd.read_csv(PICKS)
    else:
        df = pd.DataFrame()

    if df.empty:
        body = ('<div class="badge">ARMED -- waiting for the season</div>'
                '<div class="foot">Picks appear here automatically once '
                'Week 1 games and lines post. The engine is live and checks '
                'on every site update.</div>')
    else:
        season, week = int(df["season"].iloc[0]), int(df["week"].iloc[0])
        status = str(df["status"].iloc[0]) if "status" in df.columns else "LOCKED"
        banner = ("" if status == "LOCKED" else
                  "<div class='badge'>PREVIEW -- picks lock Wednesday at "
                  "then-current lines (Aaron Brown's original cadence); "
                  "nothing below is final</div>")
        rows = ""
        for _, r in df.iterrows():
            cls = "bet" if r["pick"] != "PASS" else ""
            sp = "" if pd.isna(r["spread_home"]) else f"{r['spread_home']:+.1f}"
            rows += (f"<tr class='{cls}'><td>{r['game']}</td>"
                     f"<td>{sp}</td>"
                     f"<td class='hide-m'>{int(r['home_lgt']):+d}/"
                     f"{int(r['away_lgt']):+d}</td>"
                     f"<td class='hide-m'>{int(r['home_stdc']):+d}/"
                     f"{int(r['away_stdc']):+d}</td>"
                     f"<td class='hide-m'>{int(r['home_move'])}/"
                     f"{int(r['away_move'])}</td>"
                     f"<td>{int(r['total']):+d}</td>"
                     f"<td><b>{r['pick']}</b></td></tr>")
        n_bets = int((df["pick"] != "PASS").sum())
        lock_note = " (locked)" if status == "LOCKED" else " (preview)"
        body = (banner +
                f"<h2>Season {season}, Week {week}{lock_note} -- "
                f"{n_bets} bets, {len(df) - n_bets} passes</h2>"
                "<table><thead><tr><th>Game</th><th>Home line</th>"
                "<th class='hide-m'>LGT h/a</th>"
                "<th class='hide-m'>STDC h/a</th>"
                "<th class='hide-m'>Move h/a</th>"
                "<th>Total</th><th>Pick</th></tr></thead>"
                f"<tbody>{rows}</tbody></table>"
                "<div class='sub' style='margin-top:8px'>Home line is the "
                "current spread (negative = home favored). Picks are valid "
                "at these lines only.</div>")

    record_html = ""
    if os.path.exists(NFL_LOG):
        log = pd.read_csv(NFL_LOG)
        if not log.empty:
            w = int((log["result"] == "WIN").sum())
            l = int((log["result"] == "LOSS").sum())
            pu = int((log["result"] == "PUSH").sum())
            pct = (w / (w + l) * 100) if (w + l) else 0.0
            rows2 = ""
            for _, r in log.sort_values(["season", "week"],
                                        ascending=False).iterrows():
                color = ("var(--green)" if r["result"] == "WIN" else
                         "#ff6b6b" if r["result"] == "LOSS" else "var(--dim)")
                rows2 += (f"<tr><td>Wk {int(r['week'])}</td>"
                          f"<td>{r['game']}</td><td><b>{r['pick']}</b> "
                          f"({r['line_at_pick']:+.1f})</td>"
                          f"<td class='hide-m'>{int(r['total']):+d}</td>"
                          f"<td style='color:{color};font-weight:700'>"
                          f"{r['result']}</td></tr>")
            record_html = (
                f"<h2>Our live record: {w}-{l}"
                + (f"-{pu}" if pu else "") + f" ({pct:.1f}%)</h2>"
                "<div class='sub'>Every bet the system fired, graded against "
                "the closing result at the line it was picked. Brown's "
                "long-run target was 55%; full juice needs 52.4% to break "
                "even.</div>"
                "<table><thead><tr><th>Week</th><th>Game</th><th>Pick "
                "(line)</th><th class='hide-m'>Signal</th><th>Result</th>"
                "</tr></thead><tbody>" + rows2 + "</tbody></table>")
    html = f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Wins + Dingers -- NFL 5-Factor System</title>
<style>{CSS}</style></head><body><div class="wrap">
<div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:18px"><div style="font-size:24px;font-weight:800;letter-spacing:-.02em">Wins <span style="color:#3ddc84">+</span> Dingers</div><div style="display:flex;gap:6px"><a href="/hrboard.html" style="padding:7px 14px;border-radius:9px;color:var(--accent);text-decoration:none;font-weight:600">HR Board</a> <a href="/results.html" style="padding:7px 14px;border-radius:9px;color:var(--accent);text-decoration:none;font-weight:600">Results</a> <a href="/nfl.html" style="padding:7px 14px;border-radius:9px;background:#1c2a47;color:#e8eef7;text-decoration:none;font-weight:600">NFL System</a></div></div>
<h1 style="font-size:22px">NFL 5-Factor System</h1>
{body}
{record_html}
{RULES}
<div class="foot">Updated {ts.strftime('%B %d, %Y %I:%M %p ET')}. A 2006
system running unmodified on 2026 data, for demonstration and tracking --
not betting advice. Its author would be the first to tell you past
performance guarantees nothing.</div>
</div></body></html>"""
    with open(OUT, "w") as f:
        f.write(html)
    print(f"wrote nfl.html ({'armed/off-season' if df.empty else f'{len(df)} games'})")


if __name__ == "__main__":
    build()
