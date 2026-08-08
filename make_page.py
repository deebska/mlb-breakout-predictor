"""
HR BOARD -> WEB PAGE v1.0 (baseballbreakouts.com)
Reads hr_board.csv (from board.py) and writes hrboard.html --
a self-contained static page for the repo's public/ folder.
Run after board.py:  python make_page.py
"""

import os
import sys
import pandas as pd
from datetime import date

def baseball_today():
    """The slate date: today in US/Eastern, baseball's clock (UTC servers
    would otherwise roll the date at 8pm ET)."""
    from datetime import datetime
    from zoneinfo import ZoneInfo
    return datetime.now(ZoneInfo("America/New_York")).date()


HERE = os.path.dirname(os.path.abspath(__file__))

# Maker-bid margin: suggested max bid = fair price x (1 - MARGIN).
# 0.18 means "only rest bids at least 18% below the model's fair value"
# -- the buffer that covers model error + adverse selection on resting orders.
BID_MARGIN = 0.18
CSV = os.path.join(HERE, "hr_board.csv")
OUT = os.path.join(HERE, "hrboard.html")

CSS = """
:root{--bg:#0b1220;--card:#121b2e;--row:#0f1728;--txt:#e8eef7;--dim:#8b97ab;
--hot:#ff6b6b;--warm:#ffb020;--accent:#4da3ff;--line:#1e2a44}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--txt);
font:15px/1.45 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}
.wrap{max-width:1060px;margin:0 auto;padding:28px 16px 60px}
h1{font-size:26px;margin:0 0 4px}
.sub{color:var(--dim);margin-bottom:22px;font-size:14px}
table{width:100%;border-collapse:collapse;background:var(--card);
border-radius:12px;overflow:hidden}
th{position:sticky;top:0;background:#16223b;text-align:left;padding:10px 10px;
font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:var(--dim)}
td{padding:9px 10px;border-top:1px solid var(--line);font-variant-numeric:tabular-nums}
tr:nth-child(even) td{background:var(--row)}
.p{font-weight:700}.hot .p{color:var(--hot)}.warm .p{color:var(--warm)}
.fair{color:var(--accent);font-weight:600}
.badge{display:inline-block;background:#1c2a47;border-radius:6px;
padding:1px 7px;font-size:12px;color:var(--dim)}
.foot{color:var(--dim);font-size:13px;margin-top:22px;line-height:1.6}
@media(max-width:720px){.hide-m{display:none}}
"""

