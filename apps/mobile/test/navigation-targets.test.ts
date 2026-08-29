import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every place this app sends itself has to exist. expo-router resolves a route from the
 * filesystem, so a target with no file behind it is not a compile error and not a runtime
 * throw — it is the Unmatched Route screen, arrived at by a reader who did nothing wrong and
 * whose only way off it is restarting the app.
 *
 * The rule earns its place: a completed sign-in sent the reader to `/profile`, which is the
 * *website's* account route. This app's is `/you`.
 */

const mobileRoot = fileURLToPath(new URL('..', import.meta.url));

/** Every `.ts`/`.tsx` under a directory, as `[repo-relative path, contents]`. */
function sourcesUnder(dir: string): [string, string][] {
  const out: [string, string][] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/u.test(entry.name)) {
        out.push([path.relative(mobileRoot, full), readFileSync(full, 'utf8')]);
      }
    }
  };
  walk(path.join(mobileRoot, dir));
  return out;
}

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

/** Literal `router.push('/x')` and friends. A computed target is beyond a source-level rule. */
const NAVIGATION = /router\.(?:push|replace|navigate)\(\s*'(\/[^']*)'/gu;

function targets(): { where: string; target: string }[] {
  const found: { where: string; target: string }[] = [];
  for (const [file, source] of [...sourcesUnder('app'), ...sourcesUnder('src')]) {
    source.split('\n').forEach((line, index) => {
      for (const match of line.matchAll(NAVIGATION)) {
        const target = match[1];
        if (target) found.push({ where: `${file}:${index + 1}`, target });
      }
    });
  }
  return found;
}

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

it('is never sent somewhere it cannot go', () => {
  const found = targets();
  // Same floor as `conventions.test.ts`: a scan that found nothing must not read as clean.
  expect(found.length).toBeGreaterThan(8);

  const missing = found.filter(({ target }) => !resolves(target));
  expect(missing, 'a target with no route behind it is the Unmatched Route screen').toEqual([]);
});
