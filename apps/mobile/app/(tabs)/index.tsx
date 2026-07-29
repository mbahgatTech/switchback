import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  FlatList,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import * as Location from 'expo-location';
import type {
  ActivityType,
  AreaSummary,
  BBox,
  Difficulty,
  MapOut,
  MapQuery,
  RouteType,
  TileCoverage,
  TrailSummary,
  UnitSystem,
} from '@switchback/core';
import {
  ACTIVITY_TYPES,
  ACTIVITY_TYPE_LABELS,
  DIFFICULTIES,
  DIFFICULTY_LABELS,
  ROUTE_TYPES,
  formatDistance,
  formatDuration,
  formatElevation,
} from '@switchback/core';
import { CONTROL_HEIGHT, DIFFICULTY_PLATE, nativeTheme } from '@switchback/ui';
import { useTRPC } from '@/api/trpc';
import { useAuth } from '@/auth/context';
import { Chip, ChipRail } from '@/components/chip';
import { ExploreMap, type ExploreMapHandle } from '@/components/explore-map';
import { Mark } from '@/components/marks';
import { Photograph } from '@/components/photograph';

/**
 * Explore.
 *
 * A map with a sheet over it, which is the only shape this screen can take: "what is around
 * here" is a question answered by ground, and a list of names is what you read once the ground
 * has told you where to look. The map fills the screen; the sheet is dragged over as much of it
 * as you want.
 *
 * Three states, and only three, because a map screen with more than three is a map screen
 * nobody can predict:
 *
 * - **Browsing.** The sheet lists what is in view, ranked by popularity, and follows the
 *   viewport. There is no "search this area" button — the map re-asks when it stops moving,
 *   which is what the button would have done one tap later.
 * - **Selected.** A trail is picked, on the canvas and in the sheet at once, and the sheet
 *   becomes a card for it with a way through to its page. Tapping bare ground clears it.
 * - **Searching.** A full-screen overlay over both, listing places and trails by name. A place
 *   moves the camera; a trail moves the camera and then selects itself once it has landed.
 *
 * The map is `@/components/explore-map` — MapLibre in a `WebView` — and it owns its viewport
 * and its own `trails.browse` query. This screen is the chrome around it.
 */

const theme = nativeTheme('field');

/** The grabber and one line of type: what the sheet shows when pushed as far down as it goes. */
const PEEK = 108;
/** The selection card is a fixed height, so the map above it never moves while you read it. */
const CARD = 232;
/** How far a flick carries, in points per point-per-millisecond of release velocity. */
const FLING = 140;
/** Long enough that typing a word is one lookup. Nominatim allows one request a second. */
const SEARCH_DEBOUNCE_MS = 320;

/** Snowdon, matching the website's own opening view. Overridden by a last known fix. */
const INITIAL_CENTER: readonly [number, number] = [-4.05, 53.07];
const INITIAL_ZOOM = 11;

type Snap = 'peek' | 'half' | 'full';
type BasemapId = 'relief' | 'satellite' | 'topo';

const BASEMAPS: readonly { id: BasemapId; label: string }[] = [
  { id: 'relief', label: 'Relief' },
  { id: 'satellite', label: 'Satellite' },
  { id: 'topo', label: 'Topographic' },
];

const ROUTE_TYPE_LABEL = {
  loop: 'Loop',
  out_and_back: 'Out and back',
  point_to_point: 'Point to point',
} as const;

/**
 * What the map is asked for, beyond the ground it is looking at.
 *
 * Held as the state of the controls rather than as a `MapQuery`, because the two are not the
 * same shape: "any length" is one chip being unselected here and an *absent* pair of bounds
 * over the bridge, and a `dogsAllowed: false` that meant "unset" in the UI would mean "only
 * trails that forbid dogs" on the server. `toQuery` is where one becomes the other.
 */
interface Filters {
  difficulty: readonly Difficulty[];
  routeType: readonly RouteType[];
  activityTypes: readonly ActivityType[];
  /** An index into `lengthBands(units)`, or null for any length. */
  band: number | null;
  minRating: number | null;
  dogsAllowed: boolean;
  wheelchairAccessible: boolean;
  sort: MapQuery['sort'];
}

const NO_FILTERS: Filters = {
  difficulty: [],
  routeType: [],
  activityTypes: [],
  band: null,
  minRating: null,
  dogsAllowed: false,
  wheelchairAccessible: false,
  sort: 'popularity',
};

/**
 * Three stops, not five.
 *
 * Nobody chooses between "3.5 and up" and "3.7 and up". Three is "not the bad ones", four is
 * "the good ones", four and a half is "the ones people came back to write about".
 */
const RATINGS = [3, 4, 4.5] as const;

const SORTS: readonly { id: MapQuery['sort']; label: string }[] = [
  { id: 'popularity', label: 'Popular' },
  { id: 'rating', label: 'Best rated' },
  { id: 'length_asc', label: 'Shortest' },
  { id: 'length_desc', label: 'Longest' },
];