def build(csv_path=CSV, out_path=OUT):
    df = pd.read_csv(csv_path).sort_values("p_hr_tonight", ascending=False)
    games_html = ""
    gpath = os.path.join(os.path.dirname(csv_path), "hr_games.csv")
    if os.path.exists(gpath):
        gdf = pd.read_csv(gpath).sort_values("exp_hr", ascending=False)
        grows = "".join(
            f"<tr><td><b>{g['game']}</b></td><td>{g['park']}</td>"
            f"<td class='p'>{g['exp_hr']:.2f}</td>"
            f"<td>{g['p_over_2_5']:.0%}</td></tr>"
            for _, g in gdf.iterrows())
        games_html = (
            "<h2 style='font-size:19px;margin:26px 0 8px'>Game HR totals</h2>"
            "<table><thead><tr><th>Game</th><th>Park</th>"
            "<th>Exp. HR</th><th>P(3+ HR)</th></tr></thead>"
            f"<tbody>{grows}</tbody></table>"
            "<div class='sub' style='margin-top:8px'>Expected combined home "
            "runs, both teams, from summing every hitter's modeled rate; "
            "P(3+) is the Poisson chance the game clears a 2.5 line.</div>")
    has_mkt = "mkt_prob" in df.columns and df["mkt_prob"].notna().any()
    rows = []
    for i, (_, r) in enumerate(df.iterrows(), start=1):
        p = float(r["p_hr_tonight"])
        cls = "hot" if p >= 0.28 else ("warm" if p >= 0.22 else "")
        mkt_cells = ""
        if has_mkt:
            if pd.notna(r.get("mkt_prob")):
                e = float(r["edge"])
                ecol = "#3ddc84" if e >= 0.02 else ("#ff6b6b" if e <= -0.02
                                                    else "var(--dim)")
                bo = int(r["best_over_odds"])
                mkt_cells = (f"<td>{float(r['mkt_prob']):.1%}</td>"
                             f"<td class='hide-m'>{'+' if bo>0 else ''}{bo}</td>"
                             f"<td style='color:{ecol};font-weight:700'>"
                             f"{e:+.1%}</td>")
            else:
                mkt_cells = "<td></td><td class='hide-m'></td><td></td>"
        fo = str(r["fair_odds"])
        if fo.lstrip("-").isdigit() and not fo.startswith(("-", "+")):
            fo = "+" + fo
        rows.append(
          f"<tr class='{cls}'><td>{i}</td>"
          f"<td><b>{r['player']}</b> <span class='badge'>{r['bats']}HB"
          f" &middot; #{int(r['slot'])}</span></td>"
          f"<td>{r['park']}</td>"
          f"<td class='hide-m'>{r['vs_sp']}</td>"
          f"<td class='hide-m'>x{float(r['env_mult']):.2f}</td>"
          f"<td class='p'>{p:.1%}</td>"
          f"<td class='fair'>{fo}</td>"
          f"<td>{round(p*100)}&cent;</td>"
          f"<td style='color:#3ddc84;font-weight:600'>"
          f"{int(p*100*(1-BID_MARGIN))}&cent;</td>"
          + mkt_cells +
          f"<td class='hide-m'>{int(r['bbe_sample'])}</td></tr>")
    mkt_head = ("<th>Market</th><th class='hide-m'>Best price</th>"
                "<th>Edge</th>") if has_mkt else ""
    html = f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>HR Probability Board -- Baseball Breakouts</title>
<meta name="description" content="Daily home run probabilities for every hitter
in every posted MLB lineup, from Statcast contact-quality talent, park, weather,
matchup and lineup-slot modeling.">
<style>{CSS}</style></head><body><div class="wrap">
<h1>Tonight's HR Probability Board</h1>
<div class="sub" style="margin-bottom:6px"><a href="/results.html"
style="color:var(--accent);text-decoration:none">Yesterday's results &amp;
model scoreboard &rarr;</a> &nbsp;&middot;&nbsp; <a href="/nfl.html"
style="color:var(--accent);text-decoration:none">NFL 5-factor system
&rarr;</a></div>
<div class="sub">{baseball_today().strftime('%B %d, %Y')} &middot; {len(df)} hitters
in posted lineups &middot; model chain: Statcast talent &rarr; starter matchup
&rarr; park &times; temp &times; wind &rarr; lineup-slot plate appearances</div>
<table><thead><tr><th>#</th><th>Player</th><th>Park</th>
<th class="hide-m">Opposing SP</th><th class="hide-m">Env</th>
<th>P(HR)</th><th>Fair odds</th><th>Fair &cent;</th>
<th>Bid &le;</th>{mkt_head}<th class="hide-m">BBE</th></tr></thead>
<tbody>{''.join(rows)}</tbody></table>
{games_html}
<div class="foot">
<b>How to read it:</b> "Fair &cent;" is the model's probability as a
prediction-market price; "Bid &le;" is the maximum resting bid that keeps an
{int(BID_MARGIN*100)}%+ edge after the maker's margin -- offers above it are
paying more than the model thinks the outcome is worth. P(HR) is the model's probability the player hits at least
one home run tonight. "Fair odds" is that probability expressed as an American
line -- a posted price longer than fair suggests value, shorter suggests the
market likes him more than the model does. BBE is the batted-ball sample behind
his talent estimate; small samples are regressed hard toward league average.<br><br>
Model probabilities, not betting advice. Environment factors are approximations
under continuous calibration. Lineups update through the afternoon; rerun snapshots
may differ.</div>
</div></body></html>"""
    with open(out_path, "w") as f:
        f.write(html)
    print(f"wrote {out_path} ({len(df)} hitters)")

if __name__ == "__main__":
    build(sys.argv[1] if len(sys.argv) > 1 else CSV)
