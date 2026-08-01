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
 * Explore: a draggable sheet of results over the map, in three states — browsing, selected,
 * searching. The map owns its own viewport and `trails.browse` query; this screen is the chrome.
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

/**
 * Snowdon — the first-run floor only, replaced by a last known fix as soon as one is readable.
 * Deliberately not the website's reader-derived centre: a phone's right answer is its own GPS.
 */
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
 * The state of the controls, which is not the shape of a `MapQuery` — an unpressed chip is an
 * absent facet over the bridge, not `[]` or `false`. `toQuery` is where one becomes the other.
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

/** Three stops, not five: "not the bad ones", "the good ones", "the ones people came back for". */
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

  // Pushed up by the map, which owns the viewport and the query.
  const [trails, setTrails] = useState<readonly TrailSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [coverage, setCoverage] = useState<TileCoverage | null>(null);
  const [area, setArea] = useState<AreaSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [viewBbox, setViewBbox] = useState<BBox | null>(null);

  // Owned by this screen.
  const [searching, setSearching] = useState(false);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [basemap, setBasemap] = useState<BasemapId>('relief');
  const [hillshade, setHillshade] = useState(true);
  const [layersOpen, setLayersOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const active = activeCount(filters);

  /**
   * A trail chosen from search, parked until the camera arrives. Selection matches by id
   * against what the map is currently holding, so selecting before the frame lands finds nothing.
   */
  const pending = useRef<string | null>(null);
  const nonce = useRef(0);

  /**
   * Where the sheet rests, as `translateY` from fully open. One view of fixed height moved by
   * transform, never an animated height: `translateY` runs on the native driver, a relayout does not.
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

  // Set before the first paint rather than in an effect, so the sheet never appears fully open
  // for one frame and then jumps down.
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

  // Dragged by the grabber and only by the grabber. Arbitrating "this drag scrolls the rows"
  // against "this drag moves the sheet" needs cross-recogniser plumbing, and getting it wrong
  // costs a list that will not scroll.
  const drag = useRef({ from: 0 });
  const release = useRef((_dy: number, _vy: number) => {
    /* replaced on every render, so it always closes over the current `settle` */
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

  const select = useCallback(
    (trailId: string | null, fromMap: boolean) => {
      setSelectedId(trailId);
      // A selection the map made is already drawn there; echoing it back re-renders the decision.
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

  // Checked, never requested: a permission dialog on the first frame of the first launch asks
  // before the app has shown what it is for. Granted already, the last known fix is free.
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
        // No permission or no fix: the map simply stays where it opened.
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  /**
   * The filters, handed to the map to fetch with. Filtering `trails` here instead would leave
   * the lines on the map unfiltered, and a list that disagrees with its own ground is worse.
   */
  const query = useMemo(() => toQuery(filters, units), [filters, units]);
  const sentQuery = useRef<string | null>(null);

  useEffect(() => {
    // Compared as the encoding, so this asks "would the message change" rather than "did React
    // rebuild it" — resolving the reader's units must not cost a refetch of the same ground.
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

  // The rail rides the sheet's top edge. Clamping the lift at the half snap means opening the
  // sheet fully slides the rail behind it rather than driving it up into the search field.
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

      {/* The field, floating over the map. */}
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
           * Beside the field, not in the sheet: at the peek snap the sheet is one line of type,
           * so a filter control down there is out of reach exactly when the map is being read.
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
          // The banner is the message and the dismiss both, so the label has to say so — without
          // it VoiceOver reads the notice and gives no hint that touching it does anything.
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

      {/* The rail. */}
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

      {/* The sheet. */}
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
                  /* ODbL asks for attribution as visible as the map it is under; making the
                     line the tap target for the full sources screen costs nothing. */
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
 * The card a selection becomes: everything that answers "is this the one", and a way through
 * to the page. The whole card is the control, with the words printed as well.
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
 * One trail in the sheet. Tapping selects rather than navigates: the row and the line on the
 * map are the same object seen twice, so jumping to another page would bypass the map.
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
 * Search over places and trails. Places only move the camera — the corpus fills tile by tile on
 * demand, so a summit is a place long before it is a trail here; trails move the camera and select.
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
 * The filters, over everything. A panel rather than a rail of chips: seven facets do not fit in
 * a horizontal scroller that shows three at a time.
 *
 * Applied as you tap, not on a Done button — the map is live behind the panel, so the count on
 * the footer is the number of trails that would be listed if the panel were closed now.
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

        {/* One band at a time: overlapping bands would ask for under 5 km and over 16 km at
            once, which the bounds cannot express. */}
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

        {/* All eleven, not the five the recorder offers: filtering for via ferrata is looking
            for the thing that is rare, and a shortlist would hide it. */}
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
  // Before the filter and "no trails" branches, both of which describe the ground: the server
  // refused to read this ground, so there is nothing true to say about what is on it.
  if (coverage?.busy === true) {
    const copy = busyCopy(coverage.busyReason);
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyTitle}>{copy.title}</Text>
        <Text style={styles.emptyBody}>{copy.body}</Text>
      </View>
    );
  }
  // After the loading and coverage branches: while tiles are still landing, "nothing matches"
  // is a guess, and it is the one people act on by widening filters that were fine.
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

/**
 * What a refused fetch says. Two reasons, because a deep queue drains on its own and "try again
 * in a few minutes" is a real instruction, while a full database does not and it is not.
 * `status` is the sheet's one-line version, `title`/`body` the empty state's.
 */
function busyCopy(reason: TileCoverage['busyReason']): {
  status: string;
  title: string;
  body: string;
} {
  if (reason === 'storage') {
    return {
      status: 'No room for new ground',
      title: 'No room for new ground',
      body: 'There is nowhere to store trails from ground we have not read yet. Everything already mapped still works.',
    };
  }
  return {
    status: 'Fetching paused',
    title: 'Fetching paused',
    body: 'The queue is full, so this ground has not been read from OpenStreetMap yet. Try again in a few minutes.',
  };
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
  // After the pending branch: the two states coexist, and when something is arriving, saying so
  // is the more useful line. Without this branch a refused cold viewport falls through to "No
  // trails in view" — a claim about ground the server declined to look at.
  if (coverage?.busy === true) return busyCopy(coverage.busyReason).status;
  if (loading && total === 0) return 'Searching…';
  if (total === 0) return filtered ? 'Nothing matches here' : 'No trails in view';
  const trails = `${total.toLocaleString()} ${total === 1 ? 'trail' : 'trails'}`;
  // "match" rather than "in view" when a filter is on: at the peek snap this line is the whole
  // sheet, and a count that quietly excluded half the ground would have no room to explain itself.
  return filtered ? `${trails} match` : `${trails} in view`;
}

/**
 * What the filter panel's own button says. Separate from `statusLine` because it labels a
 * control that dismisses, so it names the outcome ("Show 26 trails"), not the state.
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
  // Same ordering, and the same reason, as `statusLine`.
  if (coverage?.busy === true) return busyCopy(coverage.busyReason).status;
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
 * Bands, in round numbers of the reader's own units: an hour, a morning, a day, more than a day.
 * The imperial bounds are the mile figures converted, not the metric ones relabelled.
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
 * How many facets are narrowing the results. The sort is deliberately not counted — ordering
 * hides nothing, and a badge reading "1" for "Shortest" sends people hunting for a filter.
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
 * Controls to a query. Every unset facet must leave as `undefined`: `difficulty: []` reads as a
 * set nothing can be in, and `dogsAllowed: false` means "trails that forbid dogs".
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
 * Every edge pinned. Spelled out because React Native 0.86 removed `absoluteFillObject`, and
 * `absoluteFill` is a registered style id, so it cannot be spread into a style of its own.
 */
const fill = { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 } as const;

/*
 * There are no shadows in this app, and there must not be: depth is plate colour and hairline
 * rules, so a drop shadow reads as a component from another product. `test/conventions.test.ts`
 * is what keeps it gone, and it reads this file — hence the properties are named, not spelled.
 */
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.color.canvas },

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

  // Square when it is only a glyph, widened by the count when there is one — a badge on the
  // corner would be a dot at this size.
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
