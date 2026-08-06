import { execFileSync } from 'node:child_process';
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

describe('pg driver contract', () => {
  it('holds every claim the token design depends on', () => {
    const output = execFileSync(process.execPath, [probe], { encoding: 'utf8' });
    expect(output).not.toMatch(/^FAIL/m);
    expect(output).toMatch(/password function is invoked per physical connection/);
    expect(output).toMatch(/maxLifetimeSeconds does NOT evict a checked-out connection/);
  }, 30_000);
});
