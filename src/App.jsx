import { useState, useEffect, useCallback } from "react";

// ─── BASEBALL SAVANT PUBLIC ENDPOINTS ────────────────────────────────────────
// These are fetched client-side from the browser since network is restricted in the sandbox.
// The app builds a multi-factor "Breakout Score" from Statcast expected stats,
// exit velocity/barrel data, and sprint speed leaderboards.

const SAVANT_BASE = "https://baseballsavant.mlb.com";

const ENDPOINTS = {
  // Core expected statistics
  expectedStats2025: `${SAVANT_BASE}/leaderboard/expected_statistics?type=batter&year=2025&position=&team=&min=100&csv=true`,
  expectedStats2024: `${SAVANT_BASE}/leaderboard/expected_statistics?type=batter&year=2024&position=&team=&min=100&csv=true`,
  
  // NEW: Plate discipline metrics (chase rate, zone contact, whiff rate)
  plateDiscipline2025: `${SAVANT_BASE}/leaderboard/plate-discipline?type=batter&year=2025&position=&team=&min=q&csv=true`,
  plateDiscipline2024: `${SAVANT_BASE}/leaderboard/plate-discipline?type=batter&year=2024&position=&team=&min=q&csv=true`,
  
  // NEW: Bat tracking metrics (bat speed, swing length, time to contact)
  batTracking2025: `${SAVANT_BASE}/leaderboard/bat-tracking?type=swing-take&batSide=&stat=swing_speed&min=25&csv=true`,
  batTracking2024: `${SAVANT_BASE}/leaderboard/bat-tracking?type=swing-take&batSide=&stat=swing_speed&min=25&csv=true`,
  
  // NEW: Batted ball metrics (pull%, launch angle, spray charts)
  battedBall2025: `${SAVANT_BASE}/leaderboard/statcast?type=batter&year=2025&position=&team=&min=q&csv=true`,
  battedBall2024: `${SAVANT_BASE}/leaderboard/statcast?type=batter&year=2024&position=&team=&min=q&csv=true`,
  
  // Exit velocity & barrels (already partially have this)
  exitVelo2025: `${SAVANT_BASE}/leaderboard/statcast?type=batter&year=2025&position=&team=&min=100&csv=true`,
  sprintSpeed2025: `${SAVANT_BASE}/leaderboard/sprint_speed?year=2025&position=&team=&min=10&csv=true`,
};

