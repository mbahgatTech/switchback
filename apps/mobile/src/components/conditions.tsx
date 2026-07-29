import { StyleSheet, Text, View } from 'react-native';
import type { AlongRouteForecast, UnitSystem, WeatherFlag, WeatherSample } from '@switchback/core';
import {
  clockOf,
  compassPoint,
  formatDayLabel,
  formatDistance,
  formatElevation,
  formatHour,
  formatSpeed,
  formatTemperature,
  weatherCodeLabel,
} from '@switchback/core';
import { nativeTheme } from '@switchback/ui';
import { Chip, ChipRail } from './chip';

/**
 * Conditions on the way, on a phone.
 *
 * The website publishes this as a timetable — eight columns, one row per point you will
 * stand on. Eight columns do not fit here and shrinking them until they do produces a
 * table nobody can read, so each point gets **two lines instead of one**: where and when on
 * the first, what it will be doing on the second. Same rows, same order, same question —
 * *what will it be doing when I get there?* — folded rather than truncated. Nothing is
 * dropped, which matters because the point of this feature is the difference between the
 * car park and the summit, and a phone is where you check it from the car park.
 *
 * This is also the row the section's doc comment promised: the graphic on this screen
 * carries no callouts, because 46pt of collar cannot hold "Summit 11:20 · 1 °C · gusts 61"
 * legibly. It goes here, at full size, for every sample rather than two.
 *
 * **Plate discipline is identical to the website's.** Weather is the water plate; survey —
 * red — appears only on the safety flags and the rows they point at. A gust warning and a
 * rain shower are not the same kind of fact and must not be the same colour.
 *
 * **Missing readings are em dashes.** A forecast that looks equally confident about
 * everything is the one thing this must never be.
 */

const theme = nativeTheme('sheet');

const HOURS = Array.from({ length: 24 }, (_, i) => i);

const SEVERITY_LABEL = { warning: 'Warning', caution: 'Caution', info: 'Note' } as const;

export interface ConditionsProps {
  forecast: AlongRouteForecast | null;
  /** True before the first forecast has ever arrived; false while merely re-fetching. */
  isPending: boolean;
  /** True whenever a request is in flight, including a re-fetch over readings on screen. */
  isFetching: boolean;
  error: string | null;
  /** Effective start, local to the trail. `null` only before the first forecast lands. */
  date: string | null;
  hour: number | null;
  /** Every date the control offers, ascending. */
  dateOptions: readonly string[];
  onStartChange: (date: string, hour: number) => void;
  units?: UnitSystem;
}

export function Conditions({
  forecast,
  isPending,
  isFetching,
  error,
  date,
  hour,
  dateOptions,
  onStartChange,
  units = 'metric',
}: ConditionsProps) {
  const samples = forecast?.samples ?? [];
  const highIndex = highestIndex(samples);
  const warned = new Set(
    (forecast?.flags ?? [])
      .filter((flag) => flag.severity === 'warning')
      .map((flag) => flag.sampleIndex),
  );

  return (
    <View style={styles.block}>
      {/*
       * The re-fetch signal, as a word — the same change the web block carries, for the same
       * reason. This used to dim the readings to 45 % while a new start loaded, which was the
       * right instinct (the rows on screen are still true, just for the previous hour) served
       * by the wrong instrument: `inkMuted` starts at 4.83:1 and there is no fade of it that
       * stays readable. See the note on `SCHEMES` in `packages/ui`.
       *
       * Unlike the web twin this one is not hidden from VoiceOver — it *is* the accessible
       * signal. `accessibilityLiveRegion` is Android-only and the reliable iOS route is an
       * imperative announcement, so the state is carried declaratively by `busy` below and by
       * a word that is simply there to be read.
       *
       * `!isPending` because "updating" is a claim about readings already on screen. During
       * the first fetch there are none, and the block below is already saying so.
       */}
      <View style={styles.heading}>
        <Text style={styles.collar}>Conditions on the way</Text>
        {isFetching && !isPending ? <Text style={styles.updating}>Updating</Text> : null}
      </View>

      {/*
       * Rails of chips, not a picker. A wheel picker hides every option but one behind a
       * tap and a modal; the whole reason to plan on this screen is comparing Saturday
       * with Tuesday, which means both have to be visible and one thumb away.
       *
       * Two rails, not three. Pace belongs to the hiker rather than the trail — it will
       * live in settings, where it can also correct the headline time estimate, instead of
       * being re-answered on every trail.
       */}
      <View style={styles.dials}>
        <ChipRail label="Leaving">
          {dateOptions.map((option) => (
            <Chip
              key={option}
              label={formatDayLabel(option)}
              selected={option === date}
              disabled={date === null}
              onPress={() => onStartChange(option, hour ?? 7)}
            />
          ))}
        </ChipRail>
        <ChipRail label="At">
          {HOURS.map((option) => (
            <Chip
              key={option}
              label={formatHour(option)}
              selected={option === hour}
              disabled={date === null}
              onPress={() => onStartChange(date ?? '', option)}
            />
          ))}
        </ChipRail>
      </View>

      {error !== null ? (
        <Text style={styles.absent}>{error}</Text>
      ) : isPending ? (
        <Text style={styles.absent}>Reading the forecast for this route…</Text>
      ) : forecast === null ? null : (
        // Full strength while a new start loads — the "Updating" mark above carries the
        // state now, and `busy` says the same thing to VoiceOver.
        <View accessibilityState={{ busy: isFetching }}>
          <Flags flags={forecast.flags} />

          <View style={styles.rows}>
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
          </View>

          <Provenance forecast={forecast} />
        </View>
      )}
    </View>
  );
}

