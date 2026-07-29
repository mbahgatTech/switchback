import { StyleSheet, View } from 'react-native';
import { tallyMarks } from '@switchback/geo';
import { nativeTheme, type Scheme } from '@switchback/ui';

/**
 * The tally rule.
 *
 * A set of trails plotted as one traverse — the same graphic the website draws, from the same
 * `tallyMarks` in `@switchback/geo`, so a list looks the same shape in both places. The whole
 * argument for it is in that module: "6 trails" describes both six strolls and six mountain
 * days, and the total drawn with its divisions marked does not.
 *
 * Contour, because this is distance, and distance is the contour plate everywhere else in the
 * product. The dividers are drawn in the canvas colour as an inset border rather than as a gap
 * — a gap would take real width away from the divisions and quietly stop the rule being
 * proportional, which is the only thing it is for.
 */

const THEMES = { field: nativeTheme('field'), sheet: nativeTheme('sheet') } as const;

export interface TallyRuleProps {
  /** Each trail's length in metres, in the order the list shows them. */
  lengths: readonly number[];
  scheme?: Scheme;
  /** Points. 6 in a list of lists, 8 at the head of a list's own page. */
  height?: number;
}

export function TallyRule({ lengths, scheme = 'field', height = 6 }: TallyRuleProps) {
  const theme = THEMES[scheme];
  const marks = tallyMarks(lengths);
  if (marks.length === 0) return null;

  return (
    <View
      accessibilityRole="image"
      accessibilityLabel={`${marks.length} trails, drawn to scale`}
      style={[styles.track, { height, backgroundColor: theme.color.bezel }]}
    >
      {marks.map((mark, index) => (
        <View
          key={`${index}-${mark.lengthM}`}
          style={{
            // `flexBasis: 0` with a proportional grow is exact; a percentage width would
            // round each division independently and leave a ragged right edge.
            flexBasis: 0,
            flexGrow: mark.end - mark.start,
            backgroundColor: theme.color.contour,
            borderRightWidth: index === marks.length - 1 ? 0 : StyleSheet.hairlineWidth,
            borderRightColor: theme.color.canvas,
          }}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  track: { flexDirection: 'row', overflow: 'hidden' },
});
