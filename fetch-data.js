// Script to fetch Baseball Savant data and save as static JSON files
// Run this locally: node fetch-data.js

import Papa from 'papaparse';
import fs from 'fs';

const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY || 'YOUR_KEY_HERE';

async function fetchYear(targetYear) {
  console.log(`\nFetching data for ${targetYear} predictions...`);
  
  const currentDataYear = targetYear - 1;
  const prevDataYear = targetYear - 2;
  const actualResultsYear = targetYear; // For validation - did they actually break out?
  
  console.log(`Using data years: ${currentDataYear} (current), ${prevDataYear} (previous), ${actualResultsYear} (actual results for validation)`);
  
  // First, fetch MLB roster data for birth dates (no auth needed, public API)
  console.log('Fetching MLB player birth dates from MLB Stats API...');
  const mlbPlayersResponse = await fetch(`https://statsapi.mlb.com/api/v1/sports/1/players?season=${currentDataYear}`);
  const mlbPlayersData = await mlbPlayersResponse.json();
  
  // Build birth date map from MLB API (player_id -> birthDate)
  const mlbBirthDateMap = new Map();
  if (mlbPlayersData.people) {
    mlbPlayersData.people.forEach(player => {
      if (player.id && player.birthDate) {
        mlbBirthDateMap.set(String(player.id), player.birthDate);
      }
    });
  }
  console.log(`Loaded ${mlbBirthDateMap.size} player birth dates from MLB Stats API`);
  
  
  // Baseball Savant URLs
  const urls = {
    expectedCurrent: `https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=batter&year=${currentDataYear}&position=&team=&min=100&csv=true`,
    expectedPrev: `https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=batter&year=${prevDataYear}&position=&team=&min=100&csv=true`,
    expectedActual: `https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=batter&year=${actualResultsYear}&position=&team=&min=100&csv=true`, // NEW
    statcast1: `https://baseballsavant.mlb.com/leaderboard/custom?year=${currentDataYear}&type=batter&min=1&selections=player_id,age,k_percent,hard_hit_percent,barrel_batted_rate,pull_percent&csv=true`,
    statcast2: `https://baseballsavant.mlb.com/leaderboard/statcast?type=batter&year=${currentDataYear}&min=1&csv=true`,
    statcast3: `https://baseballsavant.mlb.com/leaderboard/bat-tracking?year=${currentDataYear}&min=1&csv=true`,
    statcast4: `https://baseballsavant.mlb.com/leaderboard/custom?year=${currentDataYear}&type=batter&min=1&selections=player_id,o_swing_percent&csv=true`,
    statcast2Prev: `https://baseballsavant.mlb.com/leaderboard/statcast?type=batter&year=${prevDataYear}&min=1&csv=true`
  };
  
  // Fetch all URLs via ScraperAPI
  const fetchWithScraper = async (url) => {
    const scraperUrl = `http://api.scraperapi.com?api_key=${SCRAPER_API_KEY}&url=${encodeURIComponent(url)}`;
    const response = await fetch(scraperUrl);
    return await response.text();
  };
  
  console.log('Fetching expected stats (current)...');
  const expectedCurrentCsv = await fetchWithScraper(urls.expectedCurrent);
  
  console.log('Fetching expected stats (previous)...');
  const expectedPrevCsv = await fetchWithScraper(urls.expectedPrev);
  
  console.log('Fetching expected stats (actual results)...');
  const expectedActualCsv = await fetchWithScraper(urls.expectedActual);
  
  console.log('Fetching statcast 1...');
  const statcast1Csv = await fetchWithScraper(urls.statcast1);
  
  console.log('Fetching statcast 2...');
  const statcast2Csv = await fetchWithScraper(urls.statcast2);
  
  console.log('Fetching statcast 3...');
  const statcast3Csv = await fetchWithScraper(urls.statcast3);
  
  console.log('Fetching statcast 4...');
  const statcast4Csv = await fetchWithScraper(urls.statcast4);
  
  console.log('Fetching statcast 2 (previous)...');
  const statcast2PrevCsv = await fetchWithScraper(urls.statcast2Prev);
  
  // Parse expected stats CSVs
  const expectedCurrentParsed = Papa.parse(expectedCurrentCsv, { header: true, skipEmptyLines: true, dynamicTyping: true });
  const expectedPrevParsed = Papa.parse(expectedPrevCsv, { header: true, skipEmptyLines: true, dynamicTyping: true });
  const expectedActualParsed = Papa.parse(expectedActualCsv, { header: true, skipEmptyLines: true, dynamicTyping: true });
  
  console.log(`Parsed ${expectedCurrentParsed.data.length} current year players`);
  console.log(`Parsed ${expectedPrevParsed.data.length} previous year players`);
  console.log(`Parsed ${expectedActualParsed.data.length} actual results players`);
  
  // Build previous year map for trajectory
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
  
  console.log(`Built previous year map with ${prevYearMap.size} players`);
  
  // Build actual results map for validation (did they break out?)
  const actualResultsMap = new Map();
  for (const row of expectedActualParsed.data) {
    const playerId = String(row.player_id);
    if (playerId && row.woba) {
      actualResultsMap.set(playerId, {
        woba: parseFloat(row.woba),
        xwoba: parseFloat(row.est_woba)
      });
    }
  }
  
  console.log(`Built actual results map with ${actualResultsMap.size} players`);
  
  // Parse and merge statcast data
  let statcastMap = new Map();
  
  const statcast1Parsed = Papa.parse(statcast1Csv, { header: true, skipEmptyLines: true, dynamicTyping: true });
  statcast1Parsed.data.forEach(row => {
    if (row.player_id) {
      statcastMap.set(String(row.player_id), row);
    }
  });
  
  const statcast2Parsed = Papa.parse(statcast2Csv, { header: true, skipEmptyLines: true, dynamicTyping: true });
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
  
  const prevLaunchAngleMap = new Map();
  const statcast2PrevParsed = Papa.parse(statcast2PrevCsv, { header: true, skipEmptyLines: true, dynamicTyping: true });
  statcast2PrevParsed.data.forEach(row => {
    const playerId = String(row.player_id);
    if (playerId) {
      prevLaunchAngleMap.set(playerId, parseFloat(row.launch_angle) || parseFloat(row.avg_hit_angle));
    }
  });
  
  const statcast3Parsed = Papa.parse(statcast3Csv, { header: true, skipEmptyLines: true, dynamicTyping: true });
  statcast3Parsed.data.forEach(row => {
    const playerId = String(row.id || row.player_id);
    if (playerId) {
      const existing = statcastMap.get(playerId) || {};
      statcastMap.set(playerId, {
        ...existing,
        avg_bat_speed: row.avg_bat_speed,
        swing_speed: row.swing_speed
      });
    }
  });
  
  const statcast4Parsed = Papa.parse(statcast4Csv, { header: true, skipEmptyLines: true, dynamicTyping: true });
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
  
  // Build players array
  const players = [];
  const currentYearSuffix = currentDataYear % 100;
  const prevYearSuffix = prevDataYear % 100;
  
  for (const row of expectedCurrentParsed.data) {
    const pa = parseInt(row.pa) || 0;
    if (pa < 100) continue;
    
    const currentWoba = parseFloat(row.woba);
    const currentXwoba = parseFloat(row.est_woba);
    
    if (!currentWoba || !currentXwoba) continue;
    
    // Get player ID, previous year data, actual results, and statcast data
    const playerId = String(row.player_id);
    const prevYearData = prevYearMap.get(playerId);
    const actualResults = actualResultsMap.get(playerId); // NEW - for validation
    const statcastData = statcastMap.get(playerId);
    const prevLaunchAngle = prevLaunchAngleMap.get(playerId);
    
    const xwobaSurplus = currentXwoba - currentWoba;
    const xwobaTrajectory = prevYearData ? currentXwoba - prevYearData.xwoba : 0;
    
    const currentLaunchAngle = statcastData && (parseFloat(statcastData.launch_angle) || parseFloat(statcastData.avg_hit_angle));
    const launchAngleDelta = (currentLaunchAngle != null && prevLaunchAngle != null) 
      ? currentLaunchAngle - prevLaunchAngle 
      : null;
    
    const pos = (row.pos || row.primary_position || 'OF').toUpperCase();
    if (pos.includes('SP') || pos.includes('RP') || pos === 'P') {
      continue;
    }
    
    const actualYearSuffix = actualResultsYear % 100; // NEW
    
    players.push({
      name: row['last_name, first_name'] || `${row.first_name || ''} ${row.last_name || ''}`.trim(),
      team: row.team_name_abbrev || row.team,
      birthDate: mlbBirthDateMap.get(playerId) || null,
      age: null, // Will be calculated dynamically in frontend
      pa: pa,
      position: row.pos || row.primary_position || 'OF',
      [`woba${currentYearSuffix}`]: currentWoba,
      [`xwoba${currentYearSuffix}`]: currentXwoba,
      [`woba${prevYearSuffix}`]: prevYearData ? prevYearData.woba : null,
      [`xwoba${prevYearSuffix}`]: prevYearData ? prevYearData.xwoba : null,
      [`woba${actualYearSuffix}`]: actualResults ? actualResults.woba : null, // NEW - for validation
      currentWoba: currentWoba,
      careerWoba: currentWoba,
      xwobaSurplus: xwobaSurplus,
      xwobaTrajectory: xwobaTrajectory,
      hardHitRate: statcastData && parseFloat(statcastData.hard_hit_percent) ? parseFloat(statcastData.hard_hit_percent) / 100 : null,
      barrelRate: statcastData && parseFloat(statcastData.barrel_batted_rate) ? parseFloat(statcastData.barrel_batted_rate) / 100 : null,
      kRate: statcastData && parseFloat(statcastData.k_percent) ? parseFloat(statcastData.k_percent) / 100 : null,
      chaseRate: statcastData && parseFloat(statcastData.o_swing_percent) ? parseFloat(statcastData.o_swing_percent) / 100 : null,
      pullRate: statcastData && parseFloat(statcastData.pull_percent) ? parseFloat(statcastData.pull_percent) / 100 : null,
      launchAngle: currentLaunchAngle,
      [`launchAngle${currentYearSuffix}`]: currentLaunchAngle,
      [`launchAngle${prevYearSuffix}`]: prevLaunchAngle,
      launchAngleDelta: launchAngleDelta,
      batSpeed: statcastData && parseFloat(statcastData.avg_bat_speed),
    });
  }
  
  console.log(`Built ${players.length} players`);
  
  return {
    success: true,
    year: targetYear,
    dataYears: [currentDataYear, prevDataYear],
    players: players,
    count: players.length,
    lastUpdated: new Date().toISOString(),
  };
}

// Main execution
async function main() {
  console.log('Starting data fetch...');
  console.log('ScraperAPI key:', SCRAPER_API_KEY ? 'Found' : 'MISSING - set SCRAPER_API_KEY env var');
  
  if (!SCRAPER_API_KEY || SCRAPER_API_KEY === 'YOUR_KEY_HERE') {
    console.error('ERROR: SCRAPER_API_KEY not set!');
    process.exit(1);
  }
  
  // Fetch 2025 and 2026 data
  const data2025 = await fetchYear(2025);
  const data2026 = await fetchYear(2026);
  
  // Save to files
  fs.writeFileSync('public/data/players-2025.json', JSON.stringify(data2025, null, 2));
  fs.writeFileSync('public/data/players-2026.json', JSON.stringify(data2026, null, 2));
  
  console.log('\n✅ Data saved!');
  console.log('  - public/data/players-2025.json');
  console.log('  - public/data/players-2026.json');
  console.log('\nYou can now commit these files to your repo.');
}

main().catch(console.error);