/**
 * One point on the route: where and when, then what it will be doing there.
 *
 * The named points are the trailhead, the high point and the finish; the rest are
 * distances, and printing "6.4 km" twice on one row is noise. So the middle rows carry the
 * distance alone and the second line does all the work.
 */
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

  const readings = [
    sample.temperatureC === null ? '—' : formatTemperature(sample.temperatureC, units),
    // "gusts 61 km/h NW", not a bare 61: the website can put the word in a column header
    // and a row of prose cannot, and an unlabelled gust read as a sustained wind is the
    // kind of quiet error that gets someone blown off a ridge.
    wind === null
      ? '—'
      : `${sample.windGustsKmh === null ? '' : 'gusts '}${formatSpeed(wind, units)}${
          bearing === null ? '' : ` ${bearing}`
        }`,
    sample.precipitationProbability === null ? '—' : `${sample.precipitationProbability} %`,
    sky,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');

  return (
    <View
      style={[styles.row, high ? styles.rowHigh : null, warned ? styles.rowWarned : null]}
      accessible
      accessibilityLabel={`${sample.label}, ${formatDistance(sample.distM, units)}, arriving ${
        clockOf(sample.arrivalAt) ?? 'at an unknown time'
      }. ${readings}. Altitude ${formatElevation(sample.eleM, units)}.`}
    >
      <View style={styles.rowHead}>
        <Text style={styles.rowDist}>{formatDistance(sample.distM, units)}</Text>
        <Text style={styles.rowLabel} numberOfLines={1}>
          {named ? sample.label : ''}
        </Text>
        <Text style={styles.rowArrive}>{clockOf(sample.arrivalAt) ?? '—'}</Text>
      </View>
      <View style={styles.rowBody}>
        <Text style={styles.rowReadings} numberOfLines={2}>
          {readings}
        </Text>
        <Text style={styles.rowEle}>{formatElevation(sample.eleM, units)}</Text>
      </View>
    </View>
  );
}

/**
 * The safety flags, in the order the model gave them — severity first, then position along
 * the trail, so reading down the list is also hiking forwards.
 */
function Flags({ flags }: { flags: readonly WeatherFlag[] }) {
  if (flags.length === 0) {
    return (
      <Text style={styles.clear}>
        Nothing on this forecast needs flagging. Read the times below anyway — the ridge is rarely
        the valley.
      </Text>
    );
  }

  return (
    <View style={styles.flags}>
      {flags.map((flag) => (
        <View key={`${flag.kind}-${flag.sampleIndex}`} style={styles.flag}>
          <View
            style={[
              styles.flagRule,
              flag.severity === 'warning'
                ? styles.flagWarning
                : flag.severity === 'caution'
                  ? styles.flagCaution
                  : styles.flagInfo,
            ]}
          />
          <Text style={[styles.flagText, flag.severity === 'info' ? styles.flagMuted : null]}>
            {flag.message}
          </Text>
          <Text style={[styles.flagSeverity, flag.severity === 'warning' ? styles.flagRed : null]}>
            {SEVERITY_LABEL[flag.severity]}
          </Text>
        </View>
      ))}
    </View>
  );
}

/**
 * Where the numbers came from and when.
 *
 * The hour matters: a forecast read at 06:00 and one read at 18:00 are different forecasts,
 * and showing one without saying which asks to be trusted more than it deserves. Sunrise
 * and sunset sit here rather than in the rows because they are facts about the day, not
 * about a point on the trail.
 */
