import { describe, expect, it } from 'vitest';
import { flagValue } from '../scripts/flags';
import { osmKey, tagsByIdQuery } from '../scripts/peak-elevations';

describe('tagsByIdQuery', () => {
  it('asks for tags only, by id, per element type', () => {
    expect(tagsByIdQuery('node', [1, 2, 3])).toBe(
      '[out:json][timeout:60];\nnode(id:1,2,3);\nout tags;',
    );
    expect(tagsByIdQuery('way', [12n])).toContain('way(id:12);');
    // No `geom`, no `center`, no bounding box: geometry is the whole weight of a response, and
    // a box would make the server walk a spatial index for features we can already name.
    expect(tagsByIdQuery('relation', [7])).not.toMatch(/geom|center|\(\d+\.\d+,/);
  });

  it('refuses an empty batch rather than sending a syntax error', () => {
    // `node(id:);` comes back 400, which the client treats as fatal and — rightly — will not
    // retry. Cheaper to fail here than to spend the run's credibility with a mirror.
    expect(() => tagsByIdQuery('node', [])).toThrow(/zero node ids/);
  });
});

describe('osmKey', () => {
  it('keeps the element type, because the three id sequences overlap', () => {
    expect(osmKey('node', 240110)).toBe('node/240110');
    expect(osmKey('way', 240110n)).toBe('way/240110');
    expect(osmKey('node', 240110)).not.toBe(osmKey('way', 240110));
  });
});

describe('flagValue', () => {
  it('reads the value after the flag', () => {
    expect(flagValue(['--out', 'peaks.json'], '--out')).toBe('peaks.json');
    expect(flagValue(['--apply', '--out', 'peaks.json'], '--out')).toBe('peaks.json');
  });

  it('treats a missing or empty value as no flag at all', () => {
    // The one that matters: `--out ""` once wrote 24 GB to a file called the empty string.
    expect(flagValue(['--out'], '--out')).toBeNull();
    expect(flagValue(['--out', ''], '--out')).toBeNull();
    expect(flagValue(['--out', '--apply'], '--out')).toBeNull();
    expect(flagValue(['--apply'], '--out')).toBeNull();
  });
});
