/**
 * Single source of product identity. Renaming the product means editing this file
 * and nothing else — no string literals of the name live anywhere in the codebase.
 */
export const BRAND = {
  name: 'Switchback',
  tagline: 'Know the trail before you hike it.',
  domain: 'switchback.app',
  /** Sent as the User-Agent contact on every outbound OSM/Overpass request. */
  contactUrl: 'https://switchback.app/attribution',
  supportEmail: 'support@switchback.app',
} as const;

/**
 * Attribution is a licence obligation, not a courtesy. OSM is ODbL (attribution +
 * share-alike on derived databases); Open-Meteo and the terrain DEMs are CC-BY.
 * Every surface that renders map or trail data renders these.
 */
export const ATTRIBUTION = {
  osm: {
    label: '© OpenStreetMap contributors',
    href: 'https://www.openstreetmap.org/copyright',
    licence: 'ODbL 1.0',
  },
  openMeteo: {
    label: 'Weather by Open-Meteo',
    href: 'https://open-meteo.com/',
    licence: 'CC BY 4.0',
  },
  terrain: {
    label: 'Elevation: Mapzen Terrain Tiles / Copernicus DEM',
    href: 'https://github.com/tilezen/joerd/blob/master/docs/attribution.md',
    licence: 'CC BY 4.0 / public domain (varies by source tile)',
  },
  protomaps: {
    label: 'Basemap © Protomaps',
    href: 'https://protomaps.com/',
    licence: 'BSD-3-Clause',
  },
  openFreeMap: {
    label: 'Names and reference © OpenFreeMap / OpenMapTiles',
    href: 'https://openfreemap.org/',
    licence: 'ODbL 1.0 (data) / BSD-3-Clause (schema)',
  },
  esriImagery: {
    label: 'Imagery © Esri, Maxar, Earthstar Geographics',
    href: 'https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9',
    licence: 'Esri terms of use',
  },
} as const;

export type AttributionKey = keyof typeof ATTRIBUTION;

export interface AttributionSource {
  key: AttributionKey;
  /** What this source puts on the screen, named the way a reader would name it. */
  what: string;
  /** How it is used here — the part a licence link cannot tell anybody. */
  detail: string;
}

/**
 * The credits page, as content rather than markup. Here because both clients publish it and a
 * licence statement that says one thing on the web and another in the app is not a formatting
 * inconsistency — under ODbL and CC-BY it is one of them being wrong.
 */
export const ATTRIBUTION_SOURCES: readonly AttributionSource[] = [
  {
    key: 'osm',
    what: 'Trails, paths, names, access tags, parking',
    detail:
      'Every route in this product is assembled from OpenStreetMap ways and relations, fetched per map tile as you browse. Under ODbL, any database we derive from it carries the same licence.',
  },
  {
    key: 'terrain',
    what: 'Elevation, gain and loss, hillshade, relief tint',
    detail:
      'Terrarium-encoded terrain tiles, resampled every 25 m along each trail. The same tiles draw the shaded relief base, so the ground you see and the climb we publish come from one set of pixels.',
  },
  {
    key: 'esriImagery',
    what: 'Satellite base map',
    detail: 'Shown only when you switch the sheet to Satellite.',
  },
  {
    key: 'openFreeMap',
    what: 'Place names, water, roads and named summits',
    detail:
      'An OpenMapTiles build of OpenStreetMap, served by OpenFreeMap without a key. Relief is rendered from elevation and satellite is a photograph, so neither carries a word of its own — the names on every sheet come from here.',
  },
  {
    key: 'protomaps',
    what: 'Vector topographic base map',
    detail: 'Shown when a Protomaps archive is configured for this deployment.',
  },
  {
    key: 'openMeteo',
    what: 'Weather along the trail',
    detail:
      'Forecasts are requested for sample points along the route at the hour you are predicted to reach each one, with our own DEM elevations passed in for downscaling.',
  },
] as const;

/**
 * The correction notice, shared for the same reason the sources are. Split in two because the
 * clients set them differently, but the words are the obligation and are identical.
 */
export const ATTRIBUTION_CORRECTIONS = {
  upstream:
    'A trail in the wrong place, a missing path, a bad name — the fix belongs upstream in OpenStreetMap, where it reaches every map that uses the data rather than just this one. Our cache re-reads each tile every 30 days, so an edit there arrives here on its own.',
  osmHref: 'https://www.openstreetmap.org/fixthemap',
} as const;
