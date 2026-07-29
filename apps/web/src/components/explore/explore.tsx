'use client';

import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useQuery } from '@tanstack/react-query';
import type { BBox } from '@switchback/core';
import { rememberPlace } from '@/lib/place-action';
import { useTRPC } from '@/trpc/react';
import { type BasemapId } from '../map/basemap';
import { LAYER_COLUMN_PX, LayerSwitch } from '../map/layer-switch';
import type { MapFrame } from '../map/trail-map';
import { CoverageNote } from './coverage-note';
import { EMPTY_FACETS, type Facets } from './facets';
import { FetchArea } from './fetch-area';
import { Filters } from './filters';
import { SearchBox } from './search-box';
import { SelectedTrail } from './selected-trail';
import { TrailCard } from './trail-card';
import {
  exploreUrlSearch,
  parseExploreUrl,
  type ExploreUrlState,
  type ExploreView,
} from './url-state';

/**
 * Explore — the map and its index.
 *
 * The layout is a map sheet: the sheet itself, and the **collar** down the left, which on a
 * printed survey sheet is the margin carrying the title block, the legend and the index.
 * That is exactly what this panel holds, in that order, and it is why the filters read as a
 * legend and the results as an index rather than as a sidebar of widgets.
 *
 * The map is loaded client-side only. MapLibre touches `window` at import time, so it
 * cannot be server-rendered, and Next 16 only allows `ssr: false` from a Client Component —
 * which is the reason this orchestrator exists as a client boundary at all.
 */

const TrailMap = dynamic(() => import('../map/trail-map').then((mod) => mod.TrailMap), {
  ssr: false,
  loading: () => <div className="absolute inset-0 bg-canvas" />,
});

/** Snowdon. Where the pipeline has ingested, and a good argument for shaded relief. */
const INITIAL_CENTER: [number, number] = [-4.05, 53.07];
const INITIAL_ZOOM = 11;

/** How long the search box waits after the last keystroke. */
const TYPING_MS = 300;

/**
 * How often to re-ask while tiles are still being fetched.
 *
 * A poll, not the SSE stream the plan sketches. With a cap of twelve tiles per viewport and
 * an Overpass round trip measured in seconds, a stream would carry a handful of messages
 * and cost a long-lived connection per open map, a serverless function held open for its
 * duration, and reconnection handling. This is the same information at a fraction of the
 * machinery; the stream is the upgrade if a viewport ever spans hundreds of tiles.
 */
const POLL_MS = 2_500;

/**
 * The gap between the fetch-area control and the layer switcher's column, plus the inset the
 * switcher itself sits at. Both are `--spacing-lg`, so this is that token doubled — written
 * as a number because it is arithmetic against a px width, and a class cannot do arithmetic.
 */
const LAYER_COLUMN_CLEARANCE_PX = 32;

/**
 * How long the URL waits behind the map.
 *
 * Longer than the map's own idle event, on purpose. A drag fires `moveend` once, but a
 * flick-and-correct fires it three times in a second, and each one would otherwise be a
 * `replaceState`. Browsers throttle that call — Safari has historically thrown after about
 * a hundred in thirty seconds — so the debounce is a correctness guard as much as a
 * politeness one.
 */
const URL_WRITE_MS = 500;

/**
 * How long an air-quality grid stays fresh on the client.
 *
 * The model publishes hourly and the server buckets its cache key to the hour, so half an
 * hour is comfortably inside the life of a reading and stops a pan-and-return from asking
 * again for a number that cannot have changed.
 */
const AIR_QUALITY_STALE_MS = 30 * 60 * 1_000;

/**
 * How long a heatmap grid stays fresh on the client.
 *
 * Longer than air quality, because the thing it measures moves slower than weather does:
 * an aggregate over every recorded hike changes when someone finishes a hike, and one more
 * track in a cell that already holds forty does not move it across a band. Five minutes is
 * short enough that a hiker who just synced sees their own contribution on a reload.
 */
const HEATMAP_STALE_MS = 5 * 60 * 1_000;

