'use client';

import { useEffect, useId, useMemo, useRef } from 'react';
import maplibregl, { type Map as MapLibreMap } from 'maplibre-gl';
import type { LngLat, Waypoint, WaypointKind } from '@switchback/core';
import { type SheetFrame, sheetGraticule, sheetPointMm, sheetZoom } from '@switchback/geo';
import { SCHEMES } from '@switchback/ui';
import { registerRTLText } from '../map/rtl';
import { useUnitsRef } from '../units';
import { printSheetStyle } from './sheet-style';
import 'maplibre-gl/dist/maplibre-gl.css';

/**
 * The mapped area, plus the collar around it. Two drawing systems stacked: the map canvas draws
 * ground, and everything the reader is here for — route, waypoints, neatline, graticule — is
 * SVG on top, so it reaches the printer as geometry rather than as pixels. A neatline at 0.2 mm
 * either is a hairline or is a grey smudge, and which depends on exactly that.
 *
 * The SVG projects through `sheetPointMm`, the same function the neatline, ticks and graticule
 * labels use, so the route and the marginalia cannot disagree about where a coordinate is.
 */

export interface SheetFaceProps {
  /** Centre, ratio and face size. Every mark on the sheet is projected through this. */
  frame: SheetFrame;
  /** The margin the neatline sits in, carrying ticks and graticule figures. */
  collarMm: number;
  route: readonly LngLat[];
  waypoints: readonly Waypoint[];
  /** Called when the reader drags the map. Latitude changes the zoom the ratio needs. */
  onCentreChange: (centre: LngLat) => void;
  /** False while tiles are in flight — the print button waits on this. */
  onReadyChange: (ready: boolean) => void;
}

/**
 * Which plate each waypoint prints in, mirroring the screen map exactly: `survey` is the reader
 * and their safety and nothing else, `water` anything wet, `contour` terrain, `woodland` the
 * trail itself, and everything built by people falls to structure black.
 */
export type WaypointPlate = 'survey' | 'water' | 'contour' | 'woodland' | 'ink';

export const WAYPOINT_INK: Record<WaypointKind, WaypointPlate> = {
  trailhead: 'woodland',
  summit: 'contour',
  viewpoint: 'contour',
  water: 'water',
  waterfall: 'water',
  lake: 'water',
  ford: 'water',
  parking: 'ink',
  toilets: 'ink',
  shelter: 'ink',
  campsite: 'ink',
  junction: 'ink',
  gate: 'ink',
  hazard: 'survey',
};

/** Labelled first when the sheet runs out of room, for the reasons a hiker would pick. */
const NAMED_KINDS: readonly WaypointKind[] = ['summit', 'trailhead', 'hazard', 'shelter'];

/** Millimetres. Closer than this and two labels are one illegible mark. */
const LABEL_CLEARANCE_MM = 8;

/** However large the sheet, past this many names it is a list rather than a map. */
const MAX_LABELS = 16;

/**
 * Shortest gap between two plotted route vertices, millimetres. A 4,000-point trail at
 * 1:250 000 puts most of its vertices inside the same tenth of a millimetre; 0.12 mm keeps
 * every bend a 300 dpi printer can render and drops only the ones it would round together.
 */
const ROUTE_MIN_STEP_MM = 0.12;

interface Placed {
  x: number;
  y: number;
  waypoint: Waypoint;
}

/** Waypoints inside the face, in the order they should be labelled if room runs out. */
function placeWaypoints(waypoints: readonly Waypoint[], frame: SheetFrame): Placed[] {
  const inside: Placed[] = [];
  for (const waypoint of waypoints) {
    const [x, y] = sheetPointMm([waypoint.lng, waypoint.lat], frame);
    if (x < 0 || y < 0 || x > frame.face.widthMm || y > frame.face.heightMm) continue;
    inside.push({ x, y, waypoint });
  }
  return inside;
}

