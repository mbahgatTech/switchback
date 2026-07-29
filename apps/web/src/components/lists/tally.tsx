import { tallyMarks } from '@switchback/geo';

/**
 * The tally rule.
 *
 * A map's scale bar, with the divisions standing for trails instead of kilometres. Each
 * block is one hike, sized by its length, and the bar is the whole list laid end to end —
 * so six matched outings and one through-hike with five strolls attached are two different
 * pictures before either is read. Alternating fill is the scale-bar convention, and it is
 * doing real work here: it is what makes the divisions countable at a glance.
 *
 * Flex boxes rather than an SVG. `preserveAspectRatio="none"` on a rule this wide and this
 * short stretches the hairlines along with the geometry, and a scale bar whose rules are
 * thicker at one end than the other is the one thing a scale bar must not be. Flex growth
 * is exact at any width, needs no viewBox arithmetic, and is the same layout primitive
 * React Native will draw this with.
 *
 * On the contour plate, because what it measures is distance.
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
    // An empty list still gets its rule, hollow and dashed — the frame of a measurement not
    // yet taken. Omitting it would make an empty card a different shape from a full one, and
    // the column would jump as lists filled up.
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
          // `flexBasis: 0` is what makes growth purely proportional — with the default
          // `auto` every division would first claim its own content width, and eleven empty
          // spans would come out eleven equal blocks regardless of what they stand for.
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
