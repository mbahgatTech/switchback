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

  it("recognises the docker host, which the suite's own IS_LOCAL regexes already allow", () => {
    // Eight test files gate themselves on a regex that admits this host. A predicate that
    // refuses it sends whoever uses it to the opt-out flag for a database that is genuinely
    // theirs — and that flag stays set long after the URL it was set for has changed.
    expect(isLocalDatabase('postgresql://sb:sb@host.docker.internal:5433/switchback')).toBe(true);
  });

  it('reads a hostname the way DNS does, without regard to case', () => {
    // `postgresql:` is not a special scheme, so the WHATWG parser preserves whatever case it
    // was given. Postgres and DNS do not care; only this guard did.
    expect(isLocalDatabase('postgresql://sb:sb@LOCALHOST:5433/switchback')).toBe(true);
    expect(isLocalDatabase('postgresql://sb:sb@Host.Docker.Internal:5433/sb')).toBe(true);
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
