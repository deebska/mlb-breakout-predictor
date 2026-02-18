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
    const { year = '2025' } = req.query;
    const targetYear = parseInt(year);
    
    const scraperApiKey = process.env.SCRAPER_API_KEY;
    
    if (!scraperApiKey) {
      throw new Error('SCRAPER_API_KEY not set');
    }
    
    console.log(`[API] Fetching year ${targetYear}...`);
    
    // Baseball Savant URLs
    const expectedStatsUrl = `https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=batter&year=${targetYear}&position=&team=&min=100&csv=true`;
    // Use TWO custom leaderboard calls - use min=1 instead of min=q to get all players
    const statcastUrl1 = `https://baseballsavant.mlb.com/leaderboard/custom?year=${targetYear}&type=batter&min=1&selections=player_id,k_percent,hard_hit_percent,barrel_batted_rate,o_swing_percent,pull_percent&csv=true`;
    const statcastUrl2 = `https://baseballsavant.mlb.com/leaderboard/custom?year=${targetYear}&type=batter&min=1&selections=player_id,launch_angle,swing_speed&csv=true`;
    
    // Fetch via ScraperAPI
    const scraperUrl1 = `http://api.scraperapi.com?api_key=${scraperApiKey}&url=${encodeURIComponent(expectedStatsUrl)}`;
    const scraperUrl2 = `http://api.scraperapi.com?api_key=${scraperApiKey}&url=${encodeURIComponent(statcastUrl1)}`;
    const scraperUrl3 = `http://api.scraperapi.com?api_key=${scraperApiKey}&url=${encodeURIComponent(statcastUrl2)}`;
    
    console.log(`[API] Fetching expected stats...`);
    const expectedResponse = await fetch(scraperUrl1);
    const expectedCsv = await expectedResponse.text();
    
    console.log(`[API] Fetching statcast 1...`);
    const statcast1Response = await fetch(scraperUrl2);
    const statcast1Csv = statcast1Response.ok ? await statcast1Response.text() : null;
    
    console.log(`[API] Fetching statcast 2...`);
    const statcast2Response = await fetch(scraperUrl3);
    const statcast2Csv = statcast2Response.ok ? await statcast2Response.text() : null;
    
    console.log(`[API] Expected: ${expectedCsv.length} bytes, Statcast1: ${statcast1Csv?.length || 0} bytes, Statcast2: ${statcast2Csv?.length || 0} bytes`);
    
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
    
    // Parse FIRST statcast CSV (k_percent, hard_hit_percent, barrel_batted_rate, o_swing_percent, pull_percent)
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
    
    // Parse SECOND statcast CSV (launch_angle, swing_speed) and MERGE with first
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
            // Merge: add all keys from row, but don't overwrite existing non-null values with null
            const merged = { ...existing };
            Object.keys(row).forEach(key => {
              // Only overwrite if existing value is null/undefined OR new value is not null
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
      
      console.log(`[API] Merged statcast2 data, total: ${statcastMap.size} players`);
      console.log(`[API] Statcast2 sample columns:`, Object.keys(statcast2Parsed.data[0] || {}).slice(0, 15));
    }
    
    // Build players array
    const players = [];
    const yearSuffix = targetYear % 100;
    
    for (const row of expectedParsed.data) {
      const pa = parseInt(row.pa) || 0;
      if (pa < 100) continue;
      
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
        age: parseInt(row.age),
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
        launchAngle: statcastData && parseFloat(statcastData.launch_angle),
        [`launchAngle${yearSuffix}`]: statcastData && parseFloat(statcastData.launch_angle),
        batSpeed: statcastData && parseFloat(statcastData.swing_speed),
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
