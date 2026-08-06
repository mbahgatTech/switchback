/**
 * Applies `prisma/spatial.sql` — the indexes and constraints Prisma cannot express.
 *
 * Run after every `prisma db push` and `prisma migrate deploy`. Statements are split on
 * semicolons at the start of a line, which keeps the `DO $$ ... $$;` blocks intact; a
 * naive split on every `;` would tear them apart mid-body.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const SQL_PATH = fileURLToPath(new URL('../prisma/spatial.sql', import.meta.url));

/**
 * Split on semicolons that terminate a statement, ignoring those inside a `$$`-quoted
 * body. Postgres has no client-side statement splitter and Prisma's `$executeRawUnsafe`
 * accepts only one statement at a time, so this has to be done here.
 */
function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inDollarQuote = false;

  for (const line of sql.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('--')) continue;

    // Every `$$` on the line toggles the quoting state; a line with two leaves it unchanged.
    const dollars = (line.match(/\$\$/g) ?? []).length;
    if (dollars % 2 === 1) inDollarQuote = !inDollarQuote;

    current += line + '\n';

    if (!inDollarQuote && trimmed.endsWith(';')) {
      const statement = current.trim();
      if (statement.length > 1) statements.push(statement);
      current = '';
    }
  }

  const tail = current.trim();
  if (tail.length > 1) statements.push(tail);
  return statements;
}

async function main(): Promise<void> {
  const sql = await readFile(SQL_PATH, 'utf8');
  const statements = splitStatements(sql);
  // Its own client, not the shared one, and so unaffected by `DATABASE_AUTH`. This runs beside
  // `prisma db push` in CI, and the Prisma CLI has no driver-adapter seam either — both read a
  // connection *string*. Under identity authentication the caller puts a freshly minted token in
  // the password field of `DATABASE_URL`; see the `migrate` job in `.github/workflows/ci.yml`.
  const prisma = new PrismaClient();

  try {
    for (const statement of statements) {
      // Statement text comes from a file in this repository, never from user input.
      await prisma.$executeRawUnsafe(statement);
    }
    console.warn(`spatial.sql applied — ${statements.length} statements`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('failed to apply spatial.sql:', error);
  process.exitCode = 1;
});
