import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { type Scheme, nativeTheme } from '@switchback/ui';

/**
 * The one control this app plans and filters with: a labelled rail of chips.
 *
 * Every native pattern for choosing a day and an hour hides the options — a wheel picker
 * shows one value and a modal, a segmented control does not hold 24 of anything. But the
 * reason to open the planning screen is comparing Saturday against Tuesday and 07:00 against
 * 14:00, and a comparison needs both terms visible. A rail keeps every option one thumb away
 * and the current one obvious, at the cost of a horizontal scroll that phones have taught
 * everyone to expect. The same argument holds over the map, where the question is "hard ones,
 * or loops" and the answer has to be readable without opening anything.
 *
 * The selected chip is filled with ink rather than tinted with a plate. Choosing a start time
 * or a difficulty filter is not a fact about the weather or about your safety, and borrowing
 * either plate for a piece of chrome is how those colours stop meaning anything on the ridge.
 *
 * **Both schemes, built once each.** The planning screens are `sheet` and the map is `field`,
 * and a chip is a chip on either. React Native resolves colour at style-construction time
 * rather than by inheritance, so supporting two schemes means two `StyleSheet.create` calls
 * at module load — cheap, and the alternative was a second copy of this file with four hex
 * values changed, which is how two controls that should be one start to drift apart.
 */

function build(scheme: Scheme) {
  const theme = nativeTheme(scheme);
  return StyleSheet.create({
    rail: { flexDirection: 'row', alignItems: 'center', gap: theme.space.sm },
    // Fixed so the rails' chips start on the same vertical, which is what makes stacked
    // rails read as one control with several rows rather than as unrelated lists.
    railLabel: { ...theme.collarLabel, color: theme.color.inkMuted, width: 52 },
    railScroll: { gap: theme.space.xs, paddingRight: theme.space.xl },

    chip: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.color.bezel,
      borderRadius: theme.radius.hair,
      paddingHorizontal: theme.space.sm,
      paddingVertical: theme.space.xs,
      backgroundColor: theme.color.surface,
    },
    chipSelected: { backgroundColor: theme.color.ink, borderColor: theme.color.ink },
    chipPressed: { borderColor: theme.color.ink },
    chipDisabled: { opacity: 0.45 },
    chipLabel: { ...theme.text('micro', { family: 'mono' }), color: theme.color.inkMuted },
    chipLabelSelected: { color: theme.color.canvas },
  });
}

const STYLES = { sheet: build('sheet'), field: build('field') } as const;

/**
 * Slop is the same on both schemes, so it is read from either theme.
 *
 * `md` rather than `sm`, because `sm` did not actually reach the rung it claimed. The chip
 * has no fixed height — it is caption text plus `xs` padding and a hairline, which lands near
 * 30pt — so 8pt of slop a side gave 46, and the comment below it said 48. Slop is invisible,
 * so the cost of clearing the rung instead of grazing it is nothing; 12 a side puts the
 * target comfortably past `CONTROL_HEIGHT.touch` however the caption metrics round.
 */
const SLOP = nativeTheme('sheet').space.md;

export function ChipRail({
  label,
  scheme = 'sheet',
  children,
}: {
  label: string;
  scheme?: Scheme;
  children: React.ReactNode;
}) {
  const styles = STYLES[scheme];
  return (
    <View style={styles.rail}>
      <Text style={styles.railLabel}>{label}</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.railScroll}
        // The rail is wider than the screen; without this a chip at the far edge cannot be
        // reached with the thumb that is already holding the phone.
        keyboardShouldPersistTaps="handled"
      >
        {children}
      </ScrollView>
    </View>
  );
}

export function Chip({
  label,
  selected,
  disabled = false,
  scheme = 'sheet',
  onPress,
}: {
  label: string;
  selected: boolean;
  disabled?: boolean;
  scheme?: Scheme;
  onPress: () => void;
}) {
  const styles = STYLES[scheme];
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ selected, disabled }}
      // The tokens' tap target, met by slop rather than by padding, so the rail stays a rail
      // instead of a row of buttons.
      hitSlop={SLOP}
      style={({ pressed }) => [
        styles.chip,
        selected ? styles.chipSelected : null,
        disabled ? styles.chipDisabled : null,
        pressed && !disabled ? styles.chipPressed : null,
      ]}
    >
      <Text style={[styles.chipLabel, selected ? styles.chipLabelSelected : null]}>{label}</Text>
    </Pressable>
  );
}
