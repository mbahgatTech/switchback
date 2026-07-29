'use client';

import { useState } from 'react';
import {
  ACTIVITY_TYPE_LABELS,
  ACTIVITY_TYPES,
  DIFFICULTIES,
  DIFFICULTY_LABELS,
  ROUTE_TYPES,
} from '@switchback/core';
import type { UnitSystem } from '@switchback/core';
import { Chip, ChipGroup } from '../chip';
import { useUnits } from '../units';
import { ROUTE_LABEL } from './route-label';
import { EMPTY_FACETS, activeFacetCount, type BrowseSort, type Facets } from './facets';
import { HEIGHT } from '../controls';

/**
 * The facets, and the controls that set them.
 *
 * **Why bands rather than sliders for length and gain.** A two-handle range slider is the
 * expected control and it is a poor one: it needs a pointer, it needs precision, and the
 * number it produces — "trails between 7.4 and 16.2 km" — is not a question anybody asks.
 * People ask for a morning, a full day, or a big day out. Bands say that in one tap, work
 * from a keyboard, and are legible on a phone, which is where this filter is used most.
 *
 * The trade is that a band cannot express 7.4 km. Nobody has wanted to.
 *
 * **Why the panel collapses.** Six chip groups — eleven activities alone — is a rail taller
 * than a laptop viewport, and it sat above the results list in a column that had no way to
 * contain it. What overflowed spilled out of the collar and into the page shell, which is
 * `overflow-hidden`: no scrollbar, but still a scrolling box, so any `scrollIntoView` in the
 * subtree shunted the entire page up and left it there. The scroll leak is fixed at its own
 * call site, but a panel that cannot fit its own column is the reason there was anything to
 * leak into. Collapsed by default with the active count on the button, so the state the rail
 * used to show at a glance is still visible at a glance.
 */

/**
 * The orderings a map can express.
 *
 * Re-exported so callers that already reach for `./filters` keep working; the definitions
 * live in `./facets`, which has no React in it.
 */
export type { BrowseSort, Facets } from './facets';
export { EMPTY_FACETS, activeFacetCount } from './facets';

interface Band {
  label: string;
  /** What goes under the name — already in the reader's unit, no conversion at render. */
  detail: string;
  min?: number;
  max?: number;
}

/**
 * Named for the hike, not for the number — and the numbers differ by unit system rather
 * than being converted.
 *
 * Converting 5 km for an American reader produces "3.1 mi", which is a boundary nobody
 * chose and a decimal nobody wants on a filter chip. The bands are qualitative; what makes
 * a "half day" is a judgement, not a constant, so each system gets round numbers in its own
 * units and the metres behind them shift slightly. The query is always in metres.
 */
const LENGTH_BANDS: Record<UnitSystem, readonly Band[]> = {
  metric: [
    { label: 'Short', detail: '<5', max: 5_000 },
    { label: 'Half day', detail: '5–12', min: 5_000, max: 12_000 },
    { label: 'Full day', detail: '12–25', min: 12_000, max: 25_000 },
    { label: 'Big day', detail: '25+', min: 25_000 },
  ],
  imperial: [
    { label: 'Short', detail: '<3', max: 4_828 },
    { label: 'Half day', detail: '3–8', min: 4_828, max: 12_875 },
    { label: 'Full day', detail: '8–15', min: 12_875, max: 24_140 },
    { label: 'Big day', detail: '15+', min: 24_140 },
  ],
};

const GAIN_BANDS: Record<UnitSystem, readonly Band[]> = {
  metric: [
    { label: 'Flat', detail: '<300', max: 300 },
    { label: 'Rolling', detail: '300–800', min: 300, max: 800 },
    { label: 'Climb', detail: '800–1500', min: 800, max: 1_500 },
    { label: 'Serious', detail: '1500+', min: 1_500 },
  ],
  imperial: [
    { label: 'Flat', detail: '<1000', max: 305 },
    { label: 'Rolling', detail: '1000–2500', min: 305, max: 762 },
    { label: 'Climb', detail: '2500–5000', min: 762, max: 1_524 },
    { label: 'Serious', detail: '5000+', min: 1_524 },
  ],
};

const SORTS: readonly { value: BrowseSort; label: string }[] = [
  { value: 'popularity', label: 'Most popular' },
  { value: 'rating', label: 'Best rated' },
  { value: 'length_desc', label: 'Longest' },
  { value: 'length_asc', label: 'Shortest' },
];

function toggle<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

function bandActive(band: Band, min: number | undefined, max: number | undefined): boolean {
  return band.min === min && band.max === max;
}

export interface FiltersProps {
  facets: Facets;
  onChange: (next: Facets) => void;
}

/**
 * Renders as two siblings — a fixed bar and a collapsible panel — rather than one wrapper,
 * so the collar's flex column can size them independently: the bar never shrinks, the panel
 * shrinks and scrolls, and neither can push the results list out of the viewport.
 */
