import type { Metadata } from 'next';
import { BRAND } from '@switchback/core';
import { ExploreShell } from '@/components/explore/explore-shell';

/**
 * Explore — the alias.
 *
 * The map moved to `/`, and this route stays because the address is in the wild: shared links
 * carrying a camera and a trail id, the old manifest `start_url` sitting in installed apps,
 * bookmarks. It renders the identical shell rather than redirecting, for two reasons. A
 * redirect costs a shared link an extra round trip on the connection least able to afford one,
 * and the production smoke test in `.github/workflows/ci.yml` reads `%{http_code}` off the
 * first response with no `-L` — so a 307 here is a red pipeline for a site that works.
 *
 * `robots` is the whole difference from the front page. Two URLs serving byte-identical markup
 * is a duplicate, and this is the copy that should lose. `alternates.canonical` is the textbook
 * answer and the wrong one here: there is no `metadataBase` anywhere in this app, so a relative
 * canonical resolves against Next's fallback origin and warns at build. `robots` costs nothing
 * and matches `app/embed/map/page.tsx`, which is non-indexable for the same reason.
 */

export const metadata: Metadata = {
  title: 'Explore',
  description: `Browse trails on a shaded relief sheet. ${BRAND.tagline}`,
  robots: { index: false, follow: true },
};

export default function ExplorePage() {
  return <ExploreShell atHome={false} />;
}
