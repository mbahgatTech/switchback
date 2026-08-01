/**
 * The device's own database, and the one place its schema is declared. One database for both the
 * downloads ledger and the write queues: `onupgradeneeded` fires per database, so two would race.
 */

const DB_NAME = 'switchback-offline';

/**
 * The upgrade creates whatever it does not find rather than switching on the version it came from,
 * so a browser arriving from 1, from 2, from nothing or from a rolled-back deploy converges.
 */
const DB_VERSION = 4;

/** One row per downloaded trail. */
export const TRAILS_STORE = 'trails';

/**
 * One row per report written where there was nothing to file it with. Keyed by person *and* trail:
 * on the old trail-only key a second person writing about the same trail silently replaced the
 * first person's row. Amending your own draft still replaces it, because your own key is the same.
 */
export const PENDING_REVIEWS_STORE = 'pending-reviews-owned';

/**
 * What version 3 and earlier called the review queue, keyed on `trailId`. Read once by the upgrade
 * below and then dropped; a row still in here afterwards is a row that was lost.
 */
const LEGACY_PENDING_REVIEWS_STORE = 'pending-reviews';

/**
 * The key of a queued report. The empty string stands for "cannot say who wrote this" — a real key
 * rather than a missing one, so those rows stay addressable and can be shown to a person.
 */
export function reviewKey(userId: string | null, trailId: string): string {
  return `${userId ?? ''}:${trailId}`;
}

/**
 * One row per hike the device is holding on the server's behalf: the header only. Keyed by the
 * activity's own id, which the device mints before the first fix and the server stores under.
 */
export const PENDING_ACTIVITIES_STORE = 'pending-activities';

/**
 * The fixes of those hikes, five hundred to a row. Chunked rather than one array on the header,
 * which is rewritten on every fix: a growing array would make the per-fix cost quadratic.
 */
export const ACTIVITY_FIXES_STORE = 'activity-fixes';

/** What each store keys on. */
const KEY_PATHS: Record<string, string> = {
  [TRAILS_STORE]: 'trailId',
  [PENDING_REVIEWS_STORE]: 'key',
  [PENDING_ACTIVITIES_STORE]: 'activityId',
  [ACTIVITY_FIXES_STORE]: 'key',
};

const STORES = Object.keys(KEY_PATHS);

/**
 * Carries the trail-keyed review queue into the person-and-trail-keyed one. Every row arrives
 * unattributed: adopting them to whoever is signed in now is the defect this re-key closes, and
 * dropping them destroys words that exist nowhere else. Runs inside the upgrade transaction, so it
 * lands whole or not at all — the legacy store is dropped only once its rows are written.
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
 * One request, in its own transaction, on a connection closed afterwards. **Resolves on the
 * transaction's commit, not the request's success**: a `put` reports success as soon as the store
 * accepts it, and the transaction can still abort under storage pressure or a quota error at commit
 * time. Callers treat a resolve as "known to have happened", so an abort must reject.
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
