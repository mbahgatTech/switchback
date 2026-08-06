import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The Entra design rests on driver behaviour, not on our own code: `pg` must call the password
 * callback per physical connection, and `maxLifetimeSeconds` must not evict a checked-out one.
 * Both are properties of a pinned dependency, so a `pg` upgrade is what would break them.
 */
const probe = fileURLToPath(
  new URL('../../../infra/postgres-identity/pg-password-callback-probe.mjs', import.meta.url),
);

const require = createRequire(import.meta.url);
const pinnedVersion = (require('pg/package.json') as { version: string }).version;

describe('pg driver contract', () => {
  it('holds every claim the token design depends on', () => {
    const output = execFileSync(process.execPath, [probe], { encoding: 'utf8' });
    expect(output).not.toMatch(/^FAIL/m);
    expect(output).toMatch(/password function is invoked per physical connection/);
    expect(output).toMatch(/maxLifetimeSeconds does NOT evict a checked-out connection/);

    // The probe lives outside every workspace, so its bare `import pg` resolves to whichever
    // copy hoisting put at the root. That is the same copy today by luck, not by construction:
    // a second `pg` under packages/db would leave the probe measuring the other one and still
    // passing. Bind the two.
    expect(output).toContain(
      `pg version under test                              : ${pinnedVersion}`,
    );
  }, 30_000);
});
