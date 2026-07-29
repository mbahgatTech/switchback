'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import type { BBox, LngLat, TrailDetail, UnitSystem, WaypointKind } from '@switchback/core';
import {
  ATTRIBUTION,
  BRAND,
  TERRAIN_CAUTION_COPY,
  formatDistance,
  formatDuration,
  formatElevation,
  terrainCaution,
} from '@switchback/core';
import {
  type PaperId,
  type SheetFrame,
  type SheetOrientation,
  type SheetSizeMm,
  SHEET_PAPERS,
  SHEET_SCALES,
  elevationTicks,
  fitSheetScale,
  formatDegrees,
  formatScale,
  hikedProfile,
  paperSizeMm,
  sheetBarScale,
  sheetCentre,
  toSectionPoints,
  toStations,
} from '@switchback/geo';
import { ELEVATION_BANDS, SCHEMES } from '@switchback/ui';
import { Blaze } from '@/components/blaze';
import { BAND_ELEVATIONS_M } from '../map/basemap';
import { mmToPx, snapSizeMm } from './mm';
import { type WaypointPlate, SheetFace, WAYPOINT_INK } from './sheet-face';
import { SheetSection } from './sheet-section';
import { HEIGHT } from '../controls';

/**
 * The sheet.
 *
 * A printed map is not a screenshot of a screen map, and the difference is not resolution.
 * A screen map answers questions one at a time — you pan to the ridge, you tap the summit,
 * you check the profile — and it can afford to, because asking is free. Paper cannot ask.
 * Everything the sheet will ever say has to be on it at the moment it leaves the printer,
 * arranged so that the answer to *where am I and how much is left* is found without
 * unfolding anything. So the sheet is a fixed composition rather than a viewport: a mapped
 * face inside a collar, a rail of figures beside it, the section along the foot, and a
 * statement of scale that a reader can hold a ruler against.
 *
 * Three properties make it a map rather than a picture of one:
 *
 * - **The ratio is real.** CSS defines an inch as exactly 96 px and browsers honour physical
 *   units when printing, so `1:25 000` in the collar is 1:25 000 under a ruler. Every
 *   dimension here is a millimetre for that reason, and the face is snapped to whole CSS
 *   pixels (`./mm`) so the SVG overlay and MapLibre agree on where the ground is.
 * - **North is up and the projection is flat.** No bearing, no pitch, no rotation gesture.
 *   A sheet a reader cannot orient by the graticule is a poster.
 * - **Nothing on it moves.** The controls live in a `data-print-hide` bar that the print
 *   stylesheet removes; what remains on paper is only ever the composition.
 *
 * The reader gets three decisions — paper, orientation, ratio — and the sheet recomposes
 * around each. Those are the three a printed series makes for you, and the reason to hand
 * them over is that we do not know which printer is in the room or whether the hike is a
 * valley round or a section of a long path.
 */

export interface SheetProps {
  trail: TrailDetail;
  units: UnitSystem;
}

/* ── Composition, in millimetres ──────────────────────────────────────────────────────── */

/**
 * The dead border. Every consumer printer has an unprintable edge, typically 5 mm and
 * occasionally more; 10 mm clears all of them and leaves a sheet that can be trimmed square
 * or hole-punched without losing a graticule figure.
 */
const MARGIN_MM = 10;

/** Wordmark, trail name, and the one line of context that names the place. */
const HEAD_MM = 14;

/** Ratio, bar scale, datum, attribution, date. */
const FOOT_MM = 12;

/** The white between blocks. One value everywhere — the composition is the structure. */
const GUTTER_MM = 4;

/**
 * The section strip.
 *
 * 34 mm is what a full-width profile needs to stay honest: about 22 mm of plot, which at a
 * typical day's 1,000 m of relief puts a 100 m contour interval a shade over 2 mm apart —
 * readable — plus two axis rows and the elevation figures. Less and the vertical
 * exaggeration climbs past the point where the graphic flatters the hike.
 */
const SECTION_MM = 34;

