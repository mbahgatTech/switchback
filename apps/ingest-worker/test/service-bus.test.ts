import { describe, expect, it, vi } from 'vitest';
import type { ServiceBusReceivedMessage } from '@azure/service-bus';

/**
 * One receiver per `createReceiver` call, so a test can tell a reused link from a fresh one —
 * which is the whole of the faulted-link assertion below.
 */
const receivers: Array<{
  receiveMessages: ReturnType<typeof vi.fn>;
  completeMessage: ReturnType<typeof vi.fn>;
}> = [];

const createReceiver = vi.fn(() => {
  const receiver = {
    receiveMessages: vi.fn(async () => []),
    completeMessage: vi.fn(async () => {}),
  };
  receivers.push(receiver);
  return receiver;
});

vi.mock('@azure/identity', () => ({ DefaultAzureCredential: class {} }));
vi.mock('@azure/service-bus', () => ({
  ServiceBusClient: class {
    createReceiver = createReceiver;
    createSender = vi.fn();
  },
}));

process.env.ServiceBusConnection__fullyQualifiedNamespace = 'sb-test.servicebus.windows.net';

const { readDedupeKey } = await import('../src/service-bus');

/** A received message carrying whatever body and id a test wants to put on the wire. */
function received(body: unknown, messageId?: unknown): ServiceBusReceivedMessage {
  return { body, messageId } as unknown as ServiceBusReceivedMessage;
}

describe('reading the job a dead-lettered message names', () => {
  it('takes the key from the body when the body is readable', () => {
    expect(readDedupeKey(received({ dedupeKey: 'ingest_tile:0213012' }))).toBe(
      'ingest_tile:0213012',
    );
  });

  it('falls back to messageId when the body is not readable', () => {
    /*
     * `toMessage` sets the two equal, so the id is a second independent copy of the identity —
     * and it survives the case the body does not: a body-shape change across a deploy, which
     * would otherwise make every message already in the queue unidentifiable.
     */
    expect(readDedupeKey(received('not json at all', 'ingest_tile:0213012'))).toBe(
      'ingest_tile:0213012',
    );
  });

  it('refuses a messageId whose kind this estate does not write', () => {
    /*
     * The trust boundary. `messageId` is a broker field any publisher can set to anything, and a
     * foreign id taken as-is would be looked up, found missing, and filed as a job already
     * finished — reporting someone else's message as work this queue had completed.
     */
    expect(readDedupeKey(received(undefined, 'someone-elses-system:42'))).toBeNull();
    expect(readDedupeKey(received(undefined, 'ingest_tile'))).toBeNull();
  });

  it('reads a body the host handed back as a JSON string', () => {
    expect(readDedupeKey(received('{"dedupeKey":"enrich_trail:way/9"}'))).toBe(
      'enrich_trail:way/9',
    );
  });

  it('is null when neither half carries a usable key', () => {
    // A fact about the message rather than an error to raise — the reconciler files it unreadable.
    expect(readDedupeKey(received(undefined, undefined))).toBeNull();
    expect(readDedupeKey(received({ dedupeKey: '' }, 12345))).toBeNull();
  });
});

describe('the dead-letter receiver', () => {
  /**
   * A fresh module per test, because the receiver is cached at module scope for the life of the
   * process — which is exactly the lifetime the faulted-link reset exists to cut short.
   */
  async function freshQueue() {
    receivers.length = 0;
    createReceiver.mockClear();
    vi.resetModules();
    const { deadLetterQueue: fresh } = await import('../src/service-bus');
    return fresh();
  }

  it('reuses one link across ticks while it is healthy', async () => {
    const queue = await freshQueue();
    await queue.receive(10);
    await queue.receive(10);

    expect(createReceiver).toHaveBeenCalledTimes(1);
  });

  it('drops a faulted link so the next tick opens a fresh one', async () => {
    /*
     * A link that has faulted stays faulted and this one is cached for the life of the process,
     * so keeping it would silence the drain until the host recycled — the exact failure the
     * dead-letter reconciler exists to prevent.
     */
    const queue = await freshQueue();
    await queue.receive(10);
    receivers[0]?.receiveMessages.mockRejectedValueOnce(new Error('link detached'));

    await expect(queue.receive(10)).rejects.toThrow('link detached');
    await queue.receive(10);

    expect(createReceiver).toHaveBeenCalledTimes(2);
  });

  it('hands the reconciler a completer bound to the message it came with', async () => {
    const queue = await freshQueue();
    await queue.receive(10); // opens the lazy receiver, so there is one to program
    const message = {
      body: { dedupeKey: 'ingest_tile:0213012' },
      deadLetterReason: 'MaxDeliveryCountExceeded',
    };
    receivers[0]?.receiveMessages.mockResolvedValueOnce([message]);

    const [letter] = await queue.receive(10);
    await letter?.complete();

    expect(letter?.dedupeKey).toBe('ingest_tile:0213012');
    expect(letter?.reason).toBe('MaxDeliveryCountExceeded');
    expect(receivers[0]?.completeMessage).toHaveBeenCalledWith(message);
  });
});
