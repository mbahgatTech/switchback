/**
 * Development seed — user content.
 *
 * Separate from `seed.ts`, and separate on principle. That one refuses to invent trails
 * because a fake trail hides a broken ingest pipeline. This one invents *only* what the
 * pipeline can never produce: people, and what they said after hiking somewhere. Reviews
 * have no upstream source — they are the one part of this product that has to be typed by
 * a human — so a local database has none until somebody signs in with a real Microsoft
 * account and writes one, and until then the whole reviews surface renders empty and
 * cannot be looked at.
 *
 * Nothing here is fixture data the app depends on. Delete every row it makes and the
 * product is exactly as correct, just quieter:
 *
 *     npm run db:seed:reviews -- --reset
 *
 * The accounts it creates carry `@example.invalid` addresses. `.invalid` is reserved by
 * RFC 2606 precisely so it can never be delegated, which means these rows can never
 * collide with a real sign-in and can never send mail anywhere.
 */
import { ActivityType, TrailCondition, prisma } from '@switchback/db';

/**
 * A deterministic generator, so two runs on the same database produce the same reviews.
 *
 * `Math.random()` here would mean a screenshot taken this morning and one taken this
 * afternoon disagree about the numbers, which makes visual review useless — the mulberry32
 * constants are the standard ones.
 */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Hiker {
  username: string;
  name: string;
}

/** Six regulars, so a trail's reports read as a small community rather than a crowd. */
const HIKERS: Hiker[] = [
  { username: 'gritstone', name: 'Ada Renshaw' },
  { username: 'coldbeck', name: 'Tomás Guerrero' },
  { username: 'slabfoot', name: 'Nkechi Obi' },
  { username: 'lateglacial', name: 'Ingrid Sørhus' },
  { username: 'foulweather', name: 'Rafiq Mansour' },
  { username: 'onemoreridge', name: 'Bea Kowalczyk' },
];

/**
 * Reports, written to be worth reading.
 *
 * Every one names a place, a hazard, or a decision — because the point of looking at this
 * seed is to judge whether a real report is legible at this width and this measure, and a
 * column of "Great hike!!" answers that question wrongly. The ratings sit deliberately
 * across the range: a distribution that is all fours makes the histogram look broken.
 */
const REPORTS: {
  rating: number;
  body: string | null;
  conditions: TrailCondition[];
  activityType: ActivityType | null;
  /** Days before today. Anything under 60 lands in the recent-conditions tally. */
  daysAgo: number | null;
}[] = [
  {
    rating: 5,
    body: 'Went up at first light and had the top to myself for an hour. The last three hundred metres are on slab and were greasy in the shade — nothing you need hands for, but I was glad of a stiffer boot. Water at the second stream crossing, nothing after that.',
    conditions: [TrailCondition.dry, TrailCondition.well_marked],
    activityType: ActivityType.hiking,
    daysAgo: 6,
  },
  {
    rating: 4,
    body: 'Good route, badly signed at the junction about two kilometres in — the obvious path is the wrong one. Keep left where the wall ends. Boggy for a stretch after that and my feet were wet the rest of the day.',
    conditions: [TrailCondition.muddy, TrailCondition.poorly_marked],
    activityType: ActivityType.hiking,
    daysAgo: 13,
  },
  {
    rating: 5,
    body: 'Ran it as an out-and-back on a clear evening. Surface is runnable the whole way apart from one rocky pitch. Watch the light — I finished twenty minutes after sunset and it was properly dark under the trees.',
    conditions: [TrailCondition.dry],
    activityType: ActivityType.trail_running,
    daysAgo: 21,
  },
  {
    rating: 3,
    body: 'Fine, but busier than I expected for a Tuesday. Two coach parties on the lower section. Quieter above the treeline if you can get past them.',
    conditions: [TrailCondition.crowded, TrailCondition.dry],
    activityType: ActivityType.hiking,
    daysAgo: 31,
  },
  {
    rating: 4,
    body: 'Storm damage on the middle third — four or five trunks across the path, all climbable but slow with a big pack. Took me an hour longer than the estimate here.',
    conditions: [TrailCondition.blowdown, TrailCondition.muddy],
    activityType: ActivityType.backpacking,
    daysAgo: 44,
  },
  {
    rating: 2,
    body: 'The ford was well over knee deep and moving fast after two days of rain. We turned round rather than cross it. Would have been a good hike otherwise — go when it has been dry.',
    conditions: [TrailCondition.flooded, TrailCondition.muddy],
    activityType: ActivityType.hiking,
    daysAgo: 52,
  },
  {
    rating: 5,
    body: null,
    conditions: [TrailCondition.well_marked, TrailCondition.dry],
    activityType: null,
    daysAgo: 58,
  },
  {
    rating: 4,
    body: 'Did this in winter with spikes. Everything above the shoulder was hard ice and I would not have got up without them. Beautiful, but it is a different route in January than the photographs suggest.',
    conditions: [TrailCondition.icy, TrailCondition.snow],
    activityType: ActivityType.hiking,
    daysAgo: 190,
  },
  {
    rating: 1,
    body: 'Nettles and bracken over head height for the first kilometre. Whatever this used to be, nobody has cut it back in years.',
    conditions: [TrailCondition.overgrown],
    activityType: ActivityType.hiking,
    daysAgo: 260,
  },
  {
    rating: 3,
    body: 'Pleasant enough but the midges at the lake were genuinely unbearable. Bring something for them or do not stop.',
    conditions: [TrailCondition.bugs],
    activityType: ActivityType.hiking,
    daysAgo: 320,
  },
];

