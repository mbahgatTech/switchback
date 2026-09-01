import { describe, expect, it } from 'vitest';
import { TileStatus } from '@switchback/db';
import {
  REFETCH_INTERVAL_MS,
  TILE_TTL_MS,
  isRefetchDue,
  isTileFresh,
  isTileSettled,
} from '../src/freshness';

const NOW = new Date('2026-06-01T12:00:00Z');
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

/**
 * Every status the predicate will serve, taken from the predicate itself rather than named here.
 * The source stamp has to bind each one, and a pair written out stops being the set the moment a
 * third settled status is added.
 */
const SERVED = Object.values(TileStatus).filter((status) =>
  isTileFresh({ status, fetchedAt: NOW, sourceSnapshotAt: null }, NOW),
);

/** A settled tile fetched a moment ago, so only the source stamp under test decides. */
const justFetched = (status: TileStatus, sourceSnapshotAt: Date | null) => ({
  status,
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
 *
 * Parameterised over every status the predicate serves rather than over `ready` alone: an
 * `empty` tile is judged on the same TTL, and a partial extract answering an out-of-area query
 * with zero elements writes exactly that row, carrying the extract's own date.
 */
describe('isTileFresh against the source stamp', () => {
  it('serves exactly the statuses `isTileSettled` admits, so the blocks below cover them all', () => {
    /*
     * Both sides measured rather than written out: what the predicate actually serves, against
     * what the settled helper claims. `SERVED` parameterises every block below, so a status that
     * reaches the TTL comparison without appearing here is a status the source stamp is never
     * tested on — the fetch-only lie back, for that status alone.
     */
    expect(SERVED).toEqual(Object.values(TileStatus).filter(isTileSettled));
    expect(SERVED.length).toBeGreaterThan(0);
  });

  describe.each(SERVED)('on a %s tile', (status) => {
    it('refuses one whose source data is older than the TTL, however recent the fetch', () => {
      expect(isTileFresh(justFetched(status, ago(TILE_TTL_MS + 1)), NOW)).toBe(false);
    });

    it('still serves one whose source is inside the TTL', () => {
      expect(isTileFresh(justFetched(status, ago(TILE_TTL_MS - 1000)), NOW)).toBe(true);
    });

    it('does not let re-fetching the same stale extract launder it fresh', () => {
      /*
       * The failure this whole column exists for. One extract, four re-ingests a month apart:
       * each stamps `fetchedAt` with its own clock, and the data behind all four is the same
       * day. Reading `fetchedAt` alone, every one of these is "fresh".
       */
      const extract = new Date('2025-01-01T00:00:00Z');
      const refetches = [30, 60, 90, 365].map(
        (days) => new Date(NOW.getTime() + days * 86_400_000),
      );

      for (const fetchedAt of refetches) {
        expect(
          isTileFresh(
            { status, fetchedAt, sourceSnapshotAt: extract },
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
      expect(isTileFresh(justFetched(status, null), NOW)).toBe(true);
    });

    it('ignores a source stamp that claims to be newer than the fetch', () => {
      // Clock skew upstream must not extend freshness past what we actually observed, so the
      // minimum — never the maximum — is what decides.
      const stale = { status, fetchedAt: ago(TILE_TTL_MS + 1), sourceSnapshotAt: NOW };
      expect(isTileFresh(stale, NOW)).toBe(false);
    });
  });
});

/*
 * Too old to serve is a different question from worth asking again, and every queueing caller has
 * the second one. A tile whose source stamp is already past the TTL never becomes fresh, so a
 * caller reading `isTileFresh` alone re-queues it on every viewport poll for as long as a map
 * stays open over that ground — a real Overpass query per browse request that cannot move the
 * stamp it exists to move.
 */
describe('isRefetchDue', () => {
  describe.each(SERVED)('on a %s tile whose source data is past the TTL', (status) => {
    const stampedStale = (fetchedAt: Date) => ({
      status,
      fetchedAt,
      sourceSnapshotAt: ago(TILE_TTL_MS + 1),
    });

    it('holds the tile back while it is inside the refetch interval', () => {
      // Stale on both readings. The point is that asking again cannot change either one.
      expect(isTileFresh(stampedStale(NOW), NOW)).toBe(false);
      expect(isRefetchDue(stampedStale(NOW), NOW)).toBe(false);
      expect(isRefetchDue(stampedStale(ago(REFETCH_INTERVAL_MS - 1)), NOW)).toBe(false);
    });

    it('lets it through once the interval has passed, so a caught-up source is noticed', () => {
      expect(isRefetchDue(stampedStale(ago(REFETCH_INTERVAL_MS)), NOW)).toBe(true);
    });
  });

  it('never holds back a tile that is stale on its own fetch clock', () => {
    // The interval is shorter than the TTL, so a tile the TTL has expired has always waited it
    // out already. Anything else would be a second, longer TTL nobody asked for.
    expect(REFETCH_INTERVAL_MS).toBeLessThan(TILE_TTL_MS);
    expect(
      isRefetchDue(
        { status: TileStatus.ready, fetchedAt: ago(TILE_TTL_MS + 1), sourceSnapshotAt: null },
        NOW,
      ),
    ).toBe(true);
  });

  it('leaves an unsettled tile to the job retry ladder, which carries its own backoff', () => {
    // `pending`, `running` and `failed` are how a tile in flight is represented. Holding one back
    // here would strand it behind an interval the ladder knows nothing about.
    const unsettled = Object.values(TileStatus).filter((status) => !isTileSettled(status));
    expect(unsettled.length).toBeGreaterThan(0);
    for (const status of unsettled) {
      expect(isRefetchDue({ status, fetchedAt: NOW, sourceSnapshotAt: NOW }, NOW)).toBe(true);
    }
  });

  it('queues a cold tile and an absent row without waiting', () => {
    expect(
      isRefetchDue({ status: TileStatus.ready, fetchedAt: null, sourceSnapshotAt: null }, NOW),
    ).toBe(true);
    expect(isRefetchDue(null, NOW)).toBe(true);
  });

  it('asks nothing of a tile that is genuinely fresh', () => {
    expect(isRefetchDue(justFetched(TileStatus.ready, ago(TILE_TTL_MS - 1000)), NOW)).toBe(false);
  });
});
