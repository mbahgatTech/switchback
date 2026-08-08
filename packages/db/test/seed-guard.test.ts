import { describe, expect, it } from 'vitest';
import { looksLikeHostedDatabase } from '../scripts/local-database';

describe('looksLikeHostedDatabase', () => {
  it('refuses the production server', () => {
    // The one host that must never be seeded. Both the pooled and direct production strings
    // reach it, and the guard sees them through any username, port or query string.
    expect(
      looksLikeHostedDatabase(
        'postgresql://sbapp:pw@psql-switchback-prod-37ywppu5p7fri.postgres.database.azure.com:5432/switchback?sslmode=verify-full',
      ),
    ).toBe(true);
    expect(
      looksLikeHostedDatabase(
        'postgresql://sbapp_vercel@psql-switchback-prod-37ywppu5p7fri.postgres.database.azure.com/switchback',
      ),
    ).toBe(true);
  });

  it('refuses the other managed providers', () => {
    expect(looksLikeHostedDatabase('postgresql://a:b@db.abcdef.supabase.co:5432/postgres')).toBe(
      true,
    );
    expect(
      looksLikeHostedDatabase('postgresql://a:b@sb.cluster-x.us-east-1.rds.amazonaws.com:5432/sb'),
    ).toBe(true);
  });

  it('lets the local development database through', () => {
    expect(
      looksLikeHostedDatabase('postgresql://switchback:switchback@localhost:5433/switchback'),
    ).toBe(false);
    expect(looksLikeHostedDatabase('')).toBe(false);
  });
});
