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

/** The single file v1 wrote. Every format since has been a directory, so it is named apart. */
const V1_FILE_NAME = 'recording-v1.json';

/**
 * The directories of formats this build no longer reads, derived for the same reason
 * `JOURNAL_DIR` is. A hardcoded list strands a whole GPS trace at the next version bump, with no
 * sweep to take it and no age horizon behind it — `docs/mobile.md` promises the opposite.
 */
function legacyDirNames(): string[] {
  const names: string[] = [];
  for (let version = 1; version < JOURNAL_VERSION; version += 1) {
    names.push(`recording-v${version}`);
  }
  return names;
}

/** Deletes an entry if it is there. A failure here is not actionable and nothing depends on it. */
function remove(entry: { exists: boolean; delete(): void }): void {
  try {
    if (entry.exists) entry.delete();
  } catch {
    /* Nothing to do about it. */
  }
}

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
    /**
     * The live head, or the staged one when the live head is missing.
     *
     * `moveSync(..., { overwrite: true })` is `removeItem` then `moveItem` on iOS, not an atomic
     * rename — there is a window in which neither file is in place, and a kill inside it would
     * otherwise throw a whole hike away. The staged copy is only ever a complete write, and
     * `decodeHead` is what decides whether to believe it.
     */
    readHead: () => readText(HEAD_NAME) ?? readText(STAGED_HEAD_NAME),

    writeHead(raw) {
      try {
        dir().create({ intermediates: true, overwrite: true });
        const staged = file(STAGED_HEAD_NAME);
        if (staged.exists) staged.delete();
        staged.create();
        staged.write(raw);
        // Staging is what keeps a half-written head off the live path: `expo-file-system`'s string
        // write is not atomic, and a head that will not parse is a hike thrown away. The move that
        // follows is not atomic either, so `readHead` falls back to the staged copy for the window
        // in which neither file exists.
        staged.moveSync(file(HEAD_NAME), { overwrite: true });
        return true;
      } catch {
        // A full disk, most likely. The hike carries on — saying so mid-climb helps nobody — but
        // the caller is told, so somewhere it can be acted on says it.
        return false;
      }
    },

    readFixes: () => readText(FIXES_NAME),

    appendFixes(raw) {
      try {
        file(FIXES_NAME).write(raw, { append: true });
        return true;
      } catch {
        return false;
      }
    },

    rewriteFixes(raw) {
      try {
        file(FIXES_NAME).write(raw);
        return true;
      } catch {
        return false;
      }
    },

    open() {
      try {
        this.clear();
        dir().create({ intermediates: true });
        file(FIXES_NAME).create();
        return true;
      } catch {
        return false;
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
      remove(new FileSystem.File(FileSystem.Paths.document, V1_FILE_NAME));
      for (const name of legacyDirNames()) {
        remove(new FileSystem.Directory(FileSystem.Paths.document, name));
      }
    },
  };
}
