import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { TRPCError } from '@trpc/server';
import type { ActivityDetail, Split, UnitSystem } from '@switchback/core';
import {
  ACTIVITY_TYPE_LABELS,
  BRAND,
  defaultActivityName,
  formatClock,
  formatDistance,
  formatDuration,
  formatElevation,
  formatPace,
  paceFromSpeed,
  plural,
  trailTitle,
} from '@switchback/core';
import { cumulativeDistancesM, elevationTicks, toSectionPoints } from '@switchback/geo';
import type { SectionPoint, SectionStation } from '@switchback/geo';
import { ActivitySettings } from '@/components/activity/activity-settings';
import { TrackMap } from '@/components/activity/track-map';
import { Section } from '@/components/section';
import { SiteNav } from '@/components/site-nav';
import { Wordmark } from '@/components/wordmark';
import { viewerUnits } from '@/lib/units';
import { caller } from '@/trpc/server';

/**
 * One hike. Unlike a trail page, every number here happened — the section carries the hiker's own
 * splits, which is why the axis gloss reads `elapsed` rather than `at`.
 *
 * The section is drawn from the track's own altitudes rather than the trail's DEM profile even
 * when the hike is attached to a trail. It is noisier, and it is the hike: a recording that
 * wandered to a viewpoint climbed those metres, and the idealised line would delete them.
 */

interface PageProps {
  params: Promise<{ id: string }>;
}

async function loadActivity(id: string): Promise<ActivityDetail | null> {
  try {
    return await caller.activities.get({ id });
  } catch (error) {
    if (error instanceof TRPCError && error.code === 'NOT_FOUND') return null;
    throw error;
  }
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const activity = await loadActivity(id);
  if (!activity) return { title: 'Hike not found' };

  const title =
    activity.name ??
    defaultActivityName(
      activity.activityType,
      activity.startedAt,
      activity.trail ? trailTitle(activity.trail) : null,
    );
  const units = await viewerUnits();

  return {
    title,
    description: `${formatDistance(activity.distanceM, units)}, ${formatElevation(activity.gainM, units)} of ascent, ${formatDuration(activity.movingTimeS)} moving. ${BRAND.tagline}`,
    // A hike that is not public must never reach an index, whatever the link is worth.
    ...(activity.visibility === 'public' ? {} : { robots: { index: false, follow: false } }),
  };
}

