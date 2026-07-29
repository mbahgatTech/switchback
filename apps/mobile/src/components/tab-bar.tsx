import { forwardRef } from 'react';
import { Pressable, StyleSheet, Text, View, type View as RNView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TabList, TabTrigger, type TabTriggerSlotProps } from 'expo-router/ui';
import { CONTROL_HEIGHT, nativeTheme } from '@switchback/ui';
import { Mark, type MarkShape } from './marks';
import { useActiveHike } from '@/record/store';

/**
 * The tab bar.
 *
 * Four places, drawn rather than inherited. The platform bar is a good bar, but it is the
 * same bar in every app on the phone, and this product's whole argument is that a map tool
 * can look like a printed sheet rather than like software. So: a hairline top rule, a mark
 * and a collar label per tab, and the active one picked out by a short rule above it —
 * the tab index printed in a folio's margin, not a filled pill.
 *
 * **The active tab is marked in ink, not in a plate.** Four coloured tabs in a row would
 * spend the whole five-plate vocabulary on navigation, which is the one thing in the product
 * that carries no information about the ground. Ink is the structure plate; structure is
 * exactly what this is.
 *
 * **One exception, and it is information.** While a hike is being recorded, the Record tab
 * goes to the survey plate and its label becomes the running clock. Survey is reserved for
 * you and your safety, and a recording you have hiked away from is both — you can be three
 * tabs deep in someone else's photos and still see that the hike is running.
 */

const theme = nativeTheme('field');

/** The rule that marks the active tab. Short and centred: a tick, not a highlight. */
const MARKER_WIDTH = 26;
const MARKER_HEIGHT = 2;
const GLYPH_SIZE = 18;

interface TabDef {
  name: string;
  href: '/' | '/saved' | '/record' | '/you';
  label: string;
  shape: MarkShape;
}

const TABS: readonly TabDef[] = [
  { name: 'index', href: '/', label: 'Explore', shape: 'contours' },
  { name: 'saved', href: '/saved', label: 'Saved', shape: 'flag' },
  { name: 'record', href: '/record', label: 'Record', shape: 'record' },
  { name: 'you', href: '/you', label: 'You', shape: 'station' },
];

export function TabBar() {
  const insets = useSafeAreaInsets();
  const hike = useActiveHike();

  return (
    <TabList
      asChild
      // The bottom inset rather than a fixed pad: on a phone with a home indicator the bar
      // sits above it, and on one without it sits on the edge, which is where it belongs.
      style={[styles.bar, { paddingBottom: insets.bottom > 0 ? insets.bottom : theme.space.sm }]}
    >
      <View>
        {TABS.map((tab) => (
          <TabTrigger key={tab.name} name={tab.name} href={tab.href} asChild>
            <TabCell
              label={tab.name === 'record' && hike !== null ? hike.clock : tab.label}
              shape={tab.shape}
              live={tab.name === 'record' && hike !== null}
            />
          </TabTrigger>
        ))}
      </View>
    </TabList>
  );
}

interface TabCellProps extends TabTriggerSlotProps {
  label: string;
  shape: MarkShape;
  /** A hike is running. Only ever true for Record. */
  live: boolean;
}

/**
 * `TabTrigger asChild` hands the press handlers and `isFocused` down to whatever child it
 * finds, so the cell is a plain Pressable that reads them off its props. `forwardRef`
 * because the trigger measures the cell it is given.
 */
const TabCell = forwardRef<RNView, TabCellProps>(function TabCell(
  { label, shape, live, isFocused, ...press },
  ref,
) {
  const plate = live ? theme.color.survey : isFocused ? theme.color.ink : theme.color.inkMuted;

  return (
    <Pressable
      ref={ref}
      accessibilityRole="tab"
      accessibilityState={{ selected: isFocused === true }}
      accessibilityLabel={live ? `Recording, ${label} elapsed` : label}
      style={styles.cell}
      {...press}
    >
      <View style={[styles.marker, isFocused ? { backgroundColor: theme.color.ink } : null]} />
      <Mark shape={shape} size={GLYPH_SIZE} color={plate} />
      <Text
        style={[styles.label, { color: plate }, live ? styles.labelLive : null]}
        numberOfLines={1}
      >
        {label}
      </Text>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    backgroundColor: theme.color.canvas,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.color.bezel,
  },
  cell: {
    flex: 1,
    alignItems: 'center',
    gap: theme.space.hair,
    // 48pt of target before the safe-area pad underneath it.
    minHeight: CONTROL_HEIGHT.touch,
    paddingTop: theme.space.sm,
  },
  marker: {
    position: 'absolute',
    // Flush to the bar's own top rule, so the two read as one printed edge.
    top: 0,
    width: MARKER_WIDTH,
    height: MARKER_HEIGHT,
    backgroundColor: 'transparent',
  },
  label: { ...theme.collarLabel },
  // The clock is figures, and figures are set in mono everywhere else in the product.
  labelLive: { ...theme.text('micro', { family: 'mono', weight: 'medium' }) },
});
