import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Stack, router } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { UnitSystem } from '@switchback/core';
import { formatBytes, formatDistance, formatElevation, plural } from '@switchback/core';
import { CONTROL_HEIGHT, nativeTheme } from '@switchback/ui';
import { useTRPC } from '@/api/trpc';
import { useAuth } from '@/auth/context';
import { useDownloads } from '@/offline/download';
import {
  type OfflineTrailSummary,
  availableBytes,
  forgetEverything,
  forgetTrail,
  useOfflineIndex,
} from '@/offline/store';

/**
 * What Switchback is keeping on this phone.
 *
 * Storage is the one resource this app spends on somebody's behalf without asking again
 * after the first time, so there has to be a page that says how much, on what, and gives
 * every byte a way off. Sorted newest first: the download somebody is wondering about is
 * almost always the one they made most recently, and the ones they have forgotten are the
 * ones at the bottom that they are here to clear.
 *
 * `sheet`, like the other reading screens. This is an inventory, not an instrument.
 */

const theme = nativeTheme('sheet');

export default function DownloadsScreen() {
  const insets = useSafeAreaInsets();
  const trpc = useTRPC();
  const { status } = useAuth();
  const index = useOfflineIndex();
  const downloads = useDownloads();
  const [confirming, setConfirming] = useState<string | null>(null);

  const me = useQuery({ ...trpc.me.get.queryOptions(), enabled: status === 'signedIn' });
  const units: UnitSystem = me.data?.units ?? 'metric';

  const free = availableBytes();
  const saving = downloads.running.size;

  if (index.trails.length === 0) {
    return (
      <Chrome insets={insets}>
        <View style={styles.head}>
          <Text style={styles.title}>On this phone</Text>
        </View>
        <Text style={styles.prose}>
          Nothing saved yet. Open a trail and choose “Save for offline” — its figures, its section,
          its waypoints and its reports then open without a signal.
        </Text>
        <Caveat />
        {saving > 0 ? <Text style={styles.note}>{saving} saving now.</Text> : null}
      </Chrome>
    );
  }

  return (
    <Chrome insets={insets}>
      <View style={styles.head}>
        <Text style={styles.collar}>
          {index.trails.length} {plural(index.trails.length, 'trail')} · {formatBytes(index.bytes)}
        </Text>
        <Text style={styles.title}>On this phone</Text>
        <Text style={styles.note}>
          {free === null ? 'Free space unknown.' : `${formatBytes(free)} free on the device.`}
          {saving > 0 ? ` ${saving} saving now.` : ''}
        </Text>
      </View>

      <Caveat />

      <View style={styles.list}>
        {index.trails.map((row) => (
          <Row
            key={row.trailId}
            row={row}
            units={units}
            confirming={confirming === row.trailId}
            onConfirm={() => setConfirming(row.trailId)}
            onCancel={() => setConfirming(null)}
            onRemove={() => {
              setConfirming(null);
              forgetTrail(row.trailId);
            }}
          />
        ))}
      </View>

      {/*
       * The one control on this screen that can take away more than the reader is looking
       * at, so it confirms and it names the figure. Survey, like every control in the
       * product that destroys data.
       */}
      {confirming === ALL ? (
        <View style={styles.confirm}>
          <Text style={styles.confirmProse}>
            {index.trails.length} {plural(index.trails.length, 'trail')} and{' '}
            {formatBytes(index.bytes)} come off the phone. Each one needs a signal again afterwards.
          </Text>
          <View style={styles.row}>
            <Pressable
              onPress={() => {
                setConfirming(null);
                forgetEverything();
              }}
              accessibilityRole="button"
              style={({ pressed }) => [styles.destructive, pressed ? styles.chipPressed : null]}
            >
              <Text style={styles.destructiveLabel}>Remove everything</Text>
            </Pressable>
            <Pressable
              onPress={() => setConfirming(null)}
              accessibilityRole="button"
              style={({ pressed }) => [styles.chip, pressed ? styles.chipPressed : null]}
            >
              <Text style={styles.chipLabel}>Keep them</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <Pressable
          onPress={() => setConfirming(ALL)}
          accessibilityRole="button"
          style={styles.quiet}
        >
          <Text style={styles.quietLabel}>Remove every download</Text>
        </Pressable>
      )}
    </Chrome>
  );
}

/** The sentinel the "everything" confirmation uses, kept distinct from any trail id. */
const ALL = '*';

