import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { TRPCError } from '@trpc/server';
import type { RouteType, SacScale, TrailDetail, UnitSystem, Waypoint } from '@switchback/core';
import {
  ACTIVITY_TYPE_LABELS,
  ATTRIBUTION,
  BRAND,
  TERRAIN_CAUTION_COPY,
  classifyDifficulty,
  formatDistance,
  formatDuration,
  formatElevation,
  plural,
  terrainCaution,
} from '@switchback/core';
import { DIFFICULTY_PLATE } from '@switchback/ui';
import { ActivityRows } from '@/components/activity/activity-rows';
import { SaveControls } from '@/components/lists/save-controls';
import { DownloadTrail } from '@/components/offline/download-trail';
import { TrailExport } from '@/components/trail/trail-export';
import { PhotoGallery } from '@/components/photos/gallery';
import { SiteFooter } from '@/components/site-footer';
import { SiteNav } from '@/components/site-nav';
import { Wordmark } from '@/components/wordmark';
import { TrailPlanner } from '@/components/trail/planner';
import { Reviews } from '@/components/trail/reviews';
import { viewerUnits } from '@/lib/units';
import { caller } from '@/trpc/server';
import { BUTTON_COLLAR, HEIGHT, SECONDARY } from '@/components/controls';

/**
 * A trail: a reading page with one dark instrument (the map and its section) set into it.
 * Server-rendered end to end apart from that pair — every fact here is fixed at request time.
 */

interface PageProps {
  params: Promise<{ slug: string }>;
}

const ROUTE_TYPE_LABEL: Record<RouteType, string> = {
  loop: 'Loop',
  out_and_back: 'Out and back',
  point_to_point: 'Point to point',
};

const DIFFICULTY_LABEL = { easy: 'Easy', moderate: 'Moderate', hard: 'Hard' } as const;

const PLATE_BG = {
  woodland: 'bg-woodland',
  contour: 'bg-contour',
  survey: 'bg-survey',
} as const;

/** The Swiss Alpine Club's own grade descriptions, shortened — not our interpretation of them. */
const SAC_LABEL: Record<SacScale, { grade: string; text: string }> = {
  hiking: { grade: 'T1', text: 'Trail well marked, no head for heights needed' },
  mountain_hiking: { grade: 'T2', text: 'Continuous trail, some steep ground, sure footing' },
  demanding_mountain_hiking: {
    grade: 'T3',
    text: 'Exposed sections possible, hands occasionally needed',
  },
  alpine_hiking: { grade: 'T4', text: 'Pathless in places, exposure, scrambling' },
  demanding_alpine_hiking: { grade: 'T5', text: 'Demanding scrambling, glacier travel possible' },
  difficult_alpine_hiking: { grade: 'T6', text: 'Serious climbing, often unmarked and exposed' },
};

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).replace(/_/g, ' ');
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const trail = await loadTrail(slug);
  if (!trail) return { title: 'Trail not found' };

  // The reader's own units, including in the tab title and the share card. A crawler has no
  // session and gets metric.
  const units = await viewerUnits();

  const summary = `${formatDistance(trail.stats.lengthM, units)} · ${formatElevation(
    trail.stats.gainM,
    units,
  )} of climb · ${formatDuration(trail.stats.estimatedTimeS)}`;

  return {
    title: trail.name,
    description: trail.description
      ? `${summary}. ${trail.description.slice(0, 150)}`
      : `${summary}. ${DIFFICULTY_LABEL[trail.difficulty]} ${ROUTE_TYPE_LABEL[
          trail.routeType
        ].toLowerCase()}${trail.regionName ? ` in ${trail.regionName}` : ''}.`,
    openGraph: {
      title: `${trail.name} · ${BRAND.name}`,
      description: summary,
      images: trail.primaryPhotoUrl ? [trail.primaryPhotoUrl] : undefined,
    },
  };
}

/** `null` rather than a throw, so `generateMetadata` and the page agree on a missing slug. */
async function loadTrail(slug: string): Promise<TrailDetail | null> {
  try {
    return await caller.trails.bySlug({ slug });
  } catch (error) {
    if (error instanceof TRPCError && error.code === 'NOT_FOUND') return null;
    throw error;
  }
}

