/**
 * scrape_unpriced_mgb.mjs
 *
 * Tente de récupérer le prix de bière + happy hour pour tous les bars
 * sans prix (beer_price = 0) via MisterGoodBeer (slug inference).
 *
 * Usage:
 *   node scrape_unpriced_mgb.mjs              # 500 premiers
 *   node scrape_unpriced_mgb.mjs 500 500      # lot 2 (bars 501-1000)
 *   node scrape_unpriced_mgb.mjs 1000 1000    # lot 3
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

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const LIMIT  = parseInt(process.argv[2] || '500');
const OFFSET = parseInt(process.argv[3] || '0');

function slugify(name) {
  return (name ?? '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-')
    .replace(/-+/g, '-').replace(/^-|-$/g, '');
}
function fmtTime(t) {
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  return m ? (m[2] === '00' ? `${m[1]}h` : `${m[1]}h${m[2]}`) : t.replace(':', 'h');
}

function parsePage(html) {
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  // Regular price: "Pinte à partir de X,XX €"
  const beerRe = /Pinte à partir de ([\d,]+)\s*€/i;
  const beerM  = beerRe.exec(text);
  const beerPrice = beerM ? parseFloat(beerM[1].replace(',', '.')) : null;

  // HH: "Happy Hour : de HH:MM à HH:MM"
  const hhTimeRe  = /Happy Hour\s*:?\s*de\s*(\d{1,2}:\d{2})\s*à\s*(\d{1,2}:\d{2})/i;
  const hhTimeM   = hhTimeRe.exec(text);
  const hhPrice1  = /Pinte en Happy hour à ([\d,]+)\s*€/i.exec(text);
  const hhPrice2  = /Pinte à ([\d,]+)\s*€ de \d{1,2}:\d{2}/i.exec(text);

  const hhPriceMatch = hhPrice1 || hhPrice2;
  const hhPrice = hhPriceMatch ? parseFloat(hhPriceMatch[1].replace(',', '.')) : null;

  return {
    beerPrice:    (beerPrice && beerPrice > 1 && beerPrice < 20) ? beerPrice : null,
    hhPrice:      (hhPrice && hhPrice > 1 && hhPrice < 20) ? hhPrice : null,
    hhTimes:      hhTimeM ? `${fmtTime(hhTimeM[1])}–${fmtTime(hhTimeM[2])}` : null,
  };
}

// Load unpriced bars
console.log('📦 Loading unpriced bars…');
const all = [];
let from = 0;
while (true) {
  const { data, error } = await supabase
    .from('bars').select('id, name')
    .eq('beer_price', 0)
    .range(from, from + 999);
  if (error || !data?.length) break;
  all.push(...data);
  if (data.length < 1000) break;
  from += 1000;
}
console.log(`  ${all.length} unpriced — processing [${OFFSET}..${OFFSET + LIMIT - 1}]`);

const batch = all.slice(OFFSET, OFFSET + LIMIT);
let updated = 0, noData = 0, errors = 0;

for (let i = 0; i < batch.length; i++) {
  const bar = batch[i];
  const slug = slugify(bar.name);
  if (!slug) { noData++; continue; }

  const url = `https://www.mistergoodbeer.com/bars/${slug}-paris`;

  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'ParisBeerMap/1.0 (speedbeer.vercel.app)', Accept: 'text/html' },
      signal: AbortSignal.timeout(13_000),
    });

    if (!r.ok) { noData++; await sleep(500); continue; }
    const html = await r.text();

    // Verify bar name is plausible on this page
    if (!html.toLowerCase().includes(slug.slice(0, 5).replace(/-/g, ' '))) {
      noData++; await sleep(500); continue;
    }

    const { beerPrice, hhPrice, hhTimes } = parsePage(html);
    if (!beerPrice && !hhPrice) { noData++; await sleep(500); continue; }

    const update = {};
    if (beerPrice) {
      update.beer_price   = beerPrice;
      update.price_source = 'mgb';
      update.last_updated = new Date().toISOString();
    }
    if (hhPrice)  update.happy_hour_price = hhPrice;
    if (hhTimes) {
      update.happy_hour_times      = hhTimes;
      update.happy_hour_source     = 'mgb';
      update.happy_hour_updated_at = new Date().toISOString();
    }

    await supabase.from('bars').update(update).eq('id', bar.id);
    updated++;
    if (updated % 20 === 0) process.stdout.write(`\r  ${i+1}/${batch.length} — updated:${updated} noData:${noData}  `);
    await sleep(620);
  } catch {
    errors++;
    await sleep(620);
  }
}

console.log(`\n✅ Done — updated:${updated} noData:${noData} errors:${errors}`);
