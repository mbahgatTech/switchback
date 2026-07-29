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
  sectionAreaPath,
  sectionBands,
  sectionLinePoints,
  sectionScale,
} from '@switchback/geo';
import { GRADE_STEPS, SCHEMES, gradeStep } from '@switchback/ui';

/**
 * The section, printed.
 *
 * The same graphic as `<Section>` and deliberately not the same component. `<Section>` draws
 * into a 1000 × 380 viewBox — a 2.6 : 1 panel sized for a column of a web page. A full-width
 * strip along the foot of an A4 landscape sheet is 277 × 34 mm, which is 8 : 1. Reusing the
 * screen component means one of two failures: `preserveAspectRatio="xMidYMid meet"` letterboxes
 * it and two-thirds of the paper's width goes to white space, or `none` stretches it and every
 * letter, every hatch line and every gradient in the profile is horizontally distorted. The
 * second is worse than it sounds — a section whose slopes have been squashed is a cartographic
 * lie, and it is the one graphic on the sheet a reader uses to judge how hard the day is.
 *
 * So: a second renderer, drawing in millimetres, over the *same* projection. Every number that
 * decides where a point lands comes from `@switchback/geo` — `sectionScale`, `sectionBands`,
 * `sectionLinePoints`, `sectionAreaPath` — and the two renderers differ only in the rectangle
 * they are given and the weights they draw at. That split is why those functions take a plot
 * rectangle and a `classify` callback rather than owning either.
 *
 * Weights are the other half of the change. On screen the profile is 2.5 px, which at a
 * typical viewport is roughly 0.6 mm; printed at 0.6 mm beside 0.1 mm gridlines it reads as
 * a cable. Everything here is specified in true millimetres against what a 300 dpi printer
 * resolves — about 0.085 mm — so a hairline is a hairline rather than a grey band.
 */

export interface SheetSectionProps {
  points: readonly SectionPoint[];
  stations: readonly SectionStation[];
  elevationTicks: readonly number[];
  /** Which units both axes are labelled in. See `<Section>` on why this is not optional. */
  units: UnitSystem;
  widthMm: number;
  heightMm: number;
}

/**
 * Millimetres per unit of token hatch spacing.
 *
 * `GRADE_STEPS` carries hatch density in screen pixels — 9 for gentle ground down to 3.5 for
 * a steep climb — and what matters is the *ratio* between the rungs, since that ratio is the
 * encoding. At 0.13 the ladder lands between 1.17 mm and 0.455 mm: the coarsest still reads
 * as separate strokes at arm's length, the finest is four times a 300 dpi printer's dot and
 * survives being photocopied, which is what happens to a sheet left in a hut.
 */
const HATCH_MM = 0.13;

/**
 * Room for the elevation figures, left; the two axis rows, below.
 *
 * `left` holds the widest label the ladder can produce, which is a five-figure grouped
 * number — `10,000` ft, on the rung a sheet of the Himalaya reaches.
 */
const PAD_MM = { top: 3.2, right: 2, bottom: 8.4, left: 12.5 } as const;

