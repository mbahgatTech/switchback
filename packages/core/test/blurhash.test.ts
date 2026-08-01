import { describe, expect, it } from 'vitest';
import {
  BLURHASH_COMPONENTS_X,
  BLURHASH_COMPONENTS_Y,
  BlurhashError,
  blurhashAverageColor,
  decodeBlurhash,
  encodeBlurhash,
  isBlurhash,
} from '../src/blurhash';

/**
 * BlurHash treated as a format: the round trip survives, the string is structurally what the
 * spec describes, and a malformed hash degrades to a missing placeholder rather than a broken
 * page — a decorative feature must never take a page of results down.
 */

type Rgb = readonly [number, number, number];

/** A solid rectangle of one colour, as RGBA bytes. */
function flat(width: number, height: number, [r, g, b]: Rgb): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    pixels[i * 4] = r;
    pixels[i * 4 + 1] = g;
    pixels[i * 4 + 2] = b;
    pixels[i * 4 + 3] = 255;
  }
  return pixels;
}

/** Top half one colour, bottom half another. */
function halves(width: number, height: number, top: Rgb, bottom: Rgb): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const [r, g, b] = y < height / 2 ? top : bottom;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      pixels[i] = r;
      pixels[i + 1] = g;
      pixels[i + 2] = b;
      pixels[i + 3] = 255;
    }
  }
  return pixels;
}

