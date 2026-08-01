import {
  DISTANCE_UNIT,
  ELEVATION_UNIT,
  type UnitSystem,
  axisDistance,
  axisElevation,
  formatElevation,
} from '@switchback/core';
import {
  type SectionPoint,
  type SectionStation,
  placeCallouts,
  sampleSection,
  sectionAreaPath,
  sectionBands,
  sectionLinePoints,
  sectionScale,
} from '@switchback/geo';
import { GRADE_STEPS, gradeStep } from '@switchback/ui';

/**
 * The section — the cross-section panel a printed trail guide draws in its margin, and the
 * product's signature graphic. See `docs/design.md` for what makes it a section and not a chart.
 *
 * Server-rendered SVG with a CSS draw-on, so there is no client bundle and no hydration. The
 * projection is `@switchback/geo`'s, shared verbatim with the iOS renderer; what is decided
 * here is only what a sheet of paper this wide should look like.
 */

export type { SectionPoint, SectionStation };

export interface SectionCallout {
  distanceM: number;
  /** Two lines: the heading, then the reading. Kept short — this is collar text. */
  label: string;
  detail: string;
  /** Survey is for safety and nothing else; water is conditions; contour is terrain. */
  plate?: 'survey' | 'water' | 'contour';
}

export interface SectionProps {
  points: readonly SectionPoint[];
  stations: readonly SectionStation[];
  elevationTicks: readonly number[];
  /**
   * Which units the axes are labelled in. Required, and threaded from the same place the stat
   * block beside the graphic reads it from — the two disagreeing is one page reporting two
   * different trails. `elevationTicks` must have been chosen in this same system.
   */
  units: UnitSystem;
  callouts?: readonly SectionCallout[];
  /** Draws a rule at this elevation and labels it. Omit when it is above the summit. */
  freezingLevelM?: number;
  /** Multiplies the token hatch spacing. Above ~800px wide the raw values read as solid. */
  hatchScale?: number;
  /**
   * Where the reader's cursor is along the section, in metres. Draws a crosshair and nothing
   * else — the numbers belong in HTML beside the graphic, where they can be announced as text.
   */
  cursorDistanceM?: number | null;
  /**
   * The unit gloss on the clock row: `at` for a wall clock, `elapsed` for time from the
   * trailhead. Both rows are numbers, so without it the second reads as a second distance.
   */
  timeAxisLabel?: string;
  /** Accessible summary. The graphic is `img`-role; this is what a screen reader gets. */
  summary: string;
  className?: string;
}

const VIEW = { w: 1000, h: 380 };
const PAD = { top: 76, right: 28, bottom: 62, left: 68 } as const;
const PLOT = {
  x0: PAD.left,
  x1: VIEW.w - PAD.right,
  y0: PAD.top,
  y1: VIEW.h - PAD.bottom,
} as const;

/**
 * Lettering inside the plot, in viewBox units rather than on the rem type ladder: a label sized
 * in rem would rescale with the reader's root font while the axis it labels stayed put, so the
 * numbers would drift off their own ticks at any zoom but 100%. The values are what
 * `--text-caption` and `--text-body` resolve to at a 16 px root.
 */
const TICK_UNITS = 13;
const CALLOUT_UNITS = 15;
const COLLAR_UNITS = 11;

/**
 * The height the callout leaders turn along. Below the whole label block, not between its two
 * lines: a displaced leader must cross only white space and other leaders, never anyone's words.
 */
const COLLAR_RULE_Y = PAD.top - 12;
const CALLOUT_LABEL_Y = PAD.top - 42;
const CALLOUT_DETAIL_Y = PAD.top - 22;

/**
 * Character advances in ems, for the two faces the collar is set in. Server-rendered SVG cannot
 * measure its own text, so these are estimated *high* — over-reserving costs a little air,
 * under-reserving costs the collision `placeCallouts` exists to prevent. The mono figure is
 * exact: IBM Plex Mono and every fallback behind it advance 0.6 em.
 */
const MONO_ADVANCE = 0.6;
const COLLAR_ADVANCE = 0.68;

/**
 * The plot rectangle and the viewBox, exported so an interactive layer can invert the
 * horizontal scale with the same numbers the graphic drew with.
 */
export const SECTION_VIEW = VIEW;
export const SECTION_PLOT = PLOT;

