/**
 * scrape_mgb_neighborhood.mjs
 *
 * Enrichit les bars avec happy_hour_price mais sans happy_hour_times,
 * en tentant de deviner leur URL MGB individuelle depuis leur nom.
 * Pattern: slugify(name) + "-paris" → https://www.mistergoodbeer.com/bars/{slug}-paris
 *
 * Usage:
 *   node scrape_mgb_neighborhood.mjs
 *   node scrape_mgb_neighborhood.mjs --dry-run
 *   node scrape_mgb_neighborhood.mjs --limit 100
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
const LIMIT   = (() => { const i = process.argv.indexOf('--limit'); return i >= 0 ? parseInt(process.argv[i+1]) : Infinity; })();
const DELAY_MS = 700;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Slugify bar name for MGB URL ──────────────────────────────────────────────
function slugify(name) {
  return (name ?? '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')  // remove accents
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// ── Parse MGB individual bar page (FR) ───────────────────────────────────────
function fmtTime(t) {
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return t.replace(':', 'h');
  return m[2] === '00' ? `${m[1]}h` : `${m[1]}h${m[2]}`;
}

function parseHH(html) {
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const timesRe = /Happy Hour\s*:?\s*de\s*(\d{1,2}:\d{2})\s*à\s*(\d{1,2}:\d{2})/i;
  const timesMatch = timesRe.exec(text);
  if (!timesMatch) return null;
  const start = fmtTime(timesMatch[1]);
  const end   = fmtTime(timesMatch[2]);
  const priceRe1 = /Pinte en Happy hour à ([\d,]+)\s*€/i;
  const priceRe2 = /Pinte à ([\d,]+)\s*€ de \d{1,2}:\d{2}/i;
  const priceMatch = priceRe1.exec(text) || priceRe2.exec(text);
  const hhPrice = priceMatch ? parseFloat(priceMatch[1].replace(',', '.')) : null;
  return {
    ...(hhPrice && hhPrice > 1 && hhPrice < 15 ? { happy_hour_price: hhPrice } : {}),
    happy_hour_times:      `${start}–${end}`,
    happy_hour_source:     'mgb',
    happy_hour_updated_at: new Date().toISOString(),
  };
}

// ── Load bars with HH price but no HH times, not having individual MGB URL ───
async function loadBars() {
  console.log('📦 Loading bars with HH price but missing HH times…');
  const all = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('bars')
      .select('id, name, source_url, happy_hour_times, happy_hour_price')
      .not('happy_hour_price', 'is', null)
      .gt('happy_hour_price', 0)
      .is('happy_hour_times', null)
      .not('source_url', 'like', '%mistergoodbeer.com/bars/%')
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    all.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }
  console.log(`  ${all.length} bars to attempt`);
  return all;
}

// ── Main ──────────────────────────────────────────────────────────────────────
const bars = await loadBars();
const total = Math.min(bars.length, LIMIT);

let attempted = 0, found = 0, updated = 0, notFound = 0;

for (let i = 0; i < total; i++) {
  const bar = bars[i];
  const slug = slugify(bar.name);
  if (!slug) { notFound++; continue; }

  const url = `https://www.mistergoodbeer.com/bars/${slug}-paris`;
  attempted++;

  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'ParisBeerMap/1.0 (speedbeer.vercel.app)',
        'Accept': 'text/html',
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!r.ok) {
      notFound++;
      process.stdout.write(`\r  ${i+1}/${total} — found:${found} updated:${updated} notFound:${notFound}  `);
      await sleep(DELAY_MS);
      continue;
    }

    const html = await r.text();
    // Verify it's the right bar (check name appears in page)
    const nameNorm = slug.replace(/-/g, ' ');
    if (!html.toLowerCase().includes(nameNorm.slice(0, 6))) {
      notFound++;
      await sleep(DELAY_MS);
      continue;
    }

    const hh = parseHH(html);
    if (!hh) {
      notFound++;
      process.stdout.write(`\r  ${i+1}/${total} — found:${found} updated:${updated} notFound:${notFound}  `);
      await sleep(DELAY_MS);
      continue;
    }

    found++;
    if (DRY_RUN) {
      console.log(`\n  [DRY] ${bar.name} → ${hh.happy_hour_times}${hh.happy_hour_price ? ` @ ${hh.happy_hour_price}€` : ''}`);
      updated++;
    } else {
      const { error } = await supabase.from('bars').update({
        ...hh,
        source_url: url, // upgrade source to individual page URL
      }).eq('id', bar.id);
      if (!error) {
        updated++;
        if (updated % 20 === 0) console.log(`\n  ✓ ${bar.name} → ${hh.happy_hour_times}`);
      }
    }

    process.stdout.write(`\r  ${i+1}/${total} — found:${found} updated:${updated} notFound:${notFound}  `);
    await sleep(DELAY_MS);

  } catch (e) {
    notFound++;
    await sleep(DELAY_MS);
  }
}

console.log(`\n\n✅ Done — ${attempted} tried, ${found} found, ${updated} updated, ${notFound} no match`);
