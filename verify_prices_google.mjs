/**
 * verify_prices_google.mjs
 *
 * Utilise Google Places API v1 pour obtenir les prix des bars :
 *   --mode fill    : remplit les bars sans prix (beer_price = 0)
 *   --mode verify  : vérifie/corrige les prix MGB existants
 *   --mode all     : les deux passes
 *
 * API : GET https://places.googleapis.com/v1/places/{place_id}
 *       FieldMask : priceRange,priceLevel,displayName,reviews
 * Coût : $0.017/call (Basic SKU) — seules les réponses réussies sont comptées
 * Hard stop : $20 par défaut (configurable avec --budget N)
 *
 * Logique prix (par ordre de priorité) :
 *   1. priceRange.startPrice ∈ [2.50, 9.00] → prix réel exact         [priceRange]
 *   2. priceRange hors borne + priceLevel   → estimation catégorielle  [priceLevel_fallback]
 *   3. priceLevel seul                      → estimation catégorielle  [priceLevel]
 *      INEXPENSIVE→€4, MODERATE→€5.50, EXPENSIVE→€8, VERY_EXPENSIVE→€12
 *   4. reviews text mining                  → médiane des prix bière   [review_text]
 *      Cherche: "bière à 5€", "pinte 5,50€", "5 euros la bière", etc.
 *
 * Vérification MGB (--mode verify) :
 *   Met à jour si |Google - MGB| > €1.50 OU >35%
 *   Recommandé uniquement quand priceRange est disponible (pas priceLevel seul)
 *
 * Usage :
 *   node verify_prices_google.mjs --mode fill --limit 600 --budget 10
 *   node verify_prices_google.mjs --mode verify --limit 300 --budget 8
 *   node verify_prices_google.mjs --mode all --budget 15
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
let MODE   = 'fill';   // fill | verify | all
let LIMIT  = 500;
let OFFSET = 0;
let HARD_STOP = 20.00;
let COST_PER_CALL = 0.017; // conservative estimate — will adjust from first response if needed

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--mode')   MODE   = args[++i];
  if (args[i] === '--limit')  LIMIT  = parseInt(args[++i]);
  if (args[i] === '--offset') OFFSET = parseInt(args[++i]);
  if (args[i] === '--budget') HARD_STOP = parseFloat(args[++i]);
}

let spent = 0;
function charge(label) {
  spent += COST_PER_CALL;
  if (spent >= HARD_STOP) {
    console.error(`\n🛑 HARD STOP $${spent.toFixed(3)} ≥ $${HARD_STOP} (${label})`);
    process.exit(1);
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// priceLevel → approximate beer price in Paris (€)
const PRICE_LEVEL_MAP = {
  'PRICE_LEVEL_FREE':          2.50,
  'PRICE_LEVEL_INEXPENSIVE':   4.00,
  'PRICE_LEVEL_MODERATE':      5.50,
  'PRICE_LEVEL_EXPENSIVE':     8.00,
  'PRICE_LEVEL_VERY_EXPENSIVE': 12.00,
};

function parseMoney(moneyObj) {
  if (!moneyObj) return null;
  const units = parseInt(moneyObj.units ?? 0);
  const nanos = parseInt(moneyObj.nanos ?? 0) / 1e9;
  const v = units + nanos;
  return v > 0 ? v : null;
}

// Beer price bounds in Paris:
//   min: cheapest pression (bière) in the city
//   max: above this = cocktail/meal price → fall back to priceLevel
const BEER_PRICE_MIN = 2.50;
const BEER_PRICE_MAX = 9.00;

// Extract all numeric prices from a text string
function extractPrices(text) {
  const prices = [];
  const patterns = [
    /(\d+)[,.](\d{1,2})\s*€/g,       // "5,50€" or "5.50€"
    /(\d+)\s*€/g,                      // "5€"
    /€\s*(\d+)[,.](\d{1,2})/g,        // "€5,50"
    /€\s*(\d+)/g,                      // "€5"
    /(\d+)[,.](\d{1,2})\s*euros?/gi,  // "5,50 euros"
    /(\d+)\s*euros?/gi,               // "5 euros"
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) {
      const intPart  = m[1] ?? m[0].replace(/[^0-9]/g, '');
      const decPart  = m[2] ?? '00';
      const price    = parseFloat(intPart + '.' + decPart.padEnd(2, '0'));
      if (!isNaN(price)) prices.push({ price, idx: m.index });
    }
  }
  return prices;
}

// Parse Google reviews array for beer price mentions.
// Returns a price (rounded to nearest 0.50€) or null.
function parseReviewsForPrice(reviews) {
  if (!reviews || !reviews.length) return null;

  const BEER_RE = /\b(bi[eè]re|pinte|demi|blonde|pression|brune|rousse|beer|draft|pint|lager|cerveza|mousse|bock|kronenbourg|leffe|heineken|stella|1664|hoegaarden|grimbergen|desperados|carlsberg|budweiser|corona|affligem|ipa|pale\s*ale)\b/i;

  const candidates = [];

  for (const review of reviews) {
    const text = review.text?.text || review.originalText?.text || '';
    if (!text) continue;
    const textLower = text.toLowerCase();
    const pricesInText = extractPrices(textLower);

    for (const { price, idx } of pricesInText) {
      if (price < BEER_PRICE_MIN || price > BEER_PRICE_MAX) continue;
      // Check for beer keyword within ±60 chars of the price mention
      const start   = Math.max(0, idx - 60);
      const end     = Math.min(textLower.length, idx + 10 + 60);
      const context = textLower.slice(start, end);
      const hasBeer = BEER_RE.test(context);
      candidates.push({ price, weight: hasBeer ? 2 : 1 });
    }
  }

  if (!candidates.length) return null;

  // Prefer high-confidence (beer keyword nearby) prices
  const highConf = candidates.filter(c => c.weight === 2);
  const pool     = highConf.length > 0 ? highConf : candidates;

  // Take median
  const vals   = pool.map(c => c.price).sort((a, b) => a - b);
  const median = vals[Math.floor(vals.length / 2)];

  // Round to nearest €0.50 for consistency with priceLevel values
  const rounded = Math.round(median * 2) / 2;
  return (rounded >= BEER_PRICE_MIN && rounded <= BEER_PRICE_MAX) ? rounded : null;
}

function parsePrice(placeData) {
  const pr = placeData.priceRange;
  const pl = placeData.priceLevel;

  if (pr) {
    const lo = parseMoney(pr.startPrice);
    const hi = parseMoney(pr.endPrice);
    if (lo !== null) {
      const rangeStr = `€${lo}–€${hi ?? lo}`;
      // Only trust priceRange.startPrice as beer price if it's in realistic range
      if (lo >= BEER_PRICE_MIN && lo <= BEER_PRICE_MAX) {
        return { price: Math.round(lo * 100) / 100, method: 'priceRange', range: rangeStr };
      }
      // startPrice is too low (tabac/coffee) or too high (cocktail/meal) → fall back to priceLevel
      if (pl && PRICE_LEVEL_MAP[pl]) {
        return { price: PRICE_LEVEL_MAP[pl], method: 'priceLevel_fallback', range: `${pl} (range: ${rangeStr})` };
      }
    }
  }
  // Fallback: priceLevel
  if (pl && PRICE_LEVEL_MAP[pl]) {
    return { price: PRICE_LEVEL_MAP[pl], method: 'priceLevel', range: pl };
  }
  // Last resort: reviews text mining
  const reviewPrice = parseReviewsForPrice(placeData.reviews);
  if (reviewPrice !== null) {
    const count = (placeData.reviews || []).length;
    return { price: reviewPrice, method: 'review_text', range: `from ${count} review(s)` };
  }
  return null;
}

// ─── Opening hours helpers ────────────────────────────────────────────────────

/**
 * Compute max closing hour in 24+ notation from Google regularOpeningHours.periods.
 * 26 = 2 am, 29 = 5 am.
 * Returns null if no periods or all periods are 24h.
 */
