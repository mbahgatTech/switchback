'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { BUTTON, BUTTON_COLLAR, GHOST, HEIGHT, SECONDARY } from '../controls';
import { forgetPlace, rememberPlace } from '@/lib/place-action';

/**
 * Where the reader is, asked for on arrival rather than behind a button — on `/nearby` the
 * list *is* the page, so there is no "later" at which the reader would have more evidence.
 *
 * A permission denied for the origin cannot be walked back, so three guards apply: never ask
 * twice, never ask after a `denied` state the Permissions API reports, and never re-arm the
 * ask after the reader presses Forget. A failure from the automatic attempt stays quiet; the
 * message below is for somebody who pressed the button. The answer goes to a cookie by server
 * action, so the list is server-rendered from it on this visit and every one after.
 */

export interface LocateProps {
  /** True once we have a position from any source, which changes the verb. */
  known: boolean;
  /** True when the position on screen came from the browser, which adds "forget". */
  precise: boolean;
}

/**
 * The reader's standing answer to the automatic ask. `localStorage` rather than a cookie: the
 * server has no use for it, and a cookie rides every request to every route.
 */
const OFF_KEY = 'sb-locate-off';

function readOff(): boolean {
  try {
    return window.localStorage.getItem(OFF_KEY) === '1';
  } catch {
    // Storage is disabled or partitioned. The reader gets the ask, which is the default.
    return false;
  }
}

function writeOff(off: boolean): void {
  try {
    if (off) window.localStorage.setItem(OFF_KEY, '1');
    else window.localStorage.removeItem(OFF_KEY);
  } catch {
    /* nothing to remember it with; the button still works */
  }
}

export function Locate({ known, precise }: LocateProps) {
  const [pending, startTransition] = useTransition();
  const [asking, setAsking] = useState(false);
  const [fault, setFault] = useState<string | null>(null);

  /*
   * StrictMode runs every effect twice on mount in development. `maximumAge` serves the second
   * call from cache, so it is not a second prompt — but it is a second server action writing
   * the same cookie.
   */
  const asked = useRef(false);

  function locate(automatic: boolean) {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      if (!automatic) setFault('This browser cannot report your position.');
      return;
    }

    setFault(null);
    setAsking(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setAsking(false);
        const { longitude, latitude } = position.coords;
        startTransition(async () => {
          await rememberPlace({ lng: longitude, lat: latitude, source: 'browser' });
        });
      },
      (error) => {
        setAsking(false);
        if (!automatic) setFault(message(error));
      },
      {
        // A street-accurate fix would cost battery and seconds to find the same trails: the
        // nearest hike does not change between one end of a town and the other.
        enableHighAccuracy: false,
        // Five minutes of staleness is free accuracy here, and it is what lets a second
        // press answer instantly instead of waking the radio again.
        maximumAge: 5 * 60 * 1000,
        timeout: 15_000,
      },
    );
  }

  useEffect(() => {
    if (asked.current || precise) return;
    asked.current = true;
    if (readOff()) return;

    // `permissions` is missing on older Safari. Without it there is no way to tell a refusal
    // from a fresh visit, so we ask — which is the behaviour every other browser gets too.
    if (!navigator.permissions?.query) {
      locate(true);
      return;
    }

    let live = true;
    void navigator.permissions
      .query({ name: 'geolocation' })
      .then((status) => {
        if (live && status.state !== 'denied') locate(true);
      })
      .catch(() => {
        if (live) locate(true);
      });
    return () => {
      live = false;
    };
    // Mount only. `precise` flipping true is the *result* of this effect, and re-running on
    // it would re-arm the ask the moment the reader pressed Forget.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const busy = asking || pending;

  return (
    <div className="flex flex-wrap items-center gap-md">
      <button
        type="button"
        onClick={() => {
          // An explicit press is also the reader taking the automatic ask off "off".
          writeOff(false);
          locate(false);
        }}
        disabled={busy}
        className={`${BUTTON} ${SECONDARY} ${HEIGHT.touch} bg-surface px-lg text-body disabled:cursor-default`}
      >
        {busy ? 'Finding you…' : known ? 'Use my exact location' : 'Find trails near me'}
      </button>

      {precise ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            writeOff(true);
            startTransition(async () => {
              await forgetPlace();
            });
          }}
          className={`${BUTTON_COLLAR} ${GHOST} ${HEIGHT.touch} px-sm disabled:cursor-default`}
        >
          Forget my location
        </button>
      ) : null}

      {/*
       * `alert` rather than a quiet paragraph: this text only ever exists in response to a
       * press, and a reader who has just pressed a button and had nothing happen is exactly
       * the person who needs to be told why without going looking.
       */}
      {fault ? (
        <p role="alert" className="font-text text-caption text-ink-muted">
          {fault}
        </p>
      ) : null}
    </div>
  );
}

/** The four ways this fails, in the words that say what to do about each. */
function message(error: GeolocationPositionError): string {
  switch (error.code) {
    case error.PERMISSION_DENIED:
      return 'Location is blocked for this site. Allow it in your browser settings, or search from the map instead.';
    case error.POSITION_UNAVAILABLE:
      return 'Your browser could not work out where you are.';
    case error.TIMEOUT:
      return 'That took too long. Try again, or search from the map.';
    default:
      return 'Could not read your position.';
  }
}
