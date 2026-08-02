import { type TitledTrail } from '@switchback/core';
import type { OfflineTrailSummary } from './store';

/**
 * A stored index row as something `trailTitle` will take. Its own module because `store.ts`
 * reaches for `expo-file-system` at import, and this has to be loadable under plain node.
 */
export function titled(row: OfflineTrailSummary): TitledTrail {
  // The one place `displayName` may legitimately be absent: an index written by a build that
  // predates the column. Widened here rather than as a `?? null` on every screen listing one.
  return { name: row.name, displayName: row.displayName ?? null };
}
