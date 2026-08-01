/**
 * Development seed. There is deliberately no fake trail data: everything comes from OSM through
 * the ingest pipeline, and invented trails would hide a broken pipeline for weeks.
 *
 * Instead it primes the queue with z9 tiles over well-known hiking regions and enqueues an
 * ingest job for each, so the first drain exercises the pipeline end to end. It also creates the
 * probe account the browser suite signs in as — see `seedProbeAccount`.
 */
import { INGEST_ZOOM, lngLatToTile, quadkeyToBBox, tileToQuadkey } from '@switchback/geo';
import { JobKind, TileStatus, prisma } from '@switchback/db';

interface StarterArea {
  name: string;
  /** [longitude, latitude] — GeoJSON axis order. */
  at: [number, number];
}

/**
 * Four continents and both hemispheres on purpose: a seed that only primed California would let
 * a hemisphere-flipping bug in the tile maths sit undetected.
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
  // A guard's job is to stop the run before you find out which kind of script it was.
  // `postgres.database.azure.com` is production; `neon.tech` stays listed for as long as Neon
  // is the retained rollback, because for a while both hold real users.
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
 * The account the browser suite signs in as. Auth.js keeps web sessions in the database, so a row
 * with a known token *is* a signed-in user by the same code path a real one takes; only the
 * identity provider is skipped.
 *
 * The well-known session token is a credential, and it is published in a spec file, so
 * `assertNotProduction` is called again here rather than relied on from `main` — the guard must
 * travel with the function. The expiry is rolled forward from now, never pinned to a date.
 */
async function seedProbeAccount(): Promise<void> {
  assertNotProduction();

  const PROBE_USER_ID = 'cms2q3ibs00017nuwcrwpmfkb';
  // Must match `PROBE_SESSION_TOKEN` in `e2e/fixtures.ts`.
  const PROBE_SESSION_TOKEN = 'probe-session-token-switchback';

  const expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);

  // A fixed id, not a generated one: specs that clean up after themselves resolve rows by
  // author, and a probe whose id changed on every seed would leave orphans behind.
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

    // Upsert, not create: re-running the seed must not reset an already-ingested tile.
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
