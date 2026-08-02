import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { TRPCError } from '@trpc/server';
import type { ListDetail } from '@switchback/core';
import {
  BRAND,
  SYSTEM_LIST_EMPTY,
  formatDateLabel,
  formatDistance,
  formatDuration,
  formatElevation,
  isSystemList,
  plural,
  trailTitle,
} from '@switchback/core';
import { DIFFICULTY_PLATE } from '@switchback/ui';
import { ListSettings } from '@/components/lists/list-settings';
import { RemoveItem } from '@/components/lists/remove-item';
import { Tally } from '@/components/lists/tally';
import { Photograph } from '@/components/photos/photograph';
import { SiteNav } from '@/components/site-nav';
import { Wordmark } from '@/components/wordmark';
import { viewerUnits } from '@/lib/units';
import { caller } from '@/trpc/server';

/**
 * One list.
 *
 * The same rule the index card carries, drawn at full width where its divisions are actually
 * readable — and directly under it, the hikes it is made of, in the order the list keeps
 * them. A completed list is ordered by date and shows one row per hike; every other list is
 * ordered by position and shows one row per trail. That difference is the feature, not an
 * inconsistency: a list is a plan, and a completion is a record.
 *
 * Public lists render for signed-out readers, which is the entire point of the flag. What
 * they do not get is the settings block or the per-row controls, because `isMine` is decided
 * on the server and this page never asks the browser to be trusted about it.
 */

interface PageProps {
  params: Promise<{ key: string }>;
}

async function loadList(key: string): Promise<ListDetail | null> {
  try {
    return await caller.lists.detail({ key });
  } catch (error) {
    if (error instanceof TRPCError && error.code === 'NOT_FOUND') return null;
    throw error;
  }
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { key } = await params;
  const list = await loadList(key);
  if (!list) return { title: 'List not found' };

  const units = await viewerUnits();

  return {
    title: list.name,
    description:
      list.description ??
      `${list.trailCount} ${plural(list.trailCount, list.kind === 'completed' ? 'hike' : 'trail')}, ${formatDistance(list.totalLengthM, units)} in total. ${BRAND.tagline}`,
    // A private list that leaks into an index is the flag failing at the one job it has.
    ...(list.isPublic ? {} : { robots: { index: false, follow: false } }),
  };
}

const DIFFICULTY_LABEL = { easy: 'Easy', moderate: 'Moderate', hard: 'Hard' } as const;

const PLATE_BG = {
  woodland: 'bg-woodland',
  contour: 'bg-contour',
  survey: 'bg-survey',
} as const;

