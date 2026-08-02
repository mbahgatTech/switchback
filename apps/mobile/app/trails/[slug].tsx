import { useCallback, useMemo, useRef, useState } from 'react';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import {
  ActivityIndicator,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { LayoutChangeEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type {
  ActivityType,
  ElevationPoint,
  LineString,
  RouteType,
  SacScale,
  UnitSystem,
  Waypoint,
} from '@switchback/core';
import {
  TERRAIN_CAUTION_COPY,
  addDays,
  formatDistance,
  formatDuration,
  formatElevation,
  localDateAt,
  localIso,
  nextDateOn,
  splitLocalIso,
  terrainCaution,
  trailTitle,
} from '@switchback/core';
import {
  cumulativeTimeS,
  elevationAt,
  elevationTicks,
  hikedProfile,
  terrainFactorFor,
  timeAtDistanceS,
  toSectionPoints,
  toStations,
} from '@switchback/geo';
import { CONTROL_HEIGHT, DIFFICULTY_PLATE, nativeTheme } from '@switchback/ui';
import { useTRPC } from '@/api/trpc';
import { useAuth } from '@/auth/context';
import { BusyTimes } from '@/components/busy-times';
import { Conditions } from '@/components/conditions';
import { DownloadTrail } from '@/components/download-trail';
import { Photos } from '@/components/photos';
import { Reviews } from '@/components/reviews';
import { SaveControls } from '@/components/save-controls';
import { SECTION_HEIGHT, Section, distanceAtX } from '@/components/section';
import { useOfflineHydration } from '@/offline/hydrate';
import { useOfflineCopy } from '@/offline/store';
import { useRecorderActions, useRecording } from '@/record/store';

/**
 * One trail. Drawn in `sheet` rather than the app's default `field` — this is a reading screen,
 * not the map. The geography is carried by the scrubbable section graphic, not a thumbnail map.
 */

const theme = nativeTheme('sheet');

/** Stable identity so the `useMemo`s below do not recompute on every render before load. */
const NO_PROFILE: readonly ElevationPoint[] = [];

/** Horizontal travel that counts as scrubbing rather than the start of a page scroll. */
const SCRUB_SLOP = 4;

const ROUTE_TYPE_LABEL: Record<RouteType, string> = {
  loop: 'Loop',
  out_and_back: 'Out and back',
  point_to_point: 'Point to point',
};

const DIFFICULTY_LABEL = { easy: 'Easy', moderate: 'Moderate', hard: 'Hard' } as const;

/** How many start days the rail offers. Six always fits inside the upstream horizon. */
const DAYS_OFFERED = 6;

const BUSYNESS_MESSAGE =
  'Busy times could not be worked out just now. Everything else on this screen is unaffected.';

/**
 * SAC grades with their T-numbers, the same table the website prints. Both are shown: the bare
 * OSM value means nothing to a reader, the T-number means everything to an Alpine hiker.
 */
const SAC_LABEL: Record<SacScale, { grade: string; text: string }> = {
  hiking: { grade: 'T1', text: 'Well marked, no head for heights needed' },
  mountain_hiking: { grade: 'T2', text: 'Continuous trail, some steep ground, sure footing' },
  demanding_mountain_hiking: {
    grade: 'T3',
    text: 'Exposed sections possible, hands occasionally needed',
  },
  alpine_hiking: { grade: 'T4', text: 'Pathless in places, exposure, scrambling' },
  demanding_alpine_hiking: { grade: 'T5', text: 'Demanding scrambling, glacier travel possible' },
  difficult_alpine_hiking: { grade: 'T6', text: 'Serious climbing, often unmarked and exposed' },
};

export default function TrailScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const insets = useSafeAreaInsets();
  const trpc = useTRPC();
  const { status } = useAuth();

  /**
   * The hiker's own units, read once and passed to every figure on this screen. Signed out
   * there is nobody to have a preference; offline the query has no answer either, so metric.
   */
  const me = useQuery({ ...trpc.me.get.queryOptions(), enabled: status === 'signedIn' });
  const units: UnitSystem = me.data?.units ?? 'metric';

  const query = useQuery(
    trpc.trails.bySlug.queryOptions({ slug: slug ?? '' }, { enabled: Boolean(slug) }),
  );

  /*
   * The phone's copy, put back under the same query keys the live ones use, so nothing below
   * this line knows a download exists. See `@/offline/hydrate`.
   */
  const offline = useOfflineCopy(slug);
  useOfflineHydration(offline.trail);

  const trail = query.data;

  /** True when the reader is looking at the phone's copy because the fetch did not land. */
  const fromDisk = query.failureReason !== null && offline.trail !== null;

  const [plotWidth, setPlotWidth] = useState(0);
  const [cursorDistanceM, setCursorDistanceM] = useState<number | null>(null);

  /**
   * The hike, which on an out-and-back is not the line OSM drew: the spur is mapped once but
   * every published figure describes the round trip. `hikedProfile` reconciles the two, so the
   * section, its cursor readout and the stat block cannot disagree about how long the day is.
   */
  const profile = useMemo(
    () =>
      trail
        ? hikedProfile(trail.profile, {
            routeType: trail.routeType,
            lengthM: trail.stats.lengthM,
          })
        : NO_PROFILE,
    [trail],
  );
  const totalM = trail?.stats.lengthM ?? 0;
  const hasProfile = profile.length >= 2;

  /**
   * The start time, held here rather than in Conditions or BusyTimes because the recommendation
   * from one is the input to the other.
   *
   * The UTC offset is never computed on this device — Hermes has no timezone database.
   * `forecast.startAt` arrives carrying the trail's real offset and every other start time is
   * that string with the date and hour swapped. See `@switchback/core`'s `localtime`.
   */
  const [start, setStart] = useState<{ date: string; hour: number } | null>(null);
  const anchor = useRef<{ date: string; offset: string } | null>(null);

  const startAt =
    start === null || anchor.current === null
      ? undefined
      : localIso(start.date, start.hour, anchor.current.offset);

  const weather = useQuery(
    trpc.weather.alongRoute.queryOptions(
      { trailId: trail?.id ?? '', ...(startAt === undefined ? {} : { startAt }) },
      {
        enabled: Boolean(trail?.id) && hasProfile,
        // The upstream model publishes hourly; asking again inside that window buys nothing
        // and costs a cellular round trip.
        staleTime: 10 * 60_000,
        placeholderData: keepPreviousData,
        retry: 1,
      },
    ),
  );

  const busyness = useQuery(
    trpc.busyness.forWeek.queryOptions(
      { trailId: trail?.id ?? '' },
      { enabled: Boolean(trail?.id), staleTime: 30 * 60_000, retry: 1 },
    ),
  );

  const forecast = weather.data ?? null;
  if (anchor.current === null && forecast) {
    const parts = splitLocalIso(forecast.startAt);
    if (parts) anchor.current = { date: parts.date, offset: parts.offset };
  }

  // What the rails show: the reader's own choice once they have made one, the server's
  // default until then.
  const shown = useMemo(() => {
    if (start !== null) return start;
    if (!forecast) return null;
    const parts = splitLocalIso(forecast.startAt);
    return parts === null ? null : { date: parts.date, hour: parts.hour };
  }, [start, forecast]);

  const dateOptions = useMemo(() => {
    const from = anchor.current?.date;
    if (from === undefined) return [];
    const days = Array.from({ length: DAYS_OFFERED }, (_, i) => addDays(from, i));
    // A recommendation can point a day past the end of the rail. Rather than clamp it —
    // which would silently answer a different question — the rail grows to hold it.
    return shown && !days.includes(shown.date) ? [...days, shown.date].sort() : days;
  }, [shown]);

  const onStartChange = useCallback((date: string, hour: number) => {
    if (date === '') return;
    setStart({ date, hour });
  }, []);

  /** A weekday from the busyness grid, resolved to the next date that is still ahead. */
  const onPickStart = useCallback((dayOfWeek: number, hour: number) => {
    const from = anchor.current?.date;
    if (from === undefined) return;
    setStart({ date: nextDateOn(from, dayOfWeek), hour });
  }, []);

  const todayDayOfWeek = useMemo(() => {
    if (!forecast) return null;
    const parts = splitLocalIso(forecast.startAt);
    if (parts === null) return null;
    const today = localDateAt(forecast.fetchedAt, parts.offset);
    return today === null ? null : new Date(`${today}T00:00:00Z`).getUTCDay();
  }, [forecast]);

  // The multiplier the ingest pipeline used for `estimatedTimeS`, so the elapsed axis under
  // the section and the headline time in the grid cannot disagree with each other.
  const terrainFactor = useMemo(
    () => terrainFactorFor({ sacScale: trail?.sacScale ?? null, surface: trail?.surface ?? null }),
    [trail?.sacScale, trail?.surface],
  );

  const points = useMemo(() => toSectionPoints(profile), [profile]);
  const ticks = useMemo(
    () => elevationTicks(trail?.stats.maxEleM ?? 0, units),
    [trail?.stats.maxEleM, units],
  );
  // Four marks, not the website's six: the same ladder of round numbers, chosen coarser for
  // the width rather than the same numbers set smaller until they collide.
  const stations = useMemo(
    () => toStations(profile, { terrainFactor, system: units, maxMarks: 4 }),
    [profile, terrainFactor, units],
  );
  const cumulative = useMemo(
    () => cumulativeTimeS(profile, { terrainFactor }),
    [profile, terrainFactor],
  );

  /**
   * Scrubbing without taking the page hostage. The responder is claimed only once the finger
   * has travelled further across than down, so a vertical swipe still reaches the `ScrollView`;
   * `onPanResponderTerminationRequest` then refuses to hand it back, or the `ScrollView`
   * reclaims a scrub that drifts off the horizontal. The cursor stays where the finger lifts —
   * a finger is opaque, so the number under it can only be read once it has moved away.
   */
  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_event, gesture) =>
          Math.abs(gesture.dx) > Math.abs(gesture.dy) && Math.abs(gesture.dx) > SCRUB_SLOP,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: (event) =>
          setCursorDistanceM(distanceAtX(event.nativeEvent.locationX, plotWidth, totalM)),
        onPanResponderMove: (event) =>
          setCursorDistanceM(distanceAtX(event.nativeEvent.locationX, plotWidth, totalM)),
      }),
    [plotWidth, totalM],
  );

  const onFrameLayout = (event: LayoutChangeEvent) => setPlotWidth(event.nativeEvent.layout.width);

  if (query.isPending || (!trail && !offline.settled)) {
    return (
      <Chrome insets={insets}>
        <ActivityIndicator color={theme.color.inkMuted} style={styles.pending} />
      </Chrome>
    );
  }

  if (query.isError || !trail) {
    return (
      <Chrome insets={insets}>
        <Text style={styles.name}>Trail not found</Text>
        <Text style={styles.prose}>
          {query.error?.message ??
            'Nothing here matches that address. It may have been renamed upstream.'}
        </Text>
        <Pressable onPress={() => void query.refetch()} style={styles.retry}>
          <Text style={styles.retryLabel}>Try again</Text>
        </Pressable>
      </Chrome>
    );
  }

  const stats = trail.stats;
  const plate = theme.color[DIFFICULTY_PLATE[trail.difficulty]];
  const cursorEleM = cursorDistanceM === null ? null : elevationAt(profile, cursorDistanceM);
  const cursorTimeS =
    cursorDistanceM === null ? null : timeAtDistanceS(profile, cumulative, cursorDistanceM);

  const onRoute = trail.waypoints
    .filter((waypoint): waypoint is Waypoint & { distM: number } => waypoint.distM !== null)
    .sort((a, b) => a.distM - b.distM);

  const cells: { label: string; value: string }[] = [
    { label: 'Length', value: formatDistance(stats.lengthM, units) },
    { label: 'Ascent', value: `↑ ${formatElevation(stats.gainM, units)}` },
    { label: 'Descent', value: `↓ ${formatElevation(stats.lossM, units)}` },
    { label: 'Moving time', value: formatDuration(stats.estimatedTimeS) },
    { label: 'High point', value: formatElevation(stats.maxEleM, units) },
    { label: 'Low point', value: formatElevation(stats.minEleM, units) },
    {
      label: 'Steepest',
      value:
        stats.maxSustainedGrade === null ? '—' : `${Math.round(stats.maxSustainedGrade * 100)} %`,
    },
    { label: 'Route', value: ROUTE_TYPE_LABEL[trail.routeType] },
  ];

  const sac = trail.sacScale === null ? null : SAC_LABEL[trail.sacScale];
  const caution = terrainCaution(stats.maxSustainedGrade);
  const title = trailTitle(trail);

  return (
    <Chrome insets={insets}>
      <View style={styles.title}>
        <Text style={styles.collar} numberOfLines={1}>
          {[trail.regionName, ROUTE_TYPE_LABEL[trail.routeType]].filter(Boolean).join(' · ')}
        </Text>
        <Text style={styles.name}>{title}</Text>
        <View style={styles.badges}>
          <View style={[styles.plate, { backgroundColor: plate }]}>
            <Text style={styles.plateLabel}>{DIFFICULTY_LABEL[trail.difficulty]}</Text>
          </View>
          <Text style={styles.rating}>
            {trail.rating === null
              ? 'No reviews yet'
              : `${trail.rating.toFixed(1)} ★ · ${trail.reviewCount} ${
                  trail.reviewCount === 1 ? 'review' : 'reviews'
                }`}
          </Text>
        </View>
      </View>

      {/*
       * Above the controls that start a hike, deliberately: everything below is written to be
       * encouraging, and a route up a 55° face must not read like one up a valley. Survey red,
       * which this product spends only on the reader's safety and on destructive controls.
       */}
      {caution ? (
        <View style={styles.caution} accessibilityRole="alert">
          <Text style={styles.cautionTitle}>{TERRAIN_CAUTION_COPY[caution].title}</Text>
          <Text style={styles.cautionBody}>{TERRAIN_CAUTION_COPY[caution].body}</Text>
        </View>
      ) : null}

      <SaveControls trailId={trail.id} />

      <StartHike
        trailId={trail.id}
        activityType={trail.activityTypes[0] ?? 'hiking'}
        geometry={trail.geometry}
        lengthM={stats.lengthM}
      />

      <DownloadTrail slug={trail.slug} stale={fromDisk} />

      {points.length < 2 ? (
        // A trail exists before its elevation pass runs — the tile commits geometry first.
        // Saying which half is missing beats an empty frame that reads as a broken screen.
        <Text style={styles.absent}>
          The elevation pass for this trail has not finished yet. The distance and the route are
          final; the section and the climb figures arrive with it.
        </Text>
      ) : (
        <View style={styles.figure}>
          <View style={styles.readout}>
            <Text style={styles.collar}>Section</Text>
            <Text style={styles.readoutValue} numberOfLines={1}>
              {cursorDistanceM === null ? (
                `${formatDistance(totalM, units)} · ↑${formatElevation(stats.gainM, units)}`
              ) : (
                <>
                  <Text style={styles.readoutStrong}>
                    {formatElevation(cursorEleM ?? 0, units)}
                  </Text>
                  {` at ${formatDistance(cursorDistanceM, units)} · ${formatDuration(
                    cursorTimeS ?? 0,
                  )} in`}
                </>
              )}
            </Text>
          </View>

          {/*
           * `box-only` makes this View the touch target rather than whichever SVG shape the
           * finger is over, which is what makes `locationX` mean "points from the left of the
           * plot" on every move instead of only on some of them.
           */}
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
              summary={`Elevation profile: ${formatDistance(
                totalM,
                units,
              )} long, climbing ${formatElevation(
                stats.gainM,
                units,
              )} from ${formatElevation(stats.minEleM, units)} to ${formatElevation(
                stats.maxEleM,
                units,
              )}.`}
            />
          </View>

          <Text style={styles.caption}>
            Drag across the section to read the height and the time at any point. Hatching tightens
            as the ground steepens. Times are moving time from the trailhead — no stops, no lunch,
            no photographs.
          </Text>
        </View>
      )}

      <View style={styles.grid}>
        {cells.map((cell, i) => (
          <View key={cell.label} style={[styles.cell, i % 2 === 1 ? styles.cellRight : null]}>
            <Text style={styles.cellLabel}>{cell.label}</Text>
            <Text style={styles.cellValue} numberOfLines={1}>
              {cell.value}
            </Text>
          </View>
        ))}
      </View>

      {hasProfile ? (
        <Conditions
          forecast={forecast}
          isPending={weather.isPending}
          isFetching={weather.isFetching}
          error={weather.isError ? weatherMessage(weather.error) : null}
          date={shown?.date ?? null}
          hour={shown?.hour ?? null}
          dateOptions={dateOptions}
          onStartChange={onStartChange}
        />
      ) : null}

      <BusyTimes
        forecast={busyness.data ?? null}
        isPending={busyness.isPending}
        error={busyness.isError ? BUSYNESS_MESSAGE : null}
        todayDayOfWeek={todayDayOfWeek}
        onPickStart={anchor.current === null ? undefined : onPickStart}
      />

      {trail.description ? (
        <Section_ title="Description">
          <Text style={styles.prose}>{trail.description}</Text>
        </Section_>
      ) : null}

      {onRoute.length > 0 ? (
        <Section_ title="On the way">
          <View>
            {onRoute.map((waypoint) => (
              <View key={waypoint.id} style={styles.waypoint}>
                <Text style={styles.waypointDist}>{formatDistance(waypoint.distM, units)}</Text>
                <Text style={styles.waypointName} numberOfLines={2}>
                  {waypoint.name ?? titleCase(waypoint.kind)}
                  {waypoint.name ? (
                    <Text style={styles.waypointKind}> · {titleCase(waypoint.kind)}</Text>
                  ) : null}
                </Text>
                {waypoint.eleM === null ? null : (
                  <Text style={styles.waypointEle}>{formatElevation(waypoint.eleM, units)}</Text>
                )}
              </View>
            ))}
          </View>
        </Section_>
      ) : null}

      <Section_ title="Access">
        <Fact label="Activities" value={trail.activityTypes.map(titleCase).join(' · ') || '—'} />
        <Fact label="Surface" value={trail.surface === null ? '—' : titleCase(trail.surface)} />
        <Fact label="Dogs" value={yesNo(trail.dogsAllowed)} />
        <Fact label="Step-free" value={yesNo(trail.wheelchairAccessible)} />
        <Fact label="Fee" value={yesNo(trail.feeRequired)} />
        {sac ? (
          <View style={styles.sac}>
            <Text style={styles.sacGrade}>{sac.grade}</Text>
            <Text style={styles.sacText}>{sac.text}</Text>
          </View>
        ) : null}
      </Section_>

      {/* Photographs before reports: the pictures answer what the figures above cannot. */}
      <Photos trailId={trail.id} trailName={title} />

      {/* Reports last: the one block written by someone who was standing on the trail. */}
      <Reviews trailId={trail.id} />

      <View style={styles.provenance}>
        <Text style={styles.provenanceText}>
          Route and tags from OpenStreetMap
          {trail.osmType && trail.osmId !== null ? ` (${trail.osmType} ${trail.osmId})` : ''}
          {/* The path's own name, where the heading is not it — the web trail page carries the
              same clause for the same reason. The title reads "<Destination> via <OSM name>",
              and this is the app held at the trailhead: without this line the words actually
              on the signpost appear nowhere on the screen. */}
          {title === trail.name ? '' : `, where the path itself is named ${trail.name}`}, ©
          OpenStreetMap contributors, ODbL. Elevation sampled from AWS Terrain Tiles.
        </Text>
        {trail.sourceUpdatedAt ? (
          <Text style={styles.provenanceText}>
            Reconciled with OSM on {new Date(trail.sourceUpdatedAt).toLocaleDateString()}.
          </Text>
        ) : null}
        {/* The way from the credit to the full statement of what every layer is made of. */}
        <Pressable
          onPress={() => router.push('/attribution')}
          accessibilityRole="button"
          accessibilityLabel="Sources and licences"
          hitSlop={theme.space.sm}
          style={({ pressed }) => [styles.provenanceLink, pressed ? { opacity: 0.55 } : null]}
        >
          <Text style={styles.provenanceLinkLabel}>Sources and licences →</Text>
        </Pressable>
      </View>
    </Chrome>
  );
}

