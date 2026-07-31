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
 * journal and the hikes it owes the server.
 *
 * The upgrade creates whatever it does not find rather than switching on the version it came
 * from, so a browser arriving from 1, from 2, from nothing, or from a rolled-back deploy all
 * end up holding the same four stores.
 */
const DB_VERSION = 3;

/** One row per downloaded trail. */
export const TRAILS_STORE = 'trails';

/**
 * One row per report written where there was nothing to file it with.
 *
 * Keyed by trail id like the other store, and for the same reason it is keyed that way in
 * Postgres: one report per person per trail. Writing a second draft for a trail replaces the
 * first, which is exactly what amending one means.
 */
export const PENDING_REVIEWS_STORE = 'pending-reviews';

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
 * activity and index, so the key path is now per store.
 */
const KEY_PATHS: Record<string, string> = {
  [TRAILS_STORE]: 'trailId',
  [PENDING_REVIEWS_STORE]: 'trailId',
  [PENDING_ACTIVITIES_STORE]: 'activityId',
  [ACTIVITY_FIXES_STORE]: 'key',
};

const STORES = Object.keys(KEY_PATHS);

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
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open the offline store.'));
  });
}

/**
 * One request, in its own transaction, on a connection that is closed afterwards.
 *
 * **It resolves on the transaction's commit, not on the request's success**, and that
 * distinction is what two callers above this file are built on. A `put` reports success as
 * soon as the object store has accepted it, which is some way short of "the write happened":
 * the transaction can still abort afterwards — eviction under storage pressure, a tab torn
 * down mid-commit, a quota error raised at commit time — and the value goes with it. This
 * used to resolve on `request.onsuccess`, so `markFinished` returning meant "accepted", while
 * the caller reading it — the offline branch of `onFinish` — treats it as "known to have
 * happened": on the strength of it `handOff()` throws away the in-memory buffer, which that
 * code calls the last copy of the day, and the screen prints "Saved on this device". Same for
 * `writeChunk`, which `writeJournal` awaits before writing a header whose `count` describes
 * those fixes. So the result is captured on success and handed back on commit, and an abort
 * rejects rather than resolving into silence.
 *
 * The connection is closed on the transaction rather than after the request for the same
 * reason. Holding one open across the tab's life would be faster and would also block the
 * next version upgrade until every tab was shut.
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
        // Definite-assignment: `oncomplete` cannot fire without the request having succeeded
        // first — a transaction whose only request failed aborts instead of committing.
        let result!: T;
        request.onsuccess = () => {
          result = request.result;
        };
        request.onerror = () => reject(request.error ?? new Error('Offline store write failed.'));
        tx.oncomplete = () => {
          db.close();
          resolve(result);
        };
        tx.onabort = () => {
          db.close();
          reject(tx.error ?? new Error('Offline store write failed.'));
        };
      }),
  );
}
