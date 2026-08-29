import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC, useTRPCClient } from '@/api/trpc';
import { useAuth } from '@/auth/context';
import { setPinger, watchLifeline } from '@/record/lifeline';
import { confirmSignedInUser, flush, hydrate, setUploader, signOut } from '@/record/store';

/**
 * The wire between the recorder and the API.
 *
 * `@/record/store` is a module, not a component, so it cannot reach a React context — which
 * is the whole point of it, since that is what lets a hike survive the Record screen
 * unmounting. It still has to get its fixes to the server somehow, so the uploader is handed
 * in from here: one component, mounted once at the root inside `ApiProvider`, where the tRPC
 * client actually exists.
 *
 * Identity arrives the same way, and for a stronger reason. A journal is a per-second location
 * history, and a phone can be handed to somebody else — so the recorder restores a hike only for
 * the person who made it. This is where the two halves meet: `useAuth` says whether anybody is
 * signed in, off the session module every other consumer subscribes to, and `me.get` is the only
 * place a user *id* exists on the device. The store adopts nothing until one arrives.
 *
 * The Lifeline is driven from here for a related reason: a loop that sends somebody's position to
 * a worried contact must not stop because they tapped another tab. This component is mounted for
 * the life of the app, so the loop is too.
 *
 * Renders nothing.
 */
export function RecordBridge() {
  const client = useTRPCClient();
  const trpc = useTRPC();
  const { status } = useAuth();
  const signedIn = status === 'signedIn';

  useEffect(() => {
    setUploader((activityId, fixes) => client.activities.append.mutate({ id: activityId, fixes }));
    setPinger((ping) => client.lifeline.ping.mutate(ping));
    return () => {
      setUploader(null);
      setPinger(null);
    };
  }, [client]);

  /*
   * Unconditionally, and before anything about identity is known. `me.get` is a network query with
   * no persister, so on a relaunch with no signal it never resolves — and a recorder that waited
   * for it would adopt no journal, register no handler for the readings iOS is already delivering,
   * and drop the rest of the hike on the floor. Restoring here is safe offline for the reason in
   * `ownerVerdict`: becoming a different user requires a sign-in through our own server.
   */
  useEffect(() => {
    hydrate();
  }, []);

  const me = useQuery({ ...trpc.me.get.queryOptions(), enabled: signedIn });

  /*
   * When this device last became signed in. A `QueryClient` built once per launch keeps `me.get`
   * for a minute after it is read, and nothing clears it on sign-out — so without this, signing in
   * as somebody else inside that window is answered with the previous user's id, and the previous
   * user's track is handed to them. An id older than the sign-in that is asking for it is refused.
   */
  const signedInAt = useRef<number | null>(null);
  if (signedIn && signedInAt.current === null) signedInAt.current = Date.now();
  if (!signedIn && signedInAt.current !== null) signedInAt.current = null;

  useEffect(() => {
    if (status === 'loading') return;
    if (!signedIn) {
      signOut();
      return;
    }
    const since = signedInAt.current;
    const id = me.data?.id;
    if (!id || since === null || me.dataUpdatedAt < since) return;
    confirmSignedInUser(id);
    // A batch may have been recorded and journalled but never acknowledged before the last launch
    // ended. Nothing else would send it until the next flush tick a minute from now.
    void flush().catch(() => undefined);
  }, [status, signedIn, me.data, me.dataUpdatedAt]);

  /*
   * Whether a Lifeline is running, asked once per launch and refreshed by whoever changes it.
   * The Record screen invalidates this key after starting, extending or ending one, so the
   * loop below picks the change up without either component knowing about the other.
   */
  const active = useQuery({ ...trpc.lifeline.active.queryOptions(), enabled: signedIn });

  useEffect(() => {
    watchLifeline(signedIn ? (active.data?.id ?? null) : null);
  }, [signedIn, active.data]);

  return null;
}
