import { useSyncExternalStore } from 'react';
import { AppState, type NativeEventSubscription } from 'react-native';
import * as Battery from 'expo-battery';
import * as Location from 'expo-location';
import { LIFELINE_PING_INTERVAL_S } from '@switchback/core';
import { latestFix, type RecordedFix } from '@/record/store';

/**
 * The Lifeline ping loop.
 *
 * A module rather than a hook, for the same reason `@/record/store` is one: this app has a tab
 * bar, and a loop living in the Record screen's `useEffect` would stop sending positions the
 * first time somebody tapped Explore to see where the path went. On a safety feature that is
 * not a degraded experience, it is the feature quietly not working — and the hiker would have
 * no way to tell, because their own screen would still say a Lifeline is running.
 *
 * So it runs here, driven from the app root, and the only thing that stops it is the Lifeline
 * ending.
 *
 * **A ping is not a side effect of recording.** Somebody who just wants their partner to see
 * where they are should not have to record a hike to get it. The loop keeps its own cadence —
 * `LIFELINE_PING_INTERVAL_S`, deliberately slower than the recorder's upload tick — and takes
 * the recorder's fix when there is a fresh one going spare. What it will not do is send an old
 * one; see `freshFix`.
 *
 * **What it cannot do in Expo Go, or on iOS at all.** Timers do not run while the app is
 * suspended, so pings stop when Switchback is not on screen. That is the same limitation the
 * recorder has and the panel says so in as many words rather than letting somebody believe a
 * pocketed phone is still reporting. The `AppState` listener below is the mitigation: coming
 * back to the app sends a position immediately instead of waiting out the rest of the interval.
 */

/** One position report. The shape `lifeline.ping` takes, minus the plumbing. */
export interface LifelinePingInput {
  id: string;
  lng: number;
  lat: number;
  eleM: number | null;
  batteryPct: number | null;
}

/** Sends one ping. Set once at the app root, where the tRPC client lives. */
export type Pinger = (ping: LifelinePingInput) => Promise<{ at: Date }>;

export interface LifelinePingState {
  /** When the server last acknowledged a position, this run. */
  lastPingAt: Date | null;
  /** Why the last attempt did not land, if it did not. Never an alarm — see `send`. */
  error: string | null;
}

/**
 * Accuracy for a fix asked for on the Lifeline's own account.
 *
 * `High` rather than `BestForNavigation`: this is one position every three minutes, not a
 * track, and the extra tens of metres are not worth what the top tier costs a battery that has
 * to last until dark. When a hike is recording, this path is not taken at all.
 */
const STANDALONE_ACCURACY = Location.Accuracy.High;

const listeners = new Set<() => void>();

let pinger: Pinger | null = null;
let sessionId: string | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let resumed: NativeEventSubscription | null = null;
let sending = false;
let lastPingAt: Date | null = null;
let error: string | null = null;

/**
 * One cached object, replaced only when something in it changes. `useSyncExternalStore`
 * compares with `Object.is`, so returning a fresh literal per read would re-render forever.
 */
let snapshot: LifelinePingState = { lastPingAt: null, error: null };

function emit(): void {
  snapshot = { lastPingAt, error };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): LifelinePingState {
  return snapshot;
}

/** What the panel shows about the link: when a position last landed, and what is in the way. */
export function useLifelinePings(): LifelinePingState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Set once, at the app root, where the tRPC client already exists. */
export function setPinger(next: Pinger | null): void {
  pinger = next;
}

/**
 * Follow this Lifeline, or none.
 *
 * Idempotent on the id, because the app root calls it from an effect that re-runs whenever the
 * `lifeline.active` query settles — which is often, and must not restart the interval each
 * time. Passing `null` stops the loop, which is what makes the promise on the follow page
 * mechanical rather than a matter of trust: the position is not withheld after a hike ends, it
 * stops being sent.
 */
