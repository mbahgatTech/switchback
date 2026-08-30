/**
 * Per-endpoint Overpass latency, measured rather than assumed. `DEFAULT_ENDPOINTS` is ordered by
 * reachability and the first entry decides whether a cold tile feels instant; this is what a
 * proposed reorder has to be argued from.
 *
 * Run it from a GitHub-hosted runner. A workstation is the wrong vantage point — production is
 * Azure, and the mirror that is unreachable from a home network is not the one that is slow from a
 * data centre. `.github/workflows/overpass-probe.yml` dispatches it.
 *
 *   OVERPASS_USER_AGENT='...' npx tsx scripts/overpass-probe.ts --rounds 3
 *
 * Etiquette is why this is shaped the way it is: one request in flight across the whole run, one
 * attempt per sample so a retry cannot be mistaken for the endpoint being slow, a pause between
 * samples, and a query small enough that the answer is dispatch latency rather than transfer.
 * Three endpoints over three rounds is nine requests.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OverpassClient,
  type OverpassQuerier,
  type OverpassResponse,
} from '../packages/ingest/src/overpass';

/**
 * A handful of paths in a tenth of a degree of Seattle. Deliberately trivial: what separates these
 * mirrors is whether they answer and how quickly they dispatch, not how fast they can stream a
 * megabyte, and a heavy probe query would spend a stranger's CPU to learn less.
 */
const PROBE_QL = '[out:json][timeout:25];way(47.60,-122.34,47.61,-122.33)["highway"];out ids 5;';

/** Long enough for a mirror that is merely busy, short enough that a dead one is not the whole run. */
const REQUEST_TIMEOUT_MS = 30_000;

/** Between samples. Sequential requests are already inside the concurrency ceiling; this is manners. */
const PAUSE_MS = 2_000;

/** One endpoint, one round. `error` is null only for an answer that carried ground. */
export interface Sample {
  endpoint: string;
  round: number;
  ms: number;
  error: string | null;
}

export interface Summary {
  endpoint: string;
  ok: number;
  rounds: number;
  medianMs: number | null;
  minMs: number | null;
  maxMs: number | null;
}

async function main(): Promise<void> {
  const userAgent = process.env.OVERPASS_USER_AGENT ?? '';
  const rounds = intArg('--rounds', process.argv) ?? 3;
  const endpoints = listArg('--endpoints', process.argv) ?? configuredEndpoints(userAgent);

  console.log(`rounds ${String(rounds)}`);
  console.log(`query  ${PROBE_QL}`);
  endpoints.forEach((endpoint, index) => {
    console.log(`order  ${String(index + 1)} ${endpoint}`);
  });
  console.log('');

  const samples = await measure(endpoints, rounds, userAgent);
  const summaries = endpoints.map((endpoint) => summarise(endpoint, samples, rounds));

  console.log('');
  for (const summary of summaries) {
    const median = summary.medianMs === null ? 'none' : String(summary.medianMs);
    const min = summary.minMs === null ? 'none' : String(summary.minMs);
    const max = summary.maxMs === null ? 'none' : String(summary.maxMs);
    console.log(
      `summary endpoint=${summary.endpoint} ok=${String(summary.ok)}/${String(summary.rounds)} ` +
        `median_ms=${median} min_ms=${min} max_ms=${max}`,
    );
  }

  console.log('');
  console.log(`VERDICT ${verdict(endpoints, summaries)}`);
}

/** One request per endpoint per round, strictly one at a time, rounds interleaved across mirrors so
 * a slow minute on the service lands on all three rather than on whichever went first. */
async function measure(
  endpoints: readonly string[],
  rounds: number,
  userAgent: string,
): Promise<Sample[]> {
  const samples: Sample[] = [];
  let first = true;

  for (let round = 1; round <= rounds; round++) {
    for (const endpoint of endpoints) {
      if (!first) await sleep(PAUSE_MS);
      first = false;

      const sample = await probe(probeClient(endpoint, userAgent), endpoint, round);
      samples.push(sample);
      console.log(
        `sample endpoint=${endpoint} round=${String(round)} ms=${String(sample.ms)} ` +
          (sample.error === null ? 'outcome=ok' : `outcome=fail detail="${sample.error}"`),
      );
    }
  }

  return samples;
}

/**
 * One attempt, one endpoint, no failover. `maxAttempts: 1` is what makes the number a measurement:
 * on the deployed settings a 504 would be retried against the next mirror and the elapsed time
 * would describe the ladder rather than this host.
 *
 * A client per *sample*, not per endpoint, so the breaker never carries state between rounds. Held
 * across rounds it opens on the fifth consecutive failure and every later round of a mirror that is
 * simply down reports `circuit breaker open` in microseconds — a run that says the endpoint failed
 * for a reason the endpoint never gave.
 */