export function Explore({ viewerId }: { viewerId: string | null }) {
  const trpc = useTRPC();

  const [bbox, setBbox] = useState<BBox | null>(null);
  const [view, setView] = useState<ExploreView | null>(null);
  const [facets, setFacets] = useState<Facets>(EMPTY_FACETS);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [basemap, setBasemap] = useState<BasemapId>('relief');
  const [hillshade, setHillshade] = useState(true);
  const [slope, setSlope] = useState(false);
  const [airQuality, setAirQuality] = useState(false);
  const [heatmap, setHeatmap] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [frame, setFrame] = useState<MapFrame | null>(null);

  /**
   * The URL, read once, after hydration.
   *
   * Not during render. The server has no `window` and would render the default viewport,
   * so reading the query string inline would make the first client render disagree with the
   * markup it is hydrating — React's own definition of a hydration error. An effect runs
   * after that reconciliation, which costs one tick and is invisible here because the map
   * is `ssr: false` and does not exist until this resolves anyway.
   *
   * `null` therefore means "not read yet", and the map waits for it. That wait is what
   * makes a shared link land on the right mountain instead of flying there from Snowdon.
   */
  const [initial, setInitial] = useState<ExploreUrlState | null>(null);
  useEffect(() => {
    const state = parseExploreUrl(window.location.search);
    setFacets(state.facets);
    setQuery(state.query);
    setDebouncedQuery(state.query);
    setSelectedId(state.trailId);
    setInitial(state);
  }, []);

  /**
   * And written back, debounced, without touching the router.
   *
   * `history.replaceState` rather than `router.replace`: the App Router treats a replace as
   * navigation, re-runs the server component, and re-renders the tree — for a pan. The
   * existing `history.state` is passed through untouched because Next keeps its own routing
   * state in there, and dropping it breaks the back button for every earlier entry.
   */
  useEffect(() => {
    if (!initial) return;

    const search = exploreUrlSearch({
      view,
      query: debouncedQuery,
      trailId: selectedId,
      facets,
    });
    const timer = setTimeout(() => {
      const { pathname, hash } = window.location;
      window.history.replaceState(
        window.history.state,
        '',
        `${pathname}${search ? `?${search}` : ''}${hash}`,
      );
    }, URL_WRITE_MS);

    return () => clearTimeout(timer);
  }, [initial, view, debouncedQuery, selectedId, facets]);

  const typing = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onQueryChange = useCallback((value: string) => {
    setQuery(value);
    clearTimeout(typing.current);
    typing.current = setTimeout(() => setDebouncedQuery(value.trim()), TYPING_MS);
  }, []);

  /**
   * Send the map to a geocoded place.
   *
   * The typed text is deliberately *not* also applied as a trail filter. Someone who picks
   * "Vesper Peak" from the list has said where, not what — and the trails around a summit
   * are mostly not named after it, so filtering by the same string would land the map on
   * the right mountain and then show an empty index beside it. Moving the map is the whole
   * of what was asked for; the tiles under it are fetched by the viewport, as always.
   *
   * It is also the strongest statement of where somebody is interested in that we ever get,
   * so it is written to the place cookie and becomes the front page's "near you" on the next
   * visit. Named, unlike a GPS fix — this is the one source that arrives with a place name
   * attached, which is why the front page can say "Hikes near Snowdonia" without ever
   * reverse-geocoding anything.
   */
  const onPlaceSelect = useCallback(
    (place: { bbox: BBox; name: string; lng: number; lat: number }) => {
      setDebouncedQuery('');
      setSelectedId(null);
      setFrame((previous) => ({ bbox: place.bbox, nonce: (previous?.nonce ?? 0) + 1 }));

      void rememberPlace({
        lng: place.lng,
        lat: place.lat,
        source: 'search',
        name: place.name,
      }).catch(() => {
        // Remembering is a courtesy to the next visit. The search itself has already
        // worked, the map is already moving, and nothing on this screen should stop
        // because a cookie did not get written.
      });
    },
    [],
  );

  const onViewportChange = useCallback((next: BBox, zoom: number) => {
    setBbox(round(next));
    // The centre of the box, not the map's own `getCenter`. Same number for an unrotated
    // north-up map, and it keeps this callback's contract to two arguments.
    setView({ center: [(next[0] + next[2]) / 2, (next[1] + next[3]) / 2], zoom });
  }, []);

  const input = useMemo(
    () => ({
      bbox: bbox ?? ([0, 0, 0, 0] as BBox),
      q: debouncedQuery || undefined,
      difficulty: facets.difficulty.length ? facets.difficulty : undefined,
      routeType: facets.routeType.length ? facets.routeType : undefined,
      activityTypes: facets.activityTypes.length ? facets.activityTypes : undefined,
      minLengthM: facets.minLengthM,
      maxLengthM: facets.maxLengthM,
      minGainM: facets.minGainM,
      maxGainM: facets.maxGainM,
      dogsAllowed: facets.dogsAllowed,
      wheelchairAccessible: facets.wheelchairAccessible,
      sort: facets.sort,
    }),
    [bbox, debouncedQuery, facets],
  );

  const browse = useQuery(
    trpc.trails.browse.queryOptions(input, {
      enabled: bbox !== null,
      // Keep the previous viewport's trails on screen while the next one loads, so a pan
      // does not blank the map and then repaint it.
      placeholderData: (previous) => previous,
      /*
       * Poll while anything upstream is still moving.
       *
       * Two conditions, not one. `pendingTiles` is the automatic path: tiles under a normal
       * viewport that are being fetched right now. `area.working` is the deliberate one, and
       * it has to be read separately because a wide viewport is `tooLarge` — which means
       * `ensureCoverage` queued nothing and `pendingTiles` is empty by construction, however
       * much work the user just kicked off with the button. Keying the poll on tiles alone
       * would leave a fetch running invisibly and the map stubbornly unchanged until
       * something else happened to refetch.
       */
      refetchInterval: (active) => {
        const data = active.state.data;
        if (!data) return false;
        const moving = data.coverage.pendingTiles.length > 0 || (data.area?.working ?? 0) > 0;
        return moving ? POLL_MS : false;
      },
    }),
  );

  /**
   * The air over the current viewport, asked for only while the overlay is on.
   *
   * Deliberately keyed on the same rounded `bbox` the trail browse uses, so a pan that hits
   * the trail cache hits this one too and the two never disagree about what "this view"
   * means. `placeholderData` keeps the previous grid painted through the next fetch — the
   * alternative is a wash that blinks out on every drag, which reads as a failure rather
   * than as loading.
   *
   * No polling. The model publishes hourly, and the cache key on the server is bucketed to
   * the hour, so asking more often than the reader moves the map would return the identical
   * object.
   */
  const airQualityQuery = useQuery(
    trpc.weather.airQualityGrid.queryOptions(
      { bbox: bbox ?? ([0, 0, 0, 0] as BBox) },
      {
        enabled: airQuality && bbox !== null,
        placeholderData: (previous) => previous,
        staleTime: AIR_QUALITY_STALE_MS,
        // One bad hour upstream should dim the overlay, not retry a scalar field four times
        // while the reader is trying to pan.
        retry: 1,
      },
    ),
  );

  /**
   * Where people have recorded hiking, asked for only while the overlay is on.
   *
   * The zoom is rounded before it goes in, and that is the whole cache design. The server
   * turns a zoom into a lattice with `Math.round(zoom) + 5`, so every fractional zoom inside
   * a level produces byte-identical cells; sending the raw float would give each of them its
   * own query key and refetch an identical grid on every scroll-wheel notch. Rounding here
   * means one request per lattice, which is one request per visible change.
   */
  const heatmapQuery = useQuery(
    trpc.activities.heatmap.queryOptions(
      { bbox: bbox ?? ([0, 0, 0, 0] as BBox), zoom: Math.round(view?.zoom ?? INITIAL_ZOOM) },
      {
        enabled: heatmap && bbox !== null,
        placeholderData: (previous) => previous,
        staleTime: HEATMAP_STALE_MS,
        retry: 1,
      },
    ),
  );

  // Memoised because the scroll-sync effect below depends on it, and `?? []` is a fresh
  // array on every render — which would re-run that effect forever.
  const trails = useMemo(() => browse.data?.trails ?? [], [browse.data]);
  const total = browse.data?.total ?? 0;
  const selected = trails.find((trail) => trail.id === selectedId) ?? null;

  /**
   * Selecting on the sheet scrolls the index to match.
   *
   * Nearest-edge alignment, computed by hand against the list's own box, and the "by hand"
   * is the point. `scrollIntoView` does the same arithmetic and then applies it to *every*
   * scrolling box between the element and the viewport — which is what the specification
   * says it must do. One of those ancestors is the page shell, `overflow-hidden` on
   * `app/explore/page.tsx`. Hidden is still a scrolling box: it can be scrolled
   * programmatically, it just has no scrollbar to scroll it back. So picking a trail off
   * the map shunted the whole page up by however far the filter rail overflowed, left the
   * header and the filters displaced with no way to undo it, and exposed a strip of the
   * results list where the map should have been.
   *
   * Scrolling only `list` cannot do that to anything above it. Smooth unless the reader has
   * asked for less motion — a list that jumps is survivable; a list that slides when you
   * have said not to is not.
   */
  const listRef = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const list = listRef.current;
    if (!selectedId || !list) return;
    const entry = list.querySelector(`[data-trail-id="${CSS.escape(selectedId)}"]`);
    if (!entry) return;

    const box = entry.getBoundingClientRect();
    const view = list.getBoundingClientRect();
    // Zero when the entry is already fully in view, which is the common case: the reader
    // clicked it in this list.
    const delta =
      box.top < view.top
        ? box.top - view.top
        : box.bottom > view.bottom
          ? box.bottom - view.bottom
          : 0;
    if (delta === 0) return;

    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    list.scrollBy({ top: delta, behavior: still ? 'auto' : 'smooth' });
  }, [selectedId, trails]);

  /**
   * How much of the bottom of the sheet the pick card is standing on.
   *
   * MapLibre's own chrome lives in the corners of the map: the scale bar bottom-left, the
   * zoom control and the ODbL attribution bottom-right. The pick card is bottom-left too,
   * and it was landing straight on top of the scale bar — and on a narrow sheet, where it
   * runs the full width, on the attribution as well. Attribution is a licence condition,
   * not a nicety, so "roughly clear of it" is not good enough.
   *
   * Measured rather than guessed. The card's height is whatever its trail's name wraps to,
   * so any constant here is a constant that is wrong for some trail — and a constant would
   * also have to restate `bottom-xl` below, in a second place that has to be kept in step.
   * One subtraction against the map's own box answers the whole question: the distance from
   * the bottom of the sheet to the top of the card is exactly the room the chrome needs to
   * step out of. Zero when nothing is picked, which is the state the CSS reads as "stay put".
   */
  const sheetRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [cardLift, setCardLift] = useState(0);
  const picked = selected !== null;

  useEffect(() => {
    const sheet = sheetRef.current;
    const card = cardRef.current;
    if (!sheet || !card) {
      setCardLift(0);
      return;
    }

    const measure = () => {
      const room = sheet.getBoundingClientRect().bottom - card.getBoundingClientRect().top;
      setCardLift(Math.max(0, Math.round(room)));
    };

    // The card is bottom-anchored, so it moving with the sheet changes nothing — only its
    // own height does, and that is what this watches.
    const observer = new ResizeObserver(measure);
    observer.observe(card);
    return () => observer.disconnect();
  }, [picked]);

  return (
    <div className="grid min-h-0 flex-1 grid-rows-[45dvh_1fr] md:grid-cols-[minmax(340px,26rem)_1fr] md:grid-rows-1">
      {/* The sheet. First in the DOM on mobile, where the map is the point of arrival. */}
      <div
        ref={sheetRef}
        /*
         * `--sb-card-lift` is the room the pick card is taking at the bottom of the sheet,
         * measured above. MapLibre's corner containers are absolutely positioned against
         * `bottom: 0`, so a bottom margin walks them up by exactly that much.
         *
         * Bottom-left always, because the card is anchored there at every width. Bottom-right
         * only below `md`, where the card runs the full width and would otherwise sit on the
         * attribution; from `md` up the card stops at 26rem and that corner is already clear,
         * so lifting the zoom control there would be motion with no cause.
         */
        style={{ '--sb-card-lift': `${cardLift}px` } as CSSProperties}
        className="relative order-first [&_.maplibregl-ctrl-bottom-left]:mb-[var(--sb-card-lift)] max-md:[&_.maplibregl-ctrl-bottom-right]:mb-[var(--sb-card-lift)] md:order-last"
      >
        {initial ? (
          <TrailMap
            trails={trails}
            onViewportChange={onViewportChange}
            selectedId={selectedId}
            onSelect={setSelectedId}
            hoveredId={hoveredId}
            onHover={setHoveredId}
            basemap={basemap}
            hillshade={hillshade}
            slope={slope}
            airQuality={airQualityQuery.data ?? null}
            heatmap={heatmapQuery.data ?? null}
            initialCenter={initial.view?.center ?? INITIAL_CENTER}
            initialZoom={initial.view?.zoom ?? INITIAL_ZOOM}
            frame={frame}
          />
        ) : (
          <div className="absolute inset-0 bg-canvas" />
        )}
        <div className="pointer-events-none absolute right-lg top-lg flex justify-end">
          <div className="pointer-events-auto">
            <LayerSwitch
              basemap={basemap}
              onBasemapChange={setBasemap}
              hillshade={hillshade}
              onHillshadeChange={setHillshade}
              slope={slope}
              onSlopeChange={setSlope}
              airQuality={airQuality}
              onAirQualityChange={setAirQuality}
              airQualityGrid={airQualityQuery.data ?? null}
              heatmap={heatmap}
              onHeatmapChange={setHeatmap}
              heatmapGrid={heatmapQuery.data ?? null}
              zoom={view?.zoom}
            />
          </div>
        </div>

        {/*
          Top-centre, which is where a map user's eye goes for "act on this view" and where
          every mapping product puts the equivalent control. Its right edge stops short of the
          layer switcher's column — one gutter for the switcher's own inset, one for the gap
          between them — so the two never collide on a narrow sheet. The width comes from the
          switcher rather than from a rem figure copied across; see `LAYER_COLUMN_PX`.
        */}
        <div
          style={{ right: LAYER_COLUMN_PX + LAYER_COLUMN_CLEARANCE_PX }}
          className="pointer-events-none absolute left-lg top-lg flex justify-center"
        >
          <FetchArea
            area={browse.data?.area}
            bbox={bbox}
            onRequested={() => void browse.refetch()}
          />
        </div>

        {selected ? (
          // Bottom-left, clear of the layer switcher at top-right. It stands on MapLibre's
          // own bottom chrome, which steps up out of its way — see `--sb-card-lift` above.
          // The attribution in particular is an ODbL condition, not a nicety.
          <div
            ref={cardRef}
            className="pointer-events-none absolute bottom-xl left-lg right-lg flex md:right-auto"
          >
            <SelectedTrail trail={selected} onDismiss={() => setSelectedId(null)} />
          </div>
        ) : null}
      </div>

      {/* The collar. */}
      <div className="flex min-h-0 flex-col border-bezel md:border-r">
        <div className="flex shrink-0 flex-col gap-md border-b border-bezel p-lg">
          <SearchBox
            value={query}
            onChange={onQueryChange}
            near={bbox}
            onPlaceSelect={onPlaceSelect}
          />
          <CoverageNote
            coverage={browse.data?.coverage}
            area={browse.data?.area}
            loading={browse.isLoading || bbox === null}
            shown={trails.length}
            total={total}
          />
        </div>

        {/* Two flex items, not one: a bar that never shrinks and a panel that does. */}
        <Filters facets={facets} onChange={setFacets} />

        <ol
          ref={listRef}
          // `overflow-x-clip` rather than nothing: when one axis is not `visible`, CSS
          // computes the other from `visible` to `auto`, so `overflow-y-auto` alone was
          // quietly asking for a horizontal scrollbar — the one across the bottom of the
          // filters. `clip` refuses the axis outright instead of hiding a scroller on it.
          className="flex min-h-0 flex-1 flex-col gap-sm overflow-y-auto overflow-x-clip p-lg"
        >
          {trails.map((trail) => (
            <TrailCard
              key={trail.id}
              trail={trail}
              selected={trail.id === selectedId}
              hovered={trail.id === hoveredId}
              viewerId={viewerId}
              onHover={setHoveredId}
              onSelect={setSelectedId}
            />
          ))}
        </ol>
      </div>
    </div>
  );
}

/**
 * Round the viewport to ~100 m before it becomes a cache key.
 *
 * A drag ends on an arbitrary float, so unrounded boxes mean every pan is a cache miss and
 * a pan back is a second one. At three decimals a returning viewport hits the cache it
 * filled a moment ago, and the map is not meaningfully less accurate — 100 m is a third of
 * a pixel at the zoom where this matters.
 */
function round(bbox: BBox): BBox {
  return bbox.map((value) => Math.round(value * 1000) / 1000) as unknown as BBox;
}
