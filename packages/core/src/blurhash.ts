/**
 * BlurHash — the twenty-odd characters that stand in for a photograph before it arrives.
 *
 * A trail gallery is a horizontal strip of large images over a slow mobile connection at a
 * trailhead, which is the worst case for the usual placeholder: a grey rectangle that holds
 * the layout and tells you nothing, replaced all at once by a photograph. The alternative
 * used to be a base64 thumbnail in the payload, but a 3 kB JPEG per photo across a
 * twelve-photo strip is 36 kB of *placeholder* — more than some of the photographs.
 *
 * This is the same idea at 1% of the size. Twenty-eight characters of DCT coefficients
 * decode to a blurred impression of the picture: right colours, right composition, wrong
 * everything else. It goes in the row next to the URL, costs nothing to ship, and the strip
 * reads as a strip of photographs from the first paint.
 *
 * Two entry points, deliberately different in cost. `blurhashAverageColor` reads only the
 * DC term — one base-83 parse, no pixel loop — and is what a card uses for a CSS background.
 * `decodeBlurhash` reconstructs pixels for a canvas, which is worth it for the gallery and
 * not for a list of forty rows.
 *
 * Encoding runs on the *client*, in the same canvas pass that already produced the thumbnail.
 * The server never decodes an image, which is what keeps `sharp` — a native dependency that
 * would need a build step on every platform we ship to — out of this repository entirely.
 *
 * Format per the BlurHash reference implementation (github.com/woltapp/blurhash, MIT), so
 * hashes we write are readable by any other implementation and vice versa.
 */

/** Base-83, chosen by the format for being URL-, HTML- and shell-safe all at once. */
const DIGITS =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~';

/** 4×3 keeps a landscape photograph's horizon and sky, and costs 28 characters. */
export const BLURHASH_COMPONENTS_X = 4;
export const BLURHASH_COMPONENTS_Y = 3;

/** Thrown for a hash that is malformed rather than merely ugly. */
export class BlurhashError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlurhashError';
  }
}

function encode83(value: number, length: number): string {
  let out = '';
  for (let i = 1; i <= length; i++) {
    const digit = Math.floor(value / 83 ** (length - i)) % 83;
    out += DIGITS[digit];
  }
  return out;
}

function decode83(chars: string): number {
  let value = 0;
  for (const char of chars) {
    const digit = DIGITS.indexOf(char);
    if (digit < 0) throw new BlurhashError(`invalid base-83 character ${JSON.stringify(char)}`);
    value = value * 83 + digit;
  }
  return value;
}

/**
 * sRGB is stored gamma-encoded, and averaging gamma-encoded values is wrong.
 *
 * Not pedantry: the average of black and white in sRGB space is 128, which renders as a mid
 * grey noticeably darker than the 188 you get by averaging light. Every coefficient below is
 * an average of some kind, so all of them happen in linear light and convert back at the end.
 */
