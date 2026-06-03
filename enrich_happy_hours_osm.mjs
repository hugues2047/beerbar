/**
 * enrich_happy_hours_osm.mjs
 *
 * Récupère les happy_hours depuis OpenStreetMap (Overpass API) — GRATUIT.
 * Matche nos bars par coordonnées (≤ 80m) + similarité de nom.
 * Convertit le format OSM "Mo-Fr 17:00-20:00" → JSONB periods + texte lisible.
 *
 * Usage :
 *   node enrich_happy_hours_osm.mjs
 *   node enrich_happy_hours_osm.mjs --dry-run
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

// ── Haversine ─────────────────────────────────────────────────────────────────
function distM(lat1, lon1, lat2, lon2) {
  const R = 6371000, dLat = (lat2-lat1)*Math.PI/180, dLon = (lon2-lon1)*Math.PI/180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

// ── Name similarity ───────────────────────────────────────────────────────────
const STOPWORDS = new Set(['le','la','les','l','au','aux','du','de','des','un','une',
  'cafe','bar','bistrot','brasserie','chez','restaurant','pub']);

function norm(s) {
  return (s ?? '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function nameSim(a, b) {
  const na = norm(a), nb = norm(b);
  if (na === nb) return 1.0;
  if (na.includes(nb) || nb.includes(na)) return 0.85;
  const wa = new Set(na.split(' ').filter(w => w.length > 1 && !STOPWORDS.has(w)));
  const wb = new Set(nb.split(' ').filter(w => w.length > 1 && !STOPWORDS.has(w)));
  if (!wa.size || !wb.size) return 0.1;
  const inter = [...wa].filter(w => wb.has(w)).length;
  return inter / new Set([...wa, ...wb]).size;
}

// ── OSM happy_hours parser ────────────────────────────────────────────────────
const DAY_MAP   = { mo:1, tu:2, we:3, th:4, fr:5, sa:6, su:0 };
const DAY_NAMES = ['su','mo','tu','we','th','fr','sa'];
// French abbreviations for display
const FR_DAY = { mo:'Lu', tu:'Ma', we:'Me', th:'Je', fr:'Ve', sa:'Sa', su:'Di' };

function expandDayRange(from, to) {
  const days = [];
  let f = DAY_NAMES.indexOf(from), t = DAY_NAMES.indexOf(to);
  if (f === -1 || t === -1) return [];
  if (t < f) t += 7;
  for (let d = f; d <= t; d++) days.push(d % 7);
  return days;
}

function parseHHMM(s) {
  const [h, m] = s.split(':').map(Number);
  return { hour: h, minute: m || 0 };
}

function osmToPeriods(osmStr) {
  if (!osmStr) return null;
  if (osmStr === '24/7') return Array.from({length:7}, (_,day) => ({ open:{day,hour:0,minute:0} }));
  const periods = [];
  for (const rule of osmStr.split(';').map(s=>s.trim()).filter(Boolean)) {
    if (/^(off|closed|ph)/i.test(rule)) continue;
    const m = rule.match(/^([A-Za-z,\- ]+)\s+(\d{2}:\d{2}-\d{2}:\d{2})$/)
           || rule.match(/^(\d{2}:\d{2}-\d{2}:\d{2})$/);
    if (!m) continue;
    let dayPart, timePart;
    if (m[2]) { dayPart = m[1].trim(); timePart = m[2]; }
    else       { dayPart = 'mo-su';   timePart = m[1]; }
    const [openStr, closeStr] = timePart.split('-');
    const openT = parseHHMM(openStr), closeT = parseHHMM(closeStr);
    let days = [];
    for (const seg of dayPart.split(',').map(s=>s.trim().toLowerCase())) {
      if (seg.includes('-')) {
        const [f, t] = seg.split('-').map(s=>s.trim());
        days.push(...expandDayRange(f, t));
      } else if (DAY_MAP[seg] !== undefined) {
        days.push(DAY_MAP[seg]);
      }
    }
    if (!days.length) days = [0,1,2,3,4,5,6];
    for (const day of days) {
      const closeDay = closeT.hour < openT.hour ? (day+1)%7 : day;
      periods.push({ open:{day,...openT}, close:{day:closeDay,...closeT} });
    }
  }
  return periods.length ? periods : null;
}

/** Convert "Mo-Fr 17:00-20:00" → "Lu-Ve 17h–20h" */
function osmToDisplay(osmStr) {
  if (!osmStr) return null;
  try {
    return osmStr
      .replace(/\bMo\b/g,'Lu').replace(/\bTu\b/g,'Ma').replace(/\bWe\b/g,'Me')
      .replace(/\bTh\b/g,'Je').replace(/\bFr\b/g,'Ve').replace(/\bSa\b/g,'Sa')
      .replace(/\bSu\b/g,'Di').replace(/\bPH\b/gi,'')
      .replace(/:00/g,'h').replace(/-(?=\d)/g,'–')
      .replace(/;/g,' · ').replace(/\s+/g,' ').trim();
  } catch { return osmStr; }
}

