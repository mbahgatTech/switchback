'use client';

import type { RouteAnchor, RouteLeg, RoutePlan, UnitSystem } from '@switchback/core';
import {
  DIFFICULTY_LABELS,
  TERRAIN_CAUTION_COPY,
  classifyDifficulty,
  formatDistance,
  formatElevation,
  formatTimeOnFoot,
  terrainCaution,
} from '@switchback/core';
import { BUTTON, HEIGHT, SECONDARY } from '../controls';
import { TrailProfile } from '../trail/profile';

/**
 * The route sheet.
 *
 * Everything the map cannot say. A drawn line answers "where"; this answers "how far", "how
 * much climbing", "how long", and — the question a planner exists to answer honestly — "which
 * parts of this are not actually a path".
 *
 * **It is a numbered list, and the numbers mean something.** Ordinal markers are the most
 * over-used device in a layout, worth having only when the content genuinely is a sequence.
 * Here it is one: point 1 is where you park, point 4 is where you turn around, and the pins
 * on the map carry the same numerals in the same three colours. The list is also the keyboard
 * surface for the whole planner — the map's pins are deliberately unreachable by tab, because
 * sixty stops announcing "3" is not access, it is an obstacle course.
 *
 * **Between the points, the legs.** A leg that could not be routed says so in words, in
 * survey, on the row between the two points it joins, with the reason spelled out rather than
 * coded. "No path near point 3" is something a person can act on by moving point 3; "partially
 * snapped" is not.
 */

export interface PlanReadoutProps {
  anchors: readonly RouteAnchor[];
  plan: RoutePlan | null;
  planning: boolean;
  error: string | null;
  units: UnitSystem;
  cursorDistanceM: number | null;
  onCursorChange: (distanceM: number | null) => void;
  onRemoveAnchor: (index: number) => void;
  onSetLegFreehand: (index: number, freehand: boolean) => void;
  /** Move the camera to hold one leg, so "no path here" can be looked at. */
  onFrameLeg: (leg: RouteLeg) => void;
}

/** What a leg's reason says out loud. `to` is the point it arrives at, one-based already. */
function legNote(leg: RouteLeg): string | null {
  switch (leg.reason) {
    case 'freehand':
      return 'Straight line, as asked';
    case 'off_network':
      return `No path near point ${String(leg.to + 1)}`;
    case 'no_path':
      return 'No walkable connection found';
    case 'network_pending':
      return 'Still downloading paths here';
    case 'network_paused':
      return 'Paths here have not been fetched';
    default:
      return null;
  }
}