function srgbToLinear(value: number): number {
  const v = value / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(value: number): number {
  const v = Math.max(0, Math.min(1, value));
  return v <= 0.0031308
    ? Math.round(v * 12.92 * 255 + 0.5)
    : Math.round((1.055 * v ** (1 / 2.4) - 0.055) * 255 + 0.5);
}

/** `sign(x) * |x|^exponent` — the format's quantisation curve, which must keep its sign. */
function signPow(value: number, exponent: number): number {
  return Math.sign(value) * Math.abs(value) ** exponent;
}

type Coefficient = [number, number, number];

/**
 * Encode RGBA pixels to a hash.
 *
 * Feed this a *small* image. The loop is `width * height * componentX * componentY`, so a
 * full-resolution photograph is tens of billions of operations for an answer that is
 * indistinguishable from the one a 32-pixel thumbnail gives — the whole output is four
 * horizontal bands of colour. The uploader downsamples to 32 px first for exactly this
 * reason, and that downsample is also what makes this cheap enough to run on the main thread.
 */
export function encodeBlurhash(
  pixels: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  componentX: number = BLURHASH_COMPONENTS_X,
  componentY: number = BLURHASH_COMPONENTS_Y,
): string {
  if (componentX < 1 || componentX > 9 || componentY < 1 || componentY > 9) {
    throw new BlurhashError('component counts must be between 1 and 9');
  }
  if (pixels.length !== 4 * width * height) {
    throw new BlurhashError(`expected ${4 * width * height} RGBA bytes, got ${pixels.length}`);
  }

  // Precomputed once per axis rather than per coefficient: the inner loop would otherwise
  // call `Math.cos` `w*h*cx*cy` times for `w*cx + h*cy` distinct arguments.
  const cosX: number[][] = [];
  for (let fx = 0; fx < componentX; fx++) {
    const row: number[] = [];
    for (let x = 0; x < width; x++) row.push(Math.cos((Math.PI * fx * x) / width));
    cosX.push(row);
  }
  const cosY: number[][] = [];
  for (let fy = 0; fy < componentY; fy++) {
    const row: number[] = [];
    for (let y = 0; y < height; y++) row.push(Math.cos((Math.PI * fy * y) / height));
    cosY.push(row);
  }

  // Linearise once. The same pixel is read by every one of the twelve coefficients, and
  // `srgbToLinear` is a `Math.pow` — doing it inside the coefficient loop is twelve times
  // the transcendental work for an identical answer.
  const linear = new Float64Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    linear[i * 3] = srgbToLinear(pixels[i * 4] ?? 0);
    linear[i * 3 + 1] = srgbToLinear(pixels[i * 4 + 1] ?? 0);
    linear[i * 3 + 2] = srgbToLinear(pixels[i * 4 + 2] ?? 0);
  }

  const factors: Coefficient[] = [];
  for (let fy = 0; fy < componentY; fy++) {
    for (let fx = 0; fx < componentX; fx++) {
      const normalisation = fx === 0 && fy === 0 ? 1 : 2;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let y = 0; y < height; y++) {
        const by = cosY[fy]?.[y] ?? 0;
        for (let x = 0; x < width; x++) {
          const basis = normalisation * (cosX[fx]?.[x] ?? 0) * by;
          const i = (y * width + x) * 3;
          r += basis * (linear[i] ?? 0);
          g += basis * (linear[i + 1] ?? 0);
          b += basis * (linear[i + 2] ?? 0);
        }
      }
      const scale = 1 / (width * height);
      factors.push([r * scale, g * scale, b * scale]);
    }
  }

  const dc = factors[0] ?? [0, 0, 0];
  const ac = factors.slice(1);

  // One shared scale for every AC coefficient, stored in the hash. A photograph of fog and
  // a photograph of a striped awning need wildly different ranges, and a fixed scale would
  // either clip the awning or quantise the fog to nothing.
  let maximum = 0;
  for (const factor of ac) {
    maximum = Math.max(maximum, Math.abs(factor[0]), Math.abs(factor[1]), Math.abs(factor[2]));
  }
  const quantisedMax =
    ac.length > 0 ? Math.max(0, Math.min(82, Math.floor(maximum * 166 - 0.5))) : 0;
  const maxValue = ac.length > 0 ? (quantisedMax + 1) / 166 : 1;

  const quantise = (value: number): number =>
    Math.max(0, Math.min(18, Math.floor(signPow(value / maxValue, 0.5) * 9 + 9.5)));

  let hash = encode83(componentX - 1 + (componentY - 1) * 9, 1);
  hash += encode83(quantisedMax, 1);
  hash += encode83(
    (linearToSrgb(dc[0]) << 16) + (linearToSrgb(dc[1]) << 8) + linearToSrgb(dc[2]),
    4,
  );
  for (const factor of ac) {
    hash += encode83(
      quantise(factor[0]) * 19 * 19 + quantise(factor[1]) * 19 + quantise(factor[2]),
      2,
    );
  }
  return hash;
}

interface ParsedHash {
  componentX: number;
  componentY: number;
  maxValue: number;
  dc: Coefficient;
  ac: Coefficient[];
}