function Provenance({ forecast }: { forecast: AlongRouteForecast }) {
  const sunrise = clockOf(forecast.sunriseAt);
  const sunset = clockOf(forecast.sunsetAt);
  const fetched = new Date(forecast.fetchedAt);
  const fetchedLabel = Number.isNaN(fetched.getTime())
    ? null
    : `${String(fetched.getUTCHours()).padStart(2, '0')}:${String(fetched.getUTCMinutes()).padStart(
        2,
        '0',
      )} UTC`;

  return (
    <Text style={styles.provenance}>
      {sunrise === null ? '' : `Sunrise ${sunrise} · `}
      {sunset === null ? '' : `Sunset ${sunset} · `}
      Times are local to the trail ({forecast.timezone}). Hiking times are moving time at an average
      pace, with no stops.
      {fetchedLabel === null ? '' : ` Forecast from Open-Meteo, read at ${fetchedLabel}.`}
    </Text>
  );
}

/** Index of the highest sample, which is the row the whole list exists for. */
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

const styles = StyleSheet.create({
  block: { gap: theme.space.md },
  heading: { flexDirection: 'row', alignItems: 'baseline', gap: theme.space.sm },
  collar: { ...theme.collarLabel, color: theme.color.inkMuted },
  updating: { ...theme.collarLabel, color: theme.color.ink },

  dials: { gap: theme.space.sm },

  absent: {
    ...theme.text('caption', { family: 'text' }),
    color: theme.color.inkMuted,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.bezel,
    borderStyle: 'dashed',
    borderRadius: theme.radius.hair,
    padding: theme.space.lg,
  },

  clear: { ...theme.text('caption', { family: 'text' }), color: theme.color.inkMuted },
  flags: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.color.bezel },
  flag: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.space.sm,
    paddingVertical: theme.space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.color.bezel,
  },
  // A stripe rather than an icon: severity is carried by weight of the same colour, so a
  // caution cannot be mistaken for a second kind of warning.
  flagRule: { width: 3, alignSelf: 'stretch' },
  flagWarning: { backgroundColor: theme.color.survey },
  flagCaution: { backgroundColor: theme.color.surveyWash },
  flagInfo: { backgroundColor: theme.color.bezel },
  // Body, matching the website. These are the sentences that say someone should turn back,
  // and they are the most important text on the screen — a caption-sized warning under a
  // caption-sized timetable is a warning nobody reads.
  flagText: { ...theme.text('body', { family: 'text' }), color: theme.color.ink, flex: 1 },
  flagMuted: { color: theme.color.inkMuted },
  flagSeverity: { ...theme.collarLabel, color: theme.color.inkMuted, paddingTop: theme.space.hair },
  flagRed: { color: theme.color.survey },

  rows: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.color.bezel },
  row: {
    gap: theme.space.hair,
    paddingVertical: theme.space.sm,
    paddingLeft: theme.space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.color.bezel,
    borderLeftWidth: 2,
    borderLeftColor: 'transparent',
  },
  // The water plate, on the one row this whole feature exists to show. The left rail says
  // why a row matters and only ever one thing at a time — water for the summit, survey for
  // a row a warning points at, and `rowWarned` comes last in the style array because if the
  // top of the hike is also the dangerous part, safety is the colour that has to survive.
  rowHigh: { backgroundColor: theme.color.waterWash, borderLeftColor: theme.color.water },
  // The flag list says what is wrong; this says where.
  rowWarned: { borderLeftColor: theme.color.survey },

  rowHead: { flexDirection: 'row', alignItems: 'baseline', gap: theme.space.sm },
  // Fixed so the distances form a column the eye can run straight down, which is the only
  // reason a list ordered by distance beats a list ordered by importance.
  rowDist: { ...theme.text('caption', { family: 'mono' }), color: theme.color.inkMuted, width: 64 },
  rowLabel: { ...theme.text('caption', { weight: 'medium' }), color: theme.color.ink, flex: 1 },
  rowArrive: {
    ...theme.text('caption', { family: 'mono', weight: 'medium' }),
    color: theme.color.ink,
  },

  rowBody: { flexDirection: 'row', alignItems: 'baseline', gap: theme.space.sm },
  // Full width rather than hung under the label. A 64pt indent is a fifth of a phone, and
  // this line carries the readings the whole feature exists to publish — it gets the space
  // and it gets ink, not the muted grey a caption would take.
  rowReadings: {
    ...theme.text('caption', { family: 'mono' }),
    color: theme.color.ink,
    flex: 1,
  },
  rowEle: { ...theme.text('micro', { family: 'mono' }), color: theme.color.inkMuted },

  // Caption rather than micro: `micro` carries +0.14em of collar letterspacing, which is
  // right for an uppercase legend key and wrong for a running sentence.
  provenance: {
    ...theme.text('caption', { family: 'text' }),
    color: theme.color.inkMuted,
    paddingTop: theme.space.sm,
  },
});
