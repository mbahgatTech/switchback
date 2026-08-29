import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, it } from 'vitest';
import { appSources } from './sources';

/**
 * The conventions the phone has to keep too — the mobile twin of
 * `apps/web/test/conventions.test.ts`. Two clients sharing `packages/ui` are one product only
 * while something checks they still agree, and a token set can offer but not enforce.
 *
 * Same bar as the web file: **a rule earns its place by having been broken.** All three below
 * are counts of real drift, not preferences.
 */

const FILES = appSources();

/**
 * A gate that scans nothing passes everything. The rules below assert an empty list, so a walk
 * that returned no files would report a clean app while reading none of it. The floor is not a
 * target; it only has to be high enough that an empty tree cannot clear it.
 */
it('reads the app', () => {
  expect(FILES.length).toBeGreaterThan(40);
  expect(FILES.map(([file]) => file)).toContain(path.join('app', '(tabs)', 'index.tsx'));
});

/** Every `file:line` where `pattern` matches, skipping files the rule exempts. */
function offenders(pattern: RegExp, exempt: (file: string) => boolean = () => false) {
  const hits: string[] = [];
  for (const [file, source] of FILES) {
    if (exempt(file)) continue;
    source.split('\n').forEach((line, index) => {
      for (const match of line.matchAll(pattern)) {
        hits.push(`${file}:${index + 1}  ${match[0]}`);
      }
    });
  }
  return hits;
}

it('casts no shadows', () => {
  /*
   * The web app's rule, word for word, because it is the same product: a printed sheet has no
   * z-axis, depth is carried by plate colour and hairline rules, and one drop shadow reads as
   * a different product's component pasted in.
   *
   * `elevation` and `boxShadow` are in the pattern although neither has ever appeared here —
   * they are the same mistake spelled the two other ways this platform accepts, and leaving
   * them out would gate the iOS spelling of a decision while waving the others through.
   */
  const stray = offenders(
    /\b(?:shadowColor|shadowOpacity|shadowRadius|shadowOffset|elevation|boxShadow)\s*:/g,
  );
  expect(stray, 'depth is plate colour and hairlines, not shadow').toEqual([]);
});

it('takes every colour from the theme', () => {
  /*
   * There is no hex in this app: colour arrives as `theme.color.*` or `dark.color.*`, which is
   * what lets a scheme change mean anything. A shadow was the one place a raw colour could
   * hide, because it is the one property where nobody asks which plate the value belongs to.
   */
  const stray = offenders(/['"]#[0-9a-fA-F]{3,8}['"]/g);
  expect(stray, 'colour comes from the theme, so it can change with the scheme').toEqual([]);
});

it('empties the query cache before it tells anybody the reader changed', () => {
  /*
   * `api/identity.ts` and `auth/context.tsx` both subscribe to `auth/session.ts`, which calls
   * its listeners in the order they were added. React mounts a child's effects before its
   * parent's, so `ApiProvider` *inside* `AuthProvider` is what puts the reset first and makes
   * the refetch that follows it the first one rather than a second.
   *
   * Correctness no longer rests on this — `resetQueries` notifies its observers, so a screen is
   * right either way — but the cost does, and the nesting is invisible from either of the two
   * files that depend on it. This is the only thing that would notice them being swapped.
   */
  const layout = readFileSync(
    fileURLToPath(new URL('../app/_layout.tsx', import.meta.url)),
    'utf8',
  );
  const auth = layout.indexOf('<AuthProvider>');
  const api = layout.indexOf('<ApiProvider>');

  expect(auth, 'AuthProvider is the outer of the two').toBeGreaterThanOrEqual(0);
  expect(api, 'ApiProvider subscribes first, so it must be the inner').toBeGreaterThan(auth);
});

/*
 * The three rules below are *structural*, and that is a compromise worth naming. Each pins a
 * property that belongs in a behavioural test, but `useOfflineHydration` and `useCacheGeneration`
 * are hooks, `vitest.config.ts` sets `environment: 'node'`, and this workspace has no
 * `react-test-renderer` or `@testing-library/react-native`. Reading the source is what is
 * available today. Each was written by making the mutation it describes and watching it fail.
 */

it('re-lays the phone’s copy when the cache generation moves', () => {
  /*
   * The dependency IS the fix. `hydrate.ts` seeds with `setQueryData`, which no refetch
   * restores, and every other dependency it has is referentially stable — so without
   * `generation` in this array the effect never re-runs, the seed stays destroyed for the life
   * of the mounted screen, and a downloaded trail reads "Trail not found" in a valley.
   */
  const hydrate = readFileSync(
    fileURLToPath(new URL('../src/offline/hydrate.ts', import.meta.url)),
    'utf8',
  );
  const deps = /\}, \[([^\]]*)\]\);/u.exec(hydrate)?.[1] ?? '';

  expect(hydrate).toContain('useCacheGeneration()');
  expect(deps, 'the effect cannot re-seed on a change it does not depend on').toContain(
    'generation',
  );
});

it('announces an identity change even when the Keychain refuses', () => {
  /*
   * `announce` is the only thing that empties the query cache, so it cannot sit behind an
   * `await` that may throw: in `adopt` the new reader's token is already installed by then, and
   * skipping the announcement would leave the previous reader's answers under their requests.
   */
  const session = readFileSync(
    fileURLToPath(new URL('../src/auth/session.ts', import.meta.url)),
    'utf8',
  );
  const finallyAnnounces = session.match(/\}\s*finally\s*\{\s*announce\(/gu) ?? [];

  expect(
    finallyAnnounces,
    'adopt and signOutLocally must both announce from a finally',
  ).toHaveLength(2);
});

it('asks for the reader’s own record only while there is a reader', () => {
  /*
   * `me.*` is account-scoped, so an ungated one fires as nobody the moment a screen mounts
   * signed out, and 401s. Screens gate it with `enabled`; a new call site that forgets is the
   * defect this catches — `app/lists/[key].tsx` shipped that way.
   */
  const ungated = FILES.filter(([, source]) =>
    /useQuery\(\s*trpc\.me\.[a-zA-Z]+\.queryOptions\(\)\s*\)/u.test(source),
  ).map(([file]) => file);

  expect(ungated, 'a me.* query needs an `enabled` gate').toEqual([]);
});