export function Section({
  points,
  stations,
  elevationTicks,
  units,
  callouts = [],
  freezingLevelM,
  hatchScale = 2,
  cursorDistanceM = null,
  timeAxisLabel = 'at',
  summary,
  className,
}: SectionProps) {
  const scale = sectionScale(points, elevationTicks, PLOT);
  const x = scale.x;
  const y = scale.y;
  const maxDistance = scale.maxDistanceM;
  const maxElevation = scale.maxElevationM;

  const profile = sectionLinePoints(points, scale);

  // A gridline within a few pixels of the freezing rule reads as one thickened line with two
  // conflicting labels. The rule is the more important of the two, so the gridline yields.
  const freezingY = freezingLevelM === undefined ? undefined : y(freezingLevelM);
  const ticks = elevationTicks.filter(
    (tick) => freezingY === undefined || Math.abs(y(tick) - freezingY) > 14,
  );

  const cursorM =
    cursorDistanceM === null || cursorDistanceM === undefined
      ? null
      : Math.min(Math.max(cursorDistanceM, 0), maxDistance);

  // Where each annotation's words go, which is not always above the place they describe.
  const placed = placeCallouts(
    callouts.map((callout) => ({ at: x(callout.distanceM), width: calloutWidth(callout) })),
    PLOT,
  );

  return (
    <svg
      viewBox={`0 0 ${VIEW.w} ${VIEW.h}`}
      className={className}
      role="img"
      aria-label={summary}
      preserveAspectRatio="xMidYMid meet"
    >
      <defs>
        {GRADE_STEPS.map((step, i) => {
          const gap = step.hatch * hatchScale;
          return (
            <pattern
              key={i}
              id={`sb-hatch-${i}`}
              width={gap}
              height={gap}
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)"
            >
              <line
                x1="0"
                y1="0"
                x2="0"
                y2={gap}
                stroke="var(--color-contour)"
                strokeWidth="1"
                opacity="0.85"
              />
            </pattern>
          );
        })}
        {/* Wipes the mass in left to right — the section being plotted, once per trail. */}
        <clipPath id="sb-section-reveal">
          <rect x={PLOT.x0} y="0" width={PLOT.x1 - PLOT.x0} height={VIEW.h} className="sb-wipe" />
        </clipPath>
      </defs>

      {/* Elevation grid. Hairlines, behind everything, never competing with the profile. */}
      {ticks.map((tick) => (
        <g key={tick}>
          <line
            x1={PLOT.x0}
            y1={y(tick)}
            x2={PLOT.x1}
            y2={y(tick)}
            stroke="var(--color-bezel)"
            strokeWidth="1"
          />
          <text
            x={PLOT.x0 - 12}
            y={y(tick)}
            textAnchor="end"
            dominantBaseline="middle"
            fill="var(--color-ink-muted)"
            className="font-mono"
            fontSize={TICK_UNITS}
          >
            {axisElevation(tick, units)}
          </text>
        </g>
      ))}

      <g clipPath="url(#sb-section-reveal)">
        {sectionBands(points, gradeClass).map((band, i) => (
          <path
            key={i}
            d={sectionAreaPath(band.points, scale, PLOT.y1)}
            fill={`url(#sb-hatch-${band.step})`}
          />
        ))}
      </g>

      {freezingLevelM !== undefined && freezingLevelM < maxElevation ? (
        <g>
          <line
            x1={PLOT.x0}
            y1={y(freezingLevelM)}
            x2={PLOT.x1}
            y2={y(freezingLevelM)}
            stroke="var(--color-water)"
            strokeWidth="1.5"
            strokeDasharray="7 5"
          />
          <text
            x={PLOT.x0 + 8}
            y={y(freezingLevelM) - 9}
            fill="var(--color-water)"
            className="collar"
            style={{ fontSize: 11 }}
          >
            Freezing level {formatElevation(freezingLevelM, units)}
          </text>
        </g>
      ) : null}

      <polyline
        points={profile}
        fill="none"
        stroke="var(--color-contour)"
        strokeWidth="2.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        pathLength={1}
        className="sb-draw"
      />

      {callouts.map((callout, i) => {
        const point = sampleSection(points, callout.distanceM);
        const cx = x(callout.distanceM);
        const cy = y(point);
        const block = placed[i]!;
        // Which edge the leader meets: whichever of the two is nearer the rule.
        const trailing = Math.abs(block.right - cx) < Math.abs(block.left - cx);
        const textX = trailing ? block.right : block.left;
        const stroke = `var(--color-${callout.plate ?? 'contour'})`;
        return (
          <g key={callout.distanceM}>
            <line x1={cx} y1={cy - 6} x2={cx} y2={COLLAR_RULE_Y} stroke={stroke} strokeWidth="1" />
            {/*
             * The arm across to the text, as long as it needs to be. Dashed because a
             * displaced arm passes under the block that displaced it, and a solid rule that
             * length below a line of text is an underline; a broken one is a leader.
             */}
            <line
              x1={cx}
              y1={COLLAR_RULE_Y}
              x2={textX}
              y2={COLLAR_RULE_Y}
              stroke={stroke}
              strokeWidth="1"
              strokeDasharray="3 3"
            />
            <circle cx={cx} cy={cy} r="3.5" fill={stroke} />
            <text
              x={textX}
              y={CALLOUT_LABEL_Y}
              textAnchor={trailing ? 'end' : 'start'}
              fill="var(--color-ink-muted)"
              className="collar"
              style={{ fontSize: COLLAR_UNITS }}
            >
              {callout.label}
            </text>
            <text
              x={textX}
              y={CALLOUT_DETAIL_Y}
              textAnchor={trailing ? 'end' : 'start'}
              fill={stroke}
              className="font-mono"
              fontSize={CALLOUT_UNITS}
            >
              {callout.detail}
            </text>
          </g>
        );
      })}

      {cursorM === null ? null : (
        <g>
          {/*
           * A full-height rule rather than a dot alone: it meets the distance axis, so the
           * reader pairing this with the map beside it sees which kilometre without looking.
           */}
          <line
            x1={x(cursorM)}
            y1={PLOT.y0 - 10}
            x2={x(cursorM)}
            y2={PLOT.y1}
            stroke="var(--color-ink)"
            strokeWidth="1"
            opacity="0.5"
          />
          {/* Ringed in the canvas colour so the dot stays legible over its own hatching. */}
          <circle
            cx={x(cursorM)}
            cy={y(sampleSection(points, cursorM))}
            r="5"
            fill="var(--color-ink)"
            stroke="var(--color-canvas)"
            strokeWidth="2"
          />
        </g>
      )}

      {/* Distance below, arrival clock below that. The second axis is the whole feature. */}
      <line
        x1={PLOT.x0}
        y1={PLOT.y1}
        x2={PLOT.x1}
        y2={PLOT.y1}
        stroke="var(--color-ink-muted)"
        strokeWidth="1"
      />
      {stations.map((station, i) => {
        // The end labels anchor inward: centred, the first would sit half outside the plot and
        // collide with the axis unit, and the last would hang off the right edge.
        const anchor = i === 0 ? 'start' : i === stations.length - 1 ? 'end' : 'middle';
        return (
          <g key={station.distanceM}>
            <line
              x1={x(station.distanceM)}
              y1={PLOT.y1}
              x2={x(station.distanceM)}
              y2={PLOT.y1 + 6}
              stroke="var(--color-ink-muted)"
              strokeWidth="1"
            />
            <text
              x={x(station.distanceM)}
              y={PLOT.y1 + 24}
              textAnchor={anchor}
              fill="var(--color-ink)"
              className="font-mono"
              fontSize={TICK_UNITS}
            >
              {axisDistance(station.distanceM, units)}
            </text>
            {station.time ? (
              <text
                x={x(station.distanceM)}
                y={PLOT.y1 + 44}
                textAnchor={anchor}
                fill="var(--color-ink-muted)"
                className="font-mono"
                fontSize={TICK_UNITS}
              >
                {station.time}
              </text>
            ) : null}
          </g>
        );
      })}
      {/*
        Both rows are numbers; without units the clock row reads as a second distance.

        `fill`, not `color`, and that distinction is the whole reason these were invisible.
        `.collar` sets the face, the size, the tracking and `color` — which is everything an
        HTML label needs and one thing short of what an SVG label needs, because SVG text is
        painted with `fill`, whose initial value is black. On the light palette black-on-cream
        is merely the wrong ink; on the dark one it is black on near-black, and the three
        glosses that name the units of every number in the graphic were gone. Nothing in the
        stylesheets maps one to the other, so each `<text>` states its own paint — as the
        freezing-level and callout labels above already do.
      */}
      <g fill="var(--color-ink-muted)" className="collar" style={{ fontSize: COLLAR_UNITS }}>
        <text x={PLOT.x0 - 12} y={PLOT.y1 + 24} textAnchor="end">
          {DISTANCE_UNIT[units]}
        </text>
        <text x={PLOT.x0 - 12} y={PLOT.y1 + 44} textAnchor="end">
          {timeAxisLabel}
        </text>
        <text x={PLOT.x0 - 12} y={PLOT.y0 - 10} textAnchor="end">
          {ELEVATION_UNIT[units]}
        </text>
      </g>
    </svg>
  );
}

/**
 * Grade → hatch index. The ramp is a design token, so `sectionBands` is handed this rather than
 * importing it: the geometry package stays free of the palette, and the phone passes its own.
 */
function gradeClass(grade: number): number {
  return GRADE_STEPS.indexOf(gradeStep(grade));
}

/**
 * How much horizontal room a callout needs — the wider of its two lines. Which one wins changes
 * with the weather: `68°F · gusts 5 mph` most days, `HIGH POINT 09:54` when there is no reading.
 */
function calloutWidth(callout: SectionCallout): number {
  return Math.max(
    callout.label.length * COLLAR_ADVANCE * COLLAR_UNITS,
    callout.detail.length * MONO_ADVANCE * CALLOUT_UNITS,
  );
}
