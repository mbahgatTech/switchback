import { readFileSync, readdirSync } from 'node:fs';
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

  /*
   * Nesting, not two positions in the file. Comparing indices only asks which tag is written
   * first, which siblings satisfy just as well as a parent and child — and siblings destroy the
   * ordering this rule exists to protect. Reading what sits *between* the opening and closing
   * tags is what tells the two shapes apart.
   */
  const opened = layout.indexOf('<AuthProvider>');
  const closed = layout.indexOf('</AuthProvider>');

  expect(opened, 'AuthProvider is the outer of the two').toBeGreaterThanOrEqual(0);
  expect(closed, 'AuthProvider must wrap something').toBeGreaterThan(opened);
  expect(
    layout.slice(opened, closed),
    'ApiProvider subscribes first, so it must be nested inside AuthProvider',
  ).toContain('<ApiProvider>');
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

/**
 * Every protected *query* the server declares, as `router.procedure`.
 *
 * Read from `packages/api/src/routers/`, not listed here: a hand-kept list is a list that goes
 * stale the first time somebody adds a procedure, and the rule below is only worth having if it
 * knows about procedures nobody thought to tell it about. Mutations are excluded — they fire on
 * a press, not on mount, so they need no `enabled`.
 */
function protectedQueries(): string[] {
  const routerDir = fileURLToPath(new URL('../../../packages/api/src/routers', import.meta.url));
  const names: string[] = [];

  for (const entry of readdirSync(routerDir)) {
    if (!entry.endsWith('.ts')) continue;
    const source = readFileSync(path.join(routerDir, entry), 'utf8');
    const declarations = [
      ...source.matchAll(/^ {2}(\w+): (protectedProcedure|publicProcedure)/gmu),
    ];

    declarations.forEach((declaration, index) => {
      if (declaration[2] !== 'protectedProcedure') return;
      const from = declaration.index ?? 0;
      const to = declarations[index + 1]?.index ?? source.length;
      // `.query(` before the next declaration means this one answers rather than writes.
      if (source.slice(from, to).includes('.query(')) {
        names.push(`${entry.replace(/\.ts$/u, '')}.${declaration[1]}`);
      }
    });
  }
  return names;
}

it('asks for the reader’s own record only while there is a reader', () => {
  /*
   * An ungated protected query fires as nobody the moment a screen mounts signed out, and 401s.
   * It also fires again through the reset that follows every identity change, before React has
   * re-rendered — so `enabled` computed from the last signed-in render is still `true`.
   *
   * Three call sites shipped ungated: `lists/[key].tsx`, then `settings.tsx` and
   * `lifeline-panel.tsx`, both found by this rule after the first was fixed by hand.
   */
  const queries = protectedQueries();
  /*
   * A plain string test, not a regex: the gated spelling always opens `useQuery({` to spread the
   * options, so `useQuery(trpc.` with no brace is exactly the ungated one.
   */
  const ungated = FILES.flatMap(([file, source]) =>
    queries
      .filter((query) => source.includes(`useQuery(trpc.${query}.queryOptions(`))
      .map((query) => `${file}: ${query}`),
  );

  expect(
    queries.length,
    'the router scan found nothing, so this rule read nothing',
  ).toBeGreaterThan(5);
  expect(ungated, 'a protected query needs an `enabled` gate').toEqual([]);
});
