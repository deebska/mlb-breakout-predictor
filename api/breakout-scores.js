// Vercel Serverless Function: Fetch Baseball Savant data and calculate breakout scores
// Endpoint: /api/breakout-scores

import fetch from 'node-fetch';

// Baseball Savant endpoints (public CSVs)
const SAVANT_BASE = 'https://baseballsavant.mlb.com/leaderboard';

const ENDPOINTS = {
  expectedStats: (year) => `${SAVANT_BASE}/expected_statistics?type=batter&year=${year}&position=&team=&min=100&csv=true`,
  plateDiscipline: (year) => `${SAVANT_BASE}/plate-discipline?type=batter&year=${year}&position=&team=&min=q&csv=true`,
  batTracking: (year) => `${SAVANT_BASE}/bat-tracking?type=swing-take&batSide=&stat=swing_speed&min=25&csv=true`,
  battedBall: (year) => `${SAVANT_BASE}/statcast?type=batter&year=${year}&position=&team=&min=q&csv=true`,
};

// Parse CSV to JSON
function parseCSV(csvText) {
  const lines = csvText.trim().split('\n');
  const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
  
  return lines.slice(1).map(line => {
    const values = line.split(',').map(v => v.trim().replace(/"/g, ''));
    const obj = {};
    headers.forEach((header, i) => {
      obj[header] = values[i] || null;
    });
    return obj;
  });
}

// Fetch data from Baseball Savant
async function fetchBaseballSavant(year = 2025) {
  console.log(`Fetching Baseball Savant data for ${year}...`);
  
  const results = {};
  
  try {
    // Fetch expected stats (primary dataset)
    const expectedStatsRes = await fetch(ENDPOINTS.expectedStats(year));
    const expectedStatsCSV = await expectedStatsRes.text();
    results.expectedStats = parseCSV(expectedStatsCSV);
    console.log(`✓ Expected stats: ${results.expectedStats.length} players`);
    
    // Fetch plate discipline
    const plateDisciplineRes = await fetch(ENDPOINTS.plateDiscipline(year));
    const plateDisciplineCSV = await plateDisciplineRes.text();
    results.plateDiscipline = parseCSV(plateDisciplineCSV);
    console.log(`✓ Plate discipline: ${results.plateDiscipline.length} players`);
    
    // Fetch bat tracking (may not have all players)
    try {
      const batTrackingRes = await fetch(ENDPOINTS.batTracking(year));
      const batTrackingCSV = await batTrackingRes.text();
      results.batTracking = parseCSV(batTrackingCSV);
      console.log(`✓ Bat tracking: ${results.batTracking.length} players`);
    } catch (e) {
      console.warn('⚠ Bat tracking data unavailable');
      results.batTracking = [];
    }
    
    // Fetch batted ball
    const battedBallRes = await fetch(ENDPOINTS.battedBall(year));
    const battedBallCSV = await battedBallRes.text();
    results.battedBall = parseCSV(battedBallCSV);
    console.log(`✓ Batted ball: ${results.battedBall.length} players`);
    
    return results;
  } catch (error) {
    console.error('Error fetching Baseball Savant data:', error);
    throw error;
  }
}

// Merge data sources by player_id
function mergeDataSources(rawData, year) {
  const playerMap = new Map();
  
  // Start with expected stats (has most complete data)
  rawData.expectedStats.forEach(p => {
    const playerId = p.player_id;
    
    // Parse all the stats into the format the frontend expects
    playerMap.set(playerId, {
      player_id: playerId,
      name: `${p.first_name} ${p.last_name}`,
      team: p.team_name_abbrev || p.team || p.team_abbrev,
      age: parseInt(p.age) || parseInt(p.player_age),
      pa: parseInt(p.pa) || 0,
      
      // Current year stats (use appropriate field based on year)
      [`woba${year % 100}`]: parseFloat(p.woba),
      [`xwoba${year % 100}`]: parseFloat(p.est_woba) || parseFloat(p.xwoba),
      
      // For calculations
      currentWoba: parseFloat(p.woba),
      xwoba: parseFloat(p.est_woba) || parseFloat(p.xwoba),
      
      hardHitRate: parseFloat(p.hard_hit_percent) ? parseFloat(p.hard_hit_percent) / 100 : null,
      barrelRate: parseFloat(p.barrel_batted_rate) ? parseFloat(p.barrel_batted_rate) / 100 : null,
      
      position: p.primary_pos_formatted || p.primary_position || p.pos || 'OF',
    });
  });
  
  // Add plate discipline data
  rawData.plateDiscipline.forEach(p => {
    const player = playerMap.get(p.player_id);
    if (player) {
      player.chaseRate = parseFloat(p.o_swing_percent) ? parseFloat(p.o_swing_percent) / 100 : null;
      player.kRate = parseFloat(p.k_percent) ? parseFloat(p.k_percent) / 100 : null;
    }
  });
  
  // Add bat tracking data
  rawData.batTracking.forEach(p => {
    const player = playerMap.get(p.player_id);
    if (player) {
      player.batSpeed = parseFloat(p.swing_speed) || parseFloat(p.bat_speed);
    }
  });
  
  // Add batted ball data (pull rate, launch angle)
  rawData.battedBall.forEach(p => {
    const player = playerMap.get(p.player_id);
    if (player) {
      player.pullRate = parseFloat(p.pull_percent) ? parseFloat(p.pull_percent) / 100 : null;
      player.launchAngle = parseFloat(p.launch_angle) || parseFloat(p.avg_launch_angle);
      
      // Also get launch angle from previous year if available
      const prevYear = year - 1;
      player[`launchAngle${prevYear % 100}`] = player.launchAngle; // Will be updated if we have prev year data
    }
  });
  
  return Array.from(playerMap.values());
}

// Main handler
export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  try {
    const { year = '2025' } = req.query;
    const targetYear = parseInt(year);
    
    console.log(`API request for year ${targetYear}`);
    
    // Fetch data from Baseball Savant
    const rawData = await fetchBaseballSavant(targetYear);
    
    // Merge all data sources
    const players = mergeDataSources(rawData, targetYear);
    
    // Filter out pitchers
    const hitters = players.filter(p => {
      const pos = (p.position || '').toUpperCase();
      return !pos.includes('SP') && !pos.includes('RP') && pos !== 'P';
    });
    
    // Return data
    res.status(200).json({
      success: true,
      year: targetYear,
      players: hitters,
      count: hitters.length,
      lastUpdated: new Date().toISOString(),
    });
    
  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Failed to fetch Baseball Savant data'
    });
  }
}
