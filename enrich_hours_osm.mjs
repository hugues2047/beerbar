/**
 * enrich_hours_osm.mjs
 *
 * Récupère les horaires depuis OpenStreetMap (Overpass API) — GRATUIT.
 * Matche nos bars sans horaires par coordonnées (≤ 60m) + similarité de nom.
 * Convertit le format OSM "Mo-Sa 12:00-02:00" vers notre schema JSONB.
 *
 * Usage :
 *   node enrich_hours_osm.mjs
 *   node enrich_hours_osm.mjs --dry-run   (affiche sans écrire en DB)
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
const sleep   = ms => new Promise(r => setTimeout(r, ms));

// ── Haversine distance in meters ──────────────────────────────────────────────
function distM(lat1, lon1, lat2, lon2) {
  const R = 6371000, dLat = (lat2-lat1)*Math.PI/180, dLon = (lon2-lon1)*Math.PI/180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

// ── Normalize name for fuzzy match ───────────────────────────────────────────
// French stopwords that inflate Jaccard when shared across different venues
const STOPWORDS = new Set(['le','la','les','l','au','aux','du','de','des',
  'un','une','cafe','bar','bistrot','brasserie','chez','restaurant','pub']);

function norm(s) {
  return (s ?? '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // remove accents
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function nameSimilarity(a, b) {
  const na = norm(a), nb = norm(b);
  if (na === nb) return 1.0;
  if (na.includes(nb) || nb.includes(na)) return 0.85;
  // Jaccard on meaningful words (exclude stopwords)
  const wa = new Set(na.split(' ').filter(w => w.length > 1 && !STOPWORDS.has(w)));
  const wb = new Set(nb.split(' ').filter(w => w.length > 1 && !STOPWORDS.has(w)));
  if (!wa.size || !wb.size) return 0.1; // only stopwords → very low score
  const inter = [...wa].filter(w => wb.has(w)).length;
  const union = new Set([...wa, ...wb]).size;
  return inter / union;
}

// ── Parse OSM opening_hours string → our JSONB periods format ───────────────
// OSM format: "Mo-Sa 12:00-02:00" or "Mo-Fr 08:00-22:00; Sa-Su 10:00-01:00"
// Returns { periods: [{open:{day,hour,minute}, close:{day,hour,minute}}], closeHour }

const DAY_MAP = { mo:1, tu:2, we:3, th:4, fr:5, sa:6, su:0 };
const DAY_NAMES = ['su','mo','tu','we','th','fr','sa'];

function expandDayRange(from, to) {
  // e.g. mo→fr = [1,2,3,4,5]
  const days = [];
  let f = DAY_NAMES.indexOf(from), t = DAY_NAMES.indexOf(to);
  if (f === -1 || t === -1) return [];
  // wrap-around (e.g. fr-mo)
  if (t < f) t += 7;
  for (let d = f; d <= t; d++) days.push(d % 7);
  return days;
}

function parseTimeHHMM(s) {
  const [h, m] = s.split(':').map(Number);
  return { hour: h, minute: m || 0 };
}

function osmToGooglePeriods(osmStr) {
  if (!osmStr || osmStr === '24/7') {
    // 24/7 — one period, no close
    return Array.from({length:7}, (_,day) => ({ open: {day, hour:0, minute:0} }));
  }

  const periods = [];

  // Split on ";" — multiple rules
  for (const rule of osmStr.split(';').map(s=>s.trim()).filter(Boolean)) {
    // Handle "PH off", "closed", etc.
    if (/^(off|closed|ph)/i.test(rule)) continue;

    // Extract day spec and time spec
    // Examples: "Mo-Fr 12:00-22:00", "Sa,Su 14:00-02:00", "Mo 08:00-20:00", "12:00-22:00"
    const m = rule.match(/^([A-Za-z,\- ]+)\s+(\d{2}:\d{2}-\d{2}:\d{2})$/)
           || rule.match(/^(\d{2}:\d{2}-\d{2}:\d{2})$/);
    if (!m) continue;

    let dayPart, timePart;
    if (m[2]) { dayPart = m[1].trim(); timePart = m[2]; }
    else       { dayPart = 'mo-su';   timePart = m[1]; } // no day = all week

    const [openStr, closeStr] = timePart.split('-');
    const openT  = parseTimeHHMM(openStr);
    const closeT = parseTimeHHMM(closeStr);

    // Figure out which days
    let days = [];
    for (const seg of dayPart.split(',').map(s=>s.trim().toLowerCase())) {
      if (seg.includes('-')) {
        const [f, t] = seg.split('-').map(s=>s.trim());
        days.push(...expandDayRange(f, t));
      } else if (DAY_MAP[seg] !== undefined) {
        days.push(DAY_MAP[seg]);
      }
    }
    if (!days.length) days = [0,1,2,3,4,5,6]; // fallback

    for (const day of days) {
      // For the close time: if close hour < open hour → it's the next day
      const closeDay = closeT.hour < openT.hour ? (day + 1) % 7 : day;
      periods.push({
        open:  { day, ...openT },
        close: { day: closeDay, ...closeT },
      });
    }
  }
  return periods.length ? periods : null;
}

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

// ── Fetch all Paris bars from OSM Overpass ───────────────────────────────────
async function fetchOSMBars() {
  console.log('🌍 Fetching Paris bars from OpenStreetMap Overpass API…');
  const query = `
[out:json][timeout:60];
(
  node["amenity"~"^(bar|pub|cafe|biergarten)$"]["opening_hours"](48.8,2.2,48.95,2.45);
  way["amenity"~"^(bar|pub|cafe|biergarten)$"]["opening_hours"](48.8,2.2,48.95,2.45);
);
out center tags;
  `.trim();

  const endpoints = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
  ];
  let json;
  for (const ep of endpoints) {
    try {
      const r = await fetch(ep, {
        method:  'POST',
        body:    'data=' + encodeURIComponent(query),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent':   'ParisBeerMap/1.0 (speedbeer.vercel.app)',
        },
        signal: AbortSignal.timeout(90000),
      });
      if (!r.ok) { console.warn(`  ${ep} → ${r.status}, trying next…`); await sleep(2000); continue; }
      json = await r.json();
      console.log(`  (via ${ep})`);
      break;
    } catch (e) { console.warn(`  ${ep} → ${e.message}`); await sleep(2000); }
  }
  if (!json) throw new Error('All Overpass endpoints failed');

  return json.elements.map(el => ({
    osm_id: el.id,
    type:   el.type,
    lat:    el.lat ?? el.center?.lat,
    lon:    el.lon ?? el.center?.lon,
    name:   el.tags?.name ?? '',
    hours:  el.tags?.opening_hours ?? null,
    terrace: el.tags?.outdoor_seating === 'yes' ? true
           : el.tags?.outdoor_seating === 'no'  ? false : null,
  })).filter(e => e.lat && e.lon && e.hours);
}

// ── Main ──────────────────────────────────────────────────────────────────────
console.log('═══════════════════════════════════════════════════════════');
console.log('  enrich_hours_osm — horaires OpenStreetMap (GRATUIT)');
console.log(DRY_RUN ? '  MODE: DRY RUN — aucune écriture en DB' : '  MODE: LIVE');
console.log('═══════════════════════════════════════════════════════════\n');

// Load OSM data
let osmBars;
try {
  osmBars = await fetchOSMBars();
} catch (e) {
  console.error('Overpass error:', e.message);
  process.exit(1);
}
console.log(`✅ ${osmBars.length} bars OSM avec horaires récupérés\n`);

// Load our bars missing hours
const ourBars = [];
let from = 0;
while (true) {
  const { data, error } = await supabase
    .from('bars')
    .select('id, name, latitude, longitude, has_terrace, opening_hours')
    .is('opening_hours', null)
    .range(from, from + 999);
  if (error || !data?.length) break;
  ourBars.push(...data);
  if (data.length < 1000) break;
  from += 1000;
}
console.log(`📥 ${ourBars.length} de nos bars sans horaires\n`);

// Match each of our bars to closest OSM bar within 60m with similar name
let matched = 0, savedHours = 0, savedTerrace = 0, noMatch = 0;

for (const bar of ourBars) {
  // Find OSM candidates within 60m max
  const candidates = osmBars
    .map(o => ({ ...o, dist: distM(bar.latitude, bar.longitude, o.lat, o.lon) }))
    .filter(o => o.dist <= 60)
    .sort((a, b) => a.dist - b.dist);

  if (!candidates.length) { noMatch++; continue; }

  // Pick best by name similarity, with distance as tiebreak
  const best = candidates
    .map(c => ({ ...c, sim: nameSimilarity(bar.name, c.name) }))
    .sort((a, b) => (b.sim - a.sim) || (a.dist - b.dist))[0];

  // Tiered rejection:
  //   > 40m → need good name match (sim ≥ 0.5)
  //   ≤ 40m → tolerate more difference (sim ≥ 0.15, likely same address)
  //   ≤ 15m → almost certainly same place, accept any name
  const minSim = best.dist > 40 ? 0.50 : best.dist > 15 ? 0.15 : 0.0;
  if (best.sim < minSim) { noMatch++; continue; }

  matched++;
  const periods   = osmToGooglePeriods(best.hours);
  const closeHour = computeCloseHour(periods);

  const lateTag = closeHour !== null && closeHour >= 26 ? ` 🌙${closeHour-24}h+` : '';
  const nameTag = best.sim < 0.6 ? ` ⚠️ "${best.name}"` : '';
  console.log(`  ✅ ${bar.name.padEnd(36).slice(0,36)} ← ${best.dist.toFixed(0)}m${lateTag}${nameTag}`);

  if (!DRY_RUN && periods) {
    const update = { opening_hours: periods, close_hour: closeHour };
    // Also grab terrace from OSM if we don't have it
    if (bar.has_terrace === null && best.terrace !== null) {
      update.has_terrace = best.terrace;
      savedTerrace++;
    }
    const { error } = await supabase.from('bars').update(update).eq('id', bar.id);
    if (error) console.error(`  ❌ ${error.message}`);
    else savedHours++;
  }
  await sleep(10);
}

console.log('\n═══════════════════════════════════════════════════════════');
console.log(`  🔍 ${matched} matchés / ${ourBars.length} bars`);
if (!DRY_RUN) {
  console.log(`  ⏰ ${savedHours} horaires enregistrés`);
  console.log(`  🌿 ${savedTerrace} terrasses OSM`);
}
console.log(`  ❌ ${noMatch} sans match OSM`);
console.log('═══════════════════════════════════════════════════════════\n');