export default function ExploreScreen() {
  const insets = useSafeAreaInsets();
  const { height: screenH } = useWindowDimensions();
  const trpc = useTRPC();
  const auth = useAuth();

  const me = useQuery({ ...trpc.me.get.queryOptions(), enabled: auth.status === 'signedIn' });
  const units: UnitSystem = me.data?.units ?? 'metric';

  const mapRef = useRef<ExploreMapHandle | null>(null);

  // ── What the map has told us ──────────────────────────────────────────────────────
  const [trails, setTrails] = useState<readonly TrailSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [coverage, setCoverage] = useState<TileCoverage | null>(null);
  const [area, setArea] = useState<AreaSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [viewBbox, setViewBbox] = useState<BBox | null>(null);

  // ── What this screen decides ──────────────────────────────────────────────────────
  const [searching, setSearching] = useState(false);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [basemap, setBasemap] = useState<BasemapId>('relief');
  const [hillshade, setHillshade] = useState(true);
  const [layersOpen, setLayersOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const active = activeCount(filters);

  /**
   * A trail chosen from search, waiting for the map to arrive over it.
   *
   * Selection is by id against what the map is currently holding, so selecting a trail the
   * camera has not reached yet would find nothing. The frame is sent first and the id parked
   * here until it turns up in a `results` message.
   */
  const pending = useRef<string | null>(null);
  const nonce = useRef(0);

  /**
   * Where the sheet rests, as `translateY` from fully open.
   *
   * The sheet is one view of fixed height moved with a transform, never a view whose height is
   * animated: `translateY` runs on the native driver, and a list re-laying itself out sixty
   * times a second does not.
   */
  const snaps = useMemo(() => {
    const height = Math.round(screenH * 0.86);
    return { full: 0, half: Math.round(screenH * 0.46), peek: height - PEEK, height };
  }, [screenH]);
  const snapsRef = useRef(snaps);
  snapsRef.current = snaps;

  const y = useRef(new Animated.Value(0)).current;
  const snap = useRef<Snap>('peek');
  const chromeTop = useRef(0);

  // The sheet's first resting place, set before the first paint rather than in an effect so
  // it never appears fully open for one frame and then jumps down.
  const placed = useRef(false);
  if (!placed.current) {
    placed.current = true;
    y.setValue(snaps.peek);
  }

  const selected = useMemo(
    () => trails.find((trail) => trail.id === selectedId) ?? null,
    [trails, selectedId],
  );

  /** How much map the chrome is covering, in points — which are CSS pixels inside the page. */
  const tellPadding = useCallback((bottom: number) => {
    mapRef.current?.send({ type: 'padding', top: chromeTop.current, bottom });
  }, []);

  const slideTo = useCallback(
    (value: number) => {
      Animated.spring(y, {
        toValue: value,
        useNativeDriver: true,
        stiffness: 240,
        damping: 26,
        mass: 0.9,
      }).start();
    },
    [y],
  );

  const settle = useCallback(
    (next: Snap) => {
      snap.current = next;
      slideTo(snapsRef.current[next]);
      tellPadding(snapsRef.current.height - snapsRef.current[next]);
    },
    [slideTo, tellPadding],
  );

  // ── The sheet is dragged by its grabber, and only by its grabber ───────────────────
  //
  // Not by the list. Arbitrating "this drag scrolls the rows" against "this drag moves the
  // sheet" needs cross-recogniser plumbing, and getting it wrong costs a list that will not
  // scroll — the failure everyone has met in a map app. A grabber is a smaller target, but it
  // always does exactly one thing.
  const drag = useRef({ from: 0 });
  const release = useRef((_dy: number, _vy: number) => {
    /* replaced below on every render, so it always sees the current `settle` */
  });

  release.current = (dy, vy) => {
    const { full, half, peek } = snapsRef.current;
    const landed = clamp(drag.current.from + dy, full, peek) + vy * FLING;
    const options: readonly (readonly [Snap, number])[] = [
      ['full', full],
      ['half', half],
      ['peek', peek],
    ];
    let best: Snap = 'peek';
    let bestGap = Number.POSITIVE_INFINITY;
    for (const [name, at] of options) {
      const gap = Math.abs(at - landed);
      if (gap < bestGap) {
        bestGap = gap;
        best = name;
      }
    }
    settle(best);
  };

  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_event, gesture) => Math.abs(gesture.dy) > 3,
        onPanResponderGrant: () => {
          y.stopAnimation();
          drag.current.from = snapsRef.current[snap.current];
        },
        onPanResponderMove: (_event, gesture) => {
          const { full, peek } = snapsRef.current;
          y.setValue(clamp(drag.current.from + gesture.dy, full, peek));
        },
        onPanResponderRelease: (_event, gesture) => release.current(gesture.dy, gesture.vy),
        onPanResponderTerminate: (_event, gesture) => release.current(gesture.dy, gesture.vy),
      }),
    [y],
  );

  // ── Selection ─────────────────────────────────────────────────────────────────────
  const select = useCallback(
    (trailId: string | null, fromMap: boolean) => {
      setSelectedId(trailId);
      // A selection the map made is already drawn there; echoing it back would be a second
      // render of the same decision.
      if (!fromMap) mapRef.current?.send({ type: 'select', trailId });
      if (trailId !== null) {
        void Haptics.selectionAsync();
        slideTo(snapsRef.current.height - CARD);
        tellPadding(CARD);
      } else {
        settle(snap.current);
      }
    },
    [settle, slideTo, tellPadding],
  );

  const onMapMessage = useCallback(
    (message: MapOut) => {
      switch (message.type) {
        case 'ready':
          setMapError(null);
          tellPadding(snapsRef.current.height - snapsRef.current[snap.current]);
          return;
        case 'viewport':
          setViewBbox(message.bbox);
          return;
        case 'results': {
          setTrails(message.trails);
          setTotal(message.total);
          setCoverage(message.coverage);
          setArea(message.area);
          const waiting = pending.current;
          if (waiting !== null && message.trails.some((trail) => trail.id === waiting)) {
            pending.current = null;
            select(waiting, false);
          }
          return;
        }
        case 'loading':
          setLoading(message.loading);
          return;
        case 'select':
          select(message.trailId, true);
          return;
        case 'error':
          setMapError(message.message);
          return;
      }
    },
    [select, tellPadding],
  );

  // ── Open where the user already is, if they have already said yes ──────────────────
  //
  // Checked rather than requested. A permission dialog on the first frame of the first launch
  // asks for something before the app has shown what it is for. If the recorder has already
  // been granted it, the last known fix is free and the map opens on home instead of on Wales.
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const permission = await Location.getForegroundPermissionsAsync();
        if (!permission.granted || !live) return;
        const fix = await Location.getLastKnownPositionAsync();
        if (!fix || !live) return;
        nonce.current += 1;
        mapRef.current?.send({
          type: 'frame',
          bbox: boxAround(fix.coords.longitude, fix.coords.latitude, 0.09),
          nonce: nonce.current,
        });
      } catch {
        // No permission, no fix, no map move. None of that is worth an error message.
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  /**
   * The filters, handed to the map to fetch with.
   *
   * The map owns the viewport and the query; this screen owns the controls, so the facets have
   * to cross the bridge rather than be applied to `trails` after they arrive. Filtering the
   * array here would leave the *lines on the map* unfiltered, and a list that disagrees with
   * the ground it is drawn over is worse than no filter at all.
   */
  const query = useMemo(() => toQuery(filters, units), [filters, units]);
  const sentQuery = useRef<string | null>(null);

  useEffect(() => {
    // Compared as the encoding rather than the object: unset facets vanish in `JSON.stringify`,
    // so this asks "would the message change" rather than "did React rebuild it". Resolving the
    // reader's units rebuilds `query` without touching a single control, and that must not cost
    // a fetch of the same ground.
    const encoded = JSON.stringify(query);
    if (sentQuery.current === encoded) return;
    const opening = sentQuery.current === null;
    sentQuery.current = encoded;
    // The map already opens on the default query of its own accord.
    if (opening) return;
    nonce.current += 1;
    mapRef.current?.send({ type: 'query', query, nonce: nonce.current });
  }, [query]);

  useEffect(() => {
    mapRef.current?.send({ type: 'basemap', basemap, hillshade });
  }, [basemap, hillshade]);

  const locate = useCallback(async () => {
    setNotice(null);
    const existing = await Location.getForegroundPermissionsAsync();
    const granted = existing.granted
      ? true
      : existing.canAskAgain
        ? (await Location.requestForegroundPermissionsAsync()).granted
        : false;
    if (!granted) {
      setNotice('Location is off for Switchback. Turn it on in Settings to see where you are.');
      return;
    }
    try {
      const fix = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      mapRef.current?.send({
        type: 'locate',
        position: [fix.coords.longitude, fix.coords.latitude],
        accuracyM: fix.coords.accuracy,
        follow: true,
      });
    } catch {
      setNotice('No position yet. Under trees or indoors this can take a minute.');
    }
  }, []);

  const goTo = useCallback((bbox: BBox, trailId: string | null) => {
    setSearching(false);
    pending.current = trailId;
    nonce.current += 1;
    mapRef.current?.send({ type: 'frame', bbox, nonce: nonce.current });
  }, []);

  /*
   * The rail rides the sheet's top edge. Visible sheet height is `height - y`, so an offset of
   * `y - height` puts the rail exactly one gap above it at every position — and clamping the
   * lift at the half snap means opening the sheet fully slides the rail behind it rather than
   * driving it up into the search field.
   */
  const railLift = snaps.height - snaps.half;
  const railY = y.interpolate({
    inputRange: [snaps.full, snaps.half, snaps.peek],
    outputRange: [-railLift, -railLift, -PEEK],
    extrapolate: 'clamp',
  });

  return (
    <View style={styles.screen}>
      <ExploreMap
        ref={mapRef}
        initialCenter={INITIAL_CENTER}
        initialZoom={INITIAL_ZOOM}
        units={units}
        onMessage={onMapMessage}
      />

      {/* ── The field, floating over the map ────────────────────────────────────── */}
      <View
        style={[styles.top, { paddingTop: insets.top + theme.space.sm }]}
        pointerEvents="box-none"
        onLayout={(event) => {
          chromeTop.current = event.nativeEvent.layout.height;
        }}
      >
        <View style={styles.field}>
          <Pressable
            onPress={() => setSearching(true)}
            accessibilityRole="search"
            accessibilityLabel="Search trails and places"
            style={({ pressed }) => [styles.searchBar, pressed ? styles.searchBarPressed : null]}
          >
            <Text style={styles.searchGlyph}>⌕</Text>
            <Text style={styles.searchHint} numberOfLines={1}>
              Search trails and places
            </Text>
          </Pressable>

          {/*
           * Beside the field, not inside the sheet. A filter narrows the map as much as the
           * list, and at the peek snap the sheet is one line of type — so a control kept down
           * there would be out of reach exactly when somebody is reading the ground.
           */}
          <Pressable
            onPress={() => setFiltersOpen(true)}
            accessibilityRole="button"
            accessibilityLabel={active === 0 ? 'Filters' : `Filters, ${active} set`}
            accessibilityState={{ selected: active > 0 }}
            style={({ pressed }) => [
              styles.filterButton,
              active > 0 ? styles.filterButtonOn : null,
              pressed ? styles.filterButtonPressed : null,
            ]}
          >
            <Mark
              shape="sliders"
              size={17}
              color={active > 0 ? theme.color.canvas : theme.color.ink}
            />
            {active > 0 ? <Text style={styles.filterCount}>{active}</Text> : null}
          </Pressable>
        </View>
        {notice === null ? null : (
          // The banner is the message and the dismiss both. It carries no height rung on
          // purpose — full-bleed and two lines of caption, it is already far past the touch
          // rung by area — but it does have to say what it is, or VoiceOver reads the notice
          // text and gives no hint that touching it does anything.
          <Pressable
            onPress={() => setNotice(null)}
            accessibilityRole="button"
            accessibilityLabel={`Dismiss: ${notice}`}
            style={styles.notice}
          >
            <Text style={styles.noticeText}>{notice}</Text>
          </Pressable>
        )}
      </View>

      {/* ── The rail ─────────────────────────────────────────────────────────────── */}
      <Animated.View
        style={[styles.rail, { transform: [{ translateY: railY }] }]}
        pointerEvents="box-none"
      >
        {layersOpen ? (
          <View style={styles.layers}>
            {BASEMAPS.map((base) => (
              <Pressable
                key={base.id}
                onPress={() => {
                  setBasemap(base.id);
                  setLayersOpen(false);
                }}
                accessibilityRole="button"
                accessibilityState={{ selected: basemap === base.id }}
                style={styles.layerRow}
              >
                <Text style={[styles.layerLabel, basemap === base.id ? styles.layerOn : null]}>
                  {base.label}
                </Text>
              </Pressable>
            ))}
            <View style={styles.layerRule} />
            <Pressable
              onPress={() => setHillshade((on) => !on)}
              accessibilityRole="switch"
              accessibilityState={{ checked: hillshade }}
              style={styles.layerRow}
            >
              <Text style={[styles.layerLabel, hillshade ? styles.layerOn : null]}>
                Hillshade {hillshade ? 'on' : 'off'}
              </Text>
            </Pressable>
          </View>
        ) : null}
        <RailButton
          shape="layers"
          label="Map layers"
          active={layersOpen}
          onPress={() => setLayersOpen((open) => !open)}
        />
        <RailButton shape="crosshair" label="Show my location" onPress={() => void locate()} />
      </Animated.View>

      {/* ── The sheet ────────────────────────────────────────────────────────────── */}
      <Animated.View
        style={[styles.sheet, { height: snaps.height, transform: [{ translateY: y }] }]}
      >
        {selected === null ? (
          <>
            <View {...pan.panHandlers} style={styles.grabZone}>
              <View style={styles.grabber} />
              <View style={styles.headline}>
                <Text style={styles.count}>
                  {statusLine({ loading, coverage, area, total, filtered: active > 0 })}
                </Text>
                {loading ? <ActivityIndicator size="small" color={theme.color.inkMuted} /> : null}
              </View>
            </View>
            <FlatList
              data={trails}
              keyExtractor={(trail) => trail.id}
              renderItem={({ item }) => (
                <TrailRow trail={item} units={units} onPress={() => select(item.id, false)} />
              )}
              contentContainerStyle={styles.list}
              showsVerticalScrollIndicator={false}
              ListEmptyComponent={
                <Empty
                  error={mapError}
                  loading={loading}
                  coverage={coverage}
                  filtered={active > 0}
                  onClear={() => setFilters(NO_FILTERS)}
                  onRetry={() => mapRef.current?.reload()}
                />
              }
              ListFooterComponent={
                trails.length > 0 ? (
                  /*
                   * The credit is the way to the credits. ODbL asks for attribution to be as
                   * visible as the map it is under, and one line of grey six-point type is
                   * the least an app can do — making it the tap target that opens the full
                   * sources screen costs nothing and is the affordance a reader who noticed
                   * the line was reaching for anyway.
                   */
                  <Pressable
                    onPress={() => router.push('/attribution')}
                    accessibilityRole="button"
                    accessibilityLabel="Sources and licences"
                    style={({ pressed }) => [
                      styles.attribution,
                      pressed ? styles.attributionPressed : null,
                    ]}
                  >
                    <Text style={styles.attributionText}>
                      Trails from OpenStreetMap contributors, ODbL. Elevation from AWS Terrain
                      Tiles.
                    </Text>
                  </Pressable>
                ) : null
              }
            />
          </>
        ) : (
          <SelectedCard trail={selected} units={units} onClose={() => select(null, false)} />
        )}
      </Animated.View>

      {searching ? (
        <SearchOverlay
          near={viewBbox}
          units={units}
          onClose={() => setSearching(false)}
          onPick={goTo}
        />
      ) : null}

      {filtersOpen ? (
        <FilterPanel
          filters={filters}
          units={units}
          action={panelAction({ loading, coverage, area, total })}
          onChange={setFilters}
          onClose={() => setFiltersOpen(false)}
        />
      ) : null}
    </View>
  );
}

