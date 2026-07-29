import Svg, { Circle, Path } from 'react-native-svg';

/**
 * The marks.
 *
 * A hiker's own annotations on a printed sheet, and the same three the website draws in
 * `apps/web/src/components/lists/marks.tsx` — ring the ones worth returning to, flag the
 * ones still ahead, tick the ones done. The two clients share the coordinates, not just the
 * idea: 14×14, 1.6 stroke, `currentColor`. A ring drawn on the phone and a ring drawn in a
 * browser are the same ring.
 *
 * The three the tab bar needs are here too, because they are the same drawing language and
 * splitting them across two files would let them drift:
 *
 * - **contours** — nested closed curves. A contour is never a circle, so the outer one
 *   isn't. This is the map, and by extension the screen the map is on.
 * - **record** — a ring with its centre filled. The universal record glyph, and it reads at
 *   18pt where anything more literal does not.
 * - **station** — a triangulation station: the surveyor's mark for a position already known.
 *   Your own record is the fixed point you measure hikes against, so it is the one for you.
 *
 * Deliberately not a heart and deliberately not a person silhouette. A heart says "like"; a
 * ring says "this one". A silhouette says "account"; a station says "here is where you are".
 */

export type MarkShape =
  | 'ring'
  | 'flag'
  | 'tick'
  | 'contours'
  | 'record'
  | 'station'
  | 'crosshair'
  | 'layers'
  | 'sliders'
  | 'close';

export interface MarkProps {
  shape: MarkShape;
  /** Points. 14 matches the website's inline size; the tab bar asks for 18. */
  size?: number;
  /**
   * `currentColor` has no meaning in React Native — there is no cascade — so the colour is a
   * prop and every caller passes the plate it means.
   */
  color: string;
}

const BOX = 14;
const STROKE = 1.6;

export function Mark({ shape, size = BOX, color }: MarkProps) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox={`0 0 ${BOX} ${BOX}`}
      fill="none"
      stroke={color}
      strokeWidth={STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {shape === 'ring' ? <Circle cx={7} cy={7} r={4.6} /> : null}

      {shape === 'flag' ? (
        <>
          <Path d="M3.6 1.6 V12.4" />
          <Path d="M4.4 2.6 L11 5 L4.4 7.4 Z" fill={color} />
        </>
      ) : null}

      {shape === 'tick' ? <Path d="M2.2 7.4 L5.6 10.8 L11.8 3.2" strokeWidth={1.9} /> : null}

      {shape === 'contours' ? (
        <>
          <Path d="M7 1.4 C10.2 1.4 12.6 3.6 12.6 6.4 C12.6 9.6 10 12.6 6.6 12.6 C3.8 12.6 1.4 10.4 1.4 7.4 C1.4 4 3.8 1.4 7 1.4 Z" />
          <Path d="M7 5.1 C8.4 5.1 9.4 6 9.4 7.2 C9.4 8.5 8.3 9.5 7 9.5 C5.8 9.5 4.8 8.6 4.8 7.4 C4.8 6.1 5.8 5.1 7 5.1 Z" />
        </>
      ) : null}

      {shape === 'record' ? (
        <>
          <Circle cx={7} cy={7} r={5} />
          <Circle cx={7} cy={7} r={2.1} fill={color} stroke="none" />
        </>
      ) : null}

      {shape === 'station' ? (
        <>
          <Path d="M7 2.2 L12.2 11.4 L1.8 11.4 Z" />
          <Circle cx={7} cy={8.4} r={1.4} fill={color} stroke="none" />
        </>
      ) : null}

      {/* A surveyor's mark over a point, which is exactly what "where am I" is asking for. */}
      {shape === 'crosshair' ? (
        <>
          <Circle cx={7} cy={7} r={3.6} />
          <Path d="M7 0.9 V2.5" />
          <Path d="M7 11.5 V13.1" />
          <Path d="M0.9 7 H2.5" />
          <Path d="M11.5 7 H13.1" />
        </>
      ) : null}

      {/* Two sheets of a map, seen at an angle — the separations a plate map is printed in. */}
      {shape === 'layers' ? (
        <>
          <Path d="M7 1.9 L12.3 4.9 L7 7.9 L1.7 4.9 Z" />
          <Path d="M2.4 7.7 L7 10.3 L11.6 7.7" />
        </>
      ) : null}

      {/*
       * Three graduated rules with a bead set on each — a slide rule, not a funnel. A funnel
       * says "pour the data through"; a rule says "each of these is set to a value", which is
       * what a filter panel actually is. The beads sit at different stops so the mark reads as
       * adjusted rather than aligned.
       */}
      {shape === 'sliders' ? (
        <>
          <Path d="M1.8 3.6 H12.2" />
          <Path d="M1.8 7 H12.2" />
          <Path d="M1.8 10.4 H12.2" />
          <Circle cx={9.4} cy={3.6} r={1.5} fill={color} stroke="none" />
          <Circle cx={4.6} cy={7} r={1.5} fill={color} stroke="none" />
          <Circle cx={7.8} cy={10.4} r={1.5} fill={color} stroke="none" />
        </>
      ) : null}

      {shape === 'close' ? (
        <>
          <Path d="M3.4 3.4 L10.6 10.6" />
          <Path d="M10.6 3.4 L3.4 10.6" />
        </>
      ) : null}
    </Svg>
  );
}
