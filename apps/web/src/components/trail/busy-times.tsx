'use client';

import { useId } from 'react';
import type { BusynessForecast, BusynessLevel } from '@switchback/core';
import { BUSYNESS_LEVEL_LABEL, DAY_NAMES, DAY_NAMES_SHORT, formatHour } from '@switchback/core';
import { BUSYNESS_INK } from '@switchback/ui';
import { BUTTON_COLLAR, HEIGHT, OUTLINE } from '../controls';

/**
 * Busy times — the culture plate.
 *
 * On a USGS quadrangle the culture plate carries the works of man: roads, buildings,
 * boundaries, everything the land did not put there. It prints in black. So do crowds, and
 * so does this grid — one ink density per level, no hue at all. That is not a neutral
 * choice made to be safe; it is the only choice that leaves the four coloured plates
 * meaning what they mean everywhere else on the page. Red still means your safety. Blue
 * still means the weather. People are black, like a road.
 *
 * **Four densities, not a gradient.** The API publishes four named levels and the grid
 * shows exactly four inks, so a cell's shade is readable against the legend rather than
 * merely comparable to its neighbours. A continuous ramp would look more precise and would
 * be a lie about a modelled number.
 *
 * **The grid is decoration; the sentences are the content.** 168 cells are unusable one at
 * a time — through a screen reader they are 168 announcements of nothing. Each row carries
 * a written summary instead, and the cells are `aria-hidden`. Same contract the section
 * graphic keeps.
 *
 * **One control.** The recommendation is a weekday and an hour; the button next to it hands
 * that start to the conditions block above. That single link is the whole editorial point
 * of putting these two features on one page — go when it is empty, and know what the
 * weather will be doing when you do.
 */

export interface BusyTimesProps {
  forecast: BusynessForecast | null;
  isPending: boolean;
  error: string | null;
  /** Highlights the row for the day the reader is actually on, when the trail's date is known. */
  todayDayOfWeek?: number | null;
  /** Hands the recommended slot to the conditions block. Absent when there is no forecast. */
  onPickStart?: ((dayOfWeek: number, hour: number) => void) | undefined;
}

const LEVELS: readonly BusynessLevel[] = ['quiet', 'moderate', 'busy', 'packed'];
const HOUR_TICKS = [0, 6, 12, 18];

/** The shared coverage table, as a colour. The phone resolves the same numbers to alpha. */
function ink(level: BusynessLevel): string {
  return `color-mix(in srgb, var(--color-ink) ${BUSYNESS_INK[level]}%, transparent)`;
}

