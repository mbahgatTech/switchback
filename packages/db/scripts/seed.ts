/**
 * Development seed.
 *
 * There is deliberately no fake trail data here. Everything Switchback shows comes from
 * OpenStreetMap through the ingest pipeline, and seeding invented trails would give a
 * fresh database content that the real pipeline could never reproduce — which is exactly
 * the kind of seed that hides a broken pipeline for weeks.
 *
 * What this does instead is prime the queue: it registers a handful of z9 tiles over
 * well-known hiking regions on four continents and enqueues an ingest job for each. Run
 * the drain (or start the dev server and pan the map) and the database fills itself with
 * real OSM data, exercising the pipeline end to end on the first run.
 *
 * It also creates the probe account the browser suite signs in as. See `seedProbeAccount`.
 */
import { INGEST_ZOOM, lngLatToTile, quadkeyToBBox, tileToQuadkey } from '@switchback/geo';
import { JobKind, TileStatus, prisma } from '@switchback/db';

interface StarterArea {
  name: string;
  /** [longitude, latitude] — GeoJSON axis order. */
  at: [number, number];
}

/**
 * Spread across four continents and both hemispheres on purpose. The on-demand design
 * claims global coverage from day one; a seed that only primes California would let a
 * hemisphere-flipping bug in the tile maths sit undetected.
 */
const STARTER_AREAS: StarterArea[] = [
  { name: 'Yosemite Valley, California', at: [-119.5383, 37.8651] },
  { name: 'Zion, Utah', at: [-113.0263, 37.2982] },
  { name: 'Banff, Alberta', at: [-115.5708, 51.1784] },
  { name: 'Eryri / Snowdonia, Wales', at: [-4.0763, 53.0685] },
  { name: 'Chamonix, France', at: [6.8694, 45.9237] },
  { name: 'Cortina d’Ampezzo, Italy', at: [12.1357, 46.5405] },
  { name: 'Table Mountain, South Africa', at: [18.4098, -33.9628] },
  { name: 'Torres del Paine, Chile', at: [-72.9877, -50.9423] },
];

function assertNotProduction(): void {
  const url = process.env.DATABASE_URL ?? '';
  if (process.env.NODE_ENV === 'production') {
    throw new Error('refusing to seed with NODE_ENV=production');
  }
  // A seed run against the live database would enqueue work, not destroy data — but the
  // point of a guard is to stop the run before you find out which kind of script it was.
  //
  // `postgres.database.azure.com` is production from the Neon→Azure migration onward, and
  // `neon.tech` stays in the list for as long as Neon is the rollback: both have to be
  // refused, because for a while both are real databases holding real users.
  if (
    /neon\.tech|amazonaws\.com|supabase\.co|postgres\.database\.azure\.com/.test(url) &&
    !process.env.SEED_ALLOW_REMOTE
  ) {
    throw new Error(
      `refusing to seed what looks like a hosted database (${url.replace(/:[^:@]*@/, ':***@')}). ` +
        'Set SEED_ALLOW_REMOTE=1 if you really mean it.',
    );
  }
}

/**
 * The account the browser suite signs in as.
 *
 * `e2e/fixtures.ts` does not drive a real sign-in — that would test Microsoft's login page,
 * which is not ours, and would tie the suite to a live tenant and a real credential. Auth.js
 * keeps web sessions in the database, so a row with a known token *is* a signed-in user by
 * the same code path a real one takes. Everything downstream of the identity provider runs
 * for real; only the provider is skipped.
 *
 * That row used to be inserted by hand, and the fixture's comment claimed this file created
 * it. It did not, which meant the signed-in half of the suite passed on exactly one laptop
 * and would have failed on a fresh clone or a CI runner with "Sign in" — a legible failure,
 * but for a reason that had nothing to do with the code under test.
 *
 * **A well-known session token is a credential, and this one is published in a spec file.**
 * `assertNotProduction` is called again here rather than relied on from `main`, so the guard
 * travels with the function: someone moving this call, or importing it from a script of their
 * own, cannot strip the protection by accident. The cost of the duplicate check is two string
 * comparisons; the cost of getting it wrong is a permanent unauthenticated session on a real
 * database.
 *
 * The expiry is rolled forward from now rather than pinned to a date, because a pinned one
 * turns into a suite that fails on a Tuesday months later with no explanation.
 */
async function seedProbeAccount(): Promise<void> {
  assertNotProduction();

  const PROBE_USER_ID = 'cms2q3ibs00017nuwcrwpmfkb';
  // Must match `PROBE_SESSION_TOKEN` in `e2e/fixtures.ts`.
  const PROBE_SESSION_TOKEN = 'probe-session-token-switchback';

  const expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);

  // A fixed id, not a generated one: the specs that clean up after themselves resolve rows
  // by author, and a probe whose id changed on every seed would leave orphans behind.
  await prisma.user.upsert({
    where: { id: PROBE_USER_ID },
    create: {
      id: PROBE_USER_ID,
      name: 'Ingrid Sørhus',
      username: 'lateglacial',
      bio: 'The account the browser suite signs in as.',
    },
    update: {},
  });

  await prisma.session.upsert({
    where: { sessionToken: PROBE_SESSION_TOKEN },
    create: { sessionToken: PROBE_SESSION_TOKEN, userId: PROBE_USER_ID, expires },
    // Re-seeding an existing checkout should push the expiry out, not leave a stale one.
    update: { expires },
  });

  console.log('probe account ready (lateglacial) — the browser suite can sign in');
}

async function main(): Promise<void> {
  assertNotProduction();

  await seedProbeAccount();

  for (const area of STARTER_AREAS) {
    const tile = lngLatToTile(area.at[0], area.at[1], INGEST_ZOOM);
    const quadkey = tileToQuadkey(tile);
    const [bboxW, bboxS, bboxE, bboxN] = quadkeyToBBox(quadkey);

    // Upsert, not create: re-running the seed must not reset a tile that has already been
    // ingested. `update: {}` makes an existing tile a no-op.
    await prisma.ingestTile.upsert({
      where: { quadkey },
      create: {
        quadkey,
        z: tile.z,
        x: tile.x,
        y: tile.y,
        status: TileStatus.pending,
        bboxW,
        bboxS,
        bboxE,
        bboxN,
      },
      update: {},
    });

    await prisma.ingestJob.upsert({
      where: { dedupeKey: `ingest_tile:${quadkey}` },
      create: {
        kind: JobKind.ingest_tile,
        dedupeKey: `ingest_tile:${quadkey}`,
        payload: { quadkey, reason: 'seed', area: area.name },
        // Seed jobs yield to anything a real user is waiting on.
        priority: -10,
      },
      update: {},
    });

    console.log(`queued ${quadkey.padEnd(9)} ${area.name}`);
  }

  const [tiles, jobs] = await Promise.all([
    prisma.ingestTile.count(),
    prisma.ingestJob.count({ where: { status: 'queued' } }),
  ]);
  console.log(`\n${tiles} tiles registered, ${jobs} jobs queued.`);
  console.log('Run the drain to fetch them: npm run dev, then hit /api/cron/drain');
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
