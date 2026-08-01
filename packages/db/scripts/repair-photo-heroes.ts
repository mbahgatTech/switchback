/**
 * Repair photo bookkeeping — heroes pointing at the wrong row, at a deleted row, or a
 * `photoCount` nobody recomputed. Symptom: a trail page with no photograph, or somebody else's.
 *
 * `Trail.primaryPhotoId` is `@unique`, so a hero misfiled onto another trail also blocks the
 * owning trail's `enrich_trail` job with a unique violation. `ON DELETE SET NULL` accounts for
 * the rest: removing a photo silently un-heroes whatever trail was flying it.
 *
 * Prints what it would do and changes nothing unless told to. Idempotent; safe after any ingest.
 *
 *     npx tsx packages/db/scripts/repair-photo-heroes.ts
 *     npx tsx packages/db/scripts/repair-photo-heroes.ts --apply
 */
import { prisma } from '@switchback/db';

interface Repair {
  trailId: string;
  slug: string;
  from: string;
  to: string | null;
}

/** A trail that had no hero at all, and the photograph it now flies. */
interface Adoption {
  slug: string;
  to: string;
}

/**
 * Re-point every stolen hero at a photograph the trail actually owns.
 *
 * Sequential over a live claim set, because the repairs interact: the id trail A releases may be
 * the one trail B is entitled to take, and deciding all of them against one snapshot would hand
 * the same photo to two trails. Ordered by trail id so two runs make the same choices. Returns
 * the claim set, which the adoption pass must keep honouring — `primaryPhotoId` is `@unique`
 * across the whole table, not per trail.
 */
async function repairHeroes(apply: boolean): Promise<{ repairs: Repair[]; claimed: Set<string> }> {
  const trails = await prisma.trail.findMany({
    where: { primaryPhotoId: { not: null } },
    select: {
      id: true,
      slug: true,
      primaryPhotoId: true,
      primaryPhoto: { select: { trailId: true } },
    },
    orderBy: { id: 'asc' },
  });

  const claimed = new Set<string>();
  for (const trail of trails) {
    if (trail.primaryPhotoId !== null) claimed.add(trail.primaryPhotoId);
  }

  const repairs: Repair[] = [];

  for (const trail of trails) {
    // The narrowing is for the compiler; a missing photo is a hero worth clearing anyway.
    if (trail.primaryPhotoId === null) continue;
    if (trail.primaryPhoto !== null && trail.primaryPhoto.trailId === trail.id) continue;

    claimed.delete(trail.primaryPhotoId);

    const own = await prisma.photo.findMany({
      // Never promote hidden content: repairing a hero onto it would quietly reverse a takedown.
      where: { trailId: trail.id, hiddenAt: null },
      select: { id: true },
      // Enrichment's own save order, so the repaired hero is the one the trail would have had.
      orderBy: { id: 'asc' },
    });
    const replacement = own.find((photo) => !claimed.has(photo.id))?.id ?? null;
    if (replacement !== null) claimed.add(replacement);

    repairs.push({
      trailId: trail.id,
      slug: trail.slug,
      from: trail.primaryPhotoId,
      to: replacement,
    });

    if (apply) {
      await prisma.trail.update({
        where: { id: trail.id },
        data: { primaryPhotoId: replacement },
      });
    }
  }

  return { repairs, claimed };
}

/**
 * Give a hero to every trail that has photographs and is not flying one. The `photos: { some: {} }`
 * filter is what keeps this cheap — most heroless trails have no photographs either.
 *
 * Eight candidates each, though one is almost always enough: the extras cover the dry run, where
 * nothing was written and the claim set still describes the database as it was found.
 */
async function adoptHeroes(apply: boolean, claimed: Set<string>): Promise<Adoption[]> {
  const trails = await prisma.trail.findMany({
    where: { primaryPhotoId: null, photos: { some: {} } },
    select: {
      id: true,
      slug: true,
      photos: { select: { id: true }, orderBy: { id: 'asc' }, take: 8 },
    },
    orderBy: { id: 'asc' },
  });

  const adoptions: Adoption[] = [];

  for (const trail of trails) {
    const hero = trail.photos.find((photo) => !claimed.has(photo.id))?.id;
    if (hero === undefined) continue;
    claimed.add(hero);

    adoptions.push({ slug: trail.slug, to: hero });

    if (apply) {
      await prisma.trail.update({ where: { id: trail.id }, data: { primaryPhotoId: hero } });
    }
  }

  return adoptions;
}

/**
 * Recompute `photoCount` from the photos that exist. One correlated statement, and the `WHERE`
 * means only rows that actually drifted are written.
 */
async function repairCounts(apply: boolean): Promise<number> {
  if (!apply) {
    const [drift] = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n
      FROM trails t
      JOIN LATERAL (SELECT count(*)::int AS n FROM photos p WHERE p."trailId" = t.id) c ON true
      WHERE t."photoCount" <> c.n
    `;
    return Number(drift?.n ?? 0);
  }

  return prisma.$executeRaw`
    UPDATE trails t
    SET "photoCount" = c.n
    FROM trails t2
    JOIN LATERAL (SELECT count(*)::int AS n FROM photos p WHERE p."trailId" = t2.id) c ON true
    WHERE t.id = t2.id AND t."photoCount" <> c.n
  `;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');

  const { repairs, claimed } = await repairHeroes(apply);
  for (const repair of repairs) {
    const outcome = repair.to === null ? 'no photo of its own — cleared' : `→ ${repair.to}`;
    console.log(`  ${repair.slug.padEnd(40)} ${repair.from} ${outcome}`);
  }

  // Must run after the stolen ones are returned: a photo released there may be the very one an
  // un-heroed trail is about to adopt.
  const adoptions = await adoptHeroes(apply, claimed);
  for (const adoption of adoptions) {
    console.log(`  ${adoption.slug.padEnd(40)} no hero → ${adoption.to}`);
  }

  const counts = await repairCounts(apply);

  const verb = apply ? 'repaired' : 'would repair';
  console.log(`\n${verb} ${repairs.length} stolen hero${repairs.length === 1 ? '' : 'es'}`);
  console.log(`${verb} ${adoptions.length} missing hero${adoptions.length === 1 ? '' : 'es'}`);
  console.log(`${verb} ${counts} photo count${counts === 1 ? '' : 's'}`);
  if (!apply && (repairs.length > 0 || adoptions.length > 0 || counts > 0)) {
    console.log('\nnothing was written — re-run with --apply');
  }
}

void main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
