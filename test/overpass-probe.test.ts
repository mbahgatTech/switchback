import { describe, expect, it } from 'vitest';
import type { OverpassQuerier, OverpassResponse } from '../packages/ingest/src/overpass';
import {
  EMPTY_ANSWER,
  intArg,
  listArg,
  probe,
  summarise,
  verdict,
  type Sample,
  type Summary,
} from '../scripts/overpass-probe';

/**
 * The probe's output is the argument for which mirror leads `DEFAULT_ENDPOINTS`, and the leader
 * decides whether a cold tile feels instant. Scoring a sample on "did not throw" rather than "sent
 * the ground back" lets a regional extract that does not carry the query win the run on speed.
 *
 * The entry guard is what makes this file possible: `main()` runs only when the script is the
 * process entry point, so importing it to reach the decision rule dispatches no live requests.
 */

const INCUMBENT = 'https://overpass-api.de/api/interpreter';
const CHALLENGER = 'https://fast.example/api/interpreter';

const GROUND: OverpassResponse = { elements: [{ type: 'way', id: 4_207_331 }] };

/** A mirror that answers every query the same way. */
function mirror(body: OverpassResponse): OverpassQuerier {
  return { query: async () => body };
}

function refusing(message: string): OverpassQuerier {
  return {
    query: async () => {
      throw new Error(message);
    },
  };
}

async function roundsAgainst(
  client: OverpassQuerier,
  endpoint: string,
  rounds: number,
): Promise<Sample[]> {
  const samples: Sample[] = [];
  for (let round = 1; round <= rounds; round++) {
    samples.push(await probe(client, endpoint, round));
  }
  return samples;
}

/** A measured incumbent to argue against: answered every round, and not instantly. */
function measured(endpoint: string, medianMs: number, ok = 3, rounds = 3): Summary {
  return { endpoint, ok, rounds, medianMs, minMs: medianMs, maxMs: medianMs };
}

describe('scoring one sample against a mirror', () => {
  it('accepts an answer that carried the ground the query asked for', async () => {
    const sample = await probe(mirror(GROUND), CHALLENGER, 1);
    expect(sample.error).toBeNull();
  });

  it('rejects a valid answer that carried no elements', async () => {
    const sample = await probe(mirror({ elements: [] }), CHALLENGER, 1);
    expect(sample.error).toBe(EMPTY_ANSWER);
  });

  /* `assertUsable` casts the parsed body rather than validating it, so a mirror can answer 200
   * with JSON carrying no `elements` key at all and nothing upstream will have noticed. */
  it('rejects a body with no elements array at all', async () => {
    const sample = await probe(mirror({} as OverpassResponse), CHALLENGER, 1);
    expect(sample.error).toBe(EMPTY_ANSWER);
  });

  it('records the reason a request failed', async () => {
    const sample = await probe(refusing('socket hang up'), CHALLENGER, 1);
    expect(sample.error).toContain('socket hang up');
  });
});

describe('what a run licenses', () => {
  /*
   * The defect this guards: an empty answer costs a mirror nothing to produce, so it is always the
   * fastest thing measured. Scored as a success it answers every round with the lowest median,
   * which is exactly the shape the reorder rule looks for.
   */
  it('refuses to promote a mirror that answers instantly with nothing', async () => {
    const samples = await roundsAgainst(mirror({ elements: [] }), CHALLENGER, 3);
    const challenger = summarise(CHALLENGER, samples, 3);

    expect(verdict([INCUMBENT, CHALLENGER], [measured(INCUMBENT, 2_400), challenger])).toContain(
      'the order stands',
    );
    expect(challenger.ok).toBe(0);
  });

  it('promotes a mirror that answered every round with the lowest median', async () => {
    const samples = await roundsAgainst(mirror(GROUND), CHALLENGER, 3);
    const challenger = { ...summarise(CHALLENGER, samples, 3), medianMs: 300 };

    expect(challenger.ok).toBe(3);
    expect(verdict([INCUMBENT, CHALLENGER], [measured(INCUMBENT, 2_400), challenger])).toContain(
      'reorder supported',
    );
  });

  it('leaves the order alone when nothing answered every round', () => {
    const patchy = measured(CHALLENGER, 90, 2);
    expect(verdict([INCUMBENT, CHALLENGER], [measured(INCUMBENT, 2_400, 1), patchy])).toContain(
      'inconclusive',
    );
  });

  it('keeps the incumbent in front on a tie', () => {
    const tied = [measured(INCUMBENT, 800), measured(CHALLENGER, 800)];
    expect(verdict([INCUMBENT, CHALLENGER], tied)).toContain('the order stands');
  });
});

describe('summarising the rounds a mirror answered', () => {
  const sample = (ms: number, error: string | null = null): Sample => ({
    endpoint: CHALLENGER,
    round: 1,
    ms,
    error,
  });

  it('medians only the rounds that answered', () => {
    const summary = summarise(CHALLENGER, [sample(500), sample(1, 'timed out'), sample(900)], 3);
    expect(summary).toMatchObject({ ok: 2, medianMs: 700, minMs: 500, maxMs: 900 });
  });

  it('averages the middle pair when an even number of rounds answered', () => {
    expect(summarise(CHALLENGER, [sample(100), sample(300)], 2).medianMs).toBe(200);
  });

  it('reports no latency for a mirror that never answered', () => {
    const summary = summarise(CHALLENGER, [sample(0, 'timed out')], 1);
    expect(summary).toMatchObject({ ok: 0, medianMs: null, minMs: null, maxMs: null });
  });
});

describe('reading the arguments', () => {
  it('takes the value after the flag', () => {
    expect(intArg('--rounds', ['node', 'probe.ts', '--rounds', '5'])).toBe(5);
  });

  it('refuses a round count that would measure nothing', () => {
    expect(() => intArg('--rounds', ['--rounds', '0'])).toThrow('positive integer');
  });

  it('falls back when the flag is absent', () => {
    expect(intArg('--rounds', ['node', 'probe.ts'])).toBeNull();
    expect(listArg('--endpoints', ['node', 'probe.ts'])).toBeNull();
  });

  it('splits an endpoint list and drops the padding', () => {
    expect(listArg('--endpoints', ['--endpoints', ' a , b ,, '])).toEqual(['a', 'b']);
  });
});
