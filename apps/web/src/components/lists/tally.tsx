import { tallyMarks } from '@switchback/geo';

/**
 * The tally rule: a map's scale bar with the divisions standing for trails instead of
 * kilometres, each block one hike sized by its length. Alternating fill is what makes the
 * divisions countable at a glance.
 *
 * Flex boxes rather than an SVG — `preserveAspectRatio="none"` on a rule this wide stretches
 * the hairlines with the geometry, and a scale bar whose rules are thicker at one end is the
 * one thing a scale bar must not be. On the contour plate, because it measures distance.
 */

export interface TallyProps {
  /** Each trail's length, in the order the list shows them. */
  lengths: readonly number[];
  /** Read out in place of the graphic. The card prints the same facts in type beside it. */
  label: string;
  className?: string;
}

export function Tally({ lengths, label, className }: TallyProps) {
  const marks = tallyMarks(lengths);

  if (marks.length === 0) {
    // An empty list still gets its rule, hollow and dashed, so the column does not jump as
    // lists fill up.
    return (
      <div
        aria-hidden
        className={`h-[9px] rounded-hair border border-dashed border-contour/40 ${className ?? ''}`}
      />
    );
  }

  return (
    <div
      role="img"
      aria-label={label}
      className={`flex h-[9px] overflow-hidden rounded-hair border border-contour ${className ?? ''}`}
    >
      {marks.map((mark, index) => (
        <span
          key={index}
          // `flexBasis: 0` is what makes growth purely proportional — with the default `auto`
          // every division first claims its own content width.
          style={{ flexGrow: mark.end - mark.start, flexBasis: 0 }}
          className={[
            index > 0 ? 'border-l border-contour' : '',
            index % 2 === 0 ? 'bg-contour' : '',
          ].join(' ')}
        />
      ))}
    </div>
  );
}
