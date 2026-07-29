import { describe, expect, it } from 'vitest';
import { plural } from '../src/text';

describe('plural', () => {
  it('gives the singular for exactly one', () => {
    expect(plural(1, 'hike')).toBe('hike');
    expect(plural(1, 'trail')).toBe('trail');
  });

  it('gives the plural for none and for many', () => {
    expect(plural(0, 'hike')).toBe('hikes');
    expect(plural(2, 'hike')).toBe('hikes');
    expect(plural(240, 'trail')).toBe('trails');
  });

  it('takes an irregular plural when -s is wrong', () => {
    expect(plural(1, 'person', 'people')).toBe('person');
    expect(plural(3, 'person', 'people')).toBe('people');
  });

  it('treats a count of minus one as singular, because a delta reads that way', () => {
    expect(plural(-1, 'hike')).toBe('hike');
    expect(plural(-2, 'hike')).toBe('hikes');
  });
});
