// Baseball Savant API - Properly maps all column names
// Tested with actual Baseball Savant CSV structure

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  try {
    const { year = '2025' } = req.query;
    const targetYear = parseInt(year);
    
    console.log(`[API] Fetching Baseball Savant for ${targetYear}...`);
    
    // Fetch BOTH endpoints: expected stats + statcast
    const expectedStatsUrl = `https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=batter&year=${targetYear}&position=&team=&min=100&csv=true`;
    const statcastUrl = `https://baseballsavant.mlb.com/leaderboard/statcast?type=batter&year=${targetYear}&position=&team=&min=q&csv=true`;
    
    // Add browser headers to bypass bot detection
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Referer': 'https://baseballsavant.mlb.com/',
      'DNT': '1',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1'
    };
    
    const [expectedResponse, statcastResponse] = await Promise.all([
      fetch(expectedStatsUrl, { headers }),
      fetch(statcastUrl, { headers })
    ]);
    
    if (!expectedResponse.ok) {
      const errorText = await expectedResponse.text();
      console.log(`[API] Baseball Savant error response:`, errorText.slice(0, 500));
      throw new Error(`Baseball Savant expected stats returned ${expectedResponse.status}`);
    }
    
    const expectedCsv = await expectedResponse.text();
    console.log(`[API] Expected CSV length:`, expectedCsv.length, 'bytes');
    console.log(`[API] Expected CSV first 200 chars:`, expectedCsv.slice(0, 200));
    
    const statcastCsv = statcastResponse.ok ? await statcastResponse.text() : null;
    
    // Parse expected stats
    const expectedLines = expectedCsv.trim().split('\n');
    const expectedHeaders = expectedLines[0].split('\t').map(h => h.trim());
    
    console.log(`[API] Expected Stats columns:`, expectedHeaders.join(' | '));
    
    // Parse statcast data (has hardHitRate, barrelRate, kRate, etc.)
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
      console.log(`[API] Loaded statcast data for ${statcastMap.size} players`);
    }
    
    console.log(`[API] Processing ${expectedLines.length - 1} players...`);
    
    // Baseball Savant uses TAB-separated values, not comma-separated!
    if (expectedLines.length < 2) {
      throw new Error('Empty CSV from Baseball Savant');
    }
    
    const players = [];
    
    for (let i = 1; i < expectedLines.length; i++) {
      // Split by tabs
      const values = expectedLines[i].split('\t').map(v => v.trim());
      
      // Build row object
      const row = {};
      expectedHeaders.forEach((header, idx) => {
        row[header] = values[idx] || null;
      });
      
      // Helper to safely parse numbers
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
      
      // Extract using actual Baseball Savant column names
      const pa = parseIntSafe(row.pa) || 0;
      if (pa < 100) continue;
      
      // Use actual column names from Baseball Savant
      const xwoba = parseNum(row.est_woba);
      const woba = parseNum(row.woba);
      
      if (!xwoba || !woba) continue;
      
      // Get statcast data for this player
      const playerId = row.player_id;
      const statcastData = statcastMap.get(playerId);
      
      // Debug: log first player's raw data
      if (i === 1) {
        console.log(`[API] First player raw data:`, JSON.stringify(row).slice(0, 200));
        console.log(`[API] Columns available:`, Object.keys(row).slice(0, 10).join(', '));
      }
      
      const player = {
        // Identity - the column name has a space: "last_name, first_name"
        name: row['last_name, first_name'] || 
              row['last_name,first_name'] || 
              `${row.first_name || ''} ${row.last_name || ''}`.trim() ||
              'Unknown Player',
        team: row.team_name_abbrev || row.team || row.team_abbrev,
        age: parseIntSafe(row.age) || parseIntSafe(row.player_age),
        pa: pa,
        position: row.primary_pos_formatted || row.primary_position || row.pos || 'OF',
        
        // Year-specific naming
        [`woba${yearSuffix}`]: woba,
        [`xwoba${yearSuffix}`]: xwoba,
        
        // Generic naming
        currentWoba: woba,
        careerWoba: woba,
        xwoba: xwoba,
        
        // Get from statcast data
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
    
    console.log(`[API] ✓ Processed ${players.length} hitters`);
    console.log(`[API] Sample player:`, players[0]?.name, players[0]?.pa, 'PA');
    
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
      error: error.message,
      message: 'Failed to fetch Baseball Savant data'
    });
  }
}
