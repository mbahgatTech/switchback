import type { Metadata } from 'next';
import { UNIT_SYSTEMS, type UnitSystem } from '@switchback/core';
import { type BasemapId, availableBasemaps } from '@/components/map/basemap';
import { EmbedMapClient } from '@/components/map/embed-map-client';

/**
 * The map the iOS app loads into a `WebView`.
 *
 * Not a page anyone visits. It exists so the phone and the website draw the same cartography
 * from the same code — `buildStyle` and the trail layers are written once and this route is
 * how the app reaches them without a native build, which would need a Mac we do not have.
 * See `map-bridge` in `@switchback/core` for the channel it talks over.
 *
 * The root layout has no chrome, so this renders full-bleed with nothing to escape. Search
 * params carry only what has to be known before the first frame: where to open, and which
 * base. Everything after that arrives over the bridge.
 */

export const metadata: Metadata = {
  title: 'Map',
  // Nothing here reads as a page to a person who lands on it, and it duplicates /explore.
  robots: { index: false, follow: false },
};

export default async function EmbedMapPage({
  searchParams,
}: {
  searchParams: Promise<{
    lng?: string;
    lat?: string;
    zoom?: string;
    basemap?: string;
    hillshade?: string;
    trails?: string;
    units?: string;
  }>;
}) {
  const params = await searchParams;

  const lng = finite(params.lng);
  const lat = finite(params.lat);
  const zoom = finite(params.zoom);

  return (
    <EmbedMapClient
      // Snowdon, and this is now the last hard-coded opening view left on the website — kept
      // deliberately. The website's own map derives its centre from the reader's cookie and
      // edge headers (`lib/place.ts`), and this route has neither: it is a WebView with no
      // session, driven entirely by the `lng`/`lat` the phone passes in. So this is not a
      // stale copy of a default that moved; it is the floor for a first run where the phone
      // has no last known fix to send, and the phone overrides it whenever it has one.
      initialCenter={lng !== null && lat !== null ? [lng, lat] : [-4.05, 53.07]}
      initialZoom={zoom !== null ? zoom : 11}
      initialBasemap={basemapId(params.basemap)}
      initialHillshade={params.hillshade !== '0'}
      // Summit heights are the one figure this map prints, and it is outside the provider
      // every other screen reads units from — so the host puts them here. See `EmbedMap`.
      initialUnits={unitSystem(params.units)}
      // `trails=0` is the map on a finished hike: one line, handed over the bridge, and no
      // viewport search at all. Everything else browses.
      browse={params.trails !== '0'}
    />
  );
}

/** A query string is a string. Anything that is not a real number is simply absent. */
function finite(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Narrowed against the bases this deployment actually has.
 *
 * `availableBasemaps` drops any base whose tiles are not configured, and asking MapLibre for
 * a style it cannot build is a blank canvas with an error in a console nobody can open. The
 * first available one is always a safe answer.
 */
function basemapId(value: string | undefined): BasemapId {
  const bases = availableBasemaps();
  const match = bases.find((base) => base.id === value);
  return match?.id ?? bases[0]?.id ?? 'relief';
}

/**
 * Metric unless the host says otherwise — the same fallback the formatters take, and the
 * same one a signed-out reader gets on the website. An unrecognised value is a phone running
 * a build that disagrees with this one, and guessing at it would be worse than defaulting.
 */
function unitSystem(value: string | undefined): UnitSystem {
  return UNIT_SYSTEMS.find((system) => system === value) ?? 'metric';
}
