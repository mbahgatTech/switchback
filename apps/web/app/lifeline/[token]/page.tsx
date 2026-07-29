import type { Metadata } from 'next';
import Link from 'next/link';
import { TRPCError } from '@trpc/server';
import {
  ATTRIBUTION,
  BRAND,
  LIFELINE_STATUS_LABELS,
  type LifelineFollow,
  formatElevation,
  formatSpan,
} from '@switchback/core';
import type { LineString } from '@switchback/core';
import { Blaze } from '@/components/blaze';
import { LifelineMap } from '@/components/lifeline/lifeline-map';
import { Refresher } from '@/components/lifeline/refresher';
import { ReturnGauge } from '@/components/lifeline/return-gauge';
import { viewerUnits } from '@/lib/units';
import { caller } from '@/trpc/server';
import { Wordmark } from '@/components/wordmark';

/**
 * Somebody's Lifeline.
 *
 * The only page in this product written for a reader who did not choose to be here. They were
 * sent a link by somebody going up a hill, and they will open it once at lunchtime and again,
 * differently, if it gets dark. Both readings have to work, and the second one is the one
 * that matters — which is why the page is arranged around a single question, answered before
 * anything else is said: *is this where they should be by now?*
 *
 * A reading page, so `sheet`, with the map set in as a dark `field` instrument the way the
 * trail page does it. The gauge above the map is the hero rather than the map itself, on
 * purpose: a position without a deadline beside it tells a worried person almost nothing.
 *
 * **Server-rendered, and correct without JavaScript.** Lateness is derived on the server on
 * every read, so this page is right whether or not the cron that persists status has run,
 * whether or not the hiker's phone has had signal for an hour, and whether or not the
 * refresher below ever gets to run. The rendered time is printed in plain sight so a stale
 * tab is visibly stale rather than quietly wrong.
 *
 * **No account, no sign-in, no nav into the rest of the site.** The header goes home and
 * stops. Whoever holds this link is here for one person, and a row of product links across
 * the top of it would be the product asking for attention at somebody's worst hour.
 */

interface PageProps {
  params: Promise<{ token: string }>;
}

/** Not indexed, not followed, not archived. `next.config.ts` sets the header to match. */
export const metadata: Metadata = {
  title: 'Lifeline',
  robots: { index: false, follow: false, nocache: true },
};

/** Always fresh. A cached position page is a wrong position page. */
export const dynamic = 'force-dynamic';

/**
 * How often the page reloads itself while somebody is watching it.
 *
 * Two minutes, against a ping cadence measured in minutes and a hiking pace measured in
 * kilometres per hour. Faster would redraw the same dot repeatedly and read as urgency the
 * data cannot support; slower and somebody refreshing by hand would beat it.
 */
const REFRESH_S = 120;