/** Four controls wearing one coat, as a table — easier to check than nested ternaries. */
type StartState = 'ready' | 'starting' | 'here' | 'elsewhere' | 'signedOut';

const START_COPY: Record<StartState, { label: string; note: string }> = {
  ready: {
    label: 'Record this hike',
    note: 'Follows this line as you go — distance still to hike, and a warning if you leave it.',
  },
  starting: { label: 'Starting…', note: 'Opening the recorder.' },
  here: {
    label: 'Open the recorder',
    note: 'Recording, and following this line.',
  },
  elsewhere: {
    label: 'Open the recorder',
    note: 'Another hike is already running. Finish or discard it before starting this one.',
  },
  signedOut: {
    label: 'Sign in to record',
    note: 'A recorded hike is kept on your record, and ticks this trail off.',
  },
};

/**
 * Start a hike on this trail. Unlike the website it starts here rather than routing to a form:
 * the activity type is the trail's own and the visibility is the account's, so nothing is left
 * to ask. Its own component so a running recording re-renders this and not the whole page.
 */
function StartHike({
  trailId,
  activityType,
  geometry,
  lengthM,
}: {
  trailId: string;
  activityType: ActivityType;
  geometry: LineString;
  lengthM: number;
}) {
  const trpc = useTRPC();
  const { status } = useAuth();
  const recording = useRecording();
  const actions = useRecorderActions();
  const start = useMutation(trpc.activities.start.mutationOptions());

  const running = recording.phase !== 'idle';
  const state: StartState = start.isPending
    ? 'starting'
    : status !== 'signedIn'
      ? 'signedOut'
      : running
        ? recording.trailId === trailId
          ? 'here'
          : 'elsewhere'
        : 'ready';

  const onPress = useCallback(() => {
    if (status !== 'signedIn') {
      router.push('/signin');
      return;
    }
    // Never two at once. `activities.start` would close the open one server-side, which is the
    // right thing for a stale recording and the wrong thing for the hike somebody is on.
    if (running) {
      router.navigate('/record');
      return;
    }
    start.mutate(
      { activityType, trailId, device: 'iPhone' },
      {
        onSuccess: (activity) => {
          actions.begin({ id: activity.id, startedAt: activity.startedAt, trailId });
          // Handed over here as well as on the Record screen: the first fix can land before
          // that screen has mounted, and a wrong-turn watchdog that only arms once its screen
          // is on misses the turn out of the car park.
          actions.setFollowing(geometry.coordinates, lengthM);
          router.navigate('/record');
        },
      },
    );
  }, [actions, activityType, geometry, lengthM, running, start, status, trailId]);

  const copy = START_COPY[state];

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
        <Text style={styles.startLabel}>{copy.label}</Text>
      </Pressable>
      <Text style={styles.startNote}>{copy.note}</Text>
      {start.isError ? <Text style={styles.startError}>{start.error.message}</Text> : null}
    </View>
  );
}

