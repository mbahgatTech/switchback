import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import {
  ActivityIndicator,
  type LayoutChangeEvent,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { File, Paths } from 'expo-file-system';
import type { ActivityType, LngLat, MapOut, Split, UnitSystem, Visibility } from '@switchback/core';
import {
  ACTIVITY_NAME_MAX,
  ACTIVITY_NOTES_MAX,
  ACTIVITY_TYPE_LABELS,
  COMMON_ACTIVITY_TYPES,
  VISIBILITIES,
  VISIBILITY_LABELS,
  defaultActivityName,
  formatClock,
  formatDistance,
  formatElevation,
  formatPace,
  paceFromSpeed,
  plural,
} from '@switchback/core';
import {
  cumulativeDistancesM,
  elevationTicks,
  simplifyLine,
  toSectionPoints,
} from '@switchback/geo';
import type { SectionPoint, SectionStation } from '@switchback/geo';
import { nativeTheme } from '@switchback/ui';
import { askAgain } from '@/api/after-write';
import { useTRPC } from '@/api/trpc';
import { useAuth } from '@/auth/context';
import { ExploreMap, type ExploreMapHandle } from '@/components/explore-map';
import { SECTION_HEIGHT, Section, distanceAtX } from '@/components/section';

/**
 * One hike, read back.
 *
 * Parity with `apps/web/app/activities/[id]`, drawn on a phone. Same numbers, same section,
 * same map layers — the derivations are ports of the web page's local helpers rather than a
 * second opinion, so a hike cannot report 412 m of ascent on one screen and 418 m on the
 * other.
 *
 * **The inline map does not take touches.** A finished hike is framed once and will never
 * move again, so a map that panned here would only ever be a trap for a finger trying to
 * scroll past it — the reader would lose their place in the page to reach a camera position
 * they did not want. Inspection gets a full screen of its own, which is where a map should
 * be when it is actually being used.
 *
 * **What is editable is exactly what the hiker owns:** the name, the notes, who can see
 * it, and what kind of outing it was. The track, the distance and the times are what the
 * phone recorded and are not offered for adjustment — a log you can quietly improve is not
 * a log. Export hands the whole thing over in both formats a watch or another app will
 * read, so the record is never trapped here.
 */

const theme = nativeTheme('sheet');
const dark = nativeTheme('field');

/** The inline map. Tall enough for a line to have a shape, short enough to scroll past. */
const MAP_HEIGHT = 260;

/**
 * Simplification before the track goes over the bridge.
 *
 * The server already thins to 2 m, which on a long day is still several thousand points and
 * a JSON string injected into a `WebView` as a JavaScript literal. Five metres is under a
 * pixel at any zoom this map opens at, and it roughly halves the string.
 */
const BRIDGE_TOLERANCE_M = 5;

/** Only used before the track arrives, and only for one frame. */
const FALLBACK_CENTER: readonly [number, number] = [-4.05, 53.07];

export default function ActivityScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { status } = useAuth();
  const signedIn = status === 'signedIn';

  const me = useQuery({ ...trpc.me.get.queryOptions(), enabled: signedIn });
  const units: UnitSystem = me.data?.units ?? 'metric';
  /*
   * Wait for the hiker's own unit setting before asking for the hike. `activities.get`
   * computes splits in the units it is given, so fetching on the default and again on the
   * real one would recompute every split on the server and repaint the table under the
   * reader's eyes a beat after it appeared.
   */
  const unitsReady = status === 'signedOut' || (signedIn && !me.isPending);

  const activity = useQuery({
    ...trpc.activities.get.queryOptions({ id, units }),
    enabled: unitsReady && typeof id === 'string' && id.length > 0,
  });

  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);

  const detail = activity.data;

  /** The drawn line: two dimensions, thinned, and stable so the bridge effect fires once. */
  const line = useMemo<LngLat[]>(() => {
    if (!detail || detail.track.length < 2) return [];
    return simplifyLine(
      detail.track.map(([lng, lat]) => [lng, lat] as LngLat),
      BRIDGE_TOLERANCE_M,
    );
  }, [detail]);

  const center = useMemo<readonly [number, number]>(() => {
    const first = line[0];
    return first ? [first[0], first[1]] : FALLBACK_CENTER;
  }, [line]);

  const section = useMemo(() => (detail ? buildSection(detail.track) : []), [detail]);
  const stations = useMemo(
    () => (detail ? buildStations(detail.splits, detail.distanceM) : []),
    [detail],
  );
  const ticks = useMemo(
    () =>
      section.length >= 2
        ? elevationTicks(Math.max(...section.map((p) => p.elevationM)), units)
        : [],
    [section, units],
  );

  // ── The section's touch tracking ──────────────────────────────────────────────────
  const [plotWidth, setPlotWidth] = useState(0);
  const [cursorDistanceM, setCursorDistanceM] = useState<number | null>(null);
  const onFrameLayout = useCallback((event: LayoutChangeEvent) => {
    setPlotWidth(event.nativeEvent.layout.width);
  }, []);

  const totalM = detail?.distanceM ?? 0;
  const pan = useMemo(
    () =>
      PanResponder.create({
        // Never on the first touch: a tap that lands on the section is usually the start of
        // a scroll, and claiming it would make the page feel stuck.
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_event, gesture) =>
          Math.abs(gesture.dx) > Math.abs(gesture.dy) && Math.abs(gesture.dx) > SCRUB_SLOP,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: (event) => {
          setCursorDistanceM(distanceAtX(event.nativeEvent.locationX, plotWidth, totalM));
        },
        onPanResponderMove: (event) => {
          setCursorDistanceM(distanceAtX(event.nativeEvent.locationX, plotWidth, totalM));
        },
        onPanResponderRelease: () => setCursorDistanceM(null),
        onPanResponderTerminate: () => setCursorDistanceM(null),
      }),
    [plotWidth, totalM],
  );

  if (activity.isPending || !unitsReady) {
    return (
      <Chrome insets={insets}>
        <ActivityIndicator color={theme.color.inkMuted} style={styles.pending} />
      </Chrome>
    );
  }

  if (activity.isError || !detail) {
    return (
      <Chrome insets={insets}>
        <Text style={styles.title}>Hike not found</Text>
        <Text style={styles.prose}>
          {activity.error?.message ?? 'That recording is not here, or is not shared with you.'}
        </Text>
        <Pressable
          onPress={() => void activity.refetch()}
          accessibilityRole="button"
          style={styles.action}
        >
          <Text style={styles.actionLabel}>Try again</Text>
        </Pressable>
      </Chrome>
    );
  }

  const name =
    detail.name ?? defaultActivityName(detail.activityType, detail.startedAt, detail.trail?.name);

  const cells: { label: string; value: string }[] = [
    { label: 'Distance', value: formatDistance(detail.distanceM, units) },
    { label: 'Ascent', value: `↑${formatElevation(detail.gainM, units)}` },
    { label: 'Descent', value: `↓${formatElevation(detail.lossM, units)}` },
    { label: 'Moving', value: formatClock(detail.movingTimeS) },
    { label: 'Elapsed', value: formatClock(detail.elapsedTimeS) },
    { label: 'Pace', value: paceFromSpeed(detail.avgSpeedMps, units) },
  ];

  return (
    <Chrome insets={insets}>
      <View style={styles.head}>
        <Text style={styles.headCollar}>
          {ACTIVITY_TYPE_LABELS[detail.activityType]} · {longDate(detail.startedAt)}
        </Text>
        <Text style={styles.title}>{name}</Text>
        {detail.trail ? (
          <Pressable
            onPress={() =>
              router.push({ pathname: '/trails/[slug]', params: { slug: detail.trail!.slug } })
            }
            accessibilityRole="button"
            hitSlop={theme.space.sm}
          >
            <Text style={styles.trailLink}>On {detail.trail.name} →</Text>
          </Pressable>
        ) : null}
      </View>

      {line.length >= 2 ? (
        <View style={styles.mapWrap}>
          <View style={styles.mapFill} pointerEvents="none">
            <HikeMap line={line} center={center} units={units} />
          </View>
          <Pressable
            onPress={() => setExpanded(true)}
            accessibilityRole="button"
            accessibilityLabel="Open the map full screen"
            style={({ pressed }) => [styles.mapOpen, pressed ? styles.mapOpenPressed : null]}
          >
            <Text style={styles.mapOpenLabel}>Open map</Text>
          </Pressable>
        </View>
      ) : null}

      <View style={styles.grid}>
        {cells.map((cell, index) => (
          <View key={cell.label} style={[styles.cell, index % 2 === 1 ? styles.cellRight : null]}>
            <Text style={styles.cellLabel}>{cell.label}</Text>
            <Text style={styles.cellValue}>{cell.value}</Text>
          </View>
        ))}
      </View>

      {detail.maxEleM != null && detail.minEleM != null ? (
        <Text style={styles.caption}>
          High point {formatElevation(detail.maxEleM, units)} · low point{' '}
          {formatElevation(detail.minEleM, units)}
          {detail.device === null ? '' : ` · recorded on ${detail.device}`}
        </Text>
      ) : null}

      {section.length >= 2 ? (
        <Block title="Section">
          <View
            onLayout={onFrameLayout}
            pointerEvents="box-only"
            style={styles.frame}
            accessible={false}
            {...pan.panHandlers}
          >
            <Section
              points={section}
              stations={stations}
              elevationTicks={ticks}
              units={units}
              width={plotWidth}
              cursorDistanceM={cursorDistanceM}
              summary={`Elevation along ${formatDistance(detail.distanceM, units)} of hiking, from ${formatElevation(section[0]!.elevationM, units)} at the start to a high point of ${formatElevation(Math.max(...section.map((p) => p.elevationM)), units)}.`}
            />
          </View>
          <Text style={styles.caption}>
            Drag across it for the height at a distance. The times under the axis are your own, not
            an estimate.
          </Text>
        </Block>
      ) : null}

      {detail.splits.length > 0 ? <Splits splits={detail.splits} units={units} /> : null}

      {detail.notes === null || detail.notes.length === 0 ? null : (
        <Block title="Notes">
          <Text style={styles.notes}>{detail.notes}</Text>
        </Block>
      )}

      {detail.isMine ? (
        <View style={styles.owner}>
          <Pressable
            onPress={() => setEditing(true)}
            accessibilityRole="button"
            style={styles.action}
          >
            <Text style={styles.actionLabel}>Edit this hike</Text>
          </Pressable>
          <ExportRow id={detail.id} />
        </View>
      ) : detail.owner ? (
        <Text style={styles.recordedBy}>
          Recorded by {detail.owner.name ?? `@${detail.owner.username ?? 'a hiker'}`}
        </Text>
      ) : null}

      {expanded && line.length >= 2 ? (
        <Modal
          visible
          animationType="fade"
          onRequestClose={() => setExpanded(false)}
          supportedOrientations={['portrait', 'landscape']}
          statusBarTranslucent
        >
          <View style={styles.full}>
            <HikeMap line={line} center={center} units={units} />
            <View style={[styles.fullBar, { paddingTop: insets.top + dark.space.sm }]}>
              <Pressable
                onPress={() => setExpanded(false)}
                accessibilityRole="button"
                accessibilityLabel="Close the map"
                hitSlop={dark.space.md}
                style={styles.fullClose}
              >
                <Text style={styles.fullCloseLabel}>← Back to the hike</Text>
              </Pressable>
            </View>
          </View>
        </Modal>
      ) : null}

      {editing ? (
        <Editor
          activity={{
            id: detail.id,
            name: detail.name,
            notes: detail.notes,
            visibility: detail.visibility,
            activityType: detail.activityType,
          }}
          insets={insets}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            void askAgain(queryClient, trpc.activities.pathFilter());
          }}
          onDeleted={() => {
            setEditing(false);
            void askAgain(queryClient, trpc.activities.pathFilter());
            if (router.canGoBack()) router.back();
            else router.replace('/activities');
          }}
        />
      ) : null}
    </Chrome>
  );
}

