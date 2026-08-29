import type { Source } from './sources';

/**
 * Reading the `enabled` an account-scoped query was actually given at each call site.
 *
 * The rule this feeds used to test for the string `useQuery(trpc.X.queryOptions(` — the ungated
 * spelling. That caught a deleted gate but not a neutered one: `enabled: true` is written in the
 * gated shape and gates nothing, and the suite stayed green through it.
 */

/** The `useQuery(...)` call that encloses `at`, from its name to its closing paren. */
function enclosingUseQuery(source: string, at: number): string | null {
  const opens = source.lastIndexOf('useQuery(', at);
  if (opens === -1) return null;

  let depth = 0;
  for (let i = opens + 'useQuery'.length; i < source.length; i += 1) {
    if (source[i] === '(') depth += 1;
    else if (source[i] === ')') {
      depth -= 1;
      if (depth === 0) return i > at ? source.slice(opens, i + 1) : null;
    }
  }
  return null;
}

/**
 * Whether an `enabled` value depends on anything. `enabled: true` names nothing, so it is the
 * ungated call written in the gated shape; `signedIn` or `status === 'signedIn'` name a reader.
 */
function gatesOnSomething(value: string): boolean {
  const names = value.replace(/'[^']*'/gu, '').match(/[A-Za-z_$][\w$]*/gu) ?? [];
  return names.some((name) => name !== 'true');
}

/**
 * Every `file: query` where an account-scoped query is asked with no `enabled`, or with one that
 * is a constant. Call sites that are not `useQuery` — a `fetchQuery` behind a press — are not
 * mount-time asks and are left alone.
 *
 * The boundary: this reads the first `enabled` in the call, so a gate passed to `queryOptions`
 * as a second argument would be read in place of one on the outer options. No account-scoped
 * query is written that way today, and a call carrying both would need reading by hand.
 */
export function ungatedCallSites(files: Source[], queries: string[]): string[] {
  const sites: string[] = [];

  for (const [file, source] of files) {
    for (const query of queries) {
      const needle = `trpc.${query}.queryOptions(`;
      for (let at = source.indexOf(needle); at !== -1; at = source.indexOf(needle, at + 1)) {
        const call = enclosingUseQuery(source, at);
        if (call === null) continue;
        const enabled = /\benabled:\s*([^,\n}]+)/u.exec(call)?.[1]?.trim();
        if (enabled === undefined || !gatesOnSomething(enabled)) sites.push(`${file}: ${query}`);
      }
    }
  }
  return sites;
}
