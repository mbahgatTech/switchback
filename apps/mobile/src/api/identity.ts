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

/**
 * Subscribe to identity changes the way `useCacheGeneration` does.
 *
 * Exported for the same reason `seedFromDisk` is: the notification is the load-bearing half of
 * the re-seed, and a counter that can only be *read* lets a test pass while nothing is ever
 * told. `useSyncExternalStore` is this function; a test that calls it exercises the real path.
 */
export function watchGeneration(watcher: () => void): () => void {
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
 * **Only a repeated sign-*out* is skipped.** The repeat this guard exists for is one-directional:
 * a 401 signs the device out locally, and the reader then presses Sign out on a screen that
 * never noticed. Acting twice there would reset a cache that is already right and cost every
 * mounted screen a second round trip.
 *
 * A repeated sign-*in* is the opposite, and treating it as a duplicate was a hole in this file.
 * `announce(true)` is fired by `adopt`, which runs only when a fresh token pair has been
 * installed — so a second one means a *different reader*, not the same one twice. It is
 * reachable: `app/signin.tsx`'s cold-start effect gates `resumeSignIn` on a ref and not on
 * `status`, so an exchange can complete while a session is already live. Swallowing that left
 * the previous reader's answers in the cache under the new reader's requests — one person's
 * record shown to another, which is the whole harm this module exists to prevent.
 */
export function forgetAnswersOnIdentityChange(
  queryClient: Pick<QueryClient, 'resetQueries'>,
  subscribe: (listener: Listener) => () => void,
): () => void {
  let signedOutAlready = false;

  return subscribe((signedIn) => {
    if (!signedIn && signedOutAlready) return;
    signedOutAlready = !signedIn;

    void forgetEverything(queryClient);
    generation += 1;
    for (const watcher of watchers) watcher();
  });
}