export default async function ListPage({ params }: PageProps) {
  const { key } = await params;
  const [list, units] = await Promise.all([loadList(key), viewerUnits()]);
  if (!list) notFound();

  const owner = list.owner.name ?? (list.owner.username ? `@${list.owner.username}` : 'A hiker');
  /* The completed list counts hikes; every other list counts trails. See {@link ListCard}. */
  const noun = list.kind === 'completed' ? 'hike' : 'trail';

  return (
    <div data-scheme="sheet" className="min-h-dvh bg-canvas text-ink">
      <header className="mx-auto flex max-w-rail items-center justify-between px-xl py-lg">
        <Wordmark />
        <SiteNav current="lists" />
      </header>

      <main className="mx-auto max-w-rail px-xl pb-5xl">
        <p className="collar flex flex-wrap items-center gap-x-md gap-y-xs">
          {list.isMine ? (
            <Link href="/lists" className="rounded-hair hover:text-ink">
              ← All your lists
            </Link>
          ) : (
            <span>Kept by {owner}</span>
          )}
          {isSystemList(list.kind) ? null : <span>List</span>}
        </p>

        <h1 className="mt-md text-h3 font-bold text-balance">{list.name}</h1>

        {list.description ? (
          <p className="mt-md max-w-measure-wide font-text text-body-lg text-ink-muted">
            {list.description}
          </p>
        ) : null}

        {list.trailCount > 0 ? (
          <>
            {/*
             * Full width, because this is the one place the rule has room to be read as a
             * measurement rather than as a motif: every division is a hike, and the eye can
             * find the long one before reading a single number.
             */}
            <Tally
              lengths={list.lengths}
              label={`${list.trailCount} ${plural(list.trailCount, noun)}, ${formatDistance(list.totalLengthM, units)} in total`}
              className="mt-xl"
            />
            <dl className="mt-sm flex flex-wrap items-baseline gap-x-lg gap-y-xs font-mono text-micro text-ink-muted">
              <Figure
                label={list.kind === 'completed' ? 'Hikes' : 'Trails'}
                value={`${list.trailCount} ${plural(list.trailCount, noun)}`}
              />
              <Figure label="Distance" value={formatDistance(list.totalLengthM, units)} />
              <Figure label="Ascent" value={`↑${formatElevation(list.totalGainM, units)}`} />
              {list.lengths.length < list.trailCount ? (
                // Said out loud rather than silently truncated: the rule is the first
                // {LIST_TALLY_MAX} hikes and the figures beside it are all of them.
                //
                // Grouped as a `dt`/`dd` pair inside a `div` rather than left as the bare
                // `span` it was. A `dl` may hold only `dt`, `dd` and `div`, and a single
                // stray child makes assistive technology stop reading the element as a
                // description list at all — so this one caveat, on the rare path where the
                // rule is truncated, would have taken the three figures beside it down with
                // it. The term is off-screen because on the page this reads as a footnote to
                // the rule above; shown, it would look like a fourth figure.
                <div className="flex items-baseline gap-xs">
                  <dt className="sr-only">Coverage</dt>
                  <dd>rule shows the first {list.lengths.length}</dd>
                </div>
              ) : null}
            </dl>
          </>
        ) : null}

        {list.isMine ? (
          <div className="mt-xl">
            <ListSettings list={list} />
          </div>
        ) : null}

        <section className="mt-2xl">
          <h2 className="collar">
            {list.kind === 'completed' ? 'Hikes, most recent first' : 'In this list'}
          </h2>

          {list.items.length === 0 ? (
            <p className="mt-md max-w-measure font-text text-body text-ink-muted">
              {isSystemList(list.kind)
                ? SYSTEM_LIST_EMPTY[list.kind]
                : 'Nothing here yet. Open a trail and add it from the row under its name.'}
            </p>
          ) : (
            <ul className="mt-md flex flex-col gap-sm">
              {list.items.map((item) => (
                <li key={item.completionId ?? item.trail.id}>
                  <article className="group relative flex gap-md rounded-hair border border-bezel p-md transition-colors duration-quick ease-standard hover:border-ink-muted">
                    <Photograph
                      src={item.trail.primaryPhotoUrl}
                      alt=""
                      loading="lazy"
                      className="h-[72px] w-[72px] shrink-0 rounded-hair object-cover"
                      fallback={
                        <div
                          aria-hidden
                          className="flex h-[72px] w-[72px] shrink-0 items-center justify-center rounded-hair border border-bezel bg-bezel/30 font-mono text-micro text-ink-muted"
                        >
                          {formatElevation(item.trail.stats.maxEleM, units)}
                        </div>
                      }
                    />

                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-sm">
                        <h3 className="min-w-0 wrap-break-word text-body font-medium leading-tight text-ink">
                          <Link
                            href={`/trails/${item.trail.slug}`}
                            className="rounded-hair after:absolute after:inset-0 after:content-[''] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
                          >
                            {trailTitle(item.trail)}
                          </Link>
                        </h3>
                        {list.isMine ? (
                          <RemoveItem
                            listId={list.id}
                            trailId={item.trail.id}
                            completionId={item.completionId}
                            trailName={trailTitle(item.trail)}
                          />
                        ) : null}
                      </div>

                      <p className="mt-hair flex flex-wrap items-baseline gap-x-md text-caption text-ink-muted">
                        {item.trail.regionName ? (
                          <span className="truncate">{item.trail.regionName}</span>
                        ) : null}
                        {item.completedAt ? (
                          <span className="font-mono text-micro text-ink">
                            {formatDateLabel(item.completedAt)}
                          </span>
                        ) : null}
                      </p>

                      {item.note ? (
                        <p className="mt-xs max-w-measure-wide font-text text-caption text-ink">
                          {item.note}
                        </p>
                      ) : null}

                      <dl className="mt-sm flex flex-wrap items-baseline gap-x-md gap-y-xs font-mono text-micro text-ink-muted">
                        <Figure
                          label="Length"
                          value={formatDistance(item.trail.stats.lengthM, units)}
                        />
                        <Figure
                          label="Gain"
                          value={`↑${formatElevation(item.trail.stats.gainM, units)}`}
                        />
                        <Figure
                          label="Time"
                          value={formatDuration(item.trail.stats.estimatedTimeS)}
                        />
                        <div className="flex items-center gap-xs">
                          <span
                            aria-hidden
                            className={`h-[6px] w-[6px] rounded-full ${PLATE_BG[DIFFICULTY_PLATE[item.trail.difficulty]]}`}
                          />
                          <dt className="sr-only">Difficulty</dt>
                          <dd>{DIFFICULTY_LABEL[item.trail.difficulty]}</dd>
                        </div>
                      </dl>
                    </div>
                  </article>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-xs">
      <dt className="sr-only">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
