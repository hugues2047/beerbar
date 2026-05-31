/**
 * fetch_hours_google.mjs
 *
 * Fetches opening hours for bars that already have a beer price but no hours yet.
 * Adds regularOpeningHours to every bar that has a google_place_id.
 *
 * API : GET https://places.googleapis.com/v1/places/{place_id}
 *       FieldMask : regularOpeningHours,displayName
 * Cost: $0.017/call (Advanced SKU — regularOpeningHours is Advanced tier)
 * Hard stop: $15 default (~882 bars)
 *
 * Usage:
 *   node fetch_hours_google.mjs --limit 500 --budget 10
 *   node fetch_hours_google.mjs --limit 1000 --budget 17
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';

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

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const GMAPS_KEY    = process.env.GOOGLE_MAPS_API_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY || !GMAPS_KEY) { console.error('Missing env vars'); process.exit(1); }

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const CENTER_LAT = 48.876;
const CENTER_LON = 2.359;

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371, dLat = (lat2 - lat1) * Math.PI / 180, dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

// Parse args
const args = process.argv.slice(2);
let LIMIT     = 500;
let OFFSET    = 0;
let HARD_STOP = 15.00;
const COST    = 0.017;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--limit')  LIMIT     = parseInt(args[++i]);
  if (args[i] === '--offset') OFFSET    = parseInt(args[++i]);
  if (args[i] === '--budget') HARD_STOP = parseFloat(args[++i]);
}

let spent = 0;
function charge() {
  spent += COST;
  if (spent >= HARD_STOP) {
    console.error(`\n🛑 HARD STOP $${spent.toFixed(3)} ≥ $${HARD_STOP}`);
    process.exit(1);
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Compute max closing hour in 24+ notation.
 * 26 = 2 am, 29 = 5 am.
 */
function computeCloseHour(periods) {
  if (!periods?.length) return null;
  let max = null;
  for (const p of periods) {
    if (!p.close) continue;
    const h = p.close.hour < 8 ? p.close.hour + 24 : p.close.hour;
    if (max === null || h > max) max = h;
  }
  return max;
}

async function fetchHours(placeId) {
  const url = `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      headers: {
        'X-Goog-Api-Key':   GMAPS_KEY,
        'X-Goog-FieldMask': 'regularOpeningHours,displayName',
      },
    });
    if (r.status === 429) {
      const wait = 2000 + attempt * 2000;
      process.stdout.write(`⏳ 429 (retry ${attempt + 1}/3 in ${wait}ms) `);
      await sleep(wait);
      continue;
    }
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new Error(`HTTP ${r.status}: ${body.slice(0, 100)}`);
    }
    return r.json();
  }
  throw new Error('429 after 3 retries');
}

console.log('═══════════════════════════════════════════════════════════');
console.log('  Fetch opening hours via Google Places API v1');
console.log(`  Limite: ${LIMIT} | Offset: ${OFFSET} | Budget: $${HARD_STOP}`);
console.log(`  ~${Math.floor(HARD_STOP / COST)} bars max`);
console.log('═══════════════════════════════════════════════════════════\n');

// Fetch bars with place_id but no hours yet, sorted closest-first
const all = [];
let from = 0;
while (true) {
  const { data, error } = await supabase.from('bars')
    .select('id, name, google_place_id, latitude, longitude')
    .not('google_place_id', 'is', null)
    .is('opening_hours', null)          // only bars without hours yet
    .range(from, from + 999);
  if (error) { console.error(error.message); break; }
  if (!data.length) break;
  all.push(...data);
  if (data.length < 1000) break;
  from += 1000;
}

all.sort((a, b) =>
  haversineKm(CENTER_LAT, CENTER_LON, a.latitude ?? CENTER_LAT, a.longitude ?? CENTER_LON) -
  haversineKm(CENTER_LAT, CENTER_LON, b.latitude ?? CENTER_LAT, b.longitude ?? CENTER_LON)
);

const batch = all.slice(OFFSET, OFFSET + LIMIT);
console.log(`📥 ${all.length} bars sans horaires | traitement ${OFFSET + 1}–${OFFSET + batch.length}\n`);

let saved = 0, noHours = 0, errors = 0;

for (let i = 0; i < batch.length; i++) {
  const bar = batch[i];
  const pad = bar.name.padEnd(38).slice(0, 38);
  process.stdout.write(`[${String(OFFSET + i + 1).padStart(4)}] ${pad} … `);

  let data;
  try {
    data = await fetchHours(bar.google_place_id);
    charge();
  } catch (e) {
    process.stdout.write(`⚠️  ${e.message}\n`);
    errors++;
    await sleep(500);
    continue;
  }

  const periods   = data.regularOpeningHours?.periods ?? null;
  const closeHour = computeCloseHour(periods);

  if (!periods) {
    process.stdout.write('— pas d\'horaires\n');
    noHours++;
    await sleep(150);
    continue;
  }

  const { error } = await supabase.from('bars').update({
    opening_hours: periods,
    close_hour:    closeHour,
  }).eq('id', bar.id);

  if (error) {
    process.stdout.write(`❌ ${error.message}\n`);
    errors++;
  } else {
    const lateTag = closeHour !== null && closeHour >= 26
      ? ` 🌙${closeHour - 24}h+`
      : '';
    process.stdout.write(`✅ ${periods.length} périodes${lateTag}\n`);
    saved++;
  }
  await sleep(150);
}

console.log('\n═══════════════════════════════════════════════════════════');
console.log(`  ✅ ${saved} bars avec horaires`);
console.log(`  — ${noHours} sans données`);
console.log(`  ⚠️  ${errors} erreurs`);
console.log(`  💸 Coût : $${spent.toFixed(3)} / budget $${HARD_STOP}`);
console.log('═══════════════════════════════════════════════════════════\n');
