/**
 * Who this browser is acting as, and whether a queued row is theirs. Kept in `localStorage` rather
 * than a React context because a write needs the answer synchronously, not one render stale.
 */

/**
 * Where the remembered reader is kept. `localStorage` and not a cookie: the server never needs it,
 * and it has to survive with no network.
 */
const READER_KEY = 'sb-reader';

/** What is stored for "the server told us nobody is signed in", as against "never asked". */
const NOBODY = '';

export interface RememberedReader {
  /** The account the browser is acting as, or null when it is acting as nobody. */
  id: string | null;
  /**
   * False before the first page the network served. Told apart from `id: null` because they mean
   * opposite things: `handover.ts` treats a first sighting as a starting point, not a handover.
   */
  known: boolean;
}

/** Local storage, when there is one. Private mode and locked profiles throw on access. */
function store(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function rememberedReader(): RememberedReader {
  let raw: string | null = null;
  try {
    raw = store()?.getItem(READER_KEY) ?? null;
  } catch {
    // A locked profile throws on the property access above, a sandboxed iframe throws here.
    return { id: null, known: false };
  }
  if (raw === null) return { id: null, known: false };
  return { id: raw === NOBODY ? null : raw, known: true };
}

/**
 * The id a write made right now should be stamped with, and the id a drain running right now may
 * send. Null — acting as nobody, or never told — means unattributed: never sent automatically.
 * **Read at the moment of the write, never from a render**: another tab's sign-in or a bfcache
 * restore makes the rendered answer a person who left while the cookie belongs to the one who came.
 */
export function writingReader(): string | null {
  return rememberedReader().id;
}

/**
 * Does this `storage` event move the remembered reader? A null key means another document called
 * `clear()`, which takes the reader with it, so that counts too.
 */
export function readerKeyChanged(key: string | null): boolean {
  return key === null || key === READER_KEY;
}

export function rememberReader(id: string | null): void {
  try {
    store()?.setItem(READER_KEY, id ?? NOBODY);
  } catch {
    // Full, or refused: the next load treats this reader as new and runs the handover again,
    // which is idempotent, and far better than throwing out of a layout effect.
  }
}

/** Only for tests and for a browser being wiped. Nothing in the product forgets a reader. */
export function forgetReader(): void {
  try {
    store()?.removeItem(READER_KEY);
  } catch {
    /* See `rememberReader`. */
  }
}

/**
 * May this browser, acting as `readerId`, send this row? The only question either drain asks, and
 * both nulls are refusals: an unowned row belongs to nobody, and a signed-out browser owns nothing.
 */
export function ownedBy(row: { userId: string | null }, readerId: string | null): boolean {
  return row.userId !== null && row.userId === readerId;
}

/**
 * Is the browser still acting as the reader a drain started under? `ownedBy` answers "may this row
 * go" once; a drain is minutes of requests, and the account can change in the middle. Both drains
 * ask this immediately before every request and stop — without marking or deleting — on a no.
 * `ask` is injected so `queue.ts` and `activities.ts` stay testable with no `localStorage`.
 */
export function stillActingAs(readerId: string | null, ask: () => string | null): boolean {
  return ask() === readerId;
}

/** A row nobody can be named for: the migration case, and the only one a person is asked about. */
export function isUnattributed(row: { userId: string | null }): boolean {
  return row.userId === null;
}

/** Somebody else's — countable, never readable, never sendable. */
export function heldForAnother(row: { userId: string | null }, readerId: string | null): boolean {
  return row.userId !== null && row.userId !== readerId;
}
