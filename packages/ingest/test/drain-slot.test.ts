import { describe, expect, it } from 'vitest';
import { JobKind } from '@switchback/db';
import type { PrismaClient } from '@switchback/db';
import { drainSlotGate, maxDrainers } from '../src/drain-slot';
import { drainIngest } from '../src/handlers';
import { drainJobs } from '../src/jobs';
import type { ClaimedBatch, ClaimedJob } from '../src/jobs';

// `drainIngest` builds the real pipeline dependencies, and `OverpassClient` refuses a
// User-Agent with no contact URL. Nothing here reaches the network.
process.env.OVERPASS_USER_AGENT ??= 'Switchback/test (+https://switchback-three.vercel.app)';

/**
 * The bound these cases are about is *fleet-wide*, and a unit test cannot start two Vercel
 * lambdas. What it can pin is the three things that make the bound real rather than decorative:
 * that the count and the claim happen inside one transaction under the advisory lock, that a
 * process arriving while another is draining claims nothing, and that a caller which asks for no
 * gate at all still gets one.
 */

interface Recorded {
  raw: string[];
  claimed: boolean;
}

/** The statement that takes work. Its presence is how these cases see a claim happen. */
const CLAIM_SQL = 'FOR UPDATE SKIP LOCKED';

function fakeDb(drainers: number): { db: PrismaClient; recorded: Recorded } {
  const recorded: Recorded = { raw: [], claimed: false };

  // Everything but the drainer count reads as an empty queue, which is what makes "did the claim
  // statement run at all" the observable these cases turn on.
  const answer = async (strings: TemplateStringsArray) => {
    const sql = strings.join('?');
    recorded.raw.push(sql);
    return sql.includes('count(distinct') ? [{ drainers }] : [];
  };

  const tx = {
    $executeRaw: async (strings: TemplateStringsArray) => {
      recorded.raw.push(strings.join('?'));
      return 1;
    },
    $queryRaw: answer,
    ingestJob: { updateMany: async () => ({ count: 0 }) },
  };

  const db = {
    $queryRaw: answer,
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

/**
 * The bound belongs to `drainIngest`, not to the three call sites that use it.
 *
 * `routes.ts` shipped a second Vercel drainer — `ingest_network` runs a real Overpass query, and
 * `routes.coverage` is a public procedure the planner fires on every viewport settle — with no
 * gate, for as long as the gate was something a call site had to remember. These cases are about
 * the omission, not about any one caller: a fourth entry point written tomorrow is bounded
 * whether or not its author has read `drain-slot.ts`.
 */
describe('a caller that asks for no gate at all', () => {
  it('is still refused while another process holds the slot', async () => {
    const { db, recorded } = fakeDb(1);

    const result = await drainIngest({ db, limit: 1, dedupeKeys: ['ingest_network:120230202'] });

    expect(recorded.raw.some((sql) => sql.includes(CLAIM_SQL))).toBe(false);
    expect(result.claimed).toBe(0);
  });

  it('reaches the claim when the slot is free, and only under the lock', async () => {
    const { db, recorded } = fakeDb(0);

    await drainIngest({ db, limit: 1, dedupeKeys: ['ingest_network:120230202'] });

    const locked = recorded.raw.findIndex((sql) => sql.includes('pg_advisory_xact_lock'));
    const claimed = recorded.raw.findIndex((sql) => sql.includes(CLAIM_SQL));
    expect(locked).toBeGreaterThan(-1);
    expect(claimed).toBeGreaterThan(locked);
  });

  it('honours an explicit opt-out, for the process that is its own fleet', async () => {
    const { db, recorded } = fakeDb(1);

    await drainIngest({ db, limit: 1, gate: null, dedupeKeys: ['ingest_tile:120230202'] });

    expect(recorded.raw.some((sql) => sql.includes('pg_advisory_xact_lock'))).toBe(false);
    expect(recorded.raw.some((sql) => sql.includes(CLAIM_SQL))).toBe(true);
  });
});
