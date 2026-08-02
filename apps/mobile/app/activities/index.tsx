import { useMemo } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Stack, router } from 'expo-router';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ActivitySummary, UnitSystem } from '@switchback/core';
import {
  ACTIVITY_TYPE_LABELS,
  VISIBILITY_LABELS,
  defaultActivityName,
  formatClock,
  formatDistance,
  formatElevation,
  plural,
} from '@switchback/core';
import { nativeTheme } from '@switchback/ui';
import { trailTitle } from '@/api/trail-title';
import { useTRPC } from '@/api/trpc';
import { useAuth } from '@/auth/context';

/**
 * Every hike you have recorded.
 *
 * The phone could record a hike before it could read one back, which made the recorder a
 * write-only instrument — this screen and the one it pushes to are the other half of it.
 *
 * **Grouped by month, with the month's own figures beside the heading.** A log of hikes is
 * read two ways: for one specific afternoon, and for how a season went. Rows answer the
 * first, and only a subtotal answers the second — the alternative is a reader adding four
 * distances in their head to find out whether June was a good month. The heading is the
 * only structure on the page, and it earns its place by carrying that arithmetic.
 *
 * Distinct from Saved → Completed, which is trails ticked off. This is the recordings: a
 * hike down a lane matching no trail we hold belongs here and nowhere else, and two visits
 * to the same summit are two rows rather than one.
 */

const theme = nativeTheme('sheet');

/** Rows per fetch. Twenty is about three screens, which is one press ahead of the reader. */
const PAGE = 20;

