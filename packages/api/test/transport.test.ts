import { describe, expect, it } from 'vitest';
import { UNBATCHED_PROCEDURES } from '@switchback/core';
import { appRouter } from '../src/root';

/**
 * The batching policy names procedures as strings, and strings do not survive a rename.
 *
 * That is the whole failure mode worth testing here. If `trails.browse` is ever renamed or
 * moved under another router, nothing breaks loudly: the split link simply stops matching,
 * the slow query rejoins the batch, and the place typeahead goes back to waiting half a
 * minute behind an Overpass fetch — the exact defect the list exists to prevent, returning
 * silently and by omission.
 *
 * So the list is checked against the router it describes rather than trusted.
 */
describe('UNBATCHED_PROCEDURES', () => {
  const known = Object.keys(appRouter._def.procedures);

  it('names procedures that actually exist on the router', () => {
    for (const path of UNBATCHED_PROCEDURES) {
      expect(known, `${path} is not a procedure on appRouter`).toContain(path);
    }
  });

  it('still covers the two that reach a third party', () => {
    // Named explicitly rather than counted. A test that only asserts "the list is not empty"
    // passes just as happily when the wrong entry is the surviving one.
    expect(UNBATCHED_PROCEDURES).toContain('trails.browse');
    expect(UNBATCHED_PROCEDURES).toContain('places.search');
  });
});
