'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type {
  RatingSummary,
  UserRole,
  Review,
  ReviewPhoto,
  ReviewSort,
  TrailCondition,
} from '@switchback/core';
import {
  REMOVED_NOTICE,
  REMOVED_NOTICE_OWN,
  REVIEW_SORTS,
  REVIEW_SORT_LABEL,
  TRAIL_CONDITION_LABEL,
  blurhashAverageColor,
  canModerate,
  formatDateLabel,
  plural,
} from '@switchback/core';
import { CONDITION_PLATE } from '@switchback/ui';
import { askAgain } from '../../lib/after-write';
import { useTRPC } from '../../trpc/react';
import { ReviewForm } from './review-form';
import { ModerateControl, ReportControl } from '../moderation/report-control';
import { Photograph, PhotographMissing, PhotographUnavailable } from '../photos/photograph';
import { BUTTON_COLLAR, HEIGHT, SECONDARY } from '../controls';

/**
 * What people found when they got there.
 *
 * The one part of this product that OpenStreetMap cannot supply, and so the part that has to
 * earn its own space rather than borrow the map's. Three blocks, ordered by what a hiker
 * standing at the car park actually needs:
 *
 * 1. **Reported lately** — the condition tags from the last sixty days, tallied. This is the
 *    block that justifies the section. Everything else on this page describes the trail as it
 *    is on paper; this describes the ground as it was last week, and it sits directly under
 *    the forecast for the same reason a wet Tuesday matters more than a four-star average.
 * 2. **Ratings** — the number and the distribution beside it. A mean with nothing under it
 *    hides the trail that is loved by nine people and hated by one, and that trail is a
 *    different proposition from the one that is quietly liked by ten.
 * 3. **The reports themselves**, newest first.
 *
 * **The scale bar.** A rating prints as a map scale bar — one bar, five equal divisions,
 * hairline ruled, filled in the woodland plate. Not stars. Stars are a borrowed convention
 * from a different kind of product and they read as decoration next to a contour section;
 * a divided bar is what this map's margin already contains, the divisions are discrete
 * because the rating is (nobody can say 4.3), and woodland is the plate that already means
 * *the trail itself, in good order*, which is exactly the claim a rating makes.
 *
 * The bar appears on individual reports and deliberately **not** on the average. Rounding
 * 4.3 up to four filled divisions would draw a measurement nobody made. The average is a
 * statistic, so it prints as a number over its distribution, which is what statistics look
 * like on a survey sheet.
 */

export interface ReviewsProps {
  trailId: string;
  /** Only used if a report has to be kept on the device — a queue row has no page to read it from. */
  trailName: string;
  /** Where to send someone who has to sign in first, so they come back here. */
  trailPath: string;
  /** Null when signed out — the only thing this section needs to know about the viewer. */
  viewerId: string | null;
  /**
   * What the viewer may do about somebody else's report. `member` for everybody who is not
   * an operator, and for everybody signed out.
   *
   * It decides whether a take-down control is *drawn*. It does not decide whether one
   * works: `moderatorProcedure` on the server does, and it re-reads the column on every
   * call. A forged role here buys a button that returns FORBIDDEN.
   */
  viewerRole?: UserRole;
}

const PAGE_SIZE = 8;

/**
 * Chip treatment per plate. Written out rather than composed, because Tailwind reads class
 * names literally out of the source and a `border-${plate}/40` would compile to nothing.
 *
 * **A hairline and the plate colour, with no wash behind it.** These carried
 * `bg-<plate>-wash` — the same 12 % tint the map fills with — and it put plate-coloured text
 * on plate-coloured ground, which costs about 0.8 of contrast and is the one background the
 * token test never measures: it checks each ink against `canvas` and `surface`, and a wash is
 * neither. On the sheet that took survey and water to 4.44:1 and left contour at 4.54:1, and
 * on the field scheme survey over a card measured 4.03:1. Worse, *which* of those applied
 * depended on whether the chip happened to sit on the page or inside a panel — the same
 * undefined-backdrop problem as a translucent panel over the map, in miniature.
 *
 * Without the wash the figure stops depending on the container: 5.32–5.42 on the sheet,
 * 4.68–8.47 on the field, everywhere these render. It also makes the family consistent, since
 * `CHIP_PLAIN` below was already a hairline with no fill — the plated chips were the odd ones.
 */