export function BusyTimes({
  forecast,
  isPending,
  error,
  todayDayOfWeek = null,
  onPickStart,
}: BusyTimesProps) {
  const headingId = useId();

  return (
    <section aria-labelledby={headingId} className="border-t border-bezel pt-lg">
      <header className="flex flex-wrap items-baseline justify-between gap-sm">
        <h2 id={headingId} className="collar">
          Busy times
        </h2>
        <p className="font-mono text-micro text-ink-muted">
          {forecast === null ? null : confidenceLine(forecast)}
        </p>
      </header>

      {error !== null ? (
        <p className="mt-md rounded-hair border border-dashed border-bezel px-md py-lg text-caption text-ink-muted">
          {error}
        </p>
      ) : isPending || forecast === null ? (
        <p className="mt-md rounded-hair border border-dashed border-bezel px-md py-lg text-caption text-ink-muted">
          Working out when this trail is quiet…
        </p>
      ) : (
        <>
          {forecast.recommendation === null ? null : (
            <div className="mt-md flex flex-wrap items-baseline justify-between gap-sm border-b border-bezel pb-md">
              <p className="hydrography max-w-measure text-body-lg">
                <span className="text-ink">
                  Quietest {DAY_NAMES[forecast.recommendation.dayOfWeek] ?? 'this week'} around{' '}
                  {formatHour(forecast.recommendation.hour)}
                </span>{' '}
                — {forecast.recommendation.reason}
              </p>
              {onPickStart === undefined ? null : (
                <button
                  type="button"
                  onClick={() =>
                    onPickStart(forecast.recommendation!.dayOfWeek, forecast.recommendation!.hour)
                  }
                  className={`${BUTTON_COLLAR} ${OUTLINE} ${HEIGHT.panel} shrink-0 px-md`}
                >
                  Forecast that start
                </button>
              )}
            </div>
          )}

          <div className="mt-md">
            {/* Hour ticks, on the same 24-column measure as the rows below. */}
            <div
              aria-hidden
              className="grid grid-cols-[2.75rem_repeat(24,minmax(0,1fr))] gap-px font-mono text-micro text-ink-muted"
            >
              <span />
              {Array.from({ length: 24 }, (_, hour) => (
                <span key={hour} className="overflow-visible whitespace-nowrap">
                  {HOUR_TICKS.includes(hour) ? String(hour).padStart(2, '0') : ''}
                </span>
              ))}
            </div>

            <ol className="mt-hair flex flex-col gap-px">
              {forecast.week.map((day) => {
                const today = day.dayOfWeek === todayDayOfWeek;
                const recommended =
                  forecast.recommendation?.dayOfWeek === day.dayOfWeek
                    ? forecast.recommendation.hour
                    : null;

                return (
                  <li
                    key={day.dayOfWeek}
                    className="grid grid-cols-[2.75rem_repeat(24,minmax(0,1fr))] items-center gap-px"
                  >
                    <span className="sr-only">
                      {DAY_NAMES[day.dayOfWeek]}: busiest around {formatHour(day.peakHour)},
                      quietest daylight hour around {formatHour(day.quietestHour)}.
                    </span>
                    <span
                      aria-hidden
                      className={`collar pr-xs ${today ? 'text-ink' : 'text-ink-muted'}`}
                    >
                      {DAY_NAMES_SHORT[day.dayOfWeek]}
                    </span>
                    {day.hours.map((slot) => (
                      <span
                        aria-hidden
                        key={slot.hour}
                        title={`${DAY_NAMES[day.dayOfWeek]} ${formatHour(slot.hour)} — ${
                          BUSYNESS_LEVEL_LABEL[slot.level]
                        }`}
                        style={{
                          backgroundColor: ink(slot.level),
                          ...(slot.hour === recommended
                            ? { boxShadow: 'inset 0 0 0 1.5px var(--color-ink)' }
                            : {}),
                        }}
                        className="h-lg"
                      />
                    ))}
                  </li>
                );
              })}
            </ol>
          </div>

          {/*
           * The key sits under the grid it decodes, not filed alongside the caveat. A
           * legend you have to look away from the chart to find is not doing its job, and
           * pairing it with a paragraph left both squeezed into half the width with nothing
           * in the other half.
           */}
          <ul aria-hidden className="mt-sm flex flex-wrap items-center gap-md">
            {LEVELS.map((level) => (
              <li key={level} className="flex items-center gap-xs">
                <span
                  className="inline-block h-sm w-lg border border-bezel"
                  style={{ backgroundColor: ink(level) }}
                />
                <span className="collar">{BUSYNESS_LEVEL_LABEL[level]}</span>
              </li>
            ))}
          </ul>

          {/* The rule runs the full measure and the prose does not — a hairline that stops
              where a paragraph happens to wrap reads as a mistake rather than a division. */}
          <div className="mt-md border-t border-bezel pt-sm">
            <p className="max-w-measure-wide text-caption text-ink-muted">
              An estimate, not a measurement. Modelled from how well used this trail is, its
              parking, the season and{' '}
              {forecast.weatherAdjusted
                ? 'this week’s forecast'
                : 'nothing about this week’s weather, which could not be read'}
              . Shades compare each hour to this trail’s own busiest hour, so a quiet trail and a
              famous one both fill the row.{' '}
              {forecast.observationCount === 0
                ? 'It sharpens as people record hikes here.'
                : `Sharpened by ${forecast.observationCount.toLocaleString()} recorded ${
                    forecast.observationCount === 1 ? 'visit' : 'visits'
                  }.`}
            </p>
          </div>
        </>
      )}
    </section>
  );
}

/**
 * How much of this is measured, and how crowded "busy" actually gets.
 *
 * `peakLevel` is the antidote to a normalised chart: the grid says *when*, and only this
 * says whether the fullest hour on a remote glen is a crowd or four cars. When the model
 * has no evidence for an absolute claim it publishes `null`, and then nothing is said.
 */
function confidenceLine(forecast: BusynessForecast): string {
  const basis =
    forecast.confidence === 'modeled'
      ? 'Estimated'
      : `${forecast.confidence.charAt(0).toUpperCase()}${forecast.confidence.slice(1)} confidence`;
  const peak =
    forecast.peakLevel === null
      ? null
      : `busiest hour ${BUSYNESS_LEVEL_LABEL[forecast.peakLevel].toLowerCase()}`;
  return peak === null ? basis : `${basis} · ${peak}`;
}
