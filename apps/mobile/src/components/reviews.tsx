import { useMemo, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import type { RatingSummary, Review, ReviewSort } from '@switchback/core';
import {
  REMOVED_NOTICE,
  REVIEW_SORTS,
  REVIEW_SORT_LABEL,
  formatDateLabel,
  plural,
} from '@switchback/core';
import { nativeTheme } from '@switchback/ui';
import { REVIEW_PAGE_SIZE } from '@/api/pages';
import { useTRPC } from '@/api/trpc';
import { Chip, ChipRail } from './chip';
import { ConditionChip } from './condition-chip';
import { ReportControl } from './report-control';
import { ReportForm } from './report-form';

/**
 * What people found when they got there.
 *
 * The same three blocks the website publishes, in the same order, because the order is an
 * argument rather than a layout: what the ground was like lately, then how well the trail is
 * thought of, then what individual people actually wrote. A hiker checking this from the
 * car park wants the first block; a hiker choosing between two trails wants the second.
 *
 * **This component fetches for itself**, unlike `Conditions` and `BusyTimes`, which are
 * handed their data by the screen. Those two are coupled — the start time a reader picks
 * from the busyness grid is the start time the forecast is drawn for — so the state has to
 * live above both. Nothing on this screen depends on a review, so lifting these queries into
 * the screen would buy nothing and put three more `useQuery`s in a component that already
 * has four.
 *
 * **Reading and writing, in that order.** The form to file a report sits at the very bottom,
 * behind one control, because a hiker who opened this section came to read what other people
 * found. An open form above the reports would make writing look like the point of the page
 * when reading is; a control that says which of the two things it will do — report, or edit
 * the one you already filed — is enough to be found by anyone who came to write.
 *
 * **The scale bar.** A rating prints as a map scale bar — one bar, five equal divisions,
 * ruled hairline, filled in the woodland plate — exactly as it does on the website. Not
 * stars. Stars are borrowed from a different kind of product and read as decoration beside a
 * contour section; a divided bar is what this map's own margin already contains, the
 * divisions are discrete because a rating is (nobody gave 4.3), and woodland is the plate
 * that already means *the trail itself, in good order*, which is the claim a rating makes.
 *
 * The bar appears on individual reports and deliberately **not** on the average, where
 * rounding 4.3 to four filled divisions would draw a measurement nobody made.
 */

const theme = nativeTheme('sheet');

/** Every division of the bar, drawn in order. */
const DIVISIONS = [1, 2, 3, 4, 5] as const;

export function Reviews({ trailId }: { trailId: string }) {
  const trpc = useTRPC();

  const [sort, setSort] = useState<ReviewSort>('recent');

  const summary = useQuery(trpc.reviews.summary.queryOptions({ trailId }));

  const list = useInfiniteQuery(
    trpc.reviews.list.infiniteQueryOptions(
      { trailId, sort, limit: REVIEW_PAGE_SIZE },
      { getNextPageParam: (page) => page.nextCursor },
    ),
  );

  const reviews = useMemo(
    () => list.data?.pages.flatMap((page) => page.reviews) ?? [],
    [list.data],
  );
  const total = list.data?.pages[0]?.total ?? summary.data?.count ?? 0;

  return (
    <View style={styles.block}>
      {/*
        The re-sort signal, as a word — see the note in `Conditions`. Not shown during the
        first fetch (`isPending`) or a page-append (`isFetchingNextPage`): neither of those is
        "the list you are reading is being replaced", and both already say so themselves.
      */}
      <View style={styles.heading}>
        <Text style={styles.collar}>Reports from the trail</Text>
        {list.isFetching && !list.isFetchingNextPage && !list.isPending ? (
          <Text style={styles.updating}>Updating</Text>
        ) : null}
      </View>

      {total > 1 ? (
        <ChipRail label="Sort">
          {REVIEW_SORTS.map((option) => (
            <Chip
              key={option}
              label={REVIEW_SORT_LABEL[option]}
              selected={option === sort}
              onPress={() => setSort(option)}
            />
          ))}
        </ChipRail>
      ) : null}

      {summary.data ? <Reported summary={summary.data} /> : null}
      {summary.data && summary.data.count > 0 ? <Ratings summary={summary.data} /> : null}

      {list.isPending ? (
        <Text style={styles.absent}>Reading the reports…</Text>
      ) : list.isError ? (
        <Text style={styles.absent}>
          The reports could not be loaded. Everything else on this screen is unaffected.
        </Text>
      ) : reviews.length === 0 ? (
        <Text style={styles.empty}>
          Nobody has reported on this trail yet. The figures above come from the map; what the
          ground was actually like has to come from someone who hiked it.
        </Text>
      ) : (
        <>
          {/* Full strength while a re-sort loads — the mark above carries the state. */}
          <View
            style={styles.rows}
            accessibilityState={{ busy: list.isFetching && !list.isFetchingNextPage }}
          >
            {reviews.map((review) => (
              <Row key={review.id} review={review} />
            ))}
          </View>

          {list.hasNextPage ? (
            <Pressable
              onPress={() => void list.fetchNextPage()}
              disabled={list.isFetchingNextPage}
              accessibilityRole="button"
              accessibilityState={{ disabled: list.isFetchingNextPage }}
              style={({ pressed }) => [styles.more, pressed ? styles.morePressed : null]}
            >
              {list.isFetchingNextPage ? (
                <ActivityIndicator color={theme.color.inkMuted} />
              ) : (
                <Text style={styles.moreLabel}>{`Show more · ${reviews.length} of ${total}`}</Text>
              )}
            </Pressable>
          ) : null}
        </>
      )}

      {/*
       * Last, and behind one control. Reading is what this section is for; writing is what a
       * few of its readers will also do, and putting the form under the reports is what says
       * so without a word of explanation.
       */}
      <ReportForm trailId={trailId} />
    </View>
  );
}

/**
 * The condition tally — the block this section exists for.
 *
 * Ordered by how many people said it, so the loudest ground truth is leftmost, and the
 * window is printed in the heading rather than implied. "12 reports" here is the honest
 * denominator: the tags are a proportion of the people who hiked it *recently*, not of
 * everyone who ever reviewed it, and quoting the all-time count beside a sixty-day tally
 * would misrepresent both numbers at once.
 */
function Reported({ summary }: { summary: RatingSummary }) {
  if (summary.recentConditions.length === 0) {
    if (summary.count === 0) return null;
    return (
      <Text style={styles.empty}>
        Nothing has been reported about the ground in the last {summary.windowDays} days.
      </Text>
    );
  }

  return (
    <View style={styles.reported}>
      <Text style={styles.collar}>
        {`Reported in the last ${summary.windowDays} days · ${summary.recentCount} ${plural(
          summary.recentCount,
          'report',
        )}`}
      </Text>
      <View style={styles.tally}>
        {summary.recentConditions.map(({ condition, count }) => (
          <ConditionChip key={condition} condition={condition} count={count} />
        ))}
      </View>
    </View>
  );
}

/**
 * The average and what it is an average of.
 *
 * The bars are set against a ruled track rather than floating, so an empty bucket is still a
 * visible row: a distribution with a hole in it is information, and a row that collapses to
 * nothing hides it.
 *
 * Collapsed to one accessibility node with the reading in a sentence. Five labelled rows of
 * two numbers each is eleven stops on the rotor to hear what one sentence says.
 */
function Ratings({ summary }: { summary: RatingSummary }) {
  const most = Math.max(...summary.histogram.map((bucket) => bucket.count), 1);

  return (
    <View
      style={styles.ratings}
      accessible
      accessibilityLabel={
        summary.average === null
          ? 'No ratings yet.'
          : `Rated ${summary.average.toFixed(1)} out of 5 from ${summary.count} reports: ${summary.histogram
              .map((bucket) => `${bucket.count} at ${bucket.rating}`)
              .join(', ')}.`
      }
    >
      <View style={styles.average}>
        <Text style={styles.averageValue}>
          {summary.average === null ? '—' : summary.average.toFixed(1)}
          <Text style={styles.averageOf}>/5</Text>
        </Text>
        <Text style={styles.collar}>
          {`${summary.count} ${summary.count === 1 ? 'report' : 'reports'}`}
        </Text>
      </View>

      <View style={styles.histogram}>
        {summary.histogram.map((bucket) => (
          <View key={bucket.rating} style={styles.bucket}>
            <Text style={styles.bucketRating}>{bucket.rating}</Text>
            <View style={styles.track}>
              <View style={[styles.fill, { width: `${(bucket.count / most) * 100}%` }]} />
            </View>
            <Text style={styles.bucketCount}>{bucket.count}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

/**
 * The rating, as a map scale bar. See this module's header for why it is not stars.
 *
 * The division rules change colour with the fill, which is what keeps it a scale bar: ruled
 * in woodland across the empty divisions and in canvas across the filled ones. Ruling them
 * all in woodland would make them invisible inside the fill, so a five would print as one
 * solid block — a bar with no divisions at all, which is the one reading this graphic must
 * never give. At the fill boundary no rule is drawn: the colour change is already the edge.
 */
export function ScaleBar({ value }: { value: number }) {
  return (
    <View style={styles.scale} accessible accessibilityLabel={`Rated ${value} out of 5`}>
      {DIVISIONS.map((division) => {
        const filled = division <= value;
        return (
          <View
            key={division}
            style={[
              styles.division,
              filled ? styles.divisionFilled : null,
              division === 1 ? null : filled ? styles.ruleOnFill : styles.rule,
            ]}
          />
        );
      })}
    </View>
  );
}

/**
 * One report.
 *
 * The date on the right is when they *hiked* it, which is the fact that decides whether the
 * mud is still there. When nobody recorded a hike date it says when the report was written
 * instead, and says which it is — printing both as a bare date is asking to be misread on
 * exactly the reports where it matters most.
 */
function Row({ review }: { review: Review }) {
  const name = review.author.name ?? review.author.username ?? 'A hiker';
  const edited = review.updatedAt.getTime() - review.createdAt.getTime() > 1000;

  return (
    <View style={[styles.row, review.isMine ? styles.rowMine : null]}>
      <View style={styles.rowHead}>
        {/*
         * No scale bar on a removed report. The server has already dropped its rating out
         * of the trail's average, so drawing the bar would put the one measurement on this
         * screen that corresponds to nothing — and it would be a rating the page is
         * asserting on behalf of a report it has just withdrawn.
         *
         * Keyed off `rating === null`, which is what the server sends on a removed row,
         * rather than off `hidden`: one value decides, so the two cannot disagree.
         */}
        {review.rating === null ? null : <ScaleBar value={review.rating} />}
        <Text style={styles.rowName} numberOfLines={1}>
          {name}
        </Text>
        {review.isMine ? <Text style={styles.rowYou}>You</Text> : null}
      </View>

      <Text style={styles.rowWhen}>
        {review.hikedOn !== null
          ? `Hiked ${formatDateLabel(review.hikedOn)}`
          : `Written ${formatDateLabel(review.createdAt.toISOString().slice(0, 10))}`}
        {edited && !review.hidden ? ' · edited' : ''}
      </Text>

      {/*
       * The tombstone, matching the website's. The row stays rather than disappearing,
       * because a report that silently vanishes reads to whoever wrote it as a bug in the
       * app rather than as a decision somebody made — and they are exactly the person who
       * has to be able to argue with it.
       *
       * The short notice on every row, including your own. The longer sentence with the
       * address lives once per screen, in the form slot `ReportForm` renders above this
       * list, which is where the author arrives to type and where the refusal has to be
       * explained before they try. Printing it in both places put the identical sentence on
       * screen twice within one scroll, styled two different ways, which reads as two
       * decisions about one takedown.
       */}
      {review.hidden ? <Text style={styles.rowRemoved}>{REMOVED_NOTICE}</Text> : null}

      {review.body === null ? null : <Text style={styles.rowBody}>{review.body}</Text>}

      {review.conditions.length === 0 ? null : (
        <View style={styles.rowChips}>
          {review.conditions.map((condition) => (
            <ConditionChip key={condition} condition={condition} />
          ))}
        </View>
      )}

      {review.activityType !== null || review.helpfulCount > 0 ? (
        <Text style={styles.rowFooter}>
          {[
            review.activityType === null ? null : review.activityType.replace(/_/g, ' '),
            review.helpfulCount > 0 ? `${review.helpfulCount} found this useful` : null,
          ]
            .filter((part): part is string => part !== null)
            .join(' · ')}
        </Text>
      ) : null}

      {/*
       * Somebody else's report, so it carries the way to complain about it. Not on your own
       * — reporting yourself is not a thing anybody needs — and not on a removed one, which
       * has already been acted on and has nothing left on screen to object to.
       */}
      {review.isMine || review.hidden ? null : (
        <ReportControl subject="review" subjectId={review.id} what={`this report by ${name}`} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  block: { gap: theme.space.md },
  heading: { flexDirection: 'row', alignItems: 'baseline', gap: theme.space.sm },
  collar: { ...theme.collarLabel, color: theme.color.inkMuted },
  updating: { ...theme.collarLabel, color: theme.color.ink },

  absent: {
    ...theme.text('caption', { family: 'text' }),
    color: theme.color.inkMuted,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.bezel,
    borderStyle: 'dashed',
    borderRadius: theme.radius.hair,
    padding: theme.space.lg,
  },
  // No box. An empty section is not a failure, and a dashed frame around "nobody has been
  // here yet" makes an ordinary fact look like something went wrong.
  empty: { ...theme.text('body', { family: 'text' }), color: theme.color.inkMuted },

  reported: { gap: theme.space.sm },
  tally: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.xs },

  ratings: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.bezel,
    borderRadius: theme.radius.hair,
    padding: theme.space.md,
  },
  average: {
    gap: theme.space.hair,
    paddingRight: theme.space.lg,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: theme.color.bezel,
  },
  averageValue: { ...theme.text('h4', { family: 'mono' }), color: theme.color.ink },
  averageOf: { ...theme.text('title', { family: 'mono' }), color: theme.color.inkMuted },

  histogram: { flex: 1, gap: theme.space.hair },
  bucket: { flexDirection: 'row', alignItems: 'center', gap: theme.space.sm },
  bucketRating: { ...theme.text('micro', { family: 'mono' }), color: theme.color.inkMuted },
  // Fixed so the counts form a column rather than jittering left as they gain a digit.
  bucketCount: {
    ...theme.text('micro', { family: 'mono' }),
    color: theme.color.inkMuted,
    width: 22,
    textAlign: 'right',
  },
  track: {
    flex: 1,
    height: 8,
    borderRadius: theme.radius.hair,
    backgroundColor: theme.color.bezel,
  },
  fill: { height: '100%', borderRadius: theme.radius.hair, backgroundColor: theme.color.woodland },

  scale: {
    flexDirection: 'row',
    width: 60,
    height: 11,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.woodland,
    borderRadius: theme.radius.hair,
    overflow: 'hidden',
  },
  division: { flex: 1 },
  divisionFilled: { backgroundColor: theme.color.woodland },
  rule: { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: theme.color.woodland },
  ruleOnFill: { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: theme.color.canvas },

  rows: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.color.bezel },
  row: {
    gap: theme.space.sm,
    paddingVertical: theme.space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.color.bezel,
    borderLeftWidth: 2,
    borderLeftColor: 'transparent',
  },
  // Ink, not a plate. "Yours" is a fact about the reader rather than about the trail, and
  // spending a separation on it would make every other rail on this screen mean less.
  rowMine: { borderLeftColor: theme.color.ink, paddingLeft: theme.space.sm },

  rowHead: { flexDirection: 'row', alignItems: 'center', gap: theme.space.sm },
  rowName: { ...theme.text('caption', { weight: 'medium' }), color: theme.color.ink, flex: 1 },
  rowYou: { ...theme.collarLabel, color: theme.color.inkMuted },
  rowWhen: { ...theme.text('micro', { family: 'mono' }), color: theme.color.inkMuted },
  // Body in the serif, the same as the description above it. This is the one piece of prose
  // on the screen a person wrote by hand, and setting it in the caption size the numbers use
  // would file it with the instrument readings.
  rowBody: { ...theme.text('body', { family: 'text' }), color: theme.color.ink },
  /* A dashed hairline and muted ink — the same treatment as this screen's other absences. */
  rowRemoved: {
    ...theme.text('caption'),
    color: theme.color.inkMuted,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: theme.color.bezel,
    borderRadius: theme.radius.hair,
    paddingHorizontal: theme.space.md,
    paddingVertical: theme.space.sm,
    marginTop: theme.space.sm,
  },
  rowChips: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.xs },
  rowFooter: { ...theme.collarLabel, color: theme.color.inkMuted },

  more: {
    alignSelf: 'flex-start',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.bezel,
    borderRadius: theme.radius.hair,
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.md,
  },
  morePressed: { borderColor: theme.color.ink },
  moreLabel: { ...theme.collarLabel, color: theme.color.ink },
});