export default async function ActivityPage({ params }: PageProps) {
  const { id } = await params;
  const [activity, units] = await Promise.all([loadActivity(id), viewerUnits()]);
  if (!activity) notFound();

  // The trail as every other screen names it, and as the server named the row when it was
  // stored — see `defaultActivityName` in `routers/activities.ts`.
  const trailName = activity.trail ? trailTitle(activity.trail) : null;
  const title =
    activity.name ?? defaultActivityName(activity.activityType, activity.startedAt, trailName);
  const owner = activity.owner;
  const section = buildSection(activity.track);
  const stations = buildStations(activity.splits, activity.distanceM);
  const hasTrack = activity.track.length >= 2;

  return (
    <div data-scheme="sheet" className="min-h-dvh bg-canvas text-ink">
      <header className="mx-auto flex max-w-rail items-center justify-between px-xl py-lg">
        <Wordmark />
        <SiteNav current="profile" />
      </header>

      <main className="mx-auto max-w-rail px-xl pb-5xl">
        <p className="collar flex flex-wrap items-center gap-x-md gap-y-xs">
          {activity.isMine ? (
            <Link href="/profile" className="rounded-hair hover:text-ink">
              ← Your hikes
            </Link>
          ) : owner?.username ? (
            <Link href={`/u/${owner.username}`} className="rounded-hair hover:text-ink">
              ← {owner.name ?? `@${owner.username}`}
            </Link>
          ) : (
            <span>A hike</span>
          )}
          <span>{ACTIVITY_TYPE_LABELS[activity.activityType]}</span>
          <span>{longDate(activity.startedAt)}</span>
        </p>

        <h1 className="mt-md text-h3 font-bold text-balance">{title}</h1>

        {activity.trail ? (
          <p className="mt-sm font-text text-body-lg text-ink-muted">
            {trailName === title ? (
              /* The heading is already the trail's name, so this line keeps only what it does not
               * say: where this is, and the way through to the trail itself. */
              <>
                {activity.trail.regionName ? `${activity.trail.regionName} · ` : null}
                <Link
                  href={`/trails/${activity.trail.slug}`}
                  className="rounded-hair underline decoration-bezel underline-offset-4 hover:decoration-ink"
                >
                  Trail notes and conditions
                </Link>
              </>
            ) : (
              <>
                on{' '}
                <Link
                  href={`/trails/${activity.trail.slug}`}
                  className="rounded-hair underline decoration-bezel underline-offset-4 hover:decoration-ink"
                >
                  {trailName}
                </Link>
                {activity.trail.regionName ? `, ${activity.trail.regionName}` : null}
              </>
            )}
          </p>
        ) : null}

        {hasTrack ? (
          <div
            data-scheme="field"
            className="relative mt-xl h-[clamp(280px,46vh,520px)] w-full overflow-hidden rounded-panel border border-bezel"
          >
            <TrackMap track={activity.track} className="h-full w-full" />
          </div>
        ) : (
          <p className="mt-xl rounded-hair border border-dashed border-bezel px-md py-lg text-center text-caption text-ink-muted">
            No positions were recorded for this hike. The figures below are what was saved before it
            stopped.
          </p>
        )}

        {/* Gauge faces, in the order somebody wants them: how far, how much up, how long, how fast. */}
        <dl className="mt-xl grid grid-cols-2 gap-px overflow-hidden rounded-hair border border-bezel bg-bezel sm:grid-cols-3 lg:grid-cols-6">
          <Figure label="Distance" value={formatDistance(activity.distanceM, units)} />
          <Figure label="Ascent" value={`↑${formatElevation(activity.gainM, units)}`} />
          <Figure label="Descent" value={`↓${formatElevation(activity.lossM, units)}`} />
          <Figure label="Moving" value={formatClock(activity.movingTimeS)} />
          <Figure label="Elapsed" value={formatClock(activity.elapsedTimeS)} />
          {/* Moving pace: `avgSpeedMps` is derived from moving time, so a long lunch on the
           * summit does not read as a slower hike than it was. */}
          <Figure label="Pace" value={paceFromSpeed(activity.avgSpeedMps, units)} />
        </dl>

        {activity.maxEleM != null && activity.minEleM != null ? (
          <p className="mt-sm font-mono text-micro text-ink-muted">
            High point {formatElevation(activity.maxEleM, units)} · low point{' '}
            {formatElevation(activity.minEleM, units)}
            {activity.device ? ` · recorded on ${activity.device}` : ''}
          </p>
        ) : null}

        {section.length >= 2 ? (
          <div className="mt-2xl">
            <h2 className="collar">Section</h2>
            <Section
              className="mt-sm"
              points={section}
              stations={stations}
              elevationTicks={elevationTicks(Math.max(...section.map((p) => p.elevationM)), units)}
              units={units}
              timeAxisLabel="elapsed"
              summary={`Elevation along ${formatDistance(activity.distanceM, units)} of hiking, from ${formatElevation(section[0]!.elevationM, units)} at the start to a high point of ${formatElevation(Math.max(...section.map((p) => p.elevationM)), units)}.`}
            />
          </div>
        ) : null}

        {activity.splits.length > 0 ? <Splits splits={activity.splits} units={units} /> : null}

        {activity.notes ? (
          <section className="mt-2xl max-w-measure-wide">
            <h2 className="collar">Notes</h2>
            <p className="mt-sm whitespace-pre-wrap font-text text-body-lg leading-relaxed">
              {activity.notes}
            </p>
          </section>
        ) : null}

        {activity.isMine ? (
          <div className="mt-2xl border-t border-bezel pt-lg">
            <ActivitySettings activity={activity} />
          </div>
        ) : owner ? (
          <p className="mt-2xl border-t border-bezel pt-lg collar">
            Recorded by{' '}
            {owner.username ? (
              <Link href={`/u/${owner.username}`} className="rounded-hair hover:text-ink">
                {owner.name ?? `@${owner.username}`}
              </Link>
            ) : (
              (owner.name ?? 'a hiker')
            )}
          </p>
        ) : null}
      </main>
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-surface px-md py-sm">
      <dt className="collar">{label}</dt>
      <dd className="mt-hair font-mono text-title tabular-nums" style={{ lineHeight: '1.3' }}>
        {value}
      </dd>
    </div>
  );
}

/**
 * The splits — the one statistic a total cannot say. The bar is drawn from the *slowest* split
 * rather than from zero, because every hiking pace is a long way from zero and a bar scaled from
 * there is six near-identical bars. Ascent shares the row because it is usually the explanation.
 */
