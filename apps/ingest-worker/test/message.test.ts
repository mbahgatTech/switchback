import { describe, expect, it } from 'vitest';
import { parseIngestSignal } from '../src/message';

describe('parseIngestSignal', () => {
  it('reads a body the host already parsed', () => {
    expect(parseIngestSignal({ dedupeKey: 'ingest_tile:021231321' })).toEqual({
      dedupeKey: 'ingest_tile:021231321',
    });
  });

  it('reads a body left as a raw string', () => {
    expect(parseIngestSignal('{"dedupeKey":"ingest_tile:021231321"}')).toEqual({
      dedupeKey: 'ingest_tile:021231321',
    });
  });

  it.each([
    ['not JSON', 'ingest_tile:021231321'],
    ['null', null],
    ['a number', 7],
    ['an object with no key', { kind: 'ingest_tile' }],
    ['an empty key', { dedupeKey: '' }],
    ['a non-string key', { dedupeKey: 12 }],
  ])('rejects %s', (_label, body) => {
    // Rejecting is what dead-letters the message: none of these becomes readable on a retry,
    // and completing one would leave a job queued with nothing to wake it.
    expect(() => parseIngestSignal(body)).toThrow();
  });
});