/**
 * Greedy label selection: named kinds first, then anything with a name, each accepted only if
 * it clears every label already placed. Greedy rather than optimal on purpose — optimal packing
 * moves labels around when the reader pans, and on a sheet stability beats density.
 */
function chooseLabels(placed: Placed[]): Placed[] {
  const named = placed.filter((p) => p.waypoint.name);
  const ordered = [
    ...named.filter((p) => NAMED_KINDS.includes(p.waypoint.kind)),
    ...named.filter((p) => !NAMED_KINDS.includes(p.waypoint.kind)),
  ];

  const kept: Placed[] = [];
  for (const candidate of ordered) {
    if (kept.length >= MAX_LABELS) break;
    const clear = kept.every(
      (p) => Math.hypot(p.x - candidate.x, p.y - candidate.y) >= LABEL_CLEARANCE_MM,
    );
    if (clear) kept.push(candidate);
  }
  return kept;
}

/** The route in face millimetres, thinned to what a printer can resolve. */
function routeMm(route: readonly LngLat[], frame: SheetFrame): [number, number][] {
  const points: [number, number][] = [];
  for (const coord of route) {
    const next = sheetPointMm(coord, frame);
    const last = points[points.length - 1];
    if (last && Math.hypot(next[0] - last[0], next[1] - last[1]) < ROUTE_MIN_STEP_MM) continue;
    points.push(next);
  }
  // The last vertex is where the hike ends, so it is never the one to drop.
  const tail = route[route.length - 1];
  const last = points[points.length - 1];
  if (tail && last) {
    const end = sheetPointMm(tail, frame);
    if (end[0] !== last[0] || end[1] !== last[1]) points.push(end);
  }
  return points;
}

