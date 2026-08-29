import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The wiring, which nothing could import until `@/` resolved in tests.
 *
 * Three things only this component decides, and each has been wrong at least once: that the
 * journal is adopted on a launch with no network, that a token refresh flickering the session does
 * not tear down a live hike, and that an id served from a cache older than the sign-in asking for
 * it is refused. React is driven by hand rather than through a renderer — the component is a
 * sequence of effects over two inputs, and a renderer would test React.
 */

const store = vi.hoisted(() => ({
  hydrate: vi.fn(),
  confirmSignedInUser: vi.fn(),
  signOut: vi.fn(),
  setUploader: vi.fn(),
  flush: vi.fn(async () => undefined),
}));

type Status = 'loading' | 'signedIn' | 'signedOut';
const auth = vi.hoisted((): { status: Status; signedInAt: number | null } => ({
  status: 'loading',
  signedInAt: null,
}));
const query = vi.hoisted(() => ({
  me: { data: undefined as { id: string } | undefined, dataUpdatedAt: 0 },
}));

vi.mock('@/record/store', () => ({
  hydrate: store.hydrate,
  confirmSignedInUser: store.confirmSignedInUser,
  signOut: store.signOut,
  setUploader: store.setUploader,
  flush: store.flush,
}));

vi.mock('@/record/lifeline', () => ({ setPinger: vi.fn(), watchLifeline: vi.fn() }));

vi.mock('@/auth/context', () => ({
  useAuth: () => ({ status: auth.status, signedInAt: auth.signedInAt }),
}));

vi.mock('@/api/trpc', () => ({
  useTRPC: () => ({
    me: { get: { queryOptions: () => ({ queryKey: ['me'] }) } },
    lifeline: { active: { queryOptions: () => ({ queryKey: ['lifeline'] }) } },
  }),
  useTRPCClient: () => ({
    activities: { append: { mutate: vi.fn() } },
    lifeline: { ping: { mutate: vi.fn() } },
  }),
}));

/** `useQuery` answers for `me.get` and returns nothing for the Lifeline key. */
vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: { queryKey: string[] }) =>
    options.queryKey[0] === 'me'
      ? { data: query.me.data, dataUpdatedAt: query.me.dataUpdatedAt }
      : { data: undefined, dataUpdatedAt: 0 },
}));

/**
 * React's hooks, played by hand across renders. `useEffect` fires when its dependencies change,
 * which is all this component uses and all that has to be faithful.
 *
 * `useRef` is deliberately absent. This component used to derive the sign-in moment by mutating a
 * ref during render — unsupported in React, because a discarded render's mutation survives — and
 * the moment now comes from `AuthProvider`, which is where the transition happens. Leaving the
 * hook unimplemented is what makes bringing that back a failure rather than a subtlety.
 */
const hooks = vi.hoisted(() => ({
  effects: [] as { deps: unknown[] | undefined; ran: boolean }[],
  slot: 0,
}));

vi.mock('react', () => ({
  useEffect: (fn: () => void, deps?: unknown[]) => {
    const index = hooks.slot++;
    const previous = hooks.effects[index];
    const changed =
      !previous ||
      deps === undefined ||
      previous.deps === undefined ||
      deps.length !== previous.deps.length ||
      deps.some((dep, i) => !Object.is(dep, previous.deps?.[i]));
    hooks.effects[index] = { deps, ran: true };
    if (changed) fn();
  },
}));

const { RecordBridge } = await import('@/record/bridge');

/** One render. */
function render(): void {
  hooks.slot = 0;
  RecordBridge();
}

beforeEach(() => {
  vi.clearAllMocks();
  hooks.effects = [];
  auth.status = 'loading';
  auth.signedInAt = null;
  query.me = { data: undefined, dataUpdatedAt: 0 };
});

describe('a launch in the backcountry, with no network', () => {
  it('adopts the journal without waiting for a user id that will never arrive', () => {
    auth.status = 'signedIn';
    render();
    // `me.get` is a network query with no persister. A recorder that waited for it would register
    // no handler for the readings iOS is already delivering, and drop the rest of the hike.
    expect(query.me.data).toBeUndefined();
    expect(store.hydrate).toHaveBeenCalledTimes(1);
  });

  it('adopts it exactly once across re-renders', () => {
    auth.status = 'signedIn';
    render();
    render();
    render();
    expect(store.hydrate).toHaveBeenCalledTimes(1);
  });
});

describe('while the session is still resolving', () => {
  it('neither confirms an identity nor seals the recorder', () => {
    auth.status = 'loading';
    render();
    expect(store.confirmSignedInUser).not.toHaveBeenCalled();
    expect(store.signOut).not.toHaveBeenCalled();
  });
});

describe('a user id from before this sign-in', () => {
  it('is refused, so the previous person’s track is not handed to the next one', () => {
    const signInMoment = Date.now();
    auth.status = 'signedIn';
    auth.signedInAt = signInMoment;
    // Served from a cache filled a minute ago, under the previous account, and never cleared.
    query.me = { data: { id: 'usr_a' }, dataUpdatedAt: signInMoment - 60_000 };
    render();
    expect(store.confirmSignedInUser).not.toHaveBeenCalled();
  });

  it('is refused when it was fetched in the very millisecond of the sign-in', () => {
    const signInMoment = Date.now();
    auth.status = 'signedIn';
    auth.signedInAt = signInMoment;
    // A tie says nothing about which side of the sign-in the answer came from, and the direction
    // that is wrong hands one person another person's track.
    query.me = { data: { id: 'usr_a' }, dataUpdatedAt: signInMoment };
    render();
    expect(store.confirmSignedInUser).not.toHaveBeenCalled();
  });

  it('is accepted once it was fetched after the sign-in that is asking', () => {
    auth.status = 'signedIn';
    auth.signedInAt = Date.now();
    render();
    query.me = { data: { id: 'usr_b' }, dataUpdatedAt: Date.now() + 1_000 };
    render();
    expect(store.confirmSignedInUser).toHaveBeenCalledWith('usr_b');
  });

  it('is refused while the provider has stamped no sign-in at all', () => {
    auth.status = 'signedIn';
    auth.signedInAt = null;
    query.me = { data: { id: 'usr_a' }, dataUpdatedAt: Date.now() };
    render();
    expect(store.confirmSignedInUser).not.toHaveBeenCalled();
  });
});

describe('signing out', () => {
  it('seals the recorder', () => {
    auth.status = 'signedOut';
    render();
    expect(store.signOut).toHaveBeenCalledTimes(1);
    expect(store.confirmSignedInUser).not.toHaveBeenCalled();
  });

  it('does not seal a live hike when a token refresh flickers the session', () => {
    auth.status = 'signedIn';
    auth.signedInAt = Date.now();
    query.me = { data: { id: 'usr_a' }, dataUpdatedAt: Date.now() + 1_000 };
    render();
    expect(store.confirmSignedInUser).toHaveBeenCalledWith('usr_a');
    // A refresh in flight reports `loading`, not `signedOut`. Treating the two alike would run
    // the whole seal-and-reset path against a recording in progress.
    auth.status = 'loading';
    render();
    expect(store.signOut).not.toHaveBeenCalled();
  });
});
