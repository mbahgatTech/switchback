import { useId } from 'react';
import Svg, {
  Circle,
  Defs,
  G,
  Line,
  Path,
  Pattern,
  Polyline,
  Text as SvgText,
} from 'react-native-svg';
import {
  DISTANCE_UNIT,
  ELEVATION_UNIT,
  type UnitSystem,
  axisDistance,
  axisElevation,
} from '@switchback/core';
import {
  type SectionPoint,
  type SectionStation,
  sampleSection,
  sectionAreaPath,
  sectionBands,
  sectionLinePoints,
  sectionScale,
} from '@switchback/geo';
import { GRADE_STEPS, NATIVE_FONTS, SCHEMES, gradeStep } from '@switchback/ui';
import type { Scheme } from '@switchback/ui';

/**
 * The section, on a phone.
 *
 * The same graphic as the website's, from the same numbers: every scale, every band split
 * and every path `d` below comes out of `@switchback/geo`, which is also what
 * `apps/web/src/components/section.tsx` calls. Neither file re-derives a curve, so the two
 * renderings agree exactly rather than approximately.
 *
 * What is *not* shared is the sheet it is drawn on, and that is deliberate. The website
 * plots into a 1000-unit viewBox and lets the browser scale it; doing the same here would
 * letterbox a 1000pt drawing onto a 340pt screen and render 13pt axis labels at about 4pt.
 * So this component works in real points — the plot rectangle is the phone's own — and the
 * type sizes below are the sizes the reader actually sees.
 *
 * The other differences from the web version are all consequences of the screen:
 *
 * - **Coarser hatching.** The plot is roughly a third of the website's width, so the token
 *   spacings are scaled toward it and then floored. Below about 2.5pt the lines merge into
 *   a flat tone and the encoding stops encoding.
 * - **No draw-on.** The web reveal is a CSS clip animation with no client bundle behind it.
 *   Reproducing it here would mean an `Animated` value and a re-render per frame for a
 *   graphic that is already on screen by the time the push transition ends.
 * - **No callouts.** They are collar annotations that need horizontal room this width does
 *   not have. The weather readings they carry on the website get their own row on the
 *   phone rather than being crammed above the plot.
 */

/** Fixed, not a ratio: the axis rows and the type in them do not scale with screen width. */
export const SECTION_HEIGHT = 196;

/**
 * The margins around the plot, in points.
 *
 * `left` is set by the widest thing that goes in it, which is a grouped five-figure
 * elevation at 10pt mono — `10,000` ft, the top rung of the imperial ladder — with room for
 * the collar glosses beneath the axis. `bottom` holds two rows of labels — distance, then
 * elapsed time — which is the whole feature.
 */
const PAD = { top: 12, right: 10, bottom: 36, left: 52 } as const;

/** Below this the plot is narrower than its own axis labels and there is nothing to draw. */
const MIN_WIDTH = PAD.left + PAD.right + 80;

/**
 * Token hatch spacing is in web pixels against a ~900px plot. This plot is about a third
 * of that, so holding the *texture* rather than the number means scaling toward it.
 */
const HATCH_SCALE = 0.8;

/** Two hatch lines closer than this read as one flat tone at any pixel density. */
const MIN_HATCH = 2.5;

const AXIS_SIZE = 10;
const COLLAR_SIZE = 8.5;

export interface SectionProps {
  points: readonly SectionPoint[];
  stations: readonly SectionStation[];
  elevationTicks: readonly number[];
  /** Which units both axes are labelled in. See the website's `<Section>` on why required. */
  units: UnitSystem;
  /** Measured by the caller, which owns the touch tracking and so already has the layout. */
  width: number;
  cursorDistanceM?: number | null;
  scheme?: Scheme;
  /** Read aloud in place of the drawing. The graphic is one image to a screen reader. */
  summary: string;
}

/**
 * A touch x, in points from the left of the graphic, as a distance along the trail.
 *
 * Exported because the pan responder lives on the screen — it has to, or the section could
 * not be inside a `ScrollView` — and inverting the scale needs `PAD`. A second copy of
 * these numbers up there would put the cursor off the line the first time either changed.
 */
export function distanceAtX(x: number, width: number, totalM: number): number {
  const span = Math.max(1, width - PAD.right - PAD.left);
  const fraction = (x - PAD.left) / span;
  return Math.min(Math.max(fraction, 0), 1) * totalM;
}