export default function ActivitiesScreen() {
  const insets = useSafeAreaInsets();
  const trpc = useTRPC();
  const { status } = useAuth();
  const signedIn = status === 'signedIn';

  const me = useQuery({ ...trpc.me.get.queryOptions(), enabled: signedIn });
  const units: UnitSystem = me.data?.units ?? 'metric';

  const list = useInfiniteQuery(
    trpc.activities.mine.infiniteQueryOptions(
      { limit: PAGE },
      { getNextPageParam: (page) => page.nextCursor, enabled: signedIn },
    ),
  );

  const items = useMemo(() => list.data?.pages.flatMap((page) => page.items) ?? [], [list.data]);
  const months = useMemo(() => byMonth(items), [items]);
  const total = list.data?.pages[0]?.total ?? 0;

  if (!signedIn) {
    return (
      <Chrome insets={insets}>
        <Text style={styles.title}>Hikes</Text>
        <Text style={styles.prose}>
          Sign in and every hike is kept — the track, the climbing, and the time it actually took.
        </Text>
        <Pressable
          onPress={() => router.push('/signin')}
          accessibilityRole="button"
          style={styles.action}
        >
          <Text style={styles.actionLabel}>Sign in</Text>
        </Pressable>
      </Chrome>
    );
  }

  if (list.isPending) {
    return (
      <Chrome insets={insets}>
        <ActivityIndicator color={theme.color.inkMuted} style={styles.pending} />
      </Chrome>
    );
  }

  if (list.isError) {
    return (
      <Chrome insets={insets}>
        <Text style={styles.title}>Could not load your hikes</Text>
        <Text style={styles.prose}>{list.error.message}</Text>
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

  if (items.length === 0) {
    return (
      <Chrome insets={insets}>
        <Text style={styles.title}>Hikes</Text>
        <Text style={styles.prose}>
          Nothing recorded yet. Press record at the car park, or start one from wherever you are — a
          hike does not have to be on a trail we hold to be worth keeping.
        </Text>
        <Pressable
          onPress={() => router.navigate('/record')}
          accessibilityRole="button"
          style={styles.action}
        >
          <Text style={styles.actionLabel}>Record a hike</Text>
        </Pressable>
      </Chrome>
    );
  }

  return (
    <Chrome insets={insets}>
      <View style={styles.head}>
        <Text style={styles.collar}>
          {total} {plural(total, 'hike')}
        </Text>
        <Text style={styles.title}>Hikes</Text>
      </View>

      {months.map((month) => (
        <View key={month.key}>
          <View style={styles.monthHead}>
            <Text style={styles.monthLabel}>{month.label}</Text>
            <Text style={styles.monthFigures}>
              {formatDistance(month.distanceM, units)}
              {'  ↑'}
              {formatElevation(month.gainM, units)}
            </Text>
          </View>
          {month.items.map((activity) => (
            <Row key={activity.id} activity={activity} units={units} />
          ))}
        </View>
      ))}

      {list.hasNextPage ? (
        <Pressable
          onPress={() => void list.fetchNextPage()}
          disabled={list.isFetchingNextPage}
          accessibilityRole="button"
          accessibilityState={{ disabled: list.isFetchingNextPage }}
          style={styles.action}
        >
          <Text style={styles.actionLabel}>
            {list.isFetchingNextPage ? 'Loading…' : 'Older hikes'}
          </Text>
        </Pressable>
      ) : (
        <Text style={styles.end}>
          {items.length === total
            ? `That is all ${total} of them.`
            : `${items.length} of ${total} shown.`}
        </Text>
      )}
    </Chrome>
  );
}

/**
 * One hike.
 *
 * The same row grammar as a trail — collar, name, figures in mono — with the date where a
 * trail carries its region, because the date is what a reader is scanning for here. The
 * three figures are the three a hiker checks first and in this order: how far, how much
 * climbing, how long it took. Visibility is stated only when it is not public: silence
 * would be the wrong default for a claim about who can see where you were.
 */
function Row({ activity, units }: { activity: ActivitySummary; units: UnitSystem }) {
  const name =
    activity.name ??
    defaultActivityName(
      activity.activityType,
      activity.startedAt,
      activity.trail ? trailTitle(activity.trail) : null,
    );
  const collar = `${dayLabel(activity.startedAt)} · ${ACTIVITY_TYPE_LABELS[activity.activityType]}`;

  return (
    <Pressable
      onPress={() => router.push({ pathname: '/activities/[id]', params: { id: activity.id } })}
      accessibilityRole="button"
      accessibilityLabel={`${name}, ${formatDistance(activity.distanceM, units)}`}
      style={({ pressed }) => [styles.row, pressed ? styles.rowPressed : null]}
    >
      <View style={styles.rowBody}>
        <Text style={styles.rowCollar} numberOfLines={1}>
          {collar}
        </Text>
        <Text style={styles.rowName} numberOfLines={2}>
          {name}
        </Text>
        <Text style={styles.rowStats} numberOfLines={1}>
          {formatDistance(activity.distanceM, units)}
          {'   ↑'}
          {formatElevation(activity.gainM, units)}
          {'   '}
          {formatClock(activity.movingTimeS)}
        </Text>
        {activity.visibility === 'public' ? null : (
          <Text style={styles.rowVisibility}>
            Visible to: {VISIBILITY_LABELS[activity.visibility].toLowerCase()}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

/** The scroll container and the way back, shared by the five states this screen has. */
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
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/you'))}
          accessibilityRole="button"
          accessibilityLabel="Back to your record"
          hitSlop={theme.space.md}
          style={styles.back}
        >
          <Text style={styles.backLabel}>← Your record</Text>
        </Pressable>
        {children}
      </ScrollView>
    </>
  );
}

interface Month {
  key: string;
  label: string;
  items: ActivitySummary[];
  distanceM: number;
  gainM: number;
}

/**
 * Split a page of hikes into months, in the order they arrived.
 *
 * The server already sorts newest first, so this only has to notice where one month stops
 * and the next begins — it never sorts, and a hike cannot land in a group that has closed.
 * Subtotals are accumulated in the same pass because they are only ever read beside the
 * heading they belong to.
 */
function byMonth(items: readonly ActivitySummary[]): Month[] {
  const months: Month[] = [];
  for (const item of items) {
    const started = item.startedAt;
    const key = `${started.getFullYear()}-${started.getMonth()}`;
    let month = months[months.length - 1];
    if (!month || month.key !== key) {
      month = {
        key,
        label: started.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
        items: [],
        distanceM: 0,
        gainM: 0,
      };
      months.push(month);
    }
    month.items.push(item);
    month.distanceM += item.distanceM;
    month.gainM += item.gainM;
  }
  return months;
}

/** `Sat 27 · 07:14`. The weekday and the hour are how an afternoon is remembered. */
function dayLabel(at: Date): string {
  const day = at.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' });
  const time = at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return `${day} · ${time}`;
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
  title: {
    ...theme.text('h3', { weight: 'bold' }),
    color: theme.color.ink,
    paddingHorizontal: theme.space.xl,
  },
  prose: {
    ...theme.text('body', { family: 'text' }),
    color: theme.color.inkMuted,
    paddingHorizontal: theme.space.xl,
  },

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

  end: {
    ...theme.text('micro', { family: 'mono' }),
    color: theme.color.inkMuted,
    paddingHorizontal: theme.space.xl,
  },

  monthHead: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: theme.space.md,
    paddingHorizontal: theme.space.xl,
    paddingBottom: theme.space.xs,
    borderBottomWidth: 1,
    borderBottomColor: theme.color.ink,
  },
  monthLabel: { ...theme.collarLabel, color: theme.color.ink },
  monthFigures: { ...theme.text('micro', { family: 'mono' }), color: theme.color.inkMuted },

  row: { paddingHorizontal: theme.space.xl },
  rowPressed: { backgroundColor: theme.color.surface },
  rowBody: {
    gap: theme.space.hair,
    paddingVertical: theme.space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.color.bezel,
  },
  rowCollar: { ...theme.collarLabel, color: theme.color.inkMuted },
  rowName: { ...theme.text('bodyLg', { weight: 'medium' }), color: theme.color.ink },
  rowStats: { ...theme.text('caption', { family: 'mono' }), color: theme.color.inkMuted },
  rowVisibility: {
    ...theme.text('micro', { family: 'text' }),
    color: theme.color.inkMuted,
    marginTop: theme.space.hair,
  },
});
