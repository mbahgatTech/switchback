import { describe, expect, it } from 'vitest';
import { isLocalDatabase } from '../scripts/local-database';

describe('isLocalDatabase', () => {
  it('recognises the local development database', () => {
    expect(isLocalDatabase('postgresql://sb:sb@localhost:5433/switchback?schema=public')).toBe(
      true,
    );
    expect(isLocalDatabase('postgresql://sb:sb@127.0.0.1:5432/switchback')).toBe(true);
    expect(isLocalDatabase('postgresql://sb:sb@[::1]:5432/switchback')).toBe(true);
    expect(isLocalDatabase('postgresql:///switchback?host=/var/run/postgresql')).toBe(true);
  });

  it('treats every host it does not recognise as production', () => {
    // The old guard matched a list of providers, so any host missing from it — an IP, a
    // pgbouncer alias, next year's provider — passed with `--apply` alone.
    expect(isLocalDatabase('postgresql://a:b@psql-prod.postgres.database.azure.com:5432/sb')).toBe(
      false,
    );
    expect(isLocalDatabase('postgresql://a:b@10.0.0.7:5432/sb')).toBe(false);
    expect(isLocalDatabase('postgresql://a:b@pgbouncer:6432/sb')).toBe(false);
    expect(isLocalDatabase('postgresql://a:b@db.internal:5432/sb')).toBe(false);
  });

  it('fails closed on a string it cannot read', () => {
    expect(isLocalDatabase('')).toBe(false);
    expect(isLocalDatabase('not a url')).toBe(false);
  });
});
