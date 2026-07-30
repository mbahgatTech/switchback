'use client';

/**
 * What is on this device.
 *
 * A storage manager is a page about trust: a hiker who cannot see what a download cost, or
 * cannot get the space back without deleting the whole app, stops downloading. So every row
 * carries its measured size, the origin's real usage sits at the top beside the browser's
 * ceiling, and removal is one press with one confirmation.
 *
 * Two numbers are shown rather than one, because they answer different questions and neither
 * is a substitute for the other. Ours is what these trails cost. The browser's is everything
 * this origin holds — including the application shell and pages visited but never downloaded
 * — and it is the number that decides when the browser starts evicting things on its own.
 *
 * The page also carries what the device owes the server: reports written where there was no
 * signal, and hikes recorded in the same place. They are listed first, because a download is
 * a possession and a queued write is a debt, and the debt is the thing somebody would want to
 * settle before closing the tab. A hike sitting in storage with nothing on screen to say so
 * is worse than an error — it looks exactly like data loss.
 */

import { useRef, useState } from 'react';
import Link from 'next/link';
import { formatBytes, formatDistance, formatElevation, plural } from '@switchback/core';
import { useUnits } from '@/components/units';
import { useDownloads, useOnline } from '@/offline/use-offline';
import {
  usePendingActivities,
  usePendingReviews,
  type PendingActivitiesApi,
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
 * Reports the device is holding on the server's behalf.
 *
 * Renders nothing when there is nothing owed, which is the ordinary case — a block that says
 * "no reports waiting" would be a permanent reminder of a problem nobody has.
 *
 * Water for the ones still waiting on a connection, survey for the ones the server actually
 * refused. The plates carry the difference so the words do not have to: one is the network's
 * fault and needs nothing from the reader, the other needs a decision.
 */
function QueuedReports() {
  const { reviews, busy, flushAll, post, discard } = usePendingReviews();
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
          <li key={row.trailId} className="flex flex-wrap items-baseline gap-x-lg gap-y-xs py-md">
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
                className="collar rounded-hair px-sm hover:text-ink disabled:opacity-40"
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

export function DownloadsManager() {
  const hikes = usePendingActivities();
  const status = useRef<HTMLParagraphElement | null>(null);

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

      <QueuedHikes
        api={hikes}
        onSettled={() => {
          // The pressed control is about to be destroyed — disabling it has already taken the
          // focus to `<body>`, and the section it lives in disappears when the queue empties.
          // Focus lands where the outcome is written instead.
          status.current?.focus();
        }}
      />
      <QueuedReports />
      <Downloads />
    </>
  );
}

/**
 * Hikes recorded where there was no signal to send them over.
 *
 * First on the page, ahead of reports, because it is the larger debt: a report is a paragraph
 * and a hike is a day. Renders nothing when there is nothing owed.
 *
 * Same grammar as the reports below it — water while it is only the network's fault, survey
 * once the server has actually refused something — so the two read as one list of debts in
 * two kinds rather than as two features that happen to share a page.
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
                className="collar rounded-hair px-sm hover:text-ink disabled:opacity-40"
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
              {row.name}
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
