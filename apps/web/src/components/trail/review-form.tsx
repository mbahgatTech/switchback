'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation } from '@tanstack/react-query';
import type { ActivityType, Review, ReviewPhoto, TrailCondition } from '@switchback/core';
import {
  ACTIVITY_TYPES,
  ACTIVITY_TYPE_LABELS,
  REVIEW_BODY_MAX,
  TRAIL_CONDITIONS,
  TRAIL_CONDITION_LABEL,
  blurhashAverageColor,
  todayLocal,
} from '@switchback/core';
import type { TrailPhoto } from '@switchback/api/routers/photos';
import { PhotoUploader } from '../photos/uploader';
import { Photograph, PhotographMissing } from '../photos/photograph';
import {
  isUnreachable,
  pendingReview,
  putPendingReview,
  type PendingReview,
} from '../../offline/queue';
import { usePendingReview } from '../../offline/use-queue';
import { writingReader } from '../../offline/identity';
import { useTRPC } from '../../trpc/react';
import { chipClass } from './reviews';
import {
  BUTTON_COLLAR,
  DANGER,
  GHOST,
  HEIGHT,
  HIT,
  OUTLINE,
  PRIMARY,
  SECONDARY,
} from '../controls';

/**
 * Filing a report — a field card rather than a review box: the rating is one line of it and
 * the rest is what was actually there. Rating is the only required field.
 *
 * Photographs are uploaded to the trail as they are picked and adopted by the report once it
 * has an id, so an abandoned draft does not lose them. A save that never reaches the server is
 * written to the device and sent when signal returns; see `offline/queue.ts`.
 */

export interface ReviewFormProps {
  trailId: string;
  /** Shown on the queued-report row in the storage manager, where there is no page to read it from. */
  trailName: string;
  /** Path to return to after signing in. */
  trailPath: string;
  /** The caller's existing report, if they have one. */
  existing: Review | null;
  /** False when signed out. Drives the prompt rather than the form. */
  isViewerKnown: boolean;
  onSaved: () => void;
}

const RATINGS = [1, 2, 3, 4, 5] as const;

/** What each rating means, said in words, so that everyone's four is not a different four. */
const RATING_HINT: Readonly<Record<number, string>> = {
  1: 'Would not go back',
  2: 'Disappointing',
  3: 'Worth doing once',
  4: 'Would do it again',
  5: 'One of the best',
};

/** What the uploader asks for here, which is not what it asks for on the gallery. */
const UPLOAD_LABEL = 'Add photographs from this hike';
const UPLOAD_HINT =
  'Drop them here or choose files. They are resized in your browser, the location the camera ' +
  'recorded is discarded unless it falls on this trail, and they appear both under your report ' +
  "and in the trail's gallery.";

/**
 * One frame in the form's strip. `onDiscard` is null for photographs the report already
 * claims: those are managed in the gallery, and a second delete control on the same object in
 * a second place is how people lose things they meant to keep.
 */
function PhotoCell({ photo, onDiscard }: { photo: ReviewPhoto; onDiscard: (() => void) | null }) {
  const wash = blurhashAverageColor(photo.blurhash);
  return (
    <li className="relative">
      {/*
       * The BlurHash wash is what it stands on while it loads; the fallback plate holds the
       * cell if it never does, so the discard control stays where the eye left it.
       */}
      <Photograph
        src={photo.thumbUrl ?? photo.url}
        alt={photo.caption ?? 'A photograph from this hike'}
        loading="lazy"
        style={wash ? { backgroundColor: wash } : undefined}
        className="h-[76px] w-[102px] rounded-hair border border-bezel object-cover"
        fallback={<PhotographMissing className="h-[76px] w-[102px]" />}
      />
      {onDiscard ? (
        <button
          type="button"
          onClick={onDiscard}
          aria-label="Remove this photograph"
          title="Remove this photograph"
          className={`${HIT} absolute right-xs top-xs flex size-6 items-center justify-center rounded-hair border border-ink bg-canvas font-mono text-micro tracking-normal text-ink transition-colors duration-quick ease-standard hover:bg-ink hover:text-canvas`}
        >
          ×
        </button>
      ) : null}
    </li>
  );
}

