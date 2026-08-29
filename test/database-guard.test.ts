import { describe, expect, it } from 'vitest';
import { ALLOW_REMOTE_TEST_DB, assertLocalTestDatabase } from './database-guard';

const LOCAL = 'postgresql://switchback:switchback@localhost:5433/switchback';

// A host shape, not a real one. Naming the production server here would put it in a diff, and
// the password is invented for the same reason the guard refuses to print one.
const REMOTE = 'postgresql://sbapp:hunter2@db.example.com:5432/switchback?sslmode=verify-full';

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
});
