# 🚀 Deploy to Vercel - Quick Checklist

## ✅ Pre-Flight Checklist

Before you start, make sure you have:
- [ ] GitHub account (https://github.com/signup)
- [ ] Git installed on your computer
- [ ] Node.js installed (https://nodejs.org - get LTS version)
- [ ] A code editor (VS Code recommended)

---

## 📦 Step 1: Extract Project Files (2 min)

1. Download the `vercel-project.tar.gz` file
2. Extract it to a folder on your computer
3. Open Terminal/Command Prompt
4. Navigate to the folder:
   ```bash
   cd path/to/vercel-project
   ```

---

## 🧪 Step 2: Test Locally (3 min)

```bash
npm install
npm run dev
```

Open http://localhost:5173 - you should see the MLB Breakout Predictor!

Press Ctrl+C to stop the dev server.

---

## 📤 Step 3: Push to GitHub (5 min)

### Initialize Git
```bash
git init
git add .
git commit -m "Initial commit: MLB Breakout Predictor v3.1"
```

### Create GitHub Repo
1. Go to https://github.com/new
2. Name: `mlb-breakout-predictor`
3. Public or Private (your choice)
4. Click "Create repository"

### Push Code
```bash
# GitHub will show you these commands - copy them:
git remote add origin https://github.com/YOUR-USERNAME/mlb-breakout-predictor.git
git branch -M main
git push -u origin main
```

---

## 🎯 Step 4: Deploy to Vercel (3 min)

### Sign Up
1. Go to https://vercel.com
2. Click "Sign Up"
3. Choose "Continue with GitHub"

### Import Project
1. Click "Add New" → "Project"
2. Find `mlb-breakout-predictor`
3. Click "Import"

### Deploy
Vercel auto-detects settings:
- Framework: Vite ✅
- Build Command: `npm run build` ✅
- Output Directory: `dist` ✅

Click "Deploy" and wait ~2 minutes.

---

## 🎉 Step 5: Visit Your Site!

Vercel gives you a URL like:
```
https://mlb-breakout-predictor-abc123.vercel.app
```

**Your site is live!** 🚀

---

## 🌐 Optional: Add Custom Domain (5 min)

### Buy a Domain
Recommended registrars:
- Namecheap.com (~$10/year)
- Google Domains (~$12/year)
- Porkbun.com (~$8/year)

Good domain ideas:
- mlbbreakouts.com
- breakoutpredictor.com
- statcastbreakouts.com

### Connect to Vercel
1. Vercel Dashboard → Your Project → Settings → Domains
2. Add your domain
3. Copy the DNS records Vercel provides
4. Add them to your domain registrar's DNS settings
5. Wait 5-60 minutes for propagation

---

## 🔄 How to Update Your Site

Every time you want to deploy changes:

```bash
git add .
git commit -m "Description of changes"
git push
```

Vercel **automatically rebuilds** in ~2 minutes!

---

## ❗ Troubleshooting

### Build Failed?
Check Vercel deployment logs:
1. Vercel Dashboard → Deployments
2. Click failed deployment
3. View "Build Logs"

Common fixes:
```bash
# Missing dependencies
npm install
git add package*.json
git commit -m "Update dependencies"
git push
```

### Blank Page?
Open browser console (F12) and check for errors.
Usually means missing files or wrong paths.

### Changes Not Showing?
- Hard refresh: Ctrl+Shift+R (Windows) or Cmd+Shift+R (Mac)
- Check Vercel dashboard - deployment succeeded?
- Clear browser cache

---

## 📊 What You Have Now

✅ Live website
✅ HTTPS (secure)
✅ Global CDN (fast)
✅ Auto-deploys from GitHub
✅ Free SSL certificate

**Current Limitations:**
- Demo data only (not live Baseball Savant data yet)
- No daily auto-updates

---

## 🔮 Next Steps (When Ready)

### Phase 1: Add Live Data (2 hours)
Add Vercel Serverless Function to fetch Baseball Savant data.

Cost: $0 (free tier works)

### Phase 2: Daily Updates (1 hour)
Add Vercel Cron Job to refresh data at 3 AM daily.

Cost: $20/month (Vercel Pro required for cron)

### Phase 3: Analytics (30 min)
Track visitors and popular players.

Cost: $0-9/month

---

## 💰 Cost Summary

**Right Now:**
- Vercel: $0/month (Free tier)
- Domain (optional): $10/year
- **Total: $0-10/year**

**With Daily Updates:**
- Vercel Pro: $20/month
- Domain: $10/year
- **Total: $20-21/month**

---

## 📞 Need Help?

Common issues:
1. **"npm: command not found"** → Install Node.js
2. **"Permission denied"** → Use `sudo` (Mac/Linux)
3. **Build fails on Vercel** → Check package.json dependencies
4. **Site won't load** → Check browser console (F12)

---

## ⏱️ Time Investment

- Initial setup: 15-20 minutes
- Testing + deployment: 10 minutes
- Custom domain (optional): 5-10 minutes

**Total: 20-40 minutes to go live!**

---

## 🎯 Success Criteria

You know it worked when:
- [ ] Site loads at Vercel URL
- [ ] Breakout predictor shows data
- [ ] Year toggle works (2023-2026)
- [ ] Clicking players shows detail panel
- [ ] Mobile view works

---

## 🚀 Ready to Launch!

Everything is configured and ready to deploy.

Just follow Steps 1-4 above and you'll be live in under 30 minutes!

**Good luck!** 🎉⚾