const CHIP_PLATE = {
  survey: 'border-survey/40 text-survey',
  water: 'border-water/40 text-water',
  woodland: 'border-woodland/40 text-woodland',
} as const;

/** A tag on no plate: reported, nobody's safety, so it prints as a hairline and no colour. */
const CHIP_PLAIN = 'border-bezel text-ink-muted';

export function chipClass(condition: TrailCondition): string {
  const plate = CONDITION_PLATE[condition];
  return plate === null ? CHIP_PLAIN : CHIP_PLATE[plate];
}

/** Whoever wrote it, by whatever name they have given us. */
function hikerName(review: Review): string {
  return review.author.name ?? review.author.username ?? 'A hiker';
}

/** What the viewer is showing: one report's photographs, and which of them is up. */
interface PhotoView {
  photos: ReviewPhoto[];
  index: number;
  /** The frames leave the line above behind, so the dialog carries the name itself. */
  author: string;
}

export function Reviews({
  trailId,
  trailName,
  trailPath,
  viewerId,
  viewerRole = 'member',
}: ReviewsProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const [sort, setSort] = useState<ReviewSort>('recent');
  const [viewing, setViewing] = useState<PhotoView | null>(null);

  const summary = useQuery(trpc.reviews.summary.queryOptions({ trailId }));

  const list = useInfiniteQuery(
    trpc.reviews.list.infiniteQueryOptions(
      { trailId, sort, limit: PAGE_SIZE },
      { getNextPageParam: (page) => page.nextCursor },
    ),
  );

  // The caller's own report, for prefilling the form. Only asked for when there is a caller:
  // the procedure is protected, and firing it signed out would be a guaranteed 401 per page.
  const mine = useQuery({
    ...trpc.reviews.mine.queryOptions({ trailId }),
    enabled: viewerId !== null,
  });

  const reviews = useMemo(
    () => list.data?.pages.flatMap((page) => page.reviews) ?? [],
    [list.data],
  );
  const total = list.data?.pages[0]?.total ?? summary.data?.count ?? 0;

  /**
   * One invalidation for the whole router.
   *
   * A write moves the list, the distribution, and the caller's own row at once, and naming
   * the three query keys separately is three chances to forget one when a fourth arrives.
   *
   * `askAgain` rather than a bare invalidation because a report can be filed while the
   * page's first batch is still in the air — see `lib/after-write.ts` for what that costs.
   */
  function refetchAll(): void {
    void askAgain(queryClient, trpc.reviews.pathFilter());
  }

  /** Wraps at both ends, so a six-frame report is a loop rather than a dead arrow. */
  const stepView = useCallback((delta: number): void => {
    setViewing((current) => {
      if (current === null || current.photos.length === 0) return current;
      const count = current.photos.length;
      return { ...current, index: (current.index + delta + count) % count };
    });
  }, []);

  const closeView = useCallback((): void => setViewing(null), []);

  return (
    <section aria-labelledby="reviews-heading" className="mt-3xl">
      <header className="flex flex-wrap items-baseline justify-between gap-sm">
        <h2 id="reviews-heading" className="collar">
          Reports from the trail
        </h2>

        {reviews.length > 1 ? (
          <div className="flex items-baseline gap-xs font-mono text-caption text-ink-muted">
            <label htmlFor="reviews-sort">Showing</label>
            <select
              id="reviews-sort"
              value={sort}
              onChange={(event) => setSort(event.target.value as ReviewSort)}
              className="dial"
            >
              {REVIEW_SORTS.map((option) => (
                <option key={option} value={option}>
                  {REVIEW_SORT_LABEL[option]}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </header>

      {summary.data ? <Reported summary={summary.data} /> : null}
      {summary.data && summary.data.count > 0 ? <Ratings summary={summary.data} /> : null}

      <ReviewForm
        trailId={trailId}
        trailName={trailName}
        trailPath={trailPath}
        existing={mine.data ?? null}
        isViewerKnown={viewerId !== null}
        onSaved={refetchAll}
      />

      {list.isPending ? (
        <p className="mt-lg rounded-hair border border-dashed border-bezel px-md py-lg text-caption text-ink-muted">
          Reading the reports…
        </p>
      ) : list.isError ? (
        <p className="mt-lg rounded-hair border border-dashed border-bezel px-md py-lg text-caption text-ink-muted">
          The reports could not be loaded. Everything else on this page is still good.
        </p>
      ) : reviews.length === 0 ? (
        <p className="mt-lg max-w-measure text-body text-ink-muted">
          Nobody has reported on this trail yet. The stats above come from the map; what the ground
          was actually like has to come from someone who hiked it.
        </p>
      ) : (
        <>
          <ol className="mt-lg border-t border-bezel">
            {reviews.map((review) => (
              <ReviewRow
                key={review.id}
                review={review}
                isViewerKnown={viewerId !== null}
                canTakeDown={canModerate(viewerRole)}
                onModerated={refetchAll}
                onOpenPhotos={(index) =>
                  setViewing({ photos: review.photos, index, author: hikerName(review) })
                }
              />
            ))}
          </ol>

          {list.hasNextPage ? (
            <button
              type="button"
              onClick={() => void list.fetchNextPage()}
              disabled={list.isFetchingNextPage}
              className={`${BUTTON_COLLAR} ${SECONDARY} ${HEIGHT.panel} mt-md px-md`}
            >
              {list.isFetchingNextPage ? 'Reading…' : `Show more · ${reviews.length} of ${total}`}
            </button>
          ) : null}
        </>
      )}

      <ReportViewer view={viewing} onClose={closeView} onStep={stepView} />
    </section>
  );
}

/**
 * The condition tally — the block this section exists for.
 *
 * Ordered by how many people said it, so the loudest ground truth is leftmost, and the
 * window is printed in the label rather than implied. "12 of 27 reports" is the honest
 * denominator: the tags are a proportion of the people who hiked it *recently*, not of
 * everyone who ever reviewed it, and quoting the all-time count next to a sixty-day tally
 * would misrepresent both.
 */
function Reported({ summary }: { summary: RatingSummary }) {
  if (summary.recentConditions.length === 0) {
    if (summary.count === 0) return null;
    return (
      <p className="mt-lg max-w-measure text-caption text-ink-muted">
        Nothing has been reported about the ground in the last {summary.windowDays} days.
      </p>
    );
  }

  return (
    <div className="mt-lg">
      <h3 className="collar">
        Reported in the last {summary.windowDays} days · {summary.recentCount}{' '}
        {plural(summary.recentCount, 'report')}
      </h3>
      <ul className="mt-sm flex flex-wrap gap-xs">
        {summary.recentConditions.map(({ condition, count }) => (
          <li key={condition}>
            <span
              className={`inline-flex ${HEIGHT.panel} items-center gap-xs rounded-hair border px-md text-caption font-medium ${chipClass(condition)}`}
            >
              {TRAIL_CONDITION_LABEL[condition]}
              {/*
                Quieter by size and family, not by opacity. At 70 % this count measured
                between 2.71 and 4.15 depending on the plate — every one of them under AA,
                on a number that is the whole reason the chip is here. Mono at `micro`
                against `medium` at `caption` is already a clear demotion and costs nothing.
              */}
              <span className="font-mono text-micro">{count}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The average and what it is an average of.
 *
 * The bars are set against a ruled track rather than floating, so an empty bucket is still
 * a visible row — a distribution with a hole in it is information, and a row that collapses
 * to nothing hides it.
 *
 * **Constrained, not full bleed.** This is six numbers on most trails. Let the track run the
 * width of the sheet and a single four-star review draws an eight-hundred-pixel bar, which
 * makes the quietest data on the page shout louder than the reports underneath it. Capped at
 * a column width, the block reads as an instrument sitting in the margin — the same way the
 * access facts do — and the reports keep the measure.
 */
function Ratings({ summary }: { summary: RatingSummary }) {
  const most = Math.max(...summary.histogram.map((bucket) => bucket.count), 1);

  return (
    <div className="mt-lg grid max-w-[26rem] gap-lg rounded-hair border border-bezel p-md sm:grid-cols-[auto_1fr] sm:gap-lg">
      <div className="sm:border-r sm:border-bezel sm:pr-lg">
        <p className="font-mono text-h4 text-ink">
          {summary.average === null ? '—' : summary.average.toFixed(1)}
          <span className="text-title text-ink-muted">/5</span>
        </p>
        <p className="collar mt-xs">
          {summary.count} {summary.count === 1 ? 'report' : 'reports'}
        </p>
      </div>

      <ol className="flex flex-col justify-center gap-hair" aria-hidden>
        {summary.histogram.map((bucket) => (
          <li key={bucket.rating} className="flex items-center gap-sm">
            <span className="w-[1ch] font-mono text-micro text-ink-muted">{bucket.rating}</span>
            <span className="h-[8px] flex-1 rounded-hair bg-bezel/60">
              <span
                className="block h-full rounded-hair bg-woodland"
                style={{ width: `${(bucket.count / most) * 100}%` }}
              />
            </span>
            <span className="w-[3ch] text-right font-mono text-micro text-ink-muted">
              {bucket.count}
            </span>
          </li>
        ))}
      </ol>

      {/*
       * The chart is decoration to a screen reader — the same five numbers said once, in a
       * sentence, is faster to hear than five labelled rows are to navigate.
       */}
      <p className="sr-only">
        {summary.average === null
          ? 'No ratings yet.'
          : `Rated ${summary.average.toFixed(1)} out of 5 from ${summary.count} reports: ` +
            summary.histogram.map((bucket) => `${bucket.count} at ${bucket.rating}`).join(', ') +
            '.'}
      </p>
    </div>
  );
}

/**
 * The rating, as a map scale bar. See this module's header for why it is not stars.
 *
 * The division rules change colour with the fill, which is what keeps it a scale bar: ruled
 * in woodland across the empty divisions, and in canvas across the filled ones. Ruling them
 * all in woodland would be invisible inside the fill, so a five would print as one solid
 * block — a bar with no divisions at all, which is the one reading this graphic must never
 * give. At the fill boundary no rule is drawn, because the colour change is already the edge.
 *
 * `aria-hidden` with the reading supplied in text beside it: five nested spans announced
 * one by one is noise, and "4 out of 5" is the whole content.
 */
export function ScaleBar({ value }: { value: number }) {
  return (
    <span
      aria-hidden
      className="inline-flex h-[11px] w-[60px] shrink-0 overflow-hidden rounded-hair border border-woodland"
    >
      {[1, 2, 3, 4, 5].map((division) => {
        const filled = division <= value;
        return (
          <span
            key={division}
            className={`flex-1 ${filled ? 'bg-woodland' : ''} ${
              division === 1 ? '' : filled ? 'border-l border-canvas' : 'border-l border-woodland'
            }`}
          />
        );
      })}
    </span>
  );
}

/**
 * One report.
 *
 * The date on the right is when they *hiked* it, which is the fact that decides whether the
 * mud below is still there. When nobody recorded a hike date it says when the report was
 * written instead, and says which it is — a page that prints both as a bare date is asking
 * to be misread on exactly the reports where it matters most.
 */
function ReviewRow({
  review,
  isViewerKnown,
  canTakeDown,
  onModerated,
  onOpenPhotos,
}: {
  review: Review;
  isViewerKnown: boolean;
  canTakeDown: boolean;
  onModerated: () => void;
  onOpenPhotos: (index: number) => void;
}) {
  const name = hikerName(review);
  const edited = review.updatedAt.getTime() - review.createdAt.getTime() > 1000;

  return (
    <li
      className={`border-b border-bezel py-md ${review.isMine ? 'border-l-2 border-l-ink pl-md' : ''}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-md gap-y-xs">
        <div className="flex items-center gap-sm">
          {/*
           * The scale bar goes when the report does. A rating still drawn under a tombstone
           * is a measurement the page is asserting on behalf of a report it has withdrawn —
           * and it is not in the average above either, so drawing it would be the one number
           * on this section that corresponds to nothing.
           */}
          {review.hidden ? null : (
            <>
              <ScaleBar value={review.rating} />
              <span className="sr-only">{review.rating} out of 5.</span>
            </>
          )}
          <span className="text-caption text-ink">
            {name}
            {review.isMine ? <span className="collar ml-sm">You</span> : null}
          </span>
        </div>

        <span className="font-mono text-micro text-ink-muted">
          {review.hikedOn !== null
            ? `Hiked ${formatDateLabel(review.hikedOn)}`
            : `Written ${formatDateLabel(review.createdAt.toISOString().slice(0, 10))}`}
          {edited && !review.hidden ? ' · edited' : ''}
        </span>
      </div>

      {/*
       * The tombstone. It keeps the row rather than removing it, because a report that
       * silently vanishes reads to its author as a bug in the site rather than as a decision
       * somebody made — and the author is exactly the person who has to be able to argue.
       *
       * Dashed hairline and `ink-muted` prose: the same treatment as the section's other
       * absences ("Reading the reports…", "Nobody has reported on this trail yet"), because
       * that is what this is. No survey plate — survey is the reader's own position and
       * safety, and somebody else's report being taken down is neither.
       *
       * Its author gets the longer sentence, with the address to write to.
       */}
      {review.hidden ? (
        <p className="mt-sm max-w-measure rounded-hair border border-dashed border-bezel px-md py-sm text-caption text-ink-muted">
          {review.isMine ? REMOVED_NOTICE_OWN : REMOVED_NOTICE}
        </p>
      ) : null}

      {review.body !== null ? (
        <p className="mt-sm max-w-measure-wide text-body leading-relaxed">{review.body}</p>
      ) : null}

      {review.photos.length > 0 ? (
        <ul className="mt-sm flex flex-wrap gap-xs">
          {review.photos.map((photo, index) => {
            const wash = blurhashAverageColor(photo.blurhash);
            return (
              <li key={photo.id}>
                <button
                  type="button"
                  onClick={() => onOpenPhotos(index)}
                  className="block rounded-hair focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
                >
                  {/*
                   * The BlurHash wash underneath is what stops the strip flashing white while
                   * these arrive. Where one does not arrive at all — an object gone from R2, a
                   * row that outlived its file — the plate keeps the row's measure so the rest
                   * of somebody's report does not shuffle up around the gap.
                   */}
                  <Photograph
                    src={photo.thumbUrl ?? photo.url}
                    alt={photo.caption ?? `Photographed by ${name}`}
                    loading="lazy"
                    style={wash ? { backgroundColor: wash } : undefined}
                    className="h-[76px] w-[102px] rounded-hair border border-bezel object-cover transition-opacity duration-quick ease-standard hover:opacity-80"
                    fallback={<PhotographMissing className="h-[76px] w-[102px]" />}
                  />
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      {review.conditions.length > 0 ? (
        <ul className="mt-sm flex flex-wrap gap-xs">
          {review.conditions.map((condition) => (
            <li
              key={condition}
              className={`rounded-hair border px-sm py-hair text-micro ${chipClass(condition)}`}
            >
              {TRAIL_CONDITION_LABEL[condition]}
            </li>
          ))}
        </ul>
      ) : null}

      {review.activityType !== null || review.helpfulCount > 0 ? (
        <p className="collar mt-sm">
          {review.activityType !== null ? review.activityType.replace(/_/g, ' ') : null}
          {review.activityType !== null && review.helpfulCount > 0 ? ' · ' : null}
          {review.helpfulCount > 0 ? `${review.helpfulCount} found this useful` : null}
        </p>
      ) : null}

      {/*
       * The controls that are about the report rather than about the trail, kept apart from
       * everything above by being right-aligned and last.
       *
       * You cannot report your own — the button would only ever mean "ask a stranger to read
       * my own writing" — and there is nothing to report about a row that has already gone,
       * which is also the only state where a moderator is offered "Put back" instead.
       */}
      {(canTakeDown || !review.isMine) && !(review.hidden && !canTakeDown) ? (
        <div className="mt-xs flex flex-wrap items-center justify-end gap-xs">
          {!review.isMine && !review.hidden ? (
            <ReportControl
              subject="review"
              subjectId={review.id}
              isViewerKnown={isViewerKnown}
              what={`this report by ${name}`}
            />
          ) : null}
          {canTakeDown ? (
            <ModerateControl
              subject="review"
              subjectId={review.id}
              hidden={review.hidden}
              onDone={onModerated}
            />
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/**
 * A report's photographs, full size.
 *
 * **One dialog for the whole section, not one per report.** Forty reports would otherwise put
 * forty `<dialog>` elements into the document, thirty-nine of them holding images nobody has
 * asked to see. The open report's frames are handed in as state instead.
 *
 * Deliberately thinner than the gallery's viewer two sections up, and each omission is a
 * decision. **No credit line** — every frame in here belongs to the one person named in the
 * heading, so repeating it under each is noise. **No caption editing and no remove**: a
 * photograph is managed where it lives, in the gallery, and a second destructive control on
 * the same object in a different place is how people delete things they meant to keep.
 */
function ReportViewer({
  view,
  onClose,
  onStep,
}: {
  view: PhotoView | null;
  onClose: () => void;
  onStep: (delta: number) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const photo = view === null ? null : (view.photos[view.index] ?? null);

  useEffect(() => {
    const node = dialogRef.current;
    if (!node) return;
    if (photo && !node.open) node.showModal();
    if (!photo && node.open) node.close();
  }, [photo]);

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onKeyDown={(event) => {
        if (event.key === 'ArrowRight') onStep(1);
        if (event.key === 'ArrowLeft') onStep(-1);
      }}
      /*
       * `m-auto` is load-bearing, not a tidy-up. A modal `<dialog>` is centred by the UA's own
       * `inset: 0; margin: auto`, and Tailwind's preflight resets `dialog { margin: 0 }` — which
       * leaves it pinned to the top-left corner against the backdrop. The gallery lightbox
       * carries the same class for the same reason.
       */
      className="m-auto w-full max-w-[min(1080px,92vw)] rounded-hair border border-bezel bg-canvas p-0 text-ink backdrop:bg-ink/85"
    >
      {view && photo ? (
        <div className="flex flex-col">
          <Photograph
            src={photo.url}
            alt={photo.caption ?? `Photographed by ${view.author}`}
            style={{
              backgroundColor: blurhashAverageColor(photo.blurhash) ?? undefined,
              aspectRatio:
                photo.width && photo.height ? `${photo.width} / ${photo.height}` : undefined,
            }}
            className="max-h-[72vh] w-full object-contain"
            fallback={<PhotographUnavailable />}
          />

          <div className="flex flex-wrap items-start gap-md border-t border-bezel p-md">
            <div className="min-w-0 flex-1">
              {photo.caption !== null ? (
                <p className="max-w-measure-wide font-text text-body leading-relaxed">
                  {photo.caption}
                </p>
              ) : null}
              <p className="collar mt-sm">Reported by {view.author}</p>
            </div>

            <div className="ml-auto flex shrink-0 items-center gap-xs">
              {view.photos.length > 1 ? (
                <>
                  <button
                    type="button"
                    onClick={() => onStep(-1)}
                    aria-label="Previous photograph"
                    className={`${BUTTON_COLLAR} ${SECONDARY} ${HEIGHT.panel} px-md`}
                  >
                    ←
                  </button>
                  <span className="font-mono text-micro text-ink-muted">
                    {view.index + 1}/{view.photos.length}
                  </span>
                  <button
                    type="button"
                    onClick={() => onStep(1)}
                    aria-label="Next photograph"
                    className={`${BUTTON_COLLAR} ${SECONDARY} ${HEIGHT.panel} px-md`}
                  >
                    →
                  </button>
                </>
              ) : null}

              <button
                type="button"
                onClick={onClose}
                className={`${BUTTON_COLLAR} ${SECONDARY} ${HEIGHT.panel} px-md`}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </dialog>
  );
}
