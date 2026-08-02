'use client';

/**
 * What is on this device: every download with its measured size, the origin's real usage beside
 * the browser's ceiling, and removal in one press with one confirmation.
 *
 * Two numbers rather than one — ours is what these trails cost, the browser's is everything the
 * origin holds, and it is the browser's that decides when eviction starts. Queued writes are
 * listed first: a download is a possession, a queued write is a debt. They come in three groups
 * and only the first is readable — yours in full, somebody else's as a count, and once per
 * device the ones written before this product recorded who wrote them. See `use-queue.ts` for
 * the split and `handover.ts` for why the third group exists.
 */

import { useRef, useState } from 'react';
import Link from 'next/link';
import { formatBytes, formatDistance, formatElevation, plural, trailTitle } from '@switchback/core';
import { useUnits } from '@/components/units';
import { useReaderId } from '@/offline/reader';
import { titled } from '@/offline/store';
import { useDownloads, useOnline } from '@/offline/use-offline';
import {
  usePendingActivities,
  usePendingReviews,
  type PendingActivitiesApi,
  type PendingReviewsApi,
} from '@/offline/use-queue';
import { BUTTON_COLLAR, DANGER, GHOST, HEIGHT, SECONDARY } from '../controls';

/** "today", "yesterday", or a plain date. A download's age is why you would remove it. */
function taken(at: number): string {
  const days = Math.floor((Date.now() - at) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return new Date(at).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/**
 * Reports the device is holding on the server's behalf. Renders nothing when there is nothing
 * owed. Water while it is only the network's fault, survey once the server has actually
 * refused — the plates carry the difference so the words do not have to.
 */
function QueuedReports({ api }: { api: PendingReviewsApi }) {
  const { reviews, busy, flushAll, post, discard } = api;
  const online = useOnline();
  const [confirming, setConfirming] = useState<string | null>(null);

  if (reviews.length === 0) return null;

  const blocked = reviews.filter((row) => row.blocked).length;

  return (
    <section aria-labelledby="queued-heading" className="mt-lg">
      <div className="flex flex-wrap items-baseline justify-between gap-sm">
        <h2 id="queued-heading" className={`collar ${blocked > 0 ? 'text-survey' : 'text-water'}`}>
          {blocked > 0 ? 'Not posted' : 'Waiting to post'}
        </h2>
        {online ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              void flushAll();
            }}
            className={`${BUTTON_COLLAR} ${SECONDARY} ${HEIGHT.panel} px-md`}
          >
            {busy ? 'Posting…' : `Post ${reviews.length} ${plural(reviews.length, 'report')}`}
          </button>
        ) : null}
      </div>

      <ul className="mt-sm divide-y divide-bezel border-y border-bezel">
        {reviews.map((row) => (
          <li key={row.key} className="flex flex-wrap items-baseline gap-x-lg gap-y-xs py-md">
            <Link
              href={row.trailPath}
              className="rounded-hair font-text text-body-lg text-ink hover:text-woodland"
            >
              {row.trailName}
            </Link>
            <span className="collar">
              {row.write.rating}/5 · written {taken(row.queuedAt)}
            </span>
            <span className="ml-auto flex flex-wrap items-baseline gap-lg">
              <span className={`collar ${row.blocked ? 'text-survey' : 'text-water'}`}>
                {row.blocked
                  ? (row.lastError ?? 'The server would not take it.')
                  : 'Waiting for signal'}
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  void post(row.trailId);
                }}
                className={`${BUTTON_COLLAR} ${GHOST} ${HEIGHT.panel} px-sm`}
              >
                Post it now
              </button>
              {/*
               * Two taps, and the second is the only control on this page that destroys
               * something a person wrote rather than something they downloaded. A trail can
               * be fetched again; these words exist nowhere else.
               */}
              {confirming === row.trailId ? (
                <>
                  <span className="text-caption text-ink-muted">Throw it away?</span>
                  <button
                    type="button"
                    onClick={() => {
                      void discard(row.trailId).finally(() => setConfirming(null));
                    }}
                    className={`${BUTTON_COLLAR} ${DANGER} ${HEIGHT.panel} px-md`}
                  >
                    Discard
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirming(null)}
                    className={`${BUTTON_COLLAR} ${GHOST} ${HEIGHT.panel} px-sm`}
                  >
                    Keep it
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirming(row.trailId)}
                  className={`collar ${HEIGHT.panel} inline-flex items-center rounded-hair px-sm text-ink-muted hover:text-survey`}
                >
                  Discard
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function DownloadsManager() {
  const hikes = usePendingActivities();
  const reports = usePendingReviews();
  const readerId = useReaderId();
  const status = useRef<HTMLParagraphElement | null>(null);

  /**
   * The pressed control is about to be destroyed — disabling it has already taken focus to
   * `<body>`, and the section disappears when its queue empties. Focus lands where the outcome
   * is written instead.
   */
  const moveFocusToOutcome = (): void => {
    status.current?.focus();
  };

  return (
    <>
      {/*
        The one live region on this page, and it is mounted whether or not there is anything
        in it.

        It used to live inside the queued-hikes section, which returns null once the queue is
        empty — so the only report a hiker ever gets that part of their day did not make it
        was inserted into the DOM at the same instant its container was removed from it. It
        never painted and was never announced. Assistive technology also misses a region that
        arrives together with its text, so the container is permanent and only the sentence
        is swapped.
      */}
      <p
        ref={status}
        role="status"
        tabIndex={-1}
        className={hikes.notice ? 'mt-lg max-w-measure text-caption text-ink' : undefined}
      >
        {hikes.notice}
      </p>

      <QueuedHikes api={hikes} onSettled={moveFocusToOutcome} />
      <QueuedReports api={reports} />
      <Unclaimed
        hikes={hikes}
        reports={reports}
        readerId={readerId}
        onSettled={moveFocusToOutcome}
      />
      <HeldForAnother count={hikes.held + reports.held} />
      <Downloads />
    </>
  );
}

/**
 * Writes this device is holding for somebody who is not signed in. A count and one sentence:
 * the storage is the reader's business, the contents are not. Renders nothing when there is
 * nothing held, which is the ordinary case.
 */
function HeldForAnother({ count }: { count: number }) {
  if (count === 0) return null;

  return (
    <section aria-labelledby="held-heading" className="mt-lg">
      <h2 id="held-heading" className="collar text-water">
        Held for another account
      </h2>
      <p className="mt-sm max-w-measure font-text text-body text-ink-muted">
        {count === 1
          ? 'One report or hike on this device was written by somebody else.'
          : `${count} reports and hikes on this device were written by somebody else.`}{' '}
        They stay here, unsent, until that person signs in — then they go to their account. Nobody
        else can read or send them.
      </p>
    </section>
  );
}

/**
 * Writes the device cannot name an author for — queued before this version shipped, or on a
 * browser never told who was signed in. Adopting them to whoever is here now is the defect this
 * feature exists to prevent, and discarding destroys a hike that exists in one place, so the
 * decision goes to the person looking at the screen. Shown only far enough to recognise: the
 * trail, the day, the distance. Nothing written after this ships is unattributed, so the
 * section appears once per device and never returns.
 */
function Unclaimed({
  hikes,
  reports,
  readerId,
  onSettled,
}: {
  hikes: PendingActivitiesApi;
  reports: PendingReviewsApi;
  readerId: string | null;
  /** Called when a claim or a discard finishes, so focus leaves a control that is about to go. */
  onSettled: () => void;
}) {
  const units = useUnits();
  const [confirming, setConfirming] = useState<string | null>(null);
  /**
   * The trail whose claim would destroy a report of the reader's own. Claiming re-keys the row
   * to `reviewKey(you, trail)`, which your own queued report already occupies; `adopt` refuses
   * and says so, and this holds that answer until the reader settles it.
   */
  const [colliding, setColliding] = useState<string | null>(null);
  const total = hikes.unattributed.length + reports.unattributed.length;

  if (total === 0) return null;

  return (
    <section aria-labelledby="unclaimed-heading" className="mt-lg">
      <h2 id="unclaimed-heading" className="collar text-survey">
        We cannot tell whose these are
      </h2>
      <p className="mt-sm max-w-measure font-text text-body text-ink-muted">
        {total === 1 ? 'This was' : 'These were'} saved on this device before it recorded who wrote
        {total === 1 ? ' it' : ' them'}. Send{' '}
        {total === 1 ? 'it as yourself if it is yours' : 'each one as yourself if it is yours'}, or
        discard {total === 1 ? 'it' : 'them'}. Nothing here will go anywhere on its own.
      </p>

      {readerId === null ? (
        <p className="collar mt-sm border-l-2 border-survey pl-md text-survey">
          Sign in to send or discard these.
        </p>
      ) : null}

      <ul className="mt-sm divide-y divide-bezel border-y border-bezel">
        {hikes.unattributed.map((row) => (
          <li
            key={row.activityId}
            className="flex flex-wrap items-baseline gap-x-lg gap-y-xs py-md"
          >
            <span className="font-text text-body-lg text-ink">{row.trailName ?? 'A hike'}</span>
            <span className="collar">
              {new Date(row.startedAt).toLocaleString(undefined, {
                weekday: 'short',
                day: 'numeric',
                month: 'short',
                hour: 'numeric',
                minute: '2-digit',
              })}{' '}
              · {formatDistance(row.distanceM, units)}
            </span>
            <span className="ml-auto flex flex-wrap items-baseline gap-lg">
              {readerId === null ? null : (
                <button
                  type="button"
                  disabled={hikes.busy}
                  onClick={() => {
                    // `catch` before `finally` for the reason written on the report claim
                    // below: a store that refuses the write must not reject into `void` and
                    // leave the press unanswered. The sentence comes from `adopt`.
                    void hikes
                      .adopt(row.activityId)
                      .catch(() => undefined)
                      .finally(onSettled);
                  }}
                  className="collar rounded-hair px-sm hover:text-ink disabled:opacity-40"
                >
                  Add it to my account
                </button>
              )}
              {confirming === row.activityId ? (
                <>
                  <span className="text-caption text-ink-muted">Throw it away?</span>
                  <button
                    type="button"
                    onClick={() => {
                      void hikes.discard(row.activityId).finally(() => {
                        setConfirming(null);
                        onSettled();
                      });
                    }}
                    className={`${BUTTON_COLLAR} ${DANGER} ${HEIGHT.panel} px-md`}
                  >
                    Discard
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirming(null)}
                    className={`${BUTTON_COLLAR} ${GHOST} ${HEIGHT.panel} px-sm`}
                  >
                    Keep it
                  </button>
                </>
              ) : readerId === null ? null : (
                <button
                  type="button"
                  onClick={() => setConfirming(row.activityId)}
                  className="collar rounded-hair px-sm text-ink-muted hover:text-survey"
                >
                  Discard
                </button>
              )}
            </span>
          </li>
        ))}

        {reports.unattributed.map((row) => (
          <li key={row.key} className="flex flex-wrap items-baseline gap-x-lg gap-y-xs py-md">
            <Link
              href={row.trailPath}
              className="rounded-hair font-text text-body-lg text-ink hover:text-woodland"
            >
              {row.trailName}
            </Link>
            <span className="collar">A report, written {taken(row.queuedAt)}</span>
            <span className="ml-auto flex flex-wrap items-baseline gap-lg">
              {/*
               * You already have a report queued for this trail, and the two cannot both be
               * kept: a report is keyed by trail and author, so claiming this one writes over
               * yours. Named rather than resolved — the device knows there is a conflict and
               * cannot know which text the hiker meant.
               *
               * The same sentence is in the page's live region, put there by `adopt`. Not a
               * duplicate by accident: this copy is the one a sighted reader needs beside the
               * two buttons it is asking about, and that copy is the one anybody who cannot
               * see the row appear is told. One wall, one wording.
               */}
              {colliding === row.trailId ? (
                <>
                  <span className="max-w-measure text-caption text-ink">
                    You already have a report waiting for this trail. Keep yours, or replace it with
                    this one.
                  </span>
                  <button
                    type="button"
                    disabled={reports.busy}
                    onClick={() => {
                      void reports
                        .adopt(row.trailId, { replace: true })
                        .catch(() => undefined)
                        .finally(() => {
                          setColliding(null);
                          onSettled();
                        });
                    }}
                    className={`${BUTTON_COLLAR} ${DANGER} ${HEIGHT.panel} px-md`}
                  >
                    Replace mine
                  </button>
                  <button
                    type="button"
                    onClick={() => setColliding(null)}
                    className={`${BUTTON_COLLAR} ${GHOST} ${HEIGHT.panel} px-sm`}
                  >
                    Keep mine
                  </button>
                </>
              ) : readerId === null ? null : (
                <button
                  type="button"
                  disabled={reports.busy}
                  onClick={() => {
                    void reports
                      .adopt(row.trailId)
                      .then((outcome) => {
                        if (outcome === 'would-replace-your-own') setColliding(row.trailId);
                      })
                      /*
                       * Every outcome answers the press. `onSettled` on the success branch
                       * alone left a collision — the one outcome that asks the reader a
                       * question — replacing the pressed button and dropping focus to
                       * `<body>`. The `catch` matters for the same reason: without it a store
                       * that refuses the claim rejects into `void` and says nothing.
                       */
                      .catch(() => undefined)
                      .finally(onSettled);
                  }}
                  className="collar rounded-hair px-sm hover:text-ink disabled:opacity-40"
                >
                  Post it as me
                </button>
              )}
              {confirming === row.key ? (
                <>
                  <span className="text-caption text-ink-muted">Throw it away?</span>
                  <button
                    type="button"
                    onClick={() => {
                      void reports.discardUnattributed(row.trailId).finally(() => {
                        setConfirming(null);
                        onSettled();
                      });
                    }}
                    className={`${BUTTON_COLLAR} ${DANGER} ${HEIGHT.panel} px-md`}
                  >
                    Discard
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirming(null)}
                    className={`${BUTTON_COLLAR} ${GHOST} ${HEIGHT.panel} px-sm`}
                  >
                    Keep it
                  </button>
                </>
              ) : readerId === null ? null : (
                <button
                  type="button"
                  onClick={() => setConfirming(row.key)}
                  className="collar rounded-hair px-sm text-ink-muted hover:text-survey"
                >
                  Discard
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Hikes recorded where there was no signal to send them over. First on the page, ahead of
 * reports, because a report is a paragraph and a hike is a day. Same water/survey grammar as
 * the reports below, so the two read as one list of debts.
 */
function QueuedHikes({
  api,
  onSettled,
}: {
  api: PendingActivitiesApi;
  /** Called when a run finishes, so focus can be moved off a control that is about to go. */
  onSettled: () => void;
}) {
  const { activities, busy, sendAll, send, discard } = api;
  const online = useOnline();
  const units = useUnits();
  const [confirming, setConfirming] = useState<string | null>(null);

  if (activities.length === 0) return null;

  const blocked = activities.filter((row) => row.blocked).length;

  return (
    <section aria-labelledby="queued-hikes-heading" aria-busy={busy} className="mt-lg">
      <div className="flex flex-wrap items-baseline justify-between gap-sm">
        <h2
          id="queued-hikes-heading"
          className={`collar ${blocked > 0 ? 'text-survey' : 'text-water'}`}
        >
          {blocked > 0 ? 'Not added' : 'Waiting to be added'}
        </h2>
        {online ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              void sendAll().finally(onSettled);
            }}
            className={`${BUTTON_COLLAR} ${SECONDARY} ${HEIGHT.panel} px-md`}
          >
            {busy ? 'Adding…' : `Add ${activities.length} ${plural(activities.length, 'hike')}`}
          </button>
        ) : null}
      </div>

      <ul className="mt-sm divide-y divide-bezel border-y border-bezel">
        {activities.map((row) => (
          <li
            key={row.activityId}
            className="flex flex-wrap items-baseline gap-x-lg gap-y-xs py-md"
          >
            <span className="font-text text-body-lg text-ink">{row.trailName ?? 'A hike'}</span>
            <span className="collar">
              {new Date(row.startedAt).toLocaleString(undefined, {
                weekday: 'short',
                day: 'numeric',
                month: 'short',
                hour: 'numeric',
                minute: '2-digit',
              })}{' '}
              · {formatDistance(row.distanceM, units)}
              {row.finish ? '' : ' · not finished'}
            </span>
            <span className="ml-auto flex flex-wrap items-baseline gap-lg">
              {/* Tabular so the count does not jitter as the drain advances it. */}
              <span className="font-mono text-caption tabular-nums text-ink">
                {row.sent} of {row.count} fixes sent
              </span>
              <span className={`collar ${row.blocked ? 'text-survey' : 'text-water'}`}>
                {row.blocked
                  ? (row.lastError ?? 'The server would not take it.')
                  : 'Waiting for signal'}
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  void send(row.activityId).finally(onSettled);
                }}
                className={`${BUTTON_COLLAR} ${GHOST} ${HEIGHT.panel} px-sm`}
              >
                Add it now
              </button>
              {/*
               * Two taps, like a report and for a stronger version of the same reason: these
               * fixes are the only record of where somebody walked that day, and no server
               * has a copy yet.
               */}
              {confirming === row.activityId ? (
                <>
                  <span className="text-caption text-ink-muted">Throw it away?</span>
                  <button
                    type="button"
                    onClick={() => {
                      void discard(row.activityId).finally(() => setConfirming(null));
                    }}
                    className={`${BUTTON_COLLAR} ${DANGER} ${HEIGHT.panel} px-md`}
                  >
                    Discard
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirming(null)}
                    className={`${BUTTON_COLLAR} ${GHOST} ${HEIGHT.panel} px-sm`}
                  >
                    Keep it
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirming(row.activityId)}
                  className={`collar ${HEIGHT.panel} inline-flex items-center rounded-hair px-sm text-ink-muted hover:text-survey`}
                >
                  Discard
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Downloads() {
  const { trails, bytes, storage, loading, remove } = useDownloads();
  const online = useOnline();
  const units = useUnits();
  const [confirmingAll, setConfirmingAll] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  if (loading) {
    return (
      <p className="mt-lg font-text text-body text-ink-muted">Reading what is on this device…</p>
    );
  }

  if (trails.length === 0) {
    return (
      <div className="mt-lg">
        <p className="max-w-measure font-text text-body-lg text-ink-muted">
          Nothing downloaded yet. Open a trail and press{' '}
          <span className="text-ink">Take offline</span> — it keeps the page, the route, the
          waypoints and the map along the line, so the trail still opens where there is no signal to
          fetch it from.
        </p>
        {/*
         * `/nearby` rather than `/`, which is the second inbound link the nearby list has in
         * the whole application — the first being "Near you" in the map's own neatline, folded
         * behind the index at phone width. The list was `/` until the map took that address,
         * and a reader who has nothing downloaded and is standing somewhere is better served by
         * a short list of the hikes around them than by a sheet to pan. The map is still one
         * tap away from here through the wordmark, which is not true in the other direction.
         */}
        <Link
          href="/nearby"
          className={`${BUTTON_COLLAR} ${SECONDARY} ${HEIGHT.touch} mt-lg px-md`}
        >
          Find a trail
        </Link>
      </div>
    );
  }

  return (
    <div className="mt-lg">
      {!online ? (
        <p className="collar mb-lg border-l-2 border-water pl-md text-water">
          Offline. These {plural(trails.length, 'trail')} open; everything else will not.
        </p>
      ) : null}

      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-hair border border-bezel bg-bezel sm:grid-cols-3">
        <div className="bg-surface px-lg py-md">
          <dt className="collar">Downloads</dt>
          <dd className="mt-xs font-mono text-body-lg">{trails.length}</dd>
        </div>
        <div className="bg-surface px-lg py-md">
          <dt className="collar">These trails</dt>
          <dd className="mt-xs font-mono text-body-lg">{formatBytes(bytes)}</dd>
        </div>
        <div className="bg-surface px-lg py-md">
          <dt className="collar">This site, all told</dt>
          <dd className="mt-xs font-mono text-body-lg">
            {storage ? formatBytes(storage.usage) : '—'}
            {storage ? (
              <span className="text-caption text-ink-muted"> of {formatBytes(storage.quota)}</span>
            ) : null}
          </dd>
        </div>
      </dl>

      <ul className="mt-xl divide-y divide-bezel border-y border-bezel">
        {trails.map((row) => (
          <li key={row.trailId} className="flex flex-wrap items-baseline gap-x-lg gap-y-xs py-md">
            <Link
              href={`/trails/${row.slug}`}
              className="rounded-hair font-text text-body-lg text-ink hover:text-woodland"
            >
              {trailTitle(titled(row))}
            </Link>
            <span className="collar">
              {row.regionName ? `${row.regionName} · ` : ''}
              {formatDistance(row.lengthM, units)} · ↑{formatElevation(row.gainM, units)}
            </span>
            <span className="ml-auto flex items-baseline gap-lg">
              <span className="collar">
                Taken {taken(row.downloadedAt)}
                {row.truncated ? ` · sharp to z${row.coveredMaxZoom}` : ''}
              </span>
              <span className="font-mono text-caption text-ink">{formatBytes(row.bytes)}</span>
              <button
                type="button"
                disabled={busy === row.trailId}
                onClick={() => {
                  setBusy(row.trailId);
                  void remove([row.trailId]).finally(() => setBusy(null));
                }}
                className="collar rounded-hair px-sm text-ink-muted hover:text-survey disabled:opacity-50"
              >
                {busy === row.trailId ? 'Removing…' : 'Remove'}
              </button>
            </span>
          </li>
        ))}
      </ul>

      <div className="mt-xl flex flex-wrap items-center gap-md">
        {confirmingAll ? (
          <>
            <span className="font-text text-body text-ink-muted">
              Remove all {trails.length} {plural(trails.length, 'download')} and free{' '}
              {formatBytes(bytes)}?
            </span>
            <button
              type="button"
              onClick={() => {
                setBusy('all');
                void remove(trails.map((row) => row.trailId)).finally(() => {
                  setBusy(null);
                  setConfirmingAll(false);
                });
              }}
              className={`${BUTTON_COLLAR} ${DANGER} ${HEIGHT.panel} px-md`}
            >
              {busy === 'all' ? 'Removing…' : 'Remove them all'}
            </button>
            <button
              type="button"
              onClick={() => setConfirmingAll(false)}
              className={`${BUTTON_COLLAR} ${GHOST} ${HEIGHT.panel} px-sm`}
            >
              Keep them
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmingAll(true)}
            className={`${BUTTON_COLLAR} ${GHOST} ${HEIGHT.panel} px-md`}
          >
            Remove all downloads
          </button>
        )}
      </div>

      <p className="mt-2xl max-w-measure font-text text-caption text-ink-muted">
        Map tiles are shared between downloads that overlap, so removing one trail frees less than
        its listed size when a neighbour still needs the same ground. The figure above is what each
        download cost on its own.
      </p>
    </div>
  );
}
