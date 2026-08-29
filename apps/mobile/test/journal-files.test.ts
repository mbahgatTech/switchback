import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The journal's actual filesystem behaviour, which the store's in-memory double cannot speak for.
 *
 * The double reports a stage and a commit because it is written to; this asserts that the real
 * store writes a staging file and moves it, and that a kill in the window where `moveSync` has
 * removed the live head but not yet put the new one in place still leaves a readable hike. Swap
 * the move for a direct write and these fail, which is the point.
 */

const disk = vi.hoisted(() => ({
  files: new Map<string, { text: string }>(),
  dirs: new Set<string>(),
  /** Fails the second half of a move, the way a kill between remove and rename would. */
  breakMoveAfterRemove: false,
  /** A full disk. */
  refuseWrites: false,
  writes: [] as string[],
  moves: [] as string[],
}));

function key(parts: unknown[]): string {
  return parts
    .map((part) => (typeof part === 'string' ? part : ((part as { path: string }).path ?? '')))
    .filter(Boolean)
    .join('/');
}

vi.mock('expo-file-system', () => {
  class Directory {
    path: string;
    constructor(...parts: unknown[]) {
      this.path = key(parts);
    }
    get exists() {
      return disk.dirs.has(this.path);
    }
    create() {
      disk.dirs.add(this.path);
    }
    delete() {
      disk.dirs.delete(this.path);
      for (const name of [...disk.files.keys()]) {
        if (name.startsWith(`${this.path}/`)) disk.files.delete(name);
      }
    }
  }
  class File {
    path: string;
    constructor(...parts: unknown[]) {
      this.path = key(parts);
    }
    get exists() {
      return disk.files.has(this.path);
    }
    create() {
      disk.files.set(this.path, { text: '' });
    }
    delete() {
      disk.files.delete(this.path);
    }
    textSync() {
      const node = disk.files.get(this.path);
      if (!node) throw new Error(`no such file: ${this.path}`);
      return node.text;
    }
    write(raw: string, options?: { append?: boolean }) {
      if (disk.refuseWrites) throw new Error('no space left on device');
      disk.writes.push(this.path);
      const previous = options?.append ? (disk.files.get(this.path)?.text ?? '') : '';
      disk.files.set(this.path, { text: previous + raw });
    }
    moveSync(destination: { path: string }) {
      disk.moves.push(`${this.path} -> ${destination.path}`);
      // iOS removes the destination and then moves; both steps can fail independently.
      disk.files.delete(destination.path);
      if (disk.breakMoveAfterRemove) throw new Error('killed between remove and move');
      const node = disk.files.get(this.path);
      if (node) disk.files.set(destination.path, node);
      disk.files.delete(this.path);
    }
  }
  return { Directory, File, Paths: { document: 'Documents' } };
});

const { fileJournalStore } = await import('../src/record/journal-files');
const { JOURNAL_VERSION } = await import('../src/record/journal');

beforeEach(() => {
  disk.files.clear();
  disk.dirs.clear();
  disk.writes = [];
  disk.moves = [];
  disk.breakMoveAfterRemove = false;
  disk.refuseWrites = false;
});

describe('writing the head', () => {
  it('writes a staging file and moves it, never the live head directly', () => {
    fileJournalStore().writeHead('{"v":2}');
    expect(disk.writes).toEqual(['Documents/recording-v2/head.json.staged']);
    expect(disk.moves).toEqual([
      'Documents/recording-v2/head.json.staged -> Documents/recording-v2/head.json',
    ]);
  });

  it('leaves the live head readable afterwards', () => {
    const store = fileJournalStore();
    store.writeHead('{"v":2,"id":"act_1"}');
    expect(store.readHead()).toBe('{"v":2,"id":"act_1"}');
  });
});

