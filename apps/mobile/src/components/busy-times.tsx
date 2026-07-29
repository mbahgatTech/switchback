import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { BusynessForecast, BusynessLevel } from '@switchback/core';
import { BUSYNESS_LEVEL_LABEL, DAY_NAMES, DAY_NAMES_SHORT, formatHour } from '@switchback/core';
import { BUSYNESS_INK, CONTROL_HEIGHT, nativeTheme, withAlpha } from '@switchback/ui';

/**
 * Busy times — the culture plate, on a phone.
 *
 * On a quadrangle the culture plate carries the works of man and prints in black. So do
 * crowds, and so does this grid: one ink coverage per level, no hue at all. That is not
 * timidity, it is what leaves the four coloured plates meaning what they mean everywhere
 * else — red is still the reader's safety, blue is still the weather, and people are black
 * like a road. The coverages come from `BUSYNESS_INK`, the same four numbers the website
 * uses, resolved to alpha here because React Native has no `color-mix()`.
 *
 * **168 cells, seven sentences.** A cell is unreadable one at a time and useless to a
 * screen reader — 168 announcements of nothing. So the cells are hidden from the
 * accessibility tree and each day row carries one written summary instead, exactly the
 * contract the section graphic keeps.
 *
 * **One control.** The recommendation is a weekday and an hour; the button beside it hands
 * that start to the conditions block above. That single link is the whole reason both
 * features share a screen — go when it is empty, and know what the weather will be doing
 * when you do.
 */

const theme = nativeTheme('sheet');

const LEVELS: readonly BusynessLevel[] = ['quiet', 'moderate', 'busy', 'packed'];
const HOUR_TICKS = [0, 6, 12, 18];

function ink(level: BusynessLevel): string {
  return withAlpha(theme.color.ink, BUSYNESS_INK[level]);
}

export interface BusyTimesProps {
  forecast: BusynessForecast | null;
  isPending: boolean;
  error: string | null;
  /** Marks the row for the day it actually is at the trail, when that is known. */
  todayDayOfWeek?: number | null;
  /** Hands the recommended slot to the conditions block. Absent until a forecast lands. */
  onPickStart?: ((dayOfWeek: number, hour: number) => void) | undefined;
}

export function BusyTimes({
  forecast,
  isPending,
  error,
  todayDayOfWeek = null,
  onPickStart,
}: BusyTimesProps) {
  return (
    <View style={styles.block}>
      <View style={styles.header}>
        <Text style={styles.collar}>Busy times</Text>
        {forecast === null ? null : (
          <Text style={styles.confidence}>{confidenceLine(forecast)}</Text>
        )}
      </View>

      {error !== null ? (
        <Text style={styles.absent}>{error}</Text>
      ) : isPending || forecast === null ? (
        <Text style={styles.absent}>Working out when this trail is quiet…</Text>
      ) : (
        <>
          {forecast.recommendation === null ? null : (
            <View style={styles.recommendation}>
              <Text style={styles.recommendationText}>
                <Text style={styles.recommendationStrong}>
                  Quietest {DAY_NAMES[forecast.recommendation.dayOfWeek] ?? 'this week'} around{' '}
                  {formatHour(forecast.recommendation.hour)}
                </Text>
                {` — ${forecast.recommendation.reason}`}
              </Text>
              {onPickStart === undefined ? null : (
                <Pressable
                  onPress={() =>
                    onPickStart(
                      forecast.recommendation?.dayOfWeek ?? 0,
                      forecast.recommendation?.hour ?? 7,
                    )
                  }
                  accessibilityRole="button"
                  hitSlop={theme.space.sm}
                  style={({ pressed }) => [styles.pick, pressed ? styles.pickPressed : null]}
                >
                  <Text style={styles.pickLabel}>Forecast that start</Text>
                </Pressable>
              )}
            </View>
          )}

          {/*
           * Ticks are positioned by percentage rather than laid out in the 24-column grid:
           * a two-digit label is wider than an 11pt cell, and letting it participate in the
           * layout would push the columns out of line with the rows beneath.
           */}
          <View style={styles.tickRow} importantForAccessibility="no-hide-descendants">
            <View style={styles.gutter} />
            <View style={styles.tickTrack}>
              {HOUR_TICKS.map((hour) => (
                <Text key={hour} style={[styles.tick, { left: `${(hour / 24) * 100}%` }]}>
                  {String(hour).padStart(2, '0')}
                </Text>
              ))}
            </View>
          </View>

          <View style={styles.grid}>
            {forecast.week.map((day) => {
              const recommended =
                forecast.recommendation?.dayOfWeek === day.dayOfWeek
                  ? forecast.recommendation.hour
                  : null;

              return (
                <View
                  key={day.dayOfWeek}
                  style={styles.dayRow}
                  accessible
                  accessibilityLabel={`${DAY_NAMES[day.dayOfWeek]}: busiest around ${formatHour(
                    day.peakHour,
                  )}, quietest daylight hour around ${formatHour(day.quietestHour)}.`}
                >
                  <Text
                    style={[
                      styles.dayLabel,
                      day.dayOfWeek === todayDayOfWeek ? styles.dayToday : null,
                    ]}
                  >
                    {DAY_NAMES_SHORT[day.dayOfWeek]}
                  </Text>
                  <View style={styles.cells}>
                    {day.hours.map((slot) => (
                      <View
                        key={slot.hour}
                        style={[
                          styles.cell,
                          { backgroundColor: ink(slot.level) },
                          slot.hour === recommended ? styles.cellRecommended : null,
                        ]}
                      />
                    ))}
                  </View>
                </View>
              );
            })}
          </View>

          <View style={styles.legend} importantForAccessibility="no-hide-descendants">
            {LEVELS.map((level) => (
              <View key={level} style={styles.legendItem}>
                <View style={[styles.swatch, { backgroundColor: ink(level) }]} />
                <Text style={styles.legendLabel}>{BUSYNESS_LEVEL_LABEL[level]}</Text>
              </View>
            ))}
          </View>

          <Text style={styles.footer}>
            An estimate, not a measurement. Modelled from how well used this trail is, its parking,
            the season and{' '}
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
          </Text>
        </>
      )}
    </View>
  );
}