/** The margin inside the neatline, carrying ticks and graticule figures. */
const COLLAR_MM = 6;

/**
 * The rail.
 *
 * Wider in landscape because there is width to give and the face is already generous; the
 * portrait sheet spends its narrower page on the map, since a portrait sheet is what a
 * reader picks for a route that runs north–south and needs the length.
 */
const RAIL_MM: Record<SheetOrientation, number> = { landscape: 62, portrait: 54 };

/**
 * The hair the sheet is drawn short of the paper.
 *
 * A box declared at exactly the paper's size does not quite fit on it. The browser lays the
 * box out at 96 px to the inch — 210 mm is 793.70 px — while the printed page box is
 * computed through points and lands on 793.28 px. The box overflows its own page by four
 * tenths of a pixel, and Chromium answers an overflow by starting another page: the reader
 * gets their map, then a second sheet with nothing on it.
 *
 * Four tenths of a millimetre is more slack than that rounding needs and less than a laser
 * printer can resolve. It comes off the right and bottom edges, which carry a 10 mm margin
 * and no marks, so nothing on the sheet moves and nothing is clipped.
 */
const PAPER_BLEED_MM = 0.4;

interface SheetLayout {
  paperMm: SheetSizeMm;
  contentWidthMm: number;
  contentHeightMm: number;
  bodyHeightMm: number;
  railMm: number;
  /** Snapped to whole CSS pixels, so the two projections over it cannot disagree. */
  face: SheetSizeMm;
}

function layout(paper: PaperId, orientation: SheetOrientation): SheetLayout {
  const paperMm = paperSizeMm(paper, orientation);
  const contentWidthMm = paperMm.widthMm - 2 * MARGIN_MM;
  const contentHeightMm = paperMm.heightMm - 2 * MARGIN_MM;
  const bodyHeightMm = contentHeightMm - HEAD_MM - FOOT_MM - SECTION_MM - 3 * GUTTER_MM;
  const railMm = RAIL_MM[orientation];

  return {
    paperMm,
    contentWidthMm,
    contentHeightMm,
    bodyHeightMm,
    railMm,
    face: snapSizeMm({
      widthMm: contentWidthMm - GUTTER_MM - railMm - 2 * COLLAR_MM,
      heightMm: bodyHeightMm - 2 * COLLAR_MM,
    }),
  };
}

/**
 * Which way up the sheet starts.
 *
 * From the route's own shape, corrected for latitude — a degree of longitude at 51°N is
 * 630 m, not 1,110, and an uncorrected aspect ratio calls every northern route portrait.
 * The threshold sits above 1 rather than at it because turning a sheet is a decision and a
 * route that is very nearly square should not have one made for it on a rounding error.
 */
function initialOrientation(bbox: BBox): SheetOrientation {
  const [west, south, east, north] = bbox;
  const wide = (east - west) * Math.cos(((south + north) / 2) * (Math.PI / 180));
  const tall = Math.max(north - south, 1e-9);
  return wide / tall > 1.15 ? 'landscape' : 'portrait';
}

/** `1:2 500 000` is nine characters of button. The ladder reads as a ladder in shorthand. */
function compactScale(denominator: number): string {
  return denominator >= 1_000_000
    ? `${String(denominator / 1_000_000)}M`
    : `${String(denominator / 1_000)}k`;
}

