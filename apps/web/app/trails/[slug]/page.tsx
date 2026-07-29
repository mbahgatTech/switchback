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
import { SiteNav } from '@/components/site-nav';
import { Wordmark } from '@/components/wordmark';
import { TrailPlanner } from '@/components/trail/planner';
import { Reviews } from '@/components/trail/reviews';
import { viewerUnits } from '@/lib/units';
import { caller } from '@/trpc/server';
import { BUTTON_COLLAR, HEIGHT, SECONDARY } from '@/components/controls';

/**
 * A trail.
 *
 * A reading page — `data-scheme="sheet"` — with one dark instrument set into it. That
 * inversion is the structure: the map and its section are the thing you consult, and
 * everything above and below them is the thing you read before deciding to.
 *
 * Server-rendered end to end apart from the map pair. A trail page is the natural landing
 * point from a search engine, and every fact on it — the stats, the description, the
 * waypoints, the licence — is fixed at request time. Only the cursor moves.
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

/**
 * SAC grades, with the T-numbers.
 *
 * The bare OSM value means nothing to a reader and the number means everything to anyone
 * who has hiked in the Alps, so both are printed. These are the Swiss Alpine Club's own
 * descriptions, shortened — not our interpretation of them.
 */
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

  /*
   * The reader's own units, including in the tab title and the share card. A crawler has no
   * session and gets metric, which is the right answer for a link preview anybody might
   * open — but a person who asked for miles and then shares the page should not have the one
   * place they cannot see be the one that contradicts them.
   */
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

  // All three are additive: the page is complete without any of them, so none blocks the
  // render of the part that matters. Requested together rather than in sequence. `me.get`
  // costs nothing extra — the request context has already loaded the user for `ctx.user`.
  const [photos, nearby, viewer] = await Promise.all([
    caller.trails.photos({ trailId: trail.id, limit: 12 }),
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

  // `activities.mine` is protected, so it can only be asked for once the viewer is known —
  // a second round trip rather than a wider first one. Most readers of this page are signed
  // out, and they never pay for it.
  const myHikes = viewer ? await caller.activities.mine({ trailId: trail.id, limit: 5 }) : null;

  return (
    <div data-scheme="sheet" className="min-h-dvh bg-canvas text-ink">
      <header className="mx-auto flex max-w-rail items-center justify-between px-xl py-lg">
        <Wordmark />
        <SiteNav />
      </header>

      <main className="mx-auto max-w-rail px-xl pb-5xl">
        {/* ── Title block ──────────────────────────────────────────────────────────── */}
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
          {/*
           * Difficulty without its reason is a verdict. `classifyDifficulty` already knows
           * which input raised the band, so the page says so rather than leaving a hiker to
           * guess whether "hard" means long or means exposed — those need different days.
           */}
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
         * Above the controls, deliberately.
         *
         * Everything under this line is written to be encouraging — save it, record it,
         * download it, print it — and a route up a 55° face wears that furniture exactly like
         * a route up a valley does. Difficulty cannot carry the difference, because "Hard" is
         * the top of its scale and the ground keeps going. So this is said before the buttons
         * are offered, not after.
         *
         * Survey red, the plate this product spends on your safety and on nothing else
         * decorative. Bordered on one edge rather than filled: a filled red panel would be the
         * loudest thing on a page whose argument is that its figures are quiet and exact.
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

        {/*
         * Directly under the name, because "is this one of mine" is answered before any of
         * the figures are read — and because the row's own state is part of the answer to
         * "have I been here before", which changes how the rest of the page is read.
         */}
        <div className="mt-lg flex flex-wrap items-center gap-lg">
          <SaveControls
            trailId={trail.id}
            trailPath={`/trails/${trail.slug}`}
            viewerId={viewer?.id ?? null}
          />
          {/*
           * Beside the marks rather than at the foot of the page. The three marks say what
           * this trail is to you; recording is the one control that says what it is about to
           * be, and somebody reading this page in a car park has ten seconds for it.
           */}
          <Link
            href={`/record?trail=${encodeURIComponent(trail.slug)}`}
            className={`${BUTTON_COLLAR} ${SECONDARY} ${HEIGHT.touch} px-md`}
          >
            Record this hike
          </Link>
          {/*
           * Third, because it is the control you reach for last and only sometimes — but in
           * this row rather than at the foot of the page, since the moment it is wanted is
           * the moment before the signal goes, not after reading the reviews.
           */}
          <DownloadTrail trail={trail} />
          {/*
           * Beside the download and not inside it, because they answer the same question —
           * what happens when there is no signal — in the two ways that actually work. A
           * phone in a pocket runs out; paper does not.
           */}
          <Link
            href={`/trails/${trail.slug}/print`}
            className={`${BUTTON_COLLAR} ${SECONDARY} ${HEIGHT.touch} px-md`}
          >
            Print a sheet
          </Link>
          {/*
           * Last, and shaped unlike the four before it, because it is the only control here
           * that sends the trail somewhere else rather than doing something on this page.
           */}
          <TrailExport trailId={trail.id} />
        </div>

        {/*
         * ── The instrument, the figures, and the two blocks that turn them into a plan ──
         *
         * The planner is a client component wrapping all three because weather and busy
         * times share one piece of state — the start time — and the stat rail sits between
         * them in the reading order. It comes through as `children` so it stays server
         * rendered: a slot, not a re-implementation.
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

        {/* ── Waypoints and access, side by side on a wide sheet ───────────────────── */}
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

        {/*
         * ── Your own visits ───────────────────────────────────────────────────────────
         *
         * Above the reports, because it changes how they read. Somebody who has hiked this
         * three times is checking the reports against their own memory of the place; somebody
         * who has never been is taking them on trust. Signed-in only, and silent when there
         * is nothing — an empty "you have not hiked this" block on every trail page in the
         * product would be a permanent reproach.
         */}
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

        {/*
         * ── Reports ───────────────────────────────────────────────────────────────────
         *
         * Above the photographs on purpose. Everything before this point describes the
         * trail as the map has it; this is the only block on the page written by someone
         * who was actually standing on it, and the sixty-day condition tally at the top of
         * it is the fact most likely to change what a hiker packs.
         */}
        <Reviews
          trailId={trail.id}
          trailName={trail.name}
          trailPath={`/trails/${trail.slug}`}
          viewerId={viewer?.id ?? null}
        />

        {/*
         * ── Photographs ───────────────────────────────────────────────────────────────
         *
         * A client island, because everything interesting about this block happens after
         * the page has rendered: an upload appears in the strip without a round trip, and
         * the lightbox is the only place a caption can be written.
         */}
        <PhotoGallery
          trailId={trail.id}
          trailName={trail.name}
          trailPath={`/trails/${trail.slug}`}
          initial={photos}
          isViewerKnown={viewer !== null}
        />

        {/* ── Nearby ───────────────────────────────────────────────────────────────── */}
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

        {/* ── Provenance ───────────────────────────────────────────────────────────── */}
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
      </main>
    </div>
  );
}

/**
 * One cell of the stat rail.
 *
 * The value is set in mono one step above reading size and the label is collar text above
 * it, which is the arrangement on the margin of a survey sheet: the measurement is the
 * content, the word is the annotation. It is the same pair every other figure rail in the
 * product uses — `/downloads`, the Lifeline sheet — because seven numbers about a trail and
 * three about a download are the same kind of thing and should not be set two different
 * ways. `bg-canvas` over a `bg-bezel` grid gap draws the rules — a real table of figures,
 * ruled, rather than seven floating boxes.
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
       * "Not recorded" rather than a dash or a silent omission. An access fact that OSM has
       * no answer for is different from a "no", and on a gate or a fee that difference is
       * what a hiker plans around.
       *
       * Set in `ink-muted` at full strength. It was `ink-muted/70` — recessed further, to
       * read as absence rather than as an answer — and that fade put it at 2.88:1 against
       * the canvas, well under the 4.5:1 that AA asks of body text. Which defeated the
       * point: a fact a hiker plans around is not one to make hard to read. Full-strength
       * `ink-muted` is 5.18:1 and still a clear step down from the `ink` beside it, so the
       * hierarchy survives the fix.
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
