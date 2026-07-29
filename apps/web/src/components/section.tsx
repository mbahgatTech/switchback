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
 * The section.
 *
 * Not a chart — a section: the cross-section panel drawn in the margin of a printed trail
 * guide. It is the product's signature graphic and the only place where the flagship
 * feature, weather at the hour you arrive, is legible as one picture.
 *
 * Three things make it ours rather than a stock area chart:
 *
 * 1. **Hatched terrain fill, one hue.** The mass below the line is the contour plate and
 *    nothing else; hatch *density* carries gradient severity. Two encodings of the same
 *    fact would be redundant — one encoding that survives any colour vision deficiency is
 *    the point, and it costs no second legend.
 * 2. **Two axes of time.** Distance along the bottom and the arrival clock beneath it.
 * 3. **The freezing level**, drawn as a rule across the section, so which part of the hike
 *    is below freezing is a thing you see rather than a number you convert.
 *
 * Server-rendered SVG. The draw-on is CSS, so there is no client bundle and no hydration
 * for a graphic that never changes after paint.
 *
 * The projection — scales, band splitting, path building — is `@switchback/geo`'s, shared
 * verbatim with the iOS renderer. What is decided here is only what a sheet of paper this
 * wide should look like.
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
   * Which units the axes are labelled in.
   *
   * Required, and threaded from the same place the stat block beside the graphic reads it
   * from, because the two disagreeing is a bug the reader has no way to resolve: a section
   * measured in kilometres under a table measured in miles is one page reporting two
   * different trails. The tick *values* must have been chosen for this same system —
   * `elevationTicks` and `toStations` take it too, and pick their step ladder in it.
   */
  units: UnitSystem;
  callouts?: readonly SectionCallout[];
  /** Draws a rule at this elevation and labels it. Omit when it is above the summit. */
  freezingLevelM?: number;
  /** Multiplies the token hatch spacing. Above ~800px wide the raw values read as solid. */
  hatchScale?: number;
  /**
   * Where the reader's cursor is along the section, in metres. Draws a crosshair and
   * nothing else — the numbers belong in HTML beside the graphic, where they can be set
   * in real type and announced to a screen reader as text rather than as SVG labels.
   */
  cursorDistanceM?: number | null;
  /**
   * The unit gloss on the clock row. `at` when the stations carry a wall clock; something
   * like `elapsed` when they carry time from the trailhead. Both rows are numbers, so
   * without the right gloss the second reads as a second distance.
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
 * Lettering inside the plot, in viewBox units — not on the type ladder, and deliberately.
 *
 * Everything inside this `viewBox` is measured in one coordinate space: `PAD.left` is 68 of
 * the same units as the `- 12` that sets an axis label off its tick. A label sized in rem
 * would rescale with the reader's root font while the axis it labels stayed put, so the
 * numbers would drift off their own ticks at any zoom but 100%. `fontSize` as an attribute
 * keeps the type in the units the graphic is drawn in.
 *
 * They are 13 and 15 because that is what `--text-caption` and `--text-body` resolve to at
 * a 16 px root, which is where the chart is normally read — the ladder chose the sizes, the
 * viewBox chose the units.
 */
const TICK_UNITS = 13;
const CALLOUT_UNITS = 15;
const COLLAR_UNITS = 11;

/**
 * The height the callout leaders turn along, and why it is below the lettering it serves.
 *
 * The rule used to run up to `PAD.top - 34`, which is between the two lines of its own
 * label — fine while a callout sat directly under its own text, and the reason a second
 * callout drew a coloured rule straight through the first one's words the moment the two
 * were close enough to be displaced. Turning below the whole block instead means a leader
 * crosses only white space and other leaders, whoever else's text it passes beneath.
 */
const COLLAR_RULE_Y = PAD.top - 12;
const CALLOUT_LABEL_Y = PAD.top - 42;
const CALLOUT_DETAIL_Y = PAD.top - 22;

