'use client';

import { useId } from 'react';
import type {
  AirQualityReading,
  AlongRouteForecast,
  UnitSystem,
  WeatherFlag,
  WeatherSample,
} from '@switchback/core';
import {
  AIR_QUALITY_POLLUTANT_LABELS,
  clockOf,
  compassPoint,
  europeanAqiBand,
  formatDayLabel,
  formatDistance,
  formatElevation,
  formatHour,
  formatSpeed,
  formatTemperature,
  weatherCodeLabel,
} from '@switchback/core';
import { useUnitsOr } from '../units';

/**
 * Conditions on the way — the flagship feature, as a timetable.
 *
 * A timetable and not a set of weather cards, because the question this answers is a
 * timetable question: *what will it be doing when I get there?* Every other weather
 * interface on the internet forecasts a place. This one forecasts a journey, so it is laid
 * out the way a journey is published — mileage on the left, named points beside it, and one
 * row per place you will actually stand in, in the order you will stand in them.
 *
 * **Plate discipline.** Weather is the water plate throughout: the block rule, the high
 * point's tint, the freezing-level line on the section above. Survey — red — appears only
 * on the safety flags and on the rows they point at, because on this product's map survey
 * means the reader or their safety and nothing else. A gust warning and a rain shower are
 * not the same kind of fact and they must not be the same colour.
 *
 * **Nothing here is decoration for missing data.** A reading upstream did not return is an
 * em dash. A sky it has no code for is an em dash. The one thing a forecast must never do
 * is look equally confident about everything.
 */

export interface ConditionsProps {
  forecast: AlongRouteForecast | null;
  /** True before the first forecast has ever arrived; false while merely re-fetching. */
  isPending: boolean;
  /** True whenever a request is in flight, including a re-fetch over stale data. */
  isFetching: boolean;
  error: string | null;
  /** Effective start, local to the trail. `null` only before the first forecast lands. */
  date: string | null;
  hour: number | null;
  /** Every date the control offers, ascending. */
  dateOptions: readonly string[];
  onStartChange: (date: string, hour: number) => void;
  units?: UnitSystem;
  /**
   * The air over the trail, or `null` while it is being read.
   *
   * One reading rather than one per row, and that is not a shortcut. The model works in
   * cells tens of kilometres across, so a column of eight would be the same number printed
   * eight times with the strong implication that it varied — which is the one thing a
   * timetable must not do to a figure that does not.
   */
  airQuality?: AirQualityReading | null;
}

const HOURS = Array.from({ length: 24 }, (_, i) => i);

const SEVERITY_LABEL = { warning: 'Warning', caution: 'Caution', info: 'Note' } as const;

