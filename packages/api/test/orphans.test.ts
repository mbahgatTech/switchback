import { afterEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@switchback/db';
import { sweepOrphanedPhotos } from '../src/orphans';
import {
  parseListing,
  setStorageDriver,
  type ObjectEntry,
  type StorageDriver,
} from '../src/storage';

/**
 * The sweeper deletes things. That is the whole reason this suite is thorough out of
 * proportion to the size of the file it covers: every other bug in this codebase shows up as
 * something missing from a page, and this one shows up as a photograph somebody took being
 * gone from a bucket with no undo.
 *
 * So the tests are written from the direction of "what would have to be true for this to
 * destroy data" — an object younger than the grace period, an object referenced only by its
 * thumbnail, a database that answers nothing because the query failed — rather than from the
 * direction of "does it collect the obvious orphan".
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-07-27T12:00:00Z');
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

/** A driver backed by a plain array, recording what it was asked to remove. */
function fakeStorage(entries: ObjectEntry[]): StorageDriver & { removed: string[] } {
  const removed: string[] = [];
  return {
    kind: 'local',
    removed,
    presignPut: () => Promise.reject(new Error('not used')),
    stat: () => Promise.resolve(null),
    remove: (key) => {
      removed.push(key);
      return Promise.resolve();
    },
    list: (prefix, limit) =>
      Promise.resolve(entries.filter((entry) => entry.key.startsWith(prefix)).slice(0, limit)),
    publicUrl: (key) => `https://photos.example.test/${key}`,
  };
}

/** Just enough Prisma to answer the one query the sweeper makes. */
function fakeDb(rows: Array<{ url: string; thumbUrl: string | null }>): PrismaClient {
  return {
    photo: {
      findMany: ({ where }: { where: { OR: Array<Record<string, { in: string[] }>> } }) => {
        const wanted = new Set(where.OR.flatMap((clause) => Object.values(clause)[0]?.in ?? []));
        return Promise.resolve(
          rows.filter((row) => wanted.has(row.url) || (row.thumbUrl && wanted.has(row.thumbUrl))),
        );
      },
    },
  } as unknown as PrismaClient;
}

const object = (key: string, age: number): ObjectEntry => ({
  key,
  size: 1024,
  lastModified: ago(age),
});

afterEach(() => {
  setStorageDriver(null);
});

describe('sweepOrphanedPhotos', () => {
  it('removes an object no row points at', async () => {
    const driver = fakeStorage([object('photos/usr_a/abandoned.webp', 3 * DAY)]);
    setStorageDriver(driver);

    const result = await sweepOrphanedPhotos(fakeDb([]), { now: NOW });

    expect(result).toEqual({ scanned: 1, orphaned: 1, deleted: 1, truncated: false });
    expect(driver.removed).toEqual(['photos/usr_a/abandoned.webp']);
  });

  it('will not touch an object younger than the grace period', async () => {
    // The whole safety argument rests on this one. An upload that lands during a sweep is
    // seconds old and has no row yet — exactly the shape of an orphan — and deleting it
    // would destroy a photograph somebody is in the middle of filing.
    const driver = fakeStorage([
      object('photos/usr_a/just-now.webp', 5_000),
      object('photos/usr_a/an-hour-ago.webp', 60 * 60 * 1000),
      object('photos/usr_a/yesterday-ish.webp', 23 * 60 * 60 * 1000),
    ]);
    setStorageDriver(driver);

    const result = await sweepOrphanedPhotos(fakeDb([]), { now: NOW });

    expect(result.scanned).toBe(0);
    expect(driver.removed).toEqual([]);
  });

  it('keeps an object a row points at, and the thumbnail beside it', async () => {
    const driver = fakeStorage([
      object('photos/usr_a/kept.webp', 30 * DAY),
      object('photos/usr_a/kept_t.jpg', 30 * DAY),
    ]);
    setStorageDriver(driver);

    const db = fakeDb([
      {
        url: 'https://photos.example.test/photos/usr_a/kept.webp',
        thumbUrl: 'https://photos.example.test/photos/usr_a/kept_t.jpg',
      },
    ]);
    const result = await sweepOrphanedPhotos(db, { now: NOW });

    expect(result).toEqual({ scanned: 2, orphaned: 0, deleted: 0, truncated: false });
    expect(driver.removed).toEqual([]);
  });

  it('collects a half-deleted pair — the rendition the row does not name', async () => {
    // `photos.remove` deletes the row first and the two objects after. If the second delete
    // fails we are left with a live row and one stranded rendition. Treating the pair as a
    // unit here would mean it is never collected.
    const driver = fakeStorage([
      object('photos/usr_a/half.webp', 30 * DAY),
      object('photos/usr_a/half_t.jpg', 30 * DAY),
    ]);
    setStorageDriver(driver);

    const db = fakeDb([
      { url: 'https://photos.example.test/photos/usr_a/half.webp', thumbUrl: null },
    ]);
    const result = await sweepOrphanedPhotos(db, { now: NOW });

    expect(driver.removed).toEqual(['photos/usr_a/half_t.jpg']);
    expect(result.orphaned).toBe(1);
  });

  it('only ever looks under photos/', async () => {
    // The bucket also holds the basemap. A sweeper that hiked the whole thing would decide
    // basemap.pmtiles is unreferenced — no `photos` row names it — and delete the map.
    const driver = fakeStorage([
      object('basemap.pmtiles', 90 * DAY),
      object('photos/usr_a/gone.webp', 90 * DAY),
    ]);
    setStorageDriver(driver);

    await sweepOrphanedPhotos(fakeDb([]), { now: NOW });

    expect(driver.removed).toEqual(['photos/usr_a/gone.webp']);
  });

  it('reports truncation when there is more to collect than one run may delete', async () => {
    const many = Array.from({ length: 260 }, (_, i) => object(`photos/usr_a/${i}.webp`, 30 * DAY));
    const driver = fakeStorage(many);
    setStorageDriver(driver);

    const result = await sweepOrphanedPhotos(fakeDb([]), { now: NOW });

    expect(result.orphaned).toBe(260);
    expect(result.deleted).toBe(200);
    expect(result.truncated).toBe(true);
  });

  it('carries on past an object it cannot remove', async () => {
    const driver = fakeStorage([
      object('photos/usr_a/locked.webp', 30 * DAY),
      object('photos/usr_a/fine.webp', 30 * DAY),
    ]);
    const remove = driver.remove.bind(driver);
    driver.remove = (key) =>
      key.includes('locked') ? Promise.reject(new Error('403')) : remove(key);
    setStorageDriver(driver);

    const result = await sweepOrphanedPhotos(fakeDb([]), { now: NOW });

    expect(result.orphaned).toBe(2);
    expect(result.deleted).toBe(1);
    expect(driver.removed).toEqual(['photos/usr_a/fine.webp']);
  });
});

describe('parseListing', () => {
  const LISTING = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>switchback</Name>
  <Prefix>photos/</Prefix>
  <KeyCount>2</KeyCount>
  <MaxKeys>1000</MaxKeys>
  <IsTruncated>true</IsTruncated>
  <NextContinuationToken>1ueGcxLPRx1Tr</NextContinuationToken>
  <Contents>
    <Key>photos/usr_a/one.webp</Key>
    <LastModified>2026-07-01T09:15:00.000Z</LastModified>
    <ETag>&quot;9b2cf5&quot;</ETag>
    <Size>184320</Size>
    <StorageClass>STANDARD</StorageClass>
  </Contents>
  <Contents>
    <Key>photos/usr_b/two &amp; a half.webp</Key>
    <LastModified>2026-07-02T09:15:00.000Z</LastModified>
    <ETag>&quot;1a0dd3&quot;</ETag>
    <Size>96000</Size>
    <StorageClass>STANDARD</StorageClass>
  </Contents>
</ListBucketResult>`;

  it('reads key, size and date out of every Contents block', () => {
    const { entries } = parseListing(LISTING);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      key: 'photos/usr_a/one.webp',
      size: 184320,
      lastModified: new Date('2026-07-01T09:15:00.000Z'),
    });
  });

  it('un-escapes the key', () => {
    // S3 XML-escapes keys. Deleting `two &amp; a half.webp` would 404 while the real object
    // stayed behind forever — a sweeper that quietly collects nothing.
    expect(parseListing(LISTING).entries[1]?.key).toBe('photos/usr_b/two & a half.webp');
  });

  it('returns the continuation token only while the listing is truncated', () => {
    expect(parseListing(LISTING).nextToken).toBe('1ueGcxLPRx1Tr');
    expect(
      parseListing(LISTING.replace('<IsTruncated>true', '<IsTruncated>false')).nextToken,
    ).toBeNull();
  });

  it('reads an empty bucket as an empty list rather than throwing', () => {
    const empty =
      '<?xml version="1.0"?><ListBucketResult><KeyCount>0</KeyCount><IsTruncated>false</IsTruncated></ListBucketResult>';
    expect(parseListing(empty)).toEqual({ entries: [], nextToken: null });
  });
});
