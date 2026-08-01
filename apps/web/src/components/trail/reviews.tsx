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
 * Reports from the trail: the recent condition tally, the rating distribution, then the reports
 * themselves. The one part of this product OpenStreetMap cannot supply.
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
   * What the viewer may do about somebody else's report. Decides whether a take-down control is
   * *drawn*, not whether one works — `moderatorProcedure` re-reads the column on every call.
   */
  viewerRole?: UserRole;
}

const PAGE_SIZE = 8;

/**
 * Chip treatment per plate. Written out rather than composed, because Tailwind reads class names
 * literally out of the source and a `border-${plate}/40` would compile to nothing. No wash behind
 * them: plate ink over a plate tint falls under 4.5:1, and the token test measures each ink only
 * against `canvas` and `surface`, so a wash is the one backdrop nothing checks.
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
   * One invalidation for the whole router: a write moves the list, the distribution and the
   * caller's own row at once. `askAgain` rather than a bare invalidation because a report can
   * be filed while the page's first batch is still in the air — see `lib/after-write.ts`.
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

      {mine.data?.hidden ? (
        /*
         * The author of a removed report is told before they type. `reviews.mine` returns the
         * hidden row with its content emptied, so handing it to `ReviewForm` drew "Edit your
         * report" over two actions the server refuses — `upsert` and `remove` both throw on a
         * hidden row. This is the only place the long notice appears; the author's own row in
         * the list prints the short `REMOVED_NOTICE`.
         */
        <p className="mt-lg max-w-measure rounded-hair border border-survey px-md py-sm text-body leading-relaxed text-ink">
          {REMOVED_NOTICE_OWN}
        </p>
      ) : (
        <ReviewForm
          trailId={trailId}
          trailName={trailName}
          trailPath={trailPath}
          existing={mine.data ?? null}
          isViewerKnown={viewerId !== null}
          onSaved={refetchAll}
        />
      )}
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
 * The condition tally, ordered by how many people said it. The window is printed in the label
 * because the tags are a proportion of recent hikers, not of everyone who ever reported.
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
 * The average and what it is an average of. The bars sit on a ruled track so an empty bucket is
 * still a visible row, and the block is capped at a column width rather than running full bleed.
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
 * The rating as a map scale bar rather than stars: five discrete divisions on the woodland
 * plate, which is what a sheet's margin already carries. The division rules flip to canvas
 * inside the fill — ruled all in woodland they vanish, and a five prints as one solid block
 * with no divisions at all. `aria-hidden`, with the reading supplied in text beside it.
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
 * One report. The date on the right is when they *hiked* it — the fact that decides whether the
 * mud is still there — falling back to the written date, and saying which of the two it is.
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
           * No scale bar under a tombstone: the rating is not in the average above either, so
           * drawing it would be the one number on this section corresponding to nothing.
           * Branching on `rating === null` rather than on `hidden` reads the value it is about
           * to draw, so the two cannot drift.
           */}
          {review.rating === null ? null : (
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
       * The tombstone keeps the row rather than removing it, so its author can argue. Dashed
       * hairline and `ink-muted`, the section's treatment for every other absence; no survey
       * plate, which is reserved for the reader's own position and safety. The short notice
       * even here — the long one carrying the address belongs in the form slot above.
       */}
      {review.hidden ? (
        <p className="mt-sm max-w-measure rounded-hair border border-dashed border-bezel px-md py-sm text-caption text-ink-muted">
          {REMOVED_NOTICE}
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
                   * The BlurHash wash stops the strip flashing white while these arrive; the
                   * fallback plate keeps the row's measure when an object has gone from R2.
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
       * Controls about the report rather than the trail: right-aligned and last. You cannot
       * report your own, and there is nothing to report about a row that has already gone —
       * the one state where a moderator is offered "Put back" instead.
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
 * A report's photographs, full size. One dialog for the whole section rather than one per
 * report, which would put forty `<dialog>` elements into the document. Deliberately thinner
 * than the gallery's viewer: no credit line, no caption editing, no remove — a photograph is
 * managed where it lives.
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
       * `m-auto` is load-bearing: a modal `<dialog>` is centred by the UA's own `margin: auto`,
       * and Tailwind's preflight resets `dialog { margin: 0 }`, pinning it to the top-left.
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
