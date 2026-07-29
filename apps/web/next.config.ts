import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,

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
      // User uploads. R2's public bucket hostname is set per environment.
      ...(process.env.NEXT_PUBLIC_R2_PUBLIC_HOST
        ? [{ protocol: 'https' as const, hostname: process.env.NEXT_PUBLIC_R2_PUBLIC_HOST }]
        : []),
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