export function Filters({ facets, onChange }: FiltersProps) {
  const units = useUnits();
  const [open, setOpen] = useState(false);
  const set = (patch: Partial<Facets>) => onChange({ ...facets, ...patch });
  const active = activeFacetCount(facets);

  return (
    <>
      <div className="flex shrink-0 items-center gap-sm border-b border-bezel px-lg py-md">
        <button
          type="button"
          onClick={() => setOpen((was) => !was)}
          aria-expanded={open}
          aria-controls="explore-facets"
          className={[
            `inline-flex ${HEIGHT.panel} items-center gap-sm rounded-hair border px-md`,
            'text-caption font-medium transition-colors duration-quick ease-standard',
            open || active > 0
              ? 'border-ink bg-ink text-canvas'
              : 'border-bezel text-ink-muted hover:border-ink-muted hover:text-ink',
          ].join(' ')}
        >
          Filters
          {active > 0 ? <span className="font-mono text-micro opacity-70">{active}</span> : null}
        </button>

        {active > 0 ? (
          <button
            type="button"
            onClick={() => onChange({ ...EMPTY_FACETS, sort: facets.sort })}
            className={`${HEIGHT.panel} rounded-hair px-sm text-caption text-ink-muted underline underline-offset-4 transition-colors duration-quick ease-standard hover:text-ink`}
          >
            Clear
          </button>
        ) : null}

        <label className="ml-auto flex items-center gap-sm">
          <span className="collar">Sort</span>
          <select
            value={facets.sort}
            onChange={(event) => set({ sort: event.target.value as BrowseSort })}
            className={`${HEIGHT.panel} rounded-hair border border-bezel bg-surface px-sm text-caption text-ink`}
          >
            {SORTS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {open ? (
        // The cap is stated as "leave the results list this much", not "take half": at half
        // the collar the panel scrolled on every desktop and sliced a row of chips down the
        // middle, while 14rem is about two and a half cards — enough for the list to still
        // read as a list. `min-h-0` is what lets the panel shrink below its content instead
        // of pushing the column past its row.
        //
        // The border sits out here rather than on the scroller, because the mask that fades
        // the scroller's last few pixels would fade the divider away with them.
        <div
          id="explore-facets"
          className="flex max-h-[calc(100%-14rem)] min-h-0 shrink flex-col border-b border-bezel"
        >
          <div className="scroll-hint flex min-h-0 flex-col gap-lg overflow-y-auto overflow-x-clip p-lg">
            <ChipGroup label="Difficulty">
              {DIFFICULTIES.map((value) => (
                <Chip
                  key={value}
                  label={DIFFICULTY_LABELS[value]}
                  pressed={facets.difficulty.includes(value)}
                  onToggle={() => set({ difficulty: toggle(facets.difficulty, value) })}
                />
              ))}
            </ChipGroup>

            <ChipGroup label={units === 'imperial' ? 'Length (mi)' : 'Length (km)'}>
              {LENGTH_BANDS[units].map((band) => {
                const pressed = bandActive(band, facets.minLengthM, facets.maxLengthM);
                return (
                  <Chip
                    key={band.label}
                    label={band.label}
                    detail={band.detail}
                    pressed={pressed}
                    // Pressing the active band clears it. Without this a band filter is a
                    // one-way door — there is no "any length" chip to go back to.
                    onToggle={() =>
                      set(
                        pressed
                          ? { minLengthM: undefined, maxLengthM: undefined }
                          : { minLengthM: band.min, maxLengthM: band.max },
                      )
                    }
                  />
                );
              })}
            </ChipGroup>

            <ChipGroup label={units === 'imperial' ? 'Elevation gain (ft)' : 'Elevation gain (m)'}>
              {GAIN_BANDS[units].map((band) => {
                const pressed = bandActive(band, facets.minGainM, facets.maxGainM);
                return (
                  <Chip
                    key={band.label}
                    label={band.label}
                    detail={band.detail}
                    pressed={pressed}
                    onToggle={() =>
                      set(
                        pressed
                          ? { minGainM: undefined, maxGainM: undefined }
                          : { minGainM: band.min, maxGainM: band.max },
                      )
                    }
                  />
                );
              })}
            </ChipGroup>

            <ChipGroup label="Route">
              {ROUTE_TYPES.map((value) => (
                <Chip
                  key={value}
                  label={ROUTE_LABEL[value]}
                  pressed={facets.routeType.includes(value)}
                  onToggle={() => set({ routeType: toggle(facets.routeType, value) })}
                />
              ))}
            </ChipGroup>

            <ChipGroup label="Activity">
              {ACTIVITY_TYPES.map((value) => (
                <Chip
                  key={value}
                  label={ACTIVITY_TYPE_LABELS[value]}
                  pressed={facets.activityTypes.includes(value)}
                  onToggle={() => set({ activityTypes: toggle(facets.activityTypes, value) })}
                />
              ))}
            </ChipGroup>

            <ChipGroup label="Access">
              {/*
              Tri-state, and the third state matters: "any" is not "no dogs". Most trails
              carry no access tag at all, so a pressed chip means "tagged as allowed" and an
              unpressed one means "not filtering" — never "tagged as banned". The router
              enforces the same distinction; see `facetWhere`.
            */}
              <Chip
                label="Dogs allowed"
                pressed={facets.dogsAllowed === true}
                onToggle={() => set({ dogsAllowed: facets.dogsAllowed ? undefined : true })}
              />
              <Chip
                label="Wheelchair accessible"
                pressed={facets.wheelchairAccessible === true}
                onToggle={() =>
                  set({ wheelchairAccessible: facets.wheelchairAccessible ? undefined : true })
                }
              />
            </ChipGroup>
          </div>
        </div>
      ) : null}
    </>
  );
}
