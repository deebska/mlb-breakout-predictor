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
    
    // ALWAYS use 2025 data - this is the most recent available from Baseball Savant
    const dataYear = 2025;
    
    const scraperApiKey = process.env.SCRAPER_API_KEY;
    
    if (!scraperApiKey) {
      throw new Error('SCRAPER_API_KEY not set');
    }
    
    console.log(`[API] Request for ${targetYear} predictions - fetching ${dataYear} Baseball Savant data`);
    
    // Baseball Savant URLs - ALWAYS use 2025 data
    const expectedStatsUrl = `https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=batter&year=${dataYear}&position=&team=&min=100&csv=true`;
    // Use FOUR statcast sources (removed swing-take as it has no useful data)
    const statcastUrl1 = `https://baseballsavant.mlb.com/leaderboard/custom?year=${dataYear}&type=batter&min=1&selections=player_id,age,k_percent,hard_hit_percent,barrel_batted_rate,pull_percent&csv=true`;
    const statcastUrl2 = `https://baseballsavant.mlb.com/leaderboard/statcast?type=batter&year=${dataYear}&min=1&csv=true`; // launch angle
    const statcastUrl3 = `https://baseballsavant.mlb.com/leaderboard/bat-tracking?year=${dataYear}&min=1&csv=true`; // bat speed
    const statcastUrl4 = `https://baseballsavant.mlb.com/leaderboard/custom?year=${dataYear}&type=batter&min=1&selections=player_id,o_swing_percent&csv=true`; // chase rate
    
    // Fetch via ScraperAPI
    const scraperUrl1 = `http://api.scraperapi.com?api_key=${scraperApiKey}&url=${encodeURIComponent(expectedStatsUrl)}`;
    const scraperUrl2 = `http://api.scraperapi.com?api_key=${scraperApiKey}&url=${encodeURIComponent(statcastUrl1)}`;
    const scraperUrl3 = `http://api.scraperapi.com?api_key=${scraperApiKey}&url=${encodeURIComponent(statcastUrl2)}`;
    const scraperUrl4 = `http://api.scraperapi.com?api_key=${scraperApiKey}&url=${encodeURIComponent(statcastUrl3)}`;
    const scraperUrl5 = `http://api.scraperapi.com?api_key=${scraperApiKey}&url=${encodeURIComponent(statcastUrl4)}`;
    
    console.log(`[API] Fetching expected stats...`);
    const expectedResponse = await fetch(scraperUrl1);
    const expectedCsv = await expectedResponse.text();
    
    console.log(`[API] Fetching statcast 1 (custom)...`);
    const statcast1Response = await fetch(scraperUrl2);
    const statcast1Csv = statcast1Response.ok ? await statcast1Response.text() : null;
    
    console.log(`[API] Fetching statcast 2 (standard)...`);
    const statcast2Response = await fetch(scraperUrl3);
    const statcast2Csv = statcast2Response.ok ? await statcast2Response.text() : null;
    
    console.log(`[API] Fetching statcast 3 (bat-tracking)...`);
    const statcast3Response = await fetch(scraperUrl4);
    const statcast3Csv = statcast3Response.ok ? await statcast3Response.text() : null;
    
    console.log(`[API] Fetching statcast 4 (o_swing custom)...`);
    const statcast4Response = await fetch(scraperUrl5);
    const statcast4Csv = statcast4Response.ok ? await statcast4Response.text() : null;
    
    console.log(`[API] Expected: ${expectedCsv.length} bytes, SC1: ${statcast1Csv?.length || 0}, SC2: ${statcast2Csv?.length || 0}, SC3: ${statcast3Csv?.length || 0}, SC4: ${statcast4Csv?.length || 0}`);
    
    // Parse expected stats CSV with PapaParse
    const expectedParsed = Papa.parse(expectedCsv, {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: true
    });
    
    console.log(`[API] PapaParse result:`, {
      data_length: expectedParsed.data.length,
      errors: expectedParsed.errors.length,
      first_row_keys: expectedParsed.data[0] ? Object.keys(expectedParsed.data[0]).slice(0, 5) : [],
      first_row_sample: expectedParsed.data[0]
    });
    
    console.log(`[API] Parsed ${expectedParsed.data.length} players from expected stats`);
    
    // Parse FIRST statcast CSV (k_percent, hard_hit_percent, barrel_batted_rate, pull_percent)
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
      if (statcast1Parsed.data[0]) {
        console.log(`[API] Statcast1 columns:`, Object.keys(statcast1Parsed.data[0]));
      }
    }
    
    // Parse and MERGE SECOND statcast CSV (launch_angle, avg_hit_angle)
    if (statcast2Csv) {
      const statcast2Parsed = Papa.parse(statcast2Csv, {
        header: true,
        skipEmptyLines: true,
        dynamicTyping: true
      });
      
      statcast2Parsed.data.forEach(row => {
        if (row.player_id) {
          const playerId = String(row.player_id);
          const existing = statcastMap.get(playerId);
          if (existing) {
            const merged = { ...existing };
            Object.keys(row).forEach(key => {
              if (existing[key] === null || existing[key] === undefined || (row[key] !== null && row[key] !== undefined)) {
                merged[key] = row[key];
              }
            });
            statcastMap.set(playerId, merged);
          } else {
            statcastMap.set(playerId, row);
          }
        }
      });
      
      console.log(`[API] Merged statcast2, total: ${statcastMap.size} players`);
    }
    
    // Parse and MERGE THIRD statcast CSV (bat tracking - uses 'id' instead of 'player_id')
    if (statcast3Csv) {
      const statcast3Parsed = Papa.parse(statcast3Csv, {
        header: true,
        skipEmptyLines: true,
        dynamicTyping: true
      });
      
      statcast3Parsed.data.forEach(row => {
        // Bat tracking uses 'id' not 'player_id'
        if (row.id) {
          const playerId = String(row.id);
          const existing = statcastMap.get(playerId);
          if (existing) {
            const merged = { ...existing };
            Object.keys(row).forEach(key => {
              if (existing[key] === null || existing[key] === undefined || (row[key] !== null && row[key] !== undefined)) {
                merged[key] = row[key];
              }
            });
            statcastMap.set(playerId, merged);
          } else {
            // If not in map yet, add it but use 'id' as 'player_id' for consistency
            statcastMap.set(playerId, { ...row, player_id: row.id });
          }
        }
      });
      
      console.log(`[API] Merged statcast3 (bat-tracking), total: ${statcastMap.size} players`);
      if (statcast3Parsed.data[0]) {
        console.log(`[API] Bat-tracking columns:`, Object.keys(statcast3Parsed.data[0]).slice(0, 15));
      }
    }
    
    // Parse and MERGE FOURTH statcast CSV (custom o_swing_percent only)
    if (statcast4Csv) {
      const statcast4Parsed = Papa.parse(statcast4Csv, {
        header: true,
        skipEmptyLines: true,
        dynamicTyping: true
      });
      
      statcast4Parsed.data.forEach(row => {
        if (row.player_id) {
          const playerId = String(row.player_id);
          const existing = statcastMap.get(playerId);
          if (existing) {
            const merged = { ...existing };
            Object.keys(row).forEach(key => {
              if (existing[key] === null || existing[key] === undefined || (row[key] !== null && row[key] !== undefined)) {
                merged[key] = row[key];
              }
            });
            statcastMap.set(playerId, merged);
          } else {
            statcastMap.set(playerId, row);
          }
        }
      });
      
      console.log(`[API] Merged statcast4 (o_swing custom), total: ${statcastMap.size} players`);
      if (statcast4Parsed.data[0]) {
        console.log(`[API] O-swing columns:`, Object.keys(statcast4Parsed.data[0]));
      }
    }
    
    // Build players array
    const players = [];
    const yearSuffix = targetYear % 100;
    
    for (const row of expectedParsed.data) {
      const pa = parseInt(row.pa) || 0;
      if (pa < 100) continue; // Only qualified players
      
      const woba = parseFloat(row.woba);
      const xwoba = parseFloat(row.est_woba);
      
      if (!woba || !xwoba) continue;
      
      // Get statcast data
      const playerId = String(row.player_id);
      const statcastData = statcastMap.get(playerId);
      
      // Debug first player
      if (players.length === 0) {
        console.log(`[API] First player matching: playerId="${playerId}", hasStatcast=${!!statcastData}`);
        if (statcastData) {
          console.log(`[API] Statcast MERGED data:`, {
            hard_hit_percent: statcastData.hard_hit_percent,
            o_swing_percent: statcastData.o_swing_percent,
            launch_angle: statcastData.launch_angle,
            swing_speed: statcastData.swing_speed,
            avg_bat_speed: statcastData.avg_bat_speed,
            age: statcastData.age,
            all_keys: Object.keys(statcastData)
          });
        } else {
          console.log(`[API] Available statcast IDs (first 5):`, Array.from(statcastMap.keys()).slice(0, 5));
        }
      }
      
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
        [`woba${yearSuffix}`]: woba,
        [`xwoba${yearSuffix}`]: xwoba,
        currentWoba: woba,
        careerWoba: woba,
        xwoba: xwoba,
        hardHitRate: statcastData && parseFloat(statcastData.hard_hit_percent) ? parseFloat(statcastData.hard_hit_percent) / 100 : null,
        barrelRate: statcastData && parseFloat(statcastData.barrel_batted_rate) ? parseFloat(statcastData.barrel_batted_rate) / 100 : null,
        kRate: statcastData && parseFloat(statcastData.k_percent) ? parseFloat(statcastData.k_percent) / 100 : null,
        chaseRate: statcastData && parseFloat(statcastData.o_swing_percent) ? parseFloat(statcastData.o_swing_percent) / 100 : null,
        pullRate: statcastData && parseFloat(statcastData.pull_percent) ? parseFloat(statcastData.pull_percent) / 100 : null,
        // Try both launch_angle and avg_hit_angle depending on source
        launchAngle: statcastData && (parseFloat(statcastData.launch_angle) || parseFloat(statcastData.avg_hit_angle)),
        [`launchAngle${yearSuffix}`]: statcastData && (parseFloat(statcastData.launch_angle) || parseFloat(statcastData.avg_hit_angle)),
        // Bat tracking data has avg_bat_speed
        batSpeed: statcastData && parseFloat(statcastData.avg_bat_speed),
      });
    }
    
    console.log(`[API] Returning ${players.length} players`);
    
    res.status(200).json({
      success: true,
      year: targetYear,
      players: players,
      count: players.length,
      lastUpdated: new Date().toISOString(),
    });
    
  } catch (error) {
    console.error('[API] Error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
}
