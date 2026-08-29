import { describe, expect, it } from 'vitest';
import { ungatedCallSites } from './query-gates';
import type { Source } from './sources';

/**
 * The gate this feeds is the only thing standing between a signed-out mount and a 401, so its
 * own reading of `enabled` is pinned here. Every case is a spelling that got past the string
 * test this replaced.
 */

const QUERIES = ['me.get'];
const sitesIn = (body: string) => ungatedCallSites([['screen.tsx', body]] as Source[], QUERIES);

describe('an account-scoped query asked on mount', () => {
  it('is gated when its `enabled` names the reader', () => {
    expect(
      sitesIn('const me = useQuery({ ...trpc.me.get.queryOptions(), enabled: signedIn });'),
    ).toEqual([]);
    expect(
      sitesIn(
        [
          'const me = useQuery({',
          '  ...trpc.me.get.queryOptions(),',
          "  enabled: status === 'signedIn',",
          '});',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('is ungated when the options carry no `enabled` at all', () => {
    expect(sitesIn('const me = useQuery(trpc.me.get.queryOptions());')).toEqual([
      'screen.tsx: me.get',
    ]);
  });

  /*
   * The shape this rule was rewritten for. `enabled: true` is written exactly like a gate and
   * fires exactly like no gate, and the string test it replaced saw only the missing brace.
   */
  it('is ungated when the `enabled` it was given is a constant', () => {
    expect(
      sitesIn('const me = useQuery({ ...trpc.me.get.queryOptions(), enabled: true });'),
    ).toEqual(['screen.tsx: me.get']);
  });

  /*
   * A fetch behind a press is not a mount-time ask — the reader is already known by the time a
   * finger lands on it — so it needs no gate and must not be reported as missing one.
   */
  it('is not a call site at all when it is fetched on a press', () => {
    expect(
      sitesIn('const doc = await queryClient.fetchQuery(trpc.me.get.queryOptions());'),
    ).toEqual([]);
  });

  it('reports each call site in a file, not just the first', () => {
    const twice = [
      'const me = useQuery(trpc.me.get.queryOptions());',
      'const also = useQuery({ ...trpc.me.get.queryOptions(), enabled: true });',
    ].join('\n');

    expect(sitesIn(twice)).toHaveLength(2);
  });
});
