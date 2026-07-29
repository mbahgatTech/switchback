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
 * So the schema is declared once, both stores are created together, and the modules above own
 * only what goes in them.
 *
 * Hand-rolled rather than wrapped in a library. Two object stores, one key path, and no
 * migrations beyond adding a store; the wrapper would be larger than the thing it wrapped.
 */

const DB_NAME = 'switchback-offline';

/**
 * Version 1 held downloads. Version 2 added the queue.
 *
 * The upgrade creates whatever it does not find rather than switching on the version it came
 * from, so a browser arriving from 1, from nothing, or from a rolled-back deploy all end up
 * holding the same two stores.
 */
const DB_VERSION = 2;

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

const STORES = [TRAILS_STORE, PENDING_REVIEWS_STORE] as const;

/** Both stores key on `trailId`, which is why one key path covers the whole schema. */
const KEY_PATH = 'trailId';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: KEY_PATH });
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