export function SheetFace({
  frame,
  collarMm,
  route,
  waypoints,
  onCentreChange,
  onReadyChange,
}: SheetFaceProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const uid = useId().replace(/:/gu, '');

  /*
   * Callbacks and the frame reach the map handlers through refs: an effect that subscribed to
   * `moveend` with `onCentreChange` in its deps would rebuild the listener on every drag,
   * because the drag is what changes the parent's centre.
   */
  const centreChangeRef = useRef(onCentreChange);
  const readyChangeRef = useRef(onReadyChange);
  centreChangeRef.current = onCentreChange;
  readyChangeRef.current = onReadyChange;

  /** The last centre the *map* produced, so a prop echo is not replayed as a command. */
  const selfCentreRef = useRef<LngLat>(frame.centre);
  const initialRef = useRef(frame);

  /*
   * The names this sheet draws for itself, frozen at construction. They go into the style so
   * the basemap's peak layer skips them, and the style is handed to the map once.
   */
  const namedRef = useRef(
    waypoints.map((w) => w.name).filter((name): name is string => Boolean(name)),
  );

  /*
   * Read through a ref for the same reason `namedRef` is: the map is built once in an effect
   * whose cleanup disposes it, and depending on `units` would rebuild the sheet.
   */
  const units = useUnitsRef();

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    registerRTLText();

    const start = initialRef.current;
    const map = new maplibregl.Map({
      container,
      style: printSheetStyle(namedRef.current, units.current),
      center: start.centre,
      zoom: sheetZoom(start.denominator, start.centre[1]),
      bearing: 0,
      pitch: 0,
      attributionControl: false,
      /*
       * Every gesture that could change the scale is off. The collar prints "1:25 000" and a
       * reader will hold a ruler to it; one stray wheel click makes that a lie nothing on the
       * page corrects. Panning survives — moving the sheet does not change what a millimetre
       * means.
       */
      scrollZoom: false,
      boxZoom: false,
      doubleClickZoom: false,
      touchZoomRotate: false,
      touchPitch: false,
      dragRotate: false,
      pitchWithRotate: false,
      keyboard: false,
      dragPan: true,
      /*
       * `preserveDrawingBuffer` belongs here, not at the top level — MapLibre folds the WebGL
       * context attributes into their own object. Without it the printed page gets a blank
       * rectangle where the ground should be.
       */
      canvasContextAttributes: { preserveDrawingBuffer: true },
      /*
       * Render the ground at print density rather than screen density: at ratio 1 every
       * hillshade pixel prints six 600 dpi dots wide, and the relief comes out visibly blocky
       * next to a vector route that did not.
       */
      pixelRatio: Math.min(3, Math.max(2, window.devicePixelRatio || 1)),
      // Nothing here fades in. The sheet is either ready to print or it is not.
      fadeDuration: 0,
    });
    mapRef.current = map;

    const settle = () => {
      readyChangeRef.current(true);
    };
    const unsettle = () => {
      readyChangeRef.current(false);
    };
    const report = () => {
      const centre = map.getCenter();
      const previous = selfCentreRef.current;
      // `setZoom` fires `moveend` with the centre untouched. Reporting it would push a
      // state update that re-derives the zoom that fired it.
      if (Math.abs(centre.lng - previous[0]) < 1e-9 && Math.abs(centre.lat - previous[1]) < 1e-9) {
        return;
      }
      const next: LngLat = [centre.lng, centre.lat];
      selfCentreRef.current = next;
      centreChangeRef.current(next);
    };

    map.on('idle', settle);
    map.on('dataloading', unsettle);
    map.on('movestart', unsettle);
    map.on('moveend', report);

    return () => {
      map.remove();
      mapRef.current = null;
    };
    // Once, and the empty array is the point: this cleanup disposes the map. `units` is read
    // through a ref precisely so that changing it cannot land here and tear down the sheet a
    // reader is in the middle of laying out.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* A new centre from the parent — "fit the route", or a paper change that recentres. */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const previous = selfCentreRef.current;
    if (
      Math.abs(frame.centre[0] - previous[0]) < 1e-9 &&
      Math.abs(frame.centre[1] - previous[1]) < 1e-9
    ) {
      return;
    }
    selfCentreRef.current = frame.centre;
    map.setCenter(frame.centre);
  }, [frame.centre]);

  /*
   * The ratio, re-derived whenever it or the latitude moves. Mercator's scale factor is
   * `1/cos(lat)`, so panning north with a fixed zoom would quietly falsify the collar. The
   * loop this could close is broken at `report` above, which ignores an unmoved `moveend`.
   */
  useEffect(() => {
    mapRef.current?.setZoom(sheetZoom(frame.denominator, frame.centre[1]));
  }, [frame.denominator, frame.centre]);

  /* Paper or orientation changed under the canvas. */
  useEffect(() => {
    mapRef.current?.resize();
  }, [frame.face.widthMm, frame.face.heightMm]);

  const sheet = SCHEMES.sheet;
  const outerW = frame.face.widthMm + collarMm * 2;
  const outerH = frame.face.heightMm + collarMm * 2;

  const line = useMemo(() => routeMm(route, frame), [route, frame]);
  const marks = useMemo(() => placeWaypoints(waypoints, frame), [waypoints, frame]);
  const labels = useMemo(() => chooseLabels(marks), [marks]);
  const graticule = useMemo(() => sheetGraticule(frame), [frame]);

  const path = line.map(([x, y]) => `${x.toFixed(3)},${y.toFixed(3)}`).join(' ');
  const start = line[0];
  const finish = line[line.length - 1];
  // A loop's two ends land on the same spot; drawing both leaves a ring inside a disc.
  const closed = start && finish && Math.hypot(start[0] - finish[0], start[1] - finish[1]) < 1.5;

  const clipId = `sb-face-${uid}`;

  return (
    <div
      className="relative"
      style={{ width: `${outerW}mm`, height: `${outerH}mm` }}
      data-sheet-face
    >
      {/*
        The canvas is inset by the collar so the neatline has a margin to sit in. It must be
        sized here rather than by a class: `maplibre-gl.css` sets `.maplibregl-map` to
        `position: relative` at the same specificity Tailwind's `.absolute` uses, and which
        one wins is load order rather than intent.
      */}
      <div
        ref={containerRef}
        className="overflow-hidden"
        style={{
          position: 'absolute',
          left: `${collarMm}mm`,
          top: `${collarMm}mm`,
          width: `${frame.face.widthMm}mm`,
          height: `${frame.face.heightMm}mm`,
        }}
      />

      <svg
        viewBox={`0 0 ${outerW} ${outerH}`}
        width={`${outerW}mm`}
        height={`${outerH}mm`}
        className="pointer-events-none absolute inset-0"
        aria-hidden="true"
      >
        <defs>
          <clipPath id={clipId}>
            <rect x={0} y={0} width={frame.face.widthMm} height={frame.face.heightMm} />
          </clipPath>
        </defs>

        <g transform={`translate(${collarMm} ${collarMm})`}>
          <g clipPath={`url(#${clipId})`}>
            {/*
              The graticule, at the weight a printed sheet gives it: present when looked for,
              absent when not. It is a coordinate reference, not a design element — anything
              heavier competes with the paths, which is the one thing on the map that has to
              win.
            */}
            <g stroke={sheet.ink} strokeWidth={0.08} opacity={0.28}>
              {graticule.meridians.map((m) => (
                <line key={`m${m.deg}`} x1={m.mm} y1={0} x2={m.mm} y2={frame.face.heightMm} />
              ))}
              {graticule.parallels.map((p) => (
                <line key={`p${p.deg}`} x1={0} y1={p.mm} x2={frame.face.widthMm} y2={p.mm} />
              ))}
            </g>

            {line.length > 1 && (
              <>
                {/*
                  Casing first, in paper white. A green route over a green valley band is
                  legible on a backlit screen and marginal on paper at a third the contrast;
                  a white halo separates the line from whatever it crosses without adding a
                  colour to the sheet.
                */}
                <polyline
                  points={path}
                  fill="none"
                  stroke="#FFFFFF"
                  strokeWidth={1.5}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  opacity={0.9}
                />
                <polyline
                  points={path}
                  fill="none"
                  stroke={sheet.woodland}
                  strokeWidth={0.7}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              </>
            )}

            {start && (
              <g>
                <circle
                  cx={start[0]}
                  cy={start[1]}
                  r={1.25}
                  fill={sheet.woodland}
                  stroke="#FFFFFF"
                  strokeWidth={0.45}
                />
              </g>
            )}
            {finish && !closed && (
              <circle
                cx={finish[0]}
                cy={finish[1]}
                r={1.25}
                fill="#FFFFFF"
                stroke={sheet.woodland}
                strokeWidth={0.55}
              />
            )}

            {marks.map(({ x, y, waypoint }) => {
              const ink = sheet[WAYPOINT_INK[waypoint.kind]];
              return waypoint.kind === 'summit' ? (
                // The triangle is the one glyph on a topographic sheet nobody has to be
                // taught, so the summit gets it and every other feature stays a dot.
                <polygon
                  key={waypoint.id}
                  points={`${x},${y - 1.25} ${x + 1.15},${y + 0.9} ${x - 1.15},${y + 0.9}`}
                  fill={ink}
                  stroke="#FFFFFF"
                  strokeWidth={0.35}
                  strokeLinejoin="round"
                />
              ) : (
                <circle
                  key={waypoint.id}
                  cx={x}
                  cy={y}
                  r={0.85}
                  fill={ink}
                  stroke="#FFFFFF"
                  strokeWidth={0.35}
                />
              );
            })}

            {labels.map(({ x, y, waypoint }) => {
              // Flip the label inboard near the right neatline so a name is never cut in half
              // by the frame it is supposed to sit inside.
              const flip = x > frame.face.widthMm - 32;
              return (
                <text
                  key={`l${waypoint.id}`}
                  x={flip ? x - 1.8 : x + 1.8}
                  y={y + 0.9}
                  textAnchor={flip ? 'end' : 'start'}
                  fontSize={2.4}
                  fill={sheet.ink}
                  stroke="#FFFFFF"
                  strokeWidth={0.7}
                  paintOrder="stroke"
                  style={{ fontFamily: 'var(--font-display)' }}
                >
                  {waypoint.name}
                </text>
              );
            })}
          </g>

          {/*
            The neatline, doubled — a heavy rule with a hairline inside it. Two rules rather
            than one because the pair is what tells a reader at a glance that the edge of the
            paper is not the edge of the survey.
          */}
          <rect
            x={0}
            y={0}
            width={frame.face.widthMm}
            height={frame.face.heightMm}
            fill="none"
            stroke={sheet.ink}
            strokeWidth={0.45}
          />
          <rect
            x={0.85}
            y={0.85}
            width={frame.face.widthMm - 1.7}
            height={frame.face.heightMm - 1.7}
            fill="none"
            stroke={sheet.ink}
            strokeWidth={0.15}
          />

          {/* Ticks crossing the neatline, so a straightedge can be laid between two edges. */}
          <g stroke={sheet.ink} strokeWidth={0.3}>
            {graticule.meridians.map((m) => (
              <g key={`t${m.deg}`}>
                <line x1={m.mm} y1={-1.6} x2={m.mm} y2={1.6} />
                <line
                  x1={m.mm}
                  y1={frame.face.heightMm - 1.6}
                  x2={m.mm}
                  y2={frame.face.heightMm + 1.6}
                />
              </g>
            ))}
            {graticule.parallels.map((p) => (
              <g key={`u${p.deg}`}>
                <line x1={-1.6} y1={p.mm} x2={1.6} y2={p.mm} />
                <line
                  x1={frame.face.widthMm - 1.6}
                  y1={p.mm}
                  x2={frame.face.widthMm + 1.6}
                  y2={p.mm}
                />
              </g>
            ))}
          </g>

          {/*
            Graticule figures in the collar. Meridians read along the top; parallels are
            turned on their side, because "50°52′30″N" is fourteen millimetres of type and the
            collar is six millimetres wide.
          */}
          <g
            fill={sheet.inkMuted}
            fontSize={2.1}
            style={{ fontFamily: 'var(--font-mono)' }}
            letterSpacing="0.02"
          >
            {graticule.meridians.map((m) => (
              <text key={`ml${m.deg}`} x={m.mm} y={-2.4} textAnchor="middle">
                {m.label}
              </text>
            ))}
            {graticule.parallels.map((p) => (
              <text
                key={`pl${p.deg}`}
                x={0}
                y={0}
                textAnchor="middle"
                transform={`translate(${-2.4} ${p.mm}) rotate(-90)`}
              >
                {p.label}
              </text>
            ))}
          </g>

          {/*
            North, inside the face rather than in the collar — it belongs to the map, and a
            reader orienting a sheet against a compass wants it where their thumb already is.
            A white plate under it because it will land on relief, and an arrow that has to be
            hunted for is not doing its job.
          */}
          <g transform={`translate(${frame.face.widthMm - 8.5} 4.5)`}>
            <rect
              x={-3.6}
              y={-1.4}
              width={7.2}
              height={12.4}
              fill="#FFFFFF"
              opacity={0.86}
              rx={0.6}
            />
            <polygon points="0,0 2,7 0,5.6 -2,7" fill={sheet.ink} />
            <text
              x={0}
              y={10.2}
              textAnchor="middle"
              fontSize={2.6}
              fill={sheet.ink}
              style={{ fontFamily: 'var(--font-display)' }}
            >
              N
            </text>
          </g>
        </g>
      </svg>
    </div>
  );
}
