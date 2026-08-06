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
let shared: { mode: DatabaseAuthMode; provider: () => Promise<string> } | undefined;

function tokenProvider(mode: DatabaseAuthMode): () => Promise<string> {
  // Sharing one cache only makes sense while every pool authenticates the same way. A second
  // mode would silently get the first one's credential, so it is refused rather than ignored.
  if (shared && shared.mode !== mode) {
    throw new Error(`Token cache already built for "${shared.mode}"; cannot also serve "${mode}".`);
  }
  shared ??= { mode, provider: createTokenProvider(createEntraTokenSource(mode)) };
  return shared.provider;
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
