import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALLOW_REMOTE_TEST_DB, assertLocalTestDatabase } from './database-guard';

const LOCAL = 'postgresql://switchback:switchback@localhost:5433/switchback';

// A host shape, not a real one. Naming the production server here would put it in a diff, and
// the password is invented for the same reason the guard refuses to print one.
const REMOTE = 'postgresql://sbapp:hunter2@db.example.com:5432/switchback?sslmode=verify-full';

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('assertLocalTestDatabase', () => {
  it('lets the local development database through', () => {
    expect(() =>
      assertLocalTestDatabase({ DATABASE_URL: LOCAL, DIRECT_DATABASE_URL: LOCAL }),
    ).not.toThrow();
  });

  it('lets the other loopback spellings through', () => {
    // `[::1]` arrives from the URL parser with its brackets still on.
    for (const url of ['postgresql://u:p@127.0.0.1:5433/db', 'postgresql://u:p@[::1]:5433/db']) {
      expect(() => assertLocalTestDatabase({ DATABASE_URL: url })).not.toThrow();
    }
  });

  it('lets a container reach the machine hosting it', () => {
    // The eight IS_LOCAL regexes in the suite admit this host, so refusing it here would send a
    // developer whose database is genuinely local to the opt-out flag, which then stays set.
    expect(() =>
      assertLocalTestDatabase({ DATABASE_URL: 'postgresql://u:p@host.docker.internal:5433/db' }),
    ).not.toThrow();
  });

  it('says nothing about a variable that is not set', () => {
    expect(() => assertLocalTestDatabase({})).not.toThrow();
  });

  it('refuses a database that is not on this machine, and names the host', () => {
    expect(() => assertLocalTestDatabase({ DATABASE_URL: REMOTE })).toThrow(/db\.example\.com/u);
  });

  it('refuses through DIRECT_DATABASE_URL as well', () => {
    expect(() =>
      assertLocalTestDatabase({ DATABASE_URL: LOCAL, DIRECT_DATABASE_URL: REMOTE }),
    ).toThrow(/DIRECT_DATABASE_URL/u);
  });

  it('fails closed on a connection string it cannot parse', () => {
    expect(() => assertLocalTestDatabase({ DATABASE_URL: 'postgres@@not a url' })).toThrow();
  });

  it('leads with the remedy that keeps the guard on, and says what a remote run costs', () => {
    // A refusal that leads with the flag teaches the reader to disable the guard, so the remedy
    // comes first. The cost it names is skipped coverage — the suite does not write to a remote
    // host, because every database test gates itself off one.
    let message = '';
    try {
      assertLocalTestDatabase({ DATABASE_URL: REMOTE });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message.indexOf('npm run db:up')).toBeLessThan(message.indexOf(ALLOW_REMOTE_TEST_DB));
    expect(message).toContain('skip');
  });

  it('keeps the credential out of the refusal', () => {
    // The reason the message names a host instead of echoing the variable: a refusal that
    // printed the URL would put a live password into a terminal, a CI log and a screenshot.
    let message = '';
    try {
      assertLocalTestDatabase({ DATABASE_URL: REMOTE });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toBe('');
    expect(message).not.toContain('hunter2');
    expect(message).not.toContain(REMOTE);
    expect(message).toContain(ALLOW_REMOTE_TEST_DB);
  });

  it('proceeds when an operator opts in, and only then', () => {
    expect(() =>
      assertLocalTestDatabase({ DATABASE_URL: REMOTE, [ALLOW_REMOTE_TEST_DB]: '1' }),
    ).not.toThrow();
    expect(() =>
      assertLocalTestDatabase({ DATABASE_URL: REMOTE, [ALLOW_REMOTE_TEST_DB]: '0' }),
    ).toThrow(/db\.example\.com/u);
  });

  it('announces a bypass, naming the host it is letting through', () => {
    // The opt-in can live in the same `.env` that names the remote host, where nothing about the
    // run would otherwise look different from a protected one.
    assertLocalTestDatabase({ DATABASE_URL: REMOTE, [ALLOW_REMOTE_TEST_DB]: '1' });

    expect(console.warn).toHaveBeenCalledTimes(1);
    const warning = vi.mocked(console.warn).mock.calls[0]?.[0] as string;
    expect(warning).toContain(ALLOW_REMOTE_TEST_DB);
    expect(warning).toContain('db.example.com');
    expect(warning).not.toContain('hunter2');
  });
});

/**
 * The unit above is imported directly by every case in this file, so deleting the one line that
 * calls it from `vitest.config.ts` would leave all of them green. These load the config itself.
 */
describe('the wiring in vitest.config.ts', () => {
  async function loadConfig(overrides: Record<string, string | undefined>): Promise<void> {
    const saved = { ...process.env };
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.resetModules();
    try {
      await import('../vitest.config');
    } finally {
      process.env = saved;
    }
  }

  // `loadEnv` merges `process.env` last, so these override whatever a root `.env` holds. The
  // opt-in is cleared explicitly: inherited from the ambient environment it would pass the run.
  const clear = { [ALLOW_REMOTE_TEST_DB]: undefined };

  it('refuses to load against a database that is not on this machine', async () => {
    await expect(
      loadConfig({ DATABASE_URL: REMOTE, DIRECT_DATABASE_URL: REMOTE, ...clear }),
    ).rejects.toThrow(/db\.example\.com/u);
  });

  it('loads against the local database CI and `npm run db:up` provide', async () => {
    await expect(
      loadConfig({ DATABASE_URL: LOCAL, DIRECT_DATABASE_URL: LOCAL, ...clear }),
    ).resolves.toBeUndefined();
  });
});
