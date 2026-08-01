'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import {
  PLACE_COOKIE,
  PLACE_COOKIE_MAX_AGE,
  type PlaceSource,
  type ViewerPlace,
  formatPlaceCookie,
} from './place';

/**
 * Every route whose server render is a function of the place cookie, so every route that must be
 * rebuilt for a new answer to appear. `/nearby` owns the "Use my location" button; `/`, `/explore`
 * and `/plan` read it through `placeCamera`. `viewerPlace()` has exactly these callers.
 */
const PLACE_READERS = ['/nearby', '/', '/explore', '/plan'] as const;

function rebuildPlaceReaders(): void {
  for (const path of PLACE_READERS) revalidatePath(path);
}

/**
 * Remember where the reader is. Cookie, not account: where you are is a property of the device
 * you are holding, and a signed-out reader needs it most. `source` is stored rather than inferred
 * because a GPS fix and a searched place license different copy — see `placeLabel`.
 *
 * Every export of a `'use server'` module is a public endpoint anybody can call with anything, so
 * the coordinate is re-validated here rather than trusted from the type.
 */
export async function rememberPlace(input: {
  lng: number;
  lat: number;
  source: PlaceSource;
  name?: string;
}): Promise<void> {
  const { lng, lat } = input;
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
  if (lng < -180 || lng > 180 || lat < -90 || lat > 90) return;
  if (input.source !== 'browser' && input.source !== 'search') return;

  const place: ViewerPlace = {
    at: [lng, lat],
    source: input.source,
    // Newlines and semicolons would end the cookie early or forge an attribute after it,
    // and a place name has no business containing either.
    ...(input.name
      ? {
          name: input.name
            .replace(/[\r\n;]/g, ' ')
            .trim()
            .slice(0, 80),
        }
      : {}),
  };

  const jar = await cookies();
  jar.set(PLACE_COOKIE, formatPlaceCookie(place), {
    maxAge: PLACE_COOKIE_MAX_AGE,
    path: '/',
    sameSite: 'lax',
    // Not a secret, and the offline shell needs the same answer the server had.
    httpOnly: false,
  });

  rebuildPlaceReaders();
}

/** Forget it — the same act as revoking the browser's permission, on our side of it. */
export async function forgetPlace(): Promise<void> {
  const jar = await cookies();
  jar.delete(PLACE_COOKIE);
  rebuildPlaceReaders();
}
