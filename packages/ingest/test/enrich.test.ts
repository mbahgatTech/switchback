import { describe, expect, it } from 'vitest';
import type { LngLat } from '@switchback/core';
import {
  PARKING_BUFFER_M,
  attachWaypoints,
  classifyTerminus,
  classifyWaypoint,
  featureSearchBBox,
  fetchCommonsPhotos,
  fetchMapillaryPhotos,
  fetchSeedPhotos,
  fileNameOf,
  parkingCapacity,
  parseEleM,
  synthesiseTrailhead,
} from '../src/enrich';
import type { EnrichedWaypoint } from '../src/enrich';
import type { OverpassElement } from '../src/overpass';

const M_PER_DEG_LAT = 111_320;
const m = (metres: number): number => metres / M_PER_DEG_LAT;
/** East-west, where a degree is only cos(lat) as wide — at 56.8° that is a little over half. */
const mLng = (metres: number): number =>
  metres / (M_PER_DEG_LAT * Math.cos((56.8 * Math.PI) / 180));

/** A 2 km line running due north from 56.80. */
const LINE: LngLat[] = Array.from({ length: 21 }, (_, i) => [-4, 56.8 + m(i * 100)]);

function node(id: number, at: LngLat, tags: Record<string, string>): OverpassElement {
  return { type: 'node', id, lon: at[0], lat: at[1], tags };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('classifyWaypoint', () => {
  it('maps the common tags to our vocabulary', () => {
    expect(classifyWaypoint({ natural: 'peak' })).toBe('summit');
    expect(classifyWaypoint({ tourism: 'viewpoint' })).toBe('viewpoint');
    expect(classifyWaypoint({ waterway: 'waterfall' })).toBe('waterfall');
    expect(classifyWaypoint({ amenity: 'parking' })).toBe('parking');
    expect(classifyWaypoint({ tourism: 'alpine_hut' })).toBe('shelter');
    expect(classifyWaypoint({ barrier: 'stile' })).toBe('gate');
    expect(classifyWaypoint({ information: 'guidepost' })).toBe('junction');
  });

  it('resolves overlapping tags in favour of the more useful label', () => {
    // Both spring and drinking water; a thirsty hiker wants "water", not "spring".
    expect(classifyWaypoint({ natural: 'spring', amenity: 'drinking_water' })).toBe('water');
  });

  it('maps the destination tags the display name needs', () => {
    expect(classifyWaypoint({ natural: 'hill' })).toBe('summit');
    expect(classifyWaypoint({ natural: 'saddle' })).toBe('pass');
    expect(classifyWaypoint({ mountain_pass: 'yes' })).toBe('pass');
    expect(classifyWaypoint({ natural: 'glacier' })).toBe('glacier');
  });

  it('keeps the naming-only kinds out of the terminus vocabulary', () => {
    // `classifyTerminus` decides whether a line is doubled. A hill classifies as `summit`,
    // which `TERMINAL_DESTINATIONS` holds, so answering here would republish 5 km as 10 km.
    expect(classifyTerminus({ natural: 'peak' })).toBe('summit');
    expect(classifyTerminus({ natural: 'hill' })).toBeNull();
    expect(classifyTerminus({ natural: 'saddle' })).toBeNull();
    expect(classifyTerminus({ natural: 'glacier' })).toBeNull();
    // Everything else answers exactly as it always did.
    expect(classifyTerminus({ amenity: 'parking' })).toBe('parking');
    expect(classifyTerminus({ waterway: 'waterfall' })).toBe('waterfall');
  });

  it('does not let the new rules steal from the ones above them', () => {
    // Appended last, so a col that is also a signposted overlook keeps the older label.
    expect(classifyWaypoint({ natural: 'saddle', tourism: 'viewpoint' })).toBe('viewpoint');
    expect(classifyWaypoint({ natural: 'hill', amenity: 'parking' })).toBe('parking');
  });

  it('does not call a river a lake', () => {
    expect(classifyWaypoint({ natural: 'water', water: 'river' })).toBeNull();
    expect(classifyWaypoint({ natural: 'water', water: 'lake' })).toBe('lake');
  });

  it('returns null for a node with nothing we recognise', () => {
    expect(classifyWaypoint({ amenity: 'bench' })).toBeNull();
    expect(classifyWaypoint({})).toBeNull();
  });
});

describe('parseEleM', () => {
  it('reads the metres OSM writes', () => {
    expect(parseEleM('1836')).toBe(1836);
    expect(parseEleM('1836.4')).toBe(1836.4);
    expect(parseEleM(' 1836 m')).toBe(1836);
    expect(parseEleM('-12')).toBe(-12);
  });

  it('refuses anything it would have to guess at', () => {
    // A wrong peak height publishes a title; an absent one falls back to the weaker test.
    expect(parseEleM('6000 ft')).toBeNull();
    expect(parseEleM('1,836')).toBeNull();
    expect(parseEleM('approx 1800')).toBeNull();
    expect(parseEleM('12000')).toBeNull();
    expect(parseEleM(undefined)).toBeNull();
  });
});

describe('attachWaypoints', () => {
  it('places a feature by its distance along the trail', () => {
    const summit = node(1, [-4, 56.8 + m(2000)], { natural: 'peak', name: 'Meall Buidhe' });
    const [waypoint] = attachWaypoints(LINE, [summit]);

    expect(waypoint!.kind).toBe('summit');
    expect(waypoint!.name).toBe('Meall Buidhe');
    expect(waypoint!.distM).toBeGreaterThan(1900);
    expect(waypoint!.offsetM).toBeLessThan(5);
    expect(waypoint!.osmType).toBe('node');
  });

  it('drops features beyond the buffer', () => {
    const far = node(2, [-4 + mLng(400), 56.81], { tourism: 'viewpoint' });
    expect(attachWaypoints(LINE, [far])).toHaveLength(0);
  });

  it("carries the peak's own height, which the trail's elevation cannot supply", () => {
    const bare = node(5, [-4, 56.8 + m(1000)], { natural: 'peak', name: 'Beinn Dubh' });
    const tagged = node(4, [-4, 56.8 + m(2000)], { natural: 'peak', name: 'Ben Vane', ele: '916' });
    // Sorted along the trail, so the nearer peak comes first.
    const [near, far] = attachWaypoints(LINE, [tagged, bare]);

    expect(near!.osmEleM).toBeNull();
    expect(far!.osmEleM).toBe(916);
  });

  it('gives parking a wider radius, because the car park is up an access road', () => {
    const carPark = node(3, [-4 + mLng(300), 56.8], { amenity: 'parking', capacity: '25' });
    const attached = attachWaypoints(LINE, [carPark]);

    expect(attached).toHaveLength(1);
    // Off the line, so it has no honest "distance along" — the elevation chart would
    // otherwise plot it at 0 m as though you hiked through it.
    expect(attached[0]!.distM).toBeNull();
    expect(attached[0]!.offsetM).toBeGreaterThan(250);
  });

  it('reads a way centre when the feature is an area', () => {
    const area: OverpassElement = {
      type: 'way',
      id: 4,
      center: { lon: -4, lat: 56.8 + m(500) },
      tags: { amenity: 'parking', capacity: '40' },
    };
    const [waypoint] = attachWaypoints(LINE, [area]);
    expect(waypoint!.osmType).toBe('way');
    expect(waypoint!.kind).toBe('parking');
  });

  it('ignores an area element, which carries no position', () => {
    const areaResult: OverpassElement = { type: 'area', id: 5, tags: { natural: 'peak' } };
    expect(attachWaypoints(LINE, [areaResult])).toHaveLength(0);
  });

  it('deduplicates a feature tagged on both a node and its area', () => {
    const at: LngLat = [-4, 56.8 + m(1000)];
    const attached = attachWaypoints(LINE, [
      node(6, at, { natural: 'peak', name: 'Cairn' }),
      {
        type: 'way',
        id: 7,
        center: { lon: at[0], lat: at[1] },
        tags: { natural: 'peak', name: 'Cairn' },
      },
    ]);
    expect(attached).toHaveLength(1);
  });

  it('orders waypoints along the hike, with off-trail features last', () => {
    const attached = attachWaypoints(LINE, [
      node(10, [-4, 56.8 + m(1500)], { tourism: 'viewpoint' }),
      node(11, [-4 + mLng(300), 56.8], { amenity: 'parking' }),
      node(12, [-4, 56.8 + m(300)], { barrier: 'gate' }),
    ]);
    expect(attached.map((w) => w.kind)).toEqual(['gate', 'viewpoint', 'parking']);
  });

  it('returns nothing for a degenerate line', () => {
    expect(attachWaypoints([[-4, 56.8]], [node(1, [-4, 56.8], { natural: 'peak' })])).toEqual([]);
  });
});

describe('synthesiseTrailhead', () => {
  it('marks the start of the line at zero', () => {
    const trailhead = synthesiseTrailhead(LINE)!;
    expect(trailhead.kind).toBe('trailhead');
    expect(trailhead.distM).toBe(0);
    expect([trailhead.lng, trailhead.lat]).toEqual(LINE[0]);
    // osmId 0 marks it as ours, not something we are attributing to a mapper.
    expect(trailhead.osmId).toBe(0);
  });

  it('returns null for an empty line', () => {
    expect(synthesiseTrailhead([])).toBeNull();
  });
});

describe('parkingCapacity', () => {
  const parking = (capacity?: string): EnrichedWaypoint => ({
    kind: 'parking',
    name: null,
    lng: -4,
    lat: 56.8,
    distM: null,
    offsetM: 100,
    osmEleM: null,
    osmType: 'node',
    osmId: 1,
    tags: capacity ? { amenity: 'parking', capacity } : { amenity: 'parking' },
  });

  it('sums what is tagged', () => {
    expect(parkingCapacity([parking('25'), parking('15')])).toBe(40);
  });

  it('returns null rather than 0 when nothing is tagged', () => {
    // The busyness model treats "no spaces" and "unknown" very differently.
    expect(parkingCapacity([parking()])).toBeNull();
    expect(parkingCapacity([])).toBeNull();
  });

  it('ignores nonsense values', () => {
    expect(parkingCapacity([parking('plenty'), parking('12')])).toBe(12);
  });
});

describe('featureSearchBBox', () => {
  it('pads by the parking radius so the car park is inside the search', () => {
    const padded = featureSearchBBox([-4, 56.8, -3.9, 56.9]);
    expect(padded[0]).toBeLessThan(-4);
    expect(padded[3]).toBeGreaterThan(56.9);
    expect((padded[3] - 56.9) * M_PER_DEG_LAT).toBeCloseTo(PARKING_BUFFER_M, -1);
  });
});

/**
 * What `imageinfo` appends to every `url` and `thumburl`. Reproduced verbatim from a live
 * geosearch response, because a paraphrase of it is what let this ship.
 */
const CAMPAIGN = '?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=original';

describe('fileNameOf', () => {
  it('reads the name out of a plain URL', () => {
    expect(fileNameOf('https://upload.wikimedia.org/wikipedia/commons/8/8e/Ben_Nevis.jpg')).toBe(
      'Ben_Nevis.jpg',
    );
  });

  it('drops the campaign parameters Commons appends', () => {
    expect(fileNameOf(`https://upload.wikimedia.org/a/bc/Ben_Nevis.jpg${CAMPAIGN}`)).toBe(
      'Ben_Nevis.jpg',
    );
  });

  it('does not read a file name out of a query string or a fragment', () => {
    // A `.jpg` sitting in a parameter's value must not make a PDF look like a photograph.
    expect(fileNameOf('https://example.test/scan.pdf?preview=thumb.jpg')).toBe('scan.pdf');
    expect(fileNameOf('https://example.test/plan.svg#Ben_Nevis.jpg')).toBe('plan.svg');
  });
});

describe('fetchCommonsPhotos', () => {
  const page = {
    pageid: 123,
    title: 'File:Ben Nevis.jpg',
    imageinfo: [
      {
        url: 'https://upload.wikimedia.org/ben-nevis.jpg',
        thumburl: 'https://upload.wikimedia.org/thumb/ben-nevis.jpg',
        width: 4000,
        height: 3000,
        descriptionurl: 'https://commons.wikimedia.org/wiki/File:Ben_Nevis.jpg',
        extmetadata: {
          LicenseShortName: { value: 'CC BY-SA 4.0' },
          Artist: { value: '<a href="/wiki/User:Someone">A. Photographer</a>' },
        },
      },
    ],
    coordinates: [{ lat: 56.797, lon: -5.003 }],
    // Every real geosearch response carries these, and the subject test reads them. A fixture
    // without them describes a response Commons does not send.
    categories: [{ title: 'Category:Ben Nevis' }, { title: 'Category:Mountains of Scotland' }],
  };

  it('maps a geosearch result onto our photo shape', async () => {
    const photos = await fetchCommonsPhotos([-5, 56.8], 2000, {
      fetchImpl: (async () =>
        jsonResponse({ query: { pages: [page] } })) as unknown as typeof fetch,
    });

    expect(photos).toHaveLength(1);
    expect(photos[0]!.source).toBe('wikimedia');
    expect(photos[0]!.externalId).toBe('123');
    expect(photos[0]!.license).toBe('CC BY-SA 4.0');
    // extmetadata values are HTML fragments; the credit line must not carry markup.
    expect(photos[0]!.attribution).toBe('A. Photographer');
  });

  it('asks for the file namespace and clamps the radius to the API limit', async () => {
    let requested = '';
    await fetchCommonsPhotos([-5, 56.8], 50_000, {
      fetchImpl: (async (url: string) => {
        requested = String(url);
        return jsonResponse({ query: { pages: [] } });
      }) as unknown as typeof fetch,
    });

    const params = new URL(requested).searchParams;
    expect(params.get('ggsnamespace')).toBe('6');
    expect(params.get('ggsradius')).toBe('10000');
    // lat|lon, which is the transposition of our own coordinate order.
    expect(params.get('ggscoord')).toBe('56.8|-5');
  });

  it('skips maps and diagrams, which Commons hosts alongside photographs', async () => {
    const svg = {
      ...page,
      pageid: 9,
      imageinfo: [{ url: 'https://upload.wikimedia.org/plan.svg' }],
    };
    const photos = await fetchCommonsPhotos([-5, 56.8], 2000, {
      fetchImpl: (async () => jsonResponse({ query: { pages: [svg] } })) as unknown as typeof fetch,
    });
    expect(photos).toEqual([]);
  });

  it('keeps a photograph whose URL carries the campaign parameters imageinfo appends', async () => {
    // Commons stopped returning bare file URLs. Every `url` and `thumburl` now ends in a query
    // string, so a file-type guard reading the whole URL rejects the entire response — which is
    // what left 17,753 trails with no photograph while every enrich job recorded success.
    const tagged = {
      ...page,
      imageinfo: [
        {
          ...page.imageinfo[0],
          url: `https://upload.wikimedia.org/ben-nevis.jpg${CAMPAIGN}`,
          thumburl: `https://upload.wikimedia.org/thumb/ben-nevis.jpg${CAMPAIGN}`,
        },
      ],
    };
    const photos = await fetchCommonsPhotos([-5, 56.8], 2000, {
      fetchImpl: (async () =>
        jsonResponse({ query: { pages: [tagged] } })) as unknown as typeof fetch,
    });

    expect(photos).toHaveLength(1);
    // Stored as Commons returned it: nothing downstream reads the path, and rewriting an
    // upstream URL needs a better reason than tidiness.
    expect(photos[0]!.url).toBe(`https://upload.wikimedia.org/ben-nevis.jpg${CAMPAIGN}`);
  });

  it('still skips a diagram when the campaign parameters are present', async () => {
    // The fix must widen the guard, not remove it.
    const svg = {
      ...page,
      pageid: 9,
      imageinfo: [{ url: `https://upload.wikimedia.org/plan.svg${CAMPAIGN}` }],
    };
    const photos = await fetchCommonsPhotos([-5, 56.8], 2000, {
      fetchImpl: (async () => jsonResponse({ query: { pages: [svg] } })) as unknown as typeof fetch,
    });
    expect(photos).toEqual([]);
  });

  it('drops the Earth as seen from orbit, which geosearch returns as a local photograph', async () => {
    // Geosearch answers "what is tagged with coordinates near here", and an astronaut's
    // frame of the Cascades is tagged with the coordinates of the Cascades. Dropped on its
    // category, so a commercial operator's scene goes the same way as a NASA one.
    const fromSpace = {
      ...page,
      pageid: 42,
      title: 'File:ISS042-E-107916 - View of Earth.jpg',
      imageinfo: [
        {
          url: 'https://upload.wikimedia.org/wikipedia/commons/4/4d/ISS042-E-107916_-_View_of_Earth.jpg',
          extmetadata: { Artist: { value: 'NASA Johnson' } },
        },
      ],
      categories: [{ title: 'Category:ISS Expedition 42 Crew Earth Observations (dump)' }],
    };
    const photos = await fetchCommonsPhotos([-5, 56.8], 2000, {
      fetchImpl: (async () =>
        jsonResponse({ query: { pages: [fromSpace, page] } })) as unknown as typeof fetch,
    });

    // The photograph taken from the ground survives; the one taken from 400 km up does not.
    expect(photos.map((photo) => photo.externalId)).toEqual(['123']);
  });

  it('returns empty rather than throwing when Commons is down', async () => {
    // Enrichment is decoration. An outage must not cost a tile of correct trails.
    await expect(
      fetchCommonsPhotos([-5, 56.8], 2000, {
        fetchImpl: (async () => {
          throw new Error('ECONNRESET');
        }) as unknown as typeof fetch,
      }),
    ).resolves.toEqual([]);

    await expect(
      fetchCommonsPhotos([-5, 56.8], 2000, {
        fetchImpl: (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch,
      }),
    ).resolves.toEqual([]);
  });
});

describe('fetchMapillaryPhotos', () => {
  it('degrades to empty without a token instead of breaking the pipeline', async () => {
    let called = false;
    const photos = await fetchMapillaryPhotos([-5, 56.8, -4.9, 56.9], undefined, {
      fetchImpl: (async () => {
        called = true;
        return jsonResponse({ data: [] });
      }) as unknown as typeof fetch,
    });
    expect(photos).toEqual([]);
    expect(called).toBe(false);
  });

  it('records the licence Mapillary publishes under', async () => {
    const photos = await fetchMapillaryPhotos([-5, 56.8, -4.9, 56.9], 'token', {
      fetchImpl: (async () =>
        jsonResponse({
          data: [
            {
              id: 'abc',
              thumb_1024_url: 'https://mapillary.test/1024.jpg',
              thumb_2048_url: 'https://mapillary.test/2048.jpg',
              computed_geometry: { coordinates: [-4.95, 56.85] },
            },
          ],
        })) as unknown as typeof fetch,
    });

    expect(photos[0]!.license).toBe('CC BY-SA 4.0');
    expect(photos[0]!.attribution).toBe('Mapillary contributors');
    expect(photos[0]!.url).toBe('https://mapillary.test/2048.jpg');
    expect(photos[0]!.lng).toBe(-4.95);
  });
});

describe('fetchSeedPhotos', () => {
  const commonsPages = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      pageid: i,
      title: `File:${i}.jpg`,
      imageinfo: [{ url: `https://upload.wikimedia.org/${i}.jpg` }],
      categories: [{ title: 'Category:Mountains of Scotland' }],
    }));

  it('does not call Mapillary when Commons already has enough', async () => {
    const urls: string[] = [];
    const photos = await fetchSeedPhotos(
      { centroid: [-5, 56.8], bbox: [-5, 56.8, -4.9, 56.9], lengthM: 8000 },
      {
        mapillaryToken: 'token',
        fetchImpl: (async (url: string) => {
          urls.push(String(url));
          return jsonResponse({ query: { pages: commonsPages(4) } });
        }) as unknown as typeof fetch,
      },
    );

    expect(photos).toHaveLength(4);
    expect(urls.every((u) => u.includes('commons.wikimedia.org'))).toBe(true);
  });

  it('falls back to Mapillary when Commons comes back thin', async () => {
    const hosts: string[] = [];
    const photos = await fetchSeedPhotos(
      { centroid: [-5, 56.8], bbox: [-5, 56.8, -4.9, 56.9], lengthM: 8000 },
      {
        mapillaryToken: 'token',
        fetchImpl: (async (url: string) => {
          hosts.push(new URL(String(url)).host);
          return String(url).includes('commons')
            ? jsonResponse({ query: { pages: commonsPages(1) } })
            : jsonResponse({ data: [{ id: 'x', thumb_1024_url: 'https://mapillary.test/1.jpg' }] });
        }) as unknown as typeof fetch,
      },
    );

    expect(hosts).toEqual(['commons.wikimedia.org', 'graph.mapillary.com']);
    expect(photos.map((p) => p.source)).toEqual(['wikimedia', 'mapillary']);
  });

  it('scales the search radius with trail length, within the API limit', async () => {
    const radii: string[] = [];
    const capture = (async (url: string) => {
      radii.push(new URL(String(url)).searchParams.get('ggsradius') ?? '');
      return jsonResponse({ query: { pages: commonsPages(3) } });
    }) as unknown as typeof fetch;

    await fetchSeedPhotos(
      { centroid: [-5, 56.8], bbox: [-5, 56.8, -4.9, 56.9], lengthM: 400 },
      { fetchImpl: capture },
    );
    await fetchSeedPhotos(
      { centroid: [-5, 56.8], bbox: [-5, 56.8, -4.9, 56.9], lengthM: 12_000 },
      { fetchImpl: capture },
    );
    await fetchSeedPhotos(
      { centroid: [-5, 56.8], bbox: [-5, 56.8, -4.9, 56.9], lengthM: 90_000 },
      { fetchImpl: capture },
    );

    expect(radii).toEqual(['500', '6000', '10000']);
  });
});
