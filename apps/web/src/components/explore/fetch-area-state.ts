import type { AreaSummary } from '@switchback/core';

/**
 * What the "fetch this area" control says, decided outside the component.
 *
 * Its own module for the reason `lift.ts` gives: the decision is the part worth testing, and
 * testing it here needs no DOM. The states it has to keep apart — refused, failed, under way,
 * nothing to do — all rendered as a plain "Fetch this area" button before this existed.
 */

/** Why an enqueue was turned down, mirroring `QueueRefusal` in `packages/ingest`. */
export type FetchAreaRefusal = 'queue-depth' | 'storage' | 'rate-limit';

/** What `trails.fetchArea` answered, or `null` while it has never been asked. */
export interface PressResult {
  busy: boolean;
  busyReason: FetchAreaRefusal | null;
  queueWaitHours: number | null;
}

/** The mutation, reduced to the three facts the control reads off it. */
export interface PressState {
  pending: boolean;
  failed: boolean;
  result: PressResult | null;
}

export interface FetchAreaInput {
  area: AreaSummary | null | undefined;
  hasBBox: boolean;
  press: PressState;
}

/** Tiles done over tiles asked for, when a fetch is under way. */
export interface FetchAreaProgress {
  done: number;
  total: number;
  percent: number;
}

/** Which of the four outcomes the line under the button is reporting. */
export type FetchAreaTone = 'failure' | 'refusal' | 'progress' | 'cap';

export interface FetchAreaMessage {
  tone: FetchAreaTone;
  text: string;
}

export interface FetchAreaView {
  label: string;
  disabled: boolean;
  /** Non-null exactly when a fetch is under way, and what the bar fills to. */
  progress: FetchAreaProgress | null;
  message: FetchAreaMessage | null;
  /** What `aria-live` announces, or null when there is nothing moving to announce. */
  liveText: string | null;
}

/**
 * An hours figure as a phrase, always hedged and never precise: the drain rate behind it is a
 * measured mean over a wide distribution, so a minute-level answer would claim an accuracy the
 * number does not have. Lower case, because every caller uses it mid-sentence.
 */
export function describeHours(hours: number | null | undefined): string | null {
  if (typeof hours !== 'number' || !Number.isFinite(hours) || hours <= 0) return null;
  if (hours < 1) return 'less than an hour';

  /*
   * Days only from a full day up. Rounding into days first put everything from 12 h to 36 h under
   * "about a day" — one label over a threefold range, in the one sentence whose whole job is
   * being honest about the wait.
   */
  if (hours >= 24) {
    const days = Math.round(hours / 24);
    return days === 1 ? 'about a day' : `about ${days} days`;
  }

  const whole = Math.round(hours);
  return whole === 1 ? 'about an hour' : `about ${whole} hours`;
}

/** The control's whole state, or `null` when there is nothing to offer and it should not render. */
export function fetchAreaView({ area, hasBBox, press }: FetchAreaInput): FetchAreaView | null {
  if (!area || !hasBBox || area.outstanding === 0) return null;

  const working = area.working;
  const done = area.fresh;
  const percent = area.tiles > 0 ? Math.round((done / area.tiles) * 100) : 0;

  const label =
    working > 0
      ? `${done} of ${area.tiles} tiles`
      : press.pending
        ? 'Queueing…'
        : 'Fetch this area';

  return {
    label,
    disabled: press.pending || working > 0,
    progress: working > 0 ? { done, total: area.tiles, percent } : null,
    message: messageFor(area, press, working),
    liveText: working > 0 ? `Fetching this area: ${done} of ${area.tiles} tiles complete.` : null,
  };
}

/**
 * The one line under the button, in the order a reader needs it: what just went wrong first,
 * then how long what is already moving will take, then the standing caveat about the cap.
 *
 * A refusal is *not* gated on `working` — tiles already in flight are a different fact from a
 * press that queued nothing, and suppressing the refusal because of them reported a turned-down
 * fetch as progress.
 */
function messageFor(
  area: AreaSummary,
  press: PressState,
  working: number,
): FetchAreaMessage | null {
  if (press.failed) {
    /*
     * Deliberately says nothing about what the server did. `isError` covers a dropped connection
     * as well as a rejection, and `queueTiles` commits each tile on its own — so a failed press
     * may have queued some, none, or all of them, and only the refusal below is entitled to
     * claim otherwise. What is safe to promise is the retry, which dedupes.
     */
    return {
      tone: 'failure',
      text: 'That request failed. Try it again — tiles already queued are not fetched twice.',
    };
  }

  if (press.result?.busy) {
    return { tone: 'refusal', text: refusalText(press.result) };
  }

  if (working > 0) {
    const wait = describeHours(area.outstandingHours);
    // No figure rather than a made-up one: an older `map-bridge` payload carries no wait at all.
    return wait === null
      ? null
      : {
          tone: 'progress',
          text: `Fetching them takes ${wait}, and other areas may be queued ahead.`,
        };
  }

  return area.capped
    ? {
        tone: 'cap',
        text: `${area.requiredTiles} tiles in view · one fetch covers the nearest ${area.tiles}`,
      }
    : null;
}

/**
 * Which refusal decides the sentence: a queue drains, storage does not, and a spent allowance is
 * this reader's own.
 *
 * The queue's wait is named rather than a retry window, and that is the correction. `coverage-note`
 * tells the *automatic* path to try again in a few minutes, which is true there — one completed
 * tile puts the depth back under the ceiling, so readmission really is minutes away. Said to
 * somebody who just asked for `MAX_AREA_TILES` at once it reads as a promise about their fetch,
 * and their fetch is a day behind the queue that refused it. The figure comes from the server, so
 * it cannot drift from the measurement that sized the ceiling.
 */
function refusalText({ busyReason, queueWaitHours }: PressResult): string {
  if (busyReason === 'storage') {
    return 'There is no room left to store new ground. Trails already mapped still work.';
  }
  if (busyReason === 'rate-limit') {
    return 'You have fetched a lot of new ground recently. This area can be fetched again later on.';
  }

  const wait = describeHours(queueWaitHours);
  return wait === null
    ? 'Nothing was queued: the fetch queue is full. This area has to wait for it.'
    : `Nothing was queued: the fetch queue already holds ${wait} of fetching. This area has to wait for it.`;
}
