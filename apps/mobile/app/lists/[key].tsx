import { useQuery } from '@tanstack/react-query';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ListItem, TrailSummary, UnitSystem } from '@switchback/core';
import {
  SYSTEM_LIST_EMPTY,
  formatDateLabel,
  formatDistance,
  formatDuration,
  formatElevation,
  isSystemList,
  plural,
  trailTitle,
} from '@switchback/core';
import { DIFFICULTY_PLATE, nativeTheme } from '@switchback/ui';
import { useTRPC } from '@/api/trpc';
import { useAuth } from '@/auth/context';
import { TallyRule } from '@/components/tally';

/**
 * One list.
 *
 * `sheet`, like the trail page: a list you have opened is something you are reading, and the
 * paper scheme is what reading is set in. Pushed over the tab bar rather than living inside
 * it, so the way out is the same "← Saved" the trail page uses.
 *
 * The rule at the head is the whole list drawn to scale — the same graphic the row on the
 * shelf carries, at 8pt rather than 6 because here it is the subject rather than a summary.
 * Under it the trails in the order they were added, each with its difficulty stripe, and on
 * a completed list the date it was hiked.
 *
 * Looked up by slug. `resolveList` on the server tries the viewer's own slug first and falls
 * back to an id, which is what makes a shared link work without the reader owning the list.
 */

const theme = nativeTheme('sheet');

const ROUTE_TYPE_LABEL = {
  loop: 'Loop',
  out_and_back: 'Out and back',
  point_to_point: 'Point to point',
} as const;

export default function ListScreen() {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ key: string }>();
  const key = params.key ?? '';
  const trpc = useTRPC();
  const { status } = useAuth();

  const list = useQuery({ ...trpc.lists.detail.queryOptions({ key }), enabled: key.length > 0 });
  const me = useQuery({ ...trpc.me.get.queryOptions(), enabled: status === 'signedIn' });
  const units: UnitSystem = me.data?.units ?? 'metric';

  if (list.isPending) {
    return (
      <Chrome insets={insets}>
        <ActivityIndicator color={theme.color.inkMuted} style={styles.pending} />
      </Chrome>
    );
  }

  if (!list.data) {
    return (
      <Chrome insets={insets}>
        <Text style={styles.name}>Could not open that list</Text>
        <Text style={styles.prose}>
          {list.error?.message ?? 'It may have been deleted, or it may not be public.'}
        </Text>
        <Pressable
          onPress={() => void list.refetch()}
          accessibilityRole="button"
          style={styles.action}
        >
          <Text style={styles.actionLabel}>Try again</Text>
        </Pressable>
      </Chrome>
    );
  }

  const detail = list.data;
  const owner = detail.owner.name ?? (detail.owner.username ? `@${detail.owner.username}` : null);

  return (
    <Chrome insets={insets}>
      <View style={styles.head}>
        <Text style={styles.collar}>
          {detail.trailCount} {plural(detail.trailCount, 'trail')}
          {detail.isMine || !owner ? '' : ` · ${owner}`}
        </Text>
        <Text style={styles.name}>{detail.name}</Text>
        {detail.description ? <Text style={styles.prose}>{detail.description}</Text> : null}
      </View>

      {detail.trailCount > 0 ? (
        <View style={styles.totals}>
          <TallyRule lengths={detail.lengths} scheme="sheet" height={8} />
          <Text style={styles.totalsFigures}>
            {formatDistance(detail.totalLengthM, units)}
            {'   ↑'}
            {formatElevation(detail.totalGainM, units)}
          </Text>
          {/*
           * Said once, here, rather than beside the rule every time it appears: the reader
           * needs to be told what a proportional graphic is measuring exactly once.
           */}
          <Text style={styles.legend}>Each division is one trail, drawn to its length.</Text>
        </View>
      ) : (
        <Text style={styles.prose}>
          {isSystemList(detail.kind) ? SYSTEM_LIST_EMPTY[detail.kind] : 'Nothing in it yet.'}
        </Text>
      )}

      <View style={styles.items}>
        {detail.items.map((item) => (
          <Row
            key={item.completionId ?? item.trail.id}
            item={item}
            units={units}
            showHikedOn={detail.kind === 'completed'}
          />
        ))}
      </View>
    </Chrome>
  );
}

/**
 * One trail on the list.
 *
 * The same row grammar as Explore — difficulty stripe, collar, name, figures in mono — so a
 * trail looks like a trail wherever it is met. Two things are added that only exist here: the
 * note the hiker wrote when they saved it, and, on the completed list, the date.
 */
