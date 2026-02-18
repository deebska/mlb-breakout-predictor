// Vercel Serverless Function: Fetch Baseball Savant data
// Returns data in exact format expected by frontend

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  try {
    const { year = '2025' } = req.query;
    const targetYear = parseInt(year);
    
    console.log(`Fetching Baseball Savant for ${targetYear}...`);
    
    // Fetch expected stats CSV
    const url = `https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=batter&year=${targetYear}&position=&team=&min=100&csv=true`;
    const response = await fetch(url);
    
    if (!response.ok) {
      throw new Error('Baseball Savant unavailable');
    }
    
    const csvText = await response.text();
    const lines = csvText.trim().split('\n');
    const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
    
    const players = lines.slice(1).map(line => {
      const values = line.split(',').map(v => v.trim().replace(/"/g, ''));
      const row = {};
      headers.forEach((h, i) => { row[h] = values[i] || null; });
      
      // Extract values
      const xwoba = parseFloat(row.est_woba || row.xwoba);
      const woba = parseFloat(row.woba);
      const pa = parseInt(row.pa) || 0;
      
      // Return in exact format frontend expects
      const yearSuffix = targetYear % 100; // 2025 -> 25
      
      return {
        name: `${row.first_name} ${row.last_name}`,
        team: row.team_name_abbrev || row.team,
        age: parseInt(row.age || row.player_age) || null,
        pa: pa,
        position: row.primary_pos_formatted || row.primary_position || row.pos || 'OF',
        
        // Year-specific fields (woba25, xwoba25, etc.)
        [`woba${yearSuffix}`]: woba,
        [`xwoba${yearSuffix}`]: xwoba,
        
        // Also include generic fields for calculations
        currentWoba: woba,
        xwoba: xwoba,
        
        hardHitRate: parseFloat(row.hard_hit_percent) ? parseFloat(row.hard_hit_percent) / 100 : null,
        barrelRate: parseFloat(row.barrel_batted_rate) ? parseFloat(row.barrel_batted_rate) / 100 : null,
        kRate: parseFloat(row.k_percent) ? parseFloat(row.k_percent) / 100 : null,
      };
    }).filter(p => p.pa >= 100 && p.xwoba != null);
    
    // Filter out pitchers
    const hitters = players.filter(p => {
      const pos = (p.position || '').toUpperCase();
      return !pos.includes('SP') && !pos.includes('RP') && pos !== 'P';
    });
    
    console.log(`✓ Loaded ${hitters.length} hitters`);
    
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
      error: error.message
    });
  }
}
