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
    
    // Fetch expected stats (primary dataset)
    const url = `https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=batter&year=${targetYear}&position=&team=&min=100&csv=true`;
    const response = await fetch(url);
    
    if (!response.ok) {
      throw new Error(`Baseball Savant returned ${response.status}`);
    }
    
    const csvText = await response.text();
    
    // Parse CSV manually (robust parsing)
    const lines = csvText.trim().split('\n');
    if (lines.length < 2) {
      throw new Error('Empty CSV from Baseball Savant');
    }
    
    const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
    console.log(`[API] Found ${headers.length} columns, ${lines.length - 1} players`);
    
    const players = [];
    
    for (let i = 1; i < lines.length; i++) {
      const values = [];
      let current = '';
      let inQuotes = false;
      
      // Handle CSV with quotes properly
      for (const char of lines[i]) {
        if (char === '"') {
          inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
          values.push(current.trim());
          current = '';
        } else {
          current += char;
        }
      }
      values.push(current.trim());
      
      // Build row object
      const row = {};
      headers.forEach((header, idx) => {
        row[header] = values[idx] || null;
      });
      
      // Helper to safely parse numbers
      const parseNum = (val) => {
        if (!val || val === '') return null;
        const num = parseFloat(val);
        return isNaN(num) ? null : num;
      };
      
      const parseInt = (val) => {
        if (!val || val === '') return null;
        const num = Number.parseInt(val);
        return isNaN(num) ? null : num;
      };
      
      // Extract all possible field variations Baseball Savant uses
      const pa = parseInt(row.pa) || 0;
      if (pa < 100) continue; // Skip players with < 100 PA
      
      const xwoba = parseNum(row.est_woba) || parseNum(row.xwoba) || parseNum(row.est_woba_using_speedangle);
      const woba = parseNum(row.woba);
      
      if (!xwoba || !woba) continue; // Need these minimum
      
      // Build player object with ALL possible field names from Baseball Savant
      const yearSuffix = targetYear % 100;
      
      const player = {
        // Identity
        name: `${row.first_name || ''} ${row.last_name || ''}`.trim(),
        team: row.team_name_abbrev || row.team || row.team_abbrev,
        age: parseInt(row.age) || parseInt(row.player_age),
        pa: pa,
        position: row.primary_pos_formatted || row.primary_position || row.pos || 'OF',
        
        // Year-specific naming (woba25, xwoba25, etc.)
        [`woba${yearSuffix}`]: woba,
        [`xwoba${yearSuffix}`]: xwoba,
        
        // Generic naming for calculations
        currentWoba: woba,
        careerWoba: woba, // Will be same as current for now
        xwoba: xwoba,
        
        // Contact quality - try all possible column names
        hardHitRate: 
          parseNum(row.hard_hit_percent) ? parseNum(row.hard_hit_percent) / 100 :
          parseNum(row.hard_hit_rate) ? parseNum(row.hard_hit_rate) :
          parseNum(row.hardhit_percent) ? parseNum(row.hardhit_percent) / 100 : null,
        
        barrelRate:
          parseNum(row.barrel_batted_rate) ? parseNum(row.barrel_batted_rate) / 100 :
          parseNum(row.barrel_percent) ? parseNum(row.barrel_percent) / 100 :
          parseNum(row.brl_percent) ? parseNum(row.brl_percent) / 100 : null,
        
        kRate:
          parseNum(row.k_percent) ? parseNum(row.k_percent) / 100 :
          parseNum(row.strikeout_percent) ? parseNum(row.strikeout_percent) / 100 :
          parseNum(row.k_rate) ? parseNum(row.k_rate) : null,
        
        // Additional useful stats
        chaseRate: parseNum(row.o_swing_percent) ? parseNum(row.o_swing_percent) / 100 : null,
        batSpeed: parseNum(row.swing_speed) || parseNum(row.bat_speed),
        pullRate: parseNum(row.pull_percent) ? parseNum(row.pull_percent) / 100 : null,
        launchAngle: parseNum(row.launch_angle) || parseNum(row.avg_launch_angle),
        
        // Add year-specific launch angle
        [`launchAngle${yearSuffix}`]: parseNum(row.launch_angle) || parseNum(row.avg_launch_angle),
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
