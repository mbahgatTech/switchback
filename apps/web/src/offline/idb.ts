/**
 * The device's own database, and the one place its schema is declared.
 *
 * Two things live here: the ledger of what has been downloaded, and the queue of writes made
 * where there was no signal to make them over. They are separate concerns with separate
 * modules above this one, but they cannot be separate *databases* without a real cost —
 * `onupgradeneeded` fires once per version for a whole database, so two modules each opening
 * "their own" store at their own version would race. Whichever opened first would create its
 * store, and the other's would be missing until a version bump that never comes.
 *
 * So the schema is declared once, every store is created together, and the modules above own
 * only what goes in them.
 *
 * Hand-rolled rather than wrapped in a library. Four object stores, one key path each, and no
 * migrations beyond adding a store; the wrapper would be larger than the thing it wrapped.
 */

const DB_NAME = 'switchback-offline';

/**
 * Version 1 held downloads. Version 2 added the review queue. Version 3 added the recording
 * journal and the hikes it owes the server. Version 4 re-keyed the review queue on the person
 * as well as the trail — see `PENDING_REVIEWS_STORE`.
 *
 * The upgrade creates whatever it does not find rather than switching on the version it came
 * from, so a browser arriving from 1, from 2, from nothing, or from a rolled-back deploy all
 * end up holding the same four stores.
 */
const DB_VERSION = 4;

/** One row per downloaded trail. */
export const TRAILS_STORE = 'trails';

/**
 * One row per report written where there was nothing to file it with.
 *
 * Keyed by *person and* trail. Postgres keys the published report `[trailId, userId]` and this
 * store used to key it on the trail alone, which was right for as long as a browser was
 * assumed to hold one hiker. It does not: a shared laptop holds whoever last sat at it, and on
 * the trail-only key a second person writing about the same trail did not queue a second
 * report — `put` silently replaced the first person's, which is the one outcome `queue.ts`
 * promises never to produce. Amending your own draft still replaces it, because your own key
 * is the same key.
 *
 * The value is built by `reviewKey`, and it is the row's `key` field rather than a composite
 * key path so that the store keeps a single string key and `get`/`delete` stay one argument.
 */
export const PENDING_REVIEWS_STORE = 'pending-reviews-owned';

/**
 * What version 3 and earlier called the review queue, keyed on `trailId`.
 *
 * Read once, by the upgrade below, and then dropped. Nothing else may touch it: a row that is
 * still in here after an upgrade is a row that was lost.
 */
const LEGACY_PENDING_REVIEWS_STORE = 'pending-reviews';

/**
 * The key of a queued report: who wrote it, and which trail it is about.
 *
 * The empty string stands for "the device cannot say who wrote this" — a row carried across
 * from the trail-keyed store, or one written by a browser with no session it could name. It
 * is a real key rather than a missing one so those rows are addressable, listable, and
 * therefore something a person can be shown and asked about, which is the whole of what
 * `handover.ts` does with them.
 *
 * A colon separates the halves. Ids on both sides are cuids, which have no colon in them.
 */
export function reviewKey(userId: string | null, trailId: string): string {
  return `${userId ?? ''}:${trailId}`;
}

/**
 * One row per hike the device is holding on the server's behalf.
 *
 * Keyed by the activity's own id, which the device mints before the first fix — so this row
 * and the server's row are the same hike under the same name from the moment the button is
 * pressed. It is the header only: who, when, how far through the upload it is, and the
 * `finish` payload once there is one.
 */
export const PENDING_ACTIVITIES_STORE = 'pending-activities';

/**
 * The fixes of those hikes, five hundred to a row.
 *
 * Chunked rather than held as one array on the header, because the header is rewritten on
 * every fix and rewriting a growing array on every fix is quadratic — at 1 Hz a six-hour
 * hike would end up serialising a 21,600-element array once a second. A chunk is bounded, so
 * the per-fix cost is constant, and a chunk is exactly one upload batch so the drain never
 * has to re-slice anything.
 */
export const ACTIVITY_FIXES_STORE = 'activity-fixes';

/**
 * What each store keys on.
 *
 * Was a single `trailId` while the schema was the downloads ledger and the review queue,
 * which both key on a trail. A hike is keyed by itself and its chunks by a composite of
 * activity and index; a queued report is keyed by `reviewKey`, which is person and trail. So
 * the key path is now per store.
 */
const KEY_PATHS: Record<string, string> = {
  [TRAILS_STORE]: 'trailId',
  [PENDING_REVIEWS_STORE]: 'key',
  [PENDING_ACTIVITIES_STORE]: 'activityId',
  [ACTIVITY_FIXES_STORE]: 'key',
};

const STORES = Object.keys(KEY_PATHS);

/**
 * Carry the trail-keyed review queue into the person-and-trail-keyed one.
 *
 * Every row arrives **unattributed** — `userId: null` — and that is the honest answer rather
 * than a lazy one. These reports were written before anything recorded whose they were, on a
 * browser that may since have changed hands, and the two tidy alternatives are both wrong:
 * adopting them to whoever is signed in now is exactly the defect this schema change exists
 * to close, and dropping them destroys words that exist nowhere else. So they are kept,
 * marked as belonging to nobody the device can name, never sent automatically, and shown to a
 * person on `/downloads` to be claimed or discarded. See `handover.ts`.
 *
 * Runs inside the upgrade transaction, so it either lands whole or not at all: a browser that
 * is closed half-way through re-runs the same version upgrade next time with the legacy store
 * still in place. The legacy store is dropped only once its rows are written, and only from
 * inside that same transaction.
 */
function carryReviewsForward(db: IDBDatabase, tx: IDBTransaction | null): void {
  if (!tx || !db.objectStoreNames.contains(LEGACY_PENDING_REVIEWS_STORE)) return;

  const legacy = tx.objectStore(LEGACY_PENDING_REVIEWS_STORE);
  const read = legacy.getAll() as IDBRequest<Array<Record<string, unknown>>>;
  read.onsuccess = () => {
    const owned = tx.objectStore(PENDING_REVIEWS_STORE);
    for (const row of read.result) {
      const trailId = typeof row.trailId === 'string' ? row.trailId : null;
      if (trailId === null) continue;
      owned.put({ ...row, key: reviewKey(null, trailId), userId: null, heldAt: null });
    }
    db.deleteObjectStore(LEGACY_PENDING_REVIEWS_STORE);
  };
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: KEY_PATHS[name] });
        }
      }
      carryReviewsForward(db, request.transaction);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open the offline store.'));
  });
}

/**
 * One request, in its own transaction, on a connection that is closed afterwards.
 *
 * The connection is closed on the transaction rather than after the request, so a write is
 * durable before the handle goes away. Holding one open across the tab's life would be
 * faster and would also block the next version upgrade until every tab was shut.
 */
export function run<T>(
  storeName: string,
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const request = work(tx.objectStore(storeName));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('Offline store write failed.'));
        tx.oncomplete = () => db.close();
        tx.onabort = () => db.close();
      }),
  );
}
