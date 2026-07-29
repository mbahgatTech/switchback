import { useCallback, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ActivityStats, ActivitySummary, ActivityType, UnitSystem } from '@switchback/core';
import {
  ACTIVITY_TYPE_LABELS,
  COMMON_ACTIVITY_TYPES,
  formatDistance,
  formatElevation,
  formatPace,
} from '@switchback/core';
import { CONTROL_HEIGHT, nativeTheme } from '@switchback/ui';
import { askAgain } from '@/api/after-write';
import { useTRPC } from '@/api/trpc';
import { useAuth } from '@/auth/context';
import { LifelinePanel } from '@/components/lifeline-panel';
import {
  dismissAlert,
  flush,
  forget,
  formatClock,
  useRecording,
  useRecorderActions,
} from '@/record/store';

/**
 * Record.
 *
 * `field`, and the only screen in the product that is an *instrument* rather than a page: one
 * figure large enough to read at arm's length on a windy col, three supporting readings under
 * it, and controls big enough to hit with a glove on. Nothing else. Everything a recorder
 * could also show — the map, the profile, the forecast — is a tap away on another tab and is
 * not what someone squinting at a phone in the rain is asking for.
 *
 * The state machine is not here. It is `@/record/store`, at module scope, because this screen
 * unmounts every time somebody looks at another tab and a recorder that lives in a screen's
 * state would end their hike when they did. This file only draws it.
 *
 * **Expo Go records in the foreground only.** Background location needs a native task
 * registration the Expo Go client does not carry, so the screen is held awake for the duration
 * and the caveat is printed rather than hidden. A development build lifts it without changing
 * a line of the engine.
 */

const theme = nativeTheme('field');

