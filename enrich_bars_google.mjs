/**
 * enrich_bars_google.mjs
 *
 * Script tout-en-un : UN seul appel Google par bar, on extrait tout.
 *
 * Par appel ($0.017) on récupère :
 *   🍺  Prix bière   (priceRange > priceLevel > reviews)
 *   ⏰  Horaires     (regularOpeningHours → opening_hours + close_hour)
 *   🌿  Terrasse     (outdoorSeating → has_terrace)
 *
 * Priorité : bars sans horaires d'abord (plus grand gap), triés par distance
 * au centre de Paris. Budget hard-stop configurable (défaut $50).
 *
 * Usage :
 *   node enrich_bars_google.mjs                        # 2941 bars, $50
 *   node enrich_bars_google.mjs --budget 10 --limit 500
 *   node enrich_bars_google.mjs --offset 2941 --budget 50  # batch suivant
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync }  from 'fs';

// ── Env ───────────────────────────────────────────────────────────────────────
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
if (!SUPABASE_URL || !SUPABASE_KEY || !GMAPS_KEY) {
  console.error('Missing env vars'); process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Args ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let LIMIT     = 99999;   // no limit by default — budget is the stopper
let OFFSET    = 0;
let HARD_STOP = 50.00;
const COST    = 0.017;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--limit')  LIMIT     = parseInt(args[++i]);
  if (args[i] === '--offset') OFFSET    = parseInt(args[++i]);
  if (args[i] === '--budget') HARD_STOP = parseFloat(args[++i]);
}

const MAX_BARS = Math.min(LIMIT, Math.floor(HARD_STOP / COST));

// ── Helpers ───────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2
          + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.asin(Math.sqrt(a));
}
const CENTER_LAT = 48.876, CENTER_LON = 2.359;

// ── Price helpers (same logic as verify_prices_google.mjs) ───────────────────
const PRICE_LEVEL_MAP = {
  PRICE_LEVEL_FREE:           2.50,
  PRICE_LEVEL_INEXPENSIVE:    4.00,
  PRICE_LEVEL_MODERATE:       5.50,
  PRICE_LEVEL_EXPENSIVE:      8.00,
  PRICE_LEVEL_VERY_EXPENSIVE: 12.00,
};
const BEER_MIN = 2.50, BEER_MAX = 9.00;
const BEER_RE  = /\b(bi[eè]re|pinte|demi|blonde|pression|brune|rousse|beer|draft|pint|lager|cerveza|mousse|bock|kronenbourg|leffe|heineken|stella|1664|hoegaarden|grimbergen|desperados|carlsberg|budweiser|corona|affligem|ipa|pale\s*ale)\b/i;

function parseMoney(obj) {
  if (!obj) return null;
  const v = parseInt(obj.units ?? 0) + parseInt(obj.nanos ?? 0) / 1e9;
  return v > 0 ? v : null;
}

function extractPrices(text) {
  const out = [];
  const pats = [
    /(\d+)[,.](\d{1,2})\s*€/g, /(\d+)\s*€/g,
    /€\s*(\d+)[,.](\d{1,2})/g, /€\s*(\d+)/g,
    /(\d+)[,.](\d{1,2})\s*euros?/gi, /(\d+)\s*euros?/gi,
  ];
  for (const re of pats) {
    let m;
    while ((m = re.exec(text)) !== null) {
      const price = parseFloat((m[1] ?? m[0].replace(/\D/g,'')) + '.' + (m[2] ?? '00').padEnd(2,'0'));
      if (!isNaN(price)) out.push({ price, idx: m.index });
    }
  }
  return out;
}

function parseReviewsForPrice(reviews) {
  if (!reviews?.length) return null;
  const candidates = [];
  for (const rev of reviews) {
    const text = (rev.text?.text || rev.originalText?.text || '').toLowerCase();
    for (const { price, idx } of extractPrices(text)) {
      if (price < BEER_MIN || price > BEER_MAX) continue;
      const ctx = text.slice(Math.max(0, idx-60), idx+70);
      candidates.push({ price, weight: BEER_RE.test(ctx) ? 2 : 1 });
    }
  }
  if (!candidates.length) return null;
  const pool = candidates.filter(c => c.weight===2).length ? candidates.filter(c=>c.weight===2) : candidates;
  const vals = pool.map(c=>c.price).sort((a,b)=>a-b);
  const med  = vals[Math.floor(vals.length/2)];
  const r    = Math.round(med*2)/2;
  return r >= BEER_MIN && r <= BEER_MAX ? r : null;
}

function parsePrice(d) {
  const pr = d.priceRange, pl = d.priceLevel;
  if (pr) {
    const lo = parseMoney(pr.startPrice), hi = parseMoney(pr.endPrice);
    if (lo !== null) {
      if (lo >= BEER_MIN && lo <= BEER_MAX)
        return { price: Math.round(lo*100)/100, method: 'priceRange', label: `€${lo}–€${hi??lo}` };
      if (pl && PRICE_LEVEL_MAP[pl])
        return { price: PRICE_LEVEL_MAP[pl], method: 'priceLevel_fallback', label: pl };
    }
  }
  if (pl && PRICE_LEVEL_MAP[pl])
    return { price: PRICE_LEVEL_MAP[pl], method: 'priceLevel', label: pl };
  const rp = parseReviewsForPrice(d.reviews);
  if (rp !== null) return { price: rp, method: 'review_text', label: `${(d.reviews||[]).length} reviews` };
  return null;
}

// ── Hours helper ──────────────────────────────────────────────────────────────
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

// ── API fetch ─────────────────────────────────────────────────────────────────
let spent = 0;
function charge() {
  spent += COST;
  if (spent >= HARD_STOP) {
    console.error(`\n🛑 HARD STOP $${spent.toFixed(3)} ≥ $${HARD_STOP}`);
    process.exit(1);
  }
}

async function fetchBar(placeId) {
  const url = `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      headers: {
        'X-Goog-Api-Key':   GMAPS_KEY,
        'X-Goog-FieldMask': 'priceRange,priceLevel,reviews,regularOpeningHours,outdoorSeating,displayName',
      },
    });
    if (r.status === 429) {
      const wait = 2000 + attempt * 2000;
      process.stdout.write(`⏳ 429 (retry ${attempt+1}/3 in ${wait}ms) `);
      await sleep(wait); continue;
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text().catch(()=>'')).slice(0,100)}`);
    return r.json();
  }
  throw new Error('429 after 3 retries');
}

// ── Load bars ─────────────────────────────────────────────────────────────────
console.log('═══════════════════════════════════════════════════════════');
console.log('  enrich_bars_google — prix + horaires + terrasse');
console.log(`  Budget: $${HARD_STOP} | Max calls: ${MAX_BARS} | Offset: ${OFFSET}`);
console.log('═══════════════════════════════════════════════════════════\n');

// Priority 1 — bars missing hours (biggest gap, 5 332 bars)
// Priority 2 — bars with hours but missing terrace (will get filled naturally later)
// We fetch in one pass, sorted by distance, skipping bars already fully enriched.
const all = [];
let from = 0;
while (true) {
  const { data, error } = await supabase
    .from('bars')
    .select('id, name, google_place_id, beer_price, price_source, has_terrace, opening_hours, latitude, longitude')
    .not('google_place_id', 'is', null)
    .range(from, from + 999);
  if (error) { console.error(error.message); break; }
  if (!data?.length) break;
  all.push(...data);
  if (data.length < 1000) break;
  from += 1000;
}

// Sort: bars missing hours first, then by distance (closest = most valuable)
all.sort((a, b) => {
  const aMissingHours = a.opening_hours === null ? 0 : 1;
  const bMissingHours = b.opening_hours === null ? 0 : 1;
  if (aMissingHours !== bMissingHours) return aMissingHours - bMissingHours;
  return haversineKm(CENTER_LAT, CENTER_LON, a.latitude??CENTER_LAT, a.longitude??CENTER_LON)
       - haversineKm(CENTER_LAT, CENTER_LON, b.latitude??CENTER_LAT, b.longitude??CENTER_LON);
});

const batch = all.slice(OFFSET, OFFSET + MAX_BARS);
const needHours   = batch.filter(b => !b.opening_hours).length;
const needPrice   = batch.filter(b => b.beer_price === 0).length;
const needTerrace = batch.filter(b => b.has_terrace === null).length;

console.log(`📥 ${all.length} bars avec place_id | traitement ${OFFSET+1}–${OFFSET+batch.length}`);
console.log(`   dont: ${needHours} sans horaires | ${needPrice} sans prix | ${needTerrace} sans terrasse\n`);

let savedHours = 0, savedPrice = 0, savedTerrace = 0, noData = 0, errors = 0;

for (let i = 0; i < batch.length; i++) {
  const bar = batch[i];
  const idx  = OFFSET + i + 1;
  const pad  = bar.name.padEnd(36).slice(0, 36);
  process.stdout.write(`[${String(idx).padStart(4)}] ${pad} … `);

  let d;
  try {
    d = await fetchBar(bar.google_place_id);
    charge();
  } catch (e) {
    process.stdout.write(`⚠️  ${e.message}\n`);
    errors++;
    await sleep(500);
    continue;
  }

  // ── What did we get? ───────────────────────────────────────────────────────
  const parsed    = parsePrice(d);
  const periods   = d.regularOpeningHours?.periods ?? null;
  const closeHour = computeCloseHour(periods);
  const terrace   = d.outdoorSeating ?? null;   // true | false | null

  // ── Build update payload ───────────────────────────────────────────────────
  const update = {};

  // Price: only write if bar has no price yet
  if (parsed && bar.beer_price === 0) {
    update.beer_price   = parsed.price;
    update.price_source = 'google';
    savedPrice++;
  }

  // Hours: write if we got something (overwrite stale data too)
  if (periods !== null) {
    update.opening_hours = periods;
    update.close_hour    = closeHour;
    if (!bar.opening_hours) savedHours++;
  }

  // Terrace: write only non-null values (null = Google doesn't know)
  if (terrace !== null) {
    update.has_terrace = terrace;
    if (bar.has_terrace === null) savedTerrace++;
  }

  if (Object.keys(update).length === 0) {
    process.stdout.write('— aucune donnée\n');
    noData++;
    await sleep(150);
    continue;
  }

  const { error } = await supabase.from('bars').update(update).eq('id', bar.id);
  if (error) {
    process.stdout.write(`❌ ${error.message}\n`);
    errors++;
  } else {
    const tags = [
      parsed && bar.beer_price === 0 ? `🍺€${parsed.price.toFixed(2)}[${parsed.method}]` : null,
      periods !== null
        ? (closeHour !== null && closeHour >= 26 ? `⏰🌙${closeHour-24}h+` : `⏰ok`)
        : null,
      terrace === true  ? '🌿oui' :
      terrace === false ? '🌿non' : null,
    ].filter(Boolean).join(' ');
    process.stdout.write(`✅ ${tags}\n`);
  }
  await sleep(150);
}

console.log('\n═══════════════════════════════════════════════════════════');
console.log(`  ⏰ ${savedHours} nouveaux horaires`);
console.log(`  🍺 ${savedPrice} nouveaux prix`);
console.log(`  🌿 ${savedTerrace} nouvelles données terrasse`);
console.log(`  — ${noData} sans données`);
console.log(`  ⚠️  ${errors} erreurs`);
console.log(`  💸 Coût : $${spent.toFixed(3)} / budget $${HARD_STOP}`);
console.log('═══════════════════════════════════════════════════════════\n');
