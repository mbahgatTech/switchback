'use client';

import { useCallback, useMemo, useRef } from 'react';
import type { ElevationPoint, TrailStats, UnitSystem } from '@switchback/core';
import { formatDistance, formatDuration, formatElevation } from '@switchback/core';
import {
  cumulativeTimeS,
  elevationAt,
  elevationTicks,
  timeAtDistanceS,
  toSectionPoints,
  toStations,
} from '@switchback/geo';
import { SECTION_PLOT, SECTION_VIEW, Section, type SectionCallout } from '../section';
import { useUnitsOr } from '../units';

/**
 * The section, made readable.
 *
 * The graphic itself is a pure SVG that could be server-rendered; what this adds is the
 * one interaction that makes a cross-section a tool rather than an illustration — putting
 * a cursor anywhere along the hike and being told the altitude, the distance and how long
 * it takes to get there, with the same position marked on the map beside it.
 *
 * **Why the readout is HTML and not SVG text.** It changes on every pointer move. In the
 * SVG it would be text that no screen reader announces and that no browser can select; in
 * HTML it is a live region set in the real type scale, and the numbers can be copied.
 *
 * **Why `role="slider"`.** The interaction genuinely is a value along a range, and that is
 * the one role that gives a keyboard user arrow keys, Home and End for free from the
 * platform rather than from a set of conventions we invented. Non-pointer readers get the
 * profile as prose from the graphic's own summary either way.
 */

export interface TrailProfileProps {
  profile: readonly ElevationPoint[];
  stats: TrailStats;
  /** Terrain multiplier from the trail's OSM tags, so the elapsed axis matches the stats. */
  terrainFactor?: number;
  units?: UnitSystem;
  cursorDistanceM: number | null;
  onCursorChange: (distanceM: number | null) => void;
  /** Collar annotations — the weather at the trailhead and the high point, once it loads. */
  callouts?: readonly SectionCallout[];
  /** Freezing level, when it falls somewhere the hike actually reaches. */
  freezingLevelM?: number;
}

/** One arrow press moves this fraction of the trail. 2% is ~15 presses end to end. */
const KEY_STEP = 0.02;

export function TrailProfile({
  profile,
  stats,
  terrainFactor = 1,
  units: given,
  cursorDistanceM,
  onCursorChange,
  callouts,
  freezingLevelM,
}: TrailProfileProps) {
  const units = useUnitsOr(given);
  const frame = useRef<HTMLDivElement | null>(null);

  const points = useMemo(() => toSectionPoints(profile), [profile]);
  const ticks = useMemo(() => elevationTicks(stats.maxEleM, units), [stats.maxEleM, units]);
  const stations = useMemo(
    () => toStations(profile, { terrainFactor, system: units }),
    [profile, terrainFactor, units],
  );
  const cumulative = useMemo(
    () => cumulativeTimeS(profile, { terrainFactor }),
    [profile, terrainFactor],
  );

  const totalM = stats.lengthM;

  /** Pointer position → distance along the trail, through the section's own scale. */
  const distanceFromEvent = useCallback(
    (clientX: number): number | null => {
      const rect = frame.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return null;
      const viewX = ((clientX - rect.left) / rect.width) * SECTION_VIEW.w;
      const span = SECTION_PLOT.x1 - SECTION_PLOT.x0;
      const fraction = (viewX - SECTION_PLOT.x0) / span;
      return Math.min(Math.max(fraction, 0), 1) * totalM;
    },
    [totalM],
  );

  const track = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      // Touch is deliberately tap-only. Tracking a drag here would need `touch-action:
      // none`, which turns a swipe over the graphic into a swipe that cannot scroll the
      // page — a page the graphic is two-thirds of the way down.
      if (event.pointerType === 'touch' && event.type === 'pointermove') return;
      const distance = distanceFromEvent(event.clientX);
      if (distance !== null) onCursorChange(distance);
    },
    [distanceFromEvent, onCursorChange],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const current = cursorDistanceM ?? 0;
      const step = totalM * KEY_STEP;
      const next =
        event.key === 'ArrowRight' || event.key === 'ArrowUp'
          ? current + step
          : event.key === 'ArrowLeft' || event.key === 'ArrowDown'
            ? current - step
            : event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? totalM
                : null;
      if (next === null) return;
      event.preventDefault();
      onCursorChange(Math.min(Math.max(next, 0), totalM));
    },
    [cursorDistanceM, onCursorChange, totalM],
  );

  const cursorEleM = cursorDistanceM === null ? null : elevationAt(profile, cursorDistanceM);
  const cursorTimeS =
    cursorDistanceM === null ? null : timeAtDistanceS(profile, cumulative, cursorDistanceM);

  const summary = `Elevation profile: ${formatDistance(totalM, units)} long, climbing ${formatElevation(
    stats.gainM,
    units,
  )} from ${formatElevation(stats.minEleM, units)} to ${formatElevation(stats.maxEleM, units)}.`;

  const valueText =
    cursorDistanceM === null
      ? 'No point selected'
      : `${formatDistance(cursorDistanceM, units)} in, ${formatElevation(cursorEleM ?? 0, units)}`;

  return (
    <figure className="m-0">
      <div className="flex flex-wrap items-baseline justify-between gap-sm">
        <figcaption className="collar">Section</figcaption>
        {/*
         * One line that answers two different questions depending on state: what the hike
         * is as a whole, and what it is at the point under the cursor. Two lines that swap
         * would shift the graphic below by a row every time the pointer entered it.
         */}
        <p aria-live="polite" className="font-mono text-micro text-ink-muted">
          {cursorDistanceM === null ? (
            <>
              {formatDistance(totalM, units)} · ↑{formatElevation(stats.gainM, units)} ·{' '}
              {formatDuration(stats.estimatedTimeS)}
            </>
          ) : (
            <>
              <span className="text-ink">{formatElevation(cursorEleM ?? 0, units)}</span> at{' '}
              {formatDistance(cursorDistanceM, units)} · {formatDuration(cursorTimeS ?? 0)} in
            </>
          )}
        </p>
      </div>

      <div
        ref={frame}
        role="slider"
        tabIndex={0}
        aria-label="Position along the trail"
        aria-valuemin={0}
        aria-valuemax={Math.round(totalM)}
        aria-valuenow={Math.round(cursorDistanceM ?? 0)}
        aria-valuetext={valueText}
        onPointerMove={track}
        onPointerDown={track}
        onPointerLeave={() => onCursorChange(null)}
        onBlur={() => onCursorChange(null)}
        onKeyDown={onKeyDown}
        // The aspect ratio matches the viewBox exactly, so `xMidYMid meet` letterboxes
        // nothing and a pointer at 40% across the box is at 40% across the plot.
        className="mt-sm aspect-[1000/380] w-full cursor-crosshair rounded-hair focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
      >
        <Section
          points={points}
          stations={stations}
          elevationTicks={ticks}
          units={units}
          cursorDistanceM={cursorDistanceM}
          {...(callouts === undefined ? {} : { callouts })}
          {...(freezingLevelM === undefined ? {} : { freezingLevelM })}
          timeAxisLabel="elapsed"
          summary={summary}
          className="h-full w-full"
        />
      </div>

      <p className="mt-sm text-caption text-ink-muted">
        Hatching tightens as the ground steepens. Times are moving time from the trailhead — no
        stops, no lunch, no photographs.
        {freezingLevelM === undefined
          ? null
          : ' The dashed rule is the freezing level; anything above it is at or below 0 °C.'}
      </p>
    </figure>
  );
}
