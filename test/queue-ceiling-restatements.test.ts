import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MAX_QUEUE_WAIT_HOURS, MAX_TILE_QUEUE_DEPTH } from '@switchback/ingest';
import { MAX_AREA_TILES, REQUEST_DRAIN_TILES_PER_HOUR, hoursToDrain } from '@switchback/ingest';

/**
 * The ceiling is derived, but prose, SQL and runbooks restate it as literals — and a restatement
 * nothing checks is the exact defect this constant already suffered once. Every figure below is
 * computed from the live constants, so raising throughput or the horizon reds every document that
 * still carries the old number instead of leaving them quietly wrong.
 */

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (relative: string): string => readFileSync(join(REPO_ROOT, relative), 'utf8');

/** Occurrences of `needle` as a standalone number, so `513` does not match inside `5130`. */
function countNumber(haystack: string, needle: number): number {
  return haystack.match(new RegExp(`(?<![0-9.])${needle}(?![0-9.])`, 'g'))?.length ?? 0;
}

const ceiling = String(MAX_TILE_QUEUE_DEPTH);
const horizon = String(MAX_QUEUE_WAIT_HOURS);
const areaHours = hoursToDrain(MAX_AREA_TILES).toFixed(1);

describe('documents that restate the derived ceiling', () => {
  it('carries the live ceiling everywhere the metrics SQL hard-codes it', () => {
    // The script states its assumptions rather than reading them, deliberately — the database does
    // not know the constant. That is only safe while something checks the statement.
    const sql = read('scripts/ingest-metrics/04-queue-depth.sql');

    expect(countNumber(sql, MAX_TILE_QUEUE_DEPTH)).toBeGreaterThanOrEqual(9);
    expect(sql).toContain(`hours_the_${ceiling}_ceiling_buys`);
    expect(sql).toContain(`\`MAX_QUEUE_WAIT_HOURS\` (${horizon})`);
  });

  it('carries the live ceiling and drain rate in the metrics runbook', () => {
    const readme = read('scripts/ingest-metrics/README.md');

    expect(readme).toContain(`compares to ${ceiling}`);
    expect(readme).toContain(`the ${ceiling} ceiling`);
    expect(readme).toContain(String(REQUEST_DRAIN_TILES_PER_HOUR));
  });

  it('carries the live horizon and floor in the architecture record', () => {
    const architecture = read('docs/architecture.md');

    expect(architecture).toContain(`${horizon} hours`);
    expect(architecture).toContain(ceiling);
    // The floor the horizon sits above, restated in prose two paragraphs from the number it bounds.
    expect(architecture).toContain(`${MAX_AREA_TILES / 0.2}`);
  });

  it('carries the live cost of one area fetch where the area cap is defined', () => {
    // `coverage.ts` names this in hours to justify being the floor under the horizon; if the drain
    // rate moves, that justification moves with it.
    expect(read('packages/ingest/src/coverage.ts')).toContain(`${areaHours} hours of`);
  });
});
