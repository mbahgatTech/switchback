import { auth } from '@/auth';

/**
 * GET /api/reader — one id, for `ReaderIdentity` in `offline/reader.tsx`, answering the one
 * question a rendered page cannot: did this HTML come from the server or out of Cache Storage?
 *
 * The handover deletes downloads and restamps queued rows, so it must run on a fact. It used to
 * infer from `navigator.onLine`, which stays true through a captive portal or a dead data session
 * while `handleNavigation` is already serving from cache — and cached HTML carries whatever
 * `readerId` it was stored with, for ever. `/api/*` is excluded from the worker's fetch handler,
 * so this reaches the origin or throws; there is no third answer.
 *
 * Not a session endpoint: it returns to a browser only the id already embedded in every page that
 * browser is served. No name, no email, no token.
 */
export const runtime = 'nodejs';

/** A CDN entry or bfcache replay would be exactly as stale as the page this exists to check. */
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const session = await auth();
  return Response.json(
    { id: session?.user?.id ?? null },
    { headers: { 'cache-control': 'no-store' } },
  );
}
