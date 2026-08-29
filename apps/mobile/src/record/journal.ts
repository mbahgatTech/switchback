import { trackFixSchema, type TrackFix } from '@switchback/core';

/**
 * The on-disk shape of a recording in progress, and the rules for reading one back.
 *
 * Pure on purpose — no `expo-*` import — so it loads under plain node and is testable without a
 * phone, the same reason `@/offline/titled` exists. `@/record/journal-files` supplies the files.
 *
 * Two files rather than one. The head is small and rewritten whenever something about the session
 * changes; the fixes are appended a line at a time and never rewritten. A recording that runs for
 * six hours in a pocket writes about 80 bytes per fix instead of re-serialising the whole track
 * once a second.
 */

/** Bumped when the shape below changes. A journal at any other version is dropped, not migrated. */
export const JOURNAL_VERSION = 2;

/** Everything about a recording except its fixes. Rewritten on start, on flush, and on pause. */
export interface JournalHead {
  v: number;
  id: string;
  /**
   * Who this track belongs to. A recording is a per-second location history, and the device it
   * was made on can be handed to somebody else — so a journal is readable only by the identity
   * that created it, and erased rather than shown to any other.
   */
  ownerId: string | null;
  /** Epoch milliseconds. `TrackFix.t` counts seconds from here. */
  startedAt: number;
  trailId: string | null;
  routeId: string | null;
  /** Fixes already acknowledged by the server. Only ever advances. */
  sent: number;
  /**
   * Whether the hike was meant to still be running when this head was last written. A hike the
   * user paused or finished is not, and must not silently restart itself on the next launch.
   */
  live: boolean;
}

/**
 * The files, behind an interface. `store.ts` constructing `expo-file-system` objects inline is
 * what made it untestable, and untested is how a batch of eight readings came to collapse into
 * one fix without anything noticing.
 */
export interface JournalStore {
  readHead(): string | null;
  /** Staged and renamed into place: a reader never observes a partially written head. */
  writeHead(raw: string): void;
  readFixes(): string | null;
  appendFixes(raw: string): void;
  /** Rewrites the fixes file whole. Used once at restore, to repair a torn tail. */
  rewriteFixes(raw: string): void;
  /** Replaces whatever the last hike left with an empty journal. */
  open(): void;
  clear(): void;
  /** Erases journals written in formats this build no longer reads. */
  clearLegacy(): void;
}

export function encodeHead(head: JournalHead): string {
  return JSON.stringify(head);
}

/** The stored head, or nothing if this file cannot be trusted to name a real activity. */
export function decodeHead(raw: string): JournalHead | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  // A head from another version may name an activity id the server never issued, or count `sent`
  // against a different batching rule. Dropping it loses one hike; adopting it corrupts one.
  if (record.v !== JOURNAL_VERSION) return null;
  if (typeof record.id !== 'string' || typeof record.startedAt !== 'number') return null;
  return {
    v: JOURNAL_VERSION,
    id: record.id,
    ownerId: typeof record.ownerId === 'string' ? record.ownerId : null,
    startedAt: record.startedAt,
    trailId: typeof record.trailId === 'string' ? record.trailId : null,
    routeId: typeof record.routeId === 'string' ? record.routeId : null,
    sent: typeof record.sent === 'number' && record.sent >= 0 ? Math.floor(record.sent) : 0,
    live: record.live === true,
  };
}

/**
 * Fixes as lines to append. Every line is terminated, so a later append starts on its own line.
 *
 * The schema runs here rather than on the way back in. It is the contract the server enforces on
 * arrival, and a line that would be refused there makes `flush` retry the same batch forever,
 * since `sent` only advances once an upload resolves — so it is checked once per fix, on the
 * append path, and not again over twenty thousand lines every time the app launches.
 */
export function encodeFixes(fixes: readonly TrackFix[]): string {
  let out = '';
  for (const fix of fixes) {
    const parsed = trackFixSchema.safeParse(fix);
    if (parsed.success) out += JSON.stringify(parsed.data) + '\n';
  }
  return out;
}

/** What a fixes file was worth, and whether reading it left the file fit to append to. */
export interface DecodedFixes {
  fixes: TrackFix[];
  /**
   * True when the last line had no terminator — a write cut off by a kill. The fragment itself is
   * already dropped, but the *next* append would concatenate onto it and cost a second fix, so
   * the caller rewrites the file before recording any more.
   */
  torn: boolean;
}

/**
 * Every fix the file can be trusted for. A line that does not parse, or that is not shaped like a
 * fix, is skipped rather than thrown: the realistic damage is a final line cut in half by a kill
 * mid-append, and losing one second of a hike to that is the whole point of appending.
 *
 * Structural rather than `trackFixSchema` — deliberately, and measured. Every line here was
 * written by `encodeFixes`, which already ran the schema over it; running it again costs 125 ms
 * against 23 ms for an eight-hour journal, on the launch path, on Hermes, while somebody stands
 * at a trailhead waiting for the app to open.
 */
export function decodeFixes(raw: string): DecodedFixes {
  const fixes: TrackFix[] = [];
  const lines = raw.split('\n');
  for (const line of lines) {
    if (line.length === 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (isFix(value)) fixes.push(value);
  }
  return { fixes, torn: raw.length > 0 && !raw.endsWith('\n') };
}

/**
 * What phase a restored recording takes. `recording` only when the OS still holds the location
 * task: that is the difference between an app iOS restarted to hand it a position — where the
 * hike genuinely never stopped — and a crash or a force-quit, after which the honest thing is to
 * come back paused and ask.
 */
export function restoredPhase(head: JournalHead, stillTracking: boolean): 'recording' | 'paused' {
  return head.live && stillTracking ? 'recording' : 'paused';
}

/** What to do with a stored journal, given who is signed in now. */
export type OwnerVerdict = 'restore' | 'erase' | 'wait';

/**
 * Whether this journal may be shown to the person at the phone.
 *
 * `wait` when nobody is confirmed signed in: absence of an identity is never treated as a
 * mismatch, because changing identity requires a network sign-in through our own server, so an
 * offline launch cannot be a different user than the launch before it. Refusing to restore
 * offline would lose a hike to a hazard that cannot occur offline.
 *
 * A head with no owner is erased rather than adopted. It can only come from a hike begun before
 * the signed-in user was known, and handing an unattributable location trace to the first
 * identity that happens to appear is the failure this function exists to prevent.
 */
export function ownerVerdict(head: JournalHead, signedInUser: string | null): OwnerVerdict {
  if (signedInUser === null) return 'wait';
  return head.ownerId === signedInUser ? 'restore' : 'erase';
}

/** The shape `encodeFixes` writes. Cheap by design — see the note on `decodeFixes`. */
function isFix(value: unknown): value is TrackFix {
  if (typeof value !== 'object' || value === null) return false;
  const fix = value as Record<string, unknown>;
  if (typeof fix.t !== 'number' || !Number.isFinite(fix.t) || fix.t < 0) return false;
  if (typeof fix.lng !== 'number' || !Number.isFinite(fix.lng)) return false;
  return typeof fix.lat === 'number' && Number.isFinite(fix.lat);
}