function kindLabel(kind: WaypointKind): string {
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

/* ── The sheet ────────────────────────────────────────────────────────────────────────── */

export function Sheet({ trail, units }: SheetProps) {
  const sheet = SCHEMES.sheet;
  const bbox = trail.bbox;

  const [paper, setPaper] = useState<PaperId>('a4');
  const [orientation, setOrientation] = useState<SheetOrientation>(() => initialOrientation(bbox));
  const [denominator, setDenominator] = useState(() =>
    fitSheetScale(bbox, layout('a4', initialOrientation(bbox)).face),
  );
  const [centre, setCentre] = useState<LngLat>(() => sheetCentre(bbox));
  /**
   * Whether the ratio is still ours to change. A reader who picks 1:10 000 has said the sheet
   * is a detail sheet; turning the paper should not quietly undo that, and a fit that always
   * ran would, because a deliberately large scale never fits by definition.
   */
  const [autoScale, setAutoScale] = useState(true);
  const [ready, setReady] = useState(false);

  const plan = useMemo(() => layout(paper, orientation), [paper, orientation]);
  const frame: SheetFrame = useMemo(
    () => ({ centre, denominator, face: plan.face }),
    [centre, denominator, plan.face],
  );

  const section = useMemo(() => {
    // The hike rather than the stored line — an out-and-back is mapped once and hiked twice,
    // and this strip sits directly beneath a stat block quoting the round trip. See
    // `hikedProfile`; the same reconciliation the on-screen section makes.
    const hiked = hikedProfile(trail.profile, {
      routeType: trail.routeType,
      lengthM: trail.stats.lengthM,
    });
    const points = toSectionPoints(hiked);
    return {
      points,
      ticks: elevationTicks(trail.stats.maxEleM, units),
      // One station per ~34 mm of strip: close enough to read a distance off without
      // interpolating, far enough apart that the two axis rows never collide.
      stations: toStations(hiked, {
        system: units,
        maxMarks: Math.max(4, Math.round(plan.contentWidthMm / 34)),
      }),
    };
  }, [
    trail.profile,
    trail.routeType,
    trail.stats.lengthM,
    trail.stats.maxEleM,
    plan.contentWidthMm,
    units,
  ]);

  const bar = useMemo(() => sheetBarScale(denominator, 46), [denominator]);
  const platesPresent = useMemo(() => {
    const seen = new Map<WaypointPlate, WaypointKind>();
    for (const point of trail.waypoints) {
      const plate = WAYPOINT_INK[point.kind];
      if (!seen.has(plate)) seen.set(plate, point.kind);
    }
    return [...seen.entries()];
  }, [trail.waypoints]);

  const named = useMemo(
    () =>
      trail.waypoints
        .filter((point) => point.name !== null && point.distM !== null)
        .sort((a, b) => (a.distM ?? 0) - (b.distM ?? 0)),
    [trail.waypoints],
  );

  /*
   * The date the sheet was printed, set after mount rather than during render.
   *
   * It is genuinely load-bearing on paper — a sheet says what the ground looked like when it
   * left the printer, and OSM moves — but a clock read on the server and again in the browser
   * disagrees across midnight and hydration fails on the difference.
   */
  const [printedOn, setPrintedOn] = useState('');
  useEffect(() => {
    setPrintedOn(
      new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
    );
  }, []);

  /*
   * Fit the paper to the window on screen and undo it on paper.
   *
   * A4 landscape is 1,123 CSS px wide, which overflows most windows once the browser chrome
   * is counted. `transform: scale` shrinks the composition without touching the layout, so
   * every millimetre inside it stays a millimetre and the print rule only has to say
   * `transform: none`. Known cost: MapLibre reads pointer positions against an untransformed
   * box, so dragging the face is off by the scale factor below about 1,160 px of viewport.
   * At full size — which is where a reader checks the framing before printing — it is exact.
   */
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [fit, setFit] = useState(1);
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const paperPx = mmToPx(plan.paperMm.widthMm);
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setFit(width > 0 ? Math.min(1, width / paperPx) : 1);
    });
    observer.observe(stage);
    return () => {
      observer.disconnect();
    };
  }, [plan.paperMm.widthMm]);

  const reflow = useCallback(
    (nextPaper: PaperId, nextOrientation: SheetOrientation) => {
      setPaper(nextPaper);
      setOrientation(nextOrientation);
      if (autoScale) setDenominator(fitSheetScale(bbox, layout(nextPaper, nextOrientation).face));
    },
    [autoScale, bbox],
  );

  const fitRoute = useCallback(() => {
    setAutoScale(true);
    setDenominator(fitSheetScale(bbox, plan.face));
    setCentre(sheetCentre(bbox));
  }, [bbox, plan.face]);

  const chooseScale = useCallback((next: number) => {
    setAutoScale(false);
    setDenominator(next);
  }, []);

  const stats: [string, string][] = [
    ['Length', formatDistance(trail.stats.lengthM, units)],
    ['Ascent', `↑${formatElevation(trail.stats.gainM, units)}`],
    ['Descent', `↓${formatElevation(trail.stats.lossM, units)}`],
    ['High point', formatElevation(trail.stats.maxEleM, units)],
    ['Low point', formatElevation(trail.stats.minEleM, units)],
    [
      'Steepest',
      trail.stats.maxSustainedGrade === null
        ? '—'
        : `${String(Math.round(trail.stats.maxSustainedGrade * 100))}%`,
    ],
    ['Moving time', formatDuration(trail.stats.estimatedTimeS)],
  ];

  /*
   * The one thing on this sheet that is not a figure.
   *
   * A printed map is the artifact that goes up the hill when the phone is dead, so it is the
   * last chance the product has to say this — and unlike every screen, it cannot be tapped
   * for more. If the ground is steeper than hiking, it is printed here in ink.
   */
  const caution = terrainCaution(trail.stats.maxSustainedGrade);

  return (
    <>
      {/*
        `@page` cannot read a custom property, and the size has to change when the reader
        changes the paper — so it is emitted as markup and re-rendered rather than declared
        once in the stylesheet. Explicit millimetres rather than `A4 landscape`, because the
        keyword form leaves the browser to reconcile a named size with an orientation and
        they do not all reconcile it the same way.
      */}
      <style>{`@page { size: ${String(plan.paperMm.widthMm)}mm ${String(plan.paperMm.heightMm)}mm; margin: 0 }`}</style>

      <ControlBar
        trail={trail}
        paper={paper}
        orientation={orientation}
        denominator={denominator}
        ready={ready}
        onPaper={(next) => {
          reflow(next, orientation);
        }}
        onOrientation={(next) => {
          reflow(paper, next);
        }}
        onScale={chooseScale}
        onFit={fitRoute}
      />

      <div
        ref={stageRef}
        data-print-stage
        className="mx-auto w-full max-w-sheet px-xl pb-4xl"
        style={{ height: `${String(mmToPx(plan.paperMm.heightMm) * fit)}px` }}
      >
        <div
          data-print-sheet
          data-scheme="sheet"
          style={{
            width: `${String(plan.paperMm.widthMm - PAPER_BLEED_MM)}mm`,
            height: `${String(plan.paperMm.heightMm - PAPER_BLEED_MM)}mm`,
            transform: `scale(${String(fit)})`,
            transformOrigin: 'top left',
            background: '#FFFFFF',
            color: sheet.ink,
            position: 'relative',
            overflow: 'hidden',
            // Browsers strip backgrounds when printing unless told the colour is the content.
            // On a hypsometric sheet it is exactly the content.
            printColorAdjust: 'exact',
            WebkitPrintColorAdjust: 'exact',
            boxShadow: '0 1px 24px rgba(22, 28, 29, 0.14)',
          }}
        >
          <div
            style={{
              position: 'absolute',
              left: `${String(MARGIN_MM)}mm`,
              top: `${String(MARGIN_MM)}mm`,
              width: `${String(plan.contentWidthMm)}mm`,
              height: `${String(plan.contentHeightMm)}mm`,
            }}
          >
            {/* ── Head ─────────────────────────────────────────────────────────────── */}
            <header
              style={{
                height: `${String(HEAD_MM)}mm`,
                display: 'flex',
                alignItems: 'flex-end',
                justifyContent: 'space-between',
                gap: '6mm',
                borderBottom: `0.3mm solid ${sheet.ink}`,
                paddingBottom: '1.4mm',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '2.6mm', minWidth: 0 }}>
                <h1
                  style={{
                    fontFamily: 'var(--font-display)',
                    fontSize: '5.2mm',
                    fontWeight: 700,
                    letterSpacing: '-0.02em',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {trail.name}
                </h1>
                <p
                  style={{
                    fontFamily: 'var(--font-display)',
                    fontSize: '2.6mm',
                    color: sheet.inkMuted,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {trail.regionName ?? 'Unnamed district'}
                </p>
              </div>

              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '1.8mm',
                  color: sheet.woodland,
                  flexShrink: 0,
                }}
              >
                <Blaze size={14} />
                <span
                  style={{
                    fontFamily: 'var(--font-display)',
                    fontSize: '3.2mm',
                    fontWeight: 600,
                    letterSpacing: '-0.01em',
                    color: sheet.ink,
                  }}
                >
                  {BRAND.name}
                </span>
              </div>
            </header>

            {/* ── Body: the mapped face, and the rail beside it ────────────────────── */}
            <div
              style={{
                marginTop: `${String(GUTTER_MM)}mm`,
                height: `${String(plan.bodyHeightMm)}mm`,
                display: 'flex',
                gap: `${String(GUTTER_MM)}mm`,
              }}
            >
              <SheetFace
                frame={frame}
                collarMm={COLLAR_MM}
                route={trail.geometry.coordinates}
                waypoints={trail.waypoints}
                onCentreChange={setCentre}
                onReadyChange={setReady}
              />

              <aside
                style={{
                  flex: 1,
                  minWidth: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '3mm',
                  overflow: 'hidden',
                }}
              >
                <Block label="Figures" sheet={sheet}>
                  <dl
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr 1fr',
                      columnGap: '2mm',
                      rowGap: '1.6mm',
                    }}
                  >
                    {stats.map(([label, value]) => (
                      <div key={label}>
                        <dt
                          style={{
                            fontFamily: 'var(--font-display)',
                            fontSize: '1.9mm',
                            letterSpacing: '0.08em',
                            textTransform: 'uppercase',
                            color: sheet.inkMuted,
                          }}
                        >
                          {label}
                        </dt>
                        <dd style={{ fontFamily: 'var(--font-mono)', fontSize: '2.9mm' }}>
                          {value}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </Block>

                {caution ? (
                  <div
                    style={{
                      borderLeft: `0.6mm solid ${sheet.survey}`,
                      paddingLeft: '2mm',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '0.8mm',
                    }}
                  >
                    <p
                      style={{
                        fontFamily: 'var(--font-display)',
                        fontSize: '2.4mm',
                        fontWeight: 600,
                        color: sheet.survey,
                      }}
                    >
                      {TERRAIN_CAUTION_COPY[caution].title}
                    </p>
                    <p
                      style={{
                        fontFamily: 'var(--font-text)',
                        fontSize: '2.1mm',
                        lineHeight: 1.35,
                      }}
                    >
                      {TERRAIN_CAUTION_COPY[caution].body}
                    </p>
                  </div>
                ) : null}

                <Block label="Marks" sheet={sheet}>
                  <ul
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr 1fr',
                      columnGap: '2mm',
                      rowGap: '1.2mm',
                      fontFamily: 'var(--font-display)',
                      fontSize: '2.2mm',
                    }}
                  >
                    <Key sheet={sheet}>
                      <svg width="6mm" height="2mm" viewBox="0 0 6 2" aria-hidden="true">
                        <line
                          x1={0}
                          y1={1}
                          x2={6}
                          y2={1}
                          stroke={sheet.woodland}
                          strokeWidth={0.7}
                        />
                      </svg>
                      The route
                    </Key>
                    <Key sheet={sheet}>
                      <svg width="6mm" height="2.4mm" viewBox="0 0 6 2.4" aria-hidden="true">
                        <circle cx={1.6} cy={1.2} r={1.05} fill={sheet.woodland} />
                        <circle
                          cx={4.4}
                          cy={1.2}
                          r={1.05}
                          fill="#FFFFFF"
                          stroke={sheet.woodland}
                          strokeWidth={0.45}
                        />
                      </svg>
                      Start / finish
                    </Key>
                    {platesPresent.map(([plate, kind]) => (
                      <Key key={plate} sheet={sheet}>
                        <svg width="6mm" height="2.4mm" viewBox="0 0 6 2.4" aria-hidden="true">
                          {plate === 'contour' ? (
                            <polygon
                              points="3,0.35 4.1,2.05 1.9,2.05"
                              fill={sheet.contour}
                              stroke="#FFFFFF"
                              strokeWidth={0.3}
                            />
                          ) : (
                            <circle
                              cx={3}
                              cy={1.2}
                              r={0.85}
                              fill={sheet[plate]}
                              stroke="#FFFFFF"
                              strokeWidth={0.3}
                            />
                          )}
                        </svg>
                        {kindLabel(kind)}
                        {plate === 'ink' ? ' &c.' : ''}
                      </Key>
                    ))}
                  </ul>
                </Block>

                <Block label="Ground" sheet={sheet}>
                  <Hypsometric railMm={plan.railMm} sheet={sheet} />
                </Block>

                {named.length > 0 ? (
                  <Block label="Along the way" sheet={sheet} grow>
                    <ol
                      style={{
                        fontFamily: 'var(--font-display)',
                        fontSize: '2.2mm',
                        lineHeight: 1.45,
                      }}
                    >
                      {named.map((point) => (
                        <li
                          key={point.id}
                          style={{ display: 'flex', gap: '1.4mm', alignItems: 'baseline' }}
                        >
                          <span
                            style={{
                              fontFamily: 'var(--font-mono)',
                              fontSize: '2mm',
                              color: sheet.inkMuted,
                              flexShrink: 0,
                              width: '9mm',
                              textAlign: 'right',
                            }}
                          >
                            {formatDistance(point.distM ?? 0, units)}
                          </span>
                          <span
                            style={{
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {point.name}
                          </span>
                        </li>
                      ))}
                    </ol>
                  </Block>
                ) : null}
              </aside>
            </div>

            {/* ── Section ──────────────────────────────────────────────────────────── */}
            <div style={{ marginTop: `${String(GUTTER_MM)}mm`, height: `${String(SECTION_MM)}mm` }}>
              <SheetSection
                points={section.points}
                stations={section.stations}
                elevationTicks={section.ticks}
                units={units}
                widthMm={plan.contentWidthMm}
                heightMm={SECTION_MM}
              />
            </div>

            {/* ── Foot ─────────────────────────────────────────────────────────────── */}
            <footer
              style={{
                marginTop: `${String(GUTTER_MM)}mm`,
                height: `${String(FOOT_MM)}mm`,
                borderTop: `0.3mm solid ${sheet.ink}`,
                paddingTop: '1.4mm',
                display: 'flex',
                alignItems: 'flex-start',
                justifyContent: 'space-between',
                gap: '6mm',
                fontFamily: 'var(--font-display)',
                fontSize: '2.1mm',
                color: sheet.inkMuted,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: '4mm' }}>
                <div>
                  <p
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: '2.9mm',
                      color: sheet.ink,
                    }}
                  >
                    {formatScale(denominator)}
                  </p>
                  {/*
                    The ratio is true at the centre latitude and nowhere else — Mercator
                    stretches with the cosine, so a sheet at 51°N is about 1.6 % smaller in
                    ground terms at its top edge than at its bottom. Saying where it is exact
                    is the difference between a scale statement and a claim.
                  */}
                  <p style={{ marginTop: '0.6mm' }}>
                    North is up · WGS 84 · exact at {formatDegrees(centre[1], 'lat')}
                  </p>
                </div>
                <BarScale bar={bar} sheet={sheet} />
              </div>

              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                <p>
                  {ATTRIBUTION.osm.label} ({ATTRIBUTION.osm.licence}) · {ATTRIBUTION.terrain.label}
                </p>
                <p style={{ marginTop: '0.6mm' }}>
                  {BRAND.domain}/trails/{trail.slug}
                  {printedOn ? ` · printed ${printedOn}` : ''}
                </p>
              </div>
            </footer>
          </div>
        </div>
      </div>
    </>
  );
}

