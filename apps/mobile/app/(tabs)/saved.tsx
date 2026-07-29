import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ListSummary, UnitSystem } from '@switchback/core';
import {
  SYSTEM_LIST_EMPTY,
  formatDistance,
  formatElevation,
  isSystemList,
  plural,
} from '@switchback/core';
import { nativeTheme } from '@switchback/ui';
import { useTRPC } from '@/api/trpc';
import { useAuth } from '@/auth/context';
import { Mark, type MarkShape } from '@/components/marks';
import { TallyRule } from '@/components/tally';

/**
 * Saved.
 *
 * The shelf: the three lists every account is given, then whatever the hiker made. Each row
 * carries its mark, its two totals, and the tally rule — the total distance drawn as one line
 * divided at each trail's length, because "6 trails" describes both six evening strolls and
 * six mountain days and the rule does not.
 *
 * `field`, like Explore. The two are the same act — looking for somewhere to hike — and the
 * only difference is whether the candidates come from the map or from your own shelf. Sheet
 * starts when you open one and begin reading.
 *
 * System lists are shown even when empty, with the line that says what each is for. A shelf
 * with nothing on it is where a product has to explain itself, and hiding the empty ones would
 * remove the only place that explanation fits.
 */

const theme = nativeTheme('field');

/** The mark each system list is saved with. Custom lists have no gesture, so no mark. */
const KIND_MARK: Readonly<Record<string, MarkShape>> = {
  favorites: 'ring',
  want_to_do: 'flag',
  completed: 'tick',
};

export default function SavedScreen() {
  const insets = useSafeAreaInsets();
  const trpc = useTRPC();
  const { status } = useAuth();

  const signedIn = status === 'signedIn';
  const lists = useQuery({ ...trpc.lists.mine.queryOptions(), enabled: signedIn });
  const me = useQuery({ ...trpc.me.get.queryOptions(), enabled: signedIn });
  const units: UnitSystem = me.data?.units ?? 'metric';

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + theme.space.lg }]}
      refreshControl={
        signedIn ? (
          <RefreshControl
            refreshing={lists.isRefetching}
            onRefresh={() => void lists.refetch()}
            tintColor={theme.color.inkMuted}
          />
        ) : undefined
      }
    >
      <Text style={styles.title}>Saved</Text>

      {status === 'loading' ? (
        <ActivityIndicator color={theme.color.inkMuted} style={styles.pending} />
      ) : null}

      {status === 'signedOut' ? (
        <>
          <Text style={styles.prose}>
            Ring the trails worth going back to, flag the ones still ahead, tick the ones you have
            hiked. Sign in and the three lists are kept for you.
          </Text>
          <Pressable
            onPress={() => router.push('/signin')}
            accessibilityRole="button"
            style={styles.action}
          >
            <Text style={styles.actionLabel}>Sign in</Text>
          </Pressable>
        </>
      ) : null}

      {signedIn && lists.isPending ? (
        <ActivityIndicator color={theme.color.inkMuted} style={styles.pending} />
      ) : null}

      {signedIn && lists.isError ? (
        <>
          <Text style={styles.prose}>{lists.error.message}</Text>
          <Pressable
            onPress={() => void lists.refetch()}
            accessibilityRole="button"
            style={styles.action}
          >
            <Text style={styles.actionLabel}>Try again</Text>
          </Pressable>
        </>
      ) : null}

      {signedIn && lists.data
        ? lists.data.map((list) => <ListCard key={list.id} list={list} units={units} />)
        : null}

      {signedIn && lists.data && lists.data.every((list) => isSystemList(list.kind)) ? (
        <Text style={styles.footnote}>
          Lists beyond these three are made on the website, and appear here as soon as they exist.
        </Text>
      ) : null}
    </ScrollView>
  );
}

/**
 * One list.
 *
 * The mark leads, at the same size and in the same ink as the row's own type, so the shelf
 * reads as a legend for the gestures rather than as decoration beside a name. Figures in mono,
 * name in the display face — the row grammar the rest of the app uses.
 */
function ListCard({ list, units }: { list: ListSummary; units: UnitSystem }) {
  const mark = KIND_MARK[list.kind];
  const empty = list.trailCount === 0;

  return (
    <Pressable
      onPress={() => router.push({ pathname: '/lists/[key]', params: { key: list.slug } })}
      accessibilityRole="button"
      accessibilityLabel={`${list.name}, ${list.trailCount} ${plural(list.trailCount, 'trail')}`}
      style={({ pressed }) => [styles.card, pressed ? styles.cardPressed : null]}
    >
      <View style={styles.cardHead}>
        {mark ? <Mark shape={mark} size={14} color={theme.color.inkMuted} /> : null}
        <Text style={styles.cardName} numberOfLines={1}>
          {list.name}
        </Text>
        <Text style={styles.cardCount}>{list.trailCount}</Text>
      </View>

      {empty ? (
        <Text style={styles.cardEmpty}>
          {isSystemList(list.kind) ? SYSTEM_LIST_EMPTY[list.kind] : 'Nothing in it yet.'}
        </Text>
      ) : (
        <>
          <TallyRule lengths={list.lengths} />
          <Text style={styles.cardFigures}>
            {formatDistance(list.totalLengthM, units)}
            {'   ↑'}
            {formatElevation(list.totalGainM, units)}
          </Text>
        </>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.color.canvas },
  content: {
    paddingHorizontal: theme.space.xl,
    paddingBottom: theme.space['3xl'],
    gap: theme.space.lg,
  },

  title: { ...theme.text('h4', { weight: 'semibold' }), color: theme.color.ink },
  prose: { ...theme.text('body', { family: 'text' }), color: theme.color.inkMuted },
  pending: { marginTop: theme.space['3xl'] },
  action: {
    alignSelf: 'flex-start',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.ink,
    borderRadius: theme.radius.hair,
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.md,
  },
  actionLabel: { ...theme.collarLabel, color: theme.color.ink },

  card: {
    gap: theme.space.sm,
    paddingVertical: theme.space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.color.bezel,
  },
  cardPressed: { backgroundColor: theme.color.surface },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: theme.space.sm },
  cardName: { ...theme.text('bodyLg', { weight: 'medium' }), color: theme.color.ink, flex: 1 },
  cardCount: { ...theme.text('body', { family: 'mono' }), color: theme.color.inkMuted },
  cardFigures: { ...theme.text('caption', { family: 'mono' }), color: theme.color.inkMuted },
  cardEmpty: { ...theme.text('caption', { family: 'text' }), color: theme.color.inkMuted },

  footnote: {
    ...theme.text('micro', { family: 'text' }),
    color: theme.color.inkMuted,
    marginTop: theme.space.md,
  },
});