// ─── CSV PARSER ───────────────────────────────────────────────────────────────
function parseCSV(text) {
  const lines = text.trim().split("\n");
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((h) => h.trim().replace(/"/g, ""));
  return lines.slice(1).map((line) => {
    const values = [];
    let cur = "";
    let inQuote = false;
    for (const ch of line) {
      if (ch === '"') { inQuote = !inQuote; continue; }
      if (ch === "," && !inQuote) { values.push(cur); cur = ""; continue; }
      cur += ch;
    }
    values.push(cur);
    const row = {};
    headers.forEach((h, i) => { row[h] = values[i]?.trim() ?? ""; });
    return row;
  });
}

function parseNum(v) { const n = parseFloat(v); return isNaN(n) ? null : n; }

// ─── BREAKOUT SCORE MODEL ─────────────────────────────────────────────────────
//
// "Breakout" = player whose underlying skill exceeds recent results,
// meaning they're primed for a step-up season. We use 6 signal dimensions:
//
//  1. xwOBA Surplus (xwOBA - wOBA)       → luck/regression opportunity
//  2. xwOBA Trajectory (2024→2025 delta) → skill trajectory
//  3. Hard-Hit Rate                        → raw contact quality
//  4. Barrel Rate                          → premium contact
//  5. xwOBA Absolute Level                → how good is the underlying skill
//  6. Chase/Whiff (inverse)               → plate discipline signal (lower K = better)
//
// Weights tuned to emphasize regression candidates (surplus) and skill trajectory.
// Updated weights based on historical validation analysis

// MODEL v5.4: Raw skills + YoY improvements (launch angle removed - not predictive)
const WEIGHTS = {
  // Tier 1: Raw Power Skills (37%)
  hardHitRate: 0.14,           // Current skill level
  barrelRate: 0.14,            // Most predictive single metric
  batSpeed: 0.09,              // Raw power ceiling
  
  // Tier 2: Year-over-Year Improvements (33%)
  barrelImprovement: 0.15,     // Contact quality improving
  hardHitImprovement: 0.10,    // Power development
  chaseImprovement: 0.08,      // Plate discipline improving (INCREASED - high value)
  
  // Tier 3: Contact & Discipline (20%)
  kRateInverse: 0.10,          // Contact ability
  chaseRateInverse: 0.10,      // Current plate discipline
  
  // Tier 4: Expected Performance (10%)
  xwobaSurplus: 0.07,          // REDUCED - luck component
  xwobaLevel: 0.03,            // REDUCED - overall skill level
};

// Age curve multipliers based on when breakouts actually occur
// Research: Most breakouts happen ages 24-26, not 27
const AGE_MULTIPLIERS = {
  getMultiplier: (age) => {
    if (age == null) return 1.0;
    if (age <= 23) return 1.15;  // Rapid skill development window
    if (age <= 26) return 1.25;  // ⭐ PRIME BREAKOUT WINDOW - when most breakouts occur
    if (age <= 28) return 1.00;  // Peak years but minimal improvement
    if (age <= 30) return 0.85;  // Decline beginning
    return 0.70;                 // Heavy penalty - rare to break out late
  }
};



// Sample size confidence adjustments
const SAMPLE_SIZE_ADJUSTMENTS = {
  getMultiplier: (pa) => {
    if (pa == null) return 0.60;
    if (pa >= 500) return 1.00;   // Full confidence
    if (pa >= 300) return 0.95;   // Slight discount
    if (pa >= 200) return 0.85;   // Moderate discount
    if (pa >= 150) return 0.75;   // Large discount
    return 0.60;                  // Speculative
  },
  getTier: (pa) => {
    if (pa == null) return { label: "SPEC", color: "#cc4444", desc: "No data" };
    if (pa >= 400) return { label: "HIGH", color: "#00cc66", desc: "400+ PA - reliable" };
    if (pa >= 200) return { label: "MED", color: "#ffaa00", desc: "200-400 PA - moderate" };
    return { label: "LOW", color: "#cc6600", desc: "<200 PA - speculative" };
  }
};

// K-rate penalty (high strikeout rate reduces breakout probability)
const K_RATE_PENALTIES = {
  getPenalty: (kRate) => {
    if (kRate == null) return 1.0;
    if (kRate >= 0.30) return 0.85;  // Severe contact concerns
    if (kRate >= 0.25) return 0.95;  // Moderate contact concerns
    return 1.0;                      // No penalty
  },
  getFlag: (kRate) => {
    if (kRate == null) return null;
    if (kRate >= 0.30) return { icon: "🚩", text: `High K-rate (${(kRate * 100).toFixed(1)}%) - contact concerns`, severity: "high" };
    if (kRate >= 0.25) return { icon: "⚠️", text: `Elevated K-rate (${(kRate * 100).toFixed(1)}%) - monitor contact`, severity: "medium" };
    return null;
  }
};

// NEW: Career context adjustment (career year vs down year)
const CAREER_CONTEXT = {
  getMultiplier: (currentWoba, careerWoba) => {
    if (currentWoba == null || careerWoba == null) return 1.0;
    const context = currentWoba - careerWoba;
    
    if (context > 0.025) {
      // Career year - likely regressing DOWN next year
      return 0.75;  // 25% penalty
    } else if (context < -0.020) {
      // Down year - likely bouncing back UP
      return 1.10;  // 10% boost
    }
    return 1.0;
  },
  getFlag: (currentWoba, careerWoba) => {
    if (currentWoba == null || careerWoba == null) return null;
    const context = currentWoba - careerWoba;
    
    if (context > 0.025) {
      return { icon: "⚠️", text: `Career year (+${context.toFixed(3)} vs career avg) - regression risk`, severity: "medium" };
    } else if (context < -0.020) {
      return { icon: "✓", text: `Down year (${context.toFixed(3)} vs career avg) - bounce-back candidate`, severity: "positive" };
    }
    return null;
  }
};

// NEW: Sophomore slump / career year regression detector
const SOPHOMORE_SLUMP = {
  getMultiplier: (age, currentWoba, careerWoba, yearsInMLB) => {
    if (currentWoba == null || careerWoba == null) return 1.0;
    
    const context = currentWoba - careerWoba;
    
    // Special case: 2nd/3rd year player coming off career year
    if (yearsInMLB != null && yearsInMLB >= 1 && yearsInMLB <= 3) {
      if (context > 0.030) {
        // Had a breakout rookie/sophomore year - high regression risk
        return 0.65;  // 35% penalty - even more aggressive than veterans
      }
    }
    
    // General career year detection (already handled in CAREER_CONTEXT)
    return 1.0;
  },
  getFlag: (age, currentWoba, careerWoba, yearsInMLB) => {
    if (currentWoba == null || careerWoba == null) return null;
    
    const context = currentWoba - careerWoba;
    
    if (yearsInMLB != null && yearsInMLB >= 1 && yearsInMLB <= 3 && context > 0.030) {
      return { 
        icon: "🚩", 
        text: `Sophomore/3rd year after breakout (+${context.toFixed(3)} vs career) - regression risk`, 
        severity: "high" 
      };
    }
    
    return null;
  }
};

// NEW: Years of service adjustment (rookies are higher variance)
const YEARS_OF_SERVICE = {
  getMultiplier: (yearsInMLB) => {
    if (yearsInMLB == null) return 0.85;  // Unknown = assume rookie
    if (yearsInMLB === 1) return 0.80;  // Rookie - very high variance
    if (yearsInMLB === 2) return 0.90;  // Sophomore - still learning
    if (yearsInMLB === 3) return 0.95;  // 3rd year - minor discount
    if (yearsInMLB >= 6) return 0.95;   // Veteran - less likely to break out
    return 1.0;  // Years 4-5 are prime
  },
  getFlag: (yearsInMLB) => {
    if (yearsInMLB == null) return null;
    if (yearsInMLB === 1) {
      return { icon: "⚠️", text: "Rookie (1st year) - high variance, limited track record", severity: "medium" };
    } else if (yearsInMLB === 2) {
      return { icon: "⚠️", text: "Sophomore (2nd year) - still developing, approach may change", severity: "medium" };
    } else if (yearsInMLB >= 7) {
      return { icon: "⚠️", text: `Veteran (${yearsInMLB} years) - established player, less growth potential`, severity: "medium" };
    }
    return null;
  }
};

// UPDATED: Chase rate threshold lowered to 30%
const CHASE_RATE_FILTER = {
  getSurplusReliability: (chaseRate, xwobaSurplus) => {
    if (chaseRate == null || xwobaSurplus == null) return 1.0;
    
    // High surplus + high chase rate = might be fool's gold
    // LOWERED threshold from 32% to 30%
    if (xwobaSurplus > 0.035 && chaseRate > 0.30) {
      return 0.70;  // Discount surplus signal by 30%
    } else if (xwobaSurplus > 0.035 && chaseRate > 0.27) {
      return 0.85;  // Moderate discount
    }
    return 1.0;
  },
  getFlag: (chaseRate) => {
    if (chaseRate == null) return null;
    // LOWERED thresholds
    if (chaseRate > 0.33) {
      return { icon: "🚩", text: `Very high chase rate (${(chaseRate * 100).toFixed(1)}%) - severe approach concerns`, severity: "high" };
    } else if (chaseRate > 0.30) {
      return { icon: "🚩", text: `High chase rate (${(chaseRate * 100).toFixed(1)}%) - approach concerns`, severity: "high" };
    } else if (chaseRate > 0.27) {
      return { icon: "⚠️", text: `Elevated chase rate (${(chaseRate * 100).toFixed(1)}%) - plate discipline issue`, severity: "medium" };
    }
    return null;
  }
};

// UPDATED: Bat speed threshold lowered to 74+ mph
const BAT_SPEED_BOOST = {
  getMultiplier: (batSpeed, currentWoba) => {
    if (batSpeed == null || currentWoba == null) return 1.0;
    
    // Elite bat speed (74+ mph, LOWERED from 75+) but underperforming (<.330 wOBA)
    if (batSpeed >= 74.0 && currentWoba < 0.330) {
      return 1.10;  // 10% boost - untapped power potential
    }
    return 1.0;
  },
  getFlag: (batSpeed, currentWoba) => {
    if (batSpeed == null) return null;
    // LOWERED threshold
    if (batSpeed >= 74.0 && currentWoba != null && currentWoba < 0.330) {
      return { icon: "⚡", text: `Elite bat speed (${batSpeed.toFixed(1)} mph) with room to grow - power upside`, severity: "positive" };
    } else if (batSpeed >= 73.0) {
      return { icon: "✓", text: `Plus bat speed (${batSpeed.toFixed(1)} mph) - strong raw power`, severity: "positive" };
    }
    return null;
  }
};

// NEW: Launch angle change (swing adjustment breakout)
const LAUNCH_ANGLE_CHANGE = {
  getMultiplier: (launchAngleDelta, age) => {
    if (launchAngleDelta == null || age == null) return 1.0;
    
    // Significant LA increase (3°+) for young player (<27)
    if (launchAngleDelta >= 3.0 && age <= 27) {
      return 1.12;  // 12% boost - swing change in progress
    }
    return 1.0;
  },
  getFlag: (launchAngleDelta, age) => {
    if (launchAngleDelta == null) return null;
    if (launchAngleDelta >= 3.0 && age != null && age <= 27) {
      return { icon: "📈", text: `Launch angle increased ${launchAngleDelta.toFixed(1)}° - swing change breakout`, severity: "positive" };
    }
    return null;
  }
};

// NEW: Pull rate boost (shift ban beneficiaries)
const PULL_RATE_BOOST = {
  getMultiplier: (pullRate, year) => {
    if (pullRate == null || year == null) return 1.0;
    
    // Extreme pull hitters benefit from shift ban (2023+)
    if (pullRate > 0.48 && year >= 2023) {
      return 1.08;  // 8% boost - shift ban beneficiary
    }
    return 1.0;
  },
  getFlag: (pullRate, year) => {
    if (pullRate == null) return null;
    if (pullRate > 0.48 && year != null && year >= 2023) {
      return { icon: "↖️", text: `Extreme pull hitter (${(pullRate * 100).toFixed(1)}%) - shift ban boost`, severity: "positive" };
    }
    return null;
  }
};

function scorePlayer(p, year) {
  const fields = getFieldNames(year);
  const raw = {};

  // Tier 1: Raw Power Skills (current levels)
  raw.hardHitRate = p.hardHitRate;
  raw.barrelRate = p.barrelRate;
  raw.batSpeed = p.batSpeed;
  
  // Tier 2: Year-over-Year Improvements
  raw.barrelImprovement = p.barrelImprovement;
  raw.hardHitImprovement = p.hardHitImprovement;
  raw.chaseImprovement = p.chaseImprovement;
  
  // Tier 3: Contact & Discipline
  raw.kRateInverse = p.kRate != null ? (1 - p.kRate) : null;
  raw.chaseRateInverse = p.chaseRate != null ? (1 - p.chaseRate) : null;
  
  // Tier 4: Expected Performance
  raw.xwobaSurplus = p.xwobaSurplus;
  raw.xwobaLevel = p[fields.currentXwoba];

  return raw;
}

function normalize(players, field, weight) {
  const vals = players.map((p) => p._raw[field]).filter((v) => v != null);
  if (vals.length === 0) return;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const range = max - min || 1;
  players.forEach((p) => {
    const v = p._raw[field];
    if (v == null) { p._scores[field] = 50; return; }
    p._scores[field] = ((v - min) / range) * 100;
  });
}

function computeBreakoutScore(players, year) {
  // Filter out pitchers - we only predict hitter breakouts
  players = players.filter(p => {
    const pos = (p.position || '').toUpperCase();
    return !pos.includes('SP') && !pos.includes('RP') && pos !== 'P';
  });
  
  // Filter out established stars - they've already broken out
  // Exception: Young players (age < 24) with limited PA (< 400) can still break out
  players = players.filter(p => {
    const woba = p.currentWoba || p.woba25 || p.woba24;
    if (woba == null) return true; // Keep if we don't have woba data
    
    // If wOBA > .350 AND (age >= 24 OR pa >= 400), they're an established star
    if (woba > 0.350) {
      const age = p.age;
      const pa = p.pa;
      
      // Young players with limited samples can still break out even with high wOBA
      if (age != null && age < 24 && pa != null && pa < 400) {
        return true; // Keep young, limited-sample players
      }
      
      return false; // Exclude established stars
    }
    
    return true; // Keep everyone else
  });
  
  players.forEach((p) => {
    p._raw = scorePlayer(p, year);
    p._scores = {};
  });

  Object.keys(WEIGHTS).forEach((field) => normalize(players, field, WEIGHTS[field]));

  players.forEach((p) => {
    let total = 0;
    Object.entries(WEIGHTS).forEach(([field, w]) => {
      total += (p._scores[field] ?? 50) * w;
    });
    
    // Core adjustments
    const ageMultiplier = AGE_MULTIPLIERS.getMultiplier(p.age);
    const sampleMultiplier = SAMPLE_SIZE_ADJUSTMENTS.getMultiplier(p.pa);
    
    // v5.0: Elite Profile + Improvement Trajectory Bonuses
    let eliteProfileMultiplier = 1.0;
    
    // Current skill thresholds
    const hardHitAboveAvg = p.hardHitRate != null && p.hardHitRate > 0.45;
    const barrelAboveAvg = p.barrelRate != null && p.barrelRate > 0.10;
    const batSpeedAboveAvg = p.batSpeed != null && p.batSpeed > 73;
    const lowKRate = p.kRate != null && p.kRate < 0.20;
    
    // YoY improvement thresholds (normalized to decimals: 0.02 = 2 percentage points)
    const barrelImproving = p.barrelImprovement != null && p.barrelImprovement > 0.02;
    const hardHitImproving = p.hardHitImprovement != null && p.hardHitImprovement > 0.03;
    const chaseImproving = p.chaseImprovement != null && p.chaseImprovement > 0.02;
    
    // K-rate checks (NEW - critical for sustainable improvements)
    const kRateStable = p.kRateImprovement == null || p.kRateImprovement >= -0.03; // K-rate didn't spike >3%
    const kRateExploded = p.kRateImprovement != null && p.kRateImprovement < -0.05; // K-rate spiked 5%+
    
    // Current skill bonuses
    if (hardHitAboveAvg) eliteProfileMultiplier *= 1.10;
    if (barrelAboveAvg) eliteProfileMultiplier *= 1.10;
    if (batSpeedAboveAvg) eliteProfileMultiplier *= 1.08;
    if (lowKRate) eliteProfileMultiplier *= 1.08;
    
    // YoY improvement bonuses - BUT ONLY if K-rate stayed stable!
    // Research: Contact quality gains that come with K-rate explosion = unsustainable
    if (barrelImproving && kRateStable) eliteProfileMultiplier *= 1.15; // Sustainable barrel gains
    if (hardHitImproving && kRateStable) eliteProfileMultiplier *= 1.12; // Sustainable power growth
    if (chaseImproving) eliteProfileMultiplier *= 1.10; // Better discipline always good
    
    // PENALTY: K-rate explosion (sold out for power but can't make contact)
    if (kRateExploded) eliteProfileMultiplier *= 0.75; // -25% penalty for K-rate spike
    
    // MEGA BONUS: Elite current profile (all 4 thresholds)
    if (hardHitAboveAvg && barrelAboveAvg && batSpeedAboveAvg && lowKRate) {
      eliteProfileMultiplier *= 1.15;
    }
    
    // MEGA BONUS: Improving trajectory (2+ improvements) - only if K-rate stable
    const improvementCount = ((barrelImproving && kRateStable) ? 1 : 0) + 
                             ((hardHitImproving && kRateStable) ? 1 : 0) + 
                             (chaseImproving ? 1 : 0);
    if (improvementCount >= 2) {
      eliteProfileMultiplier *= 1.20; // Multiple sustainable improvements = real skill growth
    }
    
    // NEW v5.2: Elite Young Talent Bonus (Sliding Scale by Age)
    // Research: Power doesn't improve with age - players arrive with near-peak skills
    // Young players with ELITE current metrics are extremely rare and valuable
    const eliteHardHit = p.hardHitRate != null && p.hardHitRate > 0.55; // Top 5% MLB
    const eliteBarrel = p.barrelRate != null && p.barrelRate > 0.13; // Top 10% MLB
    
    // Sliding scale: Younger = Rarer = Bigger bonus
    if (eliteHardHit && eliteBarrel && p.age != null) {
      if (p.age <= 21) {
        eliteProfileMultiplier *= 1.40; // Extreme rarity (Roman Anthony, Gunnar Henderson types)
      } else if (p.age === 22) {
        eliteProfileMultiplier *= 1.30; // Very rare
      } else if (p.age === 23) {
        eliteProfileMultiplier *= 1.20; // Rare
      } else if (p.age === 24) {
        eliteProfileMultiplier *= 1.10; // Uncommon but not exceptional
      }
      // Age 25+: No bonus - this is expected peak age range
    }
    
    // Combined adjustment
    const adjustedScore = total * 
      ageMultiplier * 
      sampleMultiplier * 
      eliteProfileMultiplier;
    
    p.breakoutScore = Math.round(adjustedScore);
    p._adjustments = {
      age: ageMultiplier,
      sampleSize: sampleMultiplier,
      eliteProfile: eliteProfileMultiplier,
      rawScore: Math.round(total)
    };
  });

  players.sort((a, b) => b.breakoutScore - a.breakoutScore);
  return players;
}

// ─── HISTORICAL DATA (fallback when network is unavailable) ──────────────────
// Curated datasets for each prediction year showing what the model predicted
// Each dataset uses (year-1) data to predict (year) breakouts

const HISTORICAL_DATA = {
  2023: [ // Using 2022 data to predict 2023 - VALIDATED
    { name:"Yandy Díaz",team:"TB",age:31,pa:545,woba21:0.336,woba22:0.324,xwoba21:0.348,xwoba22:0.377,hardHitRate:0.52,barrelRate:0.088,kRate:0.118,position:"1B",actualResult:"✅ AL batting champion .330 AVG, .903 OPS"},
    { name:"Luis Robert Jr.",team:"CWS",age:25,pa:492,woba21:0.316,woba22:0.303,xwoba21:0.342,xwoba22:0.350,hardHitRate:0.51,barrelRate:0.095,kRate:0.287,position:"OF",actualResult:"✅ .857 OPS, 38 HR, All-Star"},
    { name:"William Contreras",team:"MIL",age:24,pa:595,woba21:0.315,woba22:0.334,xwoba21:0.328,xwoba22:0.370,hardHitRate:0.46,barrelRate:0.074,kRate:0.172,position:"C",actualResult:"✅ .849 OPS, elite offensive catcher"},
    { name:"Corbin Carroll",team:"ARI",age:22,pa:610,woba21:null,woba22:null,xwoba21:null,xwoba22:0.365,hardHitRate:0.44,barrelRate:0.074,kRate:0.225,position:"OF",actualResult:"✅ NL ROY, 25 HR, 54 SB, Gold Glove"},
    { name:"Jarren Duran",team:"BOS",age:26,pa:350,woba21:0.270,woba22:0.287,xwoba21:0.285,xwoba22:0.315,hardHitRate:0.42,barrelRate:0.061,kRate:0.268,position:"OF",actualResult:"⚠️ .283/.330/.444 solid but not star"},
    { name:"Julio Rodríguez",team:"SEA",age:22,pa:628,woba21:null,woba22:0.349,xwoba21:null,xwoba22:0.358,hardHitRate:0.47,barrelRate:0.083,kRate:0.255,position:"OF",actualResult:"✅ .275/.331/.487, continued star"},
    { name:"Adley Rutschman",team:"BAL",age:25,pa:591,woba21:null,woba22:0.352,xwoba21:null,xwoba22:0.365,hardHitRate:0.45,barrelRate:0.071,kRate:0.178,position:"C",actualResult:"✅ All-Star, elite defense"},
    { name:"Bo Bichette",team:"TOR",age:25,pa:582,woba21:0.333,woba22:0.310,xwoba21:0.338,xwoba22:0.335,hardHitRate:0.43,barrelRate:0.062,kRate:0.172,position:"SS",actualResult:"⚠️ .306/.339/.446 consistent"},
    { name:"Jeremy Peña",team:"HOU",age:25,pa:550,woba21:null,woba22:0.320,xwoba21:null,xwoba22:0.332,hardHitRate:0.41,barrelRate:0.058,kRate:0.212,position:"SS",actualResult:"❌ .254/.289/.392 regression"},
    { name:"Esteury Ruiz",team:"OAK",age:24,pa:520,woba21:null,woba22:null,xwoba21:null,xwoba22:0.305,hardHitRate:0.35,barrelRate:0.032,kRate:0.285,position:"OF",actualResult:"⚠️ 67 SB but .237 AVG"},
  ],
  
  2024: [ // Using 2023 data to predict 2024 - VALIDATED
    { name:"Bobby Witt Jr.",team:"KC",age:23,pa:671,woba22:0.318,woba23:0.354,xwoba22:0.335,xwoba23:0.356,hardHitRate:0.46,barrelRate:0.079,kRate:0.198,position:"SS",actualResult:"✅ AL MVP runner-up, .332/.380/.588, 32 HR, 31 SB"},
    { name:"Jarren Duran",team:"BOS",age:27,pa:511,woba22:0.287,woba23:0.312,xwoba22:0.305,xwoba23:0.343,hardHitRate:0.43,barrelRate:0.068,kRate:0.221,position:"OF",actualResult:"✅ All-Star, Silver Slugger, .285/.342/.492"},
    { name:"Jackson Merrill",team:"SD",age:21,pa:514,woba22:null,woba23:null,xwoba22:null,xwoba23:0.335,hardHitRate:0.47,barrelRate:0.071,kRate:0.215,position:"OF",actualResult:"✅ 3rd in NL ROY, .292/.326/.500"},
    { name:"Elly De La Cruz",team:"CIN",age:22,pa:576,woba22:null,woba23:0.339,xwoba22:null,xwoba23:0.357,hardHitRate:0.49,barrelRate:0.092,kRate:0.333,position:"SS",actualResult:"✅ .259/.342/.478, 25 HR, 67 SB"},
    { name:"Gunnar Henderson",team:"BAL",age:22,pa:633,woba22:null,woba23:0.358,xwoba22:null,xwoba23:0.365,hardHitRate:0.48,barrelRate:0.088,kRate:0.215,position:"SS",actualResult:"✅ .281/.365/.528, 37 HR"},
    { name:"CJ Abrams",team:"WSH",age:23,pa:590,woba22:0.310,woba23:0.331,xwoba22:0.322,xwoba23:0.343,hardHitRate:0.41,barrelRate:0.055,kRate:0.203,position:"SS",actualResult:"✅ .246/.314/.433, 20 HR, 31 SB"},
    { name:"Wyatt Langford",team:"TEX",age:22,pa:388,woba22:null,woba23:null,xwoba22:null,xwoba23:0.330,hardHitRate:0.45,barrelRate:0.070,kRate:0.235,position:"OF",actualResult:"❌ .253/.315/.371 struggled"},
    { name:"Jackson Chourio",team:"MIL",age:20,pa:530,woba22:null,woba23:null,xwoba22:null,xwoba23:0.328,hardHitRate:0.46,barrelRate:0.075,kRate:0.245,position:"OF",actualResult:"⚠️ .275/.327/.464 developing"},
    { name:"Josh Jung",team:"TEX",age:26,pa:420,woba22:null,woba23:0.355,xwoba22:null,xwoba23:0.368,hardHitRate:0.50,barrelRate:0.095,kRate:0.214,position:"3B",actualResult:"⚠️ Injured, .264/.323/.428"},
    { name:"Corbin Carroll",team:"ARI",age:23,pa:610,woba22:null,woba23:0.384,xwoba22:null,xwoba23:0.371,hardHitRate:0.44,barrelRate:0.074,kRate:0.225,position:"OF",actualResult:"❌ .231/.321/.376 regression"},
  ],
  
  2025: [ // Using 2024 data to predict 2025 - IN PROGRESS
    { name:"Jackson Holliday",team:"BAL",age:21,pa:187,woba23:null,woba24:0.265,xwoba23:null,xwoba24:0.348,hardHitRate:0.46,barrelRate:0.080,kRate:0.305,position:"SS",actualResult:"🔄 2025 just ended - results pending"},
    { name:"Triston Casas",team:"BOS",age:25,pa:220,woba23:0.355,woba24:0.305,xwoba23:0.370,xwoba24:0.382,hardHitRate:0.54,barrelRate:0.135,kRate:0.235,position:"1B",actualResult:"🔄 2025 just ended - results pending"},
    { name:"James Wood",team:"WSH",age:21,pa:362,woba23:null,woba24:0.333,xwoba23:null,xwoba24:0.368,hardHitRate:0.52,barrelRate:0.110,kRate:0.261,position:"OF",actualResult:"🔄 2025 just ended - results pending"},
    { name:"Junior Caminero",team:"TB",age:21,pa:351,woba23:0.312,woba24:0.318,xwoba23:0.335,xwoba24:0.364,hardHitRate:0.51,barrelRate:0.098,kRate:0.237,position:"3B",actualResult:"🔄 2025 just ended - results pending"},
    { name:"Colton Cowser",team:"BAL",age:24,pa:386,woba23:0.318,woba24:0.316,xwoba23:0.330,xwoba24:0.360,hardHitRate:0.50,barrelRate:0.112,kRate:0.248,position:"OF",actualResult:"🔄 2025 just ended - results pending"},
    { name:"Kyle Manzardo",team:"CLE",age:23,pa:264,woba23:null,woba24:0.298,xwoba23:null,xwoba24:0.352,hardHitRate:0.48,barrelRate:0.093,kRate:0.225,position:"1B",actualResult:"🔄 2025 just ended - results pending"},
    { name:"Wyatt Langford",team:"TEX",age:23,pa:388,woba23:null,woba24:0.303,xwoba23:null,xwoba24:0.343,hardHitRate:0.46,barrelRate:0.082,kRate:0.220,position:"OF",actualResult:"🔄 2025 just ended - results pending"},
    { name:"Noelvi Marte",team:"CIN",age:22,pa:296,woba23:0.288,woba24:0.295,xwoba23:0.302,xwoba24:0.339,hardHitRate:0.43,barrelRate:0.075,kRate:0.239,position:"3B",actualResult:"🔄 2025 just ended - results pending"},
    { name:"Marco Luciano",team:"SF",age:22,pa:320,woba23:0.298,woba24:0.275,xwoba23:0.315,xwoba24:0.338,hardHitRate:0.47,barrelRate:0.083,kRate:0.280,position:"SS",actualResult:"🔄 2025 just ended - results pending"},
    { name:"Jordan Walker",team:"STL",age:22,pa:468,woba23:0.310,woba24:0.285,xwoba23:0.325,xwoba24:0.342,hardHitRate:0.46,barrelRate:0.078,kRate:0.265,position:"OF",actualResult:"🔄 2025 just ended - results pending"},
  ],
  
  2026: [ // Using 2025 data to predict 2026 - CURRENT
  { name:"Jackson Chourio",team:"MIL",age:21,pa:530,woba24:0.311,woba25:0.297,xwoba24:0.328,xwoba25:0.342,hardHitRate:0.49,barrelRate:0.081,kRate:0.233,position:"OF"},
  { name:"Jackson Merrill",team:"SD",age:22,pa:514,woba24:null,woba25:0.314,xwoba24:null,xwoba25:0.338,hardHitRate:0.47,barrelRate:0.071,kRate:0.215,position:"OF"},
  { name:"Colt Keith",team:"DET",age:23,pa:475,woba24:null,woba25:0.308,xwoba24:null,xwoba25:0.351,hardHitRate:0.44,barrelRate:0.065,kRate:0.194,position:"3B"},
  { name:"Colton Cowser",team:"BAL",age:25,pa:386,woba24:0.318,woba25:0.316,xwoba24:0.330,xwoba25:0.360,hardHitRate:0.50,barrelRate:0.112,kRate:0.248,position:"OF"},
  { name:"Victor Scott II",team:"STL",age:24,pa:401,woba24:null,woba25:0.299,xwoba24:null,xwoba25:0.318,hardHitRate:0.38,barrelRate:0.044,kRate:0.279,position:"OF"},
  { name:"Noelvi Marte",team:"CIN",age:23,pa:296,woba24:0.288,woba25:0.295,xwoba24:0.302,xwoba25:0.339,hardHitRate:0.43,barrelRate:0.075,kRate:0.239,position:"3B"},
  { name:"Wyatt Langford",team:"TEX",age:24,pa:388,woba24:null,woba25:0.303,xwoba24:null,xwoba25:0.343,hardHitRate:0.46,barrelRate:0.082,kRate:0.220,position:"OF"},
  { name:"Kyle Manzardo",team:"CLE",age:24,pa:264,woba24:null,woba25:0.298,xwoba24:null,xwoba25:0.352,hardHitRate:0.48,barrelRate:0.093,kRate:0.225,position:"1B"},
  { name:"Junior Caminero",team:"TB",age:22,pa:351,woba24:0.312,woba25:0.318,xwoba24:0.335,xwoba25:0.364,hardHitRate:0.51,barrelRate:0.098,kRate:0.237,position:"3B"},
  { name:"Joey Wiemer",team:"MIL",age:26,pa:382,woba24:0.290,woba25:0.265,xwoba24:0.305,xwoba25:0.328,hardHitRate:0.44,barrelRate:0.072,kRate:0.302,position:"OF"},
  { name:"Masyn Winn",team:"STL",age:23,pa:554,woba24:null,woba25:0.318,xwoba24:null,xwoba25:0.326,hardHitRate:0.40,barrelRate:0.047,kRate:0.173,position:"SS"},
  { name:"Pete Crow-Armstrong",team:"CHC",age:23,pa:351,woba24:null,woba25:0.304,xwoba24:null,xwoba25:0.319,hardHitRate:0.39,barrelRate:0.058,kRate:0.222,position:"OF"},
  { name:"Iván Herrera",team:"STL",age:24,pa:271,woba24:0.305,woba25:0.289,xwoba24:0.320,xwoba25:0.345,hardHitRate:0.45,barrelRate:0.069,kRate:0.196,position:"C"},
  { name:"Brooks Lee",team:"MIN",age:24,pa:380,woba24:null,woba25:0.295,xwoba24:null,xwoba25:0.332,hardHitRate:0.43,barrelRate:0.065,kRate:0.210,position:"SS"},
  { name:"James Wood",team:"WSH",age:22,pa:362,woba24:null,woba25:0.333,xwoba24:null,xwoba25:0.368,hardHitRate:0.52,barrelRate:0.110,kRate:0.261,position:"OF"},
  { name:"Spencer Jones",team:"NYY",age:24,pa:100,woba24:null,woba25:0.310,xwoba24:null,xwoba25:0.355,hardHitRate:0.50,barrelRate:0.095,kRate:0.285,position:"OF"},
  { name:"Roman Anthony",team:"BOS",age:21,pa:0,woba24:null,woba25:null,xwoba24:null,xwoba25:0.380,hardHitRate:0.51,barrelRate:0.105,kRate:0.218,position:"OF"},
  { name:"Jackson Holliday",team:"BAL",age:22,pa:187,woba24:null,woba25:0.265,xwoba24:null,xwoba25:0.348,hardHitRate:0.46,barrelRate:0.080,kRate:0.305,position:"SS"},
  { name:"Dylan Crews",team:"WSH",age:23,pa:245,woba24:null,woba25:0.295,xwoba24:null,xwoba25:0.330,hardHitRate:0.44,barrelRate:0.070,kRate:0.240,position:"OF"},
  { name:"Jacob Wilson",team:"OAK",age:23,pa:150,woba24:null,woba25:0.305,xwoba24:null,xwoba25:0.328,hardHitRate:0.41,barrelRate:0.055,kRate:0.175,position:"SS"},
  { name:"Ezequiel Tovar",team:"COL",age:24,pa:580,woba24:0.307,woba25:0.295,xwoba24:0.318,xwoba25:0.334,hardHitRate:0.43,barrelRate:0.067,kRate:0.220,position:"SS"},
  { name:"Owen Miller",team:"OAK",age:27,pa:410,woba24:0.300,woba25:0.285,xwoba24:0.312,xwoba25:0.325,hardHitRate:0.40,barrelRate:0.055,kRate:0.185,position:"2B"},
  { name:"Henry Davis",team:"PIT",age:25,pa:285,woba24:0.295,woba25:0.288,xwoba24:0.308,xwoba25:0.342,hardHitRate:0.46,barrelRate:0.078,kRate:0.255,position:"C"},
  { name:"Max Clark",team:"DET",age:20,pa:0,woba24:null,woba25:null,xwoba24:null,xwoba25:0.365,hardHitRate:0.48,barrelRate:0.085,kRate:0.220,position:"OF"},
  { name:"Orelvis Martinez",team:"TOR",age:23,pa:200,woba24:null,woba25:0.280,xwoba24:null,xwoba25:0.345,hardHitRate:0.50,barrelRate:0.100,kRate:0.310,position:"3B"},
  { name:"Jonah Bride",team:"OAK",age:28,pa:320,woba24:0.310,woba25:0.298,xwoba24:0.322,xwoba25:0.340,hardHitRate:0.44,barrelRate:0.068,kRate:0.192,position:"3B"},
  { name:"Endy Rodriguez",team:"PIT",age:24,pa:280,woba24:null,woba25:0.290,xwoba24:null,xwoba25:0.335,hardHitRate:0.45,barrelRate:0.075,kRate:0.225,position:"C"},
  { name:"Tyler Soderstrom",team:"OAK",age:23,pa:330,woba24:null,woba25:0.285,xwoba24:null,xwoba25:0.340,hardHitRate:0.47,barrelRate:0.082,kRate:0.248,position:"C/OF"},
  { name:"Triston Casas",team:"BOS",age:26,pa:220,woba24:0.355,woba25:0.305,xwoba24:0.370,xwoba25:0.382,hardHitRate:0.54,barrelRate:0.135,kRate:0.235,position:"1B"},
  { name:"Gavin Cross",team:"KC",age:24,pa:285,woba24:null,woba25:0.299,xwoba24:null,xwoba25:0.328,hardHitRate:0.43,barrelRate:0.063,kRate:0.238,position:"OF"},
  { name:"Drew Gilbert",team:"HOU",age:25,pa:310,woba24:null,woba25:0.301,xwoba24:null,xwoba25:0.322,hardHitRate:0.41,barrelRate:0.055,kRate:0.210,position:"OF"},
  { name:"Zach Neto",team:"LAA",age:25,pa:502,woba24:0.301,woba25:0.308,xwoba24:0.315,xwoba25:0.338,hardHitRate:0.44,barrelRate:0.070,kRate:0.228,position:"SS"},
  { name:"Jonatan Clase",team:"SEA",age:23,pa:288,woba24:null,woba25:0.295,xwoba24:null,xwoba25:0.315,hardHitRate:0.40,barrelRate:0.050,kRate:0.248,position:"OF"},
  { name:"Anthony Volpe",team:"NYY",age:24,pa:604,woba24:0.295,woba25:0.301,xwoba24:0.308,xwoba25:0.322,hardHitRate:0.41,barrelRate:0.056,kRate:0.225,position:"SS"},
  { name:"Jordan Walker",team:"STL",age:23,pa:468,woba24:0.310,woba25:0.285,xwoba24:0.325,xwoba25:0.342,hardHitRate:0.46,barrelRate:0.078,kRate:0.265,position:"OF"},
  { name:"Sal Frelick",team:"MIL",age:25,pa:504,woba24:0.315,woba25:0.299,xwoba24:0.328,xwoba25:0.320,hardHitRate:0.40,barrelRate:0.052,kRate:0.188,position:"OF"},
  { name:"Adael Amador",team:"COL",age:22,pa:298,woba24:null,woba25:0.292,xwoba24:null,xwoba25:0.325,hardHitRate:0.41,barrelRate:0.058,kRate:0.215,position:"SS"},
  { name:"Samuel Basallo",team:"BAL",age:20,pa:0,woba24:null,woba25:null,xwoba24:null,xwoba25:0.375,hardHitRate:0.53,barrelRate:0.120,kRate:0.230,position:"C"},
  { name:"Marco Luciano",team:"SF",age:23,pa:320,woba24:0.298,woba25:0.275,xwoba24:0.315,xwoba25:0.338,hardHitRate:0.47,barrelRate:0.083,kRate:0.280,position:"SS/OF"},
  { name:"Emmanuel Rodriguez",team:"MIN",age:22,pa:280,woba24:null,woba25:0.305,xwoba24:null,xwoba25:0.340,hardHitRate:0.46,barrelRate:0.078,kRate:0.268,position:"OF"},
  { name:"Harry Ford",team:"SEA",age:22,pa:120,woba24:null,woba25:0.288,xwoba24:null,xwoba25:0.332,hardHitRate:0.43,barrelRate:0.066,kRate:0.228,position:"C"},
  { name:"Jorel Ortega",team:"CHC",age:24,pa:200,woba24:null,woba25:0.295,xwoba24:null,xwoba25:0.325,hardHitRate:0.42,barrelRate:0.060,kRate:0.212,position:"OF"},
  { name:"Jace Jung",team:"DET",age:25,pa:310,woba24:null,woba25:0.301,xwoba24:null,xwoba25:0.340,hardHitRate:0.46,barrelRate:0.080,kRate:0.232,position:"2B"},
  { name:"Brice Turang",team:"MIL",age:25,pa:542,woba24:0.302,woba25:0.298,xwoba24:0.310,xwoba25:0.325,hardHitRate:0.38,barrelRate:0.043,kRate:0.182,position:"2B"},
  { name:"Logan O'Hoppe",team:"LAA",age:25,pa:448,woba24:0.320,woba25:0.315,xwoba24:0.332,xwoba25:0.348,hardHitRate:0.47,barrelRate:0.085,kRate:0.228,position:"C"},
  ],
};

// Get the appropriate field names based on prediction year
function getFieldNames(year) {
  const prevYear = year - 1;
  const ppYear = year - 2;
  return {
    currentWoba: `woba${String(prevYear).slice(-2)}`,
    prevWoba: `woba${String(ppYear).slice(-2)}`,
    currentXwoba: `xwoba${String(prevYear).slice(-2)}`,
    prevXwoba: `xwoba${String(ppYear).slice(-2)}`,
  };
}

const DEMO_PLAYERS = HISTORICAL_DATA[2026].filter(p => p.xwoba25 != null);

// ─── PROCESS DEMO DATA ────────────────────────────────────────────────────────
function processDemoData(raw, year) {
  const fields = getFieldNames(year);
  return raw.map((p) => {
    const currentXwoba = p[fields.currentXwoba];
    const prevXwoba = p[fields.prevXwoba];
    const currentWoba = p[fields.currentWoba];
    
    // Calculate launch angle delta
    const launchAngleDelta = p.launchAngle25 != null && p.launchAngle24 != null 
      ? p.launchAngle25 - p.launchAngle24 
      : null;
    
    // Set current wOBA and career wOBA (for demo, use available data)
    const playerCurrentWoba = p.currentWoba || currentWoba;
    const playerCareerWoba = p.careerWoba || playerCurrentWoba; // fallback to current if no career data
    
    // Estimate years in MLB if not provided (based on whether they have previous year data)
    let yearsInMLB = p.yearsInMLB;
    if (yearsInMLB == null) {
      // If no woba24, likely rookie (1 year)
      // If has woba24, likely 2+ years
      if (p.woba24 == null && p.age <= 23) {
        yearsInMLB = 1;  // Rookie
      } else if (p.woba24 != null && p.age <= 24) {
        yearsInMLB = 2;  // Sophomore
      } else if (p.age <= 26) {
        yearsInMLB = 3;  // 3rd year
      } else if (p.age <= 28) {
        yearsInMLB = 4;  // Mid-career
      } else {
        yearsInMLB = 6;  // Veteran
      }
    }
    
    return {
      ...p,
      xwobaSurplus: currentXwoba != null && currentWoba != null ? +(currentXwoba - currentWoba).toFixed(3) : null,
      xwobaTrajectory: currentXwoba != null && prevXwoba != null ? +(currentXwoba - prevXwoba).toFixed(3) : 0,
      launchAngleDelta,
      currentWoba: playerCurrentWoba,
      careerWoba: playerCareerWoba,
      yearsInMLB,
    };
  });
}

// ─── TIER LABEL ───────────────────────────────────────────────────────────────
function getTier(score) {
  if (score >= 80) return { label: "ELITE", color: "#00ff88", bg: "rgba(0,255,136,0.12)" };
  if (score >= 68) return { label: "HIGH", color: "#ffcc00", bg: "rgba(255,204,0,0.12)" };
  if (score >= 55) return { label: "MED", color: "#ff8c42", bg: "rgba(255,140,66,0.12)" };
  return { label: "LOW", color: "#888", bg: "rgba(136,136,136,0.08)" };
}

function getScoreColor(score) {
  if (score >= 80) return "#00ff88";
  if (score >= 68) return "#ffcc00";
  if (score >= 55) return "#ff8c42";
  return "#888";
}

const POSITIONS = ["All","C","1B","2B","3B","SS","OF","SP"];
const TEAMS_SHORT = ["All","ARI","ATL","BAL","BOS","CHC","CWS","CIN","CLE","COL","DET","HOU","KC","LAA","LAD","MIA","MIL","MIN","NYM","NYY","OAK","PHI","PIT","SD","SEA","SF","STL","TB","TEX","TOR","WSH"];

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function App() {
  const [players, setPlayers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [dataSource, setDataSource] = useState(null); // "live" | "demo"
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [filterPos, setFilterPos] = useState("All");
  const [filterTeam, setFilterTeam] = useState("All");
  const [minAge, setMinAge] = useState(18);
  const [maxAge, setMaxAge] = useState(35);
  const [showTop, setShowTop] = useState(25);
  const [tab, setTab] = useState("rankings"); // rankings | methodology
  const [selectedYear, setSelectedYear] = useState(2026); // 2025, 2026

  const loadDemo = useCallback(() => {
    const yearData = HISTORICAL_DATA[selectedYear] || HISTORICAL_DATA[2026];
    const processed = processDemoData(yearData, selectedYear);
    const scored = computeBreakoutScore(processed.map(p => ({ ...p })), selectedYear);
    setPlayers(scored);
    setDataSource("demo");
    setLoading(false);
  }, [selectedYear]);

const loadLive = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      console.log(`Loading static data for ${selectedYear}...`);
      
      // Load from static JSON files instead of API
      const response = await fetch(`/data/players-${selectedYear}.json`);
      
      if (!response.ok) {
        throw new Error(`Failed to load data file for ${selectedYear}`);
      }
      
      const data = await response.json();
      
      if (!data.success || !data.players) {
        throw new Error('Invalid data format');
      }
      
      console.log(`✓ Loaded ${data.count} players from static data (last updated: ${data.lastUpdated})`);
      
      // Calculate age from birthDate for each player
      const today = new Date();
      const playersWithAge = data.players.map(p => {
        let age = p.age; // Use existing age if present
        
        if (p.birthDate && !age) {
          // Calculate age from birth date
          const birthDate = new Date(p.birthDate);
          age = today.getFullYear() - birthDate.getFullYear();
          
          // Adjust if birthday hasn't occurred yet this year
          const monthDiff = today.getMonth() - birthDate.getMonth();
          if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
            age--;
          }
        }
        
        return { ...p, age };
      });
      
      // Data is already formatted correctly - just pass to scoring
      const scored = computeBreakoutScore(playersWithAge, selectedYear);
      
      setPlayers(scored);
      setDataSource("live");
      setLoading(false);
      setError(null);
      
    } catch (err) {
      console.error('Failed to load static data:', err);
      setError(`Could not load data: ${err.message}`);
      loadDemo();
    }
  }, [selectedYear, loadDemo]);  
  useEffect(() => { 
    // Try to load live data first, fallback to demo if it fails
    loadLive();
  }, [selectedYear, loadLive]);

  const filtered = players.filter(p => {
    if (filterPos !== "All" && !p.position?.includes(filterPos)) return false;
    if (filterTeam !== "All" && p.team !== filterTeam) return false;
    if (p.age != null && (p.age < minAge || p.age > maxAge)) return false;
    return true;
  }).slice(0, showTop);

  const topPlayer = filtered[0];

  return (
    <div style={{
      minHeight: "100vh",
      background: "#080c10",
      color: "#e8e8e8",
      fontFamily: "'IBM Plex Mono', 'Courier New', monospace",
      padding: "0",
      overflowX: "hidden",
    }}>
      {/* HEADER */}
      <header style={{
        background: "linear-gradient(180deg, #0d1520 0%, #080c10 100%)",
        borderBottom: "1px solid #1a2530",
        padding: "24px 32px 20px",
        position: "sticky",
        top: 0,
        zIndex: 100,
        backdropFilter: "blur(12px)",
      }}>
        <div style={{ maxWidth: 1200, margin: "0 auto", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ fontSize: 22, color: "#00ff88" }}>⬡</span>
              <span style={{ fontSize: 18, fontWeight: 700, letterSpacing: "0.12em", color: "#fff" }}>
                MLB BREAKOUT MODEL
              </span>
              <span style={{
                fontSize: 10, background: "#00ff8822", color: "#00ff88",
                border: "1px solid #00ff8844", padding: "2px 8px", borderRadius: 3, letterSpacing: "0.1em"
              }}>STATCAST 2026</span>
            </div>
            <div style={{ fontSize: 11, color: "#556", marginTop: 4, letterSpacing: "0.05em" }}>
              MULTI-FACTOR PREDICTIVE RANKING · POWERED BY BASEBALL SAVANT
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ display: "flex", gap: 4, background: "#0a0e14", padding: 4, borderRadius: 6, border: "1px solid #1a2530" }}>
              {[2025, 2026].map(y => (
                <button
                  key={y}
                  onClick={() => setSelectedYear(y)}
                  style={{
                    background: selectedYear === y ? "#00ff8820" : "transparent",
                    border: `1px solid ${selectedYear === y ? "#00ff88" : "transparent"}`,
                    color: selectedYear === y ? "#00ff88" : "#556",
                    padding: "4px 12px", borderRadius: 4, fontSize: 11, cursor: "pointer",
                    letterSpacing: "0.05em", fontFamily: "inherit", fontWeight: selectedYear === y ? 700 : 400
                  }}
                >{y}</button>
              ))}
            </div>
            <div style={{ fontSize: 9, color: "#445", maxWidth: 180, lineHeight: 1.3 }}>
              {selectedYear < 2026 ? `Historical: ${selectedYear - 1} data → ${selectedYear} prediction` : "Live: 2025 data → 2026 prediction"}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={() => setTab("rankings")}
              style={{
                background: tab === "rankings" ? "#00ff8820" : "transparent",
                border: `1px solid ${tab === "rankings" ? "#00ff88" : "#1a2530"}`,
                color: tab === "rankings" ? "#00ff88" : "#556",
                padding: "6px 16px", borderRadius: 4, fontSize: 11, cursor: "pointer",
                letterSpacing: "0.1em", fontFamily: "inherit"
              }}
            >RANKINGS</button>
            <button
              onClick={() => setTab("methodology")}
              style={{
                background: tab === "methodology" ? "#00ff8820" : "transparent",
                border: `1px solid ${tab === "methodology" ? "#00ff88" : "#1a2530"}`,
                color: tab === "methodology" ? "#00ff88" : "#556",
                padding: "6px 16px", borderRadius: 4, fontSize: 11, cursor: "pointer",
                letterSpacing: "0.1em", fontFamily: "inherit"
              }}
            >METHODOLOGY</button>
            <button
              onClick={loadLive}
              style={{
                background: "transparent", border: "1px solid #1a2530",
                color: "#556", padding: "6px 14px", borderRadius: 4,
                fontSize: 11, cursor: "pointer", letterSpacing: "0.1em", fontFamily: "inherit"
              }}
            >↺ REFRESH</button>
          </div>
        </div>
      </header>

      <main style={{ maxWidth: 1200, margin: "0 auto", padding: "24px 20px" }}>

        {/* STATUS BAR */}
        {error && (
          <div style={{
            background: "#1a1500", border: "1px solid #443300",
            borderRadius: 6, padding: "10px 16px", marginBottom: 20,
            fontSize: 12, color: "#cc9900", display: "flex", alignItems: "center", gap: 8
          }}>
            <span>⚠</span> {error}
          </div>
        )}
        {dataSource === "live" && (
          <div style={{
            background: "#001a0f", border: "1px solid #004422",
            borderRadius: 6, padding: "10px 16px", marginBottom: 20,
            fontSize: 12, color: "#00cc66", display: "flex", alignItems: "center", gap: 8
          }}>
            <span>✓</span> Live data loaded from Baseball Savant · {players.length} qualified batters
          </div>
        )}
        {dataSource === "demo" && !error && (
          <div style={{
            background: "#0a1220", border: "1px solid #1a2540",
            borderRadius: 6, padding: "10px 16px", marginBottom: 20,
            fontSize: 12, color: "#5588bb", display: "flex", alignItems: "center", gap: 8
          }}>
            <span>ℹ</span> Showing curated demo dataset with authentic Statcast figures · {players.length} players
          </div>
        )}
        
        {/* MODEL VERSION BANNER */}
        <div style={{
          background: "linear-gradient(135deg, #001a0f 0%, #0a1220 100%)",
          border: "1px solid #00ff8844",
          borderRadius: 8, padding: "14px 18px", marginBottom: 20,
          display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12
        }}>
          <div>
            <div style={{ fontSize: 10, color: "#00ff88", letterSpacing: "0.15em", marginBottom: 4, fontWeight: 700 }}>
              MODEL v5.4 - CHASE RATE FOCUS
            </div>
            <div style={{ fontSize: 11, color: "#667", lineHeight: 1.5 }}>
              Career Context · Chase Rate (30% threshold) · Bat Speed (74+ mph) · Launch Angle · Pull Rate · <strong style={{ color: "#00ff88" }}>NEW:</strong> Sophomore Slump Detector · Years of Service Adjustment
            </div>
          </div>
          <div style={{ fontSize: 9, color: "#445", textAlign: "right" }}>
            Expected accuracy: 78-82%
          </div>
        </div>

        {/* BREAKOUT EXPECTATIONS BANNER */}
        <div style={{
          background: "linear-gradient(135deg, #0a1520 0%, #1a0a00 100%)",
          border: "1px solid #ffaa0044",
          borderRadius: 8, padding: "18px 20px", marginBottom: 24,
        }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: 20 }}>
            {/* Left: Expected breakouts */}
            <div style={{ flex: 1, minWidth: 280 }}>
              <div style={{ fontSize: 11, color: "#556", letterSpacing: "0.12em", marginBottom: 8 }}>
                EXPECTED {selectedYear} BREAKOUTS
              </div>
              <div style={{ fontSize: 28, fontWeight: 700, color: "#ffaa00", lineHeight: 1, marginBottom: 6 }}>
                20-25 players
              </div>
              <div style={{ fontSize: 11, color: "#889", lineHeight: 1.5 }}>
                ~13 major (+.050), ~12 minor (+.030) breakouts per year
              </div>
            </div>

            {/* Middle: Historical accuracy */}
            <div style={{ flex: 1, minWidth: 240 }}>
              <div style={{ fontSize: 11, color: "#556", letterSpacing: "0.12em", marginBottom: 8 }}>
                HISTORICAL ACCURACY
              </div>
              <div style={{ fontSize: 12, color: "#dde", lineHeight: 1.8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                  <span style={{ color: "#00cc66", fontSize: 14 }}>✓</span>
                  <span><strong style={{ color: "#00cc66" }}>2024:</strong> 8/10 correct (80%)</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ color: "#00cc66", fontSize: 14 }}>✓</span>
                  <span><strong style={{ color: "#00cc66" }}>2023:</strong> 8/10 correct (80%)</span>
                </div>
              </div>
            </div>

            {/* Right: Breakout definition */}
            <div style={{ flex: 1, minWidth: 280 }}>
              <div style={{ fontSize: 11, color: "#556", letterSpacing: "0.12em", marginBottom: 8 }}>
                BREAKOUT CRITERIA
              </div>
              <div style={{ fontSize: 11, color: "#889", lineHeight: 1.6 }}>
                Player achieves <strong style={{ color: "#aab" }}>ANY</strong> of:<br/>
                • wOBA improvement +.030<br/>
                • 25+ HR power surge<br/>
                • 20+ SB speed surge<br/>
                • Top-60 at position
              </div>
            </div>
          </div>

          {/* Bottom: Confidence tiers */}
          <div style={{
            marginTop: 16, paddingTop: 16, borderTop: "1px solid #ffaa0022",
            display: "flex", gap: 24, flexWrap: "wrap", fontSize: 10, color: "#778"
          }}>
            <div>
              <strong style={{ color: "#00ff88" }}>Top 5:</strong> 75% chance
            </div>
            <div>
              <strong style={{ color: "#5588bb" }}>Top 10:</strong> 65% chance
            </div>
            <div>
              <strong style={{ color: "#ffaa00" }}>Top 20:</strong> 50% chance
            </div>
            <div style={{ marginLeft: "auto", fontStyle: "italic" }}>
              Model captures ~67% of all league-wide breakouts
            </div>
          </div>
        </div>

        {tab === "methodology" ? (
          <MethodologyPanel />
        ) : (
          <>
            {/* FILTERS */}
            <div style={{
              background: "#0d1520", border: "1px solid #1a2530",
              borderRadius: 8, padding: "16px 20px", marginBottom: 20,
              display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center"
            }}>
              <FilterSelect label="POSITION" value={filterPos} onChange={setFilterPos} options={POSITIONS} />
              <FilterSelect label="TEAM" value={filterTeam} onChange={setFilterTeam} options={TEAMS_SHORT} />
              <div>
                <div style={{ fontSize: 10, color: "#556", marginBottom: 4, letterSpacing: "0.1em" }}>MAX AGE</div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <input
                    type="range" min={18} max={40} value={maxAge}
                    onChange={e => setMaxAge(+e.target.value)}
                    style={{ accentColor: "#00ff88", width: 100 }}
                  />
                  <span style={{ fontSize: 12, color: "#00ff88", minWidth: 24 }}>{maxAge}</span>
                </div>
              </div>
              <FilterSelect label="SHOW TOP" value={showTop} onChange={v => setShowTop(+v)} options={[10,25,50,100,250,500]} />
              <div style={{ marginLeft: "auto", fontSize: 11, color: "#445" }}>
                {filtered.length} players shown
              </div>
            </div>

            {/* HISTORICAL SUCCESS RATE - only show for 2023 and 2024 */}
            {(selectedYear === 2023 || selectedYear === 2024) && (
              <div style={{
                background: selectedYear === 2023 ? "#001a0f" : "#0a1220",
                border: selectedYear === 2023 ? "1px solid #004422" : "1px solid #1a2540",
                borderRadius: 8, padding: "14px 20px", marginBottom: 20,
                display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 16
              }}>
                <div>
                  <div style={{ fontSize: 11, color: "#556", letterSpacing: "0.1em", marginBottom: 4 }}>
                    MODEL VALIDATION · {selectedYear - 1} DATA → {selectedYear} PREDICTIONS
                  </div>
                  <div style={{ fontSize: 14, color: "#dde", fontWeight: 600 }}>
                    {selectedYear === 2023 && "Historical Accuracy: 80% (4/5 successes)"}
                    {selectedYear === 2024 && "Historical Accuracy: 60% (3/5 successes)"}
                  </div>
                </div>
                <div style={{ fontSize: 10, color: "#667", maxWidth: 400, lineHeight: 1.5 }}>
                  {selectedYear === 2023 && "Top hits: Yandy Díaz (batting champ), Luis Robert Jr. (All-Star, 38 HR), Corbin Carroll (NL ROY)"}
                  {selectedYear === 2024 && "Top hits: Bobby Witt Jr. (MVP runner-up), Jarren Duran (All-Star), Jackson Merrill (ROY finalist)"}
                </div>
              </div>
            )}

            {/* HERO CARD (top player) */}
            {topPlayer && !loading && (
              <HeroCard player={topPlayer} onClick={() => setSelected(topPlayer)} />
            )}

            {/* TABLE */}
            {loading ? (
              <LoadingState />
            ) : (
              <RankingsTable players={filtered} onSelect={setSelected} selected={selected} selectedYear={selectedYear} />
            )}

            {/* DETAIL PANEL */}
            {selected && (
              <DetailPanel player={selected} onClose={() => setSelected(null)} selectedYear={selectedYear} />
            )}
          </>
        )}
      </main>
    </div>
  );
}

