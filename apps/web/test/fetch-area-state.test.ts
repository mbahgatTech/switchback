import { describe, expect, it } from 'vitest';
import type { AreaSummary } from '@switchback/core';
import { describeHours, fetchAreaView } from '../src/components/explore/fetch-area-state';
import type { FetchAreaView, PressState } from '../src/components/explore/fetch-area-state';

/** Eighty outstanding z9 tiles, the shape a zoomed-out viewport over Detroit produces. */
function area(over: Partial<AreaSummary> = {}): AreaSummary {
  return {
    tiles: 80,
    fresh: 0,
    outstanding: 80,
    working: 0,
    requiredTiles: 80,
    capped: false,
    // 80 tiles at the measured request-kind drain rate. The server sends this; see `toArea`.
    outstandingHours: 3.74,
    ...over,
  };
}

const untried: PressState = { pending: false, failed: false, result: null };

function view(over: Partial<{ area: AreaSummary; press: PressState }> = {}): FetchAreaView {
  const decided = fetchAreaView({
    area: over.area ?? area(),
    hasBBox: true,
    press: over.press ?? untried,
  });
  if (decided === null) throw new Error('expected the control to render');
  return decided;
}

describe('fetchAreaView', () => {
  it('offers the fetch when there is outstanding ground and nothing has been pressed', () => {
    const resting = view();

    expect(resting.label).toBe('Fetch this area');
    expect(resting.disabled).toBe(false);
    expect(resting.progress).toBeNull();
    expect(resting.message).toBeNull();
  });

  it('renders nothing when the area is already covered', () => {
    expect(
      fetchAreaView({ area: area({ outstanding: 0, fresh: 80 }), hasBBox: true, press: untried }),
    ).toBeNull();
  });

  it('reports a failed press rather than returning to the resting label', () => {
    const failed = view({ press: { pending: false, failed: true, result: null } });

    expect(failed.message?.tone).toBe('failure');
    expect(failed.message?.text).toMatch(/\S/u);
    // The whole defect: a rejected mutation was pixel-identical to never having clicked.
    expect(failed).not.toEqual(view());
  });

  it('keeps a refusal on screen while other tiles in the area are still working', () => {
    const raced = view({
      area: area({ working: 10 }),
      press: {
        pending: false,
        failed: false,
        result: { busy: true, busyReason: 'rate-limit', queueWaitHours: null },
      },
    });

    // Both facts are true at once: this press queued nothing, and ten tiles are already coming.
    expect(raced.message?.tone).toBe('refusal');
    expect(raced.progress).not.toBeNull();
  });

  it('says how long the queued tiles will take, from the figure the server derived', () => {
    const working = view({ area: area({ working: 80, outstandingHours: 3.74 }) });

    expect(working.label).toBe('0 of 80 tiles');
    expect(working.message?.tone).toBe('progress');
    expect(working.message?.text).toContain('about 4 hours');
  });

  it('drops the duration rather than inventing one when the wait is not known', () => {
    const working = view({ area: area({ working: 80, outstandingHours: 0 }) });

    expect(working.progress).not.toBeNull();
    expect(working.message).toBeNull();
  });

  it('does not promise minutes for a refusal that fires at a day of queued work', () => {
    const full = view({
      press: {
        pending: false,
        failed: false,
        result: { busy: true, busyReason: 'queue-depth', queueWaitHours: 24 },
      },
    });

    expect(full.message?.tone).toBe('refusal');
    expect(full.message?.text).not.toMatch(/minute/iu);
    expect(full.message?.text).toContain('about a day');
  });

  it('gives each refusal its own sentence, because none of them share an instruction', () => {
    const said = (busyReason: 'queue-depth' | 'storage' | 'rate-limit') =>
      view({
        press: {
          pending: false,
          failed: false,
          result: {
            busy: true,
            busyReason,
            queueWaitHours: busyReason === 'queue-depth' ? 24 : null,
          },
        },
      }).message?.text ?? '';

    const queue = said('queue-depth');
    const storage = said('storage');
    const allowance = said('rate-limit');

    expect(new Set([queue, storage, allowance]).size).toBe(3);
    // A queue drains on its own; a full database waits on an operator; an allowance is this
    // reader's alone. Collapsing any two prescribes an action that cannot work.
    expect(queue).toMatch(/queue/iu);
    expect(storage).toMatch(/no room/iu);
    expect(allowance).toMatch(/you have fetched/iu);
  });

  it('claims nothing was queued only where the server said so', () => {
    const refused = view({
      press: {
        pending: false,
        failed: false,
        result: { busy: true, busyReason: 'queue-depth', queueWaitHours: 24 },
      },
    });
    const failed = view({ press: { pending: false, failed: true, result: null } });

    // A refusal is the server's own answer, and it did queue nothing.
    expect(refused.message?.text).toMatch(/nothing was queued/iu);
    /*
     * A failure is not. `isError` fires on transport loss too, and `queueTiles` commits each
     * tile separately — so some may well have landed, and the client cannot know.
     */
    expect(failed.message?.text).not.toMatch(/nothing was queued/iu);
    expect(failed.message?.text).toMatch(/again/iu);
  });

  it('fills the bar and announces the count from the tiles actually done', () => {
    const partway = view({ area: area({ working: 60, fresh: 24, tiles: 96, outstanding: 72 }) });

    expect(partway.label).toBe('24 of 96 tiles');
    expect(partway.progress).toEqual({ done: 24, total: 96, percent: 25 });
    expect(partway.liveText).toBe('Fetching this area: 24 of 96 tiles complete.');
  });

  it('gives refused, failed, under way and covered four different answers', () => {
    const answers = [
      view(),
      view({ press: { pending: false, failed: true, result: null } }),
      view({
        press: {
          pending: false,
          failed: false,
          result: { busy: true, busyReason: 'queue-depth', queueWaitHours: 24 },
        },
      }),
      view({ area: area({ working: 80 }) }),
    ].map((each) => JSON.stringify(each));

    expect(new Set(answers).size).toBe(answers.length);
    expect(
      fetchAreaView({ area: area({ outstanding: 0 }), hasBBox: true, press: untried }),
    ).toBeNull();
  });
});

describe('describeHours', () => {
  it('hedges, because the drain rate behind it is a mean over a wide distribution', () => {
    expect(describeHours(3.74)).toBe('about 4 hours');
    expect(describeHours(24)).toBe('about a day');
  });

  it('does not round a short wait down to nothing', () => {
    expect(describeHours(0.4)).toBe('less than an hour');
  });

  it('does not call half a day a day, and does not call a day and a half one either', () => {
    // One label may not span a 3x range: 12 h and 35 h both read as "about a day" before this.
    expect(describeHours(12)).toBe('about 12 hours');
    expect(describeHours(20)).toBe('about 20 hours');
    expect(describeHours(23.9)).toBe('about 24 hours');
    expect(describeHours(36)).toBe('about 2 days');
  });

  it('has no answer for a wait that was never measured', () => {
    expect(describeHours(0)).toBeNull();
    expect(describeHours(Number.NaN)).toBeNull();
    expect(describeHours(undefined)).toBeNull();
  });
});