function computeCloseHour(periods) {
  if (!periods?.length) return null;
  let max = null;
  for (const p of periods) {
    if (!p.close) continue; // 24h → skip (treat as 24)
    // Hours < 8 after midnight are stored as next-day (day+1, hour 0-7) by Google
    // We add 24 to represent them in 24+ notation
    const h = p.close.hour < 8 ? p.close.hour + 24 : p.close.hour;
    if (max === null || h > max) max = h;
  }
  return max;
}

async function fetchGooglePlace(placeId) {
  const url = `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`;

  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      headers: {
        'X-Goog-Api-Key':   GMAPS_KEY,
        'X-Goog-FieldMask': 'priceRange,priceLevel,displayName,reviews,regularOpeningHours',
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
      throw new Error(`HTTP ${r.status}: ${body.slice(0, 120)}`);
    }
    return r.json();
  }
  throw new Error('429 after 3 retries');
}

// Keep backward compat alias
const fetchGooglePrice = fetchGooglePlace;

console.log('═══════════════════════════════════════════════════════════');
console.log('  Vérification des prix via Google Places API v1');
console.log(`  Mode: ${MODE} | Limite: ${LIMIT} | Offset: ${OFFSET}`);
console.log(`  Budget: $${HARD_STOP} | ~${Math.floor(HARD_STOP / COST_PER_CALL)} bars max`);
console.log('═══════════════════════════════════════════════════════════\n');