describe('a kill inside the move, where neither head is in place', () => {
  it('still returns a complete head, from the staged copy', () => {
    const store = fileJournalStore();
    store.writeHead('{"v":2,"id":"act_1"}');
    disk.breakMoveAfterRemove = true;
    // The second write removes the live head and then dies, exactly as iOS orders the two steps.
    store.writeHead('{"v":2,"id":"act_1","sent":500}');
    expect(disk.files.has('Documents/recording-v2/head.json')).toBe(false);
    expect(store.readHead()).toBe('{"v":2,"id":"act_1","sent":500}');
  });
});

describe('the fixes file', () => {
  it('appends rather than replacing', () => {
    const store = fileJournalStore();
    store.open();
    store.appendFixes('{"t":0}\n');
    store.appendFixes('{"t":1}\n');
    expect(store.readFixes()).toBe('{"t":0}\n{"t":1}\n');
  });

  it('is rewritten whole only when asked', () => {
    const store = fileJournalStore();
    store.open();
    store.appendFixes('{"t":0}\n{"t":1');
    store.rewriteFixes('{"t":0}\n');
    expect(store.readFixes()).toBe('{"t":0}\n');
  });
});

describe('a write the filesystem refuses', () => {
  /*
   * A full disk, most likely. The hike carrying on is deliberate — telling somebody their storage
   * is full halfway up a mountain helps nobody — but durability being entirely gone with nothing
   * anywhere recording it is a different thing, and the caller has to be able to see it.
   */

  it('says so, rather than reporting a fix that never reached the disk', () => {
    const store = fileJournalStore();
    store.open();
    disk.refuseWrites = true;
    expect(store.appendFixes('{"t":0}\n')).toBe(false);
  });

  it('says so for the head as well', () => {
    const store = fileJournalStore();
    disk.refuseWrites = true;
    expect(store.writeHead('{"v":2}')).toBe(false);
  });

  it('reports a write that did land', () => {
    const store = fileJournalStore();
    store.open();
    expect(store.appendFixes('{"t":0}\n')).toBe(true);
    expect(store.writeHead('{"v":2}')).toBe(true);
  });
});

describe('erasure', () => {
  it('takes the whole journal directory, staged head included', () => {
    const store = fileJournalStore();
    store.open();
    store.writeHead('{"v":2}');
    store.appendFixes('{"t":0}\n');
    store.clear();
    expect(store.readHead()).toBeNull();
    expect(store.readFixes()).toBeNull();
  });

  it('deletes a journal written in a format this build no longer reads', () => {
    disk.files.set('Documents/recording-v1.json', { text: '{"v":1}' });
    fileJournalStore().clearLegacy();
    expect(disk.files.has('Documents/recording-v1.json')).toBe(false);
  });

  it('sweeps every format below this one, whatever this one is', () => {
    // Derived from `JOURNAL_VERSION` rather than listed, for the same reason the live directory
    // is: a hardcoded list strands a full GPS trace at the next bump, with no sweep and no age
    // horizon to catch it. v1 was a flat file; every version since has been a directory.
    disk.files.set('Documents/recording-v1.json', { text: '{"v":1}' });
    for (let v = 1; v < JOURNAL_VERSION; v += 1) {
      disk.dirs.add(`Documents/recording-v${v}`);
      disk.files.set(`Documents/recording-v${v}/fixes.ndjson`, { text: '{"t":0}' });
    }

    fileJournalStore().clearLegacy();

    expect(disk.files.has('Documents/recording-v1.json')).toBe(false);
    for (let v = 1; v < JOURNAL_VERSION; v += 1) {
      expect(disk.dirs.has(`Documents/recording-v${v}`)).toBe(false);
      expect(disk.files.has(`Documents/recording-v${v}/fixes.ndjson`)).toBe(false);
    }
  });

  it('leaves the format this build actually reads alone', () => {
    const store = fileJournalStore();
    store.open();
    store.appendFixes('{"t":0}\n');
    store.clearLegacy();
    expect(store.readFixes()).toBe('{"t":0}\n');
  });
});