export function Section({
  points,
  stations,
  elevationTicks,
  units,
  width,
  cursorDistanceM = null,
  scheme = 'sheet',
  summary,
}: SectionProps) {
  // `useId` gives a document-unique string; the punctuation in it is not valid in a
  // `url(#…)` reference, so it is stripped rather than trusted.
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const color = SCHEMES[scheme];

  if (points.length < 2 || width < MIN_WIDTH) return null;

  const plot = {
    x0: PAD.left,
    x1: width - PAD.right,
    y0: PAD.top,
    y1: SECTION_HEIGHT - PAD.bottom,
  };

  const scale = sectionScale(points, elevationTicks, plot);
  const cursorM =
    cursorDistanceM === null ? null : Math.min(Math.max(cursorDistanceM, 0), scale.maxDistanceM);

  return (
    <Svg
      width={width}
      height={SECTION_HEIGHT}
      accessible
      accessibilityRole="image"
      accessibilityLabel={summary}
    >
      <Defs>
        {GRADE_STEPS.map((step, i) => {
          const gap = Math.max(MIN_HATCH, step.hatch * HATCH_SCALE);
          return (
            <Pattern
              key={i}
              id={`${uid}h${i}`}
              width={gap}
              height={gap}
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)"
            >
              <Line
                x1={0}
                y1={0}
                x2={0}
                y2={gap}
                stroke={color.contour}
                strokeWidth={1}
                opacity={0.85}
              />
            </Pattern>
          );
        })}
      </Defs>

      {/* Elevation grid. Hairlines behind everything, never competing with the profile. */}
      {elevationTicks.map((tick) => (
        <G key={tick}>
          <Line
            x1={plot.x0}
            y1={scale.y(tick)}
            x2={plot.x1}
            y2={scale.y(tick)}
            stroke={color.bezel}
            strokeWidth={1}
          />
          {/*
           * Baselined by hand. `dominantBaseline` is honoured inconsistently across the
           * two native SVG backends, and a tick label half a line off its own rule is the
           * kind of thing that reads as sloppiness rather than as a platform difference.
           */}
          <SvgText
            x={plot.x0 - 6}
            y={scale.y(tick) + AXIS_SIZE * 0.35}
            textAnchor="end"
            fill={color.inkMuted}
            fontFamily={NATIVE_FONTS.mono.regular}
            fontSize={AXIS_SIZE}
          >
            {axisElevation(tick, units)}
          </SvgText>
        </G>
      ))}

      {sectionBands(points, gradeClass).map((band, i) => (
        <Path
          key={i}
          d={sectionAreaPath(band.points, scale, plot.y1)}
          fill={`url(#${uid}h${band.step})`}
        />
      ))}

      <Polyline
        points={sectionLinePoints(points, scale)}
        fill="none"
        stroke={color.contour}
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
      />

      {cursorM === null ? null : (
        <G>
          {/*
           * A full-height rule, as on the website: it meets the distance axis, so the
           * reader is told which kilometre they are holding without a second glance.
           */}
          <Line
            x1={scale.x(cursorM)}
            y1={plot.y0}
            x2={scale.x(cursorM)}
            y2={plot.y1}
            stroke={color.ink}
            strokeWidth={1}
            opacity={0.5}
          />
          {/* Ringed in the canvas colour so the dot stays legible over its own hatching. */}
          <Circle
            cx={scale.x(cursorM)}
            cy={scale.y(sampleSection(points, cursorM))}
            r={5}
            fill={color.ink}
            stroke={color.canvas}
            strokeWidth={2}
          />
        </G>
      )}

      {/* Distance below, arrival clock below that. The second axis is the whole feature. */}
      <Line
        x1={plot.x0}
        y1={plot.y1}
        x2={plot.x1}
        y2={plot.y1}
        stroke={color.inkMuted}
        strokeWidth={1}
      />
      {stations.map((station, i) => {
        // The end labels anchor inward. Centred, the first would sit half outside the plot
        // and collide with the gloss; the last would hang off the right edge.
        const anchor = i === 0 ? 'start' : i === stations.length - 1 ? 'end' : 'middle';
        return (
          <G key={station.distanceM}>
            <Line
              x1={scale.x(station.distanceM)}
              y1={plot.y1}
              x2={scale.x(station.distanceM)}
              y2={plot.y1 + 5}
              stroke={color.inkMuted}
              strokeWidth={1}
            />
            <SvgText
              x={scale.x(station.distanceM)}
              y={plot.y1 + 16}
              textAnchor={anchor}
              fill={color.ink}
              fontFamily={NATIVE_FONTS.mono.regular}
              fontSize={AXIS_SIZE}
            >
              {axisDistance(station.distanceM, units)}
            </SvgText>
            {station.time ? (
              <SvgText
                x={scale.x(station.distanceM)}
                y={plot.y1 + 30}
                textAnchor={anchor}
                fill={color.inkMuted}
                fontFamily={NATIVE_FONTS.mono.regular}
                fontSize={AXIS_SIZE}
              >
                {station.time}
              </SvgText>
            ) : null}
          </G>
        );
      })}

      {/*
       * Both rows are numbers, and without a gloss the second reads as a second distance.
       * Set in the collar face at collar size — marginalia, in the margin, as on a sheet.
       */}
      <SvgText
        x={plot.x0 - 6}
        y={plot.y1 + 16}
        textAnchor="end"
        fill={color.inkMuted}
        fontFamily={NATIVE_FONTS.displayCondensed.bold}
        fontSize={COLLAR_SIZE}
        letterSpacing={1}
      >
        {DISTANCE_UNIT[units].toUpperCase()}
      </SvgText>
      <SvgText
        x={plot.x0 - 6}
        y={plot.y1 + 30}
        textAnchor="end"
        fill={color.inkMuted}
        fontFamily={NATIVE_FONTS.displayCondensed.bold}
        fontSize={COLLAR_SIZE}
        letterSpacing={1}
      >
        ELAPSED
      </SvgText>
      <SvgText
        x={plot.x0 - 6}
        y={plot.y0 + 4}
        textAnchor="end"
        fill={color.inkMuted}
        fontFamily={NATIVE_FONTS.displayCondensed.bold}
        fontSize={COLLAR_SIZE}
        letterSpacing={1}
      >
        {ELEVATION_UNIT[units].toUpperCase()}
      </SvgText>
    </Svg>
  );
}

/**
 * Grade → hatch index.
 *
 * Passed to the shared band splitter rather than imported by it: the ramp is a design
 * token, and `@switchback/geo` stays free of the palette. The web renderer hands the same
 * function to the same splitter, which is why the bands break in the same places.
 */
function gradeClass(grade: number): number {
  return GRADE_STEPS.indexOf(gradeStep(grade));
}