export function Conditions({
  forecast,
  isPending,
  isFetching,
  error,
  date,
  hour,
  dateOptions,
  onStartChange,
  units: given,
  airQuality = null,
}: ConditionsProps) {
  const units = useUnitsOr(given);
  const headingId = useId();
  const dayId = useId();
  const hourId = useId();

  const samples = forecast?.samples ?? [];
  const highIndex = highestIndex(samples);
  const warned = new Set(
    (forecast?.flags ?? []).filter((f) => f.severity === 'warning').map((f) => f.sampleIndex),
  );

  return (
    <section aria-labelledby={headingId} className="border-t border-bezel pt-lg">
      <header className="flex flex-wrap items-baseline justify-between gap-sm">
        <div className="flex items-baseline gap-sm">
          <h2 id={headingId} className="collar">
            Conditions on the way
          </h2>

          {/*
           * The re-fetch signal, as a word.
           *
           * This block used to dim itself to 45 % while a new start loaded. The reasoning was
           * right — the readings on screen are still true, just for the previous hour, and
           * blanking a table someone is mid-sentence in is worse than showing it a beat stale
           * — but 45 % opacity is not a gentler version of blanking it, it *is* blanking it,
           * slowly. `ink-muted` starts at 4.83:1 and there is no fade of it that stays
           * readable; see the note on `SCHEMES` in `packages/ui` for the arithmetic.
           *
           * So the content stays at full strength and the state is said instead. A word rather
           * than a spinner or a bar because this is a block the reader is looking straight at,
           * having just moved a dial — `fetch-area`'s bar exists for the opposite case, a
           * control glanced at while doing something else. `ink` rather than a plate colour:
           * the plates are a legend on this product and "a request is in flight" is not a fact
           * about terrain, weather, or anyone's safety.
           *
           * `aria-hidden` because the `role="status"` line below is the accessible half, and
           * announcing both would say it twice. `!isPending` because "updating" is a claim
           * about readings that are already on screen — during the first fetch there are none,
           * and the block below is already saying so in a full sentence.
           */}
          {isFetching && !isPending ? (
            <span aria-hidden className="collar text-ink">
              Updating
            </span>
          ) : null}
        </div>

        {/*
         * Two dials, not three. Pace belongs to the hiker and not to the trail — it will
         * live in account settings, where it can also correct the headline time estimate,
         * rather than being re-answered on every page.
         */}
        <div className="flex items-baseline gap-xs font-mono text-caption text-ink-muted">
          <label htmlFor={dayId}>Leaving</label>
          <select
            id={dayId}
            value={date ?? ''}
            disabled={date === null}
            onChange={(event) => onStartChange(event.target.value, hour ?? 7)}
            className="dial"
          >
            {dateOptions.map((option) => (
              <option key={option} value={option}>
                {formatDayLabel(option)}
              </option>
            ))}
          </select>
          <label htmlFor={hourId}>at</label>
          <select
            id={hourId}
            value={hour ?? ''}
            disabled={date === null}
            onChange={(event) => onStartChange(date ?? '', Number(event.target.value))}
            className="dial"
          >
            {HOURS.map((option) => (
              <option key={option} value={option}>
                {formatHour(option)}
              </option>
            ))}
          </select>
        </div>
      </header>

      {/*
        Always mounted with its text swapped, rather than mounted when the fetch begins: a
        live region that appears at the same instant as its own content is announced
        unreliably, and this has to work on a screen reader as dependably as the word above
        works on the eye. Silent during the first fetch for the same reason the word is
        absent — there is no forecast yet to be updating.
      */}
      <p role="status" className="sr-only">
        {isFetching && !isPending ? 'Updating the forecast for the new start time.' : ''}
      </p>

      {error !== null ? (
        <p className="mt-md rounded-hair border border-dashed border-bezel px-md py-lg text-caption text-ink-muted">
          {error}
        </p>
      ) : isPending ? (
        <p className="mt-md rounded-hair border border-dashed border-bezel px-md py-lg text-caption text-ink-muted">
          Reading the forecast for this route…
        </p>
      ) : forecast === null ? null : (
        <div
          // Full strength while a new start loads — the "Updating" mark in the header carries
          // the state now. `aria-busy` is the same statement to assistive technology: these
          // rows are real and readable, and a newer set is on its way.
          aria-busy={isFetching}
        >
          <Flags flags={forecast.flags} />

          <AirQuality reading={airQuality} />

          {/*
           * Eight columns need 46rem and a phone has about 24, so the table scrolls
           * sideways rather than shedding columns — the difference between the car park and
           * the summit is the entire feature, and a version that drops the summit's wind to
           * fit is not a smaller version of it. `tabIndex` and the region role are what make
           * that scroll reachable without a mouse; a bare overflow container is not.
           */}
          <div
            role="region"
            aria-label="Forecast at each point along the route"
            tabIndex={0}
            className="mt-md overflow-x-auto rounded-hair focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          >
            {/*
             * Caption, not micro. `micro` is the collar size and the tokens reserve it for
             * marginalia — labels, legend keys, axis ticks. These are the numbers the whole
             * feature exists to publish, and setting them at label size put the flagship
             * reading smaller than the description prose underneath it. The column heads stay
             * at collar, which is what gives the table a head and a body.
             */}
            <table className="w-full min-w-[46rem] border-collapse text-left font-mono text-caption tabular-nums">
              <caption className="sr-only">
                Forecast at each point along the route, at the hour you reach it.
              </caption>
              <thead>
                <tr className="border-b border-ink text-ink-muted">
                  <Th className="text-right">Dist</Th>
                  <Th>Point</Th>
                  <Th className="text-right">Arrive</Th>
                  <Th className="text-right">Alt</Th>
                  <Th className="text-right">Temp</Th>
                  <Th className="text-right">Wind</Th>
                  <Th className="text-right">Rain</Th>
                  <Th>Sky</Th>
                </tr>
              </thead>
              <tbody>
                {samples.map((sample, index) => (
                  <Row
                    key={`${sample.distM}-${index}`}
                    sample={sample}
                    named={index === 0 || index === samples.length - 1 || index === highIndex}
                    high={index === highIndex}
                    warned={warned.has(index)}
                    units={units}
                  />
                ))}
              </tbody>
            </table>
          </div>

          {/*
           * Said in words rather than drawn as a fading edge. A gradient mask over the last
           * column hides the very reading it is advertising, and on a table of numbers that
           * is worse than one short line of type.
           */}
          <p className="collar mt-xs sm:hidden">Scroll sideways for wind, rain and sky</p>

          <Provenance forecast={forecast} />
        </div>
      )}
    </section>
  );
}

