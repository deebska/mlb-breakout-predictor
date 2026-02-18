// Baseball Savant API using PapaParse for proper CSV parsing
// PapaParse is the industry-standard CSV parser for JavaScript

import Papa from 'papaparse';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  try {
    const { year = '2026' } = req.query;
    const targetYear = parseInt(year);
    
    // Use previous year's data for predictions (2025 data predicts 2026, etc.)
    const currentDataYear = targetYear - 1;
    const prevDataYear = targetYear - 2;
    
    const scraperApiKey = process.env.SCRAPER_API_KEY;
    
    if (!scraperApiKey) {
      throw new Error('SCRAPER_API_KEY not set');
    }
    
    console.log(`[API] Request for ${targetYear} predictions - fetching ${currentDataYear} and ${prevDataYear} Baseball Savant data`);
    
    // Fetch CURRENT year expected stats (for xwoba25, woba25)
    const expectedStatsUrlCurrent = `https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=batter&year=${currentDataYear}&position=&team=&min=100&csv=true`;
    
    // Fetch PREVIOUS year expected stats (for xwoba24, woba24 to calculate trajectory)
    const expectedStatsUrlPrev = `https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=batter&year=${prevDataYear}&position=&team=&min=100&csv=true`;
    
    // Fetch current year statcast sources
    const statcastUrl1 = `https://baseballsavant.mlb.com/leaderboard/custom?year=${currentDataYear}&type=batter&min=1&selections=player_id,age,k_percent,hard_hit_percent,barrel_batted_rate,pull_percent&csv=true`;
    const statcastUrl2 = `https://baseballsavant.mlb.com/leaderboard/statcast?type=batter&year=${currentDataYear}&min=1&csv=true`; // launch angle
    const statcastUrl3 = `https://baseballsavant.mlb.com/leaderboard/bat-tracking?year=${currentDataYear}&min=1&csv=true`; // bat speed
    const statcastUrl4 = `https://baseballsavant.mlb.com/leaderboard/custom?year=${currentDataYear}&type=batter&min=1&selections=player_id,o_swing_percent&csv=true`; // chase rate
    
    // Also fetch PREVIOUS year launch angle for delta calculation
    const statcastUrl2Prev = `https://baseballsavant.mlb.com/leaderboard/statcast?type=batter&year=${prevDataYear}&min=1&csv=true`;
    
    console.log(`[API] Fetching current year (${currentDataYear}) expected stats...`);
    const expectedCurrentResponse = await fetch(`http://api.scraperapi.com?api_key=${scraperApiKey}&url=${encodeURIComponent(expectedStatsUrlCurrent)}`);
    const expectedCurrentCsv = await expectedCurrentResponse.text();
    
    console.log(`[API] Fetching previous year (${prevDataYear}) expected stats...`);
    const expectedPrevResponse = await fetch(`http://api.scraperapi.com?api_key=${scraperApiKey}&url=${encodeURIComponent(expectedStatsUrlPrev)}`);
    const expectedPrevCsv = await expectedPrevResponse.text();
    
    console.log(`[API] Fetching statcast 1 (custom)...`);
    const statcast1Response = await fetch(`http://api.scraperapi.com?api_key=${scraperApiKey}&url=${encodeURIComponent(statcastUrl1)}`);
    const statcast1Csv = statcast1Response.ok ? await statcast1Response.text() : null;
    
    console.log(`[API] Fetching statcast 2 (standard)...`);
    const statcast2Response = await fetch(`http://api.scraperapi.com?api_key=${scraperApiKey}&url=${encodeURIComponent(statcastUrl2)}`);
    const statcast2Csv = statcast2Response.ok ? await statcast2Response.text() : null;
    
    console.log(`[API] Fetching statcast 3 (bat-tracking)...`);
    const statcast3Response = await fetch(`http://api.scraperapi.com?api_key=${scraperApiKey}&url=${encodeURIComponent(statcastUrl3)}`);
    const statcast3Csv = statcast3Response.ok ? await statcast3Response.text() : null;
    
    console.log(`[API] Fetching statcast 4 (o_swing custom)...`);
    const statcast4Response = await fetch(`http://api.scraperapi.com?api_key=${scraperApiKey}&url=${encodeURIComponent(statcastUrl4)}`);
    const statcast4Csv = statcast4Response.ok ? await statcast4Response.text() : null;
    
    console.log(`[API] Fetching previous year statcast 2 (for launch angle delta)...`);
    const statcast2PrevResponse = await fetch(`http://api.scraperapi.com?api_key=${scraperApiKey}&url=${encodeURIComponent(statcastUrl2Prev)}`);
    const statcast2PrevCsv = statcast2PrevResponse.ok ? await statcast2PrevResponse.text() : null;
    
    // Parse current year expected stats
    const expectedCurrentParsed = Papa.parse(expectedCurrentCsv, {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: true
    });
    
    console.log(`[API] Parsed ${expectedCurrentParsed.data.length} players from current year expected stats`);
    
    // Parse previous year expected stats
    const expectedPrevParsed = Papa.parse(expectedPrevCsv, {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: true
    });
    
    console.log(`[API] Parsed ${expectedPrevParsed.data.length} players from previous year expected stats`);
    
    // Build previous year map for trajectory calculation
    const prevYearMap = new Map();
    for (const row of expectedPrevParsed.data) {
      const playerId = String(row.player_id);
      if (playerId && row.est_woba) {
        prevYearMap.set(playerId, {
          xwoba: parseFloat(row.est_woba),
          woba: parseFloat(row.woba)
        });
      }
    }
    
    console.log(`[API] Built previous year map with ${prevYearMap.size} players`);
    
    // Parse current year statcast sources and merge into single map
    let statcastMap = new Map();
    
    if (statcast1Csv) {
      const statcast1Parsed = Papa.parse(statcast1Csv, {
        header: true,
        skipEmptyLines: true,
        dynamicTyping: true
      });
      
      statcast1Parsed.data.forEach(row => {
        if (row.player_id) {
          statcastMap.set(String(row.player_id), row);
        }
      });
      
      console.log(`[API] Loaded ${statcastMap.size} players from statcast1`);
    }
    
    // Merge statcast2 (launch angle)
    if (statcast2Csv) {
      const statcast2Parsed = Papa.parse(statcast2Csv, {
        header: true,
        skipEmptyLines: true,
        dynamicTyping: true
      });
      
      statcast2Parsed.data.forEach(row => {
        const playerId = String(row.player_id);
        if (playerId) {
          const existing = statcastMap.get(playerId) || {};
          statcastMap.set(playerId, {
            ...existing,
            launch_angle: row.launch_angle,
            avg_hit_angle: row.avg_hit_angle
          });
        }
      });
      
      console.log(`[API] Merged launch angle data`);
    }
    
    // Build previous year launch angle map
    const prevLaunchAngleMap = new Map();
    if (statcast2PrevCsv) {
      const statcast2PrevParsed = Papa.parse(statcast2PrevCsv, {
        header: true,
        skipEmptyLines: true,
        dynamicTyping: true
      });
      
      statcast2PrevParsed.data.forEach(row => {
        const playerId = String(row.player_id);
        if (playerId) {
          prevLaunchAngleMap.set(playerId, parseFloat(row.launch_angle) || parseFloat(row.avg_hit_angle));
        }
      });
      
      console.log(`[API] Built previous year launch angle map with ${prevLaunchAngleMap.size} players`);
    }
    
    // Merge statcast3 (bat speed) - SPECIAL HANDLING: uses 'id' not 'player_id'
    if (statcast3Csv) {
      const statcast3Parsed = Papa.parse(statcast3Csv, {
        header: true,
        skipEmptyLines: true,
        dynamicTyping: true
      });
      
      statcast3Parsed.data.forEach(row => {
        const playerId = String(row.id || row.player_id); // bat-tracking uses 'id'
        if (playerId) {
          const existing = statcastMap.get(playerId) || {};
          statcastMap.set(playerId, {
            ...existing,
            avg_bat_speed: row.avg_bat_speed,
            swing_speed: row.swing_speed
          });
        }
      });
      
      console.log(`[API] Merged bat speed data`);
    }
    
    // Merge statcast4 (chase rate)
    if (statcast4Csv) {
      const statcast4Parsed = Papa.parse(statcast4Csv, {
        header: true,
        skipEmptyLines: true,
        dynamicTyping: true
      });
      
      statcast4Parsed.data.forEach(row => {
        const playerId = String(row.player_id);
        if (playerId) {
          const existing = statcastMap.get(playerId) || {};
          statcastMap.set(playerId, {
            ...existing,
            o_swing_percent: row.o_swing_percent
          });
        }
      });
      
      console.log(`[API] Merged chase rate data`);
    }
    
    // Build players array
    const players = [];
    const currentYearSuffix = currentDataYear % 100;
    const prevYearSuffix = prevDataYear % 100;
    
    for (const row of expectedCurrentParsed.data) {
      const pa = parseInt(row.pa) || 0;
      if (pa < 100) continue; // Only qualified players
      
      const currentWoba = parseFloat(row.woba);
      const currentXwoba = parseFloat(row.est_woba);
      
      if (!currentWoba || !currentXwoba) continue;
      
      // Get player ID and previous year data
      const playerId = String(row.player_id);
      const prevYearData = prevYearMap.get(playerId);
      const statcastData = statcastMap.get(playerId);
      const prevLaunchAngle = prevLaunchAngleMap.get(playerId);
      
      // Calculate xwoba surplus and trajectory
      const xwobaSurplus = currentXwoba - currentWoba;
      const xwobaTrajectory = prevYearData ? currentXwoba - prevYearData.xwoba : 0;
      
      // Calculate launch angle delta
      const currentLaunchAngle = statcastData && (parseFloat(statcastData.launch_angle) || parseFloat(statcastData.avg_hit_angle));
      const launchAngleDelta = (currentLaunchAngle != null && prevLaunchAngle != null) 
        ? currentLaunchAngle - prevLaunchAngle 
        : null;
      
      // Filter out pitchers
      const pos = (row.pos || row.primary_position || 'OF').toUpperCase();
      if (pos.includes('SP') || pos.includes('RP') || pos === 'P') {
        continue;
      }
      
      players.push({
        name: row['last_name, first_name'] || `${row.first_name || ''} ${row.last_name || ''}`.trim(),
        team: row.team_name_abbrev || row.team,
        age: statcastData && parseInt(statcastData.age),
        pa: pa,
        position: row.pos || row.primary_position || 'OF',
        // Current year stats
        [`woba${currentYearSuffix}`]: currentWoba,
        [`xwoba${currentYearSuffix}`]: currentXwoba,
        // Previous year stats (if available)
        [`woba${prevYearSuffix}`]: prevYearData ? prevYearData.woba : null,
        [`xwoba${prevYearSuffix}`]: prevYearData ? prevYearData.xwoba : null,
        // Calculated fields
        currentWoba: currentWoba,
        careerWoba: currentWoba, // Simplified - could calculate from multi-year if needed
        xwobaSurplus: xwobaSurplus,
        xwobaTrajectory: xwobaTrajectory,
        // Statcast metrics
        hardHitRate: statcastData && parseFloat(statcastData.hard_hit_percent) ? parseFloat(statcastData.hard_hit_percent) / 100 : null,
        barrelRate: statcastData && parseFloat(statcastData.barrel_batted_rate) ? parseFloat(statcastData.barrel_batted_rate) / 100 : null,
        kRate: statcastData && parseFloat(statcastData.k_percent) ? parseFloat(statcastData.k_percent) / 100 : null,
        chaseRate: statcastData && parseFloat(statcastData.o_swing_percent) ? parseFloat(statcastData.o_swing_percent) / 100 : null,
        pullRate: statcastData && parseFloat(statcastData.pull_percent) ? parseFloat(statcastData.pull_percent) / 100 : null,
        // Launch angles
        launchAngle: currentLaunchAngle,
        [`launchAngle${currentYearSuffix}`]: currentLaunchAngle,
        [`launchAngle${prevYearSuffix}`]: prevLaunchAngle,
        launchAngleDelta: launchAngleDelta,
        // Bat speed
        batSpeed: statcastData && parseFloat(statcastData.avg_bat_speed),
      });
    }
    
    console.log(`[API] Returning ${players.length} players with trajectory data`);
    
    res.status(200).json({
      success: true,
      year: targetYear,
      dataYears: [currentDataYear, prevDataYear],
      players: players,
      count: players.length,
      lastUpdated: new Date().toISOString(),
    });
    
  } catch (error) {
    console.error('[API] Error:', error);
    res.status(500).json({
      success: false,
      message: error.message,
      year: parseInt(req.query.year) || 2026,
      players: [],
      count: 0
    });
  }
}
