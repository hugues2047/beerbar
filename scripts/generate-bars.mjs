/**
 * scripts/generate-bars.mjs
 *
 * Génère public/bars.json depuis Supabase.
 * Lancé automatiquement avant chaque `next build` (voir package.json).
 *
 * Le fichier est servi statiquement par le CDN Vercel :
 *   - 0 requête Supabase par visite (au lieu de 8 batch queries)
 *   - Chargement < 300 ms au lieu de 1-3 s
 *   - 0 egress Supabase
 */

import { createClient } from '@supabase/supabase-js';
import { writeFileSync, mkdirSync } from 'fs';
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

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

console.log('🍺 Generating public/bars.json from Supabase…');

const baseSelect = 'id,name,address,latitude,longitude,beer_price,happy_hour_price,happy_hour_times,price_source,last_updated,has_terrace,terrace_grande,opening_hours,close_hour';
const selectWithHappyHourPeriods = `${baseSelect},happy_hour_periods,happy_hour_source,happy_hour_updated_at`;
let selectColumns = selectWithHappyHourPeriods;
const all = [];
let from = 0;
while (true) {
  const { data, error } = await supabase
    .from('bars')
    .select(selectColumns)
    .or('serves_beer.eq.true,serves_beer.is.null')
    .range(from, from + 999);

  if (error) {
    if (
      selectColumns === selectWithHappyHourPeriods
      && /happy_hour_(periods|source|updated_at)|does not exist/i.test(error.message)
    ) {
      console.warn('happy_hour_periods columns missing; generating without happy hour periods.');
      selectColumns = baseSelect;
      all.length = 0;
      from = 0;
      continue;
    }
    console.error('Supabase error:', error.message);
    process.exit(1);
  }
  if (!data?.length) break;
  all.push(...data);
  process.stdout.write(`  fetched ${all.length}…\r`);
  if (data.length < 1000) break;
  from += 1000;
}

mkdirSync('public', { recursive: true });
const json = JSON.stringify(all);
writeFileSync('public/bars.json', json);

const kb = Math.round(Buffer.byteLength(json) / 1024);
console.log(`✅ public/bars.json — ${all.length} bars, ${kb} KB`);
