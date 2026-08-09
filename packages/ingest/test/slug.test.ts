import { describe, expect, it } from 'vitest';
import { Prisma } from '@switchback/db';
import type { OsmElementType } from '@switchback/db';
import { slugify } from '../src/derive';
import { identitySlug, planTileSlugs, slugLadder, uniqueSlug } from '../src/slug';
import type { SlugSubject } from '../src/slug';

/** A transaction client over a fixed set of taken slugs, plus whatever the alias table answers. */
function txWith(
  taken: Readonly<Record<string, { osmType: OsmElementType; osmId: bigint }>> = {},
  retired: readonly string[] = [],
  aliasLookup?: () => Promise<{ slug: string } | null>,
): Prisma.TransactionClient {
  return {
    trail: {
      findUnique: ({ where }: { where: { slug: string } }) =>
        Promise.resolve(taken[where.slug] ?? null),
    },
    trailSlugAlias: {
      findUnique:
        aliasLookup ??
        (({ where }: { where: { slug: string } }) =>
          Promise.resolve(retired.includes(where.slug) ? { slug: where.slug } : null)),
    },
  } as unknown as Prisma.TransactionClient;
}

function rejectWith(code: string): () => Promise<never> {
  return () =>
    Promise.reject(new Prisma.PrismaClientKnownRequestError(code, { code, clientVersion: 'test' }));
}

const AIN_WAY_IDS = [
  26667074, 26667073, 26668418, 26668597, 26673472, 26673476, 26673663, 26673664, 26675299,
  26675300, 26675500, 26675502,
];

/** The twelve `Chemin d'Exploitation` ways one Ain tile assembled in a 587 ms window. */
const AIN: SlugSubject[] = AIN_WAY_IDS.map((osmId) => ({
  osmType: 'way',
  osmId,
  name: "Chemin d'Exploitation",
}));

/**
 * Every trail in a batch resolves against the database as it stood before any of them wrote,
 * which is what concurrent transactions see: each read precedes every commit.
 */
async function resolveAll(
  subjects: readonly SlugSubject[],
  candidatesFor: (subject: SlugSubject) => readonly string[],
  tx: Prisma.TransactionClient = txWith(),
): Promise<string[]> {
  return Promise.all(
    subjects.map((subject) =>
      uniqueSlug(tx, candidatesFor(subject), subject.osmType, BigInt(subject.osmId)),
    ),
  );
}

describe('slugLadder', () => {
  it('offers the bare name, then the region, then the identity slug', () => {
    expect(slugLadder({ osmType: 'way', osmId: 162652736, name: 'Kibbie Lake Trail' }, 'Tuolumne'))
      .toMatchInlineSnapshot(`
      [
        "kibbie-lake-trail",
        "kibbie-lake-trail-tuolumne",
        "kibbie-lake-trail--way-2ou7nk",
      ]
    `);
  });

  it('skips the region rung when the tile has no region name', () => {
    const ladder = slugLadder({ osmType: 'relation', osmId: 12, name: 'Summit Trail' }, null);
    expect(ladder).toEqual(['summit-trail', 'summit-trail--relation-c']);
  });

  it('ends on a slug no name can produce, because slugify never emits two hyphens', () => {
    // The double hyphen is the whole guarantee: a name that would slug to the identity slug is
    // what would make "unique by construction" false.
    const collided = slugify("Chemin d'Exploitation -- way fvqy6");
    expect(collided).not.toContain('--');
    expect(collided).not.toBe(identitySlug(AIN[0]!));
  });
});