/* ── Rail furniture ───────────────────────────────────────────────────────────────────── */

type Scheme = (typeof SCHEMES)['sheet'];

function Block({
  label,
  sheet,
  grow = false,
  children,
}: {
  label: string;
  sheet: Scheme;
  grow?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section
      style={{
        ...(grow ? { flex: 1, minHeight: 0 } : {}),
        overflow: 'hidden',
      }}
    >
      <h2
        style={{
          fontFamily: 'var(--font-display)',
          fontSize: '1.9mm',
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: sheet.inkMuted,
          borderBottom: `0.15mm solid ${sheet.bezel}`,
          paddingBottom: '0.8mm',
          marginBottom: '1.4mm',
        }}
      >
        {label}
      </h2>
      {children}
    </section>
  );
}

function Key({ sheet, children }: { sheet: Scheme; children: React.ReactNode }) {
  return (
    <li
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '1.2mm',
        color: sheet.ink,
        overflow: 'hidden',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </li>
  );
}

/**
 * The hypsometric key.
 *
 * The same seven bands at the same elevations as the face, and as the screen — `ELEVATION_BANDS`
 * carries a doc comment declaring itself scheme-independent cartography, and a key that did not
 * match it would make the sheet unreadable rather than merely inconsistent.
 */
function Hypsometric({ railMm, sheet }: { railMm: number; sheet: Scheme }) {
  const swatch = railMm / ELEVATION_BANDS.length;

  return (
    <svg
      viewBox={`0 0 ${String(railMm)} 7`}
      width={`${String(railMm)}mm`}
      height="7mm"
      aria-hidden="true"
    >
      {ELEVATION_BANDS.map((color, index) => (
        <rect key={color} x={index * swatch} y={0} width={swatch} height={2.4} fill={color} />
      ))}
      <rect
        x={0}
        y={0}
        width={railMm}
        height={2.4}
        fill="none"
        stroke={sheet.bezel}
        strokeWidth={0.12}
      />
      {[0, 2, 4, 6].map((index) => (
        <text
          key={index}
          x={Math.min(index * swatch, railMm)}
          y={5.6}
          textAnchor={index === 6 ? 'end' : 'start'}
          fontSize={1.9}
          fill={sheet.inkMuted}
          style={{ fontFamily: 'var(--font-mono)' }}
        >
          {/*
            The unit rides the last figure, which is where the section puts it too — one rule
            for both ladders on the sheet, so a reader learns it once. It used to sit on the
            ramp itself, in white, over the top band; that band is `#D8D6CF`, so the letter was
            white on near-white and hard against the neatline. A gloss you have to hunt for is
            worse than no gloss, and a gloss attached to a number cannot be misread as a label
            for the band it happens to be lying on.
          */}
          {(BAND_ELEVATIONS_M[index] ?? 0).toLocaleString('en-GB')}
          {index === 6 ? ' m' : ''}
        </text>
      ))}
    </svg>
  );
}

