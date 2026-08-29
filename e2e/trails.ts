/**
 * The trails the browser suite opens by slug, and where a CI run gets each one.
 *
 * Separate from `fixtures.ts` so `test/e2e-trail-sources.test.ts` can read these declarations
 * without loading Playwright's runner. Keep it free of DOM and Playwright for a second reason the
 * import does not show: the root `tsconfig.json` excludes `e2e/` because that project alone needs
 * `lib: ["DOM"]`, and the guard's import pulls this file into the root program regardless.
 */

/** lng, lat. The sheet's centre, and the point `ci.yml` ingests its one tile around. */
const VESPER_AT = [-121.51188, 48.01213] as const;

/** Vesper Peak: at z13 the sheet holds twenty-odd trails from an already-ingested tile. */
export const VESPER = {
  slug: 'vesper-peak-summit-trail',
  name: 'Vesper Peak summit trail',
  at: VESPER_AT,
  /** `map=zoom/lat/lng`, the same format the sheet writes back into the address bar. */
  view: `map=13/${VESPER_AT[1]}/${VESPER_AT[0]}`,
} as const;

/**
 * The trails below are on no single tile, and CI makes one Overpass query — so `npm run db:seed:e2e`
 * writes them offline instead, under reserved `fixture-` slugs that nothing ingested can collide
 * with. Without it their pages 404 and the specs fail on the first thing they look for.
 */

/** The trail the reports are filed against, and the only fixture a spec writes to. */
export const REPORT_TRAIL = { slug: 'fixture-report-trail' } as const;

/** Twelve photographs, every one a row with no file behind it. The gallery spec's whole subject. */
export const PHOTOGRAPHED = { slug: 'fixture-photographed-trail' } as const;

/**
 * A long through-hike with its high point 7% along, which is where the two weather callouts
 * overprinted — the fraction is what crowds them, since the collar is laid out in viewBox units.
 * A day hike puts its summit halfway and proves nothing about this.
 */
export const LONG_TRAIL = { slug: 'fixture-early-high-point' } as const;

export const SHEET_AT_VESPER = `/?${VESPER.view}`;

/**
 * Where CI gets each trail above: `seeded` by `npm run db:seed:e2e`, or `ingested` — which means
 * inside the single z9 tile `.github/workflows/ci.yml` queries, the only Overpass request the
 * workflow makes. `test/e2e-trail-sources.test.ts` holds every entry to its claim, and its header
 * records the incident that made the declaration necessary.
 */
export type SuiteTrail =
  | { readonly slug: string; readonly from: 'seeded' }
  | { readonly slug: string; readonly from: 'ingested'; readonly at: readonly [number, number] };

export const SUITE_TRAILS: readonly SuiteTrail[] = [
  { slug: VESPER.slug, from: 'ingested', at: VESPER.at },
  { slug: REPORT_TRAIL.slug, from: 'seeded' },
  { slug: PHOTOGRAPHED.slug, from: 'seeded' },
  { slug: LONG_TRAIL.slug, from: 'seeded' },
];
