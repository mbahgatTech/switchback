/** The end-to-end distributions, summarised. A single run of either arm decides nothing here. */

import { readFileSync } from 'node:fs';

interface Run {
  mode: string;
  totalMs: number;
  tileSourceMs: number;
  contextMs: number;
  trailsCommitted: number;
  failed: number;
  served: Record<string, number>;
}

function load(path: string): Run[] {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Run);
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

function describe(label: string, runs: Run[]) {
  const totals = runs.map((r) => r.totalMs).sort((a, b) => a - b);
  console.log(
    `${label.padEnd(28)} n=${runs.length} min=${totals[0]} median=${median(totals)} max=${totals.at(-1)}`,
  );
  console.log(
    `${''.padEnd(28)} tile median=${median(runs.map((r) => r.tileSourceMs))}` +
      ` context median=${median(runs.map((r) => r.contextMs))}`,
  );
  const trails = new Set(runs.map((r) => r.trailsCommitted));
  const softFailed = runs.filter(
    (r) => !r.served['feature:live-overpass'] && r.mode === 'live',
  ).length;
  console.log(
    `${''.padEnd(28)} trailsCommitted=${[...trails].join('/')}` +
      ` failed=${runs.reduce((a, r) => a + r.failed, 0)}` +
      (runs[0]!.mode === 'live' ? ` featureLookupSoftFailed=${softFailed}/${runs.length}` : ''),
  );
  return { totals, median: median(totals) };
}

const slice = load('scripts/tmp/e2e-slice-023010230.jsonl');
const live = load('scripts/tmp/e2e-live-023010230.jsonl');

const s = describe('slice (tile+context local)', slice);
const l = describe('live (all Overpass)', live);

const complete = live.filter((r) => r.served['feature:live-overpass']);
const lc = complete.length ? median(complete.map((r) => r.totalMs)) : NaN;

console.log('\n-- speedup, stated every way it can honestly be stated --');
console.log(`median live / median slice          ${(l.median / s.median).toFixed(2)}x`);
console.log(
  `median complete-output live / slice ${(lc / s.median).toFixed(2)}x  (n=${complete.length} live runs whose feature lookup did not soft-fail)`,
);
console.log(
  `FASTEST live / median slice         ${(l.totals[0]! / s.median).toFixed(2)}x  (most conservative)`,
);
console.log(
  `fastest live / slowest slice        ${(l.totals[0]! / s.totals.at(-1)!).toFixed(2)}x  (worst-case pairing, not an estimator)`,
);