// ─── PASS 1 : fill bars without price ────────────────────────────────────────
async function passFill() {
  console.log('── Passe 1 : remplissage des bars sans prix ─────────────\n');

  const all = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase.from('bars')
      .select('id, name, google_place_id, latitude, longitude')
      .not('google_place_id', 'is', null)
      .eq('beer_price', 0)
      .eq('serves_beer', true)
      .range(from, from + 999);
    if (error) { console.error(error.message); break; }
    if (!data.length) break;
    all.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }

  // Sort by distance from center (closest first = most valuable)
  all.sort((a, b) => {
    const da = haversineKm(CENTER_LAT, CENTER_LON, a.latitude ?? CENTER_LAT, a.longitude ?? CENTER_LON);
    const db = haversineKm(CENTER_LAT, CENTER_LON, b.latitude ?? CENTER_LAT, b.longitude ?? CENTER_LON);
    return da - db;
  });

  const batch = all.slice(OFFSET, OFFSET + LIMIT);
  console.log(`📥 ${all.length} bars sans prix | traitement ${OFFSET + 1}–${OFFSET + batch.length}\n`);

  let filled = 0, noData = 0, errors = 0;

  for (let i = 0; i < batch.length; i++) {
    const bar = batch[i];
    const pad = bar.name.padEnd(38).slice(0, 38);
    process.stdout.write(`[${String(OFFSET + i + 1).padStart(4)}] ${pad} … `);

    let placeData;
    try {
      placeData = await fetchGooglePrice(bar.google_place_id);
      charge('place_details'); // only charge for successful calls
    } catch (e) {
      process.stdout.write(`⚠️  ${e.message}\n`);
      errors++;
      await sleep(500);
      continue;
    }

    const parsed    = parsePrice(placeData);
    const periods   = placeData.regularOpeningHours?.periods ?? null;
    const closeHour = computeCloseHour(periods);

    if (!parsed) {
      // No price — but save hours if we got them
      if (periods !== null) {
        await supabase.from('bars').update({ opening_hours: periods, close_hour: closeHour }).eq('id', bar.id);
        const hoursTag = closeHour !== null && closeHour >= 26 ? ` 🌙${closeHour - 24}h+` : '';
        process.stdout.write(`— no price, hours saved${hoursTag}\n`);
      } else {
        process.stdout.write('— pas de données\n');
      }
      noData++;
      await sleep(150);
      continue;
    }

    const { error } = await supabase.from('bars').update({
      beer_price:    parsed.price,
      price_source:  'google',
      opening_hours: periods,
      close_hour:    closeHour,
    }).eq('id', bar.id);

    if (error) {
      process.stdout.write(`❌ ${error.message}\n`);
      errors++;
    } else {
      const hoursTag = closeHour !== null ? ` ⏰${closeHour >= 24 ? closeHour - 24 + 'h+' : closeHour + 'h'}` : '';
      process.stdout.write(`✅ €${parsed.price.toFixed(2)} (${parsed.range}) [${parsed.method}]${hoursTag}\n`);
      filled++;
    }
    await sleep(150);
  }

  console.log(`\n  ✅ ${filled} prix remplis`);
  console.log(`  — ${noData} sans données`);
  console.log(`  ⚠️  ${errors} erreurs`);
  return filled;
}

