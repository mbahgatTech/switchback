import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC, useTRPCClient } from '@/api/trpc';
import { useAuth } from '@/auth/context';
import { setPinger, watchLifeline } from '@/record/lifeline';
import { flush, hydrate, setUploader } from '@/record/store';

/**
 * The wire between the recorder and the API.
 *
 * `@/record/store` is a module, not a component, so it cannot reach a React context — which
 * is the whole point of it, since that is what lets a hike survive the Record screen
 * unmounting. It still has to get its fixes to the server somehow, so the uploader is handed
 * in from here: one component, mounted once at the root inside `ApiProvider`, where the tRPC
 * client actually exists.
 *
 * `hydrate` runs here too rather than on the Record screen. A hike interrupted by a crash has
 * to be adopted the moment the app opens, not the first time somebody happens to look at the
 * recorder — the tab bar shows a live hike's clock, and it can only do that if the hike is
 * already restored when the bar first paints.
 *
 * The Lifeline is driven from here for the stronger version of the same reason: a loop that
 * sends somebody's position to a worried contact must not stop because they tapped another
 * tab. This component is mounted for the life of the app, so the loop is too.
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
    hydrate();
    // A batch may have been recorded and journalled but never acknowledged before the last
    // launch ended. Nothing else would send it until the next flush tick a minute from now.
    void flush().catch(() => undefined);
    return () => {
      setUploader(null);
      setPinger(null);
    };
  }, [client]);

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
