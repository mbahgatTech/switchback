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
 * The four rules below are *structural*, and that is a compromise worth naming. Each pins a
 * property that belongs in a behavioural test, but `useOfflineHydration` and `useCacheGeneration`
 * are hooks, `vitest.config.ts` sets `environment: 'node'`, and this workspace has no
 * `react-test-renderer` or `@testing-library/react-native`. Reading the source is what is
 * available today. Each was written by making the mutation it describes and watching it fail.
 *
 * Two of them are no longer alone: `session.test.ts` runs both `finally` blocks, and the screen
 * rule below is doubled by `offline-seed.test.ts` driving a real observer. Structural is the
 * floor here, not the whole story.
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
 * Every branch that draws something *instead of* the screen's content: the early-return guards a
 * screen opens with, and the arm a render ternary falls to once its pending arm is done. Read off
 * the source rather than listed, so a screen written next month is covered the day it is written.
 */
function screenReplacingBranches(): { at: string; test: string; shape: 'guard' | 'arm' }[] {
  const branches: { at: string; test: string; shape: 'guard' | 'arm' }[] = [];

  for (const [file, source] of FILES) {
    const lines = source.split('\n');
    lines.forEach((line, index) => {
      const guard = /^\s*if \((.+)\) \{$/u.exec(line);
      if (guard && lines[index + 1]?.trim() === 'return (') {
        branches.push({ at: `${file}:${index + 1}`, test: guard[1] ?? '', shape: 'guard' });
        return;
      }

      // A ternary that opens on pending: the arm chained onto it is the failure copy. One that
      // closes `) : null}` instead — `saved.tsx` — adds a message beside the content rather than
      // in place of it, and is right to read the error flag.
      if (!/\.isPending \? \($/u.test(line)) return;
      const closing = lines.findIndex((next, at) => at > index && /^\s*\) : /u.test(next));
      if (closing === -1) return;
      const arm = /^\s*\) : (.+) \? \($/u.exec(lines[closing] ?? '');
      if (arm) branches.push({ at: `${file}:${closing + 1}`, test: arm[1] ?? '', shape: 'arm' });
    });
  }
  return branches;
}

it('never draws a failure over content the phone is still holding', () => {
  /*
   * `isError` is true while `data` is still there. A refetch that fails does not take the answer
   * with it — query-core keeps `data` and moves `status` to `error` — so a branch that replaces
   * the screen on the error flag draws "Trail not found" over a trail held in full. That is the
   * defect this Work Order exists to fix, and it was in ten branches across ten files.
   *
   * The two spellings that are safe both ask about the data rather than the flag: an absence
   * test (`!trail`, `!me.data`), or `isLoadingError`, which is by definition an error with
   * nothing behind it. `offline-seed.test.ts` proves the property on a real observer for one
   * screen; this is what holds the other nine, and what will hold the screen nobody has written
   * yet.
   */
  const branches = screenReplacingBranches();
  const onTheFlag = branches
    .filter(({ test }) => /\.isError\b/u.test(test))
    .map(({ at, test }) => `${at}  ${test}`);

  expect(
    branches.length,
    'the scan found no screen branches, so this rule read nothing',
  ).toBeGreaterThan(30);
  expect(
    new Set(branches.map(({ shape }) => shape)),
    'both spellings must still be found — a regex that matches neither passes everything',
  ).toEqual(new Set(['guard', 'arm']));
  expect(onTheFlag, 'a screen branches on the data it holds, never on the error flag').toEqual([]);
});

/**
 * Every *query* whose answer is about the reader — the ones a screen must not ask as nobody.
 *
 * Two clauses, both read from `packages/api/src/routers/` rather than listed here: every
 * `protectedProcedure` query, and every query in `me.ts`. A hand-kept list goes stale the first
 * time somebody adds a procedure, and this rule is only worth having if it knows about the ones
 * nobody thought to tell it about.
 *
 * The second clause is not a special case wearing a general name. `me.get` is `publicProcedure`
 * on purpose — it answers `null` rather than 401 for a signed-out visitor, so the error logs
 * stay worth reading — but the record it returns is still the reader's own, and asking for it as
 * nobody through the reset that follows an identity change is the same defect the protected ones
 * have. The `me` router is the reader's record by construction, so it is read whole rather than
 * named procedure by procedure.
 *
 * Mutations are excluded either way: they fire on a press, not on mount, so they need no
 * `enabled`.
 */
function accountScopedQueries(): string[] {
  const routerDir = fileURLToPath(new URL('../../../packages/api/src/routers', import.meta.url));
  const names: string[] = [];

  for (const entry of readdirSync(routerDir)) {
    if (!entry.endsWith('.ts')) continue;
    const source = readFileSync(path.join(routerDir, entry), 'utf8');
    const declarations = [
      ...source.matchAll(/^ {2}(\w+): (protectedProcedure|publicProcedure)/gmu),
    ];

    declarations.forEach((declaration, index) => {
      if (declaration[2] !== 'protectedProcedure' && entry !== 'me.ts') return;
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
   * `lists/[key].tsx` shipped ungated and was fixed by hand; the rule then found two more
   * nobody had thought to look for — `me.devices` in `settings.tsx`, and `lifeline.active` in
   * `lifeline-panel.tsx`. `me.get` itself stayed invisible to it until the `me.ts` clause above,
   * though it is the procedure that first bug was about and it has twelve call sites.
   */
  const queries = accountScopedQueries();
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
  ).toBeGreaterThan(10);
  expect(queries, 'the `me.ts` clause is what makes `me.get` visible here').toContain('me.get');
  expect(ungated, 'a query about the reader needs an `enabled` gate').toEqual([]);
});