describe('planTileSlugs', () => {
  it('the ladder alone hands every trail in the batch the same slug', async () => {
    // The defect, reproduced: twelve concurrent readers all find the bare slug free, so eleven
    // of them block on the twelfth at the unique index and take a P2002 when it commits.
    const slugs = await resolveAll(AIN, (subject) => slugLadder(subject, 'Ain'));

    expect(new Set(slugs).size).toBe(1);
    expect(slugs[0]).toBe('chemin-d-exploitation');
  });

  it('gives every trail in the batch a slug of its own', async () => {
    const plan = planTileSlugs(AIN, 'Ain');
    const slugs = await resolveAll(AIN, plan);

    expect(new Set(slugs).size).toBe(AIN.length);
    expect(slugs).toContain('chemin-d-exploitation');
    expect(slugs).toContain('chemin-d-exploitation-ain');
  });

  it('hands the bare slug to the same way however the batch is ordered', () => {
    const forwards = planTileSlugs(AIN, 'Ain');
    const backwards = planTileSlugs([...AIN].reverse(), 'Ain');

    for (const subject of AIN) expect(backwards(subject)).toEqual(forwards(subject));
    expect(forwards(AIN.find((s) => s.osmId === 26667073)!)[0]).toBe('chemin-d-exploitation');
  });

  it('ranks a relation above the ways it shares a name with', () => {
    const way: SlugSubject = { osmType: 'way', osmId: 1, name: 'Mist Trail' };
    const relation: SlugSubject = { osmType: 'relation', osmId: 999, name: 'Mist Trail' };
    const plan = planTileSlugs([way, relation], 'Yosemite');

    expect(plan(relation)[0]).toBe('mist-trail');
    expect(plan(way)[0]).toBe('mist-trail-yosemite');
  });

  it('leaves trails of different names alone', () => {
    const a: SlugSubject = { osmType: 'way', osmId: 2, name: 'Lake Trail' };
    const b: SlugSubject = { osmType: 'way', osmId: 1, name: 'Ridge Trail' };
    const plan = planTileSlugs([a, b], 'Ain');

    expect(plan(a)).toEqual(slugLadder(a, 'Ain'));
    expect(plan(b)).toEqual(slugLadder(b, 'Ain'));
  });

  it('gives a trail it never saw the top of its own ladder', () => {
    const stranger: SlugSubject = { osmType: 'relation', osmId: 7, name: 'Tour du Mont Blanc' };
    expect(planTileSlugs([], 'Haute-Savoie')(stranger)).toEqual(
      slugLadder(stranger, 'Haute-Savoie'),
    );
  });
});

describe('uniqueSlug', () => {
  const SUBJECT: SlugSubject = { osmType: 'way', osmId: 162652736, name: 'Kibbie Lake Trail' };
  const LADDER = slugLadder(SUBJECT, 'Tuolumne');
  const OSM_ID = BigInt(SUBJECT.osmId);

  it('takes the bare name when no trail and no alias hold it', async () => {
    expect(await uniqueSlug(txWith(), LADDER, 'way', OSM_ID)).toBe('kibbie-lake-trail');
  });

  it('steps past a slug another trail holds', async () => {
    const held = { 'kibbie-lake-trail': { osmType: 'way' as OsmElementType, osmId: 99n } };
    expect(await uniqueSlug(txWith(held), LADDER, 'way', OSM_ID)).toBe(
      'kibbie-lake-trail-tuolumne',
    );
  });

  it('keeps a slug that is already ours, so a re-ingest keeps its URL', async () => {
    const held = { 'kibbie-lake-trail': { osmType: 'way' as OsmElementType, osmId: OSM_ID } };
    expect(await uniqueSlug(txWith(held), LADDER, 'way', OSM_ID)).toBe('kibbie-lake-trail');
  });

  it('steps past a slug a merge retired, so a permanent link keeps its own trail', async () => {
    expect(await uniqueSlug(txWith({}, ['kibbie-lake-trail']), LADDER, 'way', OSM_ID)).toBe(
      'kibbie-lake-trail-tuolumne',
    );
  });

  it('falls to the identity slug when every prettier form is taken', async () => {
    const retired = ['kibbie-lake-trail', 'kibbie-lake-trail-tuolumne'];
    expect(await uniqueSlug(txWith({}, retired), LADDER, 'way', OSM_ID)).toBe(
      'kibbie-lake-trail--way-2ou7nk',
    );
  });

  it('reads nothing when the plan has already ranked the trail onto its identity slug', async () => {
    let reads = 0;
    const counting = {
      trail: {
        findUnique: () => {
          reads += 1;
          return Promise.resolve(null);
        },
      },
    } as unknown as Prisma.TransactionClient;

    expect(await uniqueSlug(counting, [identitySlug(SUBJECT)], 'way', OSM_ID)).toBe(
      'kibbie-lake-trail--way-2ou7nk',
    );
    expect(reads).toBe(0);
  });

  // The property `osm-id` is documented to have: no dependency on `trail_slug_aliases` existing.
  // A Preview build runs branch code against whichever database it is pointed at while `migrate`
  // runs on `master` alone, so without this the whole commit fails there rather than ingesting.
  it('ingests against a database that has no trail_slug_aliases at all', async () => {
    expect(await uniqueSlug(txWith({}, [], rejectWith('P2021')), LADDER, 'way', OSM_ID)).toBe(
      'kibbie-lake-trail',
    );
  });

  it('still fails the commit on an error that is not a missing table', async () => {
    await expect(
      uniqueSlug(txWith({}, [], rejectWith('P1010')), LADDER, 'way', OSM_ID),
    ).rejects.toMatchObject({ code: 'P1010' });
  });

  it('refuses an empty candidate list rather than inventing a slug', async () => {
    await expect(uniqueSlug(txWith(), [], 'way', OSM_ID)).rejects.toThrow(
      /at least one candidate/u,
    );
  });
});