function Row({
  item,
  units,
  showHikedOn,
}: {
  item: ListItem;
  units: UnitSystem;
  showHikedOn: boolean;
}) {
  const trail: TrailSummary = item.trail;
  const plate = theme.color[DIFFICULTY_PLATE[trail.difficulty]];
  const subtitle = [trail.regionName, ROUTE_TYPE_LABEL[trail.routeType]]
    .filter(Boolean)
    .join(' · ');
  const title = trailTitle(trail);

  return (
    <Pressable
      onPress={() => router.push({ pathname: '/trails/[slug]', params: { slug: trail.slug } })}
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${formatDistance(trail.stats.lengthM, units)}`}
      style={({ pressed }) => [styles.row, pressed ? styles.rowPressed : null]}
    >
      <View style={[styles.stripe, { backgroundColor: plate }]} />
      <View style={styles.rowBody}>
        {subtitle ? (
          <Text style={styles.rowCollar} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
        <Text style={styles.rowName} numberOfLines={2}>
          {title}
        </Text>
        <Text style={styles.rowStats} numberOfLines={1}>
          {formatDistance(trail.stats.lengthM, units)}
          {'   ↑'}
          {formatElevation(trail.stats.gainM, units)}
          {'   '}
          {formatDuration(trail.stats.estimatedTimeS)}
        </Text>
        {showHikedOn && item.completedAt ? (
          <Text style={styles.rowHiked}>Hiked {formatDateLabel(item.completedAt)}</Text>
        ) : null}
        {item.note ? <Text style={styles.rowNote}>{item.note}</Text> : null}
      </View>
    </Pressable>
  );
}

/**
 * The scroll container and the way back, shared by the three states this screen has.
 *
 * The bottom pad is the safe-area inset rather than a plain measure: this screen is pushed
 * over the tab bar, so nothing else is holding the content off the home indicator.
 */
function Chrome({
  insets,
  children,
}: {
  insets: { top: number; bottom: number };
  children: React.ReactNode;
}) {
  return (
    <>
      {/* Overrides the root's dark canvas, or the push transition flashes field over sheet. */}
      <Stack.Screen options={{ contentStyle: { backgroundColor: theme.color.canvas } }} />
      <ScrollView
        style={styles.screen}
        contentContainerStyle={[
          styles.content,
          {
            paddingTop: insets.top + theme.space.md,
            paddingBottom: insets.bottom + theme.space['4xl'],
          },
        ]}
      >
        <Pressable
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/saved'))}
          accessibilityRole="button"
          accessibilityLabel="Back to saved lists"
          hitSlop={theme.space.md}
          style={styles.back}
        >
          <Text style={styles.backLabel}>← Saved</Text>
        </Pressable>
        {children}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.color.canvas },
  content: { gap: theme.space.lg },

  back: {
    alignSelf: 'flex-start',
    paddingHorizontal: theme.space.xl,
    paddingVertical: theme.space.xs,
  },
  backLabel: { ...theme.collarLabel, color: theme.color.inkMuted },

  pending: { marginTop: theme.space['4xl'] },

  head: { paddingHorizontal: theme.space.xl, gap: theme.space.xs },
  collar: { ...theme.collarLabel, color: theme.color.inkMuted },
  name: { ...theme.text('h3', { weight: 'bold' }), color: theme.color.ink },
  prose: {
    ...theme.text('body', { family: 'text' }),
    color: theme.color.inkMuted,
    paddingHorizontal: theme.space.xl,
  },

  totals: { paddingHorizontal: theme.space.xl, gap: theme.space.sm },
  totalsFigures: { ...theme.text('body', { family: 'mono' }), color: theme.color.ink },
  legend: { ...theme.text('micro', { family: 'text' }), color: theme.color.inkMuted },

  action: {
    alignSelf: 'flex-start',
    marginHorizontal: theme.space.xl,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.ink,
    borderRadius: theme.radius.hair,
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.md,
  },
  actionLabel: { ...theme.collarLabel, color: theme.color.ink },

  items: { marginTop: theme.space.sm },
  row: { flexDirection: 'row', gap: theme.space.md, paddingRight: theme.space.xl },
  rowPressed: { backgroundColor: theme.color.surface },
  stripe: { width: 3, marginLeft: theme.space.xl },
  rowBody: {
    flex: 1,
    gap: theme.space.hair,
    paddingVertical: theme.space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.color.bezel,
  },
  rowCollar: { ...theme.collarLabel, color: theme.color.inkMuted },
  rowName: { ...theme.text('bodyLg', { weight: 'medium' }), color: theme.color.ink },
  rowStats: { ...theme.text('caption', { family: 'mono' }), color: theme.color.inkMuted },
  rowHiked: { ...theme.text('micro', { family: 'mono' }), color: theme.color.woodland },
  rowNote: {
    ...theme.text('caption', { family: 'text' }),
    color: theme.color.inkMuted,
    marginTop: theme.space.hair,
  },
});
