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
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { File, Paths } from 'expo-file-system';
import type { LngLat, MapOut, PlannedRouteDetail, UnitSystem } from '@switchback/core';
import {
  ACTIVITY_TYPE_LABELS,
  DIFFICULTY_LABELS,
  TERRAIN_CAUTION_COPY,
  classifyDifficulty,
  formatDistance,
  formatElevation,
  formatTimeOnFoot,
  plural,
  terrainCaution,
} from '@switchback/core';
import { elevationTicks, simplifyLine, toSectionPoints, toStations } from '@switchback/geo';
import { nativeTheme } from '@switchback/ui';
import { askAgain } from '@/api/after-write';
import { useTRPC } from '@/api/trpc';
import { useAuth } from '@/auth/context';
import { ExploreMap, type ExploreMapHandle } from '@/components/explore-map';
import { SECTION_HEIGHT, Section, distanceAtX } from '@/components/section';
import { useRecorderActions, useRecording } from '@/record/store';

/**
 * One route, read at the car park — the same instrument as a hike page, deliberately.
 *
 * None of the planner is here: no anchors to drag, no undo, no coverage warming. Sixty points
 * placed by thumb on a 390pt screen is not planning, so a route arrives finished and the way
 * back to changing it is the website.
 *
 * The order of the page is an argument: map, numbers, section, and only then the control that
 * starts a hike. The line looks like a trail and is not one.
 */

const theme = nativeTheme('sheet');
const dark = nativeTheme('field');

/** The inline map. Tall enough for a line to have a shape, short enough to scroll past. */
const MAP_HEIGHT = 260;

/**
 * Simplification before the line goes over the bridge. Usually a no-op; it exists for the long
 * route whose points all become characters in a JavaScript literal injected into a `WebView`.
 */
const BRIDGE_TOLERANCE_M = 5;

/** Only used before the geometry arrives, and only for one frame. */
const FALLBACK_CENTER: readonly [number, number] = [-4.05, 53.07];

const SCRUB_SLOP = 4;