/** How far a finger must travel sideways before the section takes the gesture. */
const SCRUB_SLOP = 4;

// ---------------------------------------------------------------------------
// The map

/**
 * The track, on a map.
 *
 * `browse={false}`, so the page inside runs no viewport search — the only thing on this
 * canvas is the line handed over the bridge. `ExploreMap` queues messages until the page
 * reports `ready`, so the send below is safe on the frame it mounts.
 */
function HikeMap({
  line,
  center,
  units,
}: {
  line: LngLat[];
  center: readonly [number, number];
  units: UnitSystem;
}) {
  const map = useRef<ExploreMapHandle | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    map.current?.send({ type: 'track', line, fit: true });
  }, [line]);

  const onMessage = useCallback((message: MapOut) => {
    if (message.type === 'error') setFailed(message.message);
    else if (message.type === 'ready') setFailed(null);
  }, []);

  return (
    <>
      <ExploreMap
        ref={map}
        initialCenter={center}
        // Overridden by the fit as soon as the line lands; this is only what the first tile
        // request asks for, and a hike is never far from this scale.
        initialZoom={13}
        units={units}
        browse={false}
        onMessage={onMessage}
      />
      {failed === null ? null : (
        <View style={styles.mapVeil} pointerEvents="none">
          <Text style={styles.mapVeilText}>The map could not load.</Text>
        </View>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Splits

/**
 * The splits.
 *
 * The one statistic a total cannot say: an even hike and a hike that fell apart on the last
 * climb have the same average and look nothing alike here. The bar is drawn from the
 * *slowest* split rather than from zero, because every hiking pace is a long way from zero
 * and a bar scaled from there is six near-identical bars. Ascent sits in the same row as
 * pace because it is usually the explanation for it.
 */
function Splits({ splits, units }: { splits: readonly Split[]; units: UnitSystem }) {
  const unitLabel = units === 'imperial' ? 'mi' : 'km';
  const paces = splits.filter((s) => s.paceSPerUnit > 0).map((s) => s.paceSPerUnit);
  const slowest = paces.length > 0 ? Math.max(...paces) : 0;
  const fastest = paces.length > 0 ? Math.min(...paces) : 0;
  const span = slowest - fastest;
  // A single bar drawn at full width is not a comparison — it is the table claiming this was
  // the fastest kilometre of a set of one. The column goes rather than standing empty.
  const comparable = span > 0;

  return (
    <Block title={`Splits · per ${unitLabel} · ${splits.length} ${plural(splits.length, 'row')}`}>
      <View style={styles.splits}>
        {splits.map((split) => {
          // Full width is the fastest split; the slowest is a stub. Reversed because the bar
          // is read as effort, and faster is more of it.
          const share = split.paceSPerUnit > 0 ? 1 - (split.paceSPerUnit - fastest) / span : 1;
          return (
            <View key={split.index} style={styles.splitRow}>
              <Text style={styles.splitIndex}>
                {split.index}
                {split.complete ? '' : '*'}
              </Text>
              <Text style={styles.splitPace}>{formatPace(split.paceSPerUnit, units)}</Text>
              {comparable ? (
                <View style={styles.splitTrack}>
                  <View
                    style={[styles.splitBar, { width: `${Math.max(4, Math.round(share * 100))}%` }]}
                  />
                </View>
              ) : (
                <View style={styles.splitTrack} />
              )}
              <Text style={styles.splitGain}>↑{formatElevation(split.gainM, units)}</Text>
            </View>
          );
        })}
      </View>
      {splits.some((split) => !split.complete) ? (
        <Text style={styles.caption}>* a part {unitLabel}, timed at the pace it was hiked.</Text>
      ) : null}
    </Block>
  );
}

// ---------------------------------------------------------------------------
// Export

/** GPX for anything, FIT for a watch. Written to the cache, then handed to the share sheet. */
function ExportRow({ id }: { id: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<'gpx' | 'fit' | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const send = useCallback(
    (format: 'gpx' | 'fit'): void => {
      setBusy(format);
      setFailed(null);
      void (async () => {
        try {
          const file =
            format === 'gpx'
              ? await (async () => {
                  const doc = await queryClient.fetchQuery(
                    trpc.activities.gpx.queryOptions({ id }),
                  );
                  return write(doc.filename, doc.xml, false);
                })()
              : await (async () => {
                  const doc = await queryClient.fetchQuery(
                    trpc.activities.fit.queryOptions({ id }),
                  );
                  return write(doc.filename, doc.base64, true);
                })();
          await Share.share({ url: file.uri, title: file.name });
        } catch (error) {
          setFailed(error instanceof Error ? error.message : 'That file did not build.');
        } finally {
          setBusy(null);
        }
      })();
    },
    [id, queryClient, trpc],
  );

  return (
    <>
      <View style={styles.exportRow}>
        <Pressable
          onPress={() => send('gpx')}
          disabled={busy !== null}
          accessibilityRole="button"
          accessibilityState={{ disabled: busy !== null }}
          style={[styles.action, styles.actionInline, busy === null ? null : styles.actionOff]}
        >
          <Text style={styles.actionLabel}>{busy === 'gpx' ? 'Building…' : 'Share GPX'}</Text>
        </Pressable>
        <Pressable
          onPress={() => send('fit')}
          disabled={busy !== null}
          accessibilityRole="button"
          accessibilityState={{ disabled: busy !== null }}
          style={[styles.action, styles.actionInline, busy === null ? null : styles.actionOff]}
        >
          <Text style={styles.actionLabel}>{busy === 'fit' ? 'Building…' : 'Share FIT'}</Text>
        </Pressable>
      </View>
      <Text style={failed === null ? styles.caption : styles.warning}>
        {failed ?? 'GPX opens anywhere. FIT is what a Garmin wants.'}
      </Text>
    </>
  );
}

/**
 * The document, as a file the share sheet can carry.
 *
 * The cache directory rather than documents: this is a copy made to be handed to another
 * app, and iOS is free to reclaim it the moment it is no longer needed. `overwrite` because
 * sharing the same hike twice must not fail on the second press.
 */
function write(filename: string, data: string, base64: boolean): File {
  const file = new File(Paths.cache, filename);
  file.create({ overwrite: true });
  if (base64) file.write(data, { encoding: 'base64' });
  else file.write(data);
  return file;
}

// ---------------------------------------------------------------------------
// Owner controls

interface Editable {
  id: string;
  name: string | null;
  notes: string | null;
  visibility: Visibility;
  activityType: ActivityType;
}

/**
 * Rename, re-describe, re-scope, or throw away.
 *
 * One sheet rather than four inline controls, because every field on it is a considered
 * change to a record — nothing here should be one stray thumb away from happening while
 * the page is being scrolled. Delete lives at the bottom behind a confirmation and is the
 * only thing in the app's phone UI drawn in survey red, which is reserved for controls that
 * destroy data.
 */
function Editor({
  activity,
  insets,
  onClose,
  onSaved,
  onDeleted,
}: {
  activity: Editable;
  insets: { top: number; bottom: number };
  onClose: () => void;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const trpc = useTRPC();
  const [name, setName] = useState(activity.name ?? '');
  const [notes, setNotes] = useState(activity.notes ?? '');
  const [visibility, setVisibility] = useState<Visibility>(activity.visibility);
  const [activityType, setActivityType] = useState<ActivityType>(activity.activityType);
  const [confirming, setConfirming] = useState(false);

  const save = useMutation(trpc.activities.update.mutationOptions({ onSuccess: onSaved }));
  const remove = useMutation(trpc.activities.remove.mutationOptions({ onSuccess: onDeleted }));

  const busy = save.isPending || remove.isPending;
  const error = save.error?.message ?? remove.error?.message ?? null;

  return (
    <Modal
      visible
      animationType="slide"
      onRequestClose={onClose}
      supportedOrientations={['portrait', 'landscape']}
      statusBarTranslucent
    >
      <ScrollView
        style={styles.screen}
        contentContainerStyle={[
          styles.editor,
          {
            paddingTop: insets.top + theme.space.lg,
            paddingBottom: insets.bottom + theme.space['3xl'],
          },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.collar}>Edit</Text>

        <View style={styles.field}>
          <Text style={styles.fieldLabel}>Name</Text>
          <TextInput
            value={name}
            onChangeText={setName}
            maxLength={ACTIVITY_NAME_MAX}
            placeholder={defaultActivityName(activityType, new Date())}
            placeholderTextColor={theme.color.inkMuted}
            selectionColor={theme.color.inkMuted}
            accessibilityLabel="Name of this hike"
            style={styles.input}
          />
        </View>

        <View style={styles.field}>
          <Text style={styles.fieldLabel}>Notes</Text>
          <TextInput
            value={notes}
            onChangeText={setNotes}
            maxLength={ACTIVITY_NOTES_MAX}
            placeholder="The gate that was locked, the ford that was up, who came."
            placeholderTextColor={theme.color.inkMuted}
            selectionColor={theme.color.inkMuted}
            accessibilityLabel="Notes about this hike"
            style={[styles.input, styles.inputTall]}
            multiline
          />
        </View>

        <View style={styles.field}>
          <Text style={styles.fieldLabel}>Who can see it</Text>
          <View style={styles.chips}>
            {VISIBILITIES.map((option) => (
              <Chip
                key={option}
                label={VISIBILITY_LABELS[option]}
                on={visibility === option}
                onPress={() => setVisibility(option)}
              />
            ))}
          </View>
        </View>

        <View style={styles.field}>
          <Text style={styles.fieldLabel}>Kind of outing</Text>
          <View style={styles.chips}>
            {COMMON_ACTIVITY_TYPES.map((option) => (
              <Chip
                key={option}
                label={ACTIVITY_TYPE_LABELS[option]}
                on={activityType === option}
                onPress={() => setActivityType(option)}
              />
            ))}
          </View>
        </View>

        {error === null ? null : <Text style={styles.warning}>{error}</Text>}

        <View style={styles.editorActions}>
          <Pressable
            onPress={() =>
              save.mutate({
                id: activity.id,
                ...(name.trim() ? { name: name.trim() } : {}),
                notes: notes.trim() || null,
                visibility,
                activityType,
              })
            }
            disabled={busy}
            accessibilityRole="button"
            accessibilityState={{ disabled: busy }}
            style={[styles.action, styles.actionInline, busy ? styles.actionOff : null]}
          >
            <Text style={styles.actionLabel}>{save.isPending ? 'Saving…' : 'Save'}</Text>
          </Pressable>
          <Pressable
            onPress={onClose}
            disabled={busy}
            accessibilityRole="button"
            accessibilityState={{ disabled: busy }}
            style={styles.ghost}
          >
            <Text style={styles.ghostLabel}>Cancel</Text>
          </Pressable>
        </View>

        <View style={styles.danger}>
          {confirming ? (
            <>
              <Text style={styles.dangerProse}>
                Delete this hike and its track? It cannot be recovered.
              </Text>
              <View style={styles.editorActions}>
                <Pressable
                  onPress={() => remove.mutate({ id: activity.id })}
                  disabled={busy}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: busy }}
                  style={[styles.destroy, busy ? styles.actionOff : null]}
                >
                  <Text style={styles.destroyLabel}>
                    {remove.isPending ? 'Deleting…' : 'Delete it'}
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => setConfirming(false)}
                  disabled={busy}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: busy }}
                  style={styles.ghost}
                >
                  <Text style={styles.ghostLabel}>Keep it</Text>
                </Pressable>
              </View>
            </>
          ) : (
            <Pressable
              onPress={() => setConfirming(true)}
              accessibilityRole="button"
              style={styles.ghost}
            >
              <Text style={styles.destroyGhostLabel}>Delete this hike</Text>
            </Pressable>
          )}
        </View>
      </ScrollView>
    </Modal>
  );
}

function Chip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected: on }}
      style={[styles.chip, on ? styles.chipOn : null]}
    >
      <Text style={[styles.chipLabel, on ? styles.chipLabelOn : null]}>{label}</Text>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// Chrome

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.block}>
      <Text style={styles.collar}>{title}</Text>
      {children}
    </View>
  );
}

