/**
 * Whether a push changed the Prisma schema, and so whether production needs `prisma db push`.
 *
 * There are no migration files in this repository — `db push` reconciles the database to
 * `schema.prisma` — so there is no filename to key off and the question has to be asked of the
 * diff. `ci.yml`'s `migrate` job runs this and reads `changed` off stdout.
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

/** Everything the schema is made of: `schema.prisma` and the `spatial.sql` applied beside it. */
const SCHEMA_DIR = 'packages/db/prisma/';

/** What `github.event.before` holds when a ref is being created rather than moved. */
const NO_COMMIT = /^0{40}$/;

export interface Verdict {
  changed: boolean;
  reason: string;
  files: string[];
}

/** Files changed between two commits, or null when either is not in this clone. */
export type ChangedFiles = (base: string, head: string) => string[] | null;

/**
 * Decided against the commit the branch was at before the push, never against `HEAD^`.
 *
 * A push carries however many commits its merge strategy produced. `HEAD^` is the commit before
 * the *last* of those, so it only ever describes the whole push when the push was one commit —
 * a rebase merge replays every commit of a pull request, and a schema change anywhere but the
 * tip is then invisible. The database silently keeps a schema the shipped code does not expect.
 */
export function schemaChanged(base: string | undefined, head: string, diff: ChangedFiles): Verdict {
  if (!base || NO_COMMIT.test(base)) {
    return { changed: true, reason: 'no base commit to compare against', files: [] };
  }

  const files = diff(base, head);
  /*
   * Unreadable counts as changed. `db push` against a matching schema is a few seconds and a
   * no-op and `spatial.sql` is `IF NOT EXISTS` throughout, so a false positive costs nothing,
   * while a false negative deploys code that expects a column which is not there.
   */
  if (files === null) return { changed: true, reason: `cannot diff ${base}..${head}`, files: [] };

  const schema = files.filter((file) => file.startsWith(SCHEMA_DIR));
  return schema.length > 0
    ? { changed: true, reason: `changed under ${SCHEMA_DIR}`, files: schema }
    : { changed: false, reason: `no change under ${SCHEMA_DIR}`, files: [] };
}

export const gitChangedFiles: ChangedFiles = (base, head) => {
  try {
    return execFileSync('git', ['diff', '--name-only', base, head], { encoding: 'utf8' })
      .split('\n')
      .filter((line) => line.length > 0);
  } catch {
    return null;
  }
};

function main(): void {
  const [base, head = 'HEAD'] = process.argv.slice(2);
  const verdict = schemaChanged(base, head, gitChangedFiles);

  process.stdout.write(`changed=${verdict.changed}\n`);
  process.stderr.write(`${verdict.reason}\n`);
  for (const file of verdict.files) process.stderr.write(`  ${file}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