export function watchLifeline(next: string | null): void {
  if (next === sessionId) return;
  sessionId = next;
  stopLoop();
  lastPingAt = null;
  error = null;
  emit();
  if (next === null) return;

  // Immediately, then on the interval. The first one matters more than the cadence: a hiker
  // who sets off, hands over the link and then loses signal for forty minutes should still
  // have given their contact a dot at the car park.
  void send();
  timer = setInterval(() => void send(), LIFELINE_PING_INTERVAL_S * 1000);
  resumed = AppState.addEventListener('change', (state) => {
    if (state === 'active') void send();
  });
}

function stopLoop(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  resumed?.remove();
  resumed = null;
}

/**
 * One attempt.
 *
 * A failure is never surfaced as an alarm. A ping that does not land is a phone in a valley,
 * which is the normal state of affairs on a hike — and the follow page already reports how old
 * the last position is, which is the honest version of the same fact.
 */
async function send(): Promise<void> {
  const id = sessionId;
  if (id === null || !pinger || sending) return;
  sending = true;
  try {
    const fix = await freshFix();
    if (!fix) {
      if (sessionId === id) {
        error = 'Waiting for a position.';
        emit();
      }
      return;
    }
    const { at } = await pinger({
      id,
      lng: fix.lng,
      lat: fix.lat,
      eleM: fix.eleM,
      batteryPct: await batteryPct(),
    });
    // The Lifeline can end while a ping is in flight. Landing its result would put a stale
    // "position sent just now" under a panel that has already gone back to its closed state.
    if (sessionId !== id) return;
    lastPingAt = at;
    error = null;
    emit();
  } catch (cause) {
    if (sessionId !== id) return;
    error = cause instanceof Error ? cause.message : 'Could not send your position.';
    emit();
  } finally {
    sending = false;
  }
}

/**
 * A position worth sending, or nothing.
 *
 * The rule that makes this feature honest: **never ping with an old fix.** `lastPingAt` is
 * stamped server-side at the moment the ping lands, so sending a forty-minute-old position
 * would put "last heard: just now" under a dot on the wrong side of a mountain. Better by far
 * to send nothing and let the follow page report the position going stale, which is true.
 */
async function freshFix(): Promise<RecordedFix | null> {
  const recorded = latestFix();
  if (recorded && Date.now() - recorded.at < LIFELINE_PING_INTERVAL_S * 1000) return recorded;
  return currentPosition();
}

async function currentPosition(): Promise<RecordedFix | null> {
  try {
    // Asked for rather than assumed. A Lifeline can be started without recording anything, so
    // this may be the first time the app has wanted a position at all.
    const held = await Location.getForegroundPermissionsAsync();
    if (!held.granted) {
      const asked = await Location.requestForegroundPermissionsAsync();
      if (!asked.granted) return null;
    }
    const reading = await Location.getCurrentPositionAsync({ accuracy: STANDALONE_ACCURACY });
    const alt = reading.coords.altitude;
    return {
      at: Date.now(),
      lng: reading.coords.longitude,
      lat: reading.coords.latitude,
      // Dropped rather than clamped when it is outside anywhere a person can stand. A
      // barometric altimeter indoors can report a kilometre underground, and one absurd number
      // must not cost the whole ping — the position is the part that matters.
      eleM: alt != null && Number.isFinite(alt) && alt > -500 && alt < 9_500 ? alt : null,
    };
  } catch {
    return null;
  }
}

/**
 * Battery percentage, where the device will say.
 *
 * A follower's first question about a phone that has gone quiet is whether it died, and this is
 * the difference between an answer and an hour of imagining. `-1` on a simulator and on devices
 * that do not report it, which is why every consumer treats null as ordinary.
 */
async function batteryPct(): Promise<number | null> {
  try {
    const level = await Battery.getBatteryLevelAsync();
    if (!Number.isFinite(level) || level < 0) return null;
    return Math.max(0, Math.min(100, Math.round(level * 100)));
  } catch {
    return null;
  }
}
