'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { BBox } from '@switchback/core';
import type { RouterOutputs } from '@switchback/api';
import { useTRPC } from '@/trpc/react';

/**
 * The one box, doing the two things a person means by "search".
 *
 * Typing a name is ambiguous in a way a trail app cannot ignore. "Vesper Peak" is a place
 * you want to go to; "loop" is a filter on the trails already in front of you. A viewport
 * search answers only the second, and answers the first with "no trails" — which reads as
 * *we have never heard of it* rather than *that is two thousand miles away*.
 *
 * So both run. Keystrokes filter the current view immediately, and in parallel the name is
 * put to a gazetteer; anything it recognises appears above the filter as somewhere to go.
 * The two are visually separated and never merged into one ranked list, because they are
 * different kinds of answer and a blended list makes the user guess which they are getting.
 *
 * **On the plate marker.** Each suggestion carries a hairline in its plate colour — contour
 * for terrain, water for lakes, woodland for parks. It is the same five-plate legend the
 * map itself uses, so "which of these three Bear Lakes is the lake" is answered by colour
 * before the text is read. Nothing here uses the survey plate: that red belongs to the user
 * and their safety, and a dropdown row is neither.
 */

type PlaceResult = RouterOutputs['places']['search']['places'][number];

export interface SearchBoxProps {
  value: string;
  onChange: (value: string) => void;
  /** The current viewport, used to bias results. Null until the map has reported one. */
  near: BBox | null;
  onPlaceSelect: (place: PlaceResult) => void;
}

/**
 * How long the box waits before asking the gazetteer.
 *
 * Longer than the 300 ms the trail filter uses, and deliberately. Filtering is local and
 * costs a query against ground we already hold; geocoding reaches a shared public service
 * that permits one request per second for the entire OSM ecosystem. Half a second is about
 * where a typist's natural pauses fall, so "vesper peak" is one lookup rather than eleven.
 */
const PLACE_TYPING_MS = 500;

/** Shortest string worth resolving. Below this every query matches half the planet. */
const MIN_PLACE_QUERY = 3;

const PLATE_LINE: Record<string, string> = {
  contour: 'bg-contour',
  water: 'bg-water',
  woodland: 'bg-woodland',
  ink: 'bg-ink-muted',
};

/**
 * Coarsen the viewport to whole degrees, **outward**.
 *
 * The goal is a stable cache key: a pan of a few hundred metres must not become a fresh
 * lookup against a service that permits one request per second for the whole of OSM, and
 * bias only needs to know roughly where on the planet you are.
 *
 * The obvious way to do that is to round each corner, and it is wrong in a way that fails
 * silently. A viewport narrower than a degree — which is most of them; a city fits in a
 * tenth — has both its corners round to the same integer, and `[-4, 53, -4, 53]` is not a
 * coarse box, it is a point. Nominatim accepts it, biases toward a region of zero area, and
 * returns nothing at all. The symptom is a search box that finds Vesper Peak from a cold
 * page and stops finding it the moment the map has reported where it is looking, which
 * reads as the gazetteer being broken rather than as a rounding bug.
 *
 * Expanding outward — floor the low corner, ceil the high one — keeps every viewport inside
 * its own box, guarantees at least a degree in each dimension, and snaps to the same grid,
 * so it is the same cache key for the same reason.
 */
function snap(bbox: BBox): BBox {
  const [w, s, e, n] = bbox;
  return [Math.floor(w), Math.floor(s), Math.ceil(e), Math.ceil(n)];
}