function parseHash(hash: string): ParsedHash {
  if (hash.length < 6) throw new BlurhashError('hash is too short to be valid');

  const sizeFlag = decode83(hash[0] ?? '');
  const componentX = (sizeFlag % 9) + 1;
  const componentY = Math.floor(sizeFlag / 9) + 1;
  const expected = 4 + 2 * componentX * componentY;
  if (hash.length !== expected) {
    throw new BlurhashError(
      `hash declares ${componentX}×${componentY}, needing ${expected} characters, got ${hash.length}`,
    );
  }

  const maxValue = (decode83(hash[1] ?? '') + 1) / 166;
  const packedDc = decode83(hash.slice(2, 6));
  const dc: Coefficient = [
    srgbToLinear((packedDc >> 16) & 255),
    srgbToLinear((packedDc >> 8) & 255),
    srgbToLinear(packedDc & 255),
  ];

  const ac: Coefficient[] = [];
  for (let i = 1; i < componentX * componentY; i++) {
    const packed = decode83(hash.slice(4 + i * 2, 6 + i * 2));
    const dequantise = (quantised: number): number => signPow((quantised - 9) / 9, 2) * maxValue;
    ac.push([
      dequantise(Math.floor(packed / (19 * 19))),
      dequantise(Math.floor(packed / 19) % 19),
      dequantise(packed % 19),
    ]);
  }

  return { componentX, componentY, maxValue, dc, ac };
}

/**
 * The DC term as a CSS hex colour — the cheap placeholder.
 *
 * This is the whole image averaged in linear light, which is exactly what a card wants
 * behind a thumbnail that has not loaded. No pixel loop, no canvas, no effect on layout.
 * Returns null rather than throwing for a malformed hash: a placeholder is decoration, and
 * a bad one should degrade to the default background rather than break a page of results.
 */
export function blurhashAverageColor(hash: string | null | undefined): string | null {
  if (!hash) return null;
  try {
    const { dc } = parseHash(hash);
    const hex = (value: number): string => linearToSrgb(value).toString(16).padStart(2, '0');
    return `#${hex(dc[0])}${hex(dc[1])}${hex(dc[2])}`;
  } catch {
    return null;
  }
}

/**
 * Reconstruct RGBA pixels at any size — for painting to a canvas.
 *
 * Decode small and let the browser scale it up. The output has no detail above the component
 * count by construction, so a 32×32 decode stretched to 400 px is pixel-identical to a 400×400
 * decode and roughly 150 times cheaper.
 *
 * `punch` multiplies the AC terms, raising contrast. The default of 1 is the picture as
 * encoded; the format's reference implementation offers this because the very low frequency
 * content of a photograph can look washed out next to the photograph itself.
 */
export function decodeBlurhash(
  hash: string,
  width: number,
  height: number,
  punch = 1,
): Uint8ClampedArray {
  const { componentX, componentY, dc, ac } = parseHash(hash);
  const pixels = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = dc[0];
      let g = dc[1];
      let b = dc[2];

      for (let fy = 0; fy < componentY; fy++) {
        for (let fx = 0; fx < componentX; fx++) {
          if (fx === 0 && fy === 0) continue;
          const factor = ac[fy * componentX + fx - 1];
          if (!factor) continue;
          const basis =
            Math.cos((Math.PI * fx * x) / width) * Math.cos((Math.PI * fy * y) / height) * punch;
          r += factor[0] * basis;
          g += factor[1] * basis;
          b += factor[2] * basis;
        }
      }

      const i = (y * width + x) * 4;
      pixels[i] = linearToSrgb(r);
      pixels[i + 1] = linearToSrgb(g);
      pixels[i + 2] = linearToSrgb(b);
      pixels[i + 3] = 255;
    }
  }
  return pixels;
}

/** Whether a string is a structurally valid hash. Used to reject junk before it is stored. */
export function isBlurhash(value: string): boolean {
  try {
    parseHash(value);
    return true;
  } catch {
    return false;
  }
}