/** The scroll container and the way back, shared by every state this screen has. */
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
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/activities'))}
          accessibilityRole="button"
          accessibilityLabel="Back to your hikes"
          hitSlop={theme.space.md}
          style={styles.back}
        >
          <Text style={styles.backLabel}>← Hikes</Text>
        </Pressable>
        {children}
      </ScrollView>
    </>
  );
}

// ---------------------------------------------------------------------------
// Deriving the section from a track
//
// Ports of the helpers in `apps/web/app/activities/[id]/page.tsx`. Kept in step by hand
// rather than lifted into `@switchback/geo`, because both are presentation decisions about
// how many marks fit on one screen — and the two screens are different sizes.

/**
 * The recorded track as a section.
 *
 * Fixes with no elevation are dropped rather than interpolated: a phone that lost its
 * altitude for a stretch did not record a flat stretch, and drawing one would be an
 * invention. If more than two thirds of the hike came back without height there is no
 * honest curve to draw and the section is left off the page entirely.
 */
function buildSection(
  track: ReadonlyArray<readonly [number, number, number | null]>,
): SectionPoint[] {
  if (track.length < 2) return [];
  const distances = cumulativeDistancesM(track.map(([lng, lat]) => [lng, lat] as [number, number]));
  const points: { lng: number; lat: number; distM: number; eleM: number }[] = [];
  for (let i = 0; i < track.length; i += 1) {
    const fix = track[i]!;
    const ele = fix[2];
    if (ele == null || !Number.isFinite(ele)) continue;
    points.push({ lng: fix[0], lat: fix[1], distM: distances[i] ?? 0, eleM: ele });
  }
  if (points.length < 2 || points.length * 3 < track.length) return [];
  return toSectionPoints(points);
}

