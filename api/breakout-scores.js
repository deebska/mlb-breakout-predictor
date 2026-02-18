// Baseball Savant API via ScraperAPI proxy
// Bypasses bot detection by routing through ScraperAPI

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
      throw new Error('SCRAPER_API_KEY environment variable not set');
    }
    
    console.log(`[API] Fetching Baseball Savant for ${targetYear} via ScraperAPI...`);
    
    // Build URLs
    const expectedStatsUrl = `https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=batter&year=${targetYear}&position=&team=&min=100&csv=true`;
    const statcastUrl = `https://baseballsavant.mlb.com/leaderboard/statcast?type=batter&year=${targetYear}&position=&team=&min=q&csv=true`;
    
    // Route through ScraperAPI
    const scraperUrl1 = `http://api.scraperapi.com?api_key=${scraperApiKey}&url=${encodeURIComponent(expectedStatsUrl)}`;
    const scraperUrl2 = `http://api.scraperapi.com?api_key=${scraperApiKey}&url=${encodeURIComponent(statcastUrl)}`;
    
    console.log(`[API] Fetching via proxy...`);
    
    // Fetch expected stats first
    const expectedResponse = await fetch(scraperUrl1);
    
    if (!expectedResponse.ok) {
      throw new Error(`ScraperAPI returned ${expectedResponse.status} for expected stats`);
    }
    
    // Wait 1 second before second request to avoid rate limit
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Then fetch statcast
    const statcastResponse = await fetch(scraperUrl2);
    
    const expectedCsv = await expectedResponse.text();
    console.log(`[API] Expected stats CSV: ${expectedCsv.length} bytes`);
    
    const statcastCsv = statcastResponse.ok ? await statcastResponse.text() : null;
    if (statcastCsv) {
      console.log(`[API] Statcast CSV: ${statcastCsv.length} bytes`);
    }
    
    // Parse expected stats (TAB-separated)
    const expectedLines = expectedCsv.trim().split('\n');
    if (expectedLines.length < 2) {
      throw new Error('Empty CSV from Baseball Savant');
    }
    
    const expectedHeaders = expectedLines[0].split('\t').map(h => h.trim());
    console.log(`[API] Columns:`, expectedHeaders.slice(0, 5).join(', '));
    
    // Parse statcast data
    let statcastMap = new Map();
    if (statcastCsv) {
      const statcastLines = statcastCsv.trim().split('\n');
      const statcastHeaders = statcastLines[0].split('\t').map(h => h.trim());
      
      for (let i = 1; i < statcastLines.length; i++) {
        const values = statcastLines[i].split('\t').map(v => v.trim());
        const row = {};
        statcastHeaders.forEach((header, idx) => {
          row[header] = values[idx] || null;
        });
        
        const playerId = row.player_id;
        if (playerId) {
          statcastMap.set(playerId, row);
        }
      }
      console.log(`[API] Statcast: ${statcastMap.size} players`);
    }
    
    // Parse players
    const parseNum = (val) => {
      if (!val || val === '' || val === 'null') return null;
      const num = parseFloat(val);
      return isNaN(num) ? null : num;
    };
    
    const parseIntSafe = (val) => {
      if (!val || val === '' || val === 'null') return null;
      const num = Number.parseInt(val);
      return isNaN(num) ? null : num;
    };
    
    const players = [];
    const yearSuffix = targetYear % 100;
    
    for (let i = 1; i < expectedLines.length; i++) {
      const values = expectedLines[i].split('\t').map(v => v.trim());
      const row = {};
      expectedHeaders.forEach((header, idx) => {
        row[header] = values[idx] || null;
      });
      
      const pa = parseIntSafe(row.pa) || 0;
      if (pa < 100) continue;
      
      const xwoba = parseNum(row.est_woba);
      const woba = parseNum(row.woba);
      
      if (!xwoba || !woba) continue;
      
      const playerId = row.player_id;
      const statcastData = statcastMap.get(playerId);
      
      const player = {
        name: row['last_name, first_name'] || `${row.first_name || ''} ${row.last_name || ''}`.trim(),
        team: row.team_name_abbrev || row.team,
        age: parseIntSafe(row.age) || parseIntSafe(row.player_age),
        pa: pa,
        position: row.primary_pos_formatted || row.primary_position || row.pos || 'OF',
        
        [`woba${yearSuffix}`]: woba,
        [`xwoba${yearSuffix}`]: xwoba,
        
        currentWoba: woba,
        careerWoba: woba,
        xwoba: xwoba,
        
        hardHitRate: statcastData && parseNum(statcastData.hard_hit_percent) ? parseNum(statcastData.hard_hit_percent) / 100 : null,
        barrelRate: statcastData && parseNum(statcastData.barrel_batted_rate) ? parseNum(statcastData.barrel_batted_rate) / 100 : null,
        kRate: statcastData && parseNum(statcastData.k_percent) ? parseNum(statcastData.k_percent) / 100 : null,
        chaseRate: statcastData && parseNum(statcastData.o_swing_percent) ? parseNum(statcastData.o_swing_percent) / 100 : null,
        pullRate: statcastData && parseNum(statcastData.pull_percent) ? parseNum(statcastData.pull_percent) / 100 : null,
        launchAngle: statcastData && parseNum(statcastData.launch_angle),
        [`launchAngle${yearSuffix}`]: statcastData && parseNum(statcastData.launch_angle),
        batSpeed: statcastData && parseNum(statcastData.swing_speed),
      };
      
      // Filter out pitchers
      const pos = (player.position || '').toUpperCase();
      if (pos.includes('SP') || pos.includes('RP') || pos === 'P') {
        continue;
      }
      
      players.push(player);
    }
    
    console.log(`[API] ✓ ${players.length} players processed`);
    
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