/**
 * How much of this is measured, and how crowded "busy" actually gets here.
 *
 * `peakLevel` is the antidote to a normalised grid: the cells say *when*, and only this
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

/** The day-label gutter. One number, used by the ticks and the rows so they cannot drift. */
const GUTTER = 34;

const styles = StyleSheet.create({
  block: { gap: theme.space.md },
  header: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: theme.space.sm,
  },
  collar: { ...theme.collarLabel, color: theme.color.inkMuted },
  confidence: {
    ...theme.text('micro', { family: 'mono' }),
    color: theme.color.inkMuted,
    flexShrink: 1,
    textAlign: 'right',
  },

  absent: {
    ...theme.text('caption', { family: 'text' }),
    color: theme.color.inkMuted,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.bezel,
    borderStyle: 'dashed',
    borderRadius: theme.radius.hair,
    padding: theme.space.lg,
  },

  recommendation: {
    gap: theme.space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.color.bezel,
    paddingBottom: theme.space.md,
  },
  // Italic serif — the hydrography convention. Narrative about conditions is set the way a
  // sheet sets the name of a river, not the way it sets a spot height.
  recommendationText: {
    ...theme.text('body', { family: 'text', weight: 'italic' }),
    color: theme.color.inkMuted,
  },
  recommendationStrong: { color: theme.color.ink },
  pick: {
    alignSelf: 'flex-start',
    minHeight: CONTROL_HEIGHT.touch,
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.ink,
    borderRadius: theme.radius.hair,
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.sm,
  },
  pickPressed: { backgroundColor: theme.color.ink },
  pickLabel: { ...theme.collarLabel, color: theme.color.ink },

  tickRow: { flexDirection: 'row', alignItems: 'flex-end', gap: theme.space.xs },
  gutter: { width: GUTTER },
  tickTrack: { flex: 1, height: 12 },
  tick: {
    ...theme.text('micro', { family: 'mono' }),
    color: theme.color.inkMuted,
    position: 'absolute',
    bottom: 0,
  },

  grid: { gap: 1 },
  dayRow: { flexDirection: 'row', alignItems: 'center', gap: theme.space.xs },
  dayLabel: { ...theme.collarLabel, color: theme.color.inkMuted, width: GUTTER },
  dayToday: { color: theme.color.ink },
  cells: { flex: 1, flexDirection: 'row', gap: 1 },
  cell: { flex: 1, height: theme.space.lg },
  // A ring rather than a fill: the cell still has to report its own level, and overwriting
  // it with a marker would hide the one number the recommendation is a claim about.
  //
  // A literal 1 rather than `hairlineWidth` or a token, and this is the one place in the
  // file where that is right. This is a mark inside a chart, sized in the chart's own terms
  // like the 3pt condition stripes — not chrome. `hairlineWidth` would vanish against the
  // 1pt gutters ruled between every cell; 2 would eat an eighth of a cell that is only
  // `space.lg` tall. The website draws the same ring at 1.5px inset, arriving at the same
  // answer from the other side.
  cellRecommended: { borderWidth: 1, borderColor: theme.color.ink },

  legend: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: theme.space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.color.bezel,
    paddingTop: theme.space.sm,
  },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: theme.space.xs },
  swatch: {
    width: theme.space.lg,
    height: theme.space.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.bezel,
  },
  legendLabel: { ...theme.collarLabel, color: theme.color.inkMuted },

  // Caption, like the website's. `micro` is the collar size and carries collar
  // letterspacing; a paragraph set in it reads as a legend key that ran on too long.
  footer: { ...theme.text('caption', { family: 'text' }), color: theme.color.inkMuted },
});