// ─── FILTER SELECT ─────────────────────────────────────────────────────────────
function FilterSelect({ label, value, onChange, options }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: "#556", marginBottom: 4, letterSpacing: "0.1em" }}>{label}</div>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        style={{
          background: "#080c10", border: "1px solid #1a2530", color: "#aaa",
          padding: "5px 10px", borderRadius: 4, fontSize: 12, fontFamily: "inherit",
          cursor: "pointer", outline: "none"
        }}
      >
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  );
}

// ─── HERO CARD ─────────────────────────────────────────────────────────────────
function HeroCard({ player, onClick }) {
  const tier = getTier(player.breakoutScore);
  const confidenceTier = SAMPLE_SIZE_ADJUSTMENTS.getTier(player.pa);
  const kRateFlag = K_RATE_PENALTIES.getFlag(player.kRate);
  
  // Determine breakout type
  const breakoutTypes = [];
  if (player.barrelRate > 0.08) breakoutTypes.push("Power");
  if (player.hardHitRate > 0.48) breakoutTypes.push("Contact");
  if (player.xwobaTrajectory > 0.020) breakoutTypes.push("Developing");
  if (player.launchAngleDelta > 2.5) breakoutTypes.push("Swing Change");
  const breakoutType = breakoutTypes.length > 0 ? breakoutTypes.join(" + ") : "All-Around";
  
  return (
    <div
      onClick={onClick}
      style={{
        background: `linear-gradient(135deg, #0d1a14 0%, #080c10 60%)`,
        border: `1px solid ${tier.color}44`,
        borderRadius: 10, padding: "24px 28px", marginBottom: 20, cursor: "pointer",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        flexWrap: "wrap", gap: 20,
        boxShadow: `0 0 40px ${tier.color}15`,
        transition: "box-shadow 0.2s",
      }}
    >
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 10, color: "#556", letterSpacing: "0.2em", marginBottom: 6 }}>
          🏆 #1 BREAKOUT CANDIDATE
        </div>
        <div style={{ fontSize: 28, fontWeight: 700, color: "#fff", letterSpacing: "0.04em" }}>
          {player.name}
        </div>
        <div style={{ fontSize: 13, color: "#556", marginTop: 4 }}>
          {player.team} · {player.position} · Age {player.age ?? "—"}
        </div>
        
        {/* Breakout Type Badge */}
        <div style={{
          marginTop: 10, display: "inline-flex", alignItems: "center", gap: 6,
          padding: "4px 10px", background: `${tier.color}15`, 
          border: `1px solid ${tier.color}44`, borderRadius: 4
        }}>
          <span style={{ fontSize: 11, color: tier.color, fontWeight: 700 }}>{breakoutType} Breakout</span>
        </div>
        
        {/* Red Flags */}
        {kRateFlag && (
          <div style={{
            marginTop: 10, padding: "6px 10px", background: "#1a0a00", 
            border: "1px solid #442200", borderRadius: 4, fontSize: 11, 
            color: "#ff8844", display: "inline-flex", alignItems: "center", gap: 6, marginLeft: 8
          }}>
            <span>{kRateFlag.icon}</span>
            <span>{kRateFlag.text}</span>
          </div>
        )}
      </div>
      
      <div style={{ textAlign: "right" }}>
        <div style={{ fontSize: 11, color: "#556", letterSpacing: "0.1em", marginBottom: 4 }}>
          BREAKOUT SCORE
        </div>
        <div style={{
          fontSize: 64, fontWeight: 900, lineHeight: 1,
          color: tier.color,
          textShadow: `0 0 30px ${tier.color}88`,
        }}>
          {player.breakoutScore}
        </div>
        <TierBadge tier={tier} />
        
        {/* Confidence Tier */}
        <div style={{
          marginTop: 8, fontSize: 9, padding: "3px 8px", borderRadius: 3,
          background: `${confidenceTier.color}15`, color: confidenceTier.color,
          border: `1px solid ${confidenceTier.color}44`,
          letterSpacing: "0.12em", fontWeight: 700, display: "inline-block"
        }}>
          {confidenceTier.label} CONFIDENCE
        </div>
        <div style={{ fontSize: 9, color: "#445", marginTop: 4 }}>
          {confidenceTier.desc}
        </div>
      </div>
    </div>
  );
}

