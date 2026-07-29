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
 * Remember where the reader is, so the next visit opens on their trails.
 *
 * Called two ways, and the distinction between them is the whole reason `source` is stored
 * rather than inferred: the front page's "Use my location" hands over a GPS fix, and the
 * explore map hands over a place somebody searched for. Both are answers a person gave; the
 * first has no name and the second is nothing but a name.
 *
 * Cookie, not account. Where you are is a property of the device you are holding, not of
 * your identity — writing it to the account would mean a phone in the Cairngorms silently
 * moving the laptop's front page in Cardiff. It is also the one thing here a signed-out
 * reader most needs remembered, and an account row would do nothing for them.
 *
 * Every export of a `'use server'` module is a public endpoint anybody can call with
 * anything, so the coordinate is re-validated here rather than trusted from the type.
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

  // The front page is a function of this cookie and nothing else, so it has to be rebuilt
  // for the answer to appear. Only that path: the explore map reads its own viewport.
  revalidatePath('/');
}

/**
 * Forget it.
 *
 * A location control that can only be switched on is a control that has taken something.
 * This is the same act as revoking the browser's permission, on our side of it, and it
 * returns the front page to the question it asks when it knows nothing.
 */
export async function forgetPlace(): Promise<void> {
  const jar = await cookies();
  jar.delete(PLACE_COOKIE);
  revalidatePath('/');
}
