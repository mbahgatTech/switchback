import { PNG } from 'pngjs';

/**
 * A terrarium tile where every pixel encodes the same elevation.
 * `elev = R*256 + G + B/256 - 32768`, so 1000 m is R=131, G=232, B=0.
 */
export function flatTile(elevationM: number, size = 64): Buffer {
  const encoded = elevationM + 32768;
  const r = Math.floor(encoded / 256);
  const g = Math.floor(encoded - r * 256);
  const b = Math.round((encoded - r * 256 - g) * 256);

  const png = new PNG({ width: size, height: size });
  for (let i = 0; i < size * size; i++) {
    png.data[i * 4] = r;
    png.data[i * 4 + 1] = g;
    png.data[i * 4 + 2] = b;
    png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}

export function pngResponse(buffer: Buffer): Response {
  return new Response(new Uint8Array(buffer), { status: 200 });
}
