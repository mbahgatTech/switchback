import { auth } from '@/auth';

/**
 * GET /api/reader — who the server says is here, right now.
 *
 * One id and nothing else. It exists for a single caller, `ReaderIdentity` in
 * `offline/reader.tsx`, and for a single question that the rendered page cannot answer
 * honestly: **did this HTML come from the server, or out of Cache Storage?**
 *
 * The handover destroys things — it clears a departing reader's downloaded pages, tiles and
 * photographs, and it rewrites the id every later queued row is stamped with — so it must run
 * on a fact and not on an inference. It used to run on `navigator.onLine`, on the reasoning
 * that an online browser must have been served by the network-first navigation handler. That
 * is not what the service worker does: `handleNavigation` in `public/sw.js` falls back to the
 * cache when `fetch` *throws*, which a captive portal, a dead cell data session or a DNS
 * failure all do while `navigator.onLine` stays true. A trail page downloaded while signed out
 * carries `readerId={null}` in its stored HTML for ever, so the wrong branch there signs the
 * reader out of their own device: their unsent report and in-progress hike marked as held for
 * somebody else, every download deleted, and every later fix recorded unattributed.
 *
 * Asking here removes the inference rather than improving it. `/api/*` is excluded from the
 * worker's fetch handler outright, so this either reaches the origin or throws, and there is no
 * third answer. Whatever it says is the answer at *this* instant, not the answer at the instant
 * the page was rendered — which is also better than the page could ever be, and is what makes
 * a soft navigation's stale layout harmless.
 *
 * **Not a session endpoint and not a substitute for one.** It returns the id of the signed-in
 * account to that same account's own browser, which is the id already embedded in every page
 * that browser is served. Nothing else: no name, no email, no units, no session token.
 *
 * Called about as often as a browser changes hands, because the caller only asks when what the
 * page rendered and what the browser remembers disagree — a handful of times per device.
 */
export const runtime = 'nodejs';

/**
 * Never cached, by anything.
 *
 * The whole value of this route is that its answer is current. A CDN entry or a
 * back/forward-cache replay would make it exactly as stale as the page it exists to check,
 * which is worse than useless: it would look like proof.
 */
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const session = await auth();
  return Response.json(
    { id: session?.user?.id ?? null },
    { headers: { 'cache-control': 'no-store' } },
  );
}
