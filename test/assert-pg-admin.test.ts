import { describe, expect, it } from 'vitest';
import { ADMIN_PROBE_SQL, readAdminVerdict } from '../scripts/assert-pg-admin';

/**
 * `db push` runs immediately after this verdict, against the one database with real data in it,
 * so the interesting cases are the ones a truthiness test would wave through.
 */
describe('the administrator verdict', () => {
  it('reads the row', () => {
    expect(
      readAdminVerdict([{ current_user: 'id-switchback-postgres-ci', is_admin: true }]),
    ).toEqual({ currentUser: 'id-switchback-postgres-ci', isAdmin: true });
  });

  it('refuses a driver that returns the flag as text', () => {
    expect(readAdminVerdict([{ current_user: 'sbapp_runtime', is_admin: 't' }]).isAdmin).toBe(
      false,
    );
  });

  it('throws when the probe returned nothing to judge', () => {
    expect(() => readAdminVerdict([])).toThrow(ADMIN_PROBE_SQL);
  });
});
