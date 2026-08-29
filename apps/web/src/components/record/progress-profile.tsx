'use client';

import { useMemo } from 'react';
import type { UnitSystem } from '@switchback/core';
import { formatDistance, formatElevation } from '@switchback/core';
import {
  sampleSection,
  toSectionPoints,
  type HikePlan,
  type RouteProgress,
  type SectionPoint,
} from '@switchback/geo';

/**
 * What is left of the hike, as a silhouette and two numbers.
 *
 * Not `<Section>` shrunk. The section's lettering is sized in viewBox units so it stays welded
 * to its own axes, which at the 420 px of a recording column resolves to about five pixels —
 * an instrument too small to read is worse than no instrument. So this draws the shape and
 * nothing else, and every number it would have printed is HTML beside it, in the real type
 * ladder, selectable and announced.
 *
 * Ground behind the hiker is filled, ground ahead is a hairline, and the marker sits on the
 * join. Its position is `progress.hikedM` — the value the map draws its own mark from.
 */

export interface ProgressProfileProps {
  plan: HikePlan;
  /** Null until the first fix good enough to trust. The shape still draws; the marker does not. */
  progress: RouteProgress | null;
  trailName: string;
  units: UnitSystem;
}

const VIEW = { w: 320, h: 72 } as const;
/** Room at the top and bottom for the marker's ring, which straddles the line it sits on. */
const INSET = 7;

export function ProgressProfile({ plan, progress, trailName, units }: ProgressProfileProps) {
  const points = useMemo(() => toSectionPoints(plan.profile), [plan.profile]);
  const scale = useMemo(() => silhouetteScale(points), [points]);

  const totalGainM = plan.gainToM[plan.gainToM.length - 1] ?? 0;
  const hikedM = progress === null ? null : Math.min(progress.hikedM, plan.hikedLengthM);

  const covered = useMemo(
    () => (hikedM === null ? [] : pointsUpTo(points, hikedM)),
    [points, hikedM],
  );

  const summary =
    `Elevation profile of ${trailName}: ${formatDistance(plan.hikedLengthM, units)} climbing ` +
    `${formatElevation(totalGainM, units)}.` +
    (progress === null || hikedM === null
      ? ''
      : ` You are ${formatDistance(hikedM, units)} in, with ` +
        `${formatDistance(progress.remainingM, units)} and ` +
        `${formatElevation(progress.remainingGainM, units)} of climbing left.`);

  return (
    <figure className="m-0 rounded-hair border border-bezel bg-surface px-lg py-md">
      <div className="flex flex-wrap items-baseline justify-between gap-sm">
        <figcaption className="collar">Ahead</figcaption>
        {/*
         * Not a live region. A fix lands every second, and a polite region rebroadcasting two
         * numbers that often is chatter a screen-reader user cannot escape; the same text read
         * on demand says exactly as much.
         */}
        <p className="font-mono text-micro text-ink-muted">
          {progress === null ? (
            <>
              {formatDistance(plan.hikedLengthM, units)} · ↑{formatElevation(totalGainM, units)}
            </>
          ) : (
            <>
              <span className="text-ink">{formatDistance(progress.remainingM, units)}</span> to go ·{' '}
              <span className="text-ink">↑{formatElevation(progress.remainingGainM, units)}</span>{' '}
              to climb
            </>
          )}
        </p>
      </div>

      <div className="plot-surface mt-sm aspect-[320/72] w-full">
        <svg
          viewBox={`0 0 ${VIEW.w} ${VIEW.h}`}
          className="h-full w-full"
          role="img"
          aria-label={summary}
          preserveAspectRatio="xMidYMid meet"
        >
          {covered.length >= 2 ? (
            <path d={areaPath(covered, scale)} fill="var(--color-woodland-wash)" />
          ) : null}

          <polyline
            points={linePoints(points, scale)}
            fill="none"
            stroke="var(--color-ink-muted)"
            strokeWidth="1"
            strokeLinejoin="round"
          />

          {covered.length >= 2 ? (
            <polyline
              points={linePoints(covered, scale)}
              fill="none"
              stroke="var(--color-woodland)"
              strokeWidth="2.5"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ) : null}

          {hikedM === null ? null : (
            <circle
              cx={scale.x(hikedM)}
              cy={scale.y(sampleSection(points, hikedM))}
              r="4.5"
              fill="var(--color-woodland)"
              stroke="var(--color-surface)"
              strokeWidth="2"
            />
          )}
        </svg>
      </div>
    </figure>
  );
}

interface SilhouetteScale {
  x: (distanceM: number) => number;
  y: (elevationM: number) => number;
}

/**
 * Baselined on the trail's own low point rather than on sea level, which is what separates a
 * silhouette from the section chart: a 600 m rise plotted from zero on a 72 px strip is a flat
 * smear, and the shape is the only thing this graphic has to say.
 */
function silhouetteScale(points: readonly SectionPoint[]): SilhouetteScale {
  const maxDistanceM = Math.max(1, ...points.map((p) => p.distanceM));
  const elevations = points.map((p) => p.elevationM);
  const low = Math.min(...elevations);
  const span = Math.max(1, Math.max(...elevations) - low);
  const bottom = VIEW.h - INSET;

  return {
    x: (distanceM) => (distanceM / maxDistanceM) * VIEW.w,
    y: (elevationM) => bottom - ((elevationM - low) / span) * (bottom - INSET),
  };
}

/** The profile up to a distance, with a sample interpolated exactly at the cut. */
function pointsUpTo(points: readonly SectionPoint[], distanceM: number): SectionPoint[] {
  const before = points.filter((point) => point.distanceM < distanceM);
  return [...before, { distanceM, elevationM: sampleSection(points, distanceM) }];
}

function linePoints(points: readonly SectionPoint[], scale: SilhouetteScale): string {
  return points.map((point) => xy(point, scale)).join(' ');
}

function areaPath(points: readonly SectionPoint[], scale: SilhouetteScale): string {
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const ridge = points.map((point) => xy(point, scale)).join(' L ');
  return `M ${ridge} L ${scale.x(last.distanceM).toFixed(2)},${VIEW.h} L ${scale
    .x(first.distanceM)
    .toFixed(2)},${VIEW.h} Z`;
}

function xy(point: SectionPoint, scale: SilhouetteScale): string {
  return `${scale.x(point.distanceM).toFixed(2)},${scale.y(point.elevationM).toFixed(2)}`;
}