export default function RecordScreen() {
  const insets = useSafeAreaInsets();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { status } = useAuth();
  const signedIn = status === 'signedIn';

  const recording = useRecording();
  const actions = useRecorderActions();

  const [activityType, setActivityType] = useState<ActivityType>('hiking');
  const [finished, setFinished] = useState<ActivityStats | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const me = useQuery({ ...trpc.me.get.queryOptions(), enabled: signedIn });
  const units: UnitSystem = me.data?.units ?? 'metric';

  /**
   * The hike the server thinks is still open.
   *
   * Only asked when this device has nothing of its own. A phone that crashed mid-hike restores
   * its journal and owns the recording; a phone that was reinstalled, or a second device,
   * finds the recording stranded — open in the database, invisible everywhere — and this is
   * the only thing that offers a way to close it.
   */
  const open = useQuery({
    ...trpc.activities.open.queryOptions(),
    enabled: signedIn && recording.phase === 'idle',
  });

  /**
   * The line this hike is following, when it is on a trail or on a route somebody drew.
   *
   * Resolved from the recording rather than handed in, because a recording acquires a line
   * four different ways — started from a trail page, started from a planned route, adopted
   * from the server above, restored from the journal after a crash — and only the first two
   * have the geometry already in hand. Two queries, both keyed on the recorder's own ids,
   * cover all four; the alternative is a route that works when you start a hike and quietly
   * stops working when your battery dies halfway up, which is exactly when it matters.
   *
   * Never stale: neither a trail nor a saved route changes shape during a hike, and
   * refetching one over a cellular link on a ridge is a cost with nothing on the other side
   * of it.
   */
  const followingTrail = useQuery({
    ...trpc.trails.byId.queryOptions({ id: recording.trailId ?? '' }),
    enabled: Boolean(recording.trailId),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const followingRoute = useQuery({
    ...trpc.routes.detail.queryOptions({ id: recording.routeId ?? '' }),
    enabled: Boolean(recording.routeId),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const followed = followingTrail.data ?? followingRoute.data ?? null;

  /**
   * Hand the line to the recorder — and never take it away while it is still loading.
   *
   * The clear is conditioned on the ids rather than on the absence of data, because this
   * screen unmounts whenever somebody looks at another tab. On the way back the query is warm
   * but not instant, and clearing on `undefined` would reset the off-route watchdog every time
   * — losing where along the route the hiker is, and re-arming an alert they already
   * dismissed. Only a hike with no line at all has none.
   */
  useEffect(() => {
    if (!recording.trailId && !recording.routeId) {
      actions.setFollowing(null, null);
      return;
    }
    const line = followed?.geometry.coordinates;
    if (line && line.length >= 2) actions.setFollowing(line, followed.stats.lengthM);
  }, [actions, recording.trailId, recording.routeId, followed]);

  const start = useMutation(trpc.activities.start.mutationOptions());
  const finish = useMutation(trpc.activities.finish.mutationOptions());

  const onStart = useCallback(() => {
    setSaveError(null);
    setFinished(null);
    start.mutate(
      { activityType, device: 'iPhone' },
      {
        onSuccess: (activity) => {
          actions.begin({ id: activity.id, startedAt: activity.startedAt, trailId: null });
        },
      },
    );
  }, [actions, activityType, start]);

  /**
   * Finish, in the order that loses the least if a step fails.
   *
   * Flush first, so everything recorded is on the server before the recording is closed —
   * `finish` derives its totals from the samples it can see, and closing before the last batch
   * lands is how a hike comes back a kilometre short. If the flush fails the recorder stays
   * put with its buffer intact and says so, rather than ending a hike it cannot save.
   */
  const onFinish = useCallback(() => {
    const id = recording.activityId;
    if (!id) return;
    setSaveError(null);
    actions.stop();
    void (async () => {
      try {
        await flush();
      } catch {
        setSaveError('The last few minutes have not reached the server yet. Still trying.');
        return;
      }
      try {
        const activity = await finish.mutateAsync({ id, logCompletion: true });
        setFinished({
          distanceM: activity.distanceM,
          gainM: activity.gainM,
          lossM: activity.lossM,
          minEleM: activity.minEleM,
          maxEleM: activity.maxEleM,
          movingTimeS: activity.movingTimeS,
          elapsedTimeS: activity.elapsedTimeS,
          avgSpeedMps: activity.avgSpeedMps,
          maxSpeedMps: activity.maxSpeedMps,
        });
        forget();
        // `finish` closes any Lifeline riding on this hike, server-side. Nothing on the device
        // knows that yet, and a panel still counting down to a return time on a hike that is
        // over is the one thing this feature cannot be allowed to show.
        void askAgain(queryClient, trpc.lifeline.pathFilter());
      } catch (cause) {
        setSaveError(cause instanceof Error ? cause.message : 'Could not close the recording.');
      }
    })();
  }, [actions, finish, queryClient, recording.activityId, trpc]);

  const onDiscard = useCallback(() => {
    forget();
    setSaveError(null);
    setFinished(null);
  }, []);

  if (!signedIn) {
    return (
      <Chrome insets={insets}>
        <Text style={styles.title}>Record</Text>
        <Text style={styles.prose}>
          Sign in and every hike is kept — the track, the climbing, and the time it actually took,
          on your record and nobody else's unless you say so.
        </Text>
        <Pressable
          onPress={() => router.push('/signin')}
          accessibilityRole="button"
          style={styles.ghost}
        >
          <Text style={styles.ghostLabel}>Sign in</Text>
        </Pressable>
      </Chrome>
    );
  }

  const running =
    recording.phase === 'locating' ||
    recording.phase === 'recording' ||
    recording.phase === 'paused';

  return (
    <Chrome insets={insets}>
      {recording.alert ? (
        <Pressable
          onPress={dismissAlert}
          accessibilityRole="button"
          accessibilityLabel="Dismiss the route alert"
          style={[
            styles.alert,
            { borderColor: recording.alert === 'left' ? theme.color.survey : theme.color.woodland },
          ]}
        >
          <Text
            style={[
              styles.alertLabel,
              { color: recording.alert === 'left' ? theme.color.survey : theme.color.woodland },
            ]}
          >
            {recording.alert === 'left' ? 'Off the route' : 'Back on the route'}
          </Text>
          <Text style={styles.alertBody}>
            {recording.alert === 'left'
              ? recording.offRouteDistanceM == null
                ? 'You have left the line you were following.'
                : `${formatDistance(recording.offRouteDistanceM, units)} from the line you were following.`
              : 'Carry on.'}
          </Text>
        </Pressable>
      ) : null}

      {/*
       * Which trail, when there is one. Woodland — the trail's own plate — and a link, because
       * the one thing somebody wants from this line mid-hike is the rest of what we hold about
       * the ground they are standing on.
       */}
      {followed ? (
        <Pressable
          onPress={() =>
            router.push({ pathname: '/trails/[slug]', params: { slug: followed.slug } })
          }
          accessibilityRole="link"
          accessibilityLabel={`Open ${followed.name}`}
          style={styles.following}
        >
          <Text style={styles.followingLabel}>Following</Text>
          <Text style={styles.followingName} numberOfLines={1}>
            {followed.name}
          </Text>
        </Pressable>
      ) : null}

      {/*
       * The clock, at 60pt in mono. It is the one figure somebody checks without stopping, and
       * everything else on this screen is sized against it rather than the other way round.
       */}
      <View style={styles.clockBlock}>
        <Text style={styles.clock} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>
          {formatClock(running || recording.phase === 'saving' ? recording.elapsedS : 0)}
        </Text>
        <Text style={styles.clockLabel}>{phaseLabel(recording.phase, finished !== null)}</Text>
      </View>

      <View style={styles.readings}>
        <Reading
          label="Distance"
          value={formatDistance(displayed(recording.stats, finished).distanceM, units)}
        />
        <Reading
          label="Ascent"
          value={`↑${formatElevation(displayed(recording.stats, finished).gainM, units)}`}
        />
        <Reading
          label="Pace"
          value={pace(displayed(recording.stats, finished), units)}
          note={`moving ${formatClock(displayed(recording.stats, finished).movingTimeS)}`}
        />
        <Reading
          label={recording.remainingM == null ? 'Descent' : 'To finish'}
          value={
            recording.remainingM == null
              ? `↓${formatElevation(displayed(recording.stats, finished).lossM, units)}`
              : formatDistance(recording.remainingM, units)
          }
        />
      </View>

      {/* One line, always in the same place, saying whether the instrument is working. */}
      <Text style={styles.signal}>{signalLine(recording, units)}</Text>

      {recording.geoError ? <Text style={styles.problem}>{recording.geoError}</Text> : null}
      {recording.syncError ? <Text style={styles.problem}>{recording.syncError}</Text> : null}
      {saveError ? <Text style={styles.problem}>{saveError}</Text> : null}
      {start.isError ? <Text style={styles.problem}>{start.error.message}</Text> : null}

      {recording.phase === 'idle' && !finished ? (
        <>
          <View style={styles.types}>
            {COMMON_ACTIVITY_TYPES.map((type) => {
              const chosen = type === activityType;
              return (
                <Pressable
                  key={type}
                  onPress={() => setActivityType(type)}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: chosen }}
                  style={({ pressed }) => [
                    styles.type,
                    chosen ? styles.typeChosen : null,
                    pressed && !chosen ? styles.typePressed : null,
                  ]}
                >
                  <Text style={[styles.typeLabel, chosen ? styles.typeLabelChosen : null]}>
                    {ACTIVITY_TYPE_LABELS[type]}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <Primary
            label={start.isPending ? 'Starting…' : 'Start'}
            onPress={onStart}
            disabled={start.isPending}
          />

          {open.data ? (
            <CarryOn
              activity={open.data}
              onPress={(id, at, trailId) => actions.begin({ id, startedAt: at, trailId })}
            />
          ) : null}

          <Text style={styles.caveat}>
            Recording runs while Switchback is open, and the screen is held awake for it. Lock the
            phone and the track stops until you come back — everything recorded up to that point is
            already saved.
          </Text>
        </>
      ) : null}

      {recording.phase === 'locating' || recording.phase === 'recording' ? (
        <>
          <Primary label="Pause" onPress={actions.pause} />
          <Pressable onPress={onFinish} accessibilityRole="button" style={styles.ghost}>
            <Text style={styles.ghostLabel}>Finish</Text>
          </Pressable>
        </>
      ) : null}

      {recording.phase === 'paused' ? (
        <>
          <Primary label="Resume" onPress={actions.resume} />
          <Pressable onPress={onFinish} accessibilityRole="button" style={styles.ghost}>
            <Text style={styles.ghostLabel}>Finish</Text>
          </Pressable>
          {/*
           * Survey, and only here. The plate is reserved product-wide for the things that
           * destroy data, and this is the one control on the screen that throws a hike away.
           */}
          <Pressable onPress={onDiscard} accessibilityRole="button" style={styles.destructive}>
            <Text style={styles.destructiveLabel}>Discard this hike</Text>
          </Pressable>
        </>
      ) : null}

      {/*
       * Leaving word, under the controls in every state a hike can be in — including before one
       * starts, because a Lifeline is not part of recording and plenty of people want their
       * partner to see a dot without wanting a track on their record.
       *
       * Hidden only while a hike is closing. `activities.finish` ends the Lifeline server-side,
       * so drawing the panel here would flash "Tell somebody" at the one moment nobody is
       * setting off.
       */}
      {recording.phase !== 'saving' && !finished ? (
        <LifelinePanel
          activityId={recording.activityId}
          trailId={recording.trailId}
          trailName={followed?.name ?? null}
        />
      ) : null}

      {recording.phase === 'saving' ? (
        <View style={styles.saving}>
          <ActivityIndicator color={theme.color.inkMuted} />
          <Text style={styles.prose}>Saving the last of it…</Text>
        </View>
      ) : null}

      {finished ? (
        <>
          <Text style={styles.prose}>
            On your record. It is on the You tab with everything else, and if it matched a trail we
            hold, that trail is ticked off.
          </Text>
          <Primary label="Done" onPress={() => setFinished(null)} />
        </>
      ) : null}
    </Chrome>
  );
}

/** The totals to show: the live buffer while hiking, the server's word once it has spoken. */
function displayed(live: ActivityStats, saved: ActivityStats | null): ActivityStats {
  return saved ?? live;
}

/**
 * The offer to adopt a hike this device did not start.
 *
 * A component rather than an inline `Pressable` so the activity is a narrowed parameter. The
 * recording it adopts keeps its server-side samples — `begin` starts a fresh local buffer and
 * `t` counts from the original `startedAt`, so the two halves meet without a gap.
 */
function CarryOn({
  activity,
  onPress,
}: {
  activity: ActivitySummary;
  onPress: (id: string, startedAt: Date, trailId: string | null) => void;
}) {
  return (
    <Pressable
      onPress={() => onPress(activity.id, activity.startedAt, activity.trail?.id ?? null)}
      accessibilityRole="button"
      style={styles.ghost}
    >
      <Text style={styles.ghostLabel}>Carry on {activity.name ?? 'the hike still open'}</Text>
    </Pressable>
  );
}

function phaseLabel(phase: string, done: boolean): string {
  if (done) return 'Finished';
  switch (phase) {
    case 'locating':
      return 'Finding you';
    case 'recording':
      return 'Recording';
    case 'paused':
      return 'Paused';
    case 'saving':
      return 'Saving';
    default:
      return 'Ready';
  }
}

/**
 * Pace, or an honest dash.
 *
 * Derived from moving time rather than elapsed, because a pace that counts the twenty minutes
 * spent eating lunch on a summit describes nobody's hiking.
 */
function pace(stats: ActivityStats, units: UnitSystem): string {
  if (stats.distanceM < 50 || stats.movingTimeS <= 0) return '—';
  const perUnit = units === 'metric' ? 1000 : 1609.344;
  return formatPace((stats.movingTimeS / stats.distanceM) * perUnit, units);
}

function signalLine(
  recording: {
    phase: string;
    accuracyM: number | null;
    weakSignal: boolean;
    pending: number;
    syncing: boolean;
    lastSyncAt: Date | null;
  },
  units: UnitSystem,
): string {
  if (recording.phase === 'idle') return 'Nothing recording.';
  const parts: string[] = [];
  if (recording.accuracyM == null) parts.push('no fix yet');
  else parts.push(`±${formatDistance(recording.accuracyM, units)}`);
  if (recording.weakSignal) parts.push('weak signal');
  if (recording.syncing) parts.push('saving…');
  else if (recording.pending > 0) parts.push(`${recording.pending} not yet saved`);
  else if (recording.lastSyncAt) parts.push('saved');
  return parts.join(' · ');
}

function Reading({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <View style={styles.reading}>
      <Text
        style={styles.readingValue}
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.7}
      >
        {value}
      </Text>
      <Text style={styles.readingLabel}>{label}</Text>
      {note ? <Text style={styles.readingNote}>{note}</Text> : null}
    </View>
  );
}

/**
 * The one control that matters in whatever state the screen is in.
 *
 * Filled ink on canvas type, full width, 56pt tall — a target you can hit without looking,
 * which is the actual requirement for a button pressed at the start and end of a hike.
 */
function Primary({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled ?? false }}
      style={({ pressed }) => [
        styles.primary,
        pressed ? styles.primaryPressed : null,
        disabled ? styles.primaryDisabled : null,
      ]}
    >
      <Text style={styles.primaryLabel}>{label}</Text>
    </Pressable>
  );
}

function Chrome({
  insets,
  children,
}: {
  insets: { top: number; bottom: number };
  children: React.ReactNode;
}) {
  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + theme.space.lg }]}
    >
      {children}
    </ScrollView>
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

  // Woodland is the trail's plate everywhere in the product, and a rule down the side rather
  // than a box: this names what is being hiked, it does not compete with the clock under it.
  following: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: theme.space.md,
    borderLeftWidth: 2,
    borderLeftColor: theme.color.woodland,
    paddingLeft: theme.space.md,
  },
  followingLabel: { ...theme.collarLabel, color: theme.color.woodland },
  followingName: { ...theme.text('caption'), color: theme.color.ink, flexShrink: 1 },

  clockBlock: { alignItems: 'center', gap: theme.space.xs, paddingTop: theme.space.xl },
  clock: { ...theme.text('h1', { family: 'mono' }), color: theme.color.ink },
  clockLabel: { ...theme.collarLabel, color: theme.color.inkMuted },

  readings: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    rowGap: theme.space.lg,
    columnGap: theme.space.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.color.bezel,
    paddingTop: theme.space.lg,
  },
  reading: { flexBasis: '44%', flexGrow: 1, gap: theme.space.hair },
  readingValue: { ...theme.text('h4', { family: 'mono' }), color: theme.color.ink },
  readingLabel: { ...theme.collarLabel, color: theme.color.inkMuted },
  readingNote: { ...theme.text('micro', { family: 'mono' }), color: theme.color.inkMuted },

  signal: { ...theme.text('micro', { family: 'mono' }), color: theme.color.inkMuted },
  problem: { ...theme.text('caption', { family: 'text' }), color: theme.color.survey },

  types: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.sm },
  type: {
    minHeight: CONTROL_HEIGHT.touch,
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.bezel,
    borderRadius: theme.radius.hair,
    paddingHorizontal: theme.space.md,
    paddingVertical: theme.space.sm,
  },
  typeChosen: { borderColor: theme.color.ink, backgroundColor: theme.color.ink },
  typePressed: { borderColor: theme.color.inkMuted },
  typeLabel: { ...theme.text('caption'), color: theme.color.inkMuted },
  typeLabelChosen: { color: theme.color.canvas },

  primary: {
    height: CONTROL_HEIGHT.field,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.color.ink,
    borderRadius: theme.radius.hair,
  },
  primaryPressed: { backgroundColor: theme.color.inkMuted },
  primaryDisabled: { backgroundColor: theme.color.bezel },
  primaryLabel: { ...theme.collarLabel, color: theme.color.canvas },

  ghost: {
    height: CONTROL_HEIGHT.field,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.ink,
    borderRadius: theme.radius.hair,
  },
  ghostLabel: { ...theme.collarLabel, color: theme.color.ink },

  destructive: {
    height: CONTROL_HEIGHT.field,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.survey,
    borderRadius: theme.radius.hair,
  },
  destructiveLabel: { ...theme.collarLabel, color: theme.color.survey },

  alert: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: theme.radius.hair,
    padding: theme.space.md,
    gap: theme.space.hair,
  },
  alertLabel: { ...theme.collarLabel },
  alertBody: { ...theme.text('caption', { family: 'text' }), color: theme.color.ink },

  saving: { flexDirection: 'row', alignItems: 'center', gap: theme.space.md },

  caveat: { ...theme.text('micro', { family: 'text' }), color: theme.color.inkMuted },
});