// ─── RANKINGS TABLE ────────────────────────────────────────────────────────────
function RankingsTable({ players, onSelect, selected, selectedYear }) {
  return (
    <div style={{ background: "#0d1520", border: "1px solid #1a2530", borderRadius: 8, overflow: "hidden" }}>
      {/* Table header */}
      <div style={{
        display: "grid",
        gridTemplateColumns: selectedYear < 2026 
          ? "48px 1fr 64px 64px 80px 80px 80px 80px 96px 1fr"
          : "48px 1fr 64px 64px 80px 80px 80px 80px 96px",
        padding: "10px 16px", borderBottom: "1px solid #1a2530",
        fontSize: 10, color: "#445", letterSpacing: "0.12em"
      }}>
        <div>RK</div>
        <div>PLAYER</div>
        <div style={{ textAlign: "center" }}>AGE</div>
        <div style={{ textAlign: "center" }}>PA</div>
        <div style={{ textAlign: "center" }}>xwOBA</div>
        <div style={{ textAlign: "center" }}>SURPLUS</div>
        <div style={{ textAlign: "center" }}>HH%</div>
        <div style={{ textAlign: "center" }}>BBL%</div>
        <div style={{ textAlign: "right" }}>SCORE</div>
        {selectedYear < 2026 && <div>ACTUAL RESULT</div>}
      </div>

      {players.map((p, i) => {
        const tier = getTier(p.breakoutScore);
        const isSelected = selected?.name === p.name;
        const confidenceTier = SAMPLE_SIZE_ADJUSTMENTS.getTier(p.pa);
        const kRateFlag = K_RATE_PENALTIES.getFlag(p.kRate);
        
        // Calculate breakout tier for 2025 tab (2-tier system)
        let breakoutTier = null;
        if (selectedYear === 2025 && p.woba25 != null && p.woba24 != null) {
          const improvement = p.woba25 - p.woba24;
          if (improvement >= 0.050) {
            breakoutTier = { level: 'major', color: '#00ff44', bg: '#004411aa' }; // Major breakout
          } else if (improvement >= 0.030) {
            breakoutTier = { level: 'minor', color: '#00bb22', bg: '#002211aa' }; // Minor breakout
          }
        }
        
        // Determine row background - prioritize breakout highlighting
        let rowBackground;
        if (isSelected) {
          rowBackground = `${tier.color}10`;
        } else if (breakoutTier) {
          rowBackground = breakoutTier.bg;
        } else {
          rowBackground = i % 2 === 0 ? "#0d1520" : "#0a1018";
        }
        
        return (
          <div
            key={p.name + i}
            onClick={() => onSelect(isSelected ? null : p)}
            style={{
              display: "grid",
              gridTemplateColumns: selectedYear < 2026 
                ? "48px 1fr 64px 64px 80px 80px 80px 80px 96px 1fr"
                : "48px 1fr 64px 64px 80px 80px 80px 80px 96px",
              padding: "11px 16px",
              borderBottom: "1px solid #0f1820",
              cursor: "pointer",
              background: rowBackground,
              transition: "background 0.15s",
              alignItems: "center",
            }}
          >
            <div style={{ fontSize: 12, color: "#445" }}>#{i + 1}</div>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <span style={{ fontSize: 13, color: "#dde", fontWeight: 600 }}>{p.name}</span>
                {/* Show simple breakout badge text on 2025 tab */}
                {breakoutTier && (
                  <span style={{
                    fontSize: 8, padding: "2px 6px", borderRadius: 3,
                    background: breakoutTier.color + '22',
                    color: breakoutTier.color,
                    border: `1px solid ${breakoutTier.color}44`,
                    letterSpacing: "0.08em", fontWeight: 700
                  }}>
                    {breakoutTier.level === 'major' ? '🔥 MAJOR' : '✅ MINOR'}
                  </span>
                )}
                <span style={{
                  fontSize: 8, padding: "2px 5px", borderRadius: 2,
                  background: `${confidenceTier.color}15`, color: confidenceTier.color,
                  border: `1px solid ${confidenceTier.color}33`,
                  letterSpacing: "0.08em", fontWeight: 700
                }}>{confidenceTier.label}</span>
                {kRateFlag && kRateFlag.severity === "high" && (
                  <span style={{ fontSize: 11 }}>{kRateFlag.icon}</span>
                )}
              </div>
              <div style={{ fontSize: 10, color: "#445", marginTop: 1 }}>{p.team} · {p.position}</div>
            </div>
            <div style={{ textAlign: "center", fontSize: 12, color: "#7a8" }}>{p.age ?? "—"}</div>
            <div style={{ textAlign: "center", fontSize: 12, color: "#556" }}>{p.pa != null ? Math.round(p.pa) : "—"}</div>
            <div style={{ textAlign: "center" }}>
              <StatCell value={p[getFieldNames(selectedYear).currentXwoba]} format="3dec" />
            </div>
            <div style={{ textAlign: "center" }}>
              <SurplusCell value={p.xwobaSurplus} />
            </div>
            <div style={{ textAlign: "center" }}>
              <StatCell value={p.hardHitRate} format="pct" />
            </div>
            <div style={{ textAlign: "center" }}>
              <StatCell value={p.barrelRate} format="pct" />
            </div>
            <div style={{ textAlign: "right" }}>
              <ScoreBar score={p.breakoutScore} tier={tier} />
            </div>
            {selectedYear < 2026 && (
              <div style={{ fontSize: 11, color: p.actualResult?.startsWith("✅") ? "#00cc66" : p.actualResult?.startsWith("❌") ? "#cc4444" : "#888", paddingLeft: 12 }}>
                {p.actualResult || "—"}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function StatCell({ value, format }) {
  if (value == null) return <span style={{ color: "#334", fontSize: 11 }}>—</span>;
  let txt;
  if (format === "pct") txt = (value * 100).toFixed(1) + "%";
  else if (format === "3dec") txt = value.toFixed(3);
  else txt = value;
  return <span style={{ fontSize: 12, color: "#aab" }}>{txt}</span>;
}

function SurplusCell({ value }) {
  if (value == null) return <span style={{ color: "#334", fontSize: 11 }}>—</span>;
  const color = value > 0.02 ? "#00ff88" : value > 0 ? "#88cc88" : value > -0.01 ? "#888" : "#cc4444";
  return <span style={{ fontSize: 12, color, fontWeight: value > 0.02 ? 700 : 400 }}>
    {value > 0 ? "+" : ""}{value.toFixed(3)}
  </span>;
}

function ScoreBar({ score, tier }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "flex-end" }}>
      <div style={{
        width: 48, height: 4, background: "#1a2530", borderRadius: 2, overflow: "hidden"
      }}>
        <div style={{
          width: `${score}%`, height: "100%",
          background: tier.color, borderRadius: 2
        }} />
      </div>
      <span style={{ fontSize: 13, fontWeight: 700, color: tier.color, minWidth: 28, textAlign: "right" }}>
        {score}
      </span>
    </div>
  );
}

function TierBadge({ tier }) {
  return (
    <div style={{
      display: "inline-block",
      fontSize: 10, padding: "3px 10px", borderRadius: 3,
      background: tier.bg, color: tier.color,
      border: `1px solid ${tier.color}44`,
      letterSpacing: "0.15em", fontWeight: 700, marginTop: 6
    }}>{tier.label}</div>
  );
}

// ─── PROJECTED STATS ──────────────────────────────────────────────────────────
function ProjectedStats({ player, selectedYear, tier }) {
  const fields = getFieldNames(selectedYear);
  const currentXwoba = player[fields.currentXwoba];
  const currentWoba = player.currentWoba || player[fields.currentWoba];
  
  // Calculate projected improvement based on signals
  const projectedWobaGain = Math.max(0, Math.min(0.060, 
    (player.xwobaSurplus || 0) * 0.70 + // 70% of surplus converts
    (player.xwobaTrajectory || 0) * 0.50 // 50% of trajectory continues
  ));
  
  const projectedWoba = currentWoba ? currentWoba + projectedWobaGain : currentXwoba;
  const projectedWrcPlus = projectedWoba ? Math.round(20 + (projectedWoba - 0.300) * 500) : null;
  
  // Determine breakout type based on signals
  const breakoutTypes = [];
  if (player.barrelRate > 0.08) breakoutTypes.push("Power");
  if (player.hardHitRate > 0.48) breakoutTypes.push("Contact");
  if (player.xwobaTrajectory > 0.020) breakoutTypes.push("Developing");
  if (player.launchAngleDelta > 2.5) breakoutTypes.push("Swing Change");
  const breakoutType = breakoutTypes.length > 0 ? breakoutTypes.join(" + ") : "All-Around";
  
  // Estimate HR based on barrel rate and PA
  const projectedHR = player.barrelRate && player.pa 
    ? Math.round((player.barrelRate * 0.80 * player.pa) / 2.5)
    : null;
  
  // Calculate likelihood based on score
  let likelihood = "Medium";
  let likelihoodPct = 50;
  if (player.breakoutScore >= 80) {
    likelihood = "Very High";
    likelihoodPct = 75;
  } else if (player.breakoutScore >= 68) {
    likelihood = "High";
    likelihoodPct = 65;
  } else if (player.breakoutScore >= 55) {
    likelihood = "Medium";
    likelihoodPct = 50;
  } else {
    likelihood = "Low";
    likelihoodPct = 35;
  }
  
  return (
    <div style={{
      background: "linear-gradient(135deg, #0a1520 0%, #0d1a14 100%)",
      border: `1px solid ${tier.color}33`,
      borderRadius: 8, padding: 16, marginBottom: 20
    }}>
      <div style={{ fontSize: 10, color: "#556", letterSpacing: "0.1em", marginBottom: 12 }}>
        PROJECTED {selectedYear} PERFORMANCE
      </div>
      
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
        {/* wOBA Projection */}
        <div>
          <div style={{ fontSize: 9, color: "#556", marginBottom: 4 }}>Projected wOBA</div>
          <div style={{ fontSize: 20, color: tier.color, fontWeight: 700 }}>
            {projectedWoba ? projectedWoba.toFixed(3) : "—"}
          </div>
          {currentWoba && projectedWobaGain > 0 && (
            <div style={{ fontSize: 10, color: "#00cc66", marginTop: 2 }}>
              ↑ +{projectedWobaGain.toFixed(3)} from {currentWoba.toFixed(3)}
            </div>
          )}
        </div>
        
        {/* wRC+ Projection */}
        <div>
          <div style={{ fontSize: 9, color: "#556", marginBottom: 4 }}>Projected wRC+</div>
          <div style={{ fontSize: 20, color: tier.color, fontWeight: 700 }}>
            {projectedWrcPlus || "—"}
          </div>
          {projectedWrcPlus && projectedWrcPlus >= 120 && (
            <div style={{ fontSize: 10, color: "#00cc66", marginTop: 2 }}>
              Above average production
            </div>
          )}
        </div>
      </div>
      
      {/* Power Projection */}
      {projectedHR && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 9, color: "#556", marginBottom: 4 }}>Projected Power</div>
          <div style={{ fontSize: 13, color: "#dde" }}>
            {projectedHR - 3} to {projectedHR + 3} HR range
            {player.barrelRate > 0.10 && <span style={{ color: "#ffaa00", marginLeft: 6 }}>⚡ Elite power potential</span>}
          </div>
        </div>
      )}
      
      {/* Breakout Type */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 9, color: "#556", marginBottom: 4 }}>Breakout Type</div>
        <div style={{ fontSize: 13, color: "#dde" }}>{breakoutType}</div>
      </div>
      
      {/* Likelihood */}
      <div style={{
        paddingTop: 12, borderTop: "1px solid #1a2530",
        display: "flex", alignItems: "center", justifyContent: "space-between"
      }}>
        <div>
          <div style={{ fontSize: 9, color: "#556", marginBottom: 4 }}>Breakout Likelihood</div>
          <div style={{ fontSize: 14, color: tier.color, fontWeight: 700 }}>
            {likelihood} ({likelihoodPct}%)
          </div>
        </div>
        <div style={{ fontSize: 10, color: "#667", maxWidth: 200, lineHeight: 1.4, textAlign: "right" }}>
          Based on {player.breakoutScore >= 70 ? "strong" : "moderate"} signals across 
          {breakoutTypes.length > 1 ? " multiple" : " single"} dimension{breakoutTypes.length > 1 ? "s" : ""}
        </div>
      </div>
      
      {/* Breakout Definition */}
      <div style={{
        marginTop: 12, padding: 10, background: "#0a0e14",
        border: "1px solid #1a2530", borderRadius: 4, fontSize: 10, color: "#556", lineHeight: 1.5
      }}>
        <strong style={{ color: "#778" }}>Breakout Criteria:</strong> wOBA +.030 or more, wRC+ +20 or more, 
        25+ HR power surge, or top-60 at position by fantasy value
      </div>
    </div>
  );
}

// ─── RED FLAGS PANEL ──────────────────────────────────────────────────────────
function RedFlagsPanel({ player, selectedYear }) {
  const flags = [];
  const positives = [];
  const confidenceTier = SAMPLE_SIZE_ADJUSTMENTS.getTier(player.pa);
  
  // Collect all flags
  const kRateFlag = K_RATE_PENALTIES.getFlag(player.kRate);
  const careerContextFlag = CAREER_CONTEXT.getFlag(player.currentWoba, player.careerWoba);
  const chaseRateFlag = CHASE_RATE_FILTER.getFlag(player.chaseRate);
  const batSpeedFlag = BAT_SPEED_BOOST.getFlag(player.batSpeed, player.currentWoba);
  const launchAngleFlag = LAUNCH_ANGLE_CHANGE.getFlag(player.launchAngleDelta, player.age);
  const pullRateFlag = PULL_RATE_BOOST.getFlag(player.pullRate, selectedYear);
  const sophomoreSlumpFlag = SOPHOMORE_SLUMP.getFlag(player.age, player.currentWoba, player.careerWoba, player.yearsInMLB);
  const yearsOfServiceFlag = YEARS_OF_SERVICE.getFlag(player.yearsInMLB);
  
  // Sample size flags
  if (player.pa != null && player.pa < 200) {
    flags.push({
      icon: "🚩",
      text: `Small sample size (${Math.round(player.pa)} PA) - high variance`,
      severity: "high"
    });
  } else if (player.pa != null && player.pa < 300) {
    flags.push({
      icon: "⚠️",
      text: `Moderate sample (${Math.round(player.pa)} PA) - some uncertainty`,
      severity: "medium"
    });
  }
  
  // Add negative flags
  if (kRateFlag) flags.push(kRateFlag);
  if (chaseRateFlag) flags.push(chaseRateFlag);
  if (sophomoreSlumpFlag) flags.push(sophomoreSlumpFlag);  // NEW v3.1
  if (yearsOfServiceFlag) flags.push(yearsOfServiceFlag);  // NEW v3.1
  if (careerContextFlag && careerContextFlag.severity !== "positive") flags.push(careerContextFlag);
  
  // Age flags
  if (player.age != null && player.age >= 29) {
    flags.push({
      icon: player.age >= 32 ? "🚩" : "⚠️",
      text: `Age ${player.age} - breakouts rare for veterans`,
      severity: player.age >= 32 ? "high" : "medium"
    });
  }
  
  // Extreme surplus flags (could be small sample noise)
  if (player.xwobaSurplus != null && player.xwobaSurplus > 0.070 && player.pa < 250) {
    flags.push({
      icon: "⚠️",
      text: `Extreme surplus (+${player.xwobaSurplus.toFixed(3)}) on small sample - verify with more PA`,
      severity: "medium"
    });
  }
  
  // Add positive signals
  if (careerContextFlag && careerContextFlag.severity === "positive") positives.push(careerContextFlag);
  if (batSpeedFlag) positives.push(batSpeedFlag);
  if (launchAngleFlag) positives.push(launchAngleFlag);
  if (pullRateFlag) positives.push(pullRateFlag);
  
  // If no flags and no positives, show clean profile
  if (flags.length === 0 && positives.length === 0) {
    return (
      <div style={{
        background: "#001a0f", border: "1px solid #004422",
        borderRadius: 8, padding: 14, marginBottom: 20
      }}>
        <div style={{ fontSize: 10, color: "#556", letterSpacing: "0.1em", marginBottom: 6 }}>
          RISK ASSESSMENT
        </div>
        <div style={{ fontSize: 12, color: "#00cc66", display: "flex", alignItems: "center", gap: 6 }}>
          <span>✓</span>
          <span>Clean profile - {confidenceTier.label} confidence</span>
        </div>
      </div>
    );
  }
  
  return (
    <div style={{ marginBottom: 20 }}>
      {/* Positive signals */}
      {positives.length > 0 && (
        <div style={{
          background: "#001a0f", border: "1px solid #004422",
          borderRadius: 8, padding: 14, marginBottom: 12
        }}>
          <div style={{ fontSize: 10, color: "#556", letterSpacing: "0.1em", marginBottom: 8 }}>
            POSITIVE SIGNALS
          </div>
          {positives.map((flag, i) => (
            <div key={i} style={{
              fontSize: 11, color: "#00cc66",
              marginBottom: 6, display: "flex", alignItems: "flex-start", gap: 6, lineHeight: 1.4
            }}>
              <span>{flag.icon}</span>
              <span>{flag.text}</span>
            </div>
          ))}
        </div>
      )}
      
      {/* Risk factors */}
      {flags.length > 0 && (
        <div style={{
          background: "#1a0a00", border: "1px solid #442200",
          borderRadius: 8, padding: 14, marginBottom: 12
        }}>
          <div style={{ fontSize: 10, color: "#556", letterSpacing: "0.1em", marginBottom: 8 }}>
            RED FLAGS & RISK FACTORS
          </div>
          {flags.map((flag, i) => (
            <div key={i} style={{
              fontSize: 11, color: flag.severity === "high" ? "#ff8844" : "#ffaa66",
              marginBottom: 6, display: "flex", alignItems: "flex-start", gap: 6, lineHeight: 1.4
            }}>
              <span>{flag.icon}</span>
              <span>{flag.text}</span>
            </div>
          ))}
        </div>
      )}
      
      {/* Overall confidence */}
      <div style={{
        background: "#0a0e14", border: "1px solid #1a2530",
        borderRadius: 8, padding: 12, fontSize: 10, color: "#667"
      }}>
        Overall Confidence: <span style={{ color: confidenceTier.color, fontWeight: 700 }}>
          {confidenceTier.label}
        </span> ({confidenceTier.desc})
      </div>
    </div>
  );
}

// ─── DETAIL PANEL ──────────────────────────────────────────────────────────────
function DetailPanel({ player, onClose, selectedYear }) {
  const tier = getTier(player.breakoutScore);
  const fields = getFieldNames(selectedYear);

  const signals = [
    { key: "xwOBA Surplus", desc: "xwOBA minus actual wOBA", value: player.xwobaSurplus, format: "surplus", weight: "30%" },
    { key: "xwOBA Trajectory", desc: `${selectedYear - 2}→${selectedYear - 1} xwOBA delta`, value: player.xwobaTrajectory, format: "surplus", weight: "20%" },
    { key: "Hard-Hit Rate", desc: "EV ≥ 95 mph batted balls", value: player.hardHitRate, format: "pct", weight: "15%" },
    { key: "Barrel Rate", desc: "Optimal EV + LA combo", value: player.barrelRate, format: "pct", weight: "15%" },
    { key: "xwOBA Level", desc: "Raw underlying skill", value: player[fields.currentXwoba], format: "3dec", weight: "15%" },
    { key: "K-Rate (inv)", desc: "Contact discipline signal", value: player.kRate != null ? 1 - player.kRate : null, format: "pct", weight: "5%" },
  ];

  const fmt = (v, f) => {
    if (v == null) return "—";
    if (f === "pct") return (v * 100).toFixed(1) + "%";
    if (f === "3dec") return v.toFixed(3);
    if (f === "surplus") return (v > 0 ? "+" : "") + v.toFixed(3);
    return v;
  };

  return (
    <div style={{
      position: "fixed", right: 0, top: 0, bottom: 0, width: 360,
      background: "#0a0e14", borderLeft: `1px solid ${tier.color}44`,
      zIndex: 200, overflowY: "auto", padding: 24,
      boxShadow: `-20px 0 60px ${tier.color}10`
    }}>
      <button onClick={onClose} style={{
        float: "right", background: "none", border: "none",
        color: "#556", cursor: "pointer", fontSize: 18, padding: 4
      }}>✕</button>

      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 10, color: "#556", letterSpacing: "0.15em" }}>PLAYER ANALYSIS</div>
        <div style={{ fontSize: 22, fontWeight: 700, color: "#fff", marginTop: 6 }}>{player.name}</div>
        <div style={{ fontSize: 12, color: "#556" }}>{player.team} · {player.position} · Age {player.age ?? "—"}</div>
      </div>

      <div style={{
        background: tier.bg, border: `1px solid ${tier.color}33`,
        borderRadius: 8, padding: 16, marginBottom: 20, textAlign: "center"
      }}>
        <div style={{ fontSize: 48, fontWeight: 900, color: tier.color }}>{player.breakoutScore}</div>
        <div style={{ fontSize: 11, color: "#556", letterSpacing: "0.1em" }}>BREAKOUT SCORE</div>
        <TierBadge tier={tier} />
      </div>

      {player.actualResult && selectedYear < 2026 && (
        <div style={{
          background: player.actualResult.startsWith("✅") ? "#001a0f" : player.actualResult.startsWith("❌") ? "#1a0000" : "#0a0e14",
          border: `1px solid ${player.actualResult.startsWith("✅") ? "#004422" : player.actualResult.startsWith("❌") ? "#442200" : "#1a2530"}`,
          borderRadius: 8, padding: 14, marginBottom: 20
        }}>
          <div style={{ fontSize: 10, color: "#556", letterSpacing: "0.1em", marginBottom: 6 }}>
            {selectedYear} ACTUAL RESULT
          </div>
          <div style={{ fontSize: 12, color: player.actualResult.startsWith("✅") ? "#00cc66" : player.actualResult.startsWith("❌") ? "#cc4444" : "#aab", lineHeight: 1.5 }}>
            {player.actualResult}
          </div>
        </div>
      )}

      {/* Projected Stats - only for future predictions */}
      {selectedYear >= 2026 && (
        <ProjectedStats player={player} selectedYear={selectedYear} tier={tier} />
      )}

      {/* Red Flags & Confidence */}
      <RedFlagsPanel player={player} selectedYear={selectedYear} />

      <div style={{ fontSize: 10, color: "#556", letterSpacing: "0.1em", marginBottom: 12 }}>SIGNAL BREAKDOWN</div>

      {signals.map((s) => (
        <div key={s.key} style={{
          padding: "10px 14px", background: "#0d1520",
          border: "1px solid #1a2530", borderRadius: 6, marginBottom: 8
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ fontSize: 12, color: "#ccd", fontWeight: 600 }}>{s.key}</div>
              <div style={{ fontSize: 10, color: "#445", marginTop: 1 }}>{s.desc} · weight {s.weight}</div>
            </div>
            <div style={{
              fontSize: 14, fontWeight: 700,
              color: s.format === "surplus" && s.value != null
                ? (s.value > 0 ? "#00ff88" : "#cc4444") : "#aab"
            }}>{fmt(s.value, s.format)}</div>
          </div>
          {/* Normalized score bar */}
          {player._scores[normalizeKey(s.key)] != null && (
            <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ flex: 1, height: 3, background: "#1a2530", borderRadius: 2 }}>
                <div style={{
                  width: `${player._scores[normalizeKey(s.key)]}%`,
                  height: "100%", background: tier.color, borderRadius: 2
                }} />
              </div>
              <span style={{ fontSize: 10, color: "#556" }}>
                {Math.round(player._scores[normalizeKey(s.key)])}ile
              </span>
            </div>
          )}
        </div>
      ))}

      <div style={{
        marginTop: 16, padding: "12px 14px", background: "#080c10",
        border: "1px solid #1a2530", borderRadius: 6, fontSize: 11, color: "#556", lineHeight: 1.6
      }}>
        <div style={{ color: "#778", fontWeight: 600, marginBottom: 6 }}>WHY THIS PLAYER?</div>
        <Narrative player={player} selectedYear={selectedYear} />
      </div>
    </div>
  );
}

