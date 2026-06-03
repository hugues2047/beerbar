/**
 * scrape_mgb_happy_hours.mjs
 *
 * Scrape MisterGoodBeer individual bar pages for happy hour times + prices.
 * Each bar page URL is already stored in bars.source_url.
 *
 * MGB page text format:
 *   "Pint at €5.00 from 6:00 PM to 8:00 PM (€6.50 outside happy hour)"
 *
 * Usage:
 *   node scrape_mgb_happy_hours.mjs
 *   node scrape_mgb_happy_hours.mjs --dry-run
 *   node scrape_mgb_happy_hours.mjs --limit 50
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
const LIMIT   = (() => {
  const i = process.argv.indexOf('--limit');
  return i >= 0 ? parseInt(process.argv[i+1]) : Infinity;
})();
const DELAY_MS = 600; // polite rate-limit
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Convert "5:00 PM" → "17h" ─────────────────────────────────────────────────
function to24h(timeStr) {
  const m = timeStr.match(/^(\d+):(\d+)\s+(AM|PM)$/i);
  if (!m) return null;
  let h = parseInt(m[1]);
  const min = parseInt(m[2]);
  const period = m[3].toUpperCase();
  if (period === 'PM' && h !== 12) h += 12;
  if (period === 'AM' && h === 12) h = 0;
  return min ? `${h}h${String(min).padStart(2,'0')}` : `${h}h`;
}

// ── Convert "16:00" or "16h30" → "16h30" display ─────────────────────────────
function fmtTime(t) {
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return t.replace(':', 'h');
  return m[2] === '00' ? `${m[1]}h` : `${m[1]}h${m[2]}`;
}

// ── Parse MGB individual bar page (FR format) for HH info ────────────────────
// French page patterns:
//   "Pinte en Happy hour à 4,50 €"  → HH price
//   "* Happy Hour : de 16:00 à 23:00" → HH times
//   FAQ: "Happy Hour de 16:00 à 23:00"
function parseHH(html) {
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  // 1. HH hours: "Happy Hour : de 16:00 à 23:00" or "Happy Hour de 16:00 à 23:00"
  const timesRe = /Happy Hour\s*:?\s*de\s*(\d{1,2}:\d{2})\s*à\s*(\d{1,2}:\d{2})/i;
  const timesMatch = timesRe.exec(text);
  if (!timesMatch) return null;

  const start = fmtTime(timesMatch[1]);
  const end   = fmtTime(timesMatch[2]);

  // 2. HH price: "Pinte en Happy hour à 4,50 €" or "pinte à 4,50 € de 16:00"
  const priceRe1 = /Pinte en Happy hour à ([\d,]+)\s*€/i;
  const priceRe2 = /Pinte à ([\d,]+)\s*€ de \d{1,2}:\d{2}/i;
  const priceMatch = priceRe1.exec(text) || priceRe2.exec(text);
  const hhPrice = priceMatch
    ? parseFloat(priceMatch[1].replace(',', '.'))
    : null;

  return {
    ...(hhPrice && hhPrice > 1 && hhPrice < 15 ? { happy_hour_price: hhPrice } : {}),
    happy_hour_times:      `${start}–${end}`,
    happy_hour_source:     'mgb',
    happy_hour_updated_at: new Date().toISOString(),
  };
}

// ── Load bars from DB ─────────────────────────────────────────────────────────
async function loadBars() {
  console.log('📦 Loading MGB bars without HH times…');
  const all = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('bars')
      .select('id, name, source_url, happy_hour_times')
      .like('source_url', '%mistergoodbeer.com/bars/%')
      .is('happy_hour_times', null)
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    all.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }
  console.log(`  ${all.length} bars to process`);
  return all;
}

// ── Main ──────────────────────────────────────────────────────────────────────
const bars = await loadBars();
const total = Math.min(bars.length, LIMIT);

let fetched = 0, updated = 0, noHH = 0, errors = 0;

for (let i = 0; i < total; i++) {
  const bar = bars[i];
  const url = bar.source_url;

  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'ParisBeerMap/1.0 (speedbeer.vercel.app)',
        'Accept': 'text/html',
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!r.ok) {
      if (r.status === 404) {
        noHH++; // bar page gone
        process.stdout.write(`\r  ${i+1}/${total} — fetched:${fetched} updated:${updated} noHH:${noHH} errors:${errors}  `);
        await sleep(DELAY_MS);
        continue;
      }
      errors++;
      await sleep(DELAY_MS * 2);
      continue;
    }

    fetched++;
    const html = await r.text();
    const hh   = parseHH(html);

    if (!hh) {
      noHH++;
      process.stdout.write(`\r  ${i+1}/${total} — fetched:${fetched} updated:${updated} noHH:${noHH} errors:${errors}  `);
      await sleep(DELAY_MS);
      continue;
    }

    if (DRY_RUN) {
      console.log(`\n  [DRY] ${bar.name} → HH ${hh.happy_hour_times} à ${hh.happy_hour_price}€`);
      updated++;
    } else {
      const { error } = await supabase
        .from('bars')
        .update(hh)
        .eq('id', bar.id);
      if (error) { errors++; }
      else {
        updated++;
        if (updated % 20 === 0) console.log(`\n  ✓ ${bar.name} → ${hh.happy_hour_times} @ ${hh.happy_hour_price}€`);
      }
    }

    process.stdout.write(`\r  ${i+1}/${total} — fetched:${fetched} updated:${updated} noHH:${noHH} errors:${errors}  `);
    await sleep(DELAY_MS);

  } catch (e) {
    errors++;
    await sleep(DELAY_MS * 2);
  }
}

console.log(`\n\n✅ Done — ${fetched} fetched, ${updated} updated, ${noHH} no HH, ${errors} errors`);