export function SearchBox({ value, onChange, near, onPlaceSelect }: SearchBoxProps) {
  const trpc = useTRPC();
  const listId = useId();
  const optionId = useId();

  const [placeQuery, setPlaceQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);

  const typing = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const box = useRef<HTMLDivElement | null>(null);

  useEffect(() => () => clearTimeout(typing.current), []);

  const handleChange = useCallback(
    (next: string) => {
      onChange(next);
      setOpen(true);
      setActive(-1);
      clearTimeout(typing.current);
      typing.current = setTimeout(() => setPlaceQuery(next.trim()), PLACE_TYPING_MS);
    },
    [onChange],
  );

  const places = useQuery(
    trpc.places.search.queryOptions(
      {
        q: placeQuery,
        limit: 5,
        ...(near ? { near: snap(near) } : {}),
      },
      {
        enabled: placeQuery.length >= MIN_PLACE_QUERY,
        // A place name resolves to the same coordinate today and tomorrow. Re-asking on
        // every focus would spend the rate limit on an answer we already have.
        staleTime: 60 * 60 * 1000,
        retry: false,
      },
    ),
  );

  const results = useMemo(() => places.data?.places ?? [], [places.data]);
  const expanded = open && value.trim().length >= MIN_PLACE_QUERY && results.length > 0;

  // Clicking anywhere else puts the list away. Pointerdown rather than click, so the list
  // is gone by the time a click on the map below it lands.
  useEffect(() => {
    if (!expanded) return;
    const away = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [expanded]);

  const choose = useCallback(
    (place: PlaceResult) => {
      setOpen(false);
      setActive(-1);
      // The name stays in the box. It is now the label for where the map is, and clearing
      // it would also clear the trail filter the user can still see applied.
      onChange(place.name);
      clearTimeout(typing.current);
      setPlaceQuery(place.name);
      onPlaceSelect(place);
    },
    [onChange, onPlaceSelect],
  );

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      setOpen(false);
      setActive(-1);
      return;
    }
    if (!expanded) {
      if (event.key === 'ArrowDown' && results.length > 0) {
        event.preventDefault();
        setOpen(true);
        setActive(0);
      }
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((index) => (index + 1) % results.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => (index <= 0 ? results.length - 1 : index - 1));
    } else if (event.key === 'Enter' && active >= 0) {
      // Only when a suggestion is highlighted. A bare Enter submits the text as a trail
      // filter, which is what someone typing "loop" and hitting return means.
      event.preventDefault();
      const place = results[active];
      if (place) choose(place);
    }
  };

  return (
    <div ref={box} className="relative">
      <label>
        <span className="sr-only">Search trails in view, or a place to go</span>
        <input
          type="search"
          value={value}
          onChange={(event) => handleChange(event.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => setOpen(true)}
          placeholder="Search trails, or a place"
          role="combobox"
          aria-expanded={expanded}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={expanded && active >= 0 ? `${optionId}-${active}` : undefined}
          className="field"
        />
      </label>

      {expanded ? (
        <div className="absolute inset-x-0 top-[calc(100%+var(--spacing-xs))] z-30 overflow-hidden rounded-hair border border-bezel bg-surface">
          <p className="collar border-b border-bezel px-md py-sm">Go to</p>
          <ul id={listId} role="listbox" aria-label="Places">
            {results.map((place, index) => (
              <li key={place.id} role="presentation">
                <button
                  type="button"
                  id={`${optionId}-${index}`}
                  role="option"
                  aria-selected={index === active}
                  // Pointerdown, not click: the input's blur would otherwise close the list
                  // before the click resolves.
                  onPointerDown={(event) => {
                    event.preventDefault();
                    choose(place);
                  }}
                  onMouseEnter={() => setActive(index)}
                  className={`flex w-full items-center gap-md px-md py-sm text-left ${
                    index === active ? 'bg-bezel/40' : ''
                  }`}
                >
                  <span
                    aria-hidden
                    className={`h-6 w-[2px] shrink-0 ${PLATE_LINE[place.plate] ?? 'bg-ink-muted'}`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body text-ink">{place.name}</span>
                    <span className="block truncate text-caption text-ink-muted">
                      {place.context}
                    </span>
                  </span>
                  <span className="collar shrink-0">{place.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
