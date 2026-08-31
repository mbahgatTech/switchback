import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EMPTY_WRITE_WINDOW_MS } from '@switchback/ingest';

/**
 * The span the empty-write share is read over, against the line that publishes it.
 *
 * `infra/azure/ingest.bicep` tells the operator the share covers "the trailing day", and the
 * constant below is what an unwindowed `readEmptyWriteRates` actually reads — which is the only
 * call production makes. Nothing else holds the two together.
 */

const A_DAY_MS = 24 * 60 * 60 * 1000;

describe('the empty-write window', () => {
  it('is the span the deployed alert publishes', () => {
    const bicep = readFileSync(
      fileURLToPath(new URL('../infra/azure/ingest.bicep', import.meta.url)),
      'utf8',
    );

    expect(bicep).toContain("source's tile writes over the trailing day");
    expect(EMPTY_WRITE_WINDOW_MS).toBe(A_DAY_MS);
  });
});