/**
 * The card a selection becomes.
 *
 * Everything on it answers "is this the one" — the shape of the hike, how far, how high, how
 * long, what people made of it — and then one control leaves for the page where the rest of it
 * lives. The whole card is that control, with the words printed as well: a card that is
 * tappable but does not say so is a card most people read and then close.
 */
function SelectedCard({
  trail,
  units,
  onClose,
}: {
  trail: TrailSummary;
  units: UnitSystem;
  onClose: () => void;
}) {
  const plate = theme.color[DIFFICULTY_PLATE[trail.difficulty]];
  const context = [trail.regionName, ROUTE_TYPE_LABEL[trail.routeType]].filter(Boolean).join(' · ');
  const open = () => router.push({ pathname: '/trails/[slug]', params: { slug: trail.slug } });

  return (
    <View style={styles.card}>
      <Pressable
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Clear selection"
        hitSlop={theme.space.md}
        style={styles.cardClose}
      >
        <Mark shape="close" size={14} color={theme.color.inkMuted} />
      </Pressable>

      <Pressable
        onPress={open}
        accessibilityRole="button"
        accessibilityLabel={`Open ${trail.name}`}
        style={({ pressed }) => [styles.cardBody, pressed ? styles.cardPressed : null]}
      >
        <Photograph
          uri={trail.primaryPhotoUrl}
          style={styles.cardPhoto}
          fallback={<View style={[styles.cardPhoto, styles.cardPhotoEmpty]} />}
        />
        <View style={styles.cardText}>
          {context ? (
            <Text style={styles.cardCollar} numberOfLines={1}>
              {context}
            </Text>
          ) : null}
          <Text style={styles.cardName} numberOfLines={2}>
            {trail.name}
          </Text>
          <View style={styles.cardPlate}>
            <View style={[styles.cardStripe, { backgroundColor: plate }]} />
            <Text style={styles.cardDifficulty}>{trail.difficulty}</Text>
            {trail.rating === null ? null : (
              <Text style={styles.cardRating}>
                {trail.rating.toFixed(1)} ★ ({trail.reviewCount})
              </Text>
            )}
          </View>
          <Text style={styles.cardStats} numberOfLines={1}>
            {statsLine(trail, units)}
          </Text>
        </View>
      </Pressable>

      <Pressable
        onPress={open}
        accessibilityRole="button"
        style={({ pressed }) => [styles.cardGo, pressed ? styles.cardGoPressed : null]}
      >
        <Text style={styles.cardGoLabel}>View trail</Text>
      </Pressable>
    </View>
  );
}

