@AGENTS.md

## gstack

Use the `/browse` skill from gstack for all web browsing. Never use `mcp__claude-in-chrome__*` tools directly.

Available skills:
/office-hours, /plan-ceo-review, /plan-eng-review, /plan-design-review, /design-consultation, /design-shotgun, /design-html, /review, /ship, /land-and-deploy, /canary, /benchmark, /browse, /connect-chrome, /qa, /qa-only, /design-review, /setup-browser-cookies, /setup-deploy, /setup-gbrain, /retro, /investigate, /document-release, /document-generate, /codex, /cso, /autoplan, /plan-devex-review, /devex-review, /careful, /freeze, /guard, /unfreeze, /gstack-upgrade, /learn

---

## ⚠️ Architecture — `public/bars.json` statique

Le frontend charge les bars depuis `/bars.json` (CDN Vercel), **pas depuis Supabase**.
Ce fichier est généré au build via `scripts/generate-bars.mjs` (lancé en `prebuild`/`predev`).

**Conséquence critique : toute modification de la base de données ne sera visible dans l'app qu'après un redéploiement Vercel.**

### Quand déclencher un rebuild après une modif DB

| Action | Rebuild nécessaire ? |
|---|---|
| `enrich_hours_osm.mjs` — horaires OSM | ✅ OUI |
| `enrich_bars_google.mjs` — prix + horaires Google | ✅ OUI |
| Ajout de nouveaux bars (scraper) | ✅ OUI |
| Mise à jour `has_terrace`, `terrace_grande` | ✅ OUI |
| Correction d'un nom / adresse en DB | ✅ OUI |
| Submit prix par un utilisateur (frontend) | ✅ automatique via `/api/rebuild` → Deploy Hook |
| Changement de code uniquement | ✅ automatique via git push |
| Modif schéma SQL (ajout colonne) | ✅ OUI + mettre à jour le SELECT dans `generate-bars.mjs` |

### Comment déclencher le rebuild manuellement

```bash
# Option 1 — curl (immédiat)
curl -X POST https://api.vercel.com/v1/integrations/deploy/prj_WUEthL5vw3k08DpMQ79MwOLDuXkw/5xn501Mzhm

# Option 2 — git push (si tu as des modifs de code à pousser en même temps)
git commit --allow-empty -m "chore: trigger rebuild to refresh bars.json"
git push
```

### Env vars Vercel requises

| Var | Visibilité | Usage |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Public | Client Supabase |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Public | Client Supabase |
| `DEPLOY_HOOK_URL` | **Server only** | Route `/api/rebuild` → déclenche rebuild. **Ne pas mettre NEXT_PUBLIC_.** Fallback : `NEXT_PUBLIC_DEPLOY_HOOK_URL` si non configuré. |

### Scripts d'enrichissement disponibles

| Script | Source | Ce qu'il enrichit | Fréquence suggérée |
|---|---|---|---|
| `enrich_hours_osm.mjs` | OSM Overpass (gratuit) | `opening_hours`, `close_hour`, `has_terrace` | Mensuel |
| `enrich_happy_hours_osm.mjs` | OSM Overpass (gratuit) | `happy_hour_periods`, `happy_hour_times`, `happy_hour_source` | Mensuel |
| `scrape_mgb_happy_hours.mjs` | MisterGoodBeer (scraping) | `happy_hour_price`, `happy_hour_times` pour bars avec URL individuelle MGB | Une fois / quand nouveau scraping MGB |
| `scrape_mgb_neighborhood.mjs` | MisterGoodBeer (slug inference) | Idem pour bars sans URL individuelle | Idem |
| `enrich_bars_google.mjs` | Google Places API (payant) | `beer_price`, `opening_hours`, `has_terrace`, `google_place_id` | Quand budget dispo |
| `scrape_fill_gaps_osm.mjs` | OSM Overpass (gratuit) | Insère les bars OSM absents de la DB (carte noire à blanc) | Mensuel |
| `scrape_unpriced_mgb.mjs` | MisterGoodBeer (scraping) | Prix + HH pour bars avec `beer_price=0` via slug MGB | `node scrape_unpriced_mgb.mjs 500 0`, puis `500 500`, etc. |

> **Note** : `scrape_mgb_neighborhood.mjs` doit être lancé 2 fois la première fois (grant source_url ajouté après le premier run).

### Champs inclus dans bars.json

Définis dans le `SELECT` de `scripts/generate-bars.mjs` :
```
id, name, address, latitude, longitude,
beer_price, happy_hour_price, happy_hour_times, price_source, last_updated,
has_terrace, terrace_grande,
opening_hours, close_hour,
happy_hour_periods, happy_hour_source, happy_hour_updated_at,
is_top_bar
```

### Colonne `is_top_bar`

Marqueur discret pour les bars incontournables. Critères algorithmiques :
- `google_rating >= 4.5 AND beer_price > 0 AND opening_hours IS NOT NULL`
- Ou manuellement via SQL pour les bars iconiques (Harry's Bar, Hemingway, Fine Mousse…)

Actuel : **997 bars** marqués (13% de la base).
Affiché dans l'UI : ⭐ inline dans le nom + ring amber sur le dot de la map + chip "⭐ Top".

Si tu ajoutes une nouvelle colonne à afficher dans l'app → **mettre à jour ce SELECT**.
