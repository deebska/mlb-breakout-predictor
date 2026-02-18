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
    
    console.log(`[API] Calling ScraperAPI...`);
    
    const response = await fetch(scraperUrl);
    
    console.log(`[API] Response status: ${response.status}`);
    console.log(`[API] Response ok: ${response.ok}`);
    
    const text = await response.text();
    
    console.log(`[API] Response length: ${text.length} bytes`);
    console.log(`[API] First 200 chars: "${text.slice(0, 200)}"`);
    
    if (!response.ok) {
      console.log(`[API] Full error response: "${text}"`);
      throw new Error(`ScraperAPI returned ${response.status}: ${text.slice(0, 100)}`);
    }
    
    if (text.length < 200) {
      console.log(`[API] Response too short, full text: "${text}"`);
      throw new Error(`Baseball Savant returned invalid data: ${text.slice(0, 100)}`);
    }
    
    // Parse CSV
    const lines = text.trim().split('\n');
    const headers = lines[0].split('\t').map(h => h.trim());
    
    console.log(`[API] Found ${lines.length - 1} players`);
    console.log(`[API] Columns: ${headers.slice(0, 5).join(', ')}`);
    
    const players = [];
    const yearSuffix = targetYear % 100;
    
    for (let i = 1; i < Math.min(lines.length, 200); i++) { // Limit to 200 for now
      const values = lines[i].split('\t').map(v => v.trim());
      const row = {};
      headers.forEach((h, idx) => {
        row[h] = values[idx] || null;
      });
      
      const pa = parseInt(row.pa) || 0;
      if (pa < 100) continue;
      
      const woba = parseFloat(row.woba);
      const xwoba = parseFloat(row.est_woba);
      
      if (!woba || !xwoba) continue;
      
      players.push({
        name: row['last_name, first_name'] || 'Unknown',
        team: row.team_name_abbrev || row.team,
        age: parseInt(row.age),
        pa: pa,
        position: row.pos || 'OF',
        [`woba${yearSuffix}`]: woba,
        [`xwoba${yearSuffix}`]: xwoba,
        currentWoba: woba,
        careerWoba: woba,
        xwoba: xwoba,
        hardHitRate: null, // Will add statcast later
        barrelRate: null,
        kRate: null,
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
