import { NextResponse } from 'next/server';

/**
 * POST /api/rebuild
 *
 * Déclenche un rebuild Vercel via le deploy hook.
 * Le hook URL est côté serveur uniquement (pas exposé au browser).
 *
 * Env var requise dans Vercel :  DEPLOY_HOOK_URL  (sans NEXT_PUBLIC_)
 * Fallback legacy              : NEXT_PUBLIC_DEPLOY_HOOK_URL
 *
 * Rate-limit : 5 min par instance serverless (en mémoire).
 * Couplé au rate-limit client-side dans MapView.tsx, c'est suffisant.
 */

let lastRebuildAt = 0;
const COOLDOWN_MS = 5 * 60 * 1000; // 5 min

export async function POST() {
  const now = Date.now();

  if (now - lastRebuildAt < COOLDOWN_MS) {
    return NextResponse.json({ ok: false, reason: 'rate_limited' }, { status: 429 });
  }

  // Prefer server-side env var (no NEXT_PUBLIC_); fall back to legacy
  const hookUrl =
    process.env.DEPLOY_HOOK_URL ??
    process.env.NEXT_PUBLIC_DEPLOY_HOOK_URL;

  if (!hookUrl) {
    return NextResponse.json({ ok: false, reason: 'not_configured' }, { status: 500 });
  }

  lastRebuildAt = now;
  fetch(hookUrl).catch(() => {}); // fire and forget

  return NextResponse.json({ ok: true });
}