/**
 * Where a report is, when it is not on the server yet. Water is the conditions plate and no
 * signal is a condition; a report the server *refused* takes survey instead, because that one
 * needs a person.
 */
function QueuedNotice({
  pending,
  busy,
  onPost,
  className,
}: {
  pending: PendingReview;
  busy: boolean;
  onPost: () => void;
  /** Spacing only. The notice sits under a button in one place and above a form in the other. */
  className: string;
}) {
  return (
    <div
      className={`border-l-2 pl-md ${pending.blocked ? 'border-survey' : 'border-water'} ${className}`}
    >
      <p className={`collar ${pending.blocked ? 'text-survey' : 'text-water'}`}>
        {pending.blocked ? 'Not posted' : 'Saved on this device'}
      </p>
      <p className="mt-xs max-w-measure text-caption text-ink-muted">
        {pending.blocked
          ? (pending.lastError ?? 'The server would not take it.')
          : 'Written down here, and it posts itself the next time you have signal.'}
      </p>
      <button
        type="button"
        onClick={onPost}
        disabled={busy}
        className={`${BUTTON_COLLAR} ${SECONDARY} ${HEIGHT.panel} mt-sm px-md`}
      >
        {busy ? 'Posting…' : 'Post it now'}
      </button>
    </div>
  );
}

