import { useSyncExternalStore } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import type { Listener } from '@/auth/session';

/**
 * The cache does not know who asked.
 *
 * React Query keys an entry by procedure and input and never by reader, so without this the
 * person who has just signed in is served the answers given to whoever was here before —
 * signing out and back in to correct a wrong account is the ordinary way to meet it, and on a
 * shared phone it is one person's record shown to another.
 *
 * `session.ts` announces every transition and is the only thing that does, so it is the seam.
 */

/**
 * **`resetQueries`, never `clear`.** `clear` empties the cache without notifying anybody: a
 * mounted `useQuery` goes on serving the previous reader's data and never refetches on its own,
 * so the leak would close only if some other re-render happened to reach that screen.
 * `resetQueries` notifies its observers and refetches the active ones, which is the actual job.
 */
async function forgetEverything(queryClient: Pick<QueryClient, 'resetQueries'>): Promise<void> {
  await queryClient.resetQueries();
}

/**
 * Bumped on every identity change. Anything holding a `setQueryData` seed rather than a fetch —
 * `offline/hydrate.ts` is the one — watches this and lays its seed down again, because a reset
 * destroys a seeded entry and offline there is no fetch to replace it.
 */
let generation = 0;
const watchers = new Set<() => void>();

function readGeneration(): number {
  return generation;
}

function watchGeneration(watcher: () => void): () => void {
  watchers.add(watcher);
  return () => watchers.delete(watcher);
}

/** How many identity changes this process has seen. Only ever increases. */
export function cacheGeneration(): number {
  return readGeneration();
}

/** The same count, for a component that must re-lay a seed the reset took with it. */
export function useCacheGeneration(): number {
  return useSyncExternalStore(watchGeneration, readGeneration, readGeneration);
}

/**
 * Empty the query cache whenever the signed-in identity changes, and wake anything that seeds
 * the cache by hand so it can seed again.
 *
 * Everything goes, not an allow-list of account-scoped procedures: that list is not derivable
 * from this seam and would drift silently, and one it forgot to name is a leak. The cost is real
 * rather than "one refetch" — a reset takes the phone's downloaded trails out of the cache with
 * it, and offline there is no refetch to be had, which is exactly what the generation is for.
 *
 * The announced state is compared with the last one acted on, because a repeat is reachable: a
 * 401 signs the device out locally, and the reader then presses Sign out on a screen that never
 * noticed. Acting twice would reset a cache that is already right and cost every mounted screen
 * a second round trip. `null` to begin with, because a process that has heard no announcement
 * cannot assume it knows which reader the cache belongs to.
 */
export function forgetAnswersOnIdentityChange(
  queryClient: Pick<QueryClient, 'resetQueries'>,
  subscribe: (listener: Listener) => () => void,
): () => void {
  let actedOn: boolean | null = null;

  return subscribe((signedIn) => {
    if (actedOn === signedIn) return;
    actedOn = signedIn;

    void forgetEverything(queryClient);
    generation += 1;
    for (const watcher of watchers) watcher();
  });
}