function Th({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <th className={`collar px-sm py-xs font-normal ${className}`}>{children}</th>;
}

function Row({
  sample,
  named,
  high,
  warned,
  units,
}: {
  sample: WeatherSample;
  named: boolean;
  high: boolean;
  warned: boolean;
  units: UnitSystem;
}) {
  const wind = sample.windGustsKmh ?? sample.windSpeedKmh;
  const bearing = compassPoint(sample.windDirectionDeg);
  const sky = weatherCodeLabel(sample.weatherCode);

  return (
    <tr
      className={[
        'border-b border-bezel/60',
        high ? 'bg-water-wash text-ink' : 'text-ink-muted',
        // The left rail says why a row matters, and only ever one thing at a time: survey
        // for a row a warning points at, water for the high point, nothing otherwise. A
        // warning outranks the summit — if the top of the hike is also the dangerous part,
        // the colour that means *your safety* is the one that has to survive.
        'border-l-2',
        warned ? 'border-l-survey' : high ? 'border-l-water' : 'border-l-transparent',
      ].join(' ')}
    >
      <td className="px-sm py-xs text-right">{formatDistance(sample.distM, units)}</td>
      <td className={`px-sm py-xs ${named ? 'text-ink' : ''}`}>{named ? sample.label : ''}</td>
      <td className="px-sm py-xs text-right text-ink">{clockOf(sample.arrivalAt) ?? '—'}</td>
      <td className="px-sm py-xs text-right">{formatElevation(sample.eleM, units)}</td>
      <td className="px-sm py-xs text-right text-ink">
        {sample.temperatureC === null ? '—' : formatTemperature(sample.temperatureC, units)}
      </td>
      <td className="px-sm py-xs text-right">
        {wind === null
          ? '—'
          : `${formatSpeed(wind, units)}${bearing === null ? '' : ` ${bearing}`}`}
      </td>
      <td className="px-sm py-xs text-right">
        {sample.precipitationProbability === null ? '—' : `${sample.precipitationProbability}%`}
      </td>
      <td className="px-sm py-xs">{sky ?? '—'}</td>
    </tr>
  );
}

/**
 * The air, as one reading with its footprint stated.
 *
 * It sits between the flags and the timetable because that is what it is: not a warning
 * (the flags already fire at 60 and 80, from the same numbers) and not a per-point figure,
 * but a fact about the day that changes whether the hike is a good idea for the reader's
 * lungs. The dominant pollutant is the part worth printing beside the index — the European
 * AQI is the *worst* of five sub-indices rather than a blend, so naming it converts an
 * abstract number into something a hiker can act on. Ozone peaks on exposed ground in
 * afternoon sun; particulates do not.
 *
 * **The footprint line is not a disclaimer, it is the reading.** One number over a valley
 * invites the belief that it is about that valley. Saying "one 44 km cell" is what stops
 * this from claiming a precision the model has never had.
 *
 * Plate follows the same break as the map overlay and the flags: water below 60, survey at
 * and above it, where the index turns poor.
 */
function AirQuality({ reading }: { reading: AirQualityReading | null }) {
  if (reading === null) return null;

  const aqi = reading.europeanAqi;
  const band = europeanAqiBand(aqi);
  const poor = aqi !== null && aqi >= 60;
  const tone = poor ? 'text-survey' : 'text-water';
  const pollutant =
    reading.dominant === null ? null : AIR_QUALITY_POLLUTANT_LABELS[reading.dominant];
  const read = utcClock(reading.observedAt);

  return (
    <div className={`mt-md border-l-2 pl-md ${poor ? 'border-survey' : 'border-water'}`}>
      <div className="flex flex-wrap items-baseline gap-x-md gap-y-hair">
        <span className="collar">Air quality</span>
        {aqi === null ? (
          <span className="text-body text-ink-muted">Not reported for here just now</span>
        ) : (
          <>
            <span className={`font-mono text-body-lg tabular-nums ${tone}`}>{Math.round(aqi)}</span>
            <span className={`text-body ${tone}`}>{band?.label ?? '—'}</span>
            {pollutant === null ? null : (
              <span className="text-caption text-ink-muted">worst on {pollutant}</span>
            )}
          </>
        )}
      </div>

      <p className="mt-hair text-caption text-ink-muted">
        European AQI, one reading for the whole route — {reading.model} works in{' '}
        {Math.round(reading.stepDeg * 111)} km cells.
        {read === null ? null : <> Read at {read}.</>}
        {reading.pm25 === null ? null : <> Fine particulates {reading.pm25.toFixed(1)} µg/m³.</>}
      </p>
    </div>
  );
}

/**
 * The safety flags, already sorted most-severe-first by the model.
 *
 * Rendered in the order given rather than re-sorted here: the server sorts by severity and
 * then by position along the trail, so reading down the list is also hiking forwards.
 */
function Flags({ flags }: { flags: readonly WeatherFlag[] }) {
  if (flags.length === 0) {
    return (
      <p className="mt-md text-body text-ink-muted">
        Nothing on this forecast needs flagging. Read the times below anyway — the ridge is rarely
        the valley.
      </p>
    );
  }

  return (
    <ul className="mt-md flex flex-col">
      {flags.map((flag) => (
        <li
          key={`${flag.kind}-${flag.sampleIndex}`}
          className="grid grid-cols-[3px_1fr_auto] items-start gap-sm border-b border-bezel py-sm last:border-b-0"
        >
          <span
            aria-hidden
            className={`h-full rounded-pill ${
              flag.severity === 'warning'
                ? 'bg-survey'
                : flag.severity === 'caution'
                  ? 'bg-survey/45'
                  : 'bg-bezel'
            }`}
          />
          <p className={flag.severity === 'info' ? 'text-body text-ink-muted' : 'text-body'}>
            {flag.message}
          </p>
          <span
            className={`collar pt-hair ${flag.severity === 'warning' ? 'text-survey' : 'text-ink-muted'}`}
          >
            {SEVERITY_LABEL[flag.severity]}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Where the numbers came from and when.
 *
 * The hour matters. A forecast read at 06:00 and a forecast read at 18:00 are different
 * forecasts, and a page that shows one without saying which is asking to be trusted more
 * than it deserves. Sunrise and sunset sit here rather than in the table because they are
 * facts about the day, not about a point on the trail.
 */
function Provenance({ forecast }: { forecast: AlongRouteForecast }) {
  const sunrise = clockOf(forecast.sunriseAt);
  const sunset = clockOf(forecast.sunsetAt);
  const fetchedLabel = utcClock(forecast.fetchedAt);

  return (
    <p className="mt-md text-caption text-ink-muted">
      {sunrise === null ? null : <>Sunrise {sunrise} · </>}
      {sunset === null ? null : <>Sunset {sunset} · </>}
      Times are local to the trail ({forecast.timezone}). Hiking times are moving time at an average
      pace, with no stops.{' '}
      {fetchedLabel === null ? null : <>Forecast from Open-Meteo, read at {fetchedLabel}.</>}
    </p>
  );
}

/** Index of the highest sample, which is the row the whole table exists for. */
function highestIndex(samples: readonly WeatherSample[]): number {
  let best = -1;
  let bestEle = -Infinity;
  for (const [index, sample] of samples.entries()) {
    if (sample.eleM > bestEle) {
      bestEle = sample.eleM;
      best = index;
    }
  }
  return best;
}

/**
 * An instant as `14:00 UTC`, or `null` if it will not parse.
 *
 * UTC and labelled as such, not the reader's clock. Every other time on this page is local
 * to the *trail*, so rendering a provenance stamp in the browser's zone would put a third
 * clock on one screen with nothing to distinguish it — and the reader who notices would be
 * right to wonder which zone the arrival times were in.
 */
function utcClock(iso: string): string | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const hh = String(at.getUTCHours()).padStart(2, '0');
  const mm = String(at.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm} UTC`;
}
