import Link from 'next/link';
import type { ListSummary } from '@switchback/core';
import {
  SYSTEM_LIST_EMPTY,
  formatDistance,
  formatElevation,
  isSystemList,
  plural,
} from '@switchback/core';
import { Tally } from './tally';
import { Photograph } from '../photos/photograph';
import { viewerUnits } from '../../lib/units';

/**
 * One list in the index.
 *
 * The card's job is to answer "what kind of list is this" before it is opened, and the count
 * cannot do that — six strolls and six through-hikes are both "6 trails". So the count is
 * demoted to a figure in the rail and the {@link Tally} rule is given the width: a scale bar
 * whose divisions are the hikes, which shows at a glance whether this is one long project
 * with some short days attached or a set of matched outings.
 *
 * The name is the link, with an overlay making the whole card clickable — the same
 * construction as the index cards, and for the same reason: a card-shaped `<a>` announces
 * its heading, its rule and its four figures as one enormous link name.
 */

export async function ListCard({ list }: { list: ListSummary }) {
  const units = await viewerUnits();
  const empty = list.trailCount === 0;
  /*
   * The completed list counts hikes, not trails: the same loop done three times is three
   * rows in it and three divisions on its rule, and calling that "3 trails" would describe
   * the map instead of the person.
   */
  const noun = list.kind === 'completed' ? 'hike' : 'trail';

  return (
    <li>
      <article className="group relative flex h-full gap-md rounded-hair border border-bezel p-md transition-colors duration-quick ease-standard hover:border-ink-muted">
        <Photograph
          src={list.coverPhotoUrl}
          alt=""
          loading="lazy"
          className="h-[64px] w-[64px] shrink-0 rounded-hair object-cover"
          fallback={
            /*
             * An empty list gets a blank plate rather than a grey box — the ruled corner of an
             * unused sheet, which is what an empty list is. It is the same 64 px as a cover so
             * a column of lists does not step in and out as they fill up, and it is what a
             * cover whose object has gone missing falls back to for the same reason.
             */
            <div
              aria-hidden
              className="h-[64px] w-[64px] shrink-0 rounded-hair border border-dashed border-bezel"
            />
          }
        />

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-start justify-between gap-sm">
            <h3 className="text-body font-medium leading-tight text-ink">
              <Link
                href={`/lists/${list.slug}`}
                className="rounded-hair after:absolute after:inset-0 after:content-[''] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
              >
                {list.name}
              </Link>
            </h3>
            {list.isPublic ? <span className="collar shrink-0">Public</span> : null}
          </div>

          {empty ? (
            <p className="mt-xs text-caption text-ink-muted">
              {isSystemList(list.kind) ? SYSTEM_LIST_EMPTY[list.kind] : 'Nothing in it yet.'}
            </p>
          ) : (
            <>
              {list.description ? (
                <p className="mt-xs line-clamp-1 text-caption text-ink-muted">{list.description}</p>
              ) : null}

              {/*
               * The label is the rule's alt text, not a caption — it stands in for the
               * graphic where the graphic cannot be seen, so it says what the bar is a
               * picture of. The figures below print the same facts in type for everyone.
               */}
              <Tally
                lengths={list.lengths}
                label={`${list.trailCount} ${plural(list.trailCount, noun)}, ${formatDistance(list.totalLengthM, units)} in total`}
                className="mt-sm"
              />

              <dl className="mt-sm flex flex-wrap items-baseline gap-x-md gap-y-xs font-mono text-micro text-ink-muted">
                {/* Counting its own noun: a bare "1" beside "6.7 km" is a number with no unit. */}
                <Figure
                  label={list.kind === 'completed' ? 'Hikes' : 'Trails'}
                  value={`${list.trailCount} ${plural(list.trailCount, noun)}`}
                />
                <Figure label="Distance" value={formatDistance(list.totalLengthM, units)} />
                <Figure label="Ascent" value={`↑${formatElevation(list.totalGainM, units)}`} />
              </dl>
            </>
          )}
        </div>
      </article>
    </li>
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
