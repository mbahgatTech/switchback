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
 * Somebody's Lifeline, arranged around one question: is this where they should be by now?
 *
 * **Server-rendered and correct without JavaScript.** Lateness is derived on every read, so the
 * page is right whether or not the cron that persists status has run and whether or not the
 * refresher gets to run; the render time is printed so a stale tab is visibly stale. No account,
 * no sign-in, and no nav into the rest of the site — whoever holds this link is here for one
 * person.
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

/** Two minutes, against a ping cadence in minutes and a hiking pace in kilometres per hour. */
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
  // The follower's own units, not the hiker's: whoever opens this link is the one deciding
  // whether "600 m" is high enough to worry about, and the hiker is not reading this page.
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
        {/* The chip is the machine's word for the status; the sentence below is a person's. */}
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
                {follow.trail.title}
              </Link>
              {follow.trail.regionName ? `, ${follow.trail.regionName}` : null}
            </>
          ) : (
            'No trail was named for this hike.'
          )}
        </p>

        {/* The hero, not the map: a position with no deadline beside it says almost nothing. */}
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
 * What to do about it, and the facts to do it with. Shown only once somebody is overdue: standing
 * instructions train the reader to scroll past them. The card is set to be read aloud — decimal
 * degrees to five places, which is about a metre and the format every dispatcher accepts, and
 * times in full rather than as intervals. No emergency number: it differs by country and this
 * page does not know where the reader is standing.
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
                  ? `${follow.trail.title}${follow.trail.regionName ? `, ${follow.trail.regionName}` : ''}`
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
 * A link that points at nothing. Rendered here rather than handed to `notFound()`: the reader is
 * most likely somebody who half-copied a link, at the moment they least want a 404.
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

/** First name only. Falls back to the whole string — right for one word, and for an `@handle`. */
function firstName(name: string): string {
  return name.split(' ')[0] ?? name;
}

function ageS(at: Date | null, now: Date): number {
  if (!at) return 0;
  return Math.max(0, Math.round((now.getTime() - at.getTime()) / 1000));
}

/**
 * The same duration as `formatSpan`, cut to fit a figure cell — its sentence form wraps to three
 * lines under a four-letter label and stops looking like a reading.
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
