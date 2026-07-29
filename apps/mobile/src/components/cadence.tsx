import { StyleSheet, Text, View } from 'react-native';
import type { UnitSystem, HikeMonth } from '@switchback/core';
import { formatDistance, monthLabel } from '@switchback/core';
import { nativeTheme } from '@switchback/ui';

/**
 * Thirteen months of hiking, as an almanac column diagram.
 *
 * The native cut of `apps/web/src/components/profile/cadence.tsx`, and deliberately the same
 * drawing rather than a phone-shaped reinterpretation of it: bare columns rising from a
 * hairline baseline, one per month, contour plate, a mono axis under them. Somebody who reads
 * their year on the website and then on their phone should be looking at one graphic.
 *
 * The reasoning behind each choice lives in the web file's header — thirteen columns rather
 * than twelve, distance rather than hike count setting the height, a tick rather than nothing
 * for an empty month. Two things differ here and only because the medium does:
 *
 * - **No hover.** A column cannot carry a `title`, so the per-month figures that the website
 *   reveals on hover are folded into the accessibility label instead. Nothing is lost that a
 *   reader could otherwise have got at; a phone has no pointer to reveal it with.
 * - **A wider empty tick.** One CSS pixel is two device pixels on the retina screens this runs
 *   on; `hairlineWidth` here would draw a third of that and read as a rendering artefact.
 */

const theme = nativeTheme('sheet');

/** How tall the tallest column stands. Everything else is a fraction of it. */
const PLOT_PT = 88;

/** A month with no hiking still gets a mark, so the gap is visible as a gap. */
const EMPTY_PT = 1;

export function Cadence({ months, units }: { months: readonly HikeMonth[]; units: UnitSystem }) {
  const peak = Math.max(...months.map((month) => month.lengthM), 0);
  const hiked = months.reduce((sum, month) => sum + month.hikes, 0);

  if (peak === 0) {
    return <Text style={styles.none}>No hikes recorded in the last year.</Text>;
  }

  return (
    <View>
      <View
        accessibilityRole="image"
        accessibilityLabel={`Distance hiked each month over the last ${months.length} months: ${months
          .map((month) => `${month.month}, ${formatDistance(month.lengthM, units)}`)
          .join('; ')}.`}
        style={styles.plot}
      >
        {months.map((month) => (
          <View key={month.month} style={styles.slot}>
            <View
              style={[
                styles.column,
                month.lengthM > 0
                  ? {
                      backgroundColor: theme.color.contour,
                      // Floored at 2%, so a month with one short evening hike in it is still a
                      // column and not a smudge on the baseline.
                      height: `${Math.max((month.lengthM / peak) * 100, 2)}%`,
                    }
                  : { backgroundColor: theme.color.bezel, height: EMPTY_PT },
              ]}
            />
          </View>
        ))}
      </View>

      {/*
       * The baseline belongs to the plot rather than to the axis, so it is drawn as the plot's
       * own rule with the labels sitting clear beneath it.
       */}
      <View style={styles.baseline} />

      <View style={styles.axis}>
        {months.map((month, index) => (
          <Text key={month.month} numberOfLines={1} style={styles.tick}>
            {monthLabel(month.month, months[index - 1]?.month)}
          </Text>
        ))}
      </View>

      <View style={styles.caption}>
        <Text style={styles.captionLabel}>
          Peak month <Text style={styles.captionFigure}>{formatDistance(peak, units)}</Text>
        </Text>
        <Text style={styles.captionLabel}>
          {hiked} out in {months.length} months
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  none: { ...theme.text('body', { family: 'text' }), color: theme.color.inkMuted },

  plot: { flexDirection: 'row', alignItems: 'flex-end', gap: 3, height: PLOT_PT },
  slot: { flex: 1, height: '100%', justifyContent: 'flex-end' },
  column: { width: '100%' },

  baseline: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.color.ink },

  axis: { flexDirection: 'row', gap: 3, marginTop: theme.space.xs },
  // 9pt, below the `micro` step: thirteen labels have to fit across a phone, and the axis is
  // meant to be scanned for shape rather than read month by month.
  tick: {
    ...theme.text('micro', { family: 'mono' }),
    fontSize: 9,
    lineHeight: 12,
    flex: 1,
    textAlign: 'center',
    color: theme.color.inkMuted,
  },

  caption: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.space.md,
    marginTop: theme.space.sm,
  },
  captionLabel: { ...theme.collarLabel, color: theme.color.inkMuted },
  captionFigure: { ...theme.text('micro', { family: 'mono' }), color: theme.color.ink },
});
