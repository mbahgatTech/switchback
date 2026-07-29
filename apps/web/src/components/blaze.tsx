/**
 * The double blaze.
 *
 * A painted trail blaze is a 2:3 vertical rectangle. Two stacked with the top one offset
 * is the universal waymark for _the trail turns here_ — which is what a switchback is. The
 * product's name is already a graphic; this just draws it. No illustrated logo, no
 * mountain in a circle.
 *
 * The offset is a prop rather than a constant because the same mark does instrument duty
 * later: as the "you are here" marker it leans toward the next turn, so the logo and the
 * navigation cue are one shape doing two jobs rather than two shapes to learn.
 */
export function Blaze({
  size = 24,
  turn = 'left',
  className,
  title,
}: {
  size?: number;
  turn?: 'left' | 'right';
  className?: string;
  /** Set only when the mark stands alone; leave undefined beside a wordmark. */
  title?: string;
}) {
  const w = 10;
  const h = 15;
  const gap = 3;
  const offset = turn === 'left' ? -4 : 4;

  return (
    <svg
      viewBox={`0 0 ${w + 8} ${h * 2 + gap}`}
      width={(size * (w + 8)) / (h * 2 + gap)}
      height={size}
      className={className}
      role={title ? 'img' : 'presentation'}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <rect x={4 + offset} y="0" width={w} height={h} fill="currentColor" />
      <rect x="4" y={h + gap} width={w} height={h} fill="currentColor" />
    </svg>
  );
}
