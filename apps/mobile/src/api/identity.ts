import type { QueryClient } from '@tanstack/react-query';

/**
 * Empty the query cache whenever the signed-in identity changes.
 *
 * React Query keys an entry by procedure and input and never by who asked, so without this a
 * reader who has just signed in is served the answers given to whoever was here before — for a
 * whole `staleTime`, or until the app is restarted. Signing out and back in to correct a wrong
 * account is the ordinary way to meet it, and on a shared phone it is one person's record shown
 * to another.
 *
 * Everything goes, not an allow-list of account-scoped procedures: that list is not derivable
 * from here and would drift silently, and a stale entry it forgot to name is a leak, whereas the
 * cost of over-clearing is one refetch at a moment the app is already navigating.
 *
 * `session.ts` announces every transition and is the only thing that does, so it is the seam.
 */
export function forgetAnswersOnIdentityChange(
  queryClient: Pick<QueryClient, 'clear'>,
  subscribe: (listener: (signedIn: boolean) => void) => () => void,
): () => void {
  return subscribe(() => queryClient.clear());
}