export default function RouteScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const trpc = useTRPC();
  const { status } = useAuth();
  const signedIn = status === 'signedIn';

  const me = useQuery({ ...trpc.me.get.queryOptions(), enabled: signedIn });
  const units: UnitSystem = me.data?.units ?? 'metric';

  const route = useQuery({
    ...trpc.routes.detail.queryOptions({ id }),
    enabled: typeof id === 'string' && id.length > 0,
  });

  const [expanded, setExpanded] = useState(false);
  const detail = route.data;

  /** The drawn line, thinned, and stable so the bridge effect fires once. */
  const line = useMemo<LngLat[]>(() => {
    const coords = detail?.geometry.coordinates;
    if (!coords || coords.length < 2) return [];
    return simplifyLine(coords, BRIDGE_TOLERANCE_M);
  }, [detail]);

  const center = useMemo<readonly [number, number]>(() => {
    const first = line[0];
    return first ? [first[0], first[1]] : FALLBACK_CENTER;
  }, [line]);

  const points = useMemo(() => toSectionPoints(detail?.profile ?? []), [detail]);
  const ticks = useMemo(() => elevationTicks(detail?.stats.maxEleM ?? 0, units), [detail, units]);
  /*
   * No terrain factor, matching `apps/web/src/components/plan/route-view.tsx`: that multiplier
   * comes from a trail's `sac_scale` and surface tags, and a drawn line has neither, so the
   * elapsed axis runs at Tobler's own pace. Four marks rather than the website's six, chosen
   * coarser for the width rather than set smaller until they collide.
   */
  const stations = useMemo(
    () => toStations(detail?.profile ?? [], { system: units, maxMarks: 4 }),
    [detail, units],
  );

  // ── The section's touch tracking ──────────────────────────────────────────────────
  const [plotWidth, setPlotWidth] = useState(0);
  const [cursorDistanceM, setCursorDistanceM] = useState<number | null>(null);
  const onFrameLayout = useCallback((event: LayoutChangeEvent) => {
    setPlotWidth(event.nativeEvent.layout.width);
  }, []);

  const totalM = detail?.stats.lengthM ?? 0;
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

  if (route.isPending) {
    return (
      <Chrome insets={insets}>
        <ActivityIndicator color={theme.color.inkMuted} style={styles.pending} />
      </Chrome>
    );
  }

  if (route.isError || !detail) {
    return (
      <Chrome insets={insets}>
        <Text style={styles.title}>Route not found</Text>
        <Text style={styles.prose}>
          {route.error?.message ?? 'That route is not here, or is not shared with you.'}
        </Text>
        <Pressable
          onPress={() => void route.refetch()}
          accessibilityRole="button"
          style={({ pressed }) => [styles.action, pressed ? styles.actionDim : null]}
        >
          <Text style={styles.actionLabel}>Try again</Text>
        </Pressable>
      </Chrome>
    );
  }

  const band = classifyDifficulty({
    gainM: detail.stats.gainM,
    lengthM: detail.stats.lengthM,
    maxSustainedGrade: detail.stats.maxSustainedGrade,
  });

  /*
   * The router optimises for distance across the path graph and never asks how steep the ground
   * is, so two anchors either side of a crag get connected without comment.
   */
  const caution = terrainCaution(detail.stats.maxSustainedGrade);

  const cells: { label: string; value: string }[] = [
    { label: 'Distance', value: formatDistance(detail.stats.lengthM, units) },
    { label: 'Ascent', value: `↑${formatElevation(detail.stats.gainM, units)}` },
    { label: 'Descent', value: `↓${formatElevation(detail.stats.lossM, units)}` },
    { label: 'On foot', value: formatTimeOnFoot(detail.stats.estimatedTimeS) },
    { label: 'High point', value: formatElevation(detail.stats.maxEleM, units) },
    { label: 'Low point', value: formatElevation(detail.stats.minEleM, units) },
  ];

  return (
    <Chrome insets={insets}>
      <View style={styles.head}>
        <Text style={styles.headCollar}>
          {ACTIVITY_TYPE_LABELS[detail.activityType]} · {detail.anchorCount}{' '}
          {plural(detail.anchorCount, 'point')} · {DIFFICULTY_LABELS[band.difficulty]}
        </Text>
        <Text style={styles.title}>{detail.name}</Text>
        {detail.editable ? null : (
          <Text style={styles.byline}>Drawn by {detail.owner.name ?? 'someone else'}</Text>
        )}
      </View>

      {/*
       * Said plainly, once, near the top. A drawn line looks like a trail on a map and is
       * not one — that is the single most important fact on this screen, and it is worded
       * exactly as the website words it, because a caveat that changes shape between two
       * screens of the same product reads as a disclaimer rather than a fact.
       */}
      <Text style={styles.disclaimer}>
        A planned route, not a trail. The line follows paths in OpenStreetMap where they exist;
        nobody has confirmed it on the ground.
      </Text>

      {caution ? (
        <View style={styles.caution} accessibilityRole="alert">
          <Text style={styles.cautionTitle}>{TERRAIN_CAUTION_COPY[caution].title}</Text>
          <Text style={styles.cautionBody}>{TERRAIN_CAUTION_COPY[caution].body}</Text>
        </View>
      ) : null}

      {line.length >= 2 ? (
        <View style={styles.mapWrap}>
          <View style={styles.mapFill} pointerEvents="none">
            <RouteMap line={line} center={center} units={units} />
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

      {points.length >= 2 ? (
        <Block title="Section">
          <View
            onLayout={onFrameLayout}
            pointerEvents="box-only"
            style={styles.frame}
            accessible={false}
            {...pan.panHandlers}
          >
            <Section
              points={points}
              stations={stations}
              elevationTicks={ticks}
              units={units}
              width={plotWidth}
              cursorDistanceM={cursorDistanceM}
              summary={`Elevation along ${formatDistance(detail.stats.lengthM, units)} of planned route, from ${formatElevation(points[0]!.elevationM, units)} at the start to a high point of ${formatElevation(detail.stats.maxEleM, units)}.`}
            />
          </View>
          <Text style={styles.caption}>
            Drag across it for the height at a distance. The times under the axis are an estimate
            from the shape of the ground, not from anyone who has hiked it.
          </Text>
        </Block>
      ) : null}

      {detail.description ? (
        <Block title="Notes">
          <Text style={styles.notes}>{detail.description}</Text>
        </Block>
      ) : null}

      <View style={styles.tail}>
        <StartHike route={detail} />
        <ExportRow id={detail.id} />
        {detail.editable ? <Remove id={detail.id} name={detail.name} /> : null}
      </View>

      {expanded && line.length >= 2 ? (
        <Modal
          visible
          animationType="fade"
          onRequestClose={() => setExpanded(false)}
          supportedOrientations={['portrait', 'landscape']}
          statusBarTranslucent
        >
          <View style={styles.full}>
            <RouteMap line={line} center={center} units={units} />
            <View style={[styles.fullBar, { paddingTop: insets.top + dark.space.sm }]}>
              <Pressable
                onPress={() => setExpanded(false)}
                accessibilityRole="button"
                accessibilityLabel="Close the map"
                hitSlop={dark.space.md}
                style={styles.fullClose}
              >
                <Text style={styles.fullCloseLabel}>← Back to the route</Text>
              </Pressable>
            </View>
          </View>
        </Modal>
      ) : null}
    </Chrome>
  );
}

// ---------------------------------------------------------------------------
// The map

/**
 * The route, on a map. `browse={false}` so the page runs no viewport search — the only thing
 * on this canvas is the line handed over the bridge, and `ExploreMap` queues until `ready`.
 */
function RouteMap({
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
        // request asks for, and a day's route is never far from this scale.
        initialZoom={12}
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
// Hiking it

/**
 * Start a hike that follows this line. The server has no idea — `activities.start` takes a
 * trail id and there is no route equivalent, so this saves as an ordinary hike on no trail.
 * The route id is purely local: it arms the wrong-turn watchdog and the distance-to-finish.
 *
 * The line is handed over here as well as on the Record screen, because the first fix can land
 * before that screen has mounted.
 */
function StartHike({ route }: { route: PlannedRouteDetail }) {
  const trpc = useTRPC();
  const { status } = useAuth();
  const recording = useRecording();
  const actions = useRecorderActions();
  const start = useMutation(trpc.activities.start.mutationOptions());

  const running = recording.phase !== 'idle';
  const here = running && recording.routeId === route.id;

  const onPress = useCallback(() => {
    if (status !== 'signedIn') {
      router.push('/signin');
      return;
    }
    // Never two at once. `activities.start` would close the open one server-side, which is
    // the right thing for a stale recording and the wrong thing for the hike somebody is on.
    if (running) {
      router.navigate('/record');
      return;
    }
    start.mutate(
      { activityType: route.activityType, device: 'iPhone' },
      {
        onSuccess: (activity) => {
          actions.begin({
            id: activity.id,
            startedAt: activity.startedAt,
            trailId: null,
            routeId: route.id,
          });
          actions.setFollowing(route.geometry.coordinates, route.stats.lengthM);
          router.navigate('/record');
        },
      },
    );
  }, [actions, route, running, start, status]);

  const label = start.isPending
    ? 'Starting…'
    : status !== 'signedIn'
      ? 'Sign in to hike it'
      : here
        ? 'Hiking it now →'
        : running
          ? 'A hike is already running →'
          : 'Hike this route';

  const note = here
    ? 'The recorder is following this line and will say so if you leave it.'
    : running
      ? 'Finish or discard the one you are on, and this will start a new hike.'
      : 'Records as an ordinary hike, with wrong-turn alerts against this line.';

  return (
    <View style={styles.startBlock}>
      <Pressable
        onPress={onPress}
        disabled={start.isPending}
        accessibilityRole="button"
        accessibilityState={{ disabled: start.isPending }}
        style={({ pressed }) => [
          styles.start,
          pressed ? styles.startPressed : null,
          start.isPending ? styles.startDisabled : null,
        ]}
      >
        <Text style={styles.startLabel}>{label}</Text>
      </Pressable>
      <Text style={styles.caption}>{note}</Text>
      {start.isError ? <Text style={styles.warning}>{start.error.message}</Text> : null}
    </View>
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
                  const doc = await queryClient.fetchQuery(trpc.routes.gpx.queryOptions({ id }));
                  return write(doc.filename, doc.xml, false);
                })()
              : await (async () => {
                  const doc = await queryClient.fetchQuery(trpc.routes.fit.queryOptions({ id }));
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
    <View style={styles.exportBlock}>
      <View style={styles.exportRow}>
        <Pressable
          onPress={() => send('gpx')}
          disabled={busy !== null}
          accessibilityRole="button"
          accessibilityState={{ disabled: busy !== null }}
          style={({ pressed }) => [
            styles.action,
            styles.actionInline,
            busy === null ? null : styles.actionOff,
            pressed ? styles.actionDim : null,
          ]}
        >
          <Text style={styles.actionLabel}>{busy === 'gpx' ? 'Building…' : 'Share GPX'}</Text>
        </Pressable>
        <Pressable
          onPress={() => send('fit')}
          disabled={busy !== null}
          accessibilityRole="button"
          accessibilityState={{ disabled: busy !== null }}
          style={({ pressed }) => [
            styles.action,
            styles.actionInline,
            busy === null ? null : styles.actionOff,
            pressed ? styles.actionDim : null,
          ]}
        >
          <Text style={styles.actionLabel}>{busy === 'fit' ? 'Building…' : 'Share FIT'}</Text>
        </Pressable>
      </View>
      <Text style={failed === null ? styles.caption : styles.warning}>
        {failed ?? 'GPX opens anywhere. FIT is a course a Garmin can navigate.'}
      </Text>
    </View>
  );
}

/**
 * The document, as a file the share sheet can carry. The cache directory rather than documents,
 * since iOS may reclaim it; `overwrite` because sharing the same route twice must not fail.
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

/**
 * Throw the route away — the only owner control on this screen, since editing means moving
 * anchors. Two steps, in survey red, which is reserved for controls that destroy data.
 */
function Remove({ id, name }: { id: string; name: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [armed, setArmed] = useState(false);

  const remove = useMutation(
    trpc.routes.remove.mutationOptions({
      onSuccess: () => {
        void askAgain(queryClient, trpc.routes.pathFilter());
        if (router.canGoBack()) router.back();
        else router.replace('/routes');
      },
    }),
  );

  if (!armed) {
    return (
      <View style={styles.ownerBlock}>
        <Pressable
          onPress={() => setArmed(true)}
          accessibilityRole="button"
          style={({ pressed }) => [styles.destroy, pressed ? styles.actionDim : null]}
        >
          <Text style={styles.destroyLabel}>Delete this route</Text>
        </Pressable>
        <Text style={styles.caption}>
          To change where it goes, open it in the planner on the website — moving sixty points is a
          job for a mouse.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.ownerBlock}>
      <Text style={styles.confirm}>
        Delete {name}? The line, the anchors and the notes go with it, and nothing here can bring
        them back.
      </Text>
      <View style={styles.confirmRow}>
        <Pressable
          onPress={() => remove.mutate({ id })}
          disabled={remove.isPending}
          accessibilityRole="button"
          accessibilityState={{ disabled: remove.isPending }}
          style={({ pressed }) => [styles.destroy, pressed ? styles.actionDim : null]}
        >
          <Text style={styles.destroyLabel}>
            {remove.isPending ? 'Deleting…' : 'Yes, delete it'}
          </Text>
        </Pressable>
        <Pressable
          onPress={() => setArmed(false)}
          accessibilityRole="button"
          style={({ pressed }) => [styles.ghost, pressed ? styles.actionDim : null]}
        >
          <Text style={styles.ghostLabel}>Keep it</Text>
        </Pressable>
      </View>
      {remove.isError ? <Text style={styles.warning}>{remove.error.message}</Text> : null}
    </View>
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
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/routes'))}
          accessibilityRole="button"
          accessibilityLabel="Back to your routes"
          hitSlop={theme.space.md}
          style={styles.back}
        >
          <Text style={styles.backLabel}>← Routes</Text>
        </Pressable>
        {children}
      </ScrollView>
    </>
  );
}

/**
 * Every edge pinned. Spelled out because React Native 0.86 removed `absoluteFillObject`, and
 * `absoluteFill` is a registered style id, so it cannot be spread.
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
  byline: {
    ...theme.text('caption', { family: 'text' }),
    color: theme.color.inkMuted,
    paddingHorizontal: theme.space.xl,
  },
  prose: {
    ...theme.text('body', { family: 'text' }),
    color: theme.color.inkMuted,
    paddingHorizontal: theme.space.xl,
  },
  disclaimer: {
    ...theme.text('bodyLg', { family: 'text' }),
    color: theme.color.inkMuted,
    paddingHorizontal: theme.space.xl,
    marginTop: -theme.space.sm,
  },

  // A rule down one edge, not a filled panel. The screen already carries a caveat in prose
  // directly above; a red block here would flatten the two into one alarm and the reader
  // would stop distinguishing "unverified" from "you will need a rope".
  caution: {
    gap: theme.space.xs,
    marginHorizontal: theme.space.xl,
    borderLeftWidth: 2,
    borderLeftColor: theme.color.survey,
    paddingLeft: theme.space.md,
  },
  cautionTitle: { ...theme.text('body', { weight: 'semibold' }), color: theme.color.survey },
  cautionBody: { ...theme.text('caption', { family: 'text' }), color: theme.color.ink },

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

  // ── Controls ──
  tail: {
    gap: theme.space.lg,
    marginTop: theme.space.md,
    paddingTop: theme.space.lg,
    marginHorizontal: theme.space.xl,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.color.bezel,
  },
  startBlock: { gap: theme.space.sm },
  start: {
    alignSelf: 'flex-start',
    backgroundColor: theme.color.ink,
    borderRadius: theme.radius.hair,
    paddingHorizontal: theme.space.xl,
    paddingVertical: theme.space.md,
  },
  // An ink fill with a canvas label can afford to dim on press without the label vanishing.
  startPressed: { opacity: 0.8 },
  startDisabled: { opacity: 0.5 },
  startLabel: { ...theme.collarLabel, color: theme.color.canvas },

  exportBlock: { gap: theme.space.sm },
  exportRow: { flexDirection: 'row', gap: theme.space.sm },
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
  // An outline button cannot fill on press: `Pressable`'s style function styles only the
  // Pressable, and a fill would not reach the label's colour. So it dims instead.
  actionDim: { opacity: 0.55 },
  actionLabel: { ...theme.collarLabel, color: theme.color.ink },

  ownerBlock: {
    gap: theme.space.sm,
    paddingTop: theme.space.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.color.bezel,
  },
  confirm: { ...theme.text('body', { family: 'text' }), color: theme.color.ink },
  confirmRow: { flexDirection: 'row', alignItems: 'center', gap: theme.space.sm },
  destroy: {
    alignSelf: 'flex-start',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.survey,
    borderRadius: theme.radius.hair,
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.md,
  },
  destroyLabel: { ...theme.collarLabel, color: theme.color.survey },
  ghost: { paddingHorizontal: theme.space.md, paddingVertical: theme.space.md },
  ghostLabel: { ...theme.collarLabel, color: theme.color.inkMuted },
});