export default async function LifelinePage({ params }: PageProps) {
  const { token } = await params;

  let follow: LifelineFollow;
  try {
    follow = await caller.lifeline.follow({ token });
  } catch (error) {
    if (error instanceof TRPCError && error.code === 'NOT_FOUND') {
      return <Missing message={error.message} />;
    }
    throw error;
  }

  // The trail's line, when they named one. Additive: the page is complete without it, and a
  // trail that has since been re-ingested or removed must not take the position down with it.
  const route: LineString | null = follow.trail
    ? await caller.trails
        .byId({ id: follow.trail.id })
        .then((trail) => trail.geometry)
        .catch(() => null)
    : null;

  const now = new Date();
  /*
   * The follower's own units, not the hiker's. Whoever opens this link is the person who
   * may have to decide whether "600 m" is high enough to be worrying, and they can only do
   * that in the units they think in — the hiker is not reading this page.
   */
  const units = await viewerUnits();
  const live = follow.status === 'active' || follow.status === 'overdue';
  const late = follow.status === 'overdue';

  return (
    <div data-scheme="sheet" className="min-h-dvh bg-canvas text-ink">
      <Refresher everyS={REFRESH_S} />

      <header className="mx-auto flex max-w-[880px] items-center justify-between px-xl py-lg">
        <Wordmark />
        <span className="collar">Lifeline</span>
      </header>

      <main className="mx-auto max-w-[880px] px-xl pb-4xl">
        {/*
         * The status line and the headline say the same thing twice, in two registers. The
         * chip is the machine's word for it and never changes shape; the sentence is what a
         * person would say. Somebody scanning gets the first, somebody reading gets the second.
         */}
        <p className="collar flex flex-wrap items-center gap-sm">
          <span
            className={`inline-flex items-center rounded-hair border px-xs py-hair ${
              late ? 'border-survey text-survey' : 'border-bezel text-ink-muted'
            }`}
          >
            {LIFELINE_STATUS_LABELS[follow.status]}
          </span>
          {follow.contactName ? <span>Left with {follow.contactName}</span> : null}
        </p>

        <h1 className="mt-md text-h3 font-bold text-balance">{headline(follow)}</h1>

        <p className="mt-sm font-text text-body-lg text-ink-muted">
          {follow.trail ? (
            <>
              on{' '}
              <Link
                href={`/trails/${follow.trail.slug}`}
                className="rounded-hair underline decoration-bezel underline-offset-4 hover:decoration-ink"
              >
                {follow.trail.name}
              </Link>
              {follow.trail.regionName ? `, ${follow.trail.regionName}` : null}
            </>
          ) : (
            'No trail was named for this hike.'
          )}
        </p>

        {/*
         * The gauge. Given the width of the column and nothing else on its line, because it
         * is the answer to the only question the reader came with.
         */}
        <div className="mt-xl">
          <h2 className="collar">Return time</h2>
          <ReturnGauge
            className="mt-sm h-[128px] w-full"
            startedAt={follow.startedAt}
            expectedReturnAt={follow.expectedReturnAt}
            endedAt={follow.endedAt}
            now={now}
          />
        </div>

        {follow.at ? (
          <>
            <div
              data-scheme="field"
              className="relative mt-xl h-[clamp(280px,44vh,480px)] w-full overflow-hidden rounded-panel border border-bezel"
            >
              <LifelineMap
                at={follow.at}
                route={route}
                stale={follow.stale}
                className="h-full w-full"
              />
            </div>

            <dl className="mt-lg grid grid-cols-2 gap-px overflow-hidden rounded-hair border border-bezel bg-bezel sm:grid-cols-4">
              <Figure label="Last heard" value={clock(follow.lastPingAt)} />
              <Figure
                label="Fix age"
                value={follow.lastPingAt ? fixAge(ageS(follow.lastPingAt, now)) : '—'}
                alarm={follow.stale}
              />
              <Figure
                label="Elevation"
                value={follow.eleM == null ? '—' : formatElevation(follow.eleM, units)}
              />
              <Figure
                label="Battery"
                value={follow.batteryPct == null ? '—' : `${follow.batteryPct}%`}
                alarm={follow.batteryPct != null && follow.batteryPct <= 15}
              />
            </dl>

            {follow.stale ? (
              <p className="mt-sm font-text text-body text-ink-muted">
                Nothing has come through for {formatSpan(ageS(follow.lastPingAt, now))}. That is
                normal in a valley or under trees — a phone with no signal cannot send, and catches
                up when it finds one.
              </p>
            ) : null}
          </>
        ) : (
          <p className="mt-xl rounded-hair border border-dashed border-bezel px-md py-lg text-center font-text text-body text-ink-muted">
            {live
              ? 'No position has come through yet. Their phone sends one whenever it can find signal.'
              : 'This hike is over, so the map is no longer shown. A Lifeline stops giving a position the moment it ends.'}
          </p>
        )}

        {follow.message ? (
          <section className="mt-2xl max-w-measure-wide">
            <h2 className="collar">What they said</h2>
            <blockquote className="mt-sm border-l-2 border-contour pl-md font-text text-body-lg leading-relaxed">
              {follow.message}
            </blockquote>
          </section>
        ) : null}

        {late ? <Dispatch follow={follow} now={now} /> : null}

        <footer className="mt-4xl border-t border-bezel pt-lg">
          <p className="collar">
            Drawn at {clock(now)} · updates itself every {REFRESH_S / 60} minutes ·{' '}
            <a href={ATTRIBUTION.osm.href} className="rounded-hair hover:text-ink">
              {ATTRIBUTION.osm.label}
            </a>
          </p>
          <p className="mt-sm max-w-measure-wide font-text text-caption leading-relaxed text-ink-muted">
            {BRAND.name} shows the last position {firstName(follow.hikerName)}&rsquo;s phone was
            able to send. It is not a tracker, it does not know where they are now, and it is not a
            rescue service — nobody is alerted by this page but you.
          </p>
        </footer>
      </main>
    </div>
  );
}

/**
 * What to do about it, and the facts to do it with.
 *
 * Shown only once somebody is actually overdue. A page that carried emergency instructions at
 * all times would train the reader to scroll past them, which is the one thing that must not
 * happen on the day they matter.
 *
 * The card is the useful part. Mountain rescue and every emergency dispatcher ask the same
 * opening questions — who, where, when were they last heard from — and a person looking at a
 * map on a phone in a car park is in no state to compose that from a screen full of prose.
 * So it is set as a card to read aloud: decimal degrees to five places, which is about a
 * metre and the format every service accepts, and times in full rather than as intervals.
 *
 * No emergency number is printed. It is different in every country, this page does not know
 * where the reader is standing, and a wrong number here would be worse than none.
 */