function Splits({ splits, units }: { splits: readonly Split[]; units: UnitSystem }) {
  const unitLabel = units === 'imperial' ? 'mi' : 'km';
  const paces = splits.filter((s) => s.paceSPerUnit > 0).map((s) => s.paceSPerUnit);
  const slowest = paces.length > 0 ? Math.max(...paces) : 0;
  const fastest = paces.length > 0 ? Math.min(...paces) : 0;
  const span = slowest - fastest;
  // A bar is a comparison, so the column goes entirely when there is one split or several
  // identical ones, rather than standing empty.
  const comparable = span > 0;

  return (
    <section className="mt-2xl">
      <h2 className="collar">
        Splits · per {unitLabel} · {splits.length} {plural(splits.length, 'row')}
      </h2>
      <table className="mt-sm w-full border-collapse text-left">
        <thead>
          <tr className="border-b border-bezel">
            <th scope="col" className="collar py-xs pr-md font-normal">
              {unitLabel}
            </th>
            <th scope="col" className="collar py-xs pr-md text-right font-normal">
              Pace
            </th>
            {comparable ? (
              <th scope="col" className="collar w-1/2 py-xs pr-md font-normal">
                <span className="sr-only">Relative pace</span>
              </th>
            ) : null}
            <th scope="col" className="collar py-xs text-right font-normal">
              Ascent
            </th>
          </tr>
        </thead>
        <tbody>
          {splits.map((split) => {
            // Full width is the fastest split; the slowest is a stub. Reversed because the
            // bar is read as effort, and faster is more of it.
            const share = split.paceSPerUnit > 0 ? 1 - (split.paceSPerUnit - fastest) / span : 1;
            return (
              <tr key={split.index} className="border-b border-bezel/60">
                <td className="py-xs pr-md font-mono text-caption tabular-nums text-ink-muted">
                  {split.index}
                  {split.complete ? (
                    ''
                  ) : (
                    <span className="ml-xs text-micro">
                      ({formatDistance(split.distanceM, units)})
                    </span>
                  )}
                </td>
                <td className="py-xs pr-md text-right font-mono text-body tabular-nums">
                  {formatPace(split.paceSPerUnit, units)}
                </td>
                {comparable ? (
                  <td className="py-xs pr-md">
                    <span
                      aria-hidden
                      className="block h-hair bg-contour"
                      style={{ width: `${Math.max(4, Math.round(share * 100))}%` }}
                    />
                  </td>
                ) : null}
                <td className="py-xs text-right font-mono text-caption tabular-nums text-ink-muted">
                  ↑{formatElevation(split.gainM, units)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Deriving the section from a track
// ---------------------------------------------------------------------------

/**
 * Distance-and-elevation pairs from `[lng, lat, ele]` tuples.
 *
 * Fixes with no altitude are dropped rather than interpolated, and the distance axis is
 * still cumulative over the *whole* track — so a stretch where the barometer dropped out
 * shows as a straight run between the two altitudes either side of it, at its true length,
 * instead of collapsing the hike's distance by the size of the gap.
 *
 * Returns nothing at all when fewer than a third of the fixes carried an altitude: a section
 * drawn from a handful of scattered readings is a shape, not a measurement.
 */
function buildSection(
  track: ReadonlyArray<readonly [number, number, number | null]>,
): SectionPoint[] {
  if (track.length < 2) return [];
  const distances = cumulativeDistancesM(track.map(([lng, lat]) => [lng, lat] as [number, number]));

  const points: { lng: number; lat: number; distM: number; eleM: number }[] = [];
  for (let i = 0; i < track.length; i += 1) {
    const fix = track[i]!;
    const ele = fix[2];
    if (ele == null || !Number.isFinite(ele)) continue;
    points.push({ lng: fix[0], lat: fix[1], distM: distances[i] ?? 0, eleM: ele });
  }
  if (points.length < 2 || points.length * 3 < track.length) return [];

  return toSectionPoints(points);
}

/**
 * Distance marks carrying the hiker's own elapsed time.
 *
 * Built from the splits rather than from the fixes because the splits already hold exactly
 * this — a distance boundary and the seconds it took to reach it — and recomputing it from
 * the track would be a second implementation of the same sum that could disagree with the
 * table below.
 *
 * At most six marks: past that they collide at phone width, and the ladder thins by taking
 * every nth split so the marks stay on round distances.
 */
function buildStations(splits: readonly Split[], totalM: number): SectionStation[] {
  if (splits.length === 0) return [{ distanceM: 0, time: '0' }];

  const stride = Math.ceil(splits.length / 6);
  const stations: SectionStation[] = [{ distanceM: 0, time: '0' }];
  let distance = 0;
  let elapsed = 0;
  for (let i = 0; i < splits.length; i += 1) {
    distance += splits[i]!.distanceM;
    elapsed += splits[i]!.elapsedS;
    const last = i === splits.length - 1;
    if (last || (i + 1) % stride === 0) {
      stations.push({ distanceM: last ? totalM : distance, time: shortClock(elapsed) });
    }
  }
  return stations;
}

/** `1:25` or `25` — the axis form, matching `formatElapsed` in the trail section. */
function shortClock(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}` : `${m}`;
}

/** `Saturday 27 July 2026, 07:14`. The weekday is how a hike is remembered. */
function longDate(at: Date): string {
  return at.toLocaleString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
