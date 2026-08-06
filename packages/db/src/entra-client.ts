import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import type { Pool } from 'pg';
import { entraPoolConfig } from './entra-pool';
import { createEntraTokenSource, type DatabaseAuthMode } from './entra-source';
import { createTokenProvider } from './entra-token';

/** Assembles the pieces: one token cache, a `pg` pool per Prisma client, a driver adapter. */

export interface EntraPoolSizing {
  max: number;
  connectionTimeoutMillis: number;
}

// One cache per process, shared by both pools. Two caches would double the traffic to Entra
// and halve the value of collapsing concurrent refreshes, for no isolation worth having:
// both pools authenticate as the same principal.
let sharedProvider: (() => Promise<string>) | undefined;

function tokenProvider(mode: DatabaseAuthMode): () => Promise<string> {
  sharedProvider ??= createTokenProvider(createEntraTokenSource(mode));
  return sharedProvider;
}

export function createEntraPool(
  databaseUrl: string,
  sizing: EntraPoolSizing,
  mode: DatabaseAuthMode,
): Pool {
  return new pg.Pool(entraPoolConfig(databaseUrl, { ...sizing, password: tokenProvider(mode) }));
}

/**
 * A Prisma driver adapter over a pool this module owns.
 *
 * The pool is constructed here rather than handed to `PrismaPg` as a config object, because a
 * pool the caller holds is a pool the caller can assert on — and `maxLifetimeSeconds` being
 * present on the real pool is the whole safety argument.
 */
export function createEntraAdapter(pool: Pool): PrismaPg {
  return new PrismaPg(pool);
}

/** Test seam: the process-wide token cache is memoised, and suites need a clean one. */
export function resetTokenProviderForTests(): void {
  sharedProvider = undefined;
}