function Dispatch({ follow, now }: { follow: LifelineFollow; now: Date }) {
  return (
    <section className="mt-2xl rounded-panel border border-survey">
      <h2 className="collar border-b border-survey px-md py-sm text-survey">
        {firstName(follow.hikerName)} is {formatSpan(follow.overdueByS)} overdue
      </h2>

      <div className="px-md py-lg">
        <ol className="max-w-measure-wide list-decimal space-y-sm pl-lg font-text text-body leading-relaxed marker:font-mono marker:text-caption marker:text-ink-muted">
          <li>
            Try calling and messaging them. Being late is ordinary — a slower party, a longer way
            round, a phone that died at the top.
          </li>
          <li>
            Check whether the fix below has moved since you last looked. This page refreshes on its
            own; a position that is still updating means a phone that is still working.
          </li>
          <li>
            If you cannot reach them and you are worried, call your local emergency number and ask
            for mountain rescue or the police. Read them the card below.
          </li>
        </ol>

        <div className="mt-lg rounded-hair border border-bezel bg-surface p-md">
          <p className="collar">Read this to them</p>
          <dl className="mt-sm grid gap-x-lg gap-y-xs font-mono text-caption sm:grid-cols-[auto_1fr]">
            <Line label="Who" value={follow.hikerName} />
            <Line
              label="Where"
              value={
                follow.trail
                  ? `${follow.trail.name}${follow.trail.regionName ? `, ${follow.trail.regionName}` : ''}`
                  : 'Trail not named'
              }
            />
            <Line
              label="Last position"
              value={
                follow.at
                  ? `${follow.at[1].toFixed(5)}, ${follow.at[0].toFixed(5)}${
                      follow.eleM == null ? '' : ` at ${Math.round(follow.eleM)} m`
                    }`
                  : 'No position was ever received'
              }
            />
            <Line
              label="Recorded at"
              value={
                follow.lastPingAt
                  ? `${stamp(follow.lastPingAt)} (${formatSpan(ageS(follow.lastPingAt, now))} ago)`
                  : '—'
              }
            />
            <Line label="Set off" value={stamp(follow.startedAt)} />
            <Line label="Due back" value={stamp(follow.expectedReturnAt)} />
          </dl>
        </div>
      </div>
    </section>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-ink-muted">{label}</dt>
      <dd className="mb-xs sm:mb-0">{value}</dd>
    </>
  );
}

function Figure({
  label,
  value,
  alarm = false,
}: {
  label: string;
  value: string;
  alarm?: boolean;
}) {
  return (
    <div className="bg-canvas px-md py-md">
      <dt className="collar">{label}</dt>
      <dd className={`mt-hair font-mono text-body-lg ${alarm ? 'text-survey' : 'text-ink'}`}>
        {value}
      </dd>
    </div>
  );
}

/**
 * A link that points at nothing.
 *
 * Rendered here rather than handed to `notFound()` because the person reading it is most
 * likely somebody who mistyped or half-copied a link they were sent, at the moment they least
 * want a page that says 404. The message comes from the API, where it is written for them.
 */
function Missing({ message }: { message: string }) {
  return (
    <div data-scheme="sheet" className="grid min-h-dvh place-items-center bg-canvas text-ink">
      <main className="max-w-measure px-xl text-center">
        <Blaze size={28} className="mx-auto text-woodland" />
        <h1 className="mt-lg text-h4 font-bold">No hike at this link</h1>
        <p className="mt-md font-text text-body-lg leading-relaxed text-ink-muted">{message}</p>
        <p className="mt-lg font-text text-body text-ink-muted">
          Links are long and easy to break in half when they are pasted. Ask for it again if you are
          not sure you have all of it.
        </p>
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Words and numbers
// ---------------------------------------------------------------------------

/** The sentence a person would say, which is not the same as the status label. */
function headline(follow: LifelineFollow): string {
  const who = follow.hikerName;
  switch (follow.status) {
    case 'overdue':
      return `${who} is ${formatSpan(follow.overdueByS)} past when they said they would be back.`;
    case 'completed':
      return follow.endedAt
        ? `${who} got back safely at ${clock(follow.endedAt)}.`
        : `${who} got back safely.`;
    case 'cancelled':
      return `${who} called this hike off.`;
    default:
      return `${who} is out hiking.`;
  }
}

/**
 * First name only, for the places where the full name would read as a form field.
 *
 * Falls back to the whole string, which is right for a single word and right for the
 * `@handle` the API supplies when somebody has no display name.
 */
function firstName(name: string): string {
  return name.split(' ')[0] ?? name;
}

function ageS(at: Date | null, now: Date): number {
  if (!at) return 0;
  return Math.max(0, Math.round((now.getTime() - at.getTime()) / 1000));
}

/**
 * The same duration as `formatSpan`, cut to fit a figure cell.
 *
 * `formatSpan` writes for a sentence — "nothing has come through for less than a minute" —
 * and that phrase set in mono under a four-letter label wraps to three lines and stops
 * looking like a reading. A fresh fix is "just now" anywhere it is written as a value.
 */
function fixAge(seconds: number): string {
  return seconds < 60 ? 'just now' : formatSpan(seconds);
}

function clock(at: Date | null): string {
  if (!at) return '—';
  return at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

/** Day and time. The dispatch card cannot use a bare clock: a hike can cross midnight. */
function stamp(at: Date): string {
  return at.toLocaleString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}
