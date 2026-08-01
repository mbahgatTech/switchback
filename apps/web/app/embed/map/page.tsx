import type { Metadata } from 'next';
import { UNIT_SYSTEMS, type UnitSystem } from '@switchback/core';
import { type BasemapId, availableBasemaps } from '@/components/map/basemap';
import { EmbedMapClient } from '@/components/map/embed-map-client';

/**
 * The map the iOS app loads into a `WebView`, so the phone and the website draw the same
 * cartography from the same code without a native build. Search params carry only what must be
 * known before the first frame; everything after arrives over `map-bridge` in `@switchback/core`.
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
      // Snowdon, and the last hard-coded opening view on the website — kept deliberately. This
      // route is a WebView with no session and no cookie, so it has no `lib/place.ts` answer to
      // derive from; the phone overrides it whenever it has a fix.
      initialCenter={lng !== null && lat !== null ? [lng, lat] : [-4.05, 53.07]}
      initialZoom={zoom !== null ? zoom : 11}
      initialBasemap={basemapId(params.basemap)}
      initialHillshade={params.hillshade !== '0'}
      // Summit heights are the one figure this map prints, and it sits outside the provider every
      // other screen reads units from — so the host passes them.
      initialUnits={unitSystem(params.units)}
      // `trails=0` is the map on a finished hike: one line over the bridge, no viewport search.
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
 * Narrowed against the bases this deployment actually has: `availableBasemaps` drops any whose
 * tiles are unconfigured, and asking MapLibre for a style it cannot build is a blank canvas.
 */
function basemapId(value: string | undefined): BasemapId {
  const bases = availableBasemaps();
  const match = bases.find((base) => base.id === value);
  return match?.id ?? bases[0]?.id ?? 'relief';
}

/** Metric unless the host says otherwise — the same fallback a signed-out reader gets. */
function unitSystem(value: string | undefined): UnitSystem {
  return UNIT_SYSTEMS.find((system) => system === value) ?? 'metric';
}
