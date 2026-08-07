import { describe, expect, it } from 'vitest';
import { JobKind } from '@switchback/db';
import type { PrismaClient } from '@switchback/db';
import { drainSlotGate, maxDrainers } from '../src/drain-slot';
import { drainJobs } from '../src/jobs';
import type { ClaimedBatch, ClaimedJob } from '../src/jobs';

/**
 * The bound these cases are about is *fleet-wide*, and a unit test cannot start two Vercel
 * lambdas. What it can pin is the two things that make the bound real rather than decorative:
 * that the count and the claim happen inside one transaction under the advisory lock, and that a
 * process arriving while another is draining claims nothing.
 */

interface Recorded {
  raw: string[];
  claimed: boolean;
}

function fakeDb(drainers: number): { db: PrismaClient; recorded: Recorded } {
  const recorded: Recorded = { raw: [], claimed: false };

  const tx = {
    $executeRaw: async (strings: TemplateStringsArray) => {
      recorded.raw.push(strings.join('?'));
      return 1;
    },
    $queryRaw: async (strings: TemplateStringsArray) => {
      recorded.raw.push(strings.join('?'));
      return [{ drainers }];
    },
    ingestJob: { updateMany: async () => ({ count: 0 }) },
  };

  const db = {
    // `drainJobs` sweeps before it claims; the gate's own sweep is the one these cases are about.
    $queryRaw: async () => [],
    $transaction: async (run: (client: unknown) => Promise<ClaimedBatch>) => run(tx),
  } as unknown as PrismaClient;

  return { db, recorded };
}

const job: ClaimedJob = {
  id: 'j1',
  kind: JobKind.ingest_tile,
  dedupeKey: 'ingest_tile:120230202',
  payload: {},
  attempts: 1,
  maxAttempts: 5,
  lockedAt: new Date('2026-08-07T10:00:00Z'),
  lockedBy: 'inline-abcd1234',
};

describe('the drain slot', () => {
  it('admits a process when nothing else is draining', async () => {
    const { db, recorded } = fakeDb(0);

    const batch = await drainSlotGate(
      db,
      1,
    )(async () => {
      recorded.claimed = true;
      return { primary: [job], derived: [] };
    });

    expect(batch.primary).toEqual([job]);
    expect(recorded.claimed).toBe(true);
  });

  it('refuses one that arrives while another holds the slot', async () => {
    const { db, recorded } = fakeDb(1);

    const batch = await drainSlotGate(
      db,
      1,
    )(async () => {
      recorded.claimed = true;
      return { primary: [job], derived: [job] };
    });

    expect(batch).toEqual({ primary: [], derived: [] });
    expect(recorded.claimed, 'claimed despite the slot being taken').toBe(false);
  });

  it('takes the lock, sweeps and counts before it claims', async () => {
    const { db, recorded } = fakeDb(0);
    await drainSlotGate(db, 1)(async () => ({ primary: [], derived: [] }));

    expect(recorded.raw[0]).toContain('pg_advisory_xact_lock');
    expect(recorded.raw.at(-1)).toContain('count(distinct "lockedBy")');
  });

  it('reads its limit from the environment, and refuses to be talked out of one', () => {
    expect(maxDrainers({ INGEST_MAX_DRAINERS: '2' })).toBe(2);
    expect(maxDrainers({ INGEST_MAX_DRAINERS: '0' })).toBe(1);
    expect(maxDrainers({ INGEST_MAX_DRAINERS: 'lots' })).toBe(1);
    expect(maxDrainers({})).toBe(1);
  });
});

describe('a drain that is turned away', () => {
  it('runs no handler, so it makes no Overpass request', async () => {
    const { db } = fakeDb(1);
    let handled = 0;

    const result = await drainJobs(
      { [JobKind.ingest_tile]: async () => void handled++ },
      { db, gate: drainSlotGate(db, 1) },
    );

    expect(handled).toBe(0);
    expect(result.claimed).toBe(0);
  });
});
