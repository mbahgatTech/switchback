/**
 * The three marks.
 *
 * What a hiker does to a paper guide: rings the ones worth returning to, plants a flag on
 * the ones still ahead, ticks off the ones done. Three gestures from one world, drawn at one
 * weight, so the row reads as a set rather than as three icons that happened to be adjacent.
 *
 * Deliberately not a heart. A heart says "like"; a ring says "this one" — and this product
 * is a map, where circling a place is already what the reader means.
 *
 * `currentColor` throughout: the button carries the state, and the mark inherits it. A
 * separate filled variant of each shape would be a second place for the state to be wrong.
 */

export type MarkShape = 'ring' | 'flag' | 'tick';

export function Mark({ shape, size = 14 }: { shape: MarkShape; size?: number }) {
  return (
    <svg
      viewBox="0 0 14 14"
      width={size}
      height={size}
      aria-hidden
      className="shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {shape === 'ring' ? <circle cx="7" cy="7" r="4.6" /> : null}
      {shape === 'flag' ? (
        <>
          <path d="M3.6 1.6 V12.4" />
          <path d="M4.4 2.6 L11 5 L4.4 7.4 Z" fill="currentColor" />
        </>
      ) : null}
      {shape === 'tick' ? <path d="M2.2 7.4 L5.6 10.8 L11.8 3.2" strokeWidth="1.9" /> : null}
    </svg>
  );
}