function parseHex(hex: string): Rgb {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

/** Channel-wise closeness. The format quantises to 19 levels, so exactness is not the bar. */
function expectNear(actual: Rgb, expected: Rgb, tolerance: number): void {
  for (const channel of [0, 1, 2] as const) {
    expect(
      Math.abs((actual[channel] ?? 0) - (expected[channel] ?? 0)),
      `channel ${channel}: ${actual.join(',')} vs ${expected.join(',')}`,
    ).toBeLessThanOrEqual(tolerance);
  }
}

describe('encodeBlurhash', () => {
  it('produces a string of the length the component count implies', () => {
    const hash = encodeBlurhash(flat(16, 16, [63, 107, 54]), 16, 16);
    // 1 size flag + 1 quantised maximum + 4 DC + 2 per AC term.
    const terms = BLURHASH_COMPONENTS_X * BLURHASH_COMPONENTS_Y - 1;
    expect(hash).toHaveLength(6 + terms * 2);
    expect(isBlurhash(hash)).toBe(true);
  });

  it('encodes the component counts in the first character', () => {
    // The spec packs them into one base-83 digit as `(x - 1) + (y - 1) * 9`. A decoder that
    // reads this wrong reads the whole rest of the string at the wrong offsets.
    const digits =
      '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~';
    const flag = (hash: string): number => digits.indexOf(hash[0] ?? '');

    expect(flag(encodeBlurhash(flat(8, 8, [128, 128, 128]), 8, 8, 4, 3))).toBe(3 + 2 * 9);
    expect(flag(encodeBlurhash(flat(8, 8, [128, 128, 128]), 8, 8, 1, 1))).toBe(0);
    expect(flag(encodeBlurhash(flat(8, 8, [128, 128, 128]), 8, 8, 9, 9))).toBe(8 + 8 * 9);
  });

  it('refuses pixel buffers that do not match the stated dimensions', () => {
    expect(() => encodeBlurhash(new Uint8ClampedArray(4 * 15), 4, 4)).toThrow(BlurhashError);
  });

  it('refuses component counts the format cannot express', () => {
    const pixels = flat(4, 4, [0, 0, 0]);
    expect(() => encodeBlurhash(pixels, 4, 4, 0, 3)).toThrow(BlurhashError);
    expect(() => encodeBlurhash(pixels, 4, 4, 10, 3)).toThrow(BlurhashError);
    expect(() => encodeBlurhash(pixels, 4, 4, 4, 10)).toThrow(BlurhashError);
  });
});

describe('blurhashAverageColor', () => {
  it('recovers a flat colour to within a couple of levels', () => {
    for (const colour of [
      [63, 107, 54], // woodland
      [31, 106, 140], // water
      [138, 85, 36], // contour
      [237, 240, 234], // canvas
      [22, 28, 29], // ink
    ] as const) {
      const hash = encodeBlurhash(flat(32, 32, colour), 32, 32);
      const recovered = blurhashAverageColor(hash);
      expect(recovered).toMatch(/^#[0-9a-f]{6}$/u);
      expectNear(parseHex(recovered ?? '#000000'), colour, 2);
    }
  });

  it('averages in linear light, not in sRGB', () => {
    // Half black and half white averaged as stored bytes gives 0x80; averaged as light it is
    // around 0xBC. Getting this wrong makes every placeholder on the page too dark.
    const hash = encodeBlurhash(halves(32, 32, [0, 0, 0], [255, 255, 255]), 32, 32);
    const [r] = parseHex(blurhashAverageColor(hash) ?? '#000000');
    expect(r).toBeGreaterThan(170);
    expect(r).toBeLessThan(200);
  });

  it('is null for anything it cannot read, rather than throwing', () => {
    expect(blurhashAverageColor(null)).toBeNull();
    expect(blurhashAverageColor(undefined)).toBeNull();
    expect(blurhashAverageColor('')).toBeNull();
    expect(blurhashAverageColor('not a hash')).toBeNull();
    expect(blurhashAverageColor('LEHV6nWB2yk8')).toBeNull(); // right alphabet, wrong length
    expect(blurhashAverageColor('«««««««««««««««««««««««««')).toBeNull(); // outside base 83
  });
});

describe('decodeBlurhash', () => {
  it('round trips a flat colour to a flat frame', () => {
    // Flat, but not identical pixel for pixel: BlurHash samples its basis at integer pixel
    // positions rather than centres, so a constant image leaves small AC terms behind, as it
    // does in the reference implementation. The frame must average to the colour.
    const colour = [63, 107, 54] as const;
    const hash = encodeBlurhash(flat(32, 32, colour), 32, 32);
    const pixels = decodeBlurhash(hash, 8, 8);

    expect(pixels).toHaveLength(8 * 8 * 4);

    const reds: number[] = [];
    for (let i = 0; i < 64; i++) {
      reds.push(pixels[i * 4] ?? 0);
      expect(pixels[i * 4 + 3]).toBe(255); // opaque: the format carries no alpha
    }

    const mean = (channel: number): number => {
      let total = 0;
      for (let i = 0; i < 64; i++) total += pixels[i * 4 + channel] ?? 0;
      return total / 64;
    };
    expectNear([mean(0), mean(1), mean(2)], colour, 4);
    expect(Math.max(...reds) - Math.min(...reds)).toBeLessThan(20);
  });

  it('keeps the vertical arrangement of a two-tone frame', () => {
    // Four cosine terms cannot hold an edge, but they hold which end is which.
    const hash = encodeBlurhash(halves(32, 32, [20, 20, 20], [230, 230, 230]), 32, 32);
    const pixels = decodeBlurhash(hash, 4, 4);
    const top = pixels[0] ?? 0;
    const bottom = pixels[(3 * 4 + 0) * 4] ?? 0;
    expect(bottom).toBeGreaterThan(top + 40);
  });

  it('raises contrast with punch without moving the average much', () => {
    const hash = encodeBlurhash(halves(32, 32, [40, 40, 40], [200, 200, 200]), 32, 32);
    const plain = decodeBlurhash(hash, 4, 4);
    const punched = decodeBlurhash(hash, 4, 4, 2);
    const spread = (p: Uint8ClampedArray): number => (p[3 * 4 * 4] ?? 0) - (p[0] ?? 0);
    expect(spread(punched)).toBeGreaterThan(spread(plain));
  });
});

describe('isBlurhash', () => {
  it('accepts what encode produces and rejects junk', () => {
    expect(isBlurhash(encodeBlurhash(flat(8, 8, [1, 2, 3]), 8, 8))).toBe(true);
    expect(isBlurhash('')).toBe(false);
    expect(isBlurhash('L')).toBe(false);
    expect(isBlurhash('<script>alert(1)</script>')).toBe(false);
  });
});
