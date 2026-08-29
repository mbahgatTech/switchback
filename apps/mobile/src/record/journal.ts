import type { TrackFix } from '@switchback/core';

/**
 * The on-disk shape of a recording in progress, and the rules for reading one back.
 *
 * Pure on purpose — no `expo-*` import — so it loads under plain node and is testable without a
 * phone, the same reason `@/offline/titled` exists. `@/record/store` owns the files themselves.
 *
 * Two files rather than one. The head is small and rewritten whenever something about the
 * session changes; the fixes are appended a line at a time and never rewritten. A recording that
 * runs for six hours in a pocket writes about 80 bytes per fix instead of re-serialising the
 * whole track once a second, which is the difference between a background recording the battery
 * survives and one it does not.
 */

/** Bumped when the shape below changes. A journal at any other version is dropped, not migrated. */
export const JOURNAL_VERSION = 2;

/** Everything about a recording except its fixes. Rewritten on start, on flush, and on pause. */
export interface JournalHead {
  v: number;
  id: string;
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
    startedAt: record.startedAt,
    trailId: typeof record.trailId === 'string' ? record.trailId : null,
    routeId: typeof record.routeId === 'string' ? record.routeId : null,
    sent: typeof record.sent === 'number' && record.sent >= 0 ? Math.floor(record.sent) : 0,
    live: record.live === true,
  };
}

/** Fixes as lines to append. Every line is terminated, so a later append starts on its own line. */
export function encodeFixes(fixes: readonly TrackFix[]): string {
  return fixes.map((fix) => `${JSON.stringify(fix)}\n`).join('');
}

/**
 * Every fix the file can be trusted for. A line that does not parse is skipped rather than
 * thrown: the realistic damage is a final line cut in half by a kill mid-append, and losing one
 * second of a hike to that is the whole point of appending a line at a time.
 */
export function decodeFixes(raw: string): TrackFix[] {
  const out: TrackFix[] = [];
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (isFix(value)) out.push(value);
  }
  return out;
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

function isFix(value: unknown): value is TrackFix {
  if (typeof value !== 'object' || value === null) return false;
  const fix = value as Record<string, unknown>;
  if (!Number.isFinite(fix.t) || (fix.t as number) < 0) return false;
  if (!Number.isFinite(fix.lng) || !Number.isFinite(fix.lat)) return false;
  return optionalNumber(fix.eleM) && optionalNumber(fix.accuracyM) && optionalNumber(fix.speedMps);
}

function optionalNumber(value: unknown): boolean {
  return value === undefined || value === null || Number.isFinite(value);
}
