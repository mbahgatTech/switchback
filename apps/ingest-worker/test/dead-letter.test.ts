import { describe, expect, it, vi } from 'vitest';
import { JobStatus } from '@switchback/db';
import type { PrismaClient } from '@switchback/db';
import { DEAD_LETTER_MARKER, reconcileDeadLetters } from '../src/dead-letter';
import type { DeadLetter, DeadLetterQueue } from '../src/dead-letter';

/** A message, and the record of whether the reconciler settled it. */
function message(dedupeKey: string | null): DeadLetter & { completed: boolean } {
  const entry = {
    dedupeKey,
    reason: 'MaxDeliveryCountExceeded',
    completed: false,
    complete: async () => {
      entry.completed = true;
    },
  };
  return entry;
}

function queueOf(...messages: DeadLetter[]): DeadLetterQueue {
  return { receive: async (max: number) => messages.slice(0, max) };
}

/** `db.ingestJob.findMany` over a fixed set of rows, or a client that cannot be reached. */
function fakeDb(rows: Array<{ dedupeKey: string; status: JobStatus }>): PrismaClient {
  return {
    ingestJob: {
      findMany: async ({ where }: { where: { dedupeKey: { in: string[] } } }) =>
        rows.filter((row) => where.dedupeKey.in.includes(row.dedupeKey)),
    },
  } as unknown as PrismaClient;
}

const unreachable = {
  ingestJob: {
    findMany: async () => {
      throw new Error("Can't reach database server at postgres:5432");
    },
  },
} as unknown as PrismaClient;

function fakeLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/**
 * A message that records the order it was settled in, against a shared counter the log shares —
 * which is the only way to observe that the report is written before anything is completed.
 */
function ordered(dedupeKey: string, tick: { n: number }) {
  const entry = {
    dedupeKey,
    reason: 'MaxDeliveryCountExceeded',
    completedAt: 0,
    complete: async () => {
      tick.n += 1;
      entry.completedAt = tick.n;
    },
  };
  return entry;
}

describe('draining the dead-letter queue', () => {
  it('drops a message whose job row is still runnable, because the pump republishes it', async () => {
    // `running` counts as runnable too: a lease is held or the reaper will take it back, and
    // either way something other than this message carries the work.
    const waiting = message('ingest_tile:queued');
    const held = message('ingest_tile:running');
    const log = fakeLog();

    const report = await reconcileDeadLetters(
      fakeDb([
        { dedupeKey: 'ingest_tile:queued', status: JobStatus.queued },
        { dedupeKey: 'ingest_tile:running', status: JobStatus.running },
      ]),
      queueOf(waiting, held),
      log,
    );

    expect(report.runnable).toEqual(['ingest_tile:queued', 'ingest_tile:running']);
    expect([waiting, held].every((entry) => entry.completed)).toBe(true);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining(DEAD_LETTER_MARKER));
  });

  it('drops a message whose work is already finished, buried, or collected', async () => {
    const done = message('ingest_tile:done');
    const buried = message('ingest_tile:buried');
    const gone = message('ingest_tile:gone');

    const report = await reconcileDeadLetters(
      fakeDb([
        { dedupeKey: 'ingest_tile:done', status: JobStatus.done },
        { dedupeKey: 'ingest_tile:buried', status: JobStatus.dead },
      ]),
      queueOf(done, buried, gone),
      fakeLog(),
    );

    expect(report.terminal).toEqual(['ingest_tile:done', 'ingest_tile:buried', 'ingest_tile:gone']);
    expect([done, buried, gone].every((entry) => entry.completed)).toBe(true);
  });

  it('drops a message that names no job at all, and says why in the log', async () => {
    const nonsense = message(null);
    const log = fakeLog();

    const report = await reconcileDeadLetters(fakeDb([]), queueOf(nonsense), log);

    expect(report.unreadable).toEqual(['MaxDeliveryCountExceeded']);
    expect(nonsense.completed).toBe(true);
  });

  it('settles nothing when the database it must consult cannot be read', async () => {
    // The condition that dead-letters a message in the first place. Deleting one it could not
    // evaluate is the only way this loses work.
    const dead = message('ingest_tile:0213012');

    await expect(reconcileDeadLetters(unreachable, queueOf(dead), fakeLog())).rejects.toThrow(
      /reach database server/,
    );
    expect(dead.completed).toBe(false);
  });

  it('says nothing on an empty queue, which is the ordinary reading', async () => {
    const log = fakeLog();

    const report = await reconcileDeadLetters(fakeDb([]), queueOf(), log);

    expect(report).toEqual({ runnable: [], terminal: [], unreadable: [] });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('writes the report before it settles anything', async () => {
    /*
     * The ordering is a deliberate trade, not an accident of layout: a process that dies between
     * the two leaves the messages locked, and the next tick reports them again — a duplicate line
     * rather than the loss of the only record that a fault happened. Settling first would make the
     * crash silent.
     */
    const tick = { n: 0 };
    const messages = [ordered('ingest_tile:a', tick), ordered('ingest_tile:b', tick)];
    const log = fakeLog();
    log.warn.mockImplementation(() => {
      tick.n += 1;
    });

    await reconcileDeadLetters(fakeDb([]), queueOf(...messages), log, 10);

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(messages.map((entry) => entry.completedAt)).toEqual([2, 3]);
  });

  it('bounds the batch it takes off the queue', async () => {
    const messages = Array.from({ length: 5 }, (_, index) => message(`ingest_tile:${index}`));

    const report = await reconcileDeadLetters(fakeDb([]), queueOf(...messages), fakeLog(), 2);

    expect(report.terminal).toHaveLength(2);
    expect(messages.filter((entry) => entry.completed)).toHaveLength(2);
  });
});