// ── Fetch OSM bars with happy_hours tag ───────────────────────────────────────
async function fetchOSMHappyHours() {
  console.log('🍺 Fetching Paris bars with happy_hours tag from Overpass…');
  const query = `
[out:json][timeout:90];
(
  node["amenity"~"^(bar|pub|cafe|biergarten|nightclub)$"]["happy_hours"](48.80,2.20,48.96,2.47);
  way["amenity"~"^(bar|pub|cafe|biergarten|nightclub)$"]["happy_hours"](48.80,2.20,48.96,2.47);
);
out center tags;
  `.trim();

  const endpoints = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.openstreetmap.ru/api/interpreter',
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
        signal: AbortSignal.timeout(120_000),
      });
      if (!r.ok) { console.warn(`  → HTTP ${r.status}, trying next…`); await sleep(3000); continue; }
      const json = await r.json();
      console.log(`  ✓ ${json.elements?.length ?? 0} elements from ${ep}`);
      return json.elements
        .filter(el => el.tags?.happy_hours && (el.lat || el.center?.lat))
        .map(el => ({
          lat:          el.lat ?? el.center.lat,
          lon:          el.lon ?? el.center.lon,
          name:         el.tags.name ?? '',
          happy_hours:  el.tags.happy_hours,
          beer_price:   el.tags['happy_hour:beer'] ? parseFloat(el.tags['happy_hour:beer']) : null,
        }));
    } catch (e) { console.warn(`  → ${e.message}`); await sleep(3000); }
  }
  throw new Error('All Overpass endpoints failed');
}

// ── Load our bars from DB ─────────────────────────────────────────────────────
async function loadBars() {
  console.log('📦 Loading bars from DB…');
  const all = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('bars')
      .select('id,name,latitude,longitude,happy_hour_periods')
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    all.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }
  console.log(`  ${all.length} bars loaded`);
  return all;
}

// ── Main ──────────────────────────────────────────────────────────────────────
const osmBars = await fetchOSMHappyHours();
console.log(`\n🗺  ${osmBars.length} OSM bars have happy_hours tag`);

if (!osmBars.length) {
  console.log('Nothing to do.');
  process.exit(0);
}

const dbBars = await loadBars();

let matched = 0, updated = 0, skipped = 0;

for (const osm of osmBars) {
  // Find candidates within 80m
  const nearby = dbBars.filter(b => distM(b.latitude, b.longitude, osm.lat, osm.lon) <= 80);
  if (!nearby.length) { skipped++; continue; }

  // Best match by name similarity
  const best = nearby
    .map(b => ({ b, sim: nameSim(b.name, osm.name), dist: distM(b.latitude, b.longitude, osm.lat, osm.lon) }))
    .sort((a, b) => b.sim - a.sim || a.dist - b.dist)[0];

  if (best.sim < 0.25 && nearby.length > 1) { skipped++; continue; } // ambiguous

  matched++;
  const db = best.b;

  // Skip if we already have HH periods from a better source
  if (db.happy_hour_periods) { skipped++; continue; }

  const periods  = osmToPeriods(osm.happy_hours);
  const display  = osmToDisplay(osm.happy_hours);

  if (!periods) { skipped++; continue; }

  const update = {
    happy_hour_periods:   periods,
    happy_hour_times:     display,
    happy_hour_source:    'osm',
    happy_hour_updated_at: new Date().toISOString(),
    ...(osm.beer_price && osm.beer_price > 1 && osm.beer_price < 15 ? { happy_hour_price: osm.beer_price } : {}),
  };

  if (DRY_RUN) {
    console.log(`  [DRY] ${db.name} → HH: ${display}`);
    updated++;
    continue;
  }

  const { error } = await supabase
    .from('bars')
    .update(update)
    .eq('id', db.id);

  if (error) { console.warn(`  ✗ ${db.name}: ${error.message}`); }
  else {
    console.log(`  ✓ ${db.name} → ${display}`);
    updated++;
  }

  await sleep(20); // be kind to Supabase
}

console.log(`\n✅ Done — matched ${matched}, updated ${updated}, skipped ${skipped}`);