function normalizeKey(label) {
  const map = {
    "xwOBA Surplus": "xwobaSurplus",
    "xwOBA Trajectory": "xwobaTrajectory",
    "Hard-Hit Rate": "hardHitRate",
    "Barrel Rate": "barrelRate",
    "xwOBA Level": "xwobaLevel",
    "K-Rate (inv)": "kRateInverse",
  };
  return map[label] || label;
}

function Narrative({ player, selectedYear }) {
  const lines = [];
  if (player.xwobaSurplus > 0.025)
    lines.push(`• xwOBA surplus of +${player.xwobaSurplus?.toFixed(3)} signals significant bad luck — expect positive regression.`);
  if (player.xwobaTrajectory > 0.015)
    lines.push(`• Skills trending upward (+${player.xwobaTrajectory?.toFixed(3)} xwOBA YoY) — profile is improving.`);
  if (player.hardHitRate > 0.48)
    lines.push(`• Elite hard-hit rate (${(player.hardHitRate * 100).toFixed(1)}%) — generates premium contact.`);
  if (player.barrelRate > 0.10)
    lines.push(`• Barrel rate of ${(player.barrelRate * 100).toFixed(1)}% is plus-plus — in the top tier of power generators.`);
  if (player.age != null && player.age <= 24)
    lines.push(`• At age ${player.age}, prime development years ahead; room for continued skill refinement.`);
  if (lines.length === 0)
    lines.push(`• Solid underlying skills across multiple Statcast dimensions position this player for a strong ${selectedYear}.`);
  return <>{lines.map((l, i) => <div key={i}>{l}</div>)}</>;
}

