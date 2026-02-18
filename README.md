# ⚾ MLB Breakout Predictor 2026

Advanced MLB player breakout prediction model using Baseball Savant Statcast data.

**Current Accuracy:** 80% (validated on 2023-2024 historical data)

## 🎯 What This Does

Predicts which MLB players are likely to "break out" in 2026 based on:
- xwOBA surplus (unlucky players due for positive regression)
- Contact quality metrics (hard-hit rate, barrel rate)
- Plate discipline (chase rate, K-rate)
- Bat tracking data (bat speed - NEW in 2024!)
- Launch angle changes (swing adjustments)
- Career context (down years vs. career years)
- Age curves and experience levels

## 📊 Model Features

### Core Signals (v3.1)
- **xwOBA Surplus** (28%) - Players outperforming/underperforming expected stats
- **Trajectory** (18%) - Year-over-year skill improvement
- **Contact Quality** (28%) - Hard-hit rate + barrel rate
- **Plate Discipline** (13%) - K-rate inverse (contact ability)
- **xwOBA Level** (13%) - Absolute skill floor

### Contextual Adjustments
- Age curve multipliers (21-24 prime breakout years)
- Sample size confidence tiers
- K-rate penalties (30%+ strikeout rate)
- Career context (career year vs. down year)
- Chase rate filtering (approach issues)
- Bat speed boosts (74+ mph)
- Launch angle change detection
- Pull rate adjustments (shift ban era)
- Sophomore slump detector
- Years of service penalties

## 🚀 Quick Start

### Local Development

```bash
npm install
npm run dev
```

Open http://localhost:5173

### Deploy to Vercel

1. Push to GitHub
2. Import to Vercel
3. Deploy (auto-detected as Vite project)

See `DEPLOY.md` for detailed instructions.

## 📁 Project Structure

```
├── index.html          # Entry point
├── package.json        # Dependencies
├── vite.config.js      # Build configuration
└── src/
    ├── main.jsx        # React entry
    └── App.jsx         # Main application (full model)
```

## 🔮 Breakout Definition

A "breakout" is defined as achieving ANY of:
- wOBA improvement +.030 or more
- wRC+ improvement +20 or more
- 25+ HR power surge (when previously <20)
- 20+ SB speed surge (when previously <10)
- Top-60 at position by fantasy value

## 📈 Historical Performance

| Year | Accuracy | Notable Successes |
|------|----------|-------------------|
| 2023 | 80% (4/5) | Yandy Díaz (batting champ), Luis Robert (38 HR), Corbin Carroll (ROY) |
| 2024 | 80% (4/5) | Bobby Witt Jr. (MVP runner-up), Jarren Duran (All-Star) |

## 🛠️ Tech Stack

- **Frontend:** React 18.3 (Vite)
- **Data Source:** Baseball Savant (free, public)
- **Deployment:** Vercel
- **Analytics:** (Optional) Plausible or Google Analytics

## 📊 Data Sources

All data from Baseball Savant (MLB.com):
1. Expected Statistics
2. Plate Discipline
3. Bat Tracking (NEW 2024)
4. Batted Ball metrics
5. Exit Velocity
6. Sprint Speed

## 🔄 Future Enhancements

- [ ] Daily auto-updates (Vercel Cron)
- [ ] Backend API (Vercel Serverless Functions)
- [ ] Historical accuracy tracking
- [ ] Email alerts for big movers
- [ ] Mobile app (React Native)
- [ ] Public API for external use

## 📝 License

MIT License - feel free to use and modify!

## 🤝 Contributing

Found a bug or have a feature request? Open an issue!

## 📧 Contact

Questions? Feedback? Reach out!

---

**Model Version:** 3.1  
**Last Updated:** February 2026  
**Accuracy:** 80% (validated)
