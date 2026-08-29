/**
 * The trails `e2e/` opens by slug that no ingested tile holds — described here, written by
 * `seed-e2e.ts`, and held against the workflow by `test/e2e-trail-sources.test.ts`.
 */
import type { LngLat } from '@switchback/core';

/**
 * WHY THERE IS INVENTED GEOMETRY HERE, when `seed.ts` refuses to invent any.
 *
 * `seed.ts` is right for the development seed: a fake trail there would hide a broken pipeline,
 * because the pipeline is what the explore sheet is looking at. These are different. CI makes
 * exactly one Overpass query — one z9 tile over Vesper Peak, for fair use, see the note at the
 * top of `.github/workflows/ci.yml` — and three specs open trails that tile does not contain, so
 * they failed on every run. None of the three is about the pipeline: one is about what a browser
 * draws when an image file 404s, one about SVG labels overprinting, one about filing a report.
 * Fixtures answer all three, and answer them identically on a runner and on a laptop, which is
 * what those specs were not doing.
 *
 * The slugs are reserved — no OSM name slugifies to `fixture-…` — so nothing written here can
 * land on, or be landed on by, a trail the pipeline produced. The specs that *are* about the
 * pipeline still read the real ingested Vesper Peak sheet and are untouched.
 */

/**
 * A trail described by its ends and two curves: where the line goes, and where the ground does.
 * Everything stored is measured off the result rather than stated here, so the stats, the axis
 * and the section cannot disagree with the line they are drawn from.
 */
export interface Shape {
  slug: string;
  name: string;
  description: string;
  from: LngLat;
  to: LngLat;
  /** Serpentine across the straight run: amplitude in degrees, and cycles end to end. */
  wobbleDeg: number;
  wobbleCycles: number;
  lowEleM: number;
  peakEleM: number;
  endEleM: number;
  /** Where the high point falls, as a fraction of the length. */
  highAt: number;
  /** Undulation after the high point: metres trough to crest, and cycles over the remainder. */
  rollM: number;
  rollCycles: number;
  /** Photographs to hang on it. */
  photographs: number;
}

/**
 * New Zealand, deliberately: every other spec in the suite looks at Vesper Peak or Snowdon, and a
 * fixture inside one of those viewports would change what a map spec counts.
 */
export const SHAPES: readonly Shape[] = [
  {
    slug: 'fixture-photographed-trail',
    name: 'Photographed trail fixture',
    description:
      'A browser-suite fixture. Its twelve photographs are rows with no files behind them, which is the state the gallery spec is about.',
    from: [175.58, -39.16],
    to: [175.68, -39.1],
    wobbleDeg: 0.004,
    wobbleCycles: 6,
    lowEleM: 760,
    peakEleM: 1_860,
    endEleM: 1_820,
    highAt: 0.85,
    rollM: 40,
    rollCycles: 3,
    photographs: 12,
  },
  {
    /**
     * The collar spec's trail. Its high point is 7% along, and that fraction is the whole
     * condition: `placeCallouts` works in viewBox x-units, so what crowds the two weather
     * annotations is where the high point falls in the width, not how many kilometres in it is.
     * Long enough that the arrival clocks are days apart, as they were in the original report.
     */
    slug: 'fixture-early-high-point',
    name: 'Early high point fixture',
    description:
      'A browser-suite fixture. A long through-hike whose high point comes 7% in, where the section’s two weather callouts fight for room.',
    from: [170.6, -43.3],
    to: [172.0, -42.3],
    wobbleDeg: 0.008,
    wobbleCycles: 24,
    lowEleM: 420,
    peakEleM: 2_180,
    endEleM: 640,
    highAt: 0.07,
    rollM: 200,
    rollCycles: 24,
    photographs: 0,
  },
  {
    /**
     * The reviews specs' trail. Its own shape because those specs time a hydration window — they
     * re-click a button until its handler arrives — and neither trail above is a quiet page to
     * time anything on: one carries twelve photographs with no file behind them, the other a few
     * thousand profile samples.
     */
    slug: 'fixture-report-trail',
    name: 'Report trail fixture',
    description:
      'A browser-suite fixture. A half-day climb to a lake basin, quiet enough that the reports the suite files are the only ones on it.',
    from: [168.66, -44.98],
    to: [168.74, -44.94],
    wobbleDeg: 0.003,
    wobbleCycles: 5,
    lowEleM: 310,
    peakEleM: 1_240,
    endEleM: 1_180,
    highAt: 0.78,
    rollM: 30,
    rollCycles: 2,
    photographs: 0,
  },
];