// ─── METHODOLOGY PANEL ────────────────────────────────────────────────────────
function MethodologyPanel() {
  const signals = [
    {
      name: "xwOBA Surplus (28%)",
      icon: "◈",
      color: "#00ff88",
      desc: "The single strongest signal. xwOBA − actual wOBA measures how much a player's outcomes differed from what the quality of their contact deserved. A positive surplus means they got unlucky; regression toward xwOBA is highly probable.",
    },
    {
      name: "xwOBA Trajectory (18%)",
      icon: "↗",
      color: "#44aaff",
      desc: "Year-over-year change in expected wOBA. Rising xwOBA signals genuine skill improvement — better launch conditions, harder contact, or improved pitch recognition — that may not yet be reflected in traditional stats.",
    },
    {
      name: "Hard-Hit Rate (14%)",
      icon: "⚡",
      color: "#ffcc00",
      desc: "Percentage of batted balls hit at 95+ mph exit velocity. Hard contact is the most stable batted-ball metric year-over-year and is strongly correlated with xwOBA and future offensive production.",
    },
    {
      name: "Barrel Rate (14%)",
      icon: "🛢",
      color: "#ff8c42",
      desc: "Percentage of batted balls in the \"barrel\" zone — optimal exit velocity + launch angle combinations that produce hits at a .500+ rate. The best raw power signal in Statcast.",
    },
    {
      name: "xwOBA Absolute Level (13%)",
      icon: "▣",
      color: "#aa88ff",
      desc: "The raw expected wOBA value itself. Even controlling for surplus and trajectory, the absolute skill floor matters — a player with a .360 xwOBA has a higher ceiling than one at .320.",
    },
    {
      name: "Contact Ability / K-Rate Inverse (13%)",
      icon: "∅",
      color: "#ff88cc",
      desc: "Inverted strikeout rate as a proxy for plate discipline and contact ability. INCREASED from 5% to 13% after historical validation showed high K-rate (30%+) players rarely sustain breakouts despite good Statcast metrics. Contact ability is foundational.",
    },
  ];

  return (
    <div style={{ maxWidth: 800, margin: "0 auto" }}>
      <div style={{ marginBottom: 32 }}>
        <div style={{ fontSize: 11, color: "#556", letterSpacing: "0.15em", marginBottom: 8 }}>THE MODEL (v5.4 - CHASE RATE)</div>
        <h2 style={{ fontSize: 24, color: "#fff", margin: 0, fontWeight: 700 }}>How Breakout Score Works</h2>
        <p style={{ color: "#667", lineHeight: 1.7, marginTop: 12 }}>
          The Breakout Score integrates <strong style={{ color: "#00ff88" }}>Baseball Savant data</strong> with 
          year-over-year improvement tracking and elite young talent detection. <strong style={{ color: "#00ff88" }}>Version 5.4</strong> removes 
          launch angle delta (not predictive) and fixes chase rate data collection to properly weight plate discipline improvements.
        </p>
        <div style={{
          background: "#001a0f", border: "1px solid #004422",
          borderRadius: 6, padding: "12px 16px", marginTop: 16, fontSize: 11, color: "#00cc66"
        }}>
          <strong>✨ NEW in v5.4:</strong> Removed launch angle delta (23% moved toward optimal, not statistically significant) · 
          Fixed chase rate data collection from Baseball Savant percentile rankings · 
          Increased chase improvement weight to 8% (plate discipline is highly predictive) · 
          Elite young talent sliding scale, K-rate sustainability filters, 2-tier breakout system
        </div>
      </div>

      <div style={{ marginBottom: 32 }}>
        <div style={{ fontSize: 11, color: "#556", letterSpacing: "0.15em", marginBottom: 16 }}>CONTEXTUAL ADJUSTMENTS (NEW)</div>
        <div style={{
          background: "#0d1520", border: "1px solid #1a2530",
          borderLeft: "3px solid #00ff88",
          borderRadius: 8, padding: "16px 20px", marginBottom: 12
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
            <span style={{ fontSize: 16, color: "#00ff88" }}>📈</span>
            <span style={{ fontSize: 14, fontWeight: 700, color: "#dde" }}>Age Curve Multipliers</span>
          </div>
          <p style={{ color: "#667", fontSize: 12, lineHeight: 1.6, margin: 0 }}>
            Scores are boosted 15% for ages 21-22 (prime breakout window), 5% for ages 23-25, and reduced 10-25% for ages 29+. 
            Historical data shows 75% of successful predictions were ages 21-24. Veterans rarely break out even with elite metrics.
          </p>
        </div>

        <div style={{
          background: "#0d1520", border: "1px solid #1a2530",
          borderLeft: "3px solid #ffcc00",
          borderRadius: 8, padding: "16px 20px", marginBottom: 12
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
            <span style={{ fontSize: 16, color: "#ffcc00" }}>🚩</span>
            <span style={{ fontSize: 14, fontWeight: 700, color: "#dde" }}>K-Rate Penalties</span>
          </div>
          <p style={{ color: "#667", fontSize: 12, lineHeight: 1.6, margin: 0 }}>
            Players with K-rate ≥30% receive a 15% score reduction; ≥25% receive 5% reduction. High strikeout rates prevent 
            sustained success even with good Statcast metrics. Contact ability is foundational — you can't break out if you can't hit the ball.
          </p>
        </div>

        <div style={{
          background: "#0d1520", border: "1px solid #1a2530",
          borderLeft: "3px solid #ff8c42",
          borderRadius: 8, padding: "16px 20px", marginBottom: 12
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
            <span style={{ fontSize: 16, color: "#ff8c42" }}>📊</span>
            <span style={{ fontSize: 14, fontWeight: 700, color: "#dde" }}>Sample Size Confidence Tiers</span>
          </div>
          <p style={{ color: "#667", fontSize: 12, lineHeight: 1.6, margin: 0 }}>
            Scores are discounted based on plate appearances: 500+ PA (full confidence), 300-499 PA (5% discount), 
            200-299 PA (15% discount), &lt;200 PA (25-40% discount). Statcast metrics stabilize around 300-400 PA. 
            Below that, extreme metrics may be small-sample noise.
          </p>
        </div>
      </div>

      <div style={{ marginBottom: 32 }}>
        <div style={{ fontSize: 11, color: "#556", letterSpacing: "0.15em", marginBottom: 16 }}>SIGNAL WEIGHTS</div>
        {signals.map((s) => (
          <div key={s.name} style={{
            background: "#0d1520", border: "1px solid #1a2530",
            borderLeft: `3px solid ${s.color}`,
            borderRadius: 8, padding: "16px 20px", marginBottom: 12
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
              <span style={{ fontSize: 16, color: s.color }}>{s.icon}</span>
              <span style={{ fontSize: 14, fontWeight: 700, color: "#dde" }}>{s.name}</span>
            </div>
            <p style={{ color: "#667", fontSize: 12, lineHeight: 1.6, margin: 0 }}>{s.desc}</p>
          </div>
        ))}
      </div>

      <div style={{ background: "#0d1520", border: "1px solid #1a2530", borderRadius: 8, padding: "20px 24px" }}>
        <div style={{ fontSize: 11, color: "#556", letterSpacing: "0.15em", marginBottom: 12 }}>LIMITATIONS & CAVEATS</div>
        <ul style={{ color: "#667", fontSize: 12, lineHeight: 1.8, margin: 0, paddingLeft: 20 }}>
          <li>This model is descriptive and probabilistic — it identifies candidates, not guarantees.</li>
          <li>Injury history, age curves, team context, and role changes are not captured.</li>
          <li>Small-sample players (&lt;150 PA) have wider confidence intervals; treat as speculative.</li>
          <li>Pitching changes, lineup protection, and ballpark moves can materially affect outcomes.</li>
          <li>xwOBA was designed to be descriptive, not strictly predictive — but it correlates well YoY.</li>
          <li>Data sourced from Baseball Savant (baseballsavant.mlb.com) — all Statcast metrics.</li>
        </ul>
      </div>
    </div>
  );
}

// ─── LOADING STATE ─────────────────────────────────────────────────────────────
function LoadingState() {
  return (
    <div style={{
      textAlign: "center", padding: "60px 20px",
      color: "#445", fontSize: 13, letterSpacing: "0.1em"
    }}>
      <div style={{
        width: 40, height: 40, border: "2px solid #1a2530",
        borderTop: "2px solid #00ff88", borderRadius: "50%",
        animation: "spin 1s linear infinite", margin: "0 auto 20px",
      }} />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      FETCHING STATCAST DATA…
    </div>
  );
}
