import type { Metadata } from 'next';
import { BRAND } from '@switchback/core';
import { ExploreShell } from '@/components/explore/explore-shell';

/**
 * The front page is the map.
 *
 * It was a list of hikes nearest the reader, which was right about one thing and wrong about
 * another. Right that a front page should be the product rather than a pitch for it; wrong
 * that the product's first question is "where are you". A list of nearby trails cannot say
 * anything at all until it is told a location, so the first thing the front page did was ask —
 * and the thing it was asking on behalf of was the map, one click further on.
 *
 * So the map is the page. It has an answer before it is told anything, it is the screen this
 * product is for, and it is what the installed app cold-launches into. The list it displaced
 * is at `/nearby`, reached from the neatline.
 *
 * Not `async`, because there is nothing to await here — the shell does its own session read,
 * and an `async` wrapper with no `await` in it is a lint failure rather than a style.
 */

export const metadata: Metadata = {
  /*
   * `absolute`, because `app/layout.tsx` sets the template `%s · Switchback` and the front
   * page is the one page that must not read as a section of something else.
   */
  title: { absolute: BRAND.name },
  description: `Browse trails on a shaded relief sheet. ${BRAND.tagline}`,
};

export default function HomePage() {
  return <ExploreShell atHome />;
}