/** Same helper the router uses, restated here so the seed cannot drift from it. */
function averageRating(counts: readonly number[]): number | null {
  let total = 0;
  let sum = 0;
  for (const [index, count] of counts.entries()) {
    total += count;
    sum += count * (index + 1);
  }
  return total === 0 ? null : Math.round((sum / total) * 10) / 10;
}

function assertNotProduction(): void {
  const url = process.env.DATABASE_URL ?? '';
  if (process.env.NODE_ENV === 'production') {
    throw new Error('refusing to seed with NODE_ENV=production');
  }
  // This one *writes user rows*, which the trail seed does not. A stricter refusal than a
  // queue primer deserves: made-up accounts in a live users table are not a tidy mistake.
  if (/neon\.tech|amazonaws\.com|supabase\.co/.test(url) && !process.env.SEED_ALLOW_REMOTE) {
    throw new Error(
      `refusing to seed accounts into what looks like a hosted database (${url.replace(
        /:[^:@]*@/,
        ':***@',
      )}). Set SEED_ALLOW_REMOTE=1 if you really mean it.`,
    );
  }
}

/** Midnight UTC, n days ago — the same shape the router stores `hikedOn` in. */
function daysAgoUtc(days: number): Date {
  const date = new Date(Date.now() - days * 86_400_000);
  return new Date(`${date.toISOString().slice(0, 10)}T00:00:00Z`);
}

async function reset(): Promise<void> {
  const users = await prisma.user.findMany({
    where: { email: { endsWith: '@example.invalid' } },
    select: { id: true },
  });
  const ids = users.map((user) => user.id);
  if (ids.length === 0) {
    console.log('nothing to reset — no seeded accounts found');
    return;
  }

  const trails = await prisma.review.findMany({
    where: { userId: { in: ids } },
    select: { trailId: true },
    distinct: ['trailId'],
  });

  // Reviews go with the user by cascade; the trail aggregates do not, so they are put back
  // by hand. A reset that left `rating: 4.3` on a trail with no reviews would be worse than
  // no reset at all.
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  await prisma.trail.updateMany({
    where: { id: { in: trails.map((row) => row.trailId) } },
    data: { rating: null, reviewCount: 0 },
  });

  console.log(`removed ${ids.length} seeded accounts and cleared ${trails.length} trail averages`);
}

async function main(): Promise<void> {
  assertNotProduction();

  if (process.argv.includes('--reset')) {
    await reset();
    return;
  }

  const hikers = await Promise.all(
    HIKERS.map((hiker) =>
      prisma.user.upsert({
        where: { email: `${hiker.username}@example.invalid` },
        create: {
          email: `${hiker.username}@example.invalid`,
          name: hiker.name,
          username: hiker.username,
          bio: 'Seeded account for local development.',
        },
        update: { name: hiker.name },
        select: { id: true, username: true },
      }),
    ),
  );

  /**
   * The trails that are worth looking at.
   *
   * Ordered by what the ingest pipeline already found interesting — longest first among
   * named routes — rather than by id, because a review section is being judged here and an
   * unnamed forty-metre connector path is not a fair test of one.
   */
  const trails = await prisma.trail.findMany({
    where: { name: { not: '' } },
    orderBy: { lengthM: 'desc' },
    take: 12,
    select: { id: true, slug: true, name: true },
  });

  if (trails.length === 0) {
    console.log('no trails in the database yet — run `npm run db:seed` and drain the queue first');
    return;
  }

  let written = 0;

  for (const [index, trail] of trails.entries()) {
    const random = rng(index * 7919 + 13);
    // Between three and every report, so the histograms differ trail to trail and the
    // "one report" singular case actually appears somewhere in the set.
    const howMany = 3 + Math.floor(random() * (REPORTS.length - 2));

    // Each trail starts at a different offset in the report list, so trail two is not
    // trail one with the tail cut off.
    const offset = Math.floor(random() * REPORTS.length);

    const counts = [0, 0, 0, 0, 0];

    for (let n = 0; n < howMany && n < hikers.length * 2; n += 1) {
      const report = REPORTS[(offset + n) % REPORTS.length]!;
      const hiker = hikers[n % hikers.length]!;
      // One review per person per trail is a unique index, so a trail can never hold more
      // reports than there are seeded hikers.
      if (n >= hikers.length) break;

      await prisma.review.upsert({
        where: { trailId_userId: { trailId: trail.id, userId: hiker.id } },
        create: {
          trailId: trail.id,
          userId: hiker.id,
          rating: report.rating,
          body: report.body,
          hikedOn: report.daysAgo === null ? null : daysAgoUtc(report.daysAgo),
          conditions: report.conditions,
          activityType: report.activityType,
          helpfulCount: Math.floor(random() * 9),
        },
        update: {},
        select: { id: true },
      });

      // Indexed by rating − 1, the same convention the router's `ratingCounts` uses, so the
      // seeded average and the recomputed one cannot disagree. Read through a default
      // because a variable index into an array is `number | undefined` here.
      const bucket = report.rating - 1;
      counts[bucket] = (counts[bucket] ?? 0) + 1;
      written += 1;
    }

    await prisma.trail.update({
      where: { id: trail.id },
      data: {
        rating: averageRating(counts),
        reviewCount: counts.reduce((sum, count) => sum + count, 0),
      },
    });

    console.log(`  ${trail.slug} — ${counts.reduce((a, b) => a + b, 0)} reports`);
  }

  console.log(
    `\nwrote ${written} reports across ${trails.length} trails as ${hikers.length} accounts`,
  );
  console.log('remove them again with: npm run db:seed:reviews -- --reset');
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