/**
 * The drawn bar.
 *
 * Printed beside the ratio rather than instead of it, because the two fail differently: a
 * stated ratio is wrong the moment a sheet is photocopied at 94 % or printed with "fit to
 * page" left on, and a drawn bar is still right. One of them survives whatever happens to
 * this piece of paper between here and the trailhead.
 */
function BarScale({
  bar,
  sheet,
}: {
  bar: { groundM: number; lengthMm: number; rungs: number };
  sheet: Scheme;
}) {
  if (bar.lengthMm <= 0 || bar.rungs <= 0) return null;

  const seg = bar.lengthMm / bar.rungs;
  const label =
    bar.groundM >= 1_000 ? `${String(bar.groundM / 1_000)} km` : `${String(bar.groundM)} m`;

  return (
    <svg
      viewBox={`0 0 ${String(bar.lengthMm + 6)} 7`}
      width={`${String(bar.lengthMm + 6)}mm`}
      height="7mm"
      aria-hidden="true"
    >
      {Array.from({ length: bar.rungs }, (_, i) => (
        <rect
          key={i}
          x={i * seg}
          y={0.6}
          width={seg}
          height={1.3}
          fill={i % 2 === 0 ? sheet.ink : '#FFFFFF'}
          stroke={sheet.ink}
          strokeWidth={0.12}
        />
      ))}
      <text
        x={0}
        y={4.6}
        fontSize={1.9}
        fill={sheet.inkMuted}
        style={{ fontFamily: 'var(--font-mono)' }}
      >
        0
      </text>
      <text
        x={bar.lengthMm}
        y={4.6}
        textAnchor="middle"
        fontSize={1.9}
        fill={sheet.inkMuted}
        style={{ fontFamily: 'var(--font-mono)' }}
      >
        {label}
      </text>
    </svg>
  );
}

