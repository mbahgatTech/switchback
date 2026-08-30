'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useQuery } from '@tanstack/react-query';
import type { BBox } from '@switchback/core';
import { rememberPlace } from '@/lib/place-action';
import { useTRPC } from '@/trpc/react';
import { type BasemapId } from '../map/basemap';
import { browsePollInterval } from '../map/browse-poll';
import { LAYER_COLUMN_PX, LayerSwitch } from '../map/layer-switch';
import type { MapFrame } from '../map/trail-map';
import { CoverageNote } from './coverage-note';
import { EMPTY_FACETS, type Facets } from './facets';
import { FetchArea } from './fetch-area';
import { Filters } from './filters';
import { PickCard } from './pick-card';
import { SearchBox } from './search-box';
import { TrailCard } from './trail-card';
import {
  exploreUrlSearch,
  parseExploreUrl,
  type ExploreUrlState,
  type ExploreView,
} from './url-state';

/**
 * Explore — the map sheet, and down the left the collar carrying search, legend and index.
 */

/** MapLibre touches `window` at import time, so the map can only be loaded client-side. */
const TrailMap = dynamic(() => import('../map/trail-map').then((mod) => mod.TrailMap), {
  ssr: false,
  loading: () => <div className="absolute inset-0 bg-canvas" />,
});

/** How long the search box waits after the last keystroke. */
const TYPING_MS = 300;

/** Gap between the fetch-area control and the layer column, plus the switcher's own inset. */
const LAYER_COLUMN_CLEARANCE_PX = 32;

/**
 * How long the URL waits behind the map. Longer than `moveend`, which a flick-and-correct fires
 * three times a second: browsers throttle `replaceState` — Safari has historically thrown after
 * about a hundred calls in thirty seconds — so the debounce is a correctness guard.
 */
const URL_WRITE_MS = 500;

/** The model publishes hourly and the server buckets its cache key to the hour. */
const AIR_QUALITY_STALE_MS = 30 * 60 * 1_000;

/** Short enough that a hiker who has just synced sees their own track on a reload. */
const HEATMAP_STALE_MS = 5 * 60 * 1_000;

export function Explore({
  viewerId,
  opening,
}: {
  viewerId: string | null;
  /**
   * Where the map opens when the URL does not say — the reader's own place, ranked by
   * `lib/place.ts`, or Seattle. Resolved on the server because `lib/place.ts` imports
   * `next/headers`, and needed on the first client render so the opening camera is correct.
   */
  opening: ExploreView;
}) {
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
   * The URL, read once after hydration — reading it during render would disagree with markup
   * the server rendered from the default viewport. `null` means "not read yet" and the map
   * waits for it, which is what makes a shared link beat `opening` and beat Seattle.
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
   * And written back, debounced. `history.replaceState` rather than `router.replace`, which the
   * App Router treats as navigation and re-runs the server component for a pan; the existing
   * `history.state` is passed through because Next keeps its routing state in there. The
   * `view === null` guard stops the first write erasing a `map=` the URL arrived with, before
   * the map has reported a viewport of its own.
   */
  useEffect(() => {
    if (!initial) return;
    if (view === null && initial.view !== null) return;

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
   * Send the map to a geocoded place. Deliberately not also applied as a trail filter — picking
   * "Vesper Peak" says where, not what, and the trails around a summit are mostly not named
   * after it. Written to the place cookie too: that is how a reader who keeps landing on the
   * wrong city corrects it, and it is the only source that arrives with a place name attached.
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
        // Remembering is a courtesy to the next visit; the map is already moving.
      });
    },
    [],
  );

  const onViewportChange = useCallback((next: BBox, zoom: number) => {
    setBbox(round(next));
    // The centre of the box, not the map's own `getCenter` — the same number for an unrotated
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
      refetchInterval: (active) => browsePollInterval(active.state.data),
    }),
  );

  /**
   * The air over the current viewport, asked for only while the overlay is on. Keyed on the
   * same rounded `bbox` the trail browse uses, so the two never disagree about what "this
   * view" means. No polling: the server's cache key is bucketed to the hour.
   */
  const airQualityQuery = useQuery(
    trpc.weather.airQualityGrid.queryOptions(
      { bbox: bbox ?? ([0, 0, 0, 0] as BBox) },
      {
        enabled: airQuality && bbox !== null,
        placeholderData: (previous) => previous,
        staleTime: AIR_QUALITY_STALE_MS,
        // One bad hour upstream should dim the overlay, not retry four times mid-pan.
        retry: 1,
      },
    ),
  );

  /**
   * Where people have recorded hiking, asked for only while the overlay is on. The zoom is
   * rounded because the server derives its lattice from `Math.round(zoom) + 5`; a raw float
   * would give every scroll-wheel notch its own query key for a byte-identical grid.
   */
  const heatmapQuery = useQuery(
    trpc.activities.heatmap.queryOptions(
      { bbox: bbox ?? ([0, 0, 0, 0] as BBox), zoom: Math.round(view?.zoom ?? opening.zoom) },
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
   * Selecting on the sheet scrolls the index to match. Not `scrollIntoView`, which by
   * specification scrolls every ancestor scrolling box — and the `overflow-hidden` page shell
   * is one, so picking a trail off the map shunted the whole page up with no way back.
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

  const sheetRef = useRef<HTMLDivElement>(null);

  return (
    <div className="grid min-h-0 flex-1 grid-rows-[45dvh_1fr] md:grid-cols-[minmax(340px,26rem)_1fr] md:grid-rows-1">
      {/* The sheet. First in the DOM on mobile, where the map is the point of arrival. */}
      <div
        ref={sheetRef}
        /*
         * MapLibre's corner containers are positioned against `bottom: 0`, so a bottom margin
         * of `--sb-card-lift` walks them clear of the pick card, which measures itself into the
         * variable. Bottom-right only below `md`, where the card runs the full width; above it
         * the card stops at 26rem. The zero here is the no-card resting state, in a rule rather
         * than a `style` prop so a re-render cannot clobber what the card wrote.
         */
        className="relative order-first [--sb-card-lift:0px] [&_.maplibregl-ctrl-bottom-left]:mb-[var(--sb-card-lift)] max-md:[&_.maplibregl-ctrl-bottom-right]:mb-[var(--sb-card-lift)] md:order-last"
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
            initialCenter={initial.view?.center ?? opening.center}
            initialZoom={initial.view?.zoom ?? opening.zoom}
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
          <PickCard pane={sheetRef} trail={selected} onDismiss={() => setSelectedId(null)} />
        ) : null}
      </div>

      {/* The collar. `min-w-0` for the reason `trail-card.tsx` gives beside its heading: a
          grid item's min-width is its min-content width, and the index's min-content is the
          longest unbreakable word any card holds. */}
      <div className="flex min-h-0 min-w-0 flex-col border-bezel md:border-r">
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
          // quietly asking for a horizontal scrollbar. `clip` refuses the axis outright.
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
 * Round the viewport to ~100 m before it becomes a cache key, so a pan back hits the cache it
 * just filled. A third of a pixel at the zoom where this matters.
 */
function round(bbox: BBox): BBox {
  return bbox.map((value) => Math.round(value * 1000) / 1000) as unknown as BBox;
}
