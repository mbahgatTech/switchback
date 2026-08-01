import { useSyncExternalStore } from 'react';
import { AppState, type NativeEventSubscription } from 'react-native';
import * as Battery from 'expo-battery';
import * as Location from 'expo-location';
import { LIFELINE_PING_INTERVAL_S } from '@switchback/core';
import { latestFix, type RecordedFix } from '@/record/store';

/**
 * The Lifeline ping loop, at module scope like `@/record/store`: a loop in the Record screen's
 * `useEffect` would silently stop the moment somebody switched tabs, on a safety feature whose
 * own screen would go on claiming it was running.
 *
 * A ping is not a side effect of recording. The loop keeps its own cadence
 * (`LIFELINE_PING_INTERVAL_S`, slower than the recorder's upload tick) and takes the recorder's
 * fix only when a fresh one is going spare — never an old one; see `freshFix`.
 *
 * Timers do not run while the app is suspended, so pings stop when Switchback is off screen and
 * the panel says so. The `AppState` listener is the mitigation: returning to the app sends a
 * position immediately rather than waiting out the interval.
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
 * Accuracy for a fix asked for on the Lifeline's own account. `High` rather than
 * `BestForNavigation`: one position every three minutes is not a track, and the top tier costs
 * a battery that has to last until dark. Not taken at all while a hike is recording.
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
 * Follow this Lifeline, or none. Idempotent on the id: the app root calls it from an effect
 * that re-runs whenever `lifeline.active` settles, which must not restart the interval. Passing
 * `null` stops the loop, which is what makes the follow page's promise mechanical.
 */
export function watchLifeline(next: string | null): void {
  if (next === sessionId) return;
  sessionId = next;
  stopLoop();
  lastPingAt = null;
  error = null;
  emit();
  if (next === null) return;

  // Immediately, then on the interval: a hiker who hands over the link and loses signal for
  // forty minutes should still have given their contact a dot at the car park.
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
 * One attempt. A failure is never surfaced as an alarm: a ping that does not land is a phone in
 * a valley, and the follow page already reports how old the last position is.
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
    // The Lifeline can end while a ping is in flight; landing its result would put a stale
    // "position sent just now" under a panel that has already closed.
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
 * A position worth sending, or nothing. **Never ping with an old fix**: `lastPingAt` is stamped
 * server-side as the ping lands, so a forty-minute-old position would put "last heard: just now"
 * under a dot on the wrong side of a mountain.
 */
async function freshFix(): Promise<RecordedFix | null> {
  const recorded = latestFix();
  if (recorded && Date.now() - recorded.at < LIFELINE_PING_INTERVAL_S * 1000) return recorded;
  return currentPosition();
}

async function currentPosition(): Promise<RecordedFix | null> {
  try {
    // Asked for rather than assumed: a Lifeline can be started without recording anything.
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
      // Dropped rather than clamped when outside anywhere a person can stand: a barometric
      // altimeter indoors can report a kilometre underground, and the position is what matters.
      eleM: alt != null && Number.isFinite(alt) && alt > -500 && alt < 9_500 ? alt : null,
    };
  } catch {
    return null;
  }
}

/**
 * Battery percentage, where the device will say — a follower's first question about a phone
 * that has gone quiet. `-1` on a simulator and on devices that do not report it, so every
 * consumer treats null as ordinary.
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
