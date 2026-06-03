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

### Champs inclus dans bars.json

Définis dans le `SELECT` de `scripts/generate-bars.mjs` :
```
id, name, address, latitude, longitude,
beer_price, price_source, phone, last_updated,
has_terrace, terrace_grande,
opening_hours, close_hour
```

Si tu ajoutes une nouvelle colonne à afficher dans l'app → **mettre à jour ce SELECT**.
