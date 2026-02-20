import Papa from 'papaparse';
import fs from 'fs';

const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY || 'YOUR_KEY_HERE';

async function fetchYear(targetYear) {
  console.log(`Fetching data for ${targetYear} predictions`);
  
  const currentDataYear = targetYear - 1;
  const prevDataYear = targetYear - 2;
  const actualResultsYear = targetYear;
  
  const fetchWithScraper = async (url) => {
    const scraperUrl = 'http://api.scraperapi.com?api_key=' + SCRAPER_API_KEY + '&url=' + encodeURIComponent(url);
    const response = await fetch(scraperUrl);
    return await response.text();
  };
  
  console.log('Fetching MLB birth dates');
  const mlbPlayersResponse = await fetch('https://statsapi.mlb.com/api/v1/sports/1/players?season=' + currentDataYear);
  const mlbPlayersData = await mlbPlayersResponse.json();
  const mlbBirthDateMap = new Map();
  if (mlbPlayersData.people) {
    mlbPlayersData.people.forEach(player => {
      if (player.id && player.birthDate) {
        mlbBirthDateMap.set(String(player.id), player.birthDate);
      }
    });
  }
  
  console.log('Fetching expected stats current year');
  const expectedCurrentCsv = await fetchWithScraper('https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=batter&year=' + currentDataYear + '&position=&team=&min=100&csv=true');
  
  console.log('Fetching expected stats previous year');
  const expectedPrevCsv = await fetchWithScraper('https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=batter&year=' + prevDataYear + '&position=&team=&min=100&csv=true');
  
  console.log('Fetching expected stats actual year');
  const expectedActualCsv = await fetchWithScraper('https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=batter&year=' + actualResultsYear + '&position=&team=&min=100&csv=true');
  
  console.log('Fetching statcast current');
  const statcast1Csv = await fetchWithScraper('https://baseballsavant.mlb.com/leaderboard/custom?year=' + currentDataYear + '&type=batter&min=1&selections=player_id,age,k_percent,hard_hit_percent,barrel_batted_rate,pull_percent&csv=true');
  
  console.log('Fetching statcast previous');
  const statcast1PrevCsv = await fetchWithScraper('https://baseballsavant.mlb.com/leaderboard/custom?type=batter&year=' + prevDataYear + '&min=1&selections=player_id,k_percent,hard_hit_percent,barrel_batted_rate,pull_percent&csv=true');
  
  console.log('Fetching launch angle current');
  const statcast2Csv = await fetchWithScraper('https://baseballsavant.mlb.com/leaderboard/statcast?type=batter&year=' + currentDataYear + '&min=1&csv=true');
  
  console.log('Fetching launch angle previous');
  const statcast2PrevCsv = await fetchWithScraper('https://baseballsavant.mlb.com/leaderboard/statcast?type=batter&year=' + prevDataYear + '&min=1&csv=true');
  
  console.log('Fetching bat speed');
  const statcast3Csv = await fetchWithScraper('https://baseballsavant.mlb.com/leaderboard/bat-tracking?year=' + currentDataYear + '&min=1&csv=true');
  
  console.log('Fetching chase rate current');
  const statcast4Csv = await fetchWithScraper('https://baseballsavant.mlb.com/leaderboard/custom?year=' + currentDataYear + '&type=batter&min=1&selections=player_id,o_swing_percent&csv=true');
  
  console.log('Fetching chase rate previous');
  const statcast4PrevCsv = await fetchWithScraper('https://baseballsavant.mlb.com/leaderboard/custom?year=' + prevDataYear + '&type=batter&min=1&selections=player_id,o_swing_percent&csv=true');
  
  console.log('Parsing CSVs');
  const expectedCurrentParsed = Papa.parse(expectedCurrentCsv, { header: true, skipEmptyLines: true, dynamicTyping: true });
  const expectedPrevParsed = Papa.parse(expectedPrevCsv, { header: true, skipEmptyLines: true, dynamicTyping: true });
  const expectedActualParsed = Papa.parse(expectedActualCsv, { header: true, skipEmptyLines: true, dynamicTyping: true });
  const statcast1Parsed = Papa.parse(statcast1Csv, { header: true, skipEmptyLines: true, dynamicTyping: true });
  const statcast1PrevParsed = Papa.parse(statcast1PrevCsv, { header: true, skipEmptyLines: true, dynamicTyping: true });
  const statcast2Parsed = Papa.parse(statcast2Csv, { header: true, skipEmptyLines: true, dynamicTyping: true });
  const statcast2PrevParsed = Papa.parse(statcast2PrevCsv, { header: true, skipEmptyLines: true, dynamicTyping: true });
  const statcast3Parsed = Papa.parse(statcast3Csv, { header: true, skipEmptyLines: true, dynamicTyping: true });
  const statcast4Parsed = Papa.parse(statcast4Csv, { header: true, skipEmptyLines: true, dynamicTyping: true });
  const statcast4PrevParsed = Papa.parse(statcast4PrevCsv, { header: true, skipEmptyLines: true, dynamicTyping: true });
  
  const prevYearMap = new Map();
  for (const row of expectedPrevParsed.data) {
    const playerId = String(row.player_id);
    if (playerId && row.est_woba) {
      prevYearMap.set(playerId, { xwoba: parseFloat(row.est_woba), woba: parseFloat(row.woba) });
    }
  }
  
  const actualResultsMap = new Map();
  for (const row of expectedActualParsed.data) {
    const playerId = String(row.player_id);
    if (playerId && row.woba) {
      actualResultsMap.set(playerId, { woba: parseFloat(row.woba), xwoba: parseFloat(row.est_woba) });
    }
  }
  
  const statcastMap = new Map();
  statcast1Parsed.data.forEach(row => {
    if (row.player_id) statcastMap.set(String(row.player_id), row);
  });
  
  statcast2Parsed.data.forEach(row => {
    const playerId = String(row.player_id);
    if (playerId) {
      const existing = statcastMap.get(playerId) || {};
      statcastMap.set(playerId, Object.assign({}, existing, { launch_angle: row.launch_angle, avg_hit_angle: row.avg_hit_angle }));
    }
  });
  
  const statcastPrevMap = new Map();
  statcast1PrevParsed.data.forEach(row => {
    if (row.player_id) statcastPrevMap.set(String(row.player_id), row);
  });
  
  statcast2PrevParsed.data.forEach(row => {
    const playerId = String(row.player_id);
    if (playerId) {
      const existing = statcastPrevMap.get(playerId) || {};
      statcastPrevMap.set(playerId, Object.assign({}, existing, { launch_angle: row.launch_angle, avg_hit_angle: row.avg_hit_angle }));
    }
  });
  
  statcast3Parsed.data.forEach(row => {
    const playerId = String(row.id || row.player_id);
    if (playerId) {
      const existing = statcastMap.get(playerId) || {};
      statcastMap.set(playerId, Object.assign({}, existing, { avg_bat_speed: row.avg_bat_speed, swing_speed: row.swing_speed }));
    }
  });
  
  statcast4Parsed.data.forEach(row => {
    const playerId = String(row.player_id);
    if (playerId) {
      const existing = statcastMap.get(playerId) || {};
      statcastMap.set(playerId, Object.assign({}, existing, { o_swing_percent: row.o_swing_percent }));
    }
  });
  
  const chasePrevMap = new Map();
  statcast4PrevParsed.data.forEach(row => {
    const playerId = String(row.player_id);
    if (playerId && row.o_swing_percent) chasePrevMap.set(playerId, parseFloat(row.o_swing_percent));
  });
  
  const players = [];
  const currentYearSuffix = currentDataYear % 100;
  const prevYearSuffix = prevDataYear % 100;
  const actualYearSuffix = actualResultsYear % 100;
  
  for (const row of expectedCurrentParsed.data) {
    const pa = parseInt(row.pa) || 0;
    if (pa < 100) continue;
    
    const currentWoba = parseFloat(row.woba);
    const currentXwoba = parseFloat(row.est_woba);
    if (!currentWoba || !currentXwoba) continue;
    
    const playerId = String(row.player_id);
    const prevYearData = prevYearMap.get(playerId);
    const actualResults = actualResultsMap.get(playerId);
    const statcastData = statcastMap.get(playerId);
    const statcastPrevData = statcastPrevMap.get(playerId);
    const chasePrev = chasePrevMap.get(playerId);
    
    const pos = (row.pos || row.primary_position || 'OF').toUpperCase();
    if (pos.includes('SP') || pos.includes('RP') || pos === 'P') continue;
    
    const currentHardHit = statcastData && parseFloat(statcastData.hard_hit_percent);
    const prevHardHit = statcastPrevData && parseFloat(statcastPrevData.hard_hit_percent);
    const hardHitImprovement = (currentHardHit != null && prevHardHit != null) ? currentHardHit - prevHardHit : null;
    
    const currentBarrel = statcastData && parseFloat(statcastData.barrel_batted_rate);
    const prevBarrel = statcastPrevData && parseFloat(statcastPrevData.barrel_batted_rate);
    const barrelImprovement = (currentBarrel != null && prevBarrel != null) ? currentBarrel - prevBarrel : null;
    
    const currentKRate = statcastData && parseFloat(statcastData.k_percent);
    const prevKRate = statcastPrevData && parseFloat(statcastPrevData.k_percent);
    const kRateImprovement = (currentKRate != null && prevKRate != null) ? prevKRate - currentKRate : null;
    
    const currentChase = statcastData && parseFloat(statcastData.o_swing_percent);
    const chaseImprovement = (currentChase != null && chasePrev != null) ? chasePrev - currentChase : null;
    
    const currentLaunchAngle = statcastData && (parseFloat(statcastData.launch_angle) || parseFloat(statcastData.avg_hit_angle));
    const prevLaunchAngle = statcastPrevData && (parseFloat(statcastPrevData.launch_angle) || parseFloat(statcastPrevData.avg_hit_angle));
    const launchAngleDelta = (currentLaunchAngle != null && prevLaunchAngle != null) ? currentLaunchAngle - prevLaunchAngle : null;
    
    const playerObj = {
      name: row['last_name, first_name'] || (row.first_name || '') + ' ' + (row.last_name || ''),
      team: row.team_name_abbrev || row.team,
      birthDate: mlbBirthDateMap.get(playerId) || null,
      age: null,
      pa: pa,
      position: row.pos || row.primary_position || 'OF',
      currentWoba: currentWoba,
      careerWoba: currentWoba,
      xwobaSurplus: currentXwoba - currentWoba,
      xwobaTrajectory: prevYearData ? currentXwoba - prevYearData.xwoba : 0,
      hardHitRate: currentHardHit ? currentHardHit / 100 : null,
      barrelRate: currentBarrel ? currentBarrel / 100 : null,
      kRate: currentKRate ? currentKRate / 100 : null,
      chaseRate: currentChase ? currentChase / 100 : null,
      pullRate: statcastData && parseFloat(statcastData.pull_percent) ? parseFloat(statcastData.pull_percent) / 100 : null,
      launchAngle: currentLaunchAngle,
      launchAngleDelta: launchAngleDelta,
      batSpeed: statcastData && parseFloat(statcastData.avg_bat_speed),
      hardHitImprovement: hardHitImprovement,
      barrelImprovement: barrelImprovement,
      kRateImprovement: kRateImprovement,
      chaseImprovement: chaseImprovement
    };
    
    playerObj['woba' + currentYearSuffix] = currentWoba;
    playerObj['xwoba' + currentYearSuffix] = currentXwoba;
    playerObj['woba' + prevYearSuffix] = prevYearData ? prevYearData.woba : null;
    playerObj['xwoba' + prevYearSuffix] = prevYearData ? prevYearData.xwoba : null;
    playerObj['woba' + actualYearSuffix] = actualResults ? actualResults.woba : null;
    playerObj['launchAngle' + currentYearSuffix] = currentLaunchAngle;
    playerObj['launchAngle' + prevYearSuffix] = prevLaunchAngle;
    
    players.push(playerObj);
  }
  
  console.log('Built ' + players.length + ' players');
  
  return {
    success: true,
    year: targetYear,
    dataYears: [currentDataYear, prevDataYear, actualResultsYear],
    players: players,
    count: players.length,
    lastUpdated: new Date().toISOString()
  };
}

async function main() {
  if (!SCRAPER_API_KEY || SCRAPER_API_KEY === 'YOUR_KEY_HERE') {
    console.error('ERROR SCRAPER_API_KEY not set');
    process.exit(1);
  }
  
  const data2025 = await fetchYear(2025);
  const data2026 = await fetchYear(2026);
  
  if (!fs.existsSync('public/data')) {
    fs.mkdirSync('public/data', { recursive: true });
  }
  
  fs.writeFileSync('public/data/players-2025.json', JSON.stringify(data2025, null, 2));
  fs.writeFileSync('public/data/players-2026.json', JSON.stringify(data2026, null, 2));
  
  console.log('SUCCESS Data saved to public data');
}

main().catch(console.error);