export function SheetSection({
  points,
  stations,
  elevationTicks,
  units,
  widthMm,
  heightMm,
}: SheetSectionProps) {
  const sheet = SCHEMES.sheet;
  const plot = {
    x0: PAD_MM.left,
    x1: widthMm - PAD_MM.right,
    y0: PAD_MM.top,
    y1: heightMm - PAD_MM.bottom,
  };

  const scale = sectionScale(points, elevationTicks, plot);
  const profile = sectionLinePoints(points, scale);
  const bands = sectionBands(points, gradeClass);

  return (
    <svg
      viewBox={`0 0 ${widthMm} ${heightMm}`}
      width={`${widthMm}mm`}
      height={`${heightMm}mm`}
      aria-hidden="true"
    >
      <defs>
        {GRADE_STEPS.map((step, i) => {
          const gap = step.hatch * HATCH_MM;
          return (
            <pattern
              key={i}
              id={`sb-sheet-hatch-${i}`}
              width={gap}
              height={gap}
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)"
            >
              <line
                x1={0}
                y1={0}
                x2={0}
                y2={gap}
                stroke={sheet.contour}
                strokeWidth={0.11}
                opacity={0.9}
              />
            </pattern>
          );
        })}
      </defs>

      {/* Gridlines first, at a weight that is legible without being read. */}
      {elevationTicks.map((tick, index) => (
        <g key={tick}>
          <line
            x1={plot.x0}
            y1={scale.y(tick)}
            x2={plot.x1}
            y2={scale.y(tick)}
            stroke={sheet.bezel}
            strokeWidth={0.1}
          />
          <text
            x={plot.x0 - 1.4}
            y={scale.y(tick)}
            textAnchor="end"
            dominantBaseline="middle"
            fontSize={2.1}
            fill={sheet.inkMuted}
            style={{ fontFamily: 'var(--font-mono)' }}
          >
            {/*
              The unit rides on the top figure rather than sitting above the column as its own
              gloss, the way `km` and `h:mm` do below. Those two have an empty row in the left
              pad to sit on; the elevation column has a figure on every row and three
              millimetres of headroom, so a separate `m` lands on top of the topmost number.
              Gloss the first figure and the ladder below it reads in the same unit — which is
              how a printed section has always labelled its datum.
            */}
            {axisElevation(tick, units)}
            {index === elevationTicks.length - 1 ? ` ${ELEVATION_UNIT[units]}` : ''}
          </text>
        </g>
      ))}

      {/*
        The mass below the line, hatched by gradient. One hue and one variable — density —
        so the encoding survives being printed in black and white, which is how a great many
        of these sheets will actually leave a printer.
      */}
      {bands.map((band, i) => (
        <path
          key={i}
          d={sectionAreaPath(band.points, scale, plot.y1)}
          fill={`url(#sb-sheet-hatch-${band.step})`}
        />
      ))}

      <polyline
        points={profile}
        fill="none"
        stroke={sheet.contour}
        strokeWidth={0.4}
        strokeLinejoin="round"
        strokeLinecap="round"
      />

      <line
        x1={plot.x0}
        y1={plot.y1}
        x2={plot.x1}
        y2={plot.y1}
        stroke={sheet.ink}
        strokeWidth={0.2}
      />

      {stations.map((station, i) => {
        // End labels anchor inward, or the first hangs into the elevation figures and the
        // last off the edge of the strip.
        const anchor = i === 0 ? 'start' : i === stations.length - 1 ? 'end' : 'middle';
        const sx = scale.x(station.distanceM);
        return (
          <g key={station.distanceM}>
            <line
              x1={sx}
              y1={plot.y1}
              x2={sx}
              y2={plot.y1 + 1}
              stroke={sheet.ink}
              strokeWidth={0.15}
            />
            <text
              x={sx}
              y={plot.y1 + 3.6}
              textAnchor={anchor}
              fontSize={2.2}
              fill={sheet.ink}
              style={{ fontFamily: 'var(--font-mono)' }}
            >
              {axisDistance(station.distanceM, units)}
            </text>
            {station.time ? (
              <text
                x={sx}
                y={plot.y1 + 6.8}
                textAnchor={anchor}
                fontSize={2.2}
                fill={sheet.inkMuted}
                style={{ fontFamily: 'var(--font-mono)' }}
              >
                {station.time}
              </text>
            ) : null}
          </g>
        );
      })}

      {/*
        Both axis rows are bare numbers; the gloss is what stops the clock reading as a second
        distance.

        This block used to say the gloss was metric whatever the reader had asked for, on the
        grounds that the tick ladder was metric and relabelling it in miles would print
        `0.0 0.3 0.6` — evenly spaced, not round, and a round axis is most of what an axis is
        for. The observation was right and the conclusion did not follow. Relabelling a metric
        ladder is not the only way to get an imperial axis; choosing the ladder in miles in the
        first place is the other, and it is the one that keeps the numbers round. That is what
        `toStations` and `elevationTicks` now do — they pick a step in the reader's own unit
        and convert it back to the metres they plot in.

        Worth recording that the argument was also self-refuting on its own terms: the metric
        axis printed `0.0 0.3 0.5 0.8 1.0 1.1` on a 1.1 km trail, because a 250 m step is a
        quarter of a kilometre and a quarter cannot be written to one decimal. The unround row
        it warned about was already on the page, in the units it was defending.
      */}
      <g
        fill={sheet.inkMuted}
        fontSize={1.9}
        textAnchor="end"
        style={{ fontFamily: 'var(--font-display)' }}
        letterSpacing="0.06"
      >
        <text x={plot.x0 - 1.4} y={plot.y1 + 3.6}>
          {DISTANCE_UNIT[units]}
        </text>
        <text x={plot.x0 - 1.4} y={plot.y1 + 6.8}>
          h:mm
        </text>
      </g>
    </svg>
  );
}

/**
 * Grade → hatch index, the same mapping the screen uses.
 *
 * Handed to `sectionBands` rather than imported by it, so the palette stays out of the
 * geometry package and both renderers classify identically.
 */
function gradeClass(grade: number): number {
  return GRADE_STEPS.indexOf(gradeStep(grade));
}