/**
 * The scroll container and the way back, shared by this screen's three states. The back control
 * is drawn here because the root `Stack` runs headerless — a platform header would bring its own
 * typeface, rule and tint.
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
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
          accessibilityRole="button"
          accessibilityLabel="Back to trails"
          hitSlop={theme.space.md}
          style={styles.back}
        >
          <Text style={styles.backLabel}>← Trails</Text>
        </Pressable>
        {children}
      </ScrollView>
    </>
  );
}

/** A titled block. Trailing underscore because `Section` in this file is the graphic. */
function Section_({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.block}>
      <Text style={styles.collar}>{title}</Text>
      <View style={styles.blockBody}>{children}</View>
    </View>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.fact}>
      <Text style={styles.factLabel}>{label}</Text>
      <Text style={styles.factValue} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

/**
 * What went wrong, in terms of what the reader can do about it. A trail with no elevation pass
 * cannot be forecast along at all; an upstream outage is worth waiting out.
 */
function weatherMessage(error: unknown): string {
  switch (codeOf(error)) {
    case 'NOT_FOUND':
      return 'This trail has no elevation profile yet, so there is nothing to forecast along. It arrives with the elevation pass.';
    case 'TIMEOUT':
    case 'SERVICE_UNAVAILABLE':
      return 'The forecast service did not answer in time. Try again in a minute — the rest of this screen is unaffected.';
    default:
      return 'The forecast for this route could not be read. The rest of this screen is unaffected.';
  }
}

