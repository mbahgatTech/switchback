/**
 * Who this browser is acting as.
 *
 * The offline queue exists to hold writes that cannot be sent yet, and a write that cannot be
 * sent yet is a write whose author cannot be checked yet either. Until this module existed
 * there was nothing on a queued row that said whose it was, and nothing anywhere that noticed
 * the person at the keyboard had changed — so a report written on a shared laptop by the
 * person who left was posted, whole, under the name of the person who arrived.
 *
 * Two facts are kept here and nowhere else.
 *
 * **The remembered reader.** One string in `localStorage`, written only by `ReaderIdentity` in
 * the root layout and only from a page the network actually served. That last clause is the
 * load-bearing one: a page served from Cache Storage is the *previous* reader's HTML, so
 * trusting the id in it would let a stale copy re-assert an account that has since gone. What
 * makes reading it safe at all is that `handover.ts` deletes those copies the moment the
 * reader changes, so there is never a cached page belonging to somebody other than the
 * remembered reader.
 *
 * `localStorage` rather than a React context threaded from the layout, because the two places
 * that most need this — the recorder writing a fix on a ridge and the report form catching a
 * failed post — are deep in the tree, are already holding a dozen values, and need the answer
 * *synchronously at the moment of the write*. A hook would give them a value that is one
 * render stale exactly when the reader has just changed, which is the case that matters.
 *
 * **Whether a row is this reader's.** `ownedBy` is the only test the drains are allowed to
 * make, and it is deliberately strict in both directions: a row with no owner belongs to
 * nobody rather than to everybody, and a browser with no session owns nothing rather than
 * everything.
 */

/**
 * Where the remembered reader is kept.
 *
 * `localStorage` and not a cookie: a cookie would be sent to the server on every request, and
 * this is a note the browser writes to itself about a decision the server already made. It
 * also has to survive with no network, which is the whole point.
 */
const READER_KEY = 'sb-reader';

/** What is stored for "the server told us nobody is signed in", as against "never asked". */
const NOBODY = '';

export interface RememberedReader {
  /** The account the browser is acting as, or null when it is acting as nobody. */
  id: string | null;
  /**
   * False before the first page the network served — a brand-new browser, or one that has not
   * loaded a page since this shipped.
   *
   * Told apart from `id: null` because they mean opposite things. "Nobody is signed in" is a
   * fact worth acting on; "we have never looked" is not, and `handover.ts` treats the first
   * sighting as a starting point rather than as a change of hands.
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
    // A quota error on read is not a thing, but a locked profile throws on the property
    // access above and a sandboxed iframe throws here. Neither is worth failing a hike over.
    return { id: null, known: false };
  }
  if (raw === null) return { id: null, known: false };
  return { id: raw === NOBODY ? null : raw, known: true };
}

/**
 * The id a write made right now should be stamped with, and the id a drain running right now
 * may send.
 *
 * Null when the browser is acting as nobody, and null when it has never been told — both of
 * which mean the same thing to a row being written: **unattributed**. Such a row is never sent
 * automatically and never adopted silently; it is shown to a person and claimed or discarded
 * by hand. See `handover.ts`.
 *
 * **Read at the moment of the write, never from a render.** A React value is a snapshot of who
 * was here when something last rendered, and the whole of this file exists because that is not
 * the same as who is here now: another tab signs in, or a document comes back out of the
 * back/forward cache, and the rendered answer is a person who left while the cookie on the
 * request belongs to the person who arrived. Sending on the rendered answer is how a report
 * written by one hiker is published under another — which is the defect, not a symptom of it.
 * So `sync.tsx` and `use-queue.ts` call this function at the moment they act, and use the
 * subscribed value from `reader.tsx` only to decide what to *draw*.
 */
export function writingReader(): string | null {
  return rememberedReader().id;
}

/**
 * Does this `storage` event move the remembered reader?
 *
 * `storage` fires on every *other* document of this origin, which is the only notice a tab
 * gets that somebody signed in elsewhere. A null key means another document called `clear()`,
 * which takes the reader with it, so that counts too.
 */
export function readerKeyChanged(key: string | null): boolean {
  return key === null || key === READER_KEY;
}

export function rememberReader(id: string | null): void {
  try {
    store()?.setItem(READER_KEY, id ?? NOBODY);
  } catch {
    // Full, or refused. The consequence is that the next load treats this reader as new and
    // runs the handover again, which is idempotent — a worse outcome than remembering, and a
    // far better one than throwing out of a layout effect.
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
 * May this browser, acting as `readerId`, send this row?
 *
 * The whole of the answer, and the only question either drain asks. Both `null`s are refusals
 * rather than matches:
 *
 * - A row with `userId: null` was written before anything recorded authorship, or by a browser
 *   that could not name a session. Sending it would be a guess about a person, made silently,
 *   about words they wrote — which is precisely the defect this file exists to close.
 * - A reader of `null` is a signed-out browser. It owns nothing, so a drain that runs before
 *   somebody signs in sends nothing rather than everything.
 */
export function ownedBy(row: { userId: string | null }, readerId: string | null): boolean {
  return row.userId !== null && row.userId === readerId;
}

/** A row nobody can be named for: the migration case, and the only one a person is asked about. */
export function isUnattributed(row: { userId: string | null }): boolean {
  return row.userId === null;
}

/** Somebody else's — countable, never readable, never sendable. */
export function heldForAnother(row: { userId: string | null }, readerId: string | null): boolean {
  return row.userId !== null && row.userId !== readerId;
}