function probeClient(endpoint: string, userAgent: string): OverpassClient {
  return new OverpassClient({
    url: [endpoint],
    userAgent,
    maxConcurrent: 1,
    maxAttempts: 1,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    maxTotalMs: REQUEST_TIMEOUT_MS,
  });
}

/**
 * An answer carrying no elements is recorded as a failure rather than as the fastest sample in the
 * run. `assertUsable` accepts any JSON body without a failure remark, so a mirror serving a
 * regional extract that excludes the probe bbox answers `{elements: []}` in milliseconds — which
 * would otherwise read as the best mirror measured, from the one that cannot serve the query.
 */
export async function probe(
  client: OverpassQuerier,
  endpoint: string,
  round: number,
): Promise<Sample> {
  const startedAt = Date.now();
  try {
    const body = await client.query(PROBE_QL);
    const ms = Date.now() - startedAt;
    return { endpoint, round, ms, error: carriedGround(body) ? null : EMPTY_ANSWER };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      endpoint,
      round,
      ms: Date.now() - startedAt,
      error: message.replace(/\s+/g, ' ').slice(0, 160),
    };
  }
}

/** Recorded against a mirror that answered but carried nothing for the probe bbox. */
export const EMPTY_ANSWER = 'answered with no elements';

/** `elements` is cast from the wire rather than parsed, so an absent array is reachable here. */
function carriedGround(body: OverpassResponse): boolean {
  return Array.isArray(body.elements) && body.elements.length > 0;
}

/** Medians over the rounds that answered. A failed round has no latency to average in — it is
 * counted in `ok` instead, where it belongs. */
export function summarise(endpoint: string, samples: readonly Sample[], rounds: number): Summary {
  const good = samples
    .filter((sample) => sample.endpoint === endpoint && sample.error === null)
    .map((sample) => sample.ms)
    .sort((a, b) => a - b);

  return {
    endpoint,
    ok: good.length,
    rounds,
    medianMs: median(good),
    minMs: good[0] ?? null,
    maxMs: good[good.length - 1] ?? null,
  };
}

function median(sorted: readonly number[]): number | null {
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? null;
  const low = sorted[middle - 1] ?? 0;
  const high = sorted[middle] ?? 0;
  return Math.round((low + high) / 2);
}

/**
 * What the run does or does not license. A reorder needs an endpoint that answered *every* round —
 * a fast median over one lucky sample out of three is the failure this is meant to catch, not
 * evidence — and the incumbent keeps its place on a tie.
 */
export function verdict(endpoints: readonly string[], summaries: readonly Summary[]): string {
  const incumbent = endpoints[0];
  if (incumbent === undefined) return 'nothing to probe — no endpoints given.';

  const perfect = summaries.filter((s) => s.ok === s.rounds && s.medianMs !== null);
  if (perfect.length === 0) {
    return 'inconclusive — no endpoint answered every round. The order stands.';
  }

  const best = perfect.reduce((a, b) => ((a.medianMs ?? 0) <= (b.medianMs ?? 0) ? a : b));
  const stated = `${best.endpoint} has the lowest median at ${String(best.medianMs)} ms over ${String(best.ok)}/${String(best.rounds)} rounds`;

  if (best.endpoint === incumbent) return `the order stands — ${stated}, and it already leads.`;
  return `reorder supported — ${stated}; ${incumbent} currently leads.`;
}

/**
 * The built-in `DEFAULT_ENDPOINTS`, in their deployed order, read through the client rather than
 * copied. `OVERPASS_URL` is deliberately not consulted — a deployment that overrides the list would
 * silently turn this into a probe of something other than the order it is arguing about. Pass
 * `--endpoints` to measure a candidate mirror.
 */
function configuredEndpoints(userAgent: string): readonly string[] {
  return new OverpassClient({ userAgent }).mirrors;
}

export function intArg(flag: string, argv: readonly string[]): number | null {
  const value = argValue(flag, argv);
  if (value === null) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${flag} takes a positive integer`);
  return parsed;
}

export function listArg(flag: string, argv: readonly string[]): readonly string[] | null {
  const value = argValue(flag, argv);
  if (value === null) return null;
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return entries.length > 0 ? entries : null;
}

function argValue(flag: string, argv: readonly string[]): string | null {
  const index = argv.indexOf(flag);
  return index === -1 ? null : (argv[index + 1] ?? null);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
