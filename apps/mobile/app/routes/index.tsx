import { useQuery } from '@tanstack/react-query';
import { Stack, router } from 'expo-router';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { PlannedRouteSummary, UnitSystem } from '@switchback/core';
import {
  ACTIVITY_TYPE_LABELS,
  formatDistance,
  formatElevation,
  formatTimeOnFoot,
  plural,
} from '@switchback/core';
import { nativeTheme } from '@switchback/ui';
import { useTRPC } from '@/api/trpc';
import { useAuth } from '@/auth/context';

/**
 * Routes you drew.
 *
 * The third kind of line in the product, and the only one that has never been hiked. A
 * trail is a line other people hiked and the catalogue holds; a hike is a line you hiked
 * and the phone recorded; a route is an intention. They are read at different moments and
 * for different reasons, which is why this is its own screen rather than a filter on one of
 * the others.
 *
 * **Flat, newest-touched first — no grouping.** The hikes list earns its month headings
 * because a log of hikes is read by season and only a subtotal answers "how was June". A set
 * of plans has no seasons: a route drawn in March and a route drawn last night are both
 * simply things you might do on Saturday, and heading them by month would invent a
 * hierarchy the data does not have and the reader would have to scroll past.
 *
 * **Drawing happens at a desk.** Placing sixty anchors on a map is a mouse job, and the
 * phone is where the result gets carried up a hill — so this screen reads and exports, and
 * says plainly where the drawing is done rather than offering a cramped version of it.
 */

const theme = nativeTheme('sheet');

export default function RoutesScreen() {
  const insets = useSafeAreaInsets();
  const trpc = useTRPC();
  const { status } = useAuth();
  const signedIn = status === 'signedIn';

  const me = useQuery({ ...trpc.me.get.queryOptions(), enabled: signedIn });
  const units: UnitSystem = me.data?.units ?? 'metric';

  const list = useQuery({ ...trpc.routes.mine.queryOptions(), enabled: signedIn });
  const items = list.data ?? [];

  if (!signedIn) {
    return (
      <Chrome insets={insets}>
        <Text style={styles.title}>Routes</Text>
        <Text style={styles.prose}>
          Sign in and the routes you plan at a desk are on your phone at the car park — with the
          line, the climbing, and a file for your watch.
        </Text>
        <Pressable
          onPress={() => router.push('/signin')}
          accessibilityRole="button"
          style={({ pressed }) => [styles.action, pressed ? styles.actionDim : null]}
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
        <Text style={styles.title}>Could not load your routes</Text>
        <Text style={styles.prose}>{list.error.message}</Text>
        <Pressable
          onPress={() => void list.refetch()}
          accessibilityRole="button"
          style={({ pressed }) => [styles.action, pressed ? styles.actionDim : null]}
        >
          <Text style={styles.actionLabel}>Try again</Text>
        </Pressable>
      </Chrome>
    );
  }

  if (items.length === 0) {
    return (
      <Chrome insets={insets}>
        <Text style={styles.title}>Routes</Text>
        <Text style={styles.prose}>
          Nothing planned yet. A route is a line you draw yourself — between two paths the catalogue
          holds separately, or up a hill nobody has named — and it comes back with its own distance,
          ascent and time on foot.
        </Text>
        <Text style={styles.prose}>
          Draw one on the website, at Plan. Every route you save there is here the next time you
          open this screen.
        </Text>
      </Chrome>
    );
  }

  return (
    <Chrome insets={insets}>
      <View style={styles.head}>
        <Text style={styles.collar}>
          {items.length} {plural(items.length, 'route')}
        </Text>
        <Text style={styles.title}>Routes</Text>
      </View>

      <View>
        {items.map((route) => (
          <Row key={route.id} route={route} units={units} />
        ))}
      </View>

      <Text style={styles.end}>Drawn on the website, at Plan. Read and carried here.</Text>
    </Chrome>
  );
}

/**
 * One route.
 *
 * The row grammar the whole app uses — collar, name, figures in mono — with the name given
 * the weight, because a route is the one line in the product that somebody chose the name
 * of. A trail row leads with a name it inherited from OSM and a hike row leads with a date;
 * this one leads with a decision.
 *
 * **Visibility is printed only when it is not private.** The inverse of the hikes list, and
 * for the same reason: state whatever would surprise. A hike defaults to public, so the
 * restriction is the news; a route defaults to private, so the exposure is. A route is
 * where somebody intends to *be*, at a time they have not decided yet, and finding out from
 * silence that strangers can read it would be the wrong way round.
 */
function Row({ route, units }: { route: PlannedRouteSummary; units: UnitSystem }) {
  const collar = `${ACTIVITY_TYPE_LABELS[route.activityType]} · ${route.anchorCount} ${plural(route.anchorCount, 'point')}`;

  return (
    <Pressable
      onPress={() => router.push({ pathname: '/routes/[id]', params: { id: route.id } })}
      accessibilityRole="button"
      accessibilityLabel={`${route.name}, ${formatDistance(route.stats.lengthM, units)}`}
      style={({ pressed }) => [styles.row, pressed ? styles.rowPressed : null]}
    >
      <View style={styles.rowBody}>
        <Text style={styles.rowCollar} numberOfLines={1}>
          {collar}
        </Text>
        <Text style={styles.rowName} numberOfLines={2}>
          {route.name}
        </Text>
        <Text style={styles.rowStats} numberOfLines={1}>
          {formatDistance(route.stats.lengthM, units)}
          {'   ↑'}
          {formatElevation(route.stats.gainM, units)}
          {'   '}
          {formatTimeOnFoot(route.stats.estimatedTimeS)}
        </Text>
        <Text style={styles.rowMeta} numberOfLines={1}>
          {route.visibility === 'private' ? '' : `${exposure(route.visibility)} · `}
          Edited {shortDate(route.updatedAt)}
        </Text>
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

/**
 * Who can read this route, said from the reader's side.
 *
 * Not `VISIBILITY_LABELS`, which is worded for the picker on a settings screen — "Anyone"
 * answers a question that was on the screen a moment ago and answers nothing on a row in a
 * list. Here the words have to carry their own subject.
 */
function exposure(visibility: PlannedRouteSummary['visibility']): string {
  return visibility === 'public' ? 'Anyone can see it' : 'Your followers can see it';
}

/** `24 Jul` this year, `24 Jul 2025` before it. The year is only news when it is not now. */
function shortDate(iso: string): string {
  const at = new Date(iso);
  const sameYear = at.getFullYear() === new Date().getFullYear();
  return at.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
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

  // No horizontal padding of its own: `title` carries its own, because it is also used on
  // the signed-out, error and empty states where there is no head around it. Padding both
  // would set the name one gutter to the right of the count above it.
  head: { gap: theme.space.xs },
  collar: {
    ...theme.collarLabel,
    color: theme.color.inkMuted,
    paddingHorizontal: theme.space.xl,
  },
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
  // An outline button cannot fill on press: `Pressable`'s style function styles only the
  // Pressable, and a fill would not reach the label's colour. So it dims instead.
  actionDim: { opacity: 0.55 },
  actionLabel: { ...theme.collarLabel, color: theme.color.ink },

  end: {
    ...theme.text('micro', { family: 'text' }),
    color: theme.color.inkMuted,
    paddingHorizontal: theme.space.xl,
  },

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
  rowMeta: {
    ...theme.text('micro', { family: 'text' }),
    color: theme.color.inkMuted,
    marginTop: theme.space.hair,
  },
});