/**
 * One trail in the sheet.
 *
 * Tapping selects rather than navigates. On a map screen the row and the line are the same
 * object seen twice, and a row that jumped straight to another page would make the map — the
 * reason this screen exists — something you pass through on the way somewhere else.
 */
function TrailRow({
  trail,
  units,
  onPress,
}: {
  trail: TrailSummary;
  units: UnitSystem;
  onPress: () => void;
}) {
  const plate = theme.color[DIFFICULTY_PLATE[trail.difficulty]];
  const context = [trail.regionName, ROUTE_TYPE_LABEL[trail.routeType]].filter(Boolean).join(' · ');

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${trail.name}, ${trail.difficulty}, ${formatDistance(
        trail.stats.lengthM,
        units,
      )}`}
      style={({ pressed }) => [styles.row, pressed ? styles.rowPressed : null]}
    >
      <View style={[styles.stripe, { backgroundColor: plate }]} />
      <View style={styles.rowBody}>
        {context ? (
          <Text style={styles.rowCollar} numberOfLines={1}>
            {context}
          </Text>
        ) : null}
        <Text style={styles.rowName} numberOfLines={2}>
          {trail.name}
        </Text>
        <Text style={styles.rowStats} numberOfLines={1}>
          {statsLine(trail, units)}
          {trail.rating === null ? '' : `   ${trail.rating.toFixed(1)} ★`}
        </Text>
      </View>
    </Pressable>
  );
}

/**
 * Search, over everything.
 *
 * Two kinds of answer to one field. Places move the camera, and are how you reach ground the
 * app has never loaded — the corpus fills tile by tile on demand, so "Vesper Peak" is a place
 * long before it is ever a trail here. Trails move the camera *and* select, so the result you
 * tapped is the one highlighted when the map lands.
 */
function SearchOverlay({
  near,
  units,
  onClose,
  onPick,
}: {
  near: BBox | null;
  units: UnitSystem;
  onClose: () => void;
  onPick: (bbox: BBox, trailId: string | null) => void;
}) {
  const insets = useSafeAreaInsets();
  const trpc = useTRPC();
  const [text, setText] = useState('');
  const [q, setQ] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => setQ(text.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);

  const enabled = q.length >= 2;

  const places = useQuery({
    ...trpc.places.search.queryOptions({ q, ...(near === null ? {} : { near }), limit: 5 }),
    enabled,
  });
  const trails = useQuery({
    ...trpc.trails.search.queryOptions({ q, sort: 'relevance', limit: 8 }),
    enabled,
  });

  const placeRows = (places.data?.places ?? []).map(asPlaceRow);
  const trailRows = (trails.data?.trails ?? []).map((trail) => asTrailRow(trail, units));
  const rows = [...placeRows, ...trailRows];
  const busy = enabled && (places.isFetching || trails.isFetching);

  return (
    <View style={[styles.overlay, { paddingTop: insets.top + theme.space.sm }]}>
      <View style={styles.overlayBar}>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder="Trail, summit, park, or town"
          placeholderTextColor={theme.color.inkMuted}
          selectionColor={theme.color.inkMuted}
          autoFocus
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
          clearButtonMode="while-editing"
          accessibilityLabel="Search trails and places"
          style={styles.overlayField}
        />
        <Pressable onPress={onClose} accessibilityRole="button" hitSlop={theme.space.sm}>
          <Text style={styles.overlayCancel}>Cancel</Text>
        </Pressable>
      </View>

      <FlatList
        data={rows}
        keyExtractor={(row) => row.key}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={styles.overlayList}
        renderItem={({ item, index }) => (
          <>
            {/* Headings rather than sections: one array means one scroll, and the heading is
                printed wherever the kind changes. */}
            {index === 0 || index === placeRows.length ? (
              <Text style={styles.overlayCollar}>{item.heading}</Text>
            ) : null}
            <Pressable
              onPress={() => onPick(item.bbox, item.trailId)}
              accessibilityRole="button"
              style={({ pressed }) => [styles.overlayRow, pressed ? styles.rowPressed : null]}
            >
              <Text style={styles.overlayName} numberOfLines={1}>
                {item.name}
              </Text>
              {item.context ? (
                <Text style={styles.overlayContext} numberOfLines={1}>
                  {item.context}
                </Text>
              ) : null}
            </Pressable>
          </>
        )}
        ListEmptyComponent={
          <Text style={styles.overlayEmpty}>
            {!enabled
              ? 'Type a trail name, a summit, a park, or a town.'
              : busy
                ? 'Looking…'
                : 'Nothing by that name. Try the nearest town, or the summit it climbs.'}
          </Text>
        }
      />
    </View>
  );
}

/**
 * The filters, over everything.
 *
 * A panel rather than a rail of chips floating over the map. Seven facets do not fit in a
 * horizontal scroller that shows three of them at a time — a control you have to swipe blind
 * to discover is a control most people never learn they have. Given a screen, each facet gets
 * a labelled row, and the whole set is readable at once.
 *
 * **Applied as you tap, not on a Done button.** The map is live behind this panel and re-runs
 * the query with every change, so the count on the footer is a real answer rather than a
 * promise: it is the number of trails that would be listed if the panel were closed now. That
 * is the whole argument for live application — a filter panel that has to be dismissed before
 * it says anything makes you guess, and then makes you come back.
 */
function FilterPanel({
  filters,
  units,
  action,
  onChange,
  onClose,
}: {
  filters: Filters;
  units: UnitSystem;
  /** What closing this panel would show, worded by `panelAction`. */
  action: string;
  onChange: (next: Filters) => void;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const bands = lengthBands(units);
  const active = activeCount(filters);
  const set = (patch: Partial<Filters>) => onChange({ ...filters, ...patch });

  return (
    <View style={[styles.overlay, { paddingTop: insets.top + theme.space.sm }]}>
      <View style={styles.panelHead}>
        <Text style={styles.panelTitle}>Filters</Text>
        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close filters"
          hitSlop={theme.space.md}
          style={styles.panelClose}
        >
          <Mark shape="close" size={16} color={theme.color.inkMuted} />
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={styles.panelBody}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <ChipRail label="Grade" scheme="field">
          {DIFFICULTIES.map((grade) => (
            <Chip
              key={grade}
              scheme="field"
              label={DIFFICULTY_LABELS[grade]}
              selected={filters.difficulty.includes(grade)}
              onPress={() => set({ difficulty: toggle(filters.difficulty, grade) })}
            />
          ))}
        </ChipRail>

        {/* One band at a time. Overlapping bands would let somebody ask for under 5 km and
            over 16 km at once, which the bounds cannot express and nobody meant. */}
        <ChipRail label="Length" scheme="field">
          {bands.map((band, index) => (
            <Chip
              key={band.label}
              scheme="field"
              label={band.label}
              selected={filters.band === index}
              onPress={() => set({ band: filters.band === index ? null : index })}
            />
          ))}
        </ChipRail>

        <ChipRail label="Shape" scheme="field">
          {ROUTE_TYPES.map((shape) => (
            <Chip
              key={shape}
              scheme="field"
              label={ROUTE_TYPE_LABEL[shape]}
              selected={filters.routeType.includes(shape)}
              onPress={() => set({ routeType: toggle(filters.routeType, shape) })}
            />
          ))}
        </ChipRail>

        <ChipRail label="Rated" scheme="field">
          {RATINGS.map((rating) => (
            <Chip
              key={rating}
              scheme="field"
              label={`${rating} ★ and up`}
              selected={filters.minRating === rating}
              onPress={() => set({ minRating: filters.minRating === rating ? null : rating })}
            />
          ))}
        </ChipRail>

        <ChipRail label="Access" scheme="field">
          <Chip
            scheme="field"
            label="Dogs allowed"
            selected={filters.dogsAllowed}
            onPress={() => set({ dogsAllowed: !filters.dogsAllowed })}
          />
          <Chip
            scheme="field"
            label="Step-free"
            selected={filters.wheelchairAccessible}
            onPress={() => set({ wheelchairAccessible: !filters.wheelchairAccessible })}
          />
        </ChipRail>

        {/* All eleven, not the five the recorder offers. Somebody filtering a map for via
            ferrata is looking for the thing that is rare, and a shortlist would hide it. */}
        <ChipRail label="Doing" scheme="field">
          {ACTIVITY_TYPES.map((activity) => (
            <Chip
              key={activity}
              scheme="field"
              label={ACTIVITY_TYPE_LABELS[activity]}
              selected={filters.activityTypes.includes(activity)}
              onPress={() => set({ activityTypes: toggle(filters.activityTypes, activity) })}
            />
          ))}
        </ChipRail>

        <View style={styles.panelRule} />

        {/* Below the rule, and not counted on the button: an order is not a narrowing. */}
        <ChipRail label="Order" scheme="field">
          {SORTS.map((option) => (
            <Chip
              key={option.id}
              scheme="field"
              label={option.label}
              selected={filters.sort === option.id}
              onPress={() => set({ sort: option.id })}
            />
          ))}
        </ChipRail>

        <Text style={styles.panelNote}>
          Filters narrow the map as well as the list. A trail that does not match is not drawn.
        </Text>
      </ScrollView>

      <View style={[styles.panelFoot, { paddingBottom: insets.bottom + theme.space.md }]}>
        {active > 0 ? (
          <Pressable
            onPress={() => onChange(NO_FILTERS)}
            accessibilityRole="button"
            accessibilityLabel={`Clear ${active} filters`}
            style={({ pressed }) => [styles.panelClear, pressed ? styles.panelClearOn : null]}
          >
            <Text style={styles.panelClearLabel}>Clear</Text>
          </Pressable>
        ) : null}
        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          style={({ pressed }) => [styles.panelDone, pressed ? styles.panelDonePressed : null]}
        >
          <Text style={styles.panelDoneLabel}>{action}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function Empty({
  error,
  loading,
  coverage,
  filtered,
  onClear,
  onRetry,
}: {
  error: string | null;
  loading: boolean;
  coverage: TileCoverage | null;
  filtered: boolean;
  onClear: () => void;
  onRetry: () => void;
}) {
  if (error !== null) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyTitle}>The map could not load</Text>
        <Text style={styles.emptyBody}>{error}</Text>
        <Pressable onPress={onRetry} accessibilityRole="button" style={styles.retry}>
          <Text style={styles.retryLabel}>Try again</Text>
        </Pressable>
      </View>
    );
  }
  if (coverage?.tooLarge === true) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyTitle}>Too much ground</Text>
        <Text style={styles.emptyBody}>
          Trails are fetched for the area you are looking at. Zoom in to somewhere the size of a
          national park and they will load.
        </Text>
      </View>
    );
  }
  if (loading || (coverage !== null && coverage.pendingTiles.length > 0)) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyTitle}>Fetching this area</Text>
        <Text style={styles.emptyBody}>
          Nobody has looked here before, so the paths are being read from OpenStreetMap now. They
          appear as each tile lands.
        </Text>
      </View>
    );
  }
  // Checked after the loading and coverage branches: while tiles are still landing, "nothing
  // matches" is a guess, and it is the one people act on by widening filters that were fine.
  if (filtered) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyTitle}>Nothing matches here</Text>
        <Text style={styles.emptyBody}>
          No trail in view passes the filters you have set. Widen them, or move the map.
        </Text>
        <Pressable onPress={onClear} accessibilityRole="button" style={styles.retry}>
          <Text style={styles.retryLabel}>Clear filters</Text>
        </Pressable>
      </View>
    );
  }
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>No trails in view</Text>
      <Text style={styles.emptyBody}>Pan to somewhere with paths on it, or zoom out a little.</Text>
    </View>
  );
}

function RailButton({
  shape,
  label,
  active = false,
  onPress,
}: {
  shape: 'layers' | 'crosshair';
  label: string;
  active?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
      style={({ pressed }) => [
        styles.railButton,
        active ? styles.railButtonOn : null,
        pressed ? styles.railButtonPressed : null,
      ]}
    >
      <Mark shape={shape} size={17} color={active ? theme.color.canvas : theme.color.ink} />
    </Pressable>
  );
}

// ── Plumbing ────────────────────────────────────────────────────────────────────────

interface PickRow {
  key: string;
  heading: string;
  name: string;
  context: string;
  bbox: BBox;
  /** Null for a place: there is nothing to select once the camera arrives. */
  trailId: string | null;
}

function asPlaceRow(place: {
  id: string;
  name: string;
  context: string;
  label: string;
  bbox: BBox;
}): PickRow {
  return {
    key: `place:${place.id}`,
    heading: 'Places',
    name: place.name,
    context: [place.label, place.context].filter(Boolean).join(' · '),
    bbox: place.bbox,
    trailId: null,
  };
}

function asTrailRow(trail: TrailSummary, units: UnitSystem): PickRow {
  return {
    key: `trail:${trail.id}`,
    heading: 'Trails',
    name: trail.name,
    context: [trail.regionName, formatDistance(trail.stats.lengthM, units)]
      .filter(Boolean)
      .join(' · '),
    bbox: trail.bbox,
    trailId: trail.id,
  };
}

/** Distance, gain, time — the three numbers that decide whether a hike fits the afternoon. */
function statsLine(trail: TrailSummary, units: UnitSystem): string {
  return [
    formatDistance(trail.stats.lengthM, units),
    `↑${formatElevation(trail.stats.gainM, units)}`,
    formatDuration(trail.stats.estimatedTimeS),
  ].join('   ');
}

/** A box around a point, wide enough to be a view rather than a pin. */
function boxAround(lng: number, lat: number, half: number): BBox {
  return [lng - half, lat - half, lng + half, lat + half];
}

function statusLine({
  loading,
  coverage,
  area,
  total,
  filtered,
}: {
  loading: boolean;
  coverage: TileCoverage | null;
  area: AreaSummary | null;
  total: number;
  filtered: boolean;
}): string {
  if (coverage?.tooLarge === true) return 'Zoom in to load trails';
  if ((coverage !== null && coverage.pendingTiles.length > 0) || (area?.working ?? 0) > 0) {
    return 'Fetching this area…';
  }
  if (loading && total === 0) return 'Searching…';
  if (total === 0) return filtered ? 'Nothing matches here' : 'No trails in view';
  const trails = `${total.toLocaleString()} ${total === 1 ? 'trail' : 'trails'}`;
  // "match" rather than "in view" when a filter is on, because at the peek snap this line is
  // the whole sheet — and a count that quietly excluded half the ground would be a lie told in
  // the one place there is no room to explain it.
  return filtered ? `${trails} match` : `${trails} in view`;
}

/**
 * What the filter panel's own button says.
 *
 * Separate from `statusLine` because the panel is covering the map: the sentence has to work
 * as the label of a control that dismisses, so it names the outcome ("Show 26 trails") rather
 * than describing a state ("26 trails match").
 */
function panelAction({
  loading,
  coverage,
  area,
  total,
}: {
  loading: boolean;
  coverage: TileCoverage | null;
  area: AreaSummary | null;
  total: number;
}): string {
  if (coverage?.tooLarge === true) return 'Zoom in to load trails';
  if ((coverage !== null && coverage.pendingTiles.length > 0) || (area?.working ?? 0) > 0) {
    return 'Fetching this area…';
  }
  if (loading) return 'Counting…';
  if (total === 0) return 'Nothing matches here';
  return `Show ${total.toLocaleString()} ${total === 1 ? 'trail' : 'trails'}`;
}

interface LengthBand {
  label: string;
  minLengthM?: number;
  maxLengthM?: number;
}

/**
 * Bands, in round numbers of the reader's own units.
 *
 * Not a slider. A slider over a range with no known ceiling — the corpus holds the Pacific
 * Crest Trail — spends most of its travel on distances nobody hikes in a day, and reading a
 * value off one needs both hands. The four bands are the four answers people actually give:
 * an hour, a morning, a day, and more than a day.
 *
 * The imperial bounds are the mile figures converted, not the metric ones relabelled, so a
 * reader who asks for under three miles gets under three miles.
 */
function lengthBands(units: UnitSystem): readonly LengthBand[] {
  return units === 'imperial'
    ? [
        { label: 'Under 3 mi', maxLengthM: 4828 },
        { label: '3–6 mi', minLengthM: 4828, maxLengthM: 9656 },
        { label: '6–10 mi', minLengthM: 9656, maxLengthM: 16093 },
        { label: 'Over 10 mi', minLengthM: 16093 },
      ]
    : [
        { label: 'Under 5 km', maxLengthM: 5000 },
        { label: '5–10 km', minLengthM: 5000, maxLengthM: 10000 },
        { label: '10–16 km', minLengthM: 10000, maxLengthM: 16000 },
        { label: 'Over 16 km', minLengthM: 16000 },
      ];
}

/**
 * How many facets are narrowing the results.
 *
 * The sort is deliberately not counted. Ordering the same trails differently hides nothing,
 * and a badge that read "1" the moment somebody chose "Shortest" would send them hunting for
 * a filter they never set.
 */
function activeCount(filters: Filters): number {
  return (
    filters.difficulty.length +
    filters.routeType.length +
    filters.activityTypes.length +
    (filters.band === null ? 0 : 1) +
    (filters.minRating === null ? 0 : 1) +
    (filters.dogsAllowed ? 1 : 0) +
    (filters.wheelchairAccessible ? 1 : 0)
  );
}

/**
 * Controls to a query.
 *
 * Every unset facet leaves as `undefined` rather than as an empty array or a `false`. An empty
 * `difficulty: []` would be read by the schema as a set of grades that nothing can be in, and
 * `dogsAllowed: false` means "trails that forbid dogs" — the opposite of an unpressed chip.
 */
function toQuery(filters: Filters, units: UnitSystem): MapQuery {
  const band = filters.band === null ? undefined : lengthBands(units)[filters.band];
  return {
    difficulty: filters.difficulty.length > 0 ? [...filters.difficulty] : undefined,
    routeType: filters.routeType.length > 0 ? [...filters.routeType] : undefined,
    activityTypes: filters.activityTypes.length > 0 ? [...filters.activityTypes] : undefined,
    minLengthM: band?.minLengthM,
    maxLengthM: band?.maxLengthM,
    minRating: filters.minRating ?? undefined,
    dogsAllowed: filters.dogsAllowed ? true : undefined,
    wheelchairAccessible: filters.wheelchairAccessible ? true : undefined,
    sort: filters.sort,
  };
}

/** In or out of a set, preserving the order the options are declared in. */
function toggle<T>(list: readonly T[], value: T): readonly T[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

/**
 * Every edge pinned.
 *
 * Spelled out rather than `StyleSheet.absoluteFillObject`, which React Native 0.86 removed —
 * `absoluteFill` survives but is a registered style id, so it cannot be spread into a style
 * that adds anything of its own.
 */
const fill = { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 } as const;

/*
 * There is no shadow here, and that is the whole of it.
 *
 * This screen used to carry one — pure black at 0.32, radius 10, offset down 3, spread into
 * the search bar, the filter button, the rail buttons and the layers panel, with a heavier
 * one under the sheet. It was reasoned about ("a sheet lying on a map, not a card floating
 * above it") and it was still the wrong call, because the product it belongs to has no
 * z-axis at all. The web app states that outright and enforces it: depth is plate colour and
 * hairline rules, so a drop shadow reads as a component from some other product pasted in.
 * The same explore screen on the web floats the same controls over the same map with
 * `rounded-hair border border-bezel bg-surface` and nothing else, and it is legible.
 *
 * Removing it cost nothing, which is the tell that it was never load-bearing: every element
 * that spread it already had `backgroundColor: surface`, a hairline `bezel` border and
 * `radius.panel`. Opacity is what separates a control from the map under it; the shadow was
 * decoration on top of a separation that already worked.
 *
 * It was also off-system twice over — pure black is not in the palette (ink is a very dark
 * green-grey), and those props are iOS-only, so on any other target the design was already
 * the one below. `test/conventions.test.ts` is what keeps it gone, and it reads this file,
 * which is why the properties are described here rather than spelled.
 */
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.color.canvas },

  // ── Top ──
  top: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    paddingHorizontal: theme.space.lg,
    gap: theme.space.sm,
  },
  field: { flexDirection: 'row', alignItems: 'center', gap: theme.space.sm },
  searchBar: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.sm,
    minHeight: CONTROL_HEIGHT.touch,
    paddingHorizontal: theme.space.md,
    backgroundColor: theme.color.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.bezel,
    borderRadius: theme.radius.panel,
  },
  searchBarPressed: { borderColor: theme.color.inkMuted },
  searchGlyph: { ...theme.text('bodyLg'), color: theme.color.inkMuted },
  searchHint: { ...theme.text('body', { family: 'text' }), color: theme.color.inkMuted, flex: 1 },

  // Square when it is only a glyph, and widened by the count when there is one — the badge is
  // set beside the mark rather than floating on its corner, where at that size it would be a dot.
  filterButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.space.xs,
    minWidth: CONTROL_HEIGHT.touch,
    height: CONTROL_HEIGHT.touch,
    paddingHorizontal: theme.space.md,
    backgroundColor: theme.color.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.bezel,
    borderRadius: theme.radius.panel,
  },
  filterButtonOn: { backgroundColor: theme.color.ink, borderColor: theme.color.ink },
  filterButtonPressed: { borderColor: theme.color.inkMuted },
  filterCount: { ...theme.text('caption', { family: 'mono' }), color: theme.color.canvas },
  notice: {
    backgroundColor: theme.color.surface,
    borderLeftWidth: 3,
    borderLeftColor: theme.color.survey,
    padding: theme.space.md,
  },
  noticeText: { ...theme.text('caption', { family: 'text' }), color: theme.color.ink },

  // ── Rail ──
  rail: {
    position: 'absolute',
    right: theme.space.lg,
    bottom: theme.space.md,
    alignItems: 'flex-end',
    gap: theme.space.sm,
  },
  railButton: {
    width: CONTROL_HEIGHT.touch,
    height: CONTROL_HEIGHT.touch,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.color.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.bezel,
    borderRadius: theme.radius.panel,
  },
  railButtonOn: { backgroundColor: theme.color.ink, borderColor: theme.color.ink },
  railButtonPressed: { borderColor: theme.color.inkMuted },

  layers: {
    backgroundColor: theme.color.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.bezel,
    borderRadius: theme.radius.panel,
    paddingVertical: theme.space.xs,
    minWidth: 152,
  },
  layerRow: {
    paddingHorizontal: theme.space.md,
    paddingVertical: theme.space.sm,
    minHeight: CONTROL_HEIGHT.touch,
    justifyContent: 'center',
  },
  layerLabel: { ...theme.collarLabel, color: theme.color.inkMuted },
  layerOn: { color: theme.color.ink },
  layerRule: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: theme.color.bezel,
    marginVertical: theme.space.xs,
  },

  // ── Sheet ──
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: theme.color.canvas,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.color.bezel,
  },
  grabZone: { paddingBottom: theme.space.sm },
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 3,
    marginTop: theme.space.sm,
    marginBottom: theme.space.md,
    backgroundColor: theme.color.bezel,
  },
  headline: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.space.xl,
    minHeight: 20,
  },
  count: { ...theme.collarLabel, color: theme.color.inkMuted },

  list: { paddingTop: theme.space.md, paddingBottom: theme.space['4xl'] },
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

  attribution: {
    paddingHorizontal: theme.space.xl,
    paddingTop: theme.space.xl,
  },
  attributionPressed: { opacity: 0.55 },
  attributionText: {
    ...theme.text('micro', { family: 'text' }),
    color: theme.color.inkMuted,
  },

  empty: {
    paddingHorizontal: theme.space.xl,
    paddingTop: theme.space.lg,
    gap: theme.space.sm,
    alignItems: 'flex-start',
  },
  emptyTitle: { ...theme.text('title', { weight: 'medium' }), color: theme.color.ink },
  emptyBody: { ...theme.text('body', { family: 'text' }), color: theme.color.inkMuted },
  retry: {
    marginTop: theme.space.sm,
    paddingHorizontal: theme.space.lg,
    minHeight: CONTROL_HEIGHT.touch,
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.bezel,
  },
  retryLabel: { ...theme.collarLabel, color: theme.color.ink },

  // ── Card ──
  card: { flex: 1, paddingTop: theme.space.lg },
  cardClose: {
    position: 'absolute',
    top: theme.space.sm,
    right: theme.space.md,
    zIndex: 1,
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardBody: { flexDirection: 'row', gap: theme.space.md, paddingHorizontal: theme.space.xl },
  cardPressed: { opacity: 0.72 },
  cardPhoto: { width: 76, height: 96, backgroundColor: theme.color.surface },
  cardPhotoEmpty: { borderWidth: StyleSheet.hairlineWidth, borderColor: theme.color.bezel },
  cardText: { flex: 1, gap: theme.space.hair, paddingRight: theme.space.lg },
  cardCollar: { ...theme.collarLabel, color: theme.color.inkMuted },
  cardName: { ...theme.text('title', { weight: 'medium' }), color: theme.color.ink },
  cardPlate: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.sm,
    paddingTop: theme.space.xs,
  },
  cardStripe: { width: 14, height: 3 },
  cardDifficulty: { ...theme.collarLabel, color: theme.color.ink },
  cardRating: { ...theme.text('caption', { family: 'mono' }), color: theme.color.inkMuted },
  cardStats: { ...theme.text('caption', { family: 'mono' }), color: theme.color.inkMuted },
  cardGo: {
    marginTop: theme.space.lg,
    marginHorizontal: theme.space.xl,
    minHeight: CONTROL_HEIGHT.touch,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.color.ink,
  },
  cardGoPressed: { backgroundColor: theme.color.inkMuted },
  cardGoLabel: { ...theme.collarLabel, color: theme.color.canvas },

  // ── Search overlay ──
  overlay: { ...fill, backgroundColor: theme.color.canvas },
  overlayBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.md,
    paddingHorizontal: theme.space.xl,
  },
  overlayField: {
    ...theme.text('bodyLg'),
    color: theme.color.ink,
    flex: 1,
    minHeight: CONTROL_HEIGHT.touch,
    paddingVertical: theme.space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.color.bezel,
  },
  overlayCancel: { ...theme.collarLabel, color: theme.color.inkMuted },
  overlayList: { paddingBottom: theme.space['4xl'] },
  overlayCollar: {
    ...theme.collarLabel,
    color: theme.color.inkMuted,
    paddingHorizontal: theme.space.xl,
    paddingTop: theme.space.xl,
    paddingBottom: theme.space.sm,
  },
  overlayRow: {
    paddingHorizontal: theme.space.xl,
    paddingVertical: theme.space.md,
    minHeight: CONTROL_HEIGHT.field,
    justifyContent: 'center',
    gap: theme.space.hair,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.color.bezel,
  },
  overlayName: { ...theme.text('body', { weight: 'medium' }), color: theme.color.ink },
  overlayContext: { ...theme.text('caption', { family: 'text' }), color: theme.color.inkMuted },
  overlayEmpty: {
    ...theme.text('body', { family: 'text' }),
    color: theme.color.inkMuted,
    paddingHorizontal: theme.space.xl,
    paddingTop: theme.space['2xl'],
  },

  // ── Filter panel ──
  panelHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.space.xl,
    paddingBottom: theme.space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.color.bezel,
  },
  panelTitle: { ...theme.text('h4', { weight: 'medium' }), color: theme.color.ink },
  panelClose: {
    width: CONTROL_HEIGHT.touch,
    height: CONTROL_HEIGHT.touch,
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  panelBody: {
    gap: theme.space.lg,
    paddingHorizontal: theme.space.xl,
    paddingTop: theme.space.lg,
    paddingBottom: theme.space['2xl'],
  },
  panelRule: { height: StyleSheet.hairlineWidth, backgroundColor: theme.color.bezel },
  panelNote: { ...theme.text('caption', { family: 'text' }), color: theme.color.inkMuted },

  panelFoot: {
    flexDirection: 'row',
    gap: theme.space.sm,
    paddingHorizontal: theme.space.xl,
    paddingTop: theme.space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.color.bezel,
    backgroundColor: theme.color.canvas,
  },
  // Hairline, not survey. Clearing a filter destroys nothing — the plate that means "your
  // safety" is not spent on a control that puts trails back on the map.
  panelClear: {
    minHeight: CONTROL_HEIGHT.touch,
    justifyContent: 'center',
    paddingHorizontal: theme.space.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.bezel,
  },
  panelClearOn: { borderColor: theme.color.ink },
  panelClearLabel: { ...theme.collarLabel, color: theme.color.ink },
  panelDone: {
    flex: 1,
    minHeight: CONTROL_HEIGHT.touch,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.color.ink,
  },
  panelDonePressed: { backgroundColor: theme.color.inkMuted },
  panelDoneLabel: { ...theme.collarLabel, color: theme.color.canvas },
});
