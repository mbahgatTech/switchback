import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BUCKET_CAPACITY,
  ESTATE_DRAIN_TILES_PER_HOUR,
  MAX_AREA_TILES,
  MAX_QUEUE_WAIT_HOURS,
  MAX_TILE_QUEUE_DEPTH,
  PRINCIPAL_QUEUE_SHARE,
  PRINCIPAL_TILES_PER_HOUR,
  REQUEST_DRAIN_TILES_PER_HOUR,
  REVIVAL_OUTSTANDING_MAX,
  hoursToDrain,
} from '@switchback/ingest';

/**
 * The ceiling is derived, but prose, SQL and runbooks restate it as literals — and a restatement
 * nothing checks is the exact defect this constant already suffered once.
 *
 * **Every expected figure is computed, never written down.** A literal here would agree with a
 * stale document instead of with the code, which reproduces the bug this file exists to catch.
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

/** The depth below which the per-caller allowance stops being a share — see `MAX_QUEUE_WAIT_HOURS`. */
const floorJobs = MAX_AREA_TILES / PRINCIPAL_QUEUE_SHARE;

describe('documents that restate the derived ceiling', () => {
  it('carries the live ceiling everywhere the metrics SQL hard-codes it', () => {
    // The script states its assumptions rather than reading them, deliberately — the database does
    // not know the constant. That is only safe while something checks the statement.
    const sql = read('scripts/ingest-metrics/04-queue-depth.sql');

    expect(countNumber(sql, MAX_TILE_QUEUE_DEPTH)).toBeGreaterThanOrEqual(9);
    expect(sql).toContain(`hours_the_${ceiling}_ceiling_buys`);
    expect(sql).toContain(`\`MAX_QUEUE_WAIT_HOURS\` (${horizon})`);
    expect(sql).toContain(`${REQUEST_DRAIN_TILES_PER_HOUR} request-kind`);
  });

  it('carries the live ceiling and drain rate in the metrics runbook', () => {
    const readme = read('scripts/ingest-metrics/README.md');

    expect(readme).toContain(`compares to ${ceiling}`);
    expect(readme).toContain(`the ${ceiling} ceiling`);
    expect(readme).toContain(`${horizon} h at ${REQUEST_DRAIN_TILES_PER_HOUR}`);
    expect(countNumber(readme, ESTATE_DRAIN_TILES_PER_HOUR)).toBeGreaterThanOrEqual(1);
  });

  it('carries every figure the architecture record restates, including the derived ones', () => {
    /*
     * The diagram and the two paragraphs under it name ten numbers, seven of which are consequences
     * of constants a reader can change. `PRINCIPAL_QUEUE_SHARE` is the one that moves the most of
     * them at once and touches this ceiling only through `rate-limit.ts`, so it is the change most
     * able to leave this section quietly wrong.
     */
    const architecture = read('docs/architecture.md');

    expect(architecture).toContain(`${horizon} hours at\n${REQUEST_DRAIN_TILES_PER_HOUR}`);
    expect(countNumber(architecture, MAX_TILE_QUEUE_DEPTH)).toBeGreaterThanOrEqual(1);

    expect(architecture).toContain(`ESTATE_DRAIN_TILES_PER_HOUR = ${ESTATE_DRAIN_TILES_PER_HOUR}`);
    expect(architecture).toContain(
      `REQUEST_DRAIN_TILES_PER_HOUR = ${REQUEST_DRAIN_TILES_PER_HOUR}`,
    );
    expect(architecture).toContain(`MAX_QUEUE_WAIT_HOURS = ${MAX_QUEUE_WAIT_HOURS}`);
    expect(architecture).toContain(`MAX_TILE_QUEUE_DEPTH = ${MAX_TILE_QUEUE_DEPTH}`);
    expect(architecture).toContain(`BUCKET_CAPACITY = ${BUCKET_CAPACITY}`);
    expect(architecture).toContain(`PRINCIPAL_TILES_PER_HOUR = ${PRINCIPAL_TILES_PER_HOUR}`);
    expect(architecture).toContain(`REVIVAL_OUTSTANDING_MAX = ${REVIVAL_OUTSTANDING_MAX}`);
    expect(architecture).toContain(`MAX_AREA_TILES = ${MAX_AREA_TILES} = ${areaHours} h`);

    // The floor, and what it is worth in hours — the pair the horizon has to sit above.
    expect(architecture).toContain(
      `${floorJobs} jobs, or ${hoursToDrain(floorJobs).toFixed(1)} hours`,
    );
    expect(architecture).toContain(
      `${MAX_AREA_TILES} tiles, which at a serial drain is ${areaHours} hours`,
    );
  });

  it('carries the live cost of one area fetch where the area cap is defined', () => {
    // `coverage.ts` names this in hours to justify being the floor under the horizon; if the drain
    // rate moves, that justification moves with it.
    expect(read('packages/ingest/src/coverage.ts')).toContain(`${areaHours} hours of`);
  });
});