export default async function TrailPage({ params }: PageProps) {
  const { slug } = await params;
  const trail = await loadTrail(slug);
  if (!trail) notFound();

  // All three are additive — the page is complete without any of them — so none blocks the render.
  const [photos, nearby, viewer] = await Promise.all([
    // `includeHidden` is granted to nobody but an operator; `trails.photos` reads the role from
    // the session. It puts a taken-down frame in front of the one control that can restore it.
    caller.trails.photos({ trailId: trail.id, limit: 12, includeHidden: true }),
    caller.trails.nearby({ at: trail.centroid, radiusM: 30_000, limit: 7 }),
    caller.me.get(),
  ]);

  const { raisedBy } = classifyDifficulty({
    gainM: trail.stats.gainM,
    lengthM: trail.stats.lengthM,
    sacScale: trail.sacScale,
    maxSustainedGrade: trail.stats.maxSustainedGrade,
  });

  const units = await viewerUnits();

  const caution = terrainCaution(trail.stats.maxSustainedGrade);

  const others = nearby.filter((candidate) => candidate.id !== trail.id).slice(0, 6);
  const onRoute = trail.waypoints.filter((point) => point.distM !== null);
  const offRoute = trail.waypoints.filter((point) => point.distM === null);

  // `activities.mine` is protected, so it can only be asked for once the viewer is known — a
  // second round trip rather than a wider first one that every signed-out reader would pay for.
  const myHikes = viewer ? await caller.activities.mine({ trailId: trail.id, limit: 5 }) : null;

  return (
    <div data-scheme="sheet" className="min-h-dvh bg-canvas text-ink">
      <header className="mx-auto flex max-w-rail items-center justify-between px-xl py-lg">
        <Wordmark />
        <SiteNav />
      </header>

      <main className="mx-auto max-w-rail px-xl pb-5xl">
        {/* Title block */}
        <p className="collar flex flex-wrap items-center gap-x-md gap-y-xs">
          {trail.regionName ? <span>{trail.regionName}</span> : null}
          <span>{ROUTE_TYPE_LABEL[trail.routeType]}</span>
          {trail.activityTypes.length > 0 ? (
            <span>{trail.activityTypes.map((type) => ACTIVITY_TYPE_LABELS[type]).join(' · ')}</span>
          ) : null}
        </p>

        <h1 className="mt-md text-h3 font-bold text-balance">{trail.name}</h1>

        <p className="mt-md flex flex-wrap items-center gap-x-md gap-y-xs text-caption text-ink-muted">
          <span className="flex items-center gap-xs text-ink">
            <span
              aria-hidden
              className={`h-[7px] w-[7px] rounded-full ${PLATE_BG[DIFFICULTY_PLATE[trail.difficulty]]}`}
            />
            {DIFFICULTY_LABEL[trail.difficulty]}
          </span>
          {/* `classifyDifficulty` knows which input raised the band, so the page says which. */}
          {raisedBy.includes('sac_scale') ? <span>raised by its alpine grade</span> : null}
          {raisedBy.includes('sustained_grade') ? (
            <span>raised by a sustained steep pitch</span>
          ) : null}
          {trail.rating !== null ? (
            <span className="font-mono">
              {trail.rating.toFixed(1)}{' '}
              <span className="text-ink-muted">· {trail.reviewCount}</span>
            </span>
          ) : null}
        </p>

        {/*
         * Above the controls deliberately: everything below this line is encouraging furniture,
         * and "Hard" is the top of the difficulty scale while the ground keeps going.
         */}
        {caution ? (
          <aside role="note" className="mt-lg border-l-2 border-survey pl-md">
            <p className="text-body font-semibold text-survey">
              {TERRAIN_CAUTION_COPY[caution].title}
            </p>
            <p className="mt-xs max-w-measure-wide text-caption text-ink">
              {TERRAIN_CAUTION_COPY[caution].body}
            </p>
          </aside>
        ) : null}

        <div className="mt-lg flex flex-wrap items-center gap-lg">
          {/* First: "is this one of mine" is answered before any of the figures are read. */}
          <SaveControls
            trailId={trail.id}
            trailPath={`/trails/${trail.slug}`}
            viewerId={viewer?.id ?? null}
          />
          {/* The marks say what this trail is to you; this says what it is about to be. */}
          <Link
            href={`/record?trail=${encodeURIComponent(trail.slug)}`}
            className={`${BUTTON_COLLAR} ${SECONDARY} ${HEIGHT.touch} px-md`}
          >
            Record this hike
          </Link>
          {/* Wanted at the moment before the signal goes, so not at the foot of the page. */}
          <DownloadTrail trail={trail} />
          {/* Beside the download: the same question answered the other way — paper does not run out. */}
          <Link
            href={`/trails/${trail.slug}/print`}
            className={`${BUTTON_COLLAR} ${SECONDARY} ${HEIGHT.touch} px-md`}
          >
            Print a sheet
          </Link>
          {/* Last, and shaped unlike the rest: the only control that sends the trail elsewhere. */}
          <TrailExport trailId={trail.id} />
        </div>

        {/*
         * A client component wrapping all three: weather and busy times share one piece of state
         * (the start time) and the stat rail sits between them. The rail comes through as
         * `children` so it stays server rendered — a slot, not a re-implementation.
         */}
        <TrailPlanner trail={trail}>
          <dl className="mt-2xl grid grid-cols-2 gap-px overflow-hidden rounded-hair border border-bezel bg-bezel sm:grid-cols-4 lg:grid-cols-7">
            <Stat label="Length" value={formatDistance(trail.stats.lengthM, units)} />
            <Stat label="Ascent" value={`↑${formatElevation(trail.stats.gainM, units)}`} />
            <Stat label="Descent" value={`↓${formatElevation(trail.stats.lossM, units)}`} />
            <Stat label="High point" value={formatElevation(trail.stats.maxEleM, units)} />
            <Stat label="Low point" value={formatElevation(trail.stats.minEleM, units)} />
            <Stat
              label="Steepest"
              value={
                trail.stats.maxSustainedGrade === null
                  ? '—'
                  : `${Math.round(trail.stats.maxSustainedGrade * 100)}%`
              }
            />
            <Stat label="Moving time" value={formatDuration(trail.stats.estimatedTimeS)} />
          </dl>
        </TrailPlanner>

        {trail.description ? (
          <section className="mt-3xl">
            <h2 className="collar">Description</h2>
            <p className="mt-md max-w-measure-wide text-body-lg leading-relaxed">
              {trail.description}
            </p>
          </section>
        ) : null}

        {/* Waypoints and access, side by side on a wide sheet */}
        <div className="mt-3xl grid gap-3xl lg:grid-cols-[1fr_18rem]">
          <section>
            <h2 className="collar">On the way</h2>
            {onRoute.length === 0 && offRoute.length === 0 ? (
              <p className="mt-md max-w-measure text-caption text-ink-muted">
                No features are mapped along this route yet. Summits, water and gates appear here as
                they are added to OpenStreetMap.
              </p>
            ) : (
              <>
                <ol className="mt-md border-t border-bezel">
                  {onRoute.map((point) => (
                    <WaypointRow key={point.id} waypoint={point} units={units} />
                  ))}
                </ol>
                {offRoute.length > 0 ? (
                  <>
                    <h3 className="collar mt-xl">Nearby, off the route</h3>
                    <ul className="mt-md flex flex-wrap gap-x-md gap-y-xs text-caption text-ink-muted">
                      {offRoute.map((point) => (
                        <li key={point.id}>{point.name ?? titleCase(point.kind)}</li>
                      ))}
                    </ul>
                  </>
                ) : null}
              </>
            )}
          </section>

          <section>
            <h2 className="collar">Access</h2>
            <dl className="mt-md border-t border-bezel text-caption">
              <Fact label="Surface" value={trail.surface ? titleCase(trail.surface) : null} />
              <Fact label="Dogs" value={yesNo(trail.dogsAllowed)} />
              <Fact label="Step-free" value={yesNo(trail.wheelchairAccessible)} />
              <Fact label="Fee" value={yesNo(trail.feeRequired)} />
            </dl>

            {trail.sacScale ? (
              <div className="mt-lg rounded-hair border border-bezel p-md">
                <p className="collar">Terrain grade {SAC_LABEL[trail.sacScale].grade}</p>
                <p className="mt-xs text-caption text-ink-muted">
                  {SAC_LABEL[trail.sacScale].text}
                </p>
              </div>
            ) : null}
          </section>
        </div>

        {/* Above the reports, because having been here changes how they read. */}
        {myHikes && myHikes.items.length > 0 ? (
          <section className="mt-3xl">
            <h2 className="collar">
              You have recorded this {myHikes.total} {plural(myHikes.total, 'time')}
            </h2>
            <ActivityRows
              activities={myHikes.items}
              units={units}
              showTrail={false}
              className="mt-md"
            />
            {myHikes.nextCursor ? (
              <p className="mt-md">
                <Link href="/activities" className="collar rounded-hair hover:text-ink">
                  All your recordings →
                </Link>
              </p>
            ) : null}
          </section>
        ) : null}

        {/* Above the photographs: the only block written by somebody who stood on the ground. */}
        <Reviews
          trailId={trail.id}
          trailName={trail.name}
          trailPath={`/trails/${trail.slug}`}
          viewerId={viewer?.id ?? null}
          viewerRole={viewer?.role ?? 'member'}
        />

        {/* A client island: an upload appears without a round trip, and captions need the lightbox. */}
        <PhotoGallery
          trailId={trail.id}
          trailName={trail.name}
          trailPath={`/trails/${trail.slug}`}
          initial={photos}
          isViewerKnown={viewer !== null}
          viewerRole={viewer?.role ?? 'member'}
        />

        {/* Nearby */}
        {others.length > 0 ? (
          <section className="mt-3xl">
            <h2 className="collar">Also within 30 km</h2>
            <ul className="mt-md grid gap-px overflow-hidden rounded-hair border border-bezel bg-bezel sm:grid-cols-2 lg:grid-cols-3">
              {others.map((other) => (
                <li key={other.id} className="bg-canvas">
                  <Link
                    href={`/trails/${other.slug}`}
                    className="flex h-full flex-col justify-between gap-sm p-md transition-colors duration-quick ease-standard hover:bg-surface"
                  >
                    <span className="text-body font-medium leading-tight">{other.name}</span>
                    <span className="font-mono text-micro text-ink-muted">
                      {formatDistance(other.stats.lengthM, units)} · ↑
                      {formatElevation(other.stats.gainM, units)} ·{' '}
                      {formatDistance(other.distanceM, units)} away
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* Provenance */}
        <footer className="mt-3xl border-t border-bezel pt-lg">
          <p className="max-w-measure-wide text-caption text-ink-muted">
            This route was assembled from{' '}
            <a
              href={ATTRIBUTION.osm.href}
              className="text-ink underline decoration-bezel underline-offset-4 hover:decoration-ink"
            >
              OpenStreetMap
            </a>
            {trail.osmType && trail.osmId !== null ? (
              <>
                {' '}
                (
                <a
                  href={`https://www.openstreetmap.org/${trail.osmType}/${trail.osmId}`}
                  className="font-mono text-ink underline decoration-bezel underline-offset-4 hover:decoration-ink"
                >
                  {trail.osmType} {trail.osmId}
                </a>
                )
              </>
            ) : null}
            , with elevation resampled every 25 m from terrain tiles. Something wrong? The fix
            belongs upstream in OpenStreetMap, where it reaches every map rather than just this one.
          </p>
          {trail.sourceUpdatedAt ? (
            <p className="mt-sm font-mono text-micro text-ink-muted">
              Reconciled with OpenStreetMap{' '}
              {new Date(trail.sourceUpdatedAt).toLocaleDateString('en-GB', {
                day: 'numeric',
                month: 'long',
                year: 'numeric',
              })}
            </p>
          ) : null}
        </footer>

        {/*
         * The site colophon, distinct from the trail's own provenance above it: this one carries
         * the rules and the route in for reporting other people's writing and photographs.
         */}
        <SiteFooter />
      </main>
    </div>
  );
}

/**
 * One cell of the stat rail: mono value under a collar label, the same pair every figure rail in
 * the product uses. `bg-canvas` over a `bg-bezel` grid gap is what draws the rules.
 */
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-canvas px-md py-sm">
      <dt className="collar">{label}</dt>
      <dd className="mt-xs font-mono text-body-lg text-ink">{value}</dd>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex items-baseline justify-between gap-md border-b border-bezel py-sm">
      <dt className="text-ink-muted">{label}</dt>
      {/*
       * "Not recorded", not a dash: on a gate or a fee, "OSM has no answer" is not "no". Full
       * strength `ink-muted` (5.18:1) — do not re-fade it, `ink-muted/70` was 2.88:1 and failed AA.
       */}
      <dd className={value === null ? 'text-ink-muted' : 'text-ink'}>{value ?? 'Not recorded'}</dd>
    </div>
  );
}

function yesNo(value: boolean | null): string | null {
  return value === null ? null : value ? 'Yes' : 'No';
}

function WaypointRow({ waypoint, units }: { waypoint: Waypoint; units: UnitSystem }) {
  return (
    <li className="flex items-baseline gap-md border-b border-bezel py-sm">
      <span className="w-[4.5rem] shrink-0 font-mono text-caption text-ink-muted">
        {waypoint.distM === null ? '' : formatDistance(waypoint.distM, units)}
      </span>
      <span className="min-w-0 flex-1 text-caption text-ink">
        {waypoint.name ?? titleCase(waypoint.kind)}
        {waypoint.name ? (
          <span className="text-ink-muted"> · {titleCase(waypoint.kind)}</span>
        ) : null}
      </span>
      {waypoint.eleM !== null ? (
        <span className="shrink-0 font-mono text-caption text-ink-muted">
          {formatElevation(waypoint.eleM, units)}
        </span>
      ) : null}
    </li>
  );
}