/**
 * Character advances, in ems, for the two faces the collar is set in.
 *
 * Server-rendered SVG cannot measure its own text: `getComputedTextLength` needs a laid-out
 * document, and by the time there is one the annotations have already been drawn on top of
 * each other. So the widths that decide the layout are estimated, and estimated *high* —
 * over-reserving costs a little air between two blocks, under-reserving costs the collision
 * this exists to prevent.
 *
 * The mono figure is exact rather than estimated. Measured against the rendered sheet, every
 * string in the graphic came back at 0.600 em per character — ticks, clocks, and a reading
 * carrying `°`, `·` and a slash alike — because IBM Plex Mono is monospaced at 0.6 em and so
 * is every fallback behind it. A count of characters is a measurement.
 *
 * The display figure is not, and cannot be: Archivo condensed to 78% and uppercased advances
 * by whatever glyphs the heading happens to contain. `TRAILHEAD 07:00` measures 0.618 em per
 * character and `HIGH POINT 09:54` measures 0.594 — call it 0.48 of glyph plus the 0.14 em
 * that `--text-micro` charges per character in tracking. 0.68 is that with room for a heading
 * of unusually wide letters, and the cost of being wrong in this direction is 10% of a word's
 * worth of air between two blocks that were never going to touch.
 */
const MONO_ADVANCE = 0.6;
const COLLAR_ADVANCE = 0.68;

/**
 * The plot rectangle, in viewBox units, and the viewBox itself.
 *
 * Exported so an interactive layer can invert the horizontal scale — turn a pointer
 * position back into a distance along the trail — using the same numbers the graphic drew
 * with. A second copy of these constants in the wrapper would drift the crosshair off the
 * line the first time either changed.
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
        // Which edge the leader meets: whichever of the two is nearer the rule. Normally the
        // left one, the block having been set down just to the right of its rule; the right
        // one when the sweep pulled the block back off the edge of the sheet and left the
        // rule standing inside it.
        const trailing = Math.abs(block.right - cx) < Math.abs(block.left - cx);
        const textX = trailing ? block.right : block.left;
        const stroke = `var(--color-${callout.plate ?? 'contour'})`;
        return (
          <g key={callout.distanceM}>
            <line x1={cx} y1={cy - 6} x2={cx} y2={COLLAR_RULE_Y} stroke={stroke} strokeWidth="1" />
            {/*
             * The arm across to the text, dashed.
             *
             * Ten units long when nothing was in the way and as long as it needs to be when
             * something was — the annotation admitting that its words are not above the place
             * they describe, rather than pretending. Dashed because a displaced arm has to
             * pass *under* the block it was displaced by, and a solid rule running the width
             * of a line of text at seven units below its baseline is an underline. A broken
             * one is a leader, which is what a printed sheet uses for exactly this reason.
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
           * A full-height rule rather than a dot alone. The reader is pairing this position
           * with the same position on the map beside it, and a rule that meets the distance
           * axis says which kilometre that is without a second glance.
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
        // The end labels anchor inward. Centred, the first one would sit half outside the
        // plot and collide with the axis unit; the last would hang off the right edge.
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
 * Grade → hatch index.
 *
 * The ramp is a design token, so `sectionBands` is handed this rather than importing it —
 * the geometry package stays free of the palette, and the phone passes the same function.
 */
function gradeClass(grade: number): number {
  return GRADE_STEPS.indexOf(gradeStep(grade));
}

/**
 * How much horizontal room a callout needs — the wider of its two lines.
 *
 * The heading is set small and condensed, the reading larger and monospaced, and which of
 * them wins changes with the weather: `68°F · gusts 5 mph` is the longer line most days,
 * `HIGH POINT 09:54` on the day the forecast came back with nothing to say and the reading
 * is an em dash.
 */
function calloutWidth(callout: SectionCallout): number {
  return Math.max(
    callout.label.length * COLLAR_ADVANCE * COLLAR_UNITS,
    callout.detail.length * MONO_ADVANCE * CALLOUT_UNITS,
  );
}
