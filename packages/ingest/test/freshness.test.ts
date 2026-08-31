import { describe, expect, it } from 'vitest';
import { TileStatus } from '@switchback/db';
import { TILE_TTL_MS, isTileFresh } from '../src/freshness';

const NOW = new Date('2026-06-01T12:00:00Z');
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

/** A settled tile fetched a moment ago, so only the source stamp under test decides. */
const justFetched = (sourceSnapshotAt: Date | null) => ({
  status: TileStatus.ready,
  fetchedAt: NOW,
  sourceSnapshotAt,
});

describe('isTileFresh', () => {
  it('serves cached data inside the TTL', () => {
    expect(
      isTileFresh(
        { status: TileStatus.ready, fetchedAt: ago(29 * 24 * 3600_000), sourceSnapshotAt: null },
        NOW,
      ),
    ).toBe(true);
  });

  it('counts an empty tile as fresh, so ocean is not re-queried every request', () => {
    expect(
      isTileFresh({ status: TileStatus.empty, fetchedAt: ago(1000), sourceSnapshotAt: null }, NOW),
    ).toBe(true);
  });

  it('expires past the TTL', () => {
    expect(
      isTileFresh(
        { status: TileStatus.ready, fetchedAt: ago(TILE_TTL_MS + 1), sourceSnapshotAt: null },
        NOW,
      ),
    ).toBe(false);
  });

  it('never serves a tile that failed or is still running', () => {
    // A failed tile with a stale fetchedAt would otherwise render an empty map as though
    // the area genuinely had no trails.
    const settled = { fetchedAt: ago(1000), sourceSnapshotAt: null };
    expect(isTileFresh({ status: TileStatus.failed, ...settled }, NOW)).toBe(false);
    expect(isTileFresh({ status: TileStatus.running, ...settled }, NOW)).toBe(false);
    expect(isTileFresh({ status: TileStatus.pending, ...settled }, NOW)).toBe(false);
  });

  it('treats a never-fetched or absent tile as cold', () => {
    expect(
      isTileFresh({ status: TileStatus.ready, fetchedAt: null, sourceSnapshotAt: null }, NOW),
    ).toBe(false);
    expect(isTileFresh(null, NOW)).toBe(false);
  });
});

/*
 * The age of the data, not the age of the fetch. An extract-backed ingest stamps `fetchedAt`
 * with the clock on data that may be a year old, so a predicate reading `fetchedAt` alone
 * reports fresh for as long as something keeps re-fetching — without bound, and without any
 * of it being true.
 */
describe('isTileFresh against the source stamp', () => {
  it('refuses a tile whose source data is older than the TTL, however recent the fetch', () => {
    expect(isTileFresh(justFetched(ago(TILE_TTL_MS + 1)), NOW)).toBe(false);
  });

  it('still serves a tile whose source is inside the TTL', () => {
    expect(isTileFresh(justFetched(ago(TILE_TTL_MS - 1000)), NOW)).toBe(true);
  });

  it('does not let re-fetching the same stale extract launder it fresh', () => {
    /*
     * The failure this whole column exists for. One extract, four re-ingests a month apart:
     * each stamps `fetchedAt` with its own clock, and the data behind all four is the same
     * day. Reading `fetchedAt` alone, every one of these is "fresh".
     */
    const extract = new Date('2025-01-01T00:00:00Z');
    const refetches = [30, 60, 90, 365].map((days) => new Date(NOW.getTime() + days * 86_400_000));

    for (const fetchedAt of refetches) {
      expect(
        isTileFresh(
          { status: TileStatus.ready, fetchedAt, sourceSnapshotAt: extract },
          new Date(fetchedAt.getTime() + 1000),
        ),
      ).toBe(false);
    }
  });

  /*
   * Regression guards, not red-then-green: both of these already hold under the old predicate
   * and must keep holding. They pin the two ways the minimum could go wrong in the unsafe
   * direction — by expiring the whole existing estate at once, or by trusting a skewed clock.
   */
  it('falls back to the fetch time when no source stamp was recorded', () => {
    // Every row written before this column existed is null. Treating null as stale would
    // expire the entire estate at once and re-queue it into one Overpass thundering herd.
    expect(isTileFresh(justFetched(null), NOW)).toBe(true);
  });

  it('ignores a source stamp that claims to be newer than the fetch', () => {
    // Clock skew upstream must not extend freshness past what we actually observed, so the
    // minimum — never the maximum — is what decides.
    const stale = {
      status: TileStatus.ready,
      fetchedAt: ago(TILE_TTL_MS + 1),
      sourceSnapshotAt: NOW,
    };
    expect(isTileFresh(stale, NOW)).toBe(false);
  });
});
