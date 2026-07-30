import { randomUUID } from 'node:crypto';
import type { NextConfig } from 'next';

/**
 * This build, as one string the whole app agrees on.
 *
 * The service worker's shell cache is named after it — see `src/offline/caches.ts` — so it has
 * to change when the code does and stay fixed within a build. The commit is that on Vercel and
 * in CI. A local production build has neither, and a constant there would be worse than
 * useless: two builds sharing a cache name is the collision the whole scheme exists to avoid.
 * So it falls back to something per-build and random, evaluated once when this config loads.
 */
const BUILD_ID =
  process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) ??
  process.env.GITHUB_SHA?.slice(0, 12) ??
  randomUUID().slice(0, 12);

/**
 * The origin user-uploaded photographs are served from, if a deployment has a real one.
 *
 * Read from `R2_PUBLIC_URL`, which is the variable a deployment with R2 configured must have:
 * `src/env.ts` validates it as a URL, its cross-field rule refuses a half-configured R2, and
 * `packages/api/src/storage.ts` builds every photo URL out of it. `NEXT_PUBLIC_R2_PUBLIC_HOST`
 * is a second, scheme-less spelling of the same host, kept as a fallback because
 * `images.remotePatterns` below wants a hostname rather than a URL — but it is optional and
 * unvalidated, so a deployment can be fully R2-configured with it unset. Reading only that
 * one, which is what this file used to do, gave exactly those deployments a policy with no
 * entry for the host every photograph comes from: harmless while the header is Report-Only,
 * and a blank gallery on the day it is enforced.
 *
 * Placeholders are dropped for the same reason `pmtilesOrigin` drops them — `.env.example`
 * ships `NEXT_PUBLIC_R2_PUBLIC_HOST="cdn.example.com"` verbatim, so a fresh clone would
 * otherwise allow-list a host it will never talk to, and a CSP that allow-lists a placeholder
 * has stopped describing the deployment it is on.
 *
 * `R2_PUBLIC_URL` is server-only, which is fine — this file runs on the server — but it is read
 * at *build* time, so it has to be in the build environment and not only the runtime one. On
 * Vercel that means the variable must be available to the Build step, not just to Functions.
 */
const PLACEHOLDER_HOSTS = ['cdn.example.com', 'example.com'];

function r2Host(): string | null {
  const url = process.env.R2_PUBLIC_URL?.trim();
  const bare = process.env.NEXT_PUBLIC_R2_PUBLIC_HOST?.trim();

  let hostname: string | undefined;
  if (url) {
    try {
      hostname = new URL(url).hostname;
    } catch {
      hostname = undefined;
    }
  }
  hostname ??= bare || undefined;

  if (!hostname || PLACEHOLDER_HOSTS.includes(hostname)) return null;
  return hostname;
}

/** The same host as a CSP source, or nothing to add. */
function r2Origin(): string[] {
  const host = r2Host();
  return host ? [`https://${host}`] : [];
}

/**
 * The PMTiles origin, if a deployment has a real one.
 *
 * `.env.example` ships `https://cdn.example.com/...` and a fresh clone copies it verbatim, so
 * the common case is a variable that is *set* and points nowhere. `components/map/basemap.ts`
 * rejects those hosts by name before offering the topo base at all; the same list is applied
 * here, because a CSP that allow-lists a placeholder is a CSP that has stopped describing the
 * deployment it is on.
 */
function pmtilesOrigin(): string[] {
  const raw = process.env.NEXT_PUBLIC_PMTILES_URL?.trim();
  if (!raw) return [];
  try {
    const { origin, hostname } = new URL(raw);
    return PLACEHOLDER_HOSTS.includes(hostname) ? [] : [origin];
  } catch {
    return [];
  }
}

/**
 * Content Security Policy.
 *
 * **Report-only, on purpose, and not yet finished.** It is here because `setRTLTextPlugin`
 * loads a script into a worker that inherits this origin and takes no integrity parameter —
 * that URL is same-origin now, and `script-src 'self'` is what keeps it that way if somebody
 * points it back at a CDN. But a CSP that is wrong breaks the map completely: MapLibre creates
 * its workers from `blob:`, the basemap talks to four hosts, and photographs come from three
 * more. Enforcing a first guess at that list is how a map goes blank in production for a
 * header nobody was watching. Report-only publishes the same rules with the browser reporting
 * instead of blocking, which is how the list gets finished honestly.
 *
 * **What has to happen before it can be enforced.** Next inlines the RSC payload as
 * `<script>self.__next_f.push(…)</script>`, and `script-src 'self'` does not permit an inline
 * script — so under this policy every page reports violations of its own framework. The fix is
 * a per-request nonce from a `middleware.ts`, which this app does not have; adding one is a
 * change to every request's cost and belongs in its own commit, not smuggled into a security
 * fix. Until then this header names the destination and the console says how far away it is.
 *
 * `frame-ancestors 'none'` with no allow-list. `/embed/map` is loaded by
 * `apps/mobile/src/components/explore-map.tsx` as a React Native `WebView` `source.uri` — a
 * top-level navigation in a browser view, not a frame — so `frame-ancestors` never applies to
 * it. Checked rather than assumed, because an allow-list added "just in case" is an allow-list
 * that outlives the reason for it.
 */
const CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  // The RTL shaper is ours now; nothing else may be. See `components/map/rtl.ts`.
  "script-src 'self'",
  // MapLibre builds its workers from a `blob:` URL. Without `blob:` there is no map at all.
  "worker-src 'self' blob:",
  // Tailwind emits a stylesheet, but `next/font` and MapLibre both set inline styles.
  "style-src 'self' 'unsafe-inline'",
  // Self-hosted at build time by `next/font`, so no third-party font origin is needed.
  "font-src 'self'",
  /*
   * Where pixels come from. `data:` and `blob:` are MapLibre's own — it decodes terrarium
   * tiles into canvases and hands them back as blobs. The named hosts are the basemap's
   * imagery, the terrain DEM, and the two photo sources seeded during ingest; R2's public
   * host is per-deployment and joins the list when it is configured.
   */
  [
    "img-src 'self' data: blob:",
    'https://tiles.openfreemap.org',
    'https://protomaps.github.io',
    'https://server.arcgisonline.com',
    'https://s3.amazonaws.com',
    'https://upload.wikimedia.org',
    'https://*.mapillary.com',
    ...r2Origin(),
  ].join(' '),
  /*
   * The same hosts as fetches rather than as images, because that is how MapLibre asks for
   * vector tiles, glyphs and the style JSON — and how a PMTiles archive is range-requested.
   * `NEXT_PUBLIC_PMTILES_URL` is a deployment's own bucket, so it is read from the same place
   * `basemap.ts` reads it.
   */
  [
    "connect-src 'self'",
    'https://tiles.openfreemap.org',
    'https://protomaps.github.io',
    'https://server.arcgisonline.com',
    'https://s3.amazonaws.com',
    'https://upload.wikimedia.org',
    'https://*.mapillary.com',
    ...pmtilesOrigin(),
    ...r2Origin(),
  ].join(' '),
].join('; ');
const config: NextConfig = {
  reactStrictMode: true,

  /** Inlined into the client bundle so `offline/caches.ts` and `sw.js` name the same cache. */
  env: { NEXT_PUBLIC_BUILD_ID: BUILD_ID },

  /**
   * A production build normally evicts whatever `next dev` has in `.next`, which is a problem
   * here for one specific reason: the service worker only registers in production, so the only
   * way to test offline is to build — and killing the dev server to do it defeats the point of
   * having it. Vercel never sets this, so the default holds everywhere that matters.
   */
  distDir: process.env.NEXT_DIST_DIR ?? '.next',

  /**
   * The workspace packages ship TypeScript source with no build step, so Next has to
   * compile them the same way it compiles `app/`. This is the whole reason there is no
   * `tsc --build` orchestration in this repo: one compiler, one pass, no stale `dist/`
   * to explain when a change does not appear.
   */
  transpilePackages: ['@switchback/api', '@switchback/core', '@switchback/db', '@switchback/geo'],

  /**
   * Prisma's client loads a native query engine at runtime. Bundling it produces a build
   * that works locally — where the engine happens to sit next to the output — and fails
   * on Vercel.
   */
  serverExternalPackages: ['@prisma/client', '@prisma/engines'],

  images: {
    remotePatterns: [
      // Wikimedia Commons and Mapillary, for photos seeded during ingest.
      { protocol: 'https', hostname: 'upload.wikimedia.org' },
      { protocol: 'https', hostname: '*.mapillary.com' },
      // User uploads, from the same host the CSP allow-lists — derived from `R2_PUBLIC_URL`
      // rather than read only from `NEXT_PUBLIC_R2_PUBLIC_HOST`, so the two cannot disagree.
      ...(r2Host() ? [{ protocol: 'https' as const, hostname: r2Host() as string }] : []),
    ],
  },

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          // The map needs precise location; nothing here needs a camera or a microphone.
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(self)' },
          // Report-only until a nonce exists for Next's inlined RSC payload. See `CSP` above.
          { key: 'Content-Security-Policy-Report-Only', value: CSP },
          /*
           * `frame-ancestors` is the one directive a report-only policy cannot enforce, and it
           * is also the one with no map to break — nothing in this product is framed, and the
           * iOS map is a top-level `WebView` navigation rather than a frame. So it ships as a
           * header of its own, enforcing, today. `X-Frame-Options` rather than a second
           * enforcing CSP because it is the narrower statement and every browser honours it.
           */
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
      /*
       * A Lifeline link is a bearer credential for somebody's position, and it travels in the
       * URL because it has to — it gets pasted into a message to one person. That makes three
       * things non-negotiable on this path.
       *
       * `X-Robots-Tag` because a crawler that indexed one of these would publish a hiker's
       * location and, worse, the link itself; the page carries a `robots` meta too, and both
       * exist because the header covers the case where nothing renders.
       *
       * `no-referrer` because every outbound link on the page — the attribution, the trail —
       * would otherwise hand the destination a URL containing the token. The site-wide policy
       * already truncates cross-origin referrers to the origin, but "already safe" is not the
       * standard to apply to a credential.
       *
       * `no-store` because a shared cache holding a rendered position page would serve one
       * person's whereabouts to whoever asked next.
       */
      {
        source: '/lifeline/:token*',
        headers: [
          { key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'Cache-Control', value: 'private, no-store, max-age=0' },
        ],
      },
    ];
  },
};

export default config;
