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

  it('has no answer for a wait that was never measured', () => {
    expect(describeHours(0)).toBeNull();
    expect(describeHours(Number.NaN)).toBeNull();
    expect(describeHours(undefined)).toBeNull();
  });
});
