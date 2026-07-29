import Link from 'next/link';
import type { UnitSystem, HikeRecord, HikerProfile } from '@switchback/core';
import {
  formatDateLabel,
  formatDistance,
  formatElevation,
  formatTimeOnFoot,
  plural,
} from '@switchback/core';
import { Cadence } from './cadence';
import { Photograph } from '../photos/photograph';

/**
 * One hiker's record, as a page.
 *
 * Shared by `/u/[username]` and `/profile` so your own page and the one a stranger reads are
 * the same page — the alternative is two layouts that drift until you cannot tell what you
 * are publishing by looking at your own profile.
 *
 * **The order is an argument.** How much hiking, then when it happened, then the three hikes
 * worth telling someone about, then where. A profile that opened on a grid of badges would be
 * making a different claim about what the product is for.
 *
 * **Nothing here is a leaderboard.** No rank, no percentile, no comparison to anyone else.
 * The figures are somebody's own record of their own hiking, and the moment they are scored
 * against other people the honest thing to do becomes logging hikes you did not do.
 */

export function Hiker({
  hiker,
  units,
  now,
}: {
  hiker: HikerProfile;
  units: UnitSystem;
  now: Date;
}) {
  const { profile, stats } = hiker;
  const name = profile.name ?? (profile.username ? `@${profile.username}` : 'A hiker');
  const since = profile.createdAt.toLocaleDateString('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

  return (
    <>
      <div className="flex items-start gap-lg">
        <Portrait src={profile.image} name={name} />

        <div className="min-w-0 flex-1">
          <p className="collar flex flex-wrap items-center gap-x-md gap-y-xs">
            {profile.username && profile.name ? <span>@{profile.username}</span> : null}
            <span>Hiking here since {since}</span>
            {hiker.isMe ? (
              <>
                <Link href="/settings" className="rounded-hair hover:text-ink">
                  Settings
                </Link>
                {/*
                 * Downloads sits beside Settings rather than in the nav because it is the same
                 * kind of thing — housekeeping you go looking for — and because what is
                 * downloaded belongs to this browser, not to the account this page is about.
                 */}
                <Link href="/downloads" className="rounded-hair hover:text-ink">
                  Downloads
                </Link>
              </>
            ) : null}
          </p>

          <h1 className="mt-xs text-h3 font-bold text-balance">{name}</h1>
        </div>
      </div>

      {profile.bio ? (
        <p className="mt-md max-w-measure-wide font-text text-body-lg text-ink">{profile.bio}</p>
      ) : hiker.isMe ? (
        <p className="mt-md max-w-measure-wide font-text text-body-lg text-ink-muted">
          You have not written anything about yourself yet.{' '}
          <Link href="/settings" className="rounded-hair text-ink underline underline-offset-4">
            Add a line
          </Link>
          .
        </p>
      ) : null}

      {/*
       * The four totals, set as instrument readings: figure in mono at reading size, label in
       * collar caps beneath it. Distance leads because it is the number a hiker actually
       * carries around; the count of hikes is the denominator that makes it mean something.
       */}
      <dl className="mt-xl flex flex-wrap gap-x-2xl gap-y-lg border-t border-bezel pt-lg">
        <Reading
          label="Distance"
          value={formatDistance(stats.lengthM, units)}
          note={`${stats.hikes} ${plural(stats.hikes, 'hike')}`}
        />
        <Reading
          label="Ascent"
          value={`↑${formatElevation(stats.gainM, units)}`}
          note={`${stats.trails} ${plural(stats.trails, 'trail')}`}
        />
        <Reading
          label="Time on foot"
          value={stats.estimatedTimeS > 0 ? formatTimeOnFoot(stats.estimatedTimeS) : '—'}
          note="estimated"
        />
        <Reading
          label="Latest"
          value={stats.lastHike ? formatDateLabel(stats.lastHike) : '—'}
          note={stats.firstHike ? `first ${formatDateLabel(stats.firstHike)}` : 'nothing yet'}
        />
      </dl>

      <section className="mt-2xl">
        <h2 className="collar">Thirteen months</h2>
        <Cadence months={stats.months} units={units} className="mt-md max-w-[560px]" />
      </section>

      {stats.longest || stats.steepest || stats.highest ? (
        <section className="mt-3xl">
          <h2 className="collar">Records</h2>
          <ul className="mt-md grid gap-md sm:grid-cols-3">
            <Record
              label="Furthest"
              record={stats.longest}
              format={(m) => formatDistance(m, units)}
            />
            <Record
              label="Most climbed"
              record={stats.steepest}
              format={(m) => `↑${formatElevation(m, units)}`}
            />
            <Record
              label="Highest point"
              record={stats.highest}
              format={(m) => formatElevation(m, units)}
            />
          </ul>
        </section>
      ) : null}

      {stats.regions.length > 0 ? (
        <section className="mt-3xl">
          <h2 className="collar">Where</h2>
          <Regions regions={stats.regions} units={units} />
        </section>
      ) : null}

      <section className="mt-3xl">
        <h2 className="collar">Hikes</h2>
        {stats.hikes === 0 ? (
          /*
           * Checked before visibility, because the totals above already say nought. Telling a
           * reader the hikes are private when the count beside it reads 0 is the page arguing
           * with itself.
           */
          <p className="mt-md max-w-measure font-text text-body text-ink-muted">
            {hiker.isMe
              ? 'Nothing ticked off yet. Open a trail and mark it done the day you hike it.'
              : 'Nothing ticked off yet.'}
          </p>
        ) : hiker.hikesVisible && hiker.completedKey ? (
          <p className="mt-md max-w-measure font-text text-body text-ink-muted">
            <Link
              href={`/lists/${hiker.completedKey}`}
              className="rounded-hair text-ink underline underline-offset-4"
            >
              Every hike on the record
            </Link>
            , most recent first.
          </p>
        ) : (
          /*
           * Said, not hidden. A page that silently omits the hikes looks incomplete; a page
           * that says they are private describes a setting somebody chose.
           */
          <p className="mt-md max-w-measure font-text text-body text-ink-muted">
            The individual hikes are private. The totals above are not.
            {hiker.isMe ? (
              <>
                {' '}
                <Link
                  href="/lists/completed"
                  className="rounded-hair text-ink underline underline-offset-4"
                >
                  Change that on the list
                </Link>
                .
              </>
            ) : null}
          </p>
        )}

        {/*
         * A completion is a claim that a hike happened; a recording is the hike. They are
         * counted separately and live on separate pages, so the link out says which of the
         * two it leads to rather than being filed under "Hikes" and left ambiguous.
         */}
        {hiker.isMe ? (
          <p className="mt-md max-w-measure font-text text-body text-ink-muted">
            <Link href="/activities" className="rounded-hair text-ink underline underline-offset-4">
              Hikes you tracked
            </Link>{' '}
            are kept separately, with their tracks and times.
          </p>
        ) : null}
      </section>

      {hiker.lists.length > 0 ? (
        <section className="mt-3xl">
          <h2 className="collar">Lists</h2>
          <ul className="mt-md flex flex-col">
            {hiker.lists.map((list) => (
              <li key={list.id}>
                <Link
                  href={`/lists/${hiker.isMe ? list.slug : list.id}`}
                  className="flex items-baseline justify-between gap-md border-b border-bezel py-sm transition-colors duration-quick ease-standard hover:border-ink-muted"
                >
                  <span className="min-w-0 truncate text-body text-ink">{list.name}</span>
                  <span className="shrink-0 font-mono text-micro text-ink-muted">
                    {list.trailCount} {plural(list.trailCount, 'trail')}
                    {list.trailCount > 0 ? ` · ${formatDistance(list.totalLengthM, units)}` : ''}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {stats.reviews > 0 || stats.photos > 0 ? (
        <p className="collar mt-3xl">
          Contributed <span className="font-mono text-ink">{stats.reviews}</span>{' '}
          {plural(stats.reviews, 'report')} and{' '}
          <span className="font-mono text-ink">{stats.photos}</span> {plural(stats.photos, 'photo')}
        </p>
      ) : null}

      {/* Kept out of the reading flow but present, so the strip's window is never ambiguous. */}
      <p className="sr-only">
        Figures current as of {formatDateLabel(now.toISOString().slice(0, 10))}.
      </p>
    </>
  );
}

/**
 * The hiker, or the initial standing in for them.
 *
 * A square, not a circle. Circular avatars are the convention everywhere else on the web and
 * they carry a social-feed connotation this product does not want; a square plate with a
 * hairline round it reads as a specimen label, which is the register the rest of the page is
 * written in. Sized in the type scale rather than in pixels picked by eye, so it sits on the
 * same baseline grid as the name beside it.
 */
function Portrait({ src, name }: { src: string | null; name: string }) {
  return (
    <Photograph
      src={src}
      alt=""
      width={64}
      height={64}
      className="size-[64px] shrink-0 rounded-hair border border-bezel object-cover"
      fallback={
        /*
         * The initial, which is also where a stale avatar lands. These URLs belong to whichever
         * identity provider signed the hiker in and stop resolving when they change their
         * picture there — a hiker who has one is otherwise the person most likely to see a
         * broken-image glyph on their own profile.
         */
        <span
          aria-hidden
          className="flex size-[64px] shrink-0 items-center justify-center rounded-hair border border-bezel bg-surface font-display text-h4 text-ink-muted"
        >
          {name.replace(/^@/u, '').slice(0, 1).toUpperCase()}
        </span>
      }
    />
  );
}

/** One headline total: the figure, what it is, and the denominator it needs. */
function Reading({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div>
      {/*
       * The mono face is set on its own line-height token rather than `leading-none`: at this
       * size its ascenders and the ↑ overshoot a 1.0 line box by several pixels, which puts
       * the glyphs into the collar label rather than above it.
       */}
      <dd className="font-mono text-h4 text-ink">{value}</dd>
      <dt className="collar mt-xs">{label}</dt>
      <dd className="mt-hair font-mono text-micro text-ink-muted">{note}</dd>
    </div>
  );
}

/**
 * One record, or the reason there isn't one.
 *
 * An absent record still occupies its cell rather than collapsing the row, so the three read
 * as a set of three whether or not the ingest produced a summit elevation for the trail.
 */
function Record({
  label,
  record,
  format,
}: {
  label: string;
  record: HikeRecord | null;
  format: (metres: number) => string;
}) {
  if (!record) {
    return (
      <li className="rounded-hair border border-dashed border-bezel p-md">
        <p className="collar">{label}</p>
        <p className="mt-xs font-mono text-body text-ink-muted">—</p>
      </li>
    );
  }

  return (
    <li className="group relative rounded-hair border border-bezel p-md transition-colors duration-quick ease-standard hover:border-ink-muted">
      <p className="collar">{label}</p>
      <p className="mt-xs font-mono text-h4 text-ink">{format(record.valueM)}</p>
      <p className="mt-sm text-caption text-ink">
        <Link
          href={`/trails/${record.trailSlug}`}
          className="rounded-hair after:absolute after:inset-0 after:content-[''] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
        >
          {record.trailName}
        </Link>
      </p>
      <p className="mt-hair font-mono text-micro text-ink-muted">
        {formatDateLabel(record.completedAt)}
      </p>
    </li>
  );
}

/**
 * Where somebody hikes, as a ranked set of proportional rules.
 *
 * The rule is distance rather than count for the same reason the cadence columns are: a
 * region with one long traverse in it is not beaten by a region with two evening laps.
 */
function Regions({
  regions,
  units,
}: {
  regions: HikerProfile['stats']['regions'];
  units: UnitSystem;
}) {
  const peak = Math.max(...regions.map((region) => region.lengthM), 1);

  return (
    <ul className="mt-md flex max-w-[560px] flex-col gap-sm">
      {regions.map((region) => (
        <li key={region.region ?? '—'} className="flex items-center gap-md">
          <span className="w-[40%] shrink-0 truncate text-caption text-ink">
            {/* Not "null", and not dropped: a trail OSM never gave a region to is still a hike. */}
            {region.region ?? 'Unnamed ground'}
          </span>
          <span aria-hidden className="h-[6px] flex-1 bg-bezel/50">
            <span
              className="block h-full bg-contour"
              style={{ width: `${Math.max((region.lengthM / peak) * 100, 2)}%` }}
            />
          </span>
          <span className="w-[92px] shrink-0 text-right font-mono text-micro text-ink-muted">
            {formatDistance(region.lengthM, units)} · {region.hikes}
          </span>
        </li>
      ))}
    </ul>
  );
}