export function PlanReadout({
  anchors,
  plan,
  planning,
  error,
  units,
  cursorDistanceM,
  onCursorChange,
  onRemoveAnchor,
  onSetLegFreehand,
  onFrameLeg,
}: PlanReadoutProps) {
  const stats = plan?.stats ?? null;
  const profile = plan?.profile ?? [];
  const legs = plan?.legs ?? [];
  const unroutable = legs.filter((leg) => !leg.snapped && leg.reason !== 'freehand').length;

  const band = stats
    ? classifyDifficulty({
        gainM: stats.gainM,
        lengthM: stats.lengthM,
        maxSustainedGrade: stats.maxSustainedGrade,
      })
    : null;

  /*
   * The planner is where this matters most. A trail in the catalogue is at least a line
   * somebody hiked; a drawn route is a line the router found, and the router optimises for
   * distance over the path graph without ever asking how steep the ground under it is. Drop
   * two anchors either side of a crag and it will happily connect them.
   */
  const caution = stats ? terrainCaution(stats.maxSustainedGrade) : null;

  return (
    <div className="flex flex-col gap-lg">
      <Instrument stats={stats} units={units} planning={planning} />

      {band && stats ? (
        <p className="text-caption text-ink-muted">
          {DIFFICULTY_LABELS[band.difficulty]} for a {formatDistance(stats.lengthM, units)} hike —
          the same rating any trail with this length and ascent would get.
        </p>
      ) : null}

      {caution ? (
        <aside role="note" className="border-l-2 border-survey pl-md">
          <p className="text-caption font-semibold text-survey">
            {TERRAIN_CAUTION_COPY[caution].title}
          </p>
          <p className="mt-hair text-caption text-ink">{TERRAIN_CAUTION_COPY[caution].body}</p>
        </aside>
      ) : null}

      {error ? (
        <p
          className="rounded-hair border border-survey px-md py-sm text-caption text-ink"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      {plan?.tooLarge ? (
        <p className="rounded-hair border border-survey px-md py-sm text-caption text-ink">
          These points cover more ground than one route may span. Bring them closer together, or
          plan the hike in sections.
        </p>
      ) : null}

      {plan?.busy ? (
        /*
         * The fetch was refused, so nothing is on its way and nothing will improve on its own.
         *
         * This paragraph outranks both of the ones below it, and that ordering is the fix for
         * a real regression: under a refusal the planner reported zero pending tiles, which
         * read as "we hold everything", which turned every unroutable leg into the warning
         * below — a claim that stretches of the route have no path under them, on ground the
         * server had never looked at. Say what happened instead, and say nothing about the
         * terrain, because nothing about the terrain is known.
         *
         * The closing clause splits on the reason, the same way the trail side's coverage
         * note does. "Try the route again later" is a real instruction for a deep queue and
         * a false one for a full database — that does not drain on its own, an operator has
         * to decide what to delete, and telling somebody to wait for it prescribes an action
         * that cannot work. This branch used to give both refusals the queue's sentence.
         */
        <p className="rounded-hair border border-survey px-md py-sm text-caption text-ink">
          Fetching paths for this ground is paused, so the straight stretches below are not claims
          about the terrain — they are ground we have not looked at.{' '}
          {plan.busyReason === 'storage'
            ? 'There is no room left to store new ground. Paths already mapped still work.'
            : 'Try the route again later.'}
        </p>
      ) : null}

      {plan && !plan.busy && plan.pendingTiles > 0 ? (
        <p className="rounded-hair border border-dashed border-bezel px-md py-sm text-caption text-ink-muted">
          Fetching the paths under this route
          {plan.pendingTiles > 1 ? ` — ${String(plan.pendingTiles)} areas to go` : ''}. The line
          will improve on its own.
        </p>
      ) : null}

      {unroutable > 0 && plan && !plan.busy && plan.pendingTiles === 0 ? (
        <p className="rounded-hair border border-survey px-md py-sm text-caption text-ink">
          {unroutable === 1
            ? 'One stretch of this route has no path under it and is drawn as a straight red line.'
            : `${String(unroutable)} stretches of this route have no path under them and are drawn as straight red lines.`}{' '}
          Do not plan on hiking them without checking the ground yourself.
        </p>
      ) : null}

      {profile.length >= 2 && stats ? (
        <TrailProfile
          profile={profile}
          stats={stats}
          units={units}
          cursorDistanceM={cursorDistanceM}
          onCursorChange={onCursorChange}
        />
      ) : null}

      <Sheet
        anchors={anchors}
        legs={legs}
        units={units}
        onRemoveAnchor={onRemoveAnchor}
        onSetLegFreehand={onSetLegFreehand}
        onFrameLeg={onFrameLeg}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The gauge
// ---------------------------------------------------------------------------

/**
 * Distance at gauge size, everything else beneath it.
 *
 * The same instrument face as the recorder's, and deliberately so: the number that matters
 * while planning a hike and the number that matters while hiking it are the same number, and
 * a product that sets them in two different type sizes is two products.
 */
function Instrument({
  stats,
  units,
  planning,
}: {
  stats: RoutePlan['stats'] | null;
  units: UnitSystem;
  planning: boolean;
}) {
  const idle = !stats;
  const [value, unit] = splitMeasurement(formatDistance(stats?.lengthM ?? 0, units));

  return (
    <div className="rounded-hair border border-bezel bg-surface">
      <div className="flex items-baseline justify-between gap-md px-lg pb-md pt-lg">
        <div>
          <p className="collar">Distance</p>
          <p
            className={`font-mono tabular-nums ${idle ? 'text-ink-muted' : 'text-ink'}`}
            // Matches the recorder's gauge exactly, leading included — the mono face's own
            // leading is far too generous at display size.
            style={{ fontSize: 'var(--text-display)', lineHeight: '1.02' }}
          >
            {value}
            <span className="ml-xs align-baseline text-h4 text-ink-muted">{unit}</span>
          </p>
        </div>
        {planning ? (
          <p className="collar text-ink-muted" role="status">
            Working
          </p>
        ) : null}
      </div>

      <div className="grid grid-cols-2 border-t border-bezel">
        <Dial label="Ascent" value={formatElevation(stats?.gainM ?? 0, units)} idle={idle} />
        <Dial
          label="Descent"
          value={formatElevation(stats?.lossM ?? 0, units)}
          idle={idle}
          border
        />
        <Dial
          label="On foot"
          value={formatTimeOnFoot(stats?.estimatedTimeS ?? 0)}
          idle={idle}
          top
        />
        <Dial
          label="High point"
          value={formatElevation(stats?.maxEleM ?? 0, units)}
          idle={idle}
          border
          top
        />
      </div>
    </div>
  );
}

function Dial({
  label,
  value,
  idle,
  border,
  top,
}: {
  label: string;
  value: string;
  idle: boolean;
  border?: boolean;
  top?: boolean;
}) {
  return (
    <div
      className={`px-lg py-md ${border ? 'border-l border-bezel' : ''} ${top ? 'border-t border-bezel' : ''}`}
    >
      <p className="collar">{label}</p>
      <p
        className={`font-mono text-h4 tabular-nums ${idle ? 'text-ink-muted' : 'text-ink'}`}
        style={{ lineHeight: '1.3' }}
      >
        {value}
      </p>
    </div>
  );
}

/**
 * Split "4.82 km" into the number and its unit so the unit can be set smaller.
 *
 * A units suffix at display size is as loud as the measurement, and the measurement is the
 * only thing being read.
 */
function splitMeasurement(formatted: string): [string, string] {
  const at = formatted.lastIndexOf(' ');
  return at === -1 ? [formatted, ''] : [formatted.slice(0, at), formatted.slice(at + 1)];
}

// ---------------------------------------------------------------------------
// The sheet
// ---------------------------------------------------------------------------

function Sheet({
  anchors,
  legs,
  units,
  onRemoveAnchor,
  onSetLegFreehand,
  onFrameLeg,
}: {
  anchors: readonly RouteAnchor[];
  legs: readonly RouteLeg[];
  units: UnitSystem;
  onRemoveAnchor: (index: number) => void;
  onSetLegFreehand: (index: number, freehand: boolean) => void;
  onFrameLeg: (leg: RouteLeg) => void;
}) {
  if (anchors.length === 0) {
    return (
      <div className="rounded-hair border border-dashed border-bezel px-lg py-xl text-center">
        <p className="text-body text-ink">Click the map to drop your first point.</p>
        <p className="mt-xs text-caption text-ink-muted">
          Every point after that is joined to the last one along whatever paths exist between them.
          Drag a point to move it; click it to take it out.
        </p>
      </div>
    );
  }

  return (
    <section aria-label="Points on this route">
      <h2 className="collar mb-sm">The route, point by point</h2>
      <ol className="border-t border-bezel">
        {anchors.map((anchor, index) => {
          // Legs are keyed by the point they arrive at, so the leg above point `index` is the
          // one whose `to` is `index`. Point 0 has nothing above it.
          const leg = legs.find((candidate) => candidate.to === index) ?? null;
          return (
            <li key={`${String(index)}-${anchor.lng.toFixed(5)}-${anchor.lat.toFixed(5)}`}>
              {leg ? (
                <LegRow
                  leg={leg}
                  units={units}
                  freehand={anchor.freehand}
                  onToggle={() => {
                    onSetLegFreehand(index, !anchor.freehand);
                  }}
                  onFrame={() => {
                    onFrameLeg(leg);
                  }}
                />
              ) : null}
              <PointRow
                index={index}
                total={anchors.length}
                anchor={anchor}
                onRemove={() => {
                  onRemoveAnchor(index);
                }}
              />
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** The pin numerals, in the same three treatments the map uses. */
function pinClass(index: number, total: number): string {
  if (index === 0) return 'border-woodland bg-woodland text-canvas';
  if (index === total - 1 && total > 1) return 'border-ink bg-ink text-canvas';
  return 'border-ink bg-surface text-ink';
}

function PointRow({
  index,
  total,
  anchor,
  onRemove,
}: {
  index: number;
  total: number;
  anchor: RouteAnchor;
  onRemove: () => void;
}) {
  const role = index === 0 ? 'Start' : index === total - 1 && total > 1 ? 'Finish' : 'Waypoint';
  return (
    <div className="flex items-center gap-md border-b border-bezel py-sm">
      <span
        className={`flex h-xl w-xl shrink-0 items-center justify-center rounded-pill border-2 font-mono text-micro leading-none tracking-normal tabular-nums ${pinClass(index, total)}`}
        aria-hidden
      >
        {index + 1}
      </span>
      <span className="flex-1 text-caption text-ink">
        {role}
        <span className="ml-sm font-mono text-micro text-ink-muted">
          {anchor.lat.toFixed(4)}, {anchor.lng.toFixed(4)}
        </span>
      </span>
      <button
        type="button"
        onClick={onRemove}
        className="text-caption text-ink-muted underline decoration-bezel underline-offset-4 transition-colors duration-quick hover:text-survey hover:decoration-survey"
      >
        Remove
        <span className="sr-only"> point {index + 1}</span>
      </button>
    </div>
  );
}

function LegRow({
  leg,
  units,
  freehand,
  onToggle,
  onFrame,
}: {
  leg: RouteLeg;
  units: UnitSystem;
  freehand: boolean;
  onToggle: () => void;
  onFrame: () => void;
}) {
  const note = legNote(leg);
  // A leg the user asked to be straight is not a problem; every other unsnapped leg is.
  const warn = !leg.snapped && leg.reason !== 'freehand';

  return (
    // Indented past the pin badge and the gap after it, in the tokens that set both, so the
    // leg's rule hangs directly under the numerals rather than starting at the panel edge —
    // and stays there if either token moves.
    <div className="flex items-center gap-md border-b border-bezel py-xs pl-[calc(var(--spacing-xl)+var(--spacing-md))]">
      <span
        className={`h-4 w-px shrink-0 ${warn ? 'bg-survey' : leg.snapped ? 'bg-woodland' : 'bg-ink-muted'}`}
        aria-hidden
      />
      <span className="flex-1 text-micro text-ink-muted">
        <span className="font-mono tabular-nums">{formatDistance(leg.lengthM, units)}</span>
        {note ? <span className={warn ? ' text-survey' : ''}> · {note}</span> : null}
      </span>
      {warn ? (
        <button
          type="button"
          onClick={onFrame}
          className="text-micro text-ink-muted underline decoration-bezel underline-offset-4 transition-colors duration-quick hover:text-ink hover:decoration-ink-muted"
        >
          Show
          <span className="sr-only"> the stretch before point {leg.to + 1} on the map</span>
        </button>
      ) : null}
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={freehand}
        className={`${BUTTON} ${freehand ? 'border-ink bg-ink text-canvas' : SECONDARY} ${HEIGHT.panel} px-sm text-micro`}
      >
        Straight
        <span className="sr-only"> line into point {leg.to + 1}</span>
      </button>
    </div>
  );
}