export function ReviewForm({
  trailId,
  trailName,
  trailPath,
  existing,
  isViewerKnown,
  onSaved,
}: ReviewFormProps) {
  const trpc = useTRPC();
  const router = useRouter();
  const queued = usePendingReview(trailId);
  const draft = queued.pending;

  const [open, setOpen] = useState(false);
  const [rating, setRating] = useState<number | null>(null);
  const [hikedOn, setHikedOn] = useState('');
  const [conditions, setConditions] = useState<readonly TrailCondition[]>([]);
  const [body, setBody] = useState('');
  const [activityType, setActivityType] = useState<ActivityType | ''>('');
  const [confirmingRemoval, setConfirmingRemoval] = useState(false);
  /**
   * Photographs uploaded in this sitting and not yet claimed by the report. Deliberately not
   * reset when the form is closed — clearing them would leave the files on the trail with no
   * way to file them under the report they were taken for.
   */
  const [added, setAdded] = useState<ReviewPhoto[]>([]);

  const bodyId = useId();
  const dateId = useId();
  const activityId = useId();

  /**
   * Prefill once the existing report arrives, and only while the form is closed: `existing`
   * changes identity after every save, so without the guard a re-render mid-edit would
   * overwrite what the person is typing. A queued draft outranks the server's copy — by
   * construction it is the newer of the two.
   */
  useEffect(() => {
    if (open) return;
    const source = draft?.write ?? existing;
    setRating(source?.rating ?? null);
    setHikedOn(source?.hikedOn ?? '');
    setConditions(source?.conditions ?? []);
    setBody(source?.body ?? '');
    setActivityType(source?.activityType ?? '');
  }, [existing, draft, open]);

  /** Claims uploaded photographs for a report. See `save`'s `onSuccess` for the ordering. */
  const attach = useMutation(trpc.photos.attach.mutationOptions());

  /**
   * Take back a photograph added a moment ago, bytes and all. A real delete rather than a
   * detach: one not yet filed under a report is visible nowhere else, so detaching would leave
   * it in the trail's gallery, which is not what "remove this one" means.
   */
  const discard = useMutation(
    trpc.photos.remove.mutationOptions({
      onSuccess: (_result, variables) => {
        setAdded((current) => current.filter((photo) => photo.id !== variables.photoId));
      },
    }),
  );

  const save = useMutation(
    trpc.reviews.upsert.mutationOptions({
      onSuccess: async (review) => {
        // The server now has it, so the device's copy is no longer owed to anyone.
        if (draft) await queued.discard();
        /*
         * Adopt the photographs now the report has an id. Awaited inside `onSuccess` so the
         * refetch below happens after the attach rather than racing it — invalidating first
         * would refill the strip from rows that are still unclaimed.
         */
        if (added.length > 0) {
          try {
            await attach.mutateAsync({
              reviewId: review.id,
              photoIds: added.map((photo) => photo.id),
            });
          } catch {
            // The report saved; only the adoption failed. Leaving the form open with the
            // photographs listed lets someone press the button again without re-picking files.
            onSaved();
            router.refresh();
            return;
          }
          setAdded([]);
        }
        setOpen(false);
        setConfirmingRemoval(false);
        onSaved();
        // The title block above is server rendered and holds the average this write just
        // moved. Without this it keeps the old number until a hard navigation.
        router.refresh();
      },

      /**
       * Nothing came back: keep the report on the device rather than on the screen.
       * `navigator.onLine` is checked as well as the error shape because a request can fail
       * looking like a server error while the phone knows it has no signal. A refusal the
       * server actually issued falls through to the error strip — that one has to be changed.
       */
      onError: (error, variables) => {
        if (!isUnreachable(error) && navigator.onLine) return;
        void putPendingReview(
          pendingReview({
            trailId,
            trailName,
            trailPath,
            // `conditions` is optional going in — the schema defaults it — and required in
            // the stored shape, so it is filled here rather than left to the sender.
            write: { ...variables, conditions: variables.conditions ?? [] },
            at: Date.now(),
            // Read here rather than taken from a prop: this is the moment that decides whose
            // report it is, and a downloaded trail page can be one sign-in stale. Null means
            // the row is nobody's until somebody claims it.
            userId: writingReader(),
          }),
        ).then(
          () => {
            // Closed, not left open with a warning: from where the person is standing the
            // report is filed. The banner below says where it is filed *to*.
            setOpen(false);
            setConfirmingRemoval(false);
          },
          () => {
            // IndexedDB refused it — private mode, or a full disk. The form stays open and
            // the error strip says so, which at least keeps the words on screen.
          },
        );
      },
    }),
  );

  const received = useCallback((photo: TrailPhoto): void => {
    // Narrowed to the report's own shape on the way in: the uploader speaks the gallery's
    // language, and none of that belongs to a picture credited by the report's own author.
    // A frame uploaded seconds ago cannot already be moderated, so the nullable `url` is
    // unreachable — checked rather than asserted away, because a `!` would be a promise
    // about somebody else's code.
    if (photo.url === null) return;
    const url = photo.url;

    setAdded((current) => [
      ...current,
      {
        id: photo.id,
        url,
        thumbUrl: photo.thumbUrl,
        width: photo.width,
        height: photo.height,
        blurhash: photo.blurhash,
        caption: photo.caption,
      },
    ]);
  }, []);

  const remove = useMutation(
    trpc.reviews.remove.mutationOptions({
      onSuccess: async () => {
        // Withdrawing the report withdraws the queued amendment with it. Leaving it would
        // have the device re-file, on the next reconnection, the very thing just deleted.
        if (draft) await queued.discard();
        setOpen(false);
        setConfirmingRemoval(false);
        setRating(null);
        setHikedOn('');
        setConditions([]);
        setBody('');
        setActivityType('');
        onSaved();
        router.refresh();
      },
    }),
  );

  const busy = save.isPending || remove.isPending || discard.isPending || queued.busy;

  /** Photographs the report already claims. Not editable here, so not mirrored into state. */
  const filed = existing?.photos ?? [];

  if (!isViewerKnown) {
    return (
      <div className="mt-lg rounded-hair border border-dashed border-bezel px-md py-lg">
        <p className="max-w-measure text-body text-ink-muted">
          Hiked this one? Sign in to report what the ground was like. Conditions go stale fastest
          and are the hardest thing to get from a map.
        </p>
        <Link
          href={`/signin?callbackUrl=${encodeURIComponent(trailPath)}`}
          className={`${BUTTON_COLLAR} ${SECONDARY} ${HEIGHT.panel} mt-md px-md`}
        >
          Sign in
        </Link>
      </div>
    );
  }

  if (!open) {
    return (
      <div className="mt-lg">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={`${BUTTON_COLLAR} ${OUTLINE} ${HEIGHT.panel} px-md`}
        >
          {existing || draft ? 'Edit your report' : 'Report on this trail'}
        </button>
        {draft ? (
          <QueuedNotice
            pending={draft}
            busy={queued.busy}
            className="mt-sm"
            onPost={() => {
              void queued.post();
            }}
          />
        ) : null}
        {/*
         * Photographs uploaded and then left behind when the form was closed. Said out loud,
         * so nobody has to work out why their pictures are on the trail but not under the
         * report they took them for.
         */}
        {added.length > 0 ? (
          <p className="collar mt-sm text-ink-muted">
            {added.length} {added.length === 1 ? 'photograph' : 'photographs'} waiting to be filed
            with it
          </p>
        ) : null}
      </div>
    );
  }

  function toggle(condition: TrailCondition): void {
    setConditions((current) =>
      current.includes(condition)
        ? current.filter((value) => value !== condition)
        : [...current, condition],
    );
  }

  function submit(event: React.FormEvent): void {
    event.preventDefault();
    if (rating === null) return;
    save.mutate({
      trailId,
      rating,
      body: body.trim() || null,
      hikedOn: hikedOn || null,
      // Copied out of state rather than passed by reference: the input schema takes a mutable
      // array, and handing zod the array this component still renders from is an aliasing bug.
      conditions: [...conditions],
      ...(activityType ? { activityType } : {}),
    });
  }

  return (
    <form
      onSubmit={submit}
      className="mt-lg rounded-hair border border-bezel bg-surface p-md sm:p-lg"
    >
      <fieldset disabled={busy} className="border-0 p-0">
        {/*
         * Why the fields are already filled in with something nobody else can see. Above the
         * rating, because it explains the state of the form the person is looking at.
         */}
        {draft ? (
          <QueuedNotice
            pending={draft}
            busy={queued.busy}
            className="mb-lg"
            onPost={() => {
              void queued.post();
            }}
          />
        ) : null}

        {/* Rating */}
        <fieldset className="border-0 p-0">
          <legend className="collar p-0">How was it</legend>
          {/*
           * Real radios under the labels: the cells look like the scale bar the reports are
           * read with, but arrow keys, tab and the announced state are the browser's own.
           */}
          <div className="mt-sm flex flex-wrap items-center gap-md">
            <div className="inline-flex overflow-hidden rounded-hair border border-woodland">
              {RATINGS.map((value) => (
                <label
                  key={value}
                  title={RATING_HINT[value]}
                  className={`flex h-[34px] w-[34px] cursor-pointer items-center justify-center font-mono text-caption transition-colors duration-quick ease-standard ${
                    value > 1 ? 'border-l border-woodland' : ''
                  } ${
                    rating !== null && value <= rating
                      ? 'bg-woodland text-canvas'
                      : 'text-woodland hover:bg-woodland-wash'
                  } has-[:focus-visible]:outline-2 has-[:focus-visible]:-outline-offset-2 has-[:focus-visible]:outline-ink`}
                >
                  <input
                    type="radio"
                    name="rating"
                    value={value}
                    checked={rating === value}
                    onChange={() => setRating(value)}
                    className="sr-only"
                  />
                  {value}
                  <span className="sr-only"> — {RATING_HINT[value]}</span>
                </label>
              ))}
            </div>
            <p className="text-caption text-ink-muted">
              {rating === null ? 'Pick a number to file the report.' : RATING_HINT[rating]}
            </p>
          </div>
        </fieldset>

        {/* When, and how you travelled */}
        <p className="mt-lg flex flex-wrap items-baseline gap-xs font-mono text-caption text-ink-muted">
          <label htmlFor={dateId}>Hiked on</label>
          {/*
           * A date input rather than a "when did you go" dropdown of the last fortnight: a
           * report about last autumn is worth having *as* a report about last autumn. The
           * tally upstream reads this field first and the written-on date only as a fallback.
           */}
          <input
            id={dateId}
            type="date"
            value={hikedOn}
            max={todayLocal()}
            onChange={(event) => setHikedOn(event.target.value)}
            className="dial"
          />
          <label htmlFor={activityId}>, travelling by</label>
          <select
            id={activityId}
            value={activityType}
            onChange={(event) => setActivityType(event.target.value as ActivityType | '')}
            className="dial"
          >
            <option value="">not saying</option>
            {ACTIVITY_TYPES.map((option) => (
              <option key={option} value={option}>
                {ACTIVITY_TYPE_LABELS[option].toLowerCase()}
              </option>
            ))}
          </select>
        </p>

        {/* Conditions */}
        <fieldset className="mt-lg border-0 p-0">
          <legend className="collar p-0">What was the ground like</legend>
          <div className="mt-sm flex flex-wrap gap-xs">
            {TRAIL_CONDITIONS.map((condition) => {
              const on = conditions.includes(condition);
              return (
                <button
                  key={condition}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggle(condition)}
                  className={`inline-flex ${HEIGHT.panel} items-center rounded-hair border px-md text-caption font-medium transition-colors duration-quick ease-standard ${
                    on
                      ? chipClass(condition)
                      : 'border-bezel text-ink-muted hover:border-ink-muted hover:text-ink'
                  }`}
                >
                  {TRAIL_CONDITION_LABEL[condition]}
                </button>
              );
            })}
          </div>
        </fieldset>

        {/* Notes */}
        <div className="mt-lg">
          <label htmlFor={bodyId} className="collar">
            Anything else worth knowing
          </label>
          <textarea
            id={bodyId}
            value={body}
            maxLength={REVIEW_BODY_MAX}
            rows={4}
            onChange={(event) => setBody(event.target.value)}
            placeholder="Where the path is hard to follow, where the water is, what you wish you had known."
            className="mt-sm w-full rounded-hair border border-bezel bg-canvas px-sm py-sm font-text text-body leading-relaxed text-ink placeholder:text-ink-muted"
          />
        </div>

        {/* Photographs */}
        <div className="mt-lg">
          <p className="collar">What it looked like</p>
          {filed.length + added.length > 0 ? (
            <ul className="mt-sm flex flex-wrap gap-xs">
              {filed.map((photo) => (
                <PhotoCell key={photo.id} photo={photo} onDiscard={null} />
              ))}
              {added.map((photo) => (
                <PhotoCell
                  key={photo.id}
                  photo={photo}
                  onDiscard={() => discard.mutate({ photoId: photo.id })}
                />
              ))}
            </ul>
          ) : null}
          <PhotoUploader
            trailId={trailId}
            onUploaded={received}
            label={UPLOAD_LABEL}
            hint={UPLOAD_HINT}
          />
        </div>

        {/* Actions */}
        <div className="mt-lg flex flex-wrap items-center gap-sm border-t border-bezel pt-md">
          <button
            type="submit"
            disabled={rating === null}
            className={`${BUTTON_COLLAR} ${PRIMARY} ${HEIGHT.panel} px-lg`}
          >
            {save.isPending ? 'Filing…' : existing ? 'Update report' : 'File report'}
          </button>

          <button
            type="button"
            onClick={() => {
              setOpen(false);
              setConfirmingRemoval(false);
            }}
            className={`${BUTTON_COLLAR} ${GHOST} ${HEIGHT.panel} px-md`}
          >
            Cancel
          </button>

          {/*
           * Two taps to delete, and the second is the only control on this page allowed the
           * survey plate — not because losing a review is dangerous, but because it destroys
           * something. It says what will go.
           */}
          {existing ? (
            <div className="ml-auto flex items-center gap-sm">
              {confirmingRemoval ? (
                <>
                  <span className="text-caption text-ink-muted">Remove your report?</span>
                  <button
                    type="button"
                    onClick={() => remove.mutate({ trailId })}
                    className={`${BUTTON_COLLAR} ${DANGER} ${HEIGHT.panel} px-md`}
                  >
                    {remove.isPending ? 'Removing…' : 'Remove'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmingRemoval(false)}
                    className={`${BUTTON_COLLAR} ${GHOST} ${HEIGHT.panel} px-sm`}
                  >
                    Keep
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmingRemoval(true)}
                  className={`${BUTTON_COLLAR} ${GHOST} ${HEIGHT.panel} px-md`}
                >
                  Remove
                </button>
              )}
            </div>
          ) : null}
        </div>

        {/*
         * A queued draft answers the save error itself — "saved on this device" is a truer
         * account of a failed fetch, and the two together would contradict each other.
         */}
        {(save.isError && !draft) || remove.isError || attach.isError || discard.isError ? (
          <p className="mt-md text-caption text-survey">
            {(save.isError && !draft ? save.error?.message : null) ??
              remove.error?.message ??
              (attach.isError ? 'The report saved, but the photographs did not attach.' : null) ??
              discard.error?.message ??
              'That did not save. Try again.'}
          </p>
        ) : null}
      </fieldset>
    </form>
  );
}