/* ── The controls, which never print ──────────────────────────────────────────────────── */

const PRESSED = 'border-ink bg-ink text-canvas';
const UNPRESSED = 'border-bezel text-ink-muted hover:border-ink-muted hover:text-ink';

function ControlBar({
  trail,
  paper,
  orientation,
  denominator,
  ready,
  onPaper,
  onOrientation,
  onScale,
  onFit,
}: {
  trail: TrailDetail;
  paper: PaperId;
  orientation: SheetOrientation;
  denominator: number;
  ready: boolean;
  onPaper: (next: PaperId) => void;
  onOrientation: (next: SheetOrientation) => void;
  onScale: (next: number) => void;
  onFit: () => void;
}) {
  return (
    <div data-print-hide className="sticky top-0 z-10 border-b border-bezel bg-canvas">
      <div className="mx-auto flex max-w-sheet flex-wrap items-center gap-x-xl gap-y-md px-xl py-md">
        <Link
          href={`/trails/${trail.slug}`}
          className="collar rounded-hair transition-colors duration-quick ease-standard hover:text-ink"
        >
          ← {trail.name}
        </Link>

        <Field label="Paper">
          {SHEET_PAPERS.map((option) => (
            <button
              key={option.id}
              type="button"
              aria-pressed={paper === option.id}
              onClick={() => {
                onPaper(option.id);
              }}
              className={`${HEIGHT.panel} rounded-hair border px-sm text-caption transition-colors duration-quick ease-standard ${paper === option.id ? PRESSED : UNPRESSED}`}
            >
              {option.label}
            </button>
          ))}
        </Field>

        <Field label="Turn">
          {(['landscape', 'portrait'] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={orientation === option}
              onClick={() => {
                onOrientation(option);
              }}
              className={`${HEIGHT.panel} rounded-hair border px-sm text-caption capitalize transition-colors duration-quick ease-standard ${orientation === option ? PRESSED : UNPRESSED}`}
            >
              {option}
            </button>
          ))}
        </Field>

        <Field label="Scale">
          {SHEET_SCALES.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={denominator === option}
              aria-label={formatScale(option)}
              onClick={() => {
                onScale(option);
              }}
              className={`${HEIGHT.panel} rounded-hair border px-sm font-mono text-caption transition-colors duration-quick ease-standard ${denominator === option ? PRESSED : UNPRESSED}`}
            >
              {compactScale(option)}
            </button>
          ))}
          <button
            type="button"
            onClick={onFit}
            className={`${HEIGHT.panel} rounded-hair border px-sm text-caption transition-colors duration-quick ease-standard ${UNPRESSED}`}
          >
            Fit the route
          </button>
        </Field>

        <div className="ml-auto flex items-center gap-md">
          {/*
            Disabled until the face reports idle. A sheet printed mid-fetch has grey squares
            where the ridge was, and the reader finds out at the trailhead.
          */}
          <span aria-live="polite" className="text-caption text-ink-muted">
            {ready ? '' : 'Drawing the ground…'}
          </span>
          <button
            type="button"
            disabled={!ready}
            onClick={() => {
              window.print();
            }}
            className={`${HEIGHT.touch} rounded-hair border border-ink bg-ink px-lg text-caption text-canvas transition-opacity duration-quick ease-standard disabled:opacity-40`}
          >
            Print
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-sm">
      <span className="collar">{label}</span>
      <div className="flex flex-wrap items-center gap-xs">{children}</div>
    </div>
  );
}