/** tRPC hangs the error code off `data`, which arrives as JSON and is typed as unknown. */
function codeOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const data: unknown = (error as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) return null;
  const code: unknown = (data as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

/** OSM's absence of a tag is not a "no", and printing one would be inventing data. */
function yesNo(value: boolean | null): string {
  if (value === null) return 'Not recorded';
  return value ? 'Yes' : 'No';
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).replace(/_/g, ' ');
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.color.canvas },
  content: {
    paddingHorizontal: theme.space.xl,
    gap: theme.space['2xl'],
  },

  back: { alignSelf: 'flex-start', paddingVertical: theme.space.xs },
  backLabel: { ...theme.collarLabel, color: theme.color.inkMuted },

  pending: { marginTop: theme.space['4xl'] },
  retry: {
    alignSelf: 'flex-start',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.ink,
    borderRadius: theme.radius.hair,
    paddingHorizontal: theme.space.lg,
    // The tap target is the token, not a number chosen to look right — 48pt everywhere.
    paddingVertical: theme.space.md,
  },
  retryLabel: { ...theme.collarLabel, color: theme.color.ink },

  title: { gap: theme.space.sm },
  collar: { ...theme.collarLabel, color: theme.color.inkMuted },
  name: { ...theme.text('h3', { weight: 'semibold' }), color: theme.color.ink },
  badges: { flexDirection: 'row', alignItems: 'center', gap: theme.space.md },
  plate: {
    borderRadius: theme.radius.hair,
    paddingHorizontal: theme.space.sm,
    paddingVertical: theme.space.hair,
  },
  // Canvas on the plate rather than white: the chip is a printed patch of one separation, and
  // the paper showing through it is the paper this page is already on.
  plateLabel: { ...theme.collarLabel, color: theme.color.canvas },
  rating: { ...theme.text('caption', { family: 'mono' }), color: theme.color.inkMuted },

  // The one filled control on a page of hairlines, in ink rather than woodland: it is not a
  // fact about the trail, so it does not take a plate.
  startBlock: { gap: theme.space.sm },
  start: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.color.ink,
    borderRadius: theme.radius.hair,
    // The field rung rather than the touch one: pressed with a glove on, in a car park.
    height: CONTROL_HEIGHT.field,
  },
  startPressed: { backgroundColor: theme.color.inkMuted },
  startDisabled: { opacity: 0.6 },
  startLabel: { ...theme.collarLabel, color: theme.color.canvas },
  startNote: { ...theme.text('micro', { family: 'text' }), color: theme.color.inkMuted },
  startError: { ...theme.text('micro', { family: 'text' }), color: theme.color.survey },

  figure: { gap: theme.space.sm },
  readout: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: theme.space.md,
  },
  readoutValue: {
    ...theme.text('micro', { family: 'mono' }),
    color: theme.color.inkMuted,
    flexShrink: 1,
    textAlign: 'right',
  },
  readoutStrong: { color: theme.color.ink },
  frame: { width: '100%', height: SECTION_HEIGHT },
  caption: { ...theme.text('caption', { family: 'text' }), color: theme.color.inkMuted },
  absent: {
    ...theme.text('caption', { family: 'text' }),
    color: theme.color.inkMuted,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.bezel,
    borderStyle: 'dashed',
    borderRadius: theme.radius.hair,
    padding: theme.space.lg,
  },

  // Two columns of four, ruled rather than boxed — a table on a sheet, not a row of cards.
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  cell: {
    width: '50%',
    gap: theme.space.hair,
    paddingVertical: theme.space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.color.bezel,
  },
  cellRight: {
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: theme.color.bezel,
    paddingLeft: theme.space.md,
  },
  cellLabel: { ...theme.collarLabel, color: theme.color.inkMuted },
  cellValue: { ...theme.text('title', { family: 'mono' }), color: theme.color.ink },

  block: { gap: theme.space.md },
  blockBody: {
    gap: theme.space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.color.bezel,
    paddingTop: theme.space.md,
  },
  prose: { ...theme.text('body', { family: 'text' }), color: theme.color.ink },

  waypoint: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: theme.space.md,
    paddingVertical: theme.space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.color.bezel,
  },
  // Fixed width so the distances form a column the eye can run down, which is why this list is
  // ordered by distance rather than by importance.
  waypointDist: {
    ...theme.text('caption', { family: 'mono' }),
    color: theme.color.inkMuted,
    width: 64,
  },
  waypointName: { ...theme.text('caption'), color: theme.color.ink, flex: 1 },
  waypointKind: { color: theme.color.inkMuted },
  waypointEle: { ...theme.text('caption', { family: 'mono' }), color: theme.color.inkMuted },

  fact: { flexDirection: 'row', justifyContent: 'space-between', gap: theme.space.lg },
  factLabel: { ...theme.text('caption'), color: theme.color.inkMuted },
  factValue: {
    ...theme.text('caption', { family: 'mono' }),
    color: theme.color.ink,
    flexShrink: 1,
    textAlign: 'right',
  },

  sac: { flexDirection: 'row', gap: theme.space.md, paddingTop: theme.space.sm },
  sacGrade: {
    ...theme.text('caption', { family: 'mono', weight: 'medium' }),
    color: theme.color.contour,
  },
  sacText: { ...theme.text('caption', { family: 'text' }), color: theme.color.inkMuted, flex: 1 },

  // A rule rather than a filled panel: survey red at this size would be the loudest thing on a
  // screen whose whole argument is that the figures above it are quiet and exact.
  caution: {
    gap: theme.space.xs,
    borderLeftWidth: 2,
    borderLeftColor: theme.color.survey,
    paddingLeft: theme.space.md,
  },
  cautionTitle: { ...theme.text('body', { weight: 'semibold' }), color: theme.color.survey },
  cautionBody: { ...theme.text('caption', { family: 'text' }), color: theme.color.ink },

  provenance: {
    gap: theme.space.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.color.bezel,
    paddingTop: theme.space.md,
  },
  provenanceText: { ...theme.text('micro', { family: 'text' }), color: theme.color.inkMuted },
  provenanceLink: {
    alignSelf: 'flex-start',
    minHeight: CONTROL_HEIGHT.touch,
    justifyContent: 'center',
  },
  provenanceLinkLabel: { ...theme.collarLabel, color: theme.color.ink },
});
