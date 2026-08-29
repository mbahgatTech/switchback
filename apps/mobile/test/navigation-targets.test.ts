import { describe, expect, it } from 'vitest';
import { appSources, sourcesUnder } from './sources';

/**
 * Every place this app sends itself has to exist. expo-router resolves a route from the
 * filesystem, so a target with no file behind it is not a compile error and not a runtime
 * throw — it is the Unmatched Route screen, arrived at by a reader who did nothing wrong and
 * whose only way off it is restarting the app.
 *
 * The rule earns its place: a completed sign-in sent the reader to `/profile`, which is the
 * *website's* account route. This app's is `/you`.
 *
 * The compiler is the better answer and is one line from working — `typedRoutes` is set in
 * `app.config.ts`, and `tsconfig.json` excludes the `.expo` directory its declarations are
 * generated into, so they never enter the program. Wiring that generation into CI is repo-wide
 * and is being done separately; this gate needs no build step and holds in the meantime.
 */

/**
 * The URL a route file answers to. Route groups are parentheses on disk and absent from the
 * path, `_layout` draws rather than routes, and `index` is its directory.
 */
function routeOf(file: string): string | null {
  const withoutExtension = file
    .replace(/\\/gu, '/')
    .replace(/^app\//u, '')
    .replace(/\.tsx?$/u, '');
  const segments = withoutExtension
    .split('/')
    .filter((segment) => !/^\(.+\)$/u.test(segment))
    .filter((segment) => segment !== 'index');
  if (withoutExtension.split('/').some((segment) => segment.startsWith('_'))) return null;
  return `/${segments.join('/')}`;
}

const ROUTES = sourcesUnder('app')
  .map(([file]) => routeOf(file))
  .filter((route): route is string => route !== null);

/** Does `target` name one of the app's routes, allowing a dynamic segment to match anything? */
function resolves(target: string): boolean {
  const wanted = (target.split('?')[0] ?? '').replace(/\/$/u, '') || '/';
  const asked = wanted.split('/');
  return ROUTES.some((route) => {
    const offered = route.split('/');
    if (offered.length !== asked.length) return false;
    return offered.every((segment, index) => /^\[.+\]$/u.test(segment) || segment === asked[index]);
  });
}

/**
 * The three literal spellings of a destination this app uses.
 *
 * `router.push('/x')` is the short form; `router.push({ pathname: '/x', params })` is how every
 * dynamic route is navigated, and the pathname in it is every bit as literal as the short form;
 * `href` is the tab bar's. Missing the object form is not academic — the bug this file exists
 * for would walk straight back in through it.
 *
 * What is genuinely beyond a source-level rule is a target assembled from a variable. Nothing
 * here does that today, and a gate cannot follow it if something starts.
 */
const DESTINATIONS: { spelling: Spelling; pattern: RegExp }[] = [
  { spelling: 'call', pattern: /router\.(?:push|replace|navigate)\(\s*'(\/[^']*)'/gu },
  { spelling: 'pathname', pattern: /pathname:\s*'(\/[^']*)'/gu },
  { spelling: 'href', pattern: /href:\s*'(\/[^']*)'/gu },
  { spelling: 'href', pattern: /href=\{?'(\/[^']*)'/gu },
];

type Spelling = 'call' | 'pathname' | 'href';
const SPELLINGS: Spelling[] = ['call', 'pathname', 'href'];

function destinations(): { where: string; target: string; spelling: Spelling }[] {
  const found: { where: string; target: string; spelling: Spelling }[] = [];
  for (const [file, source] of appSources()) {
    source.split('\n').forEach((line, index) => {
      for (const { spelling, pattern } of DESTINATIONS) {
        for (const match of line.matchAll(pattern)) {
          const target = match[1];
          if (target) found.push({ where: `${file}:${index + 1}`, target, spelling });
        }
      }
    });
  }
  return found;
}

const FOUND = destinations();

describe('the routes this app has', () => {
  /* A resolver that matched nothing would pass the rule below by reading nothing. */
  it('are read off the filesystem, groups and layouts aside', () => {
    expect(ROUTES).toEqual(expect.arrayContaining(['/', '/you', '/record', '/saved', '/signin']));
    expect(ROUTES).toContain('/trails/[slug]');
    expect(ROUTES).not.toContain('/_layout');
  });

  it('do not include the website-only ones', () => {
    expect(resolves('/profile')).toBe(false);
    expect(resolves('/explore')).toBe(false);
  });
});

describe('every destination in the app', () => {
  /*
   * A floor per spelling, and it has to be per spelling to mean anything: `/you` and `/saved`
   * are written in more than one of them, so a single total plus a list of expected targets
   * stays green with a whole pattern deleted. That is the hole the first version of this file
   * shipped with — 37 matched, 9 missed, every dynamic route among the missing — and asserting
   * the total again would have reintroduced it in the file that fixed it.
   */
  it.each(SPELLINGS)('is scanned where it is written as %s', (spelling) => {
    expect(FOUND.filter((found) => found.spelling === spelling)).not.toEqual([]);
  });

  it('includes the dynamic routes, which only the object form reaches', () => {
    expect(FOUND.filter(({ target }) => target.includes('['))).not.toEqual([]);
  });

  it('names a route this app can go to', () => {
    const missing = FOUND.filter(({ target }) => !resolves(target));
    expect(missing, 'a target with no route behind it is the Unmatched Route screen').toEqual([]);
  });
});
