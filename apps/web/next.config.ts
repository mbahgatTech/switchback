import { randomUUID } from 'node:crypto';
import type { NextConfig } from 'next';

/**
 * This build, as one string the whole app agrees on: the service worker's shell cache is named
 * after it. Falls back to a random per-build value, because two builds sharing a cache name is
 * exactly the collision the scheme exists to avoid.
 */
const BUILD_ID =
  process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) ??
  process.env.GITHUB_SHA?.slice(0, 12) ??
  randomUUID().slice(0, 12);

/**
 * Hosts that mean "not configured" — `.env.example` ships these verbatim, and a CSP that
 * allow-lists a placeholder has stopped describing the deployment it is on. Same list as
 * `components/map/basemap.ts`, which rejects them before offering the topo base: the two must agree.
 */
const PLACEHOLDER_HOSTS = ['cdn.example.com', 'example.com'];

/**
 * The origin user-uploaded photographs come from. `R2_PUBLIC_URL` first — it is the validated
 * variable a configured deployment must have, whereas `NEXT_PUBLIC_R2_PUBLIC_HOST` is an optional
 * scheme-less spelling. Read at *build* time, so it must be in the Vercel Build environment too.
 */
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

/** The deployment's own PMTiles origin, or nothing when the URL is unset or a placeholder. */
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
 * Content Security Policy. **Report-only until a nonce exists** — Next inlines the RSC payload
 * as `<script>self.__next_f.push(…)</script>`, which `script-src 'self'` forbids, so enforcing
 * this today reports every page against its own framework. A nonce needs a `middleware.ts` this
 * app does not have. `frame-ancestors 'none'` carries no allow-list on purpose: `/embed/map` is
 * a top-level `WebView` navigation from the iOS app, not a frame.
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
  // `data:` and `blob:` are MapLibre's own — it hands decoded terrarium tiles back as blobs.
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
  // The same hosts as fetches: vector tiles, glyphs, style JSON and PMTiles range requests.
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

  /**
   * The only inlined variable. `NEXT_PUBLIC_*` values are baked into the client bundle and reach
   * the browser, so nothing secret may ever be added here. This one lets `offline/caches.ts` and
   * `sw.js` name the same cache.
   */
  env: { NEXT_PUBLIC_BUILD_ID: BUILD_ID },

  /**
   * A production build would otherwise evict what `next dev` has in `.next`, and the service
   * worker only registers in production — so testing offline would mean killing the dev server.
   * Vercel never sets this.
   */
  distDir: process.env.NEXT_DIST_DIR ?? '.next',

  /**
   * The workspace packages ship TypeScript source with no build step, so Next compiles them the
   * same way it compiles `app/`. One compiler, one pass, no stale `dist/` to explain.
   */
  transpilePackages: ['@switchback/api', '@switchback/core', '@switchback/db', '@switchback/geo'],

  /**
   * Prisma loads a native query engine at runtime. Bundling it builds fine locally, where the
   * engine happens to sit next to the output, and fails on Vercel.
   */
  serverExternalPackages: ['@prisma/client', '@prisma/engines'],

  images: {
    remotePatterns: [
      // Wikimedia Commons and Mapillary, for photos seeded during ingest.
      { protocol: 'https', hostname: 'upload.wikimedia.org' },
      { protocol: 'https', hostname: '*.mapillary.com' },
      // User uploads, from the same host the CSP allow-lists, so the two cannot disagree.
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
          // `frame-ancestors` is the one directive report-only cannot enforce, and nothing here
          // is framed — so it ships enforcing, as the narrower header every browser honours.
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
      /*
       * A Lifeline link is a bearer credential for somebody's position and it travels in the URL,
       * so this path gets three headers the rest of the site does not: `X-Robots-Tag` (a crawler
       * would publish both the hiker's location and the link), `no-referrer` (every outbound link
       * on the page would otherwise hand the destination the token), and `no-store` (a shared
       * cache would serve one person's whereabouts to whoever asked next).
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
