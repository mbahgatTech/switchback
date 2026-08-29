import { describe, expect, it } from 'vitest';
import { drawsOverHeldData, screenReplacingBranches } from './screen-branches';
import type { Source } from './sources';

/**
 * The scanner in `conventions.test.ts` is the whole defence for nine of the ten screens it
 * covers, so its own edge cases are pinned here rather than left to whatever the app happens to
 * contain today. Each case below is a shape that got past an earlier version of it.
 */

const sourceOf = (body: string): Source[] => [['screen.tsx', body]];
const testsOf = (body: string) => screenReplacingBranches(sourceOf(body)).map(({ test }) => test);
const caught = (body: string) => screenReplacingBranches(sourceOf(body)).filter(drawsOverHeldData);

describe('the guard a screen opens with', () => {
  it('is read off one line', () => {
    expect(testsOf(['  if (!trail) {', '    return (', '      <Chrome />'].join('\n'))).toEqual([
      '!trail',
    ]);
  });

  it('is read back whole when Prettier wrapped it past the print width', () => {
    const wrapped = [
      '  if (',
      '    query.isError ||',
      '    !trail ||',
      '    reviews.isError',
      '  ) {',
      '    return (',
    ].join('\n');

    expect(testsOf(wrapped)).toEqual(['query.isError || !trail || reviews.isError']);
  });

  /*
   * Prettier's own output for a callback whose parameter list wraps puts a bare `) {` *inside*
   * the condition. Taking the first of those as the terminator drops every clause after it —
   * here, the only one that matters — so the closer is anchored to the `if`'s indentation.
   */
  it('is not cut short by a brace opened inside a nested call', () => {
    const nested = [
      '  if (',
      '    trails.some(',
      '      function (',
      '        candidate,',
      '        index,',
      '        all,',
      '      ) {',
      '        return candidate.stale;',
      '      },',
      '    ) ||',
      '    query.isError',
      '  ) {',
      '    return (',
    ].join('\n');

    expect(caught(nested)).toHaveLength(1);
  });

  it('is not a branch at all unless it returns a screen', () => {
    expect(testsOf(['  if (query.isError) {', '    refetch();'].join('\n'))).toEqual([]);
  });
});

describe('the arms a render ternary falls to', () => {
  const chain = (opener: string) =>
    [
      `      {${opener} ? (`,
      '        <Text>Reading…</Text>',
      '      ) : list.isError ? (',
      '        <Text>Failed</Text>',
      '      ) : (',
    ].join('\n');

  it('are found under either spelling of the pending arm', () => {
    expect(caught(chain('list.isPending'))).toHaveLength(1);
    expect(caught(chain("list.status === 'pending'"))).toHaveLength(1);
  });

  it('are followed past the first, because the failure copy need not be next', () => {
    const late = [
      '      {list.isPending ? (',
      '        <Text>Reading…</Text>',
      '      ) : reviews.length === 0 ? (',
      '        <Text>Nothing yet</Text>',
      '      ) : list.isError ? (',
      '        <Text>Failed</Text>',
      '      ) : (',
    ].join('\n');

    expect(testsOf(late)).toEqual(['reviews.length === 0', 'list.isError']);
  });

  /*
   * `saved.tsx` opens on the auth status and closes `) : null}`, which puts a message *beside*
   * the content rather than in place of it — and is right to read the error flag.
   */
  it('are left alone when the ternary does not open on pending', () => {
    expect(testsOf(chain("status === 'signedOut'"))).toEqual([]);
  });

  it('do not reach into a ternary nested inside an arm', () => {
    const nested = [
      '      {list.isPending ? (',
      '        <Text>Reading…</Text>',
      '      ) : (',
      '        {inner.isPending ? (',
      '          <Text>Inner</Text>',
      '        ) : inner.isError ? (',
      '          <Text>Failed</Text>',
      '        ) : null}',
      '      )}',
    ].join('\n');

    expect(testsOf(nested)).toEqual(['inner.isError']);
  });
});

describe('the flags that are true while the answer is still held', () => {
  const branchOn = (test: string) => ({ at: 'screen.tsx:1', test, shape: 'guard' as const });

  it('are caught however they are spelled', () => {
    expect(drawsOverHeldData(branchOn('query.isError'))).toBe(true);
    expect(drawsOverHeldData(branchOn("query.status === 'error'"))).toBe(true);
    expect(drawsOverHeldData(branchOn('query.isRefetchError'))).toBe(true);
  });

  /*
   * `isLoadingError` is an error with nothing behind it, so a branch reading it has no content
   * to draw over. Four shipped screens depend on it staying out of this set.
   */
  it('do not include the error that has nothing behind it', () => {
    expect(drawsOverHeldData(branchOn('list.isLoadingError'))).toBe(false);
    expect(drawsOverHeldData(branchOn('!trail'))).toBe(false);
    expect(drawsOverHeldData(branchOn('!me.data || !stats.data'))).toBe(false);
  });
});