// ─── PASS 2 : verify MGB prices ──────────────────────────────────────────────
async function passVerify() {
  console.log('\n── Passe 2 : vérification des prix MGB ──────────────────\n');

  const all = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase.from('bars')
      .select('id, name, google_place_id, beer_price, latitude, longitude')
      .not('google_place_id', 'is', null)
      .eq('price_source', 'mgb')
      .eq('serves_beer', true)
      .range(from, from + 999);
    if (error) { console.error(error.message); break; }
    if (!data.length) break;
    all.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }

  // Sort by distance from center (closest bars first = most important)
  all.sort((a, b) => {
    const da = haversineKm(CENTER_LAT, CENTER_LON, a.latitude ?? CENTER_LAT, a.longitude ?? CENTER_LON);
    const db = haversineKm(CENTER_LAT, CENTER_LON, b.latitude ?? CENTER_LAT, b.longitude ?? CENTER_LON);
    return da - db;
  });

  const batch = all.slice(OFFSET, OFFSET + LIMIT);
  console.log(`📥 ${all.length} prix MGB | vérification ${OFFSET + 1}–${OFFSET + batch.length}\n`);

  let updated = 0, confirmed = 0, noData = 0, errors = 0;

  for (let i = 0; i < batch.length; i++) {
    const bar = batch[i];
    const pad = bar.name.padEnd(36).slice(0, 36);
    process.stdout.write(`[${String(OFFSET + i + 1).padStart(4)}] ${pad} MGB€${bar.beer_price.toFixed(2)} … `);

    let placeData;
    try {
      placeData = await fetchGooglePrice(bar.google_place_id);
      charge('place_details_verify'); // only charge for successful calls
    } catch (e) {
      process.stdout.write(`⚠️  ${e.message}\n`);
      errors++;
      await sleep(500);
      continue;
    }

    const parsed = parsePrice(placeData);
    if (!parsed) {
      process.stdout.write('— pas de données prix\n');
      noData++;
      await sleep(150);
      continue;
    }

    const mgbPrice   = bar.beer_price;
    const gPrice     = parsed.price;
    const diff       = Math.abs(gPrice - mgbPrice);
    const pctDiff    = diff / mgbPrice;

    // Only trust priceLevel estimates for MAJOR discrepancies (>40% AND >€2)
    // For priceLevel_fallback: priceRange data was absent/out-of-range → less reliable
    const isFirmPrice = parsed.method === 'priceRange';
    const threshold_eur = isFirmPrice ? 1.5 : 2.0;
    const threshold_pct = isFirmPrice ? 0.35 : 0.50;

    const periods    = placeData.regularOpeningHours?.periods ?? null;
    const closeHour  = computeCloseHour(periods);

    // Always save hours even if price doesn't change
    const hoursUpdate = periods !== null ? { opening_hours: periods, close_hour: closeHour } : {};

    // Update if Google price exceeds thresholds
    if (diff > threshold_eur && pctDiff > threshold_pct) {
      const { error } = await supabase.from('bars').update({
        beer_price:   gPrice,
        price_source: 'google',
        ...hoursUpdate,
      }).eq('id', bar.id);

      if (error) {
        process.stdout.write(`❌ ${error.message}\n`);
        errors++;
      } else {
        const hoursTag = closeHour !== null ? ` ⏰${closeHour >= 24 ? closeHour - 24 + 'h+' : closeHour + 'h'}` : '';
        process.stdout.write(`🔄 €${mgbPrice.toFixed(2)}→€${gPrice.toFixed(2)} (${parsed.range}) [${parsed.method}]${hoursTag}\n`);
        updated++;
      }
    } else {
      // Price ok — still save hours if we got them
      if (periods !== null) {
        await supabase.from('bars').update(hoursUpdate).eq('id', bar.id);
      }
      process.stdout.write(`✓ €${mgbPrice.toFixed(2)} ok (Google: ${parsed.range})\n`);
      confirmed++;
    }
    await sleep(150);
  }

  console.log(`\n  🔄 ${updated} prix MGB mis à jour vers Google`);
  console.log(`  ✓  ${confirmed} prix MGB confirmés`);
  console.log(`  — ${noData} sans données Google`);
  console.log(`  ⚠️  ${errors} erreurs`);
  return updated;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
let totalChanged = 0;

if (MODE === 'fill' || MODE === 'all') {
  totalChanged += await passFill();
}
if (MODE === 'verify' || MODE === 'all') {
  totalChanged += await passVerify();
}

console.log('\n═══════════════════════════════════════════════════════════');
console.log(`  Total modifié : ${totalChanged}`);
console.log(`  💸 Coût : $${spent.toFixed(3)} / budget $${HARD_STOP}`);
console.log('═══════════════════════════════════════════════════════════\n');
