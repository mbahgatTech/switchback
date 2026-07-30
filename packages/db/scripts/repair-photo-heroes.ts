/**
 * Repair photo bookkeeping — heroes pointing at the wrong row, or at no row at all.
 *
 * Two causes, one symptom: a trail page with no photograph on it, or somebody else's.
 *
 * **A hero belonging to somebody else.** `enrichTrailPhotos` once keyed photos on
 * `(source, sourceId)` alone. Commons geosearch is a radius query and neighbouring trails
 * share photographs, so the second trail to enrich did not create its own row — it
 * *re-parented* the first trail's, moving `Photo.trailId` across. The key now includes
 * `trailId` and the bug cannot recur, but nothing ever went back for the rows it moved.
 * `Trail.primaryPhotoId` still points at a row that now belongs to a different trail, which
 * is a photograph of somewhere else at the top of a trail page. It is also why enrichment
 * was failing: the column is `@unique` (Prisma requires it on the owning side of a
 * one-to-one), so the trail that actually *owns* that photo cannot claim it as its own hero,
 * and its `enrich_trail` job died on a unique violation before writing anything.
 *
 * **A hero that was deleted.** `primaryPhotoId` is `ON DELETE SET NULL`, so removing a photo
 * silently un-heroes whatever trail was flying it. That is the right behaviour — the
 * alternative is a dangling pointer — but it leaves a trail holding a dozen good photographs
 * and showing none of them, because the card reads the hero and not the album. Purging the
 * 18,047 satellite images out of the seed corpus nulled 2,604 heroes in one statement.
 *
 * **A `photoCount` nobody recomputed.** Either of the above leaves the stored count
 * describing a set of photos that no longer exists, so cards advertise pictures that are not
 * there.
 *
 * Prints what it would do and changes nothing unless told to:
 *
 *     npx tsx packages/db/scripts/repair-photo-heroes.ts
 *     npx tsx packages/db/scripts/repair-photo-heroes.ts --apply
 *
 * Idempotent — a second run finds nothing. Safe to re-run after any ingest.
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
 * Sequential, over a live set of claimed ids, because the repairs interact: the id trail A
 * releases may be exactly the one trail B is entitled to take, and a pass that decided all
 * of them against one snapshot would hand the same photo to two trails and fail on the
 * second write. Ordered by trail id so two runs on the same data make the same choices.
 *
 * Returns the claim set as it stands afterwards, because the adoption pass has to keep
 * honouring it — `primaryPhotoId` is `@unique` across the whole table, not per trail.
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
    // `primaryPhoto` is null only if the row vanished without the FK firing, which it cannot;
    // the narrowing is for the compiler, and a missing photo is a hero worth clearing anyway.
    if (trail.primaryPhotoId === null) continue;
    if (trail.primaryPhoto !== null && trail.primaryPhoto.trailId === trail.id) continue;

    claimed.delete(trail.primaryPhotoId);

    const own = await prisma.photo.findMany({
      // A photograph a moderator took down is not a candidate for the hero slot. This
      // script exists to repair heroes, and repairing one onto hidden content would be a
      // maintenance pass quietly reversing a takedown.
      where: { trailId: trail.id, hiddenAt: null },
      select: { id: true },
      // The order enrichment itself would have saved them in, so the repaired hero is the
      // one the trail would have had if the photos had never moved.
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
 * Give a hero to every trail that has photographs and is not flying one.
 *
 * The relation filter is what keeps this cheap: the great majority of trails with no hero
 * have no photographs either, and asking the database for `photos: { some: {} }` means they
 * are never loaded. Only the trails that are actually showing less than they hold come back.
 *
 * Eight candidates each rather than one, though one is almost always enough. A trail's own
 * photographs cannot be claimed by anybody else once the pass above has run — that pass
 * exists precisely to return misfiled claims — so the first is free. The extra seven cost a
 * few bytes and cover the dry run, where nothing was written and the claim set still
 * describes the database as it was found.
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
 * Recompute `photoCount` from the photos that exist.
 *
 * One correlated statement rather than a row-at-a-time loop: it is a count over an indexed
 * column, and the `WHERE` means only the rows that actually drifted are written.
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

  // After the stolen ones are back, because a photo returned here may be the very one an
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
