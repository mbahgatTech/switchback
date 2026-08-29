import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Reading the app off disk, for the source-level gates.
 *
 * One copy because two had already started to drift — `navigation-targets.test.ts` was walking
 * with a `u`-flagged pattern that `conventions.test.ts` was not, which is the beginning of two
 * gates disagreeing about which files are the app.
 */

const mobileRoot = fileURLToPath(new URL('..', import.meta.url));

export type Source = [file: string, contents: string];

/** Every `.ts`/`.tsx` under `dir`, as `[repo-relative path, contents]`. */
export function sourcesUnder(dir: string): Source[] {
  const out: Source[] = [];
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
 * `app` is the router and `src` is everything it draws with. Route groups like `(tabs)` are
 * ordinary directories on disk, so nothing special is needed to walk into them.
 */
export function appSources(): Source[] {
  return [...sourcesUnder('app'), ...sourcesUnder('src')];
}
