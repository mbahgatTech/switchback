import Link from 'next/link';
import type { LngLat, TrailSummary, UnitSystem } from '@switchback/core';
import {
  DIFFICULTY_LABELS,
  formatDistance,
  formatDuration,
  formatElevation,
} from '@switchback/core';
import { bearingDeg, compassPoint } from '@switchback/geo';
import { DIFFICULTY_PLATE } from '@switchback/ui';
import { ROUTE_LABEL } from '../explore/route-label';
import { Photograph } from '../photos/photograph';

/**
 * The trails nearest the reader, as a gazetteer index.
 *
 * The device is the **distance column**: every row leads with how far away the trail is and
 * which way it lies, in one monospaced column that the eye can run down. That is a signpost
 * at a junction and the toposcope on a summit — the two places a hiker already reads a
 * bearing and a distance together — and it is the honest structure for this list, because
 * distance from the reader is genuinely what orders it. The trail's own name and statistics
 * come after, in the second column, where they answer the next question rather than the
 * first.
 *
 * Both figures are real. The distance is PostGIS's, computed against the same point the
 * page says it is using; the bearing is `bearingDeg` between that point and the trail's
 * centroid, shown to eight points because the origin is never precise enough for sixteen.
 *
 * Server-rendered and static. There is deliberately no save control, no hover-link to a map,
 * no filter — this page's whole job is to get somebody to a trail or to the map, and every
 * control that is not one of those two is a control that delays both.
 */

export interface NearbyTrail extends TrailSummary {
  distanceM: number;
}

export interface NearbyListProps {
  trails: readonly NearbyTrail[];
  /** Where the distances are measured from. */
  from: LngLat;
  units: UnitSystem;
}

/** The plate a difficulty prints on, as a Tailwind background utility. */
const PLATE_BG = {
  woodland: 'bg-woodland',
  contour: 'bg-contour',
  survey: 'bg-survey',
} as const;

export function NearbyList({ trails, from, units }: NearbyListProps) {
  return (
    <ol className="mt-xl border-t border-bezel">
      {trails.map((trail) => (
        <Row key={trail.id} trail={trail} from={from} units={units} />
      ))}
    </ol>
  );
}

function Row({ trail, from, units }: { trail: NearbyTrail; from: LngLat; units: UnitSystem }) {
  const { stats } = trail;
  const plate = PLATE_BG[DIFFICULTY_PLATE[trail.difficulty]];
  const point = compassPoint(bearingDeg(from, trail.centroid));

  return (
    <li className="border-b border-bezel">
      <article className="group relative flex items-start gap-lg py-md transition-colors duration-quick ease-standard hover:bg-surface">
        {/*
         * The column. Fixed width and right-aligned so the numbers stack on their own
         * edge — a ragged column of distances is not a column, it is a list of numbers
         * that happen to be first on each line.
         */}
        <p className="w-[5.5rem] shrink-0 pt-hair text-right font-mono">
          <span className="block text-body text-ink">{formatDistance(trail.distanceM, units)}</span>
          <span className="collar block">{point}</span>
        </p>

        <div className="min-w-0 flex-1">
          <h3 className="text-body font-medium leading-tight text-ink">
            <Link
              href={`/trails/${trail.slug}`}
              // The name is the link and an overlay makes the row clickable — a row-shaped
              // anchor would announce the name, the region and six statistics as one
              // enormous link name.
              className="rounded-hair after:absolute after:inset-0 after:content-[''] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
            >
              {trail.name}
            </Link>
          </h3>

          {trail.regionName ? (
            <p className="mt-hair truncate text-caption text-ink-muted">{trail.regionName}</p>
          ) : null}

          <dl className="mt-xs flex flex-wrap items-baseline gap-x-md gap-y-xs font-mono text-micro text-ink-muted">
            <Stat label="Length" value={formatDistance(stats.lengthM, units)} />
            <Stat label="Gain" value={`↑${formatElevation(stats.gainM, units)}`} />
            <Stat label="Time" value={formatDuration(stats.estimatedTimeS)} />
            <Stat label="Route" value={ROUTE_LABEL[trail.routeType]} />
            <div className="flex items-center gap-xs">
              <span aria-hidden className={`h-[6px] w-[6px] rounded-full ${plate}`} />
              <dt className="sr-only">Difficulty</dt>
              <dd>{DIFFICULTY_LABELS[trail.difficulty]}</dd>
            </div>
            {trail.rating !== null ? (
              <div className="flex items-baseline gap-xs">
                <dt className="sr-only">Rating</dt>
                <dd>
                  {trail.rating.toFixed(1)}
                  <span className="text-ink-muted"> · {trail.reviewCount}</span>
                </dd>
              </div>
            ) : null}
          </dl>
        </div>

        <Photograph
          src={trail.primaryPhotoUrl}
          alt=""
          loading="lazy"
          className="hidden h-[64px] w-[96px] shrink-0 rounded-hair object-cover sm:block"
          fallback={
            // Nothing, rather than a grey rectangle. On the explore card the slot carries a
            // number because it is load-bearing at 72px square in a dense index; here the
            // row already prints six figures and a seventh in a picture frame is clutter.
            <div aria-hidden className="hidden h-[64px] w-[96px] shrink-0 sm:block" />
          }
        />
      </article>
    </li>
  );
}

/** The value is the content; the label is for a screen reader and the unit says which is which. */
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-xs">
      <dt className="sr-only">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
