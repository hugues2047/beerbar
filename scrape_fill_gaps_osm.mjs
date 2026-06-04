/**
 * scrape_fill_gaps_osm.mjs
 *
 * Trouve les bars parisiens dans OSM qui ne sont PAS dans notre DB
 * (matching par coordonnées GPS à ≤ 60m) et les insère.
 *
 * On inclut intentionnellement les brasseries artisanales, caves à bières,
 * speakeasies et autres établissements souvent absents des scraping MGB.
 *
 * Usage:
 *   node scrape_fill_gaps_osm.mjs
 *   node scrape_fill_gaps_osm.mjs --dry-run
 *   node scrape_fill_gaps_osm.mjs --min-count 5  (seulement catégories ≥ N résultats)
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync }  from 'fs';

function loadEnv() {
  try {
    const raw = readFileSync('.env.local', 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
  } catch {}
}
loadEnv();

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

const DRY_RUN = process.argv.includes('--dry-run');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Haversine ─────────────────────────────────────────────────────────────────
function distM(lat1, lon1, lat2, lon2) {
  const R = 6371000, dLat = (lat2-lat1)*Math.PI/180, dLon = (lon2-lon1)*Math.PI/180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

// ── Fetch all Paris bars/pubs/cafes from OSM ──────────────────────────────────
async function fetchOSM() {
  console.log('🌍 Fetching all Paris bars from OSM Overpass…');

  // Broad query — includes all bar-like amenities + craft breweries
  const query = `
[out:json][timeout:120];
(
  node["amenity"~"^(bar|pub|cafe|biergarten|nightclub)$"](48.79,2.20,48.97,2.47);
  way["amenity"~"^(bar|pub|cafe|biergarten|nightclub)$"](48.79,2.20,48.97,2.47);
  node["craft"="brewery"](48.79,2.20,48.97,2.47);
  node["amenity"="bar"]["brewery"](48.79,2.20,48.97,2.47);
);
out center tags;
  `.trim();

  const endpoints = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
  ];

  for (const ep of endpoints) {
    try {
      console.log(`  trying ${ep}…`);
      const r = await fetch(ep, {
        method: 'POST',
        body:   'data=' + encodeURIComponent(query),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent':   'ParisBeerMap/1.0 (speedbeer.vercel.app)',
        },
        signal: AbortSignal.timeout(150_000),
      });
      if (!r.ok) { console.warn(`  → HTTP ${r.status}`); await sleep(3000); continue; }
      const json = await r.json();
      console.log(`  ✓ ${json.elements?.length ?? 0} OSM elements`);
      return json.elements
        .filter(el => el.tags?.name && (el.lat || el.center?.lat))
        .map(el => ({
          lat:          el.lat ?? el.center.lat,
          lon:          el.lon ?? el.center.lon,
          name:         el.tags.name,
          amenity:      el.tags.amenity ?? 'bar',
          addr:         [el.tags['addr:housenumber'], el.tags['addr:street']]
                          .filter(Boolean).join(' '),
          opening_hours: el.tags.opening_hours ?? null,
        }));
    } catch (e) { console.warn(`  → ${e.message}`); await sleep(3000); }
  }
  throw new Error('All Overpass endpoints failed');
}

// ── Load our DB bars (lat/lon only for matching) ─────────────────────────────
async function loadDB() {
  console.log('📦 Loading DB bars for comparison…');
  const all = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('bars')
      .select('id, name, latitude, longitude')
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    all.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }
  console.log(`  ${all.length} bars in DB`);
  return all;
}

// ── Build a simple grid index for fast nearest-neighbor ──────────────────────
function buildGrid(bars, cellDeg = 0.01) { // ~1km cells
  const grid = new Map();
  for (const b of bars) {
    const key = `${Math.floor(b.latitude/cellDeg)},${Math.floor(b.longitude/cellDeg)}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(b);
  }
  return { grid, cellDeg };
}

function nearbyDB({ grid, cellDeg }, lat, lon, radiusM) {
  const cells = 2;
  const candidates = [];
  for (let dy = -cells; dy <= cells; dy++) {
    for (let dx = -cells; dx <= cells; dx++) {
      const key = `${Math.floor(lat/cellDeg)+dy},${Math.floor(lon/cellDeg)+dx}`;
      const c = grid.get(key);
      if (c) candidates.push(...c);
    }
  }
  return candidates.filter(b => distM(b.latitude, b.longitude, lat, lon) <= radiusM);
}

// ── Parse OSM opening_hours → close_hour ─────────────────────────────────────
function computeCloseHour(osmHours) {
  if (!osmHours) return null;
  let max = null;
  const timeRe = /(\d{2}):(\d{2})/g;
  let m;
  while ((m = timeRe.exec(osmHours)) !== null) {
    const h = parseInt(m[1]);
    const norm = h < 8 ? h + 24 : h; // 01:00 → 25, 02:00 → 26
    if (max === null || norm > max) max = norm;
  }
  return max;
}

// ── Main ──────────────────────────────────────────────────────────────────────
const osmBars = await fetchOSM();
const dbBars  = await loadDB();
const { grid, cellDeg } = buildGrid(dbBars);

console.log(`\n🔍 Comparing ${osmBars.length} OSM bars vs ${dbBars.length} DB bars…`);

const toInsert = [];

for (const osm of osmBars) {
  const nearby = nearbyDB({ grid, cellDeg }, osm.lat, osm.lon, 60);
  if (nearby.length > 0) continue; // already in DB

  // Not found → new bar
  toInsert.push({
    name:          osm.name,
    latitude:      osm.lat,
    longitude:     osm.lon,
    address:       osm.addr || '',
    beer_price:    0,
    amenity_type:  osm.amenity,
    serves_beer:   true,
    close_hour:    computeCloseHour(osm.opening_hours),
    last_updated:  new Date().toISOString(),
  });
}

console.log(`\n📍 ${toInsert.length} new bars to insert (not in DB within 60m)`);

if (toInsert.length === 0) {
  console.log('Nothing to do — DB is already comprehensive!');
  process.exit(0);
}

if (DRY_RUN) {
  console.log('\nSample of new bars:');
  toInsert.slice(0, 20).forEach(b => console.log(`  ${b.name} (${b.amenity_type}) @ ${b.latitude.toFixed(4)},${b.longitude.toFixed(4)}`));
  console.log(`  … ${Math.max(0, toInsert.length - 20)} more`);
  process.exit(0);
}

// Insert in batches of 50
let inserted = 0, errors = 0;
const BATCH = 50;

for (let i = 0; i < toInsert.length; i += BATCH) {
  const batch = toInsert.slice(i, i + BATCH);
  const { error } = await supabase.from('bars').insert(batch);
  if (error) {
    console.error(`  ✗ Batch ${i}-${i+BATCH}: ${error.message}`);
    errors++;
  } else {
    inserted += batch.length;
    process.stdout.write(`\r  ${inserted}/${toInsert.length} inserted…`);
  }
  await sleep(200);
}

console.log(`\n\n✅ Done — ${inserted} inserted, ${errors} batch errors`);
console.log('💡 Run scraper.mjs next to get prices for the new bars via MGB');
