import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { TrailCondition } from '@switchback/core';
import { TRAIL_CONDITION_LABEL } from '@switchback/core';
import { CONDITION_PLATE, CONTROL_HEIGHT, nativeTheme } from '@switchback/ui';

/**
 * A condition tag, in both of the states it exists in: reported, and being reported.
 *
 * The two live in one module because they are one object seen twice. Somebody taps *Icy* in
 * the form and then sees *Icy* in the tally an hour later; if those were built in separate
 * files the day one of them changed plate, the form would promise a colour the published
 * report does not keep. Sharing the mapping makes that drift impossible rather than unlikely.
 *
 * **The plate is the claim.** `CONDITION_PLATE` files each tag under the separation that owns
 * what it is a fact about: survey for the ones that can hurt you — closed, washed out,
 * flooded, icy, poorly marked — water for the state of the ground, woodland for the trail
 * being in good order. A tag on no plate is a hairline in muted ink, which is the honest
 * rendering of "noted, and nobody's safety".
 */

const theme = nativeTheme('sheet');

/**
 * Chip treatment per plate, written out rather than composed.
 *
 * ``theme.color[`${plate}Wash`]`` would type-check and would also be the line that survives
 * a rename of one token and silently loses its background. Three literals cost nothing.
 */
const CHIP_PLATE = {
  survey: { borderColor: theme.color.survey, backgroundColor: theme.color.surveyWash },
  water: { borderColor: theme.color.water, backgroundColor: theme.color.waterWash },
  woodland: { borderColor: theme.color.woodland, backgroundColor: theme.color.woodlandWash },
} as const;

const CHIP_INK = {
  survey: theme.color.survey,
  water: theme.color.water,
  woodland: theme.color.woodland,
} as const;

/** A tag somebody already reported, optionally with how many of them said it. */
export function ConditionChip({ condition, count }: { condition: TrailCondition; count?: number }) {
  const plate = CONDITION_PLATE[condition];
  return (
    <View style={[styles.chip, plate === null ? styles.chipPlain : CHIP_PLATE[plate]]}>
      <Text style={[styles.chipLabel, plate === null ? null : { color: CHIP_INK[plate] }]}>
        {TRAIL_CONDITION_LABEL[condition]}
      </Text>
      {count === undefined ? null : <Text style={styles.chipCount}>{count}</Text>}
    </View>
  );
}

/**
 * The same tag, with a finger on it.
 *
 * Selected takes the plate the published chip will have, so the form is a preview of the
 * report rather than a differently-coloured control that produces one. The tags with no
 * plate are the exception and fill with ink instead: hairline-and-muted is what *unselected*
 * looks like here, and a chip whose only signal of being on is that it looks exactly like
 * being off is not a control at all.
 */
export function ConditionToggle({
  condition,
  selected,
  onPress,
}: {
  condition: TrailCondition;
  selected: boolean;
  onPress: () => void;
}) {
  const plate = CONDITION_PLATE[condition];
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected }}
      // 48pt of touch from a 34pt chip: the tokens' tap target met by slop rather than by
      // padding, so a wrapped set of thirteen tags still fits on one screen.
      hitSlop={theme.space.sm}
      style={({ pressed }) => [
        styles.chip,
        styles.toggle,
        selected ? (plate === null ? styles.toggleInk : CHIP_PLATE[plate]) : styles.chipPlain,
        pressed ? styles.togglePressed : null,
      ]}
    >
      <Text
        style={[
          styles.chipLabel,
          selected && plate !== null ? { color: CHIP_INK[plate] } : null,
          selected && plate === null ? styles.toggleInkLabel : null,
        ]}
      >
        {TRAIL_CONDITION_LABEL[condition]}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.xs,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: theme.radius.hair,
    paddingHorizontal: theme.space.sm,
    paddingVertical: theme.space.xs,
  },
  chipPlain: { borderColor: theme.color.bezel },
  chipLabel: { ...theme.text('caption', { weight: 'medium' }), color: theme.color.inkMuted },
  chipCount: { ...theme.text('micro', { family: 'mono' }), color: theme.color.inkMuted },

  // Taller than the read-only chip. A tally is read; this one is aimed at.
  toggle: { minHeight: CONTROL_HEIGHT.panel, paddingHorizontal: theme.space.md },
  togglePressed: { borderColor: theme.color.ink },
  toggleInk: { borderColor: theme.color.ink, backgroundColor: theme.color.ink },
  toggleInkLabel: { color: theme.color.canvas },
});
