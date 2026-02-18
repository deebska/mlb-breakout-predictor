// Simple Baseball Savant API via ScraperAPI with detailed error logging

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
    
    // Baseball Savant URL
    const baseballSavantUrl = `https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=batter&year=${targetYear}&position=&team=&min=100&csv=true`;
    
    // ScraperAPI URL
    const scraperUrl = `http://api.scraperapi.com?api_key=${scraperApiKey}&url=${encodeURIComponent(baseballSavantUrl)}`;
    
    console.log(`[API] Calling ScraperAPI for expected stats...`);
    
    const response = await fetch(scraperUrl);
    
    console.log(`[API] Expected stats response status: ${response.status}`);
    
    const text = await response.text();
    
    console.log(`[API] Expected stats length: ${text.length} bytes`);
    
    if (!response.ok) {
      console.log(`[API] Full error response: "${text}"`);
      throw new Error(`ScraperAPI returned ${response.status}: ${text.slice(0, 100)}`);
    }
    
    if (text.length < 200) {
      console.log(`[API] Response too short, full text: "${text}"`);
      throw new Error(`Baseball Savant returned invalid data: ${text.slice(0, 100)}`);
    }
    
    // Fetch statcast data for hardHitRate, barrelRate, kRate
    console.log(`[API] Fetching statcast data...`);
    
    let statcastText = null;
    try {
      const statcastUrl = `https://baseballsavant.mlb.com/leaderboard/statcast?type=batter&year=${targetYear}&position=&team=&min=q&csv=true`;
      const scraperStatcastUrl = `http://api.scraperapi.com?api_key=${scraperApiKey}&url=${encodeURIComponent(statcastUrl)}`;
      
      const statcastResponse = await fetch(scraperStatcastUrl);
      statcastText = statcastResponse.ok ? await statcastResponse.text() : null;
      
      console.log(`[API] Statcast response status: ${statcastResponse.status}`);
      console.log(`[API] Statcast length: ${statcastText ? statcastText.length : 0} bytes`);
    } catch (error) {
      console.log(`[API] Statcast fetch failed: ${error.message}`);
    }
    
    // Parse CSV - ScraperAPI returns comma-separated with quotes, not tabs
    const lines = text.trim().split('\n');
    
    // Parse CSV properly handling quotes
    const parseCsvLine = (line) => {
      const result = [];
      let current = '';
      let inQuotes = false;
      
      for (let i = 0; i < line.length; i++) {
        const char = line[i];
        
        if (char === '"') {
          inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
          result.push(current.trim());
          current = '';
        } else {
          current += char;
        }
      }
      result.push(current.trim());
      return result;
    };
    
    const headerValues = parseCsvLine(lines[0]);
    const headers = headerValues.map(h => h.replace(/"/g, '').trim());
    
    console.log(`[API] Found ${lines.length - 1} players`);
    console.log(`[API] Columns: ${headers.slice(0, 5).join(', ')}`);
    
    // Parse statcast data
    let statcastMap = new Map();
    if (statcastText && statcastText.length > 200) {
      const statcastLines = statcastText.trim().split('\n');
      const statcastHeaderValues = parseCsvLine(statcastLines[0]);
      const statcastHeaders = statcastHeaderValues.map(h => h.replace(/"/g, '').trim());
      
      for (let i = 1; i < statcastLines.length; i++) {
        const values = parseCsvLine(statcastLines[i]).map(v => v.replace(/"/g, '').trim());
        const row = {};
        statcastHeaders.forEach((h, idx) => {
          row[h] = values[idx] || null;
        });
        
        const playerId = row.player_id;
        if (playerId) {
          statcastMap.set(playerId, row);
        }
      }
      console.log(`[API] Statcast: loaded ${statcastMap.size} players`);
    }
    
    const players = [];
    const yearSuffix = targetYear % 100;
    
    for (let i = 1; i < lines.length; i++) {
      const values = parseCsvLine(lines[i]).map(v => v.replace(/"/g, '').trim());
      const row = {};
      headers.forEach((h, idx) => {
        row[h] = values[idx] || null;
      });
      
      const pa = parseInt(row.pa) || 0;
      if (pa < 100) continue;
      
      const woba = parseFloat(row.woba);
      const xwoba = parseFloat(row.est_woba);
      
      if (!woba || !xwoba) continue;
      
      // Get statcast data for this player
      const playerId = row.player_id;
      const statcastData = statcastMap.get(playerId);
      
      players.push({
        name: row['last_name, first_name'] || 'Unknown',
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
    console.log(`[API] DEBUG - First player hardHitRate: ${players[0]?.hardHitRate}`);
    console.log(`[API] DEBUG - Statcast map had ${statcastMap.size} players`);
    
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
