/**
 * Terrarium tiles on a filesystem. The development half of the shared tier, mirroring the
 * R2/local split `packages/api/src/storage.ts` already uses: a laptop drain and the benchmark get
 * a real second tier without a bucket, and the contract they exercise is the deployed one.
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { StoredTerrain, TerrainCacheStore } from './terrain-cache';

/** Zero bytes records a tile the origin does not have; a terrarium PNG is never empty. */
const NO_TILE = Buffer.alloc(0);

export function directoryTerrainStore(root: string): TerrainCacheStore {
  const base = resolve(root);

  return {
    kind: 'directory',

    async read(z, x, y, signal): Promise<StoredTerrain> {
      try {
        const body = await readFile(tilePath(base, z, x, y), { signal });
        return body.length === 0 ? { kind: 'absent' } : { kind: 'tile', body };
      } catch (error) {
        if (isMissingFile(error)) return { kind: 'miss' };
        throw error;
      }
    },

    async write(z, x, y, body, signal) {
      const path = tilePath(base, z, x, y);
      await mkdir(dirname(path), { recursive: true });
      // Written beside the target and renamed over it, because two drains racing for one tile is
      // the normal case: a reader must never see a half-written PNG that then fails to decode.
      const staging = `${path}.${process.pid}.${Date.now()}.tmp`;
      try {
        await writeFile(staging, body ?? NO_TILE, { signal });
        await rename(staging, path);
      } catch (error) {
        await rm(staging, { force: true });
        throw error;
      }
    },
  };
}

/**
 * `<root>/<z>/<x>/<y>.png`. The coordinates come from `requiredTiles`, so a non-integer is a
 * caller bug rather than input — but this is what keeps it from becoming a path.
 */
function tilePath(base: string, z: number, x: number, y: number): string {
  for (const value of [z, x, y]) {
    if (!Number.isInteger(value) || value < 0) throw new Error(`bad terrain tile coordinate`);
  }
  return join(base, String(z), String(x), `${y}.png`);
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}
