import * as FileSystem from 'expo-file-system';
import { JOURNAL_VERSION, type JournalStore } from './journal';

/**
 * The journal on disk. Everything `expo-file-system` in the recorder is here, behind
 * `JournalStore`, so the state machine can be tested against an in-memory store.
 *
 * **Documents, not Caches**, matching `@/offline/store`: iOS empties Caches under storage
 * pressure, and the one file a recording cannot afford to lose is the one it is writing. The cost
 * is that a track rides into iCloud backups, which for a continuous all-day trace is a real
 * disclosure — so nothing is kept beyond the hike being recorded: `clear` runs on finish, on
 * discard, and on any identity that is not the one that made it.
 *
 * At rest the file inherits the app's default protection class, which iOS unlocks after first
 * authentication and leaves unlocked. That is not a shrug: a recording is written while the phone
 * is locked in a pocket, so `NSFileProtectionComplete` would make the writes fail exactly when
 * they matter. `docs/mobile.md` carries the trade-off.
 */

/** Derived, so the directory and the format version cannot drift apart. */
const JOURNAL_DIR = `recording-v${JOURNAL_VERSION}`;
const HEAD_NAME = 'head.json';
const STAGED_HEAD_NAME = 'head.json.staged';
const FIXES_NAME = 'fixes.ndjson';

/** Journals from formats this build no longer reads. Deleted, not ignored — see `clearLegacy`. */
const LEGACY_NAMES = ['recording-v1.json'];

export function fileJournalStore(): JournalStore {
  const dir = (): FileSystem.Directory =>
    new FileSystem.Directory(FileSystem.Paths.document, JOURNAL_DIR);
  const file = (name: string): FileSystem.File => new FileSystem.File(dir(), name);

  const readText = (name: string): string | null => {
    try {
      const handle = file(name);
      return handle.exists ? handle.textSync() : null;
    } catch {
      return null;
    }
  };

  return {
    readHead: () => readText(HEAD_NAME),

    writeHead(raw) {
      try {
        dir().create({ intermediates: true, overwrite: true });
        const staged = file(STAGED_HEAD_NAME);
        if (staged.exists) staged.delete();
        staged.create();
        staged.write(raw);
        // The rename is what makes the head atomic. `expo-file-system`'s string write is not —
        // it writes non-atomically, so a kill mid-write leaves a head that will not parse, and a
        // head that will not parse is a hike thrown away. A reader sees the old head or the new
        // one, never half of either.
        staged.moveSync(file(HEAD_NAME), { overwrite: true });
      } catch {
        // A full disk, most likely. Durability degrades; the hike carries on, because saying so
        // mid-hike is worse than carrying on.
      }
    },

    readFixes: () => readText(FIXES_NAME),

    appendFixes(raw) {
      try {
        file(FIXES_NAME).write(raw, { append: true });
      } catch {
        /* As above. */
      }
    },

    rewriteFixes(raw) {
      try {
        file(FIXES_NAME).write(raw);
      } catch {
        /* As above. */
      }
    },

    open() {
      try {
        this.clear();
        dir().create({ intermediates: true });
        file(FIXES_NAME).create();
      } catch {
        /* As above. */
      }
    },

    clear() {
      try {
        const target = dir();
        if (target.exists) target.delete();
      } catch {
        /* Nothing to do about it, and nothing depends on it. */
      }
    },

    clearLegacy() {
      for (const name of LEGACY_NAMES) {
        try {
          const stale = new FileSystem.File(FileSystem.Paths.document, name);
          if (stale.exists) stale.delete();
        } catch {
          /* As above. */
        }
      }
    },
  };
}