/** The elapsed marks under the distance axis, thinned to about six. */
function buildStations(splits: readonly Split[], totalM: number): SectionStation[] {
  if (splits.length === 0) return [{ distanceM: 0, time: '0' }];
  const stride = Math.ceil(splits.length / 6);
  const stations: SectionStation[] = [{ distanceM: 0, time: '0' }];
  let distance = 0;
  let elapsed = 0;
  for (let i = 0; i < splits.length; i += 1) {
    distance += splits[i]!.distanceM;
    elapsed += splits[i]!.elapsedS;
    const last = i === splits.length - 1;
    if (last || (i + 1) % stride === 0) {
      stations.push({ distanceM: last ? totalM : distance, time: shortClock(elapsed) });
    }
  }
  return stations;
}

/** `1:25` or `25` — the axis form, matching the trail section. */
function shortClock(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${String(h)}:${String(m).padStart(2, '0')}` : String(m);
}

/** `Saturday 27 July 2026, 07:14`. The weekday is how a hike is remembered. */
function longDate(at: Date): string {
  return at.toLocaleString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Every edge pinned.
 *
 * Spelled out rather than `StyleSheet.absoluteFillObject`, which React Native 0.86 removed —
 * `absoluteFill` survives but is a registered style id, so it cannot be spread.
 */
const fill = { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 } as const;

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
  // the not-found state where there is no head around it. Padding both would set the name
  // one gutter to the right of the collar above it.
  head: { gap: theme.space.xs },
  collar: { ...theme.collarLabel, color: theme.color.inkMuted },
  headCollar: {
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
  trailLink: {
    ...theme.text('caption', { weight: 'medium' }),
    color: theme.color.woodland,
    paddingHorizontal: theme.space.xl,
  },

  // ── Map ──
  mapWrap: { height: MAP_HEIGHT, backgroundColor: dark.color.canvas },
  mapFill: { ...fill },
  mapVeil: {
    ...fill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: dark.color.canvas,
  },
  mapVeilText: { ...dark.text('caption', { family: 'text' }), color: dark.color.inkMuted },
  mapOpen: {
    position: 'absolute',
    right: theme.space.md,
    bottom: theme.space.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: dark.color.bezel,
    borderRadius: theme.radius.hair,
    backgroundColor: dark.color.surface,
    paddingHorizontal: theme.space.md,
    paddingVertical: theme.space.sm,
  },
  mapOpenPressed: { borderColor: dark.color.ink },
  mapOpenLabel: { ...dark.collarLabel, color: dark.color.ink },

  full: { flex: 1, backgroundColor: dark.color.canvas },
  fullBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    paddingHorizontal: dark.space.lg,
    paddingBottom: dark.space.sm,
    backgroundColor: dark.color.canvas,
  },
  fullClose: { alignSelf: 'flex-start' },
  fullCloseLabel: { ...dark.collarLabel, color: dark.color.ink },

  // ── Figures ──
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.color.bezel,
    marginHorizontal: theme.space.xl,
  },
  cell: {
    width: '50%',
    paddingVertical: theme.space.sm,
    paddingRight: theme.space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.color.bezel,
  },
  cellRight: {
    paddingRight: 0,
    paddingLeft: theme.space.md,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: theme.color.bezel,
  },
  cellLabel: { ...theme.collarLabel, color: theme.color.inkMuted },
  cellValue: {
    ...theme.text('title', { family: 'mono' }),
    color: theme.color.ink,
    marginTop: theme.space.hair,
  },
  caption: {
    ...theme.text('micro', { family: 'text' }),
    color: theme.color.inkMuted,
    paddingHorizontal: theme.space.xl,
  },
  warning: {
    ...theme.text('caption', { family: 'text' }),
    color: theme.color.survey,
    paddingHorizontal: theme.space.xl,
  },

  block: { gap: theme.space.sm, paddingHorizontal: theme.space.xl },
  frame: { width: '100%', height: SECTION_HEIGHT },
  notes: { ...theme.text('body', { family: 'text' }), color: theme.color.ink },
  recordedBy: {
    ...theme.collarLabel,
    color: theme.color.inkMuted,
    paddingHorizontal: theme.space.xl,
  },

  // ── Splits ──
  splits: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.color.bezel },
  splitRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.md,
    paddingVertical: theme.space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.color.bezel,
  },
  splitIndex: {
    ...theme.text('caption', { family: 'mono' }),
    color: theme.color.inkMuted,
    width: 28,
  },
  splitPace: { ...theme.text('body', { family: 'mono' }), color: theme.color.ink, width: 76 },
  splitTrack: { flex: 1, height: 2, justifyContent: 'center' },
  splitBar: { height: 2, backgroundColor: theme.color.contour },
  splitGain: {
    ...theme.text('caption', { family: 'mono' }),
    color: theme.color.inkMuted,
    minWidth: 56,
    textAlign: 'right',
  },

  // ── Controls ──
  owner: {
    gap: theme.space.sm,
    marginTop: theme.space.md,
    paddingTop: theme.space.lg,
    marginHorizontal: theme.space.xl,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.color.bezel,
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
  actionInline: { marginHorizontal: 0 },
  actionOff: { borderColor: theme.color.bezel, opacity: 0.6 },
  actionLabel: { ...theme.collarLabel, color: theme.color.ink },
  exportRow: { flexDirection: 'row', gap: theme.space.sm },

  ghost: { paddingHorizontal: theme.space.md, paddingVertical: theme.space.md },
  ghostLabel: { ...theme.collarLabel, color: theme.color.inkMuted },

  destroy: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.survey,
    borderRadius: theme.radius.hair,
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.md,
  },
  destroyLabel: { ...theme.collarLabel, color: theme.color.survey },
  destroyGhostLabel: { ...theme.collarLabel, color: theme.color.survey },

  // ── Editor ──
  editor: { gap: theme.space.lg, paddingHorizontal: theme.space.xl },
  field: { gap: theme.space.xs },
  fieldLabel: { ...theme.collarLabel, color: theme.color.inkMuted },
  input: {
    ...theme.text('body', { family: 'text' }),
    color: theme.color.ink,
    backgroundColor: theme.color.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.bezel,
    borderRadius: theme.radius.hair,
    paddingHorizontal: theme.space.md,
    paddingVertical: theme.space.sm,
  },
  inputTall: { minHeight: 104, textAlignVertical: 'top' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.sm },
  chip: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.bezel,
    borderRadius: theme.radius.hair,
    paddingHorizontal: theme.space.md,
    paddingVertical: theme.space.sm,
  },
  chipOn: { borderColor: theme.color.ink, backgroundColor: theme.color.ink },
  chipLabel: { ...theme.collarLabel, color: theme.color.inkMuted },
  chipLabelOn: { color: theme.color.canvas },
  editorActions: { flexDirection: 'row', alignItems: 'center', gap: theme.space.sm },
  danger: {
    marginTop: theme.space.lg,
    paddingTop: theme.space.lg,
    gap: theme.space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.color.bezel,
  },
  dangerProse: { ...theme.text('body', { family: 'text' }), color: theme.color.ink },
});