function Row({
  row,
  units,
  confirming,
  onConfirm,
  onCancel,
  onRemove,
}: {
  row: OfflineTrailSummary;
  units: UnitSystem;
  confirming: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onRemove: () => void;
}) {
  return (
    <View style={styles.entry}>
      <Pressable
        onPress={() => router.push({ pathname: '/trails/[slug]', params: { slug: row.slug } })}
        accessibilityRole="link"
        accessibilityLabel={`Open ${row.name}`}
        style={({ pressed }) => [styles.card, pressed ? styles.cardPressed : null]}
      >
        {row.regionName ? (
          <Text style={styles.rowCollar} numberOfLines={1}>
            {row.regionName}
          </Text>
        ) : null}
        <Text style={styles.rowName} numberOfLines={2}>
          {row.name}
        </Text>
        <Text style={styles.rowFigures}>
          {formatDistance(row.lengthM, units)} ↑{formatElevation(row.gainM, units)} ·{' '}
          {formatBytes(row.bytes)} · {row.photos} {plural(row.photos, 'photo')}
        </Text>
        <Text style={styles.rowMeta}>Saved {stamp(row.savedAt)}</Text>
      </Pressable>

      {confirming ? (
        <View style={styles.confirm}>
          <Text style={styles.confirmProse}>{formatBytes(row.bytes)} comes off the phone.</Text>
          <View style={styles.row}>
            <Pressable
              onPress={onRemove}
              accessibilityRole="button"
              style={({ pressed }) => [styles.destructive, pressed ? styles.chipPressed : null]}
            >
              <Text style={styles.destructiveLabel}>Remove it</Text>
            </Pressable>
            <Pressable
              onPress={onCancel}
              accessibilityRole="button"
              style={({ pressed }) => [styles.chip, pressed ? styles.chipPressed : null]}
            >
              <Text style={styles.chipLabel}>Keep it</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <Pressable
          onPress={onConfirm}
          accessibilityRole="button"
          accessibilityLabel={`Remove ${row.name}`}
          style={({ pressed }) => [styles.chip, pressed ? styles.chipPressed : null]}
        >
          <Text style={styles.chipLabel}>Remove</Text>
        </Pressable>
      )}
    </View>
  );
}

/**
 * The exclusion, repeated here on purpose.
 *
 * Somebody reading a list of downloads before a trip is deciding whether they are ready.
 * The single most consequential thing about these files is what is missing from them, and
 * it does not become less true for having been said on the trail screen.
 */
function Caveat() {
  return (
    <Text style={styles.note}>
      A download holds the trail&apos;s data, not the map. The map is drawn by a web view that
      cannot be handed tiles from storage, so it still needs a connection.
    </Text>
  );
}

/** "24 Jul 2026". Long enough to notice a copy made two seasons ago. */
function stamp(at: number): string {
  return new Date(at).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** The scroll container and the way back, shared by both states this screen has. */
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

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.color.canvas },
  content: { gap: theme.space.lg },

  back: {
    alignSelf: 'flex-start',
    paddingHorizontal: theme.space.xl,
    paddingVertical: theme.space.xs,
  },
  backLabel: { ...theme.collarLabel, color: theme.color.inkMuted },

  head: { paddingHorizontal: theme.space.xl, gap: theme.space.xs },
  collar: { ...theme.collarLabel, color: theme.color.inkMuted },
  title: { ...theme.text('h3', { weight: 'bold' }), color: theme.color.ink },

  prose: {
    ...theme.text('body', { family: 'text' }),
    color: theme.color.ink,
    paddingHorizontal: theme.space.xl,
  },
  note: {
    ...theme.text('micro', { family: 'text' }),
    color: theme.color.inkMuted,
    paddingHorizontal: theme.space.xl,
  },

  list: { gap: theme.space.md, paddingHorizontal: theme.space.xl },

  // One download: the card that opens it, with its removal underneath rather than beside
  // it. A destructive control inside the tap target of the thing it destroys is a trap.
  entry: { gap: theme.space.sm, alignItems: 'flex-start' },
  card: {
    alignSelf: 'stretch',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.bezel,
    borderRadius: theme.radius.hair,
    padding: theme.space.lg,
    gap: theme.space.hair,
  },
  cardPressed: { backgroundColor: theme.color.surface },
  rowCollar: { ...theme.collarLabel, color: theme.color.inkMuted },
  rowName: { ...theme.text('bodyLg', { weight: 'semibold' }), color: theme.color.ink },
  rowFigures: { ...theme.text('caption', { family: 'mono' }), color: theme.color.ink },
  rowMeta: { ...theme.text('micro', { family: 'mono' }), color: theme.color.inkMuted },

  row: { flexDirection: 'row', gap: theme.space.sm },

  chip: {
    minHeight: CONTROL_HEIGHT.touch,
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.bezel,
    borderRadius: theme.radius.hair,
    paddingHorizontal: theme.space.md,
  },
  chipPressed: { backgroundColor: theme.color.surface },
  chipLabel: { ...theme.text('caption', { family: 'mono' }), color: theme.color.inkMuted },

  quiet: {
    minHeight: CONTROL_HEIGHT.touch,
    justifyContent: 'center',
    alignSelf: 'flex-start',
    paddingHorizontal: theme.space.xl,
  },
  quietLabel: { ...theme.text('caption', { family: 'text' }), color: theme.color.inkMuted },

  confirm: {
    gap: theme.space.sm,
    borderLeftWidth: 2,
    borderLeftColor: theme.color.survey,
    paddingLeft: theme.space.md,
    marginHorizontal: theme.space.xl,
  },
  confirmProse: { ...theme.text('caption', { family: 'text' }), color: theme.color.ink },
  destructive: {
    minHeight: CONTROL_HEIGHT.touch,
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.survey,
    borderRadius: theme.radius.hair,
    paddingHorizontal: theme.space.md,
  },
  destructiveLabel: { ...theme.collarLabel, color: theme.color.survey },
});
