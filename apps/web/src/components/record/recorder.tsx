'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useMutation } from '@tanstack/react-query';
import {
  ACTIVITY_NAME_MAX,
  ACTIVITY_NOTES_MAX,
  ACTIVITY_TYPE_LABELS,
  COMMON_ACTIVITY_TYPES,
  VISIBILITIES,
  VISIBILITY_LABELS,
  defaultActivityName,
  formatClock,
  formatDistance,
  formatElevation,
  paceFromSpeed,
  type ActivitySummary,
  type ActivityType,
  type LineString,
  type LngLat,
  type UnitSystem,
  type Visibility,
} from '@switchback/core';
import { useTRPC } from '../../trpc/react';
import { isMissing, markFinished, newActivityId, type FinishWrite } from '../../offline/activities';
import { isUnreachable } from '../../offline/queue';
import { BUTTON, DANGER, HEIGHT, PRIMARY, SECONDARY } from '../controls';
import { LifelinePanel } from './lifeline-panel';
import { RecordMap } from './record-map';
import { useRecorder, type RecorderOptions, type RecorderPhase } from './use-recorder';

/**
 * The recorder.
 *
 * Everything on this screen is read at arm's length, in daylight, by someone who is hiking.
 * That single fact settles most of the layout arguments: the numbers are enormous and set in
 * mono so they do not reflow as they tick, the controls are far enough apart that a gloved
 * thumb cannot hit the wrong one, and there is exactly one thing on the page that is red.
 *
 * **The instrument is the signature.** Distance sits alone above a hairline, at display size,
 * with a collar label over it — the face of a bezel-mounted gauge, which is what a person
 * glancing at their phone on a ridge actually wants. Everything else is a secondary dial
 * beneath it. It is the same graphic language as the elevation section on a trail page: a
 * measurement, labelled the way a sheet labels its margin, and nothing decorative near it.
 *
 * Survey red appears on this screen only where somebody's safety is the subject: the position
 * dot, the banner that says you have left the trail, an overdue Lifeline, and the two
 * confirmations that throw a hike away. Not on the record button, however much a record button
 * wants to be red — a control that shares a colour with a wrong-turn alert is a control that
 * makes the alert mean less.
 *
 * **Pressing start does not wait for the server.** The id is minted here, on the device, and
 * `activities.start` is sent afterwards as a confirmation rather than as a precondition — it
 * carries that same id, and the server adopts it. So a hike begins with no signal exactly as
 * it begins with five bars, the GPS watch starts on the press rather than a round trip later,
 * and the recording is already a queued row from its first second. `offline/activities.ts`
 * holds the idempotency argument that makes that safe to retry.
 */

export interface RecorderTrail {
  id: string;
  name: string;
  slug: string;
  geometry: LineString;
  lengthM: number;
}

export interface RecorderProps {
  units: UnitSystem;
  defaultVisibility: Visibility;
  /** The trail this hike is following, when the page was opened from one. */
  trail: RecorderTrail | null;
  /** A recording left open on the server — from this device or another one. */
  openRecording: ActivitySummary | null;
}

/**
 * What the screen has to say about the hike that just ended, when it does not navigate away.
 *
 * Three endings need one: a hike closed with no connection, which is safe on the device and is
 * now the drain's business; a hike finished on a browser that is acting as somebody else by
 * then, which is safe on the device and waiting for its own author; and a hike the server
 * closed before this device had sent all of it, whose tail no longer has anywhere to go. All
 * three are the answer to "where did my hike go?", so all three are written into the same
 * region at the top of the readout.
 */
type Receipt =
  | { kind: 'offline' }
  /** Finished while the browser was acting as somebody else. Held for the hiker who walked it. */
  | { kind: 'held' }
  /** `activityId` is the saved hike, `lost` the fixes the server would not take. */
  | { kind: 'truncated'; activityId: string; lost: number };

export function Recorder({ units, defaultVisibility, trail, openRecording }: RecorderProps) {
  const trpc = useTRPC();
  const router = useRouter();

  const [activityType, setActivityType] = useState<ActivityType>('hiking');
  const [follow, setFollow] = useState(true);
  const [finishing, setFinishing] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  /**
   * The permanent live region the receipt is written into, and where focus goes with it.
   *
   * Two things this element is doing, both of them because it is the answer to "where did my
   * hike go?". It is mounted whether or not there is anything in it: assistive technology
   * misses a `role="status"` region that arrives in the DOM together with its text, so the
   * container is constant and only the sentence is swapped — the same rule, and the same
   * mistake corrected, as the notice on `/downloads` (`downloads-manager.tsx`). And it is
   * focusable, because the offline finish is the one ending that does not navigate: closing
   * the dialog unmounts it while the control that opened it is being replaced on the ledge,
   * which measurably drops focus to `<body>`. Focus lands where the outcome is written.
   */
  const receiptRef = useRef<HTMLDivElement | null>(null);
  /**
   * The scrollport that holds the readout. Driven, not just read.
   *
   * Everything the phase changes into view is inserted at the *top* of this box — the
   * off-route banner, the receipt for a hike saved with no connection — and the box keeps
   * whatever scroll position the hiker left it at. At 320×568 that position is rarely zero:
   * five of the fourteen things on the recording screen are below the fold, so reading your
   * GPS accuracy or reaching the Lifeline means scrolling, and nothing scrolls back. Measured
   * with the readout where a hiker leaves it, the wrong-turn alert renders 430px above the
   * top of its own scrollport: none of it on the glass, and it is the only wrong-turn warning
   * the product has.
   *
   * So the two effects below put the top of the readout back on screen whenever something
   * lands there. `overflow-y-auto` is what made the column reachable at all; this is what
   * keeps "reachable" from meaning "reachable if you happen to scroll".
   */
  const readout = useRef<HTMLDivElement | null>(null);
  const wasIdle = useRef(true);

  const route = useMemo<readonly LngLat[] | null>(
    () => trail?.geometry.coordinates ?? null,
    [trail],
  );

  const append = useMutation(trpc.activities.append.mutationOptions());
  const appendRef = useRef(append);
  appendRef.current = append;

  /**
   * Posts `activities.start`, for the recorder to call when the server has not heard of a
   * hike it is about to upload. Assigned below, once the mutation exists.
   */
  const startServerRef = useRef<RecorderOptions['onStart']>(() =>
    Promise.reject(new Error('The recorder is not ready.')),
  );

  const recorder = useRecorder({
    onFlush: (id, fixes) => appendRef.current.mutateAsync({ id, fixes }),
    // Announcing the recording is the upload path's job, not the button's — see the note on
    // `RecorderOptions.onStart`. Held in a ref because `start` is declared below this call.
    onStart: (input) => startServerRef.current(input),
    route,
    routeLengthM: trail?.lengthM ?? null,
  });

  const start = useMutation(
    trpc.activities.start.mutationOptions({
      onSuccess: (activity) => {
        setStartError(null);
        // The recording is already running under this id; all the server has added is that
        // it now knows about it. Nothing on screen changes.
        recorder.noteServerStarted(activity.id);
      },
      onError: (err) => {
        // No signal is not an error here. The hike is recording, the row is queued, and the
        // next flush posts this same `start` when the connection comes back — so there is
        // nothing to tell the hiker and nothing for them to do about it.
        if (isUnreachable(err)) return;
        setStartError(err.message);
      },
    }),
  );
  startServerRef.current = (input) =>
    start.mutateAsync({
      id: input.id,
      activityType: input.activityType,
      startedAt: input.startedAt,
      ...(input.trailId ? { trailId: input.trailId } : {}),
    });

  const finish = useMutation(trpc.activities.finish.mutationOptions());
  const remove = useMutation(trpc.activities.remove.mutationOptions());

  const running = recorder.phase === 'recording' || recorder.phase === 'locating';
  const live = running || recorder.phase === 'paused';

  // Something has landed at the top of the readout. Put the top of the readout on screen.
  useEffect(() => {
    if (recorder.offRoute || recorder.alert !== null || receipt !== null) {
      readout.current?.scrollTo({ top: 0 });
    }
  }, [recorder.offRoute, recorder.alert, receipt]);

  // And the receipt takes focus with it. The offline finish is the only ending that stays on
  // this screen, and the dialog it closes is unmounted while the button that opened it is
  // being replaced — which drops focus to `<body>` and leaves a keyboard reader at the top of
  // the document with no idea the hike was saved.
  useEffect(() => {
    if (receipt) receiptRef.current?.focus();
  }, [receipt]);

  // And on the way into a hike. Choosing anything but Hiking means scrolling the chooser into
  // view, and Start is on the ledge — so the press that begins a hike is routinely made from
  // a scrolled column, and the first second of the recording would otherwise open with the
  // distance gauge, which this file calls the signature, entirely off the glass.
  useEffect(() => {
    if (wasIdle.current && recorder.phase !== 'idle') readout.current?.scrollTo({ top: 0 });
    wasIdle.current = recorder.phase === 'idle';
  }, [recorder.phase]);

  // The elapsed clock ticks off the wall, not off the fixes, so it keeps moving through a
  // stretch with no signal. It is the same figure the server derives — `t` is measured from
  // `startedAt` whatever happens in between, so a pause shows up in moving time and not here.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [running]);

  const elapsedS = recorder.startedAt
    ? running
      ? Math.max(0, Math.round((nowMs - recorder.startedAt.getTime()) / 1000))
      : recorder.stats.elapsedTimeS
    : 0;

  // Leaving mid-hike is how a recording gets orphaned, so the browser asks first. Only while
  // something is genuinely unsaved — a prompt on a finished hike is the boy who cried wolf.
  useEffect(() => {
    if (!live || recorder.pending === 0) return;
    const warn = (event: BeforeUnloadEvent): void => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [live, recorder.pending]);

  const track = useMemo<Array<[number, number]>>(
    () => recorder.fixes.map((fix) => [fix.lng, fix.lat]),
    [recorder.fixes],
  );

  // The elevation of the last fix that was good enough to keep, for the Lifeline ping. Read
  // off the track rather than off `position`, which carries no altitude.
  const lastEleM = useMemo<number | null>(() => {
    const last = recorder.fixes[recorder.fixes.length - 1];
    return last?.eleM ?? null;
  }, [recorder.fixes]);

  async function onFinish(input: {
    name: string;
    notes: string;
    visibility: Visibility;
    logCompletion: boolean;
  }): Promise<void> {
    const id = recorder.activityId;
    if (!id) return;
    setSaveError(null);
    recorder.stop();
    // Everything still in the buffer goes up before the recording is closed, because
    // `finish` computes the hike from what is stored and nothing else. `flush` joins a drain
    // that is already running rather than returning past it — see its note in `use-recorder`;
    // returning early here is what used to let `finish` land in the middle of a backlog and
    // close the recording under the loop still uploading it.
    try {
      await recorder.flush();
    } catch {
      // Reported by the recorder already. Closing anyway is the right call: the alternative
      // is a hike that cannot be ended because the last minute will not upload. What it costs
      // is counted below rather than swallowed.
    }
    // Read after the await, not off the render this closure was made in.
    const lost = recorder.outstanding();

    const write: FinishWrite = {
      id,
      name: input.name.trim() || null,
      notes: input.notes.trim() || null,
      visibility: input.visibility,
      trailId: recorder.trailId,
      logCompletion: input.logCompletion,
    };

    /**
     * Write the finish onto the queued row and let go of the screen, leaving the hike on this
     * device for a drain to publish.
     *
     * Two endings need exactly this — no connection, and no longer this browser's hike to post
     * — and the order matters in both. `markFinished` is awaited and its failure is not
     * swallowed: the receipt each caller then prints says the hike is safe on this device, and
     * `handOff` throws away the in-memory buffer that is otherwise the last copy of it, so on a
     * device whose storage has been refusing writes all day (quota, private mode, a locked
     * profile) that sentence used to be printed over a hike it had just destroyed. Nothing is
     * cleared until the write is known to have happened, which since `idb.run` resolves on
     * commit is now what that means.
     *
     * `handOff` rather than `forget`, which would delete the only copy of the day.
     *
     * False when the device would not take it, having already said so and put the recorder back
     * where the hiker can try again.
     *
     * An arrow rather than a declaration so that the `if (!id) return` above it still narrows
     * `id` here; a hoisted declaration could in principle run before that check, and the
     * compiler is right to say so.
     */
    const keepForTheDrain = async (): Promise<boolean> => {
      try {
        await markFinished(id, write);
      } catch {
        recorder.unstop();
        setSaveError(
          'This hike could not be saved on this device — its storage is full or blocked. ' +
            'Keep this tab open and try again; the recording is still here.',
        );
        return false;
      }
      recorder.handOff();
      setFinishing(false);
      // The hike this belonged to has gone. See `onDiscard`.
      setStartError(null);
      return true;
    };

    /*
     * Somebody else is signed in now, so this hike is not this browser's to publish.
     *
     * The last and most expensive place to be wrong on this screen. `finish` does not merely
     * upload — it publishes a day, attaches it to whichever account the request carries and
     * logs a completion against the trail under that name. It is also the request furthest in
     * time from the press that decided the name: a hike is hours, the finish dialog is however
     * long it takes somebody to write a note, and on a shared laptop a sign-in can land
     * anywhere in that. Asked here rather than trusted from the flush above, because the flush
     * may have stopped for exactly this reason and returned without a word — see `stillMine`.
     *
     * The hike is not lost and not blocked: the payload goes onto the row, the row keeps every
     * fix, and `flushPendingActivities` sends the lot the moment its own author signs back in.
     * `/downloads` counts it as held for another account in the meantime, and shows nothing of
     * what it says.
     */
    if (!recorder.stillMine()) {
      if (await keepForTheDrain()) setReceipt({ kind: 'held' });
      return;
    }

    try {
      const saved = await finish.mutateAsync(write);
      recorder.forget();
      setFinishing(false);
      /*
       * Fixes that were still outstanding when the hike closed are gone, and saying so is
       * this path's job.
       *
       * `finish` has just set `endedAt` and `syncedAt` on the server, and `append` refuses a
       * row carrying both, permanently — so there is no later run of the drain that could
       * land them, and `forget()` is right to delete chunks nothing will ever take. What was
       * wrong was doing it in silence. The drain says exactly this sentence when it hits the
       * same wall (`flushPendingActivities`, `truncated`), and it could never say it for this
       * path because the row was deleted here before any drain saw it.
       *
       * Reported on this screen rather than navigated past: the hike is open in the account
       * and one link away, and a notice on `/downloads` is a notice on a page nobody opens.
       */
      if (lost > 0) {
        setReceipt({ kind: 'truncated', activityId: saved.id, lost });
        return;
      }
      router.push(`/activities/${saved.id}`);
    } catch (error) {
      if (isUnreachable(error)) {
        // The hike ends here as far as the hiker is concerned. The row keeps everything —
        // the fixes and now this payload — and the drain replays start, append and finish
        // when there is a connection. No `router.push`: `/activities/:id` does not exist yet,
        // and is not a page that can be rendered with no network.
        //
        // Nothing is truncated on this branch however much is outstanding: the row still
        // holds every fix and the drain sends them all before it replays this payload.
        if (await keepForTheDrain()) setReceipt({ kind: 'offline' });
        return;
      }
      // The server refused it. Leave `saving` so the dialog's buttons work again and the
      // hiker can read the reason, change something, and try — rather than being locked out
      // of their own hike behind a modal that can neither be confirmed nor cancelled.
      recorder.unstop();
    }
  }

  /**
   * The press.
   *
   * The id is minted here and the recording begins immediately; `start.mutate` carries that
   * same id and is a confirmation, not a precondition. Lives on the Recorder rather than on
   * the start panel because the button it belongs to now sits on the control ledge, which is
   * a sibling of the panel rather than part of it.
   */
  function onStartPress(): void {
    const id = newActivityId();
    const startedAt = new Date();
    setStartError(null);
    setSaveError(null);
    setReceipt(null);
    recorder.begin({
      id,
      startedAt,
      trailId: trail?.id ?? null,
      trailName: trail?.name ?? null,
      activityType,
      serverStarted: false,
    });
    start.mutate({
      id,
      activityType,
      startedAt,
      ...(trail ? { trailId: trail.id } : {}),
    });
  }

  async function onDiscard(): Promise<void> {
    const id = recorder.activityId;
    if (id) {
      try {
        await remove.mutateAsync({ id });
      } catch (error) {
        // Nothing there to delete, in either of the two ways that happens: no connection to
        // ask over, or a hike begun with no signal that the server has never been told about.
        // Refusing to discard would leave a hiker unable to throw away a false start until
        // they found signal, which is the worse of the two.
        if (!isUnreachable(error) && !isMissing(error)) throw error;
      }
    }
    recorder.forget();
    setConfirmDiscard(false);
    // The hike that error was about has just been thrown away. Left set, it is re-rendered by
    // the ledge's `!live` branch — a fresh `role="alert"` node, so it is announced again,
    // assertively — above a Start button, describing a recording that no longer exists.
    setStartError(null);
    setSaveError(null);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
      <div className="relative h-[40dvh] shrink-0 lg:h-auto lg:flex-1">
        <RecordMap
          className="absolute inset-0 h-full w-full"
          track={track}
          route={trail?.geometry ?? null}
          position={recorder.position}
          accuracyM={recorder.accuracyM}
          follow={follow}
          onUserPan={() => setFollow(false)}
        />
        {!follow && recorder.position ? (
          <button
            type="button"
            onClick={() => setFollow(true)}
            className={`${BUTTON} clear-home-indicator absolute bottom-md left-1/2 ${HEIGHT.touch} -translate-x-1/2 border-ink bg-canvas px-md text-ink`}
          >
            Recentre
          </button>
        ) : null}
      </div>

      {/*
        The readout is two boxes, not one: a scrollport holding everything that is *read*, and
        a ledge below it holding the one control the current phase exists for. The screen is
        `h-dvh overflow-hidden` — the correct shell for an instrument, and the same one `/plan`
        and `/` use — which means a column that overflows it is not scrollable by any gesture
        at all. Before this it did: at 320×568 "Start recording" sat 177px past the bottom of
        the phone with no way to reach it, and the Lifeline's setup form stranded seven more
        controls at 1280×800. So the column has to bound itself.

        The ledge is a sibling rather than something floating, because this product has no
        z-axis: a `sticky` or absolutely-positioned bar would occlude the tail of whatever is
        under it and need a hand-tuned padding to compensate. As a flow child it simply takes
        its height out of the scrollport's, and Start / Pause / Finish land at a fixed place on
        the glass that does not move when the off-route banner appears or the Lifeline opens.

        `lg:flex-none` on the column, not `lg:shrink-0`: `flex-1` is `1 1 0%`, and overriding
        only the shrink term leaves a grow of 1 with a basis of 0, which beats `w-[420px]` on
        the row's main axis and splits the desktop half and half with the map.
      */}
      <div className="flex min-h-0 w-full flex-1 flex-col border-t border-bezel lg:w-[420px] lg:flex-none lg:border-l lg:border-t-0">
        {/*
          `lg:flex-initial` rather than `flex-1` on the desktop breakpoint so a column with
          room to spare keeps its old shape — content, then the ledge directly beneath it —
          and only starts scrolling when the Lifeline makes it taller than the window.
        */}
        <div
          ref={readout}
          className="flex min-h-0 flex-1 flex-col gap-lg overflow-y-auto overscroll-contain px-lg py-lg lg:flex-initial lg:px-xl"
        >
          {recorder.offRoute ? (
            <OffRouteBanner
              distanceM={recorder.offRouteDistanceM}
              units={units}
              trailName={trail?.name ?? 'the trail'}
            />
          ) : null}

          {recorder.alert === 'returned' ? (
            <p
              className="rounded-hair border border-woodland px-md py-sm text-caption text-ink"
              role="status"
            >
              Back on {trail?.name ?? 'the trail'}.
            </p>
          ) : null}

          {/*
            The receipt for a hike that has just ended. At the top of the scrollport rather
            than inside the start panel, where it began: the start panel now sits below a
            full-height instrument, so on a 320px phone the receipt would have opened below
            the fold — and "where did my hike go?" is the one question this screen must answer
            without being scrolled.

            The container is mounted whether or not it has anything to say, and only its
            contents are swapped. A `role="status"` region that arrives in the DOM at the same
            moment as its text is missed by assistive technology — the note on the equivalent
            region in `downloads-manager.tsx` sets out the same rule, and this element was
            built the way that note says does not work.

            `sr-only` while it is empty rather than a bare zero-height box: the scrollport is a
            `gap-lg` column, and an empty flex item still takes a gap on both sides of itself,
            which would open 24px of nothing above the instrument on every idle screen.
            `sr-only` is absolutely positioned, so it leaves the flow without leaving the
            accessibility tree — which is the whole point of keeping it mounted.
          */}
          <div
            ref={receiptRef}
            role="status"
            tabIndex={-1}
            className={
              receipt && !live
                ? `rounded-hair border px-md py-sm ${
                    receipt.kind === 'offline' ? 'border-water' : 'border-bezel'
                  }`
                : 'sr-only'
            }
          >
            {receipt && !live ? <ReceiptBody receipt={receipt} /> : null}
          </div>

          <Instrument
            units={units}
            distanceM={recorder.stats.distanceM}
            elapsedS={elapsedS}
            movingS={recorder.stats.movingTimeS}
            gainM={recorder.stats.gainM}
            avgSpeedMps={recorder.stats.avgSpeedMps}
            remainingM={recorder.remainingM}
            idle={!live}
          />

          {live ? (
            <Status
              phase={recorder.phase}
              accuracyM={recorder.accuracyM}
              weakSignal={recorder.weakSignal}
              pending={recorder.pending}
              syncing={recorder.syncing}
              lastSyncAt={recorder.lastSyncAt}
              geoError={recorder.geoError}
              syncError={recorder.syncError}
              syncOffline={recorder.syncOffline}
              units={units}
            />
          ) : null}

          {/*
            A start the server refused rather than failed to receive — an expired session, most
            likely. Once the hike is live the ledge below carries the transport row instead of
            the start button, so this is the only place the refusal can be read. The hike is
            safe either way: it is on the device and queued.
          */}
          {live && startError ? (
            <p className="text-caption text-survey" role="alert">
              {startError} The hike is recording and saved on this device.
            </p>
          ) : null}

          {!live ? (
            <StartPanel
              openRecording={openRecording}
              units={units}
              activityType={activityType}
              onActivityType={setActivityType}
              onAdopt={(open) => {
                setStartError(null);
                setReceipt(null);
                recorder.begin({
                  id: open.id,
                  startedAt: open.startedAt,
                  trailId: open.trail?.id ?? null,
                  trailName: open.trail?.name ?? null,
                  activityType: open.activityType,
                  resumed: true,
                  serverStarted: true,
                });
              }}
            />
          ) : (
            <div className="flex flex-col gap-sm">
              {confirmDiscard ? (
                <div className="flex flex-col gap-xs rounded-hair border border-survey px-md py-sm">
                  <div className="flex items-center gap-sm">
                    <p className="flex-1 text-caption text-ink">
                      Throw this hike away? It cannot be recovered.
                    </p>
                    <button
                      type="button"
                      onClick={() => void onDiscard().catch(() => undefined)}
                      disabled={remove.isPending}
                      className={`${BUTTON} ${DANGER} ${HEIGHT.touch} px-md`}
                    >
                      {remove.isPending ? 'Discarding' : 'Discard'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDiscard(false)}
                      className={`${BUTTON} ${SECONDARY} ${HEIGHT.touch} px-md`}
                    >
                      Keep
                    </button>
                  </div>
                  {/*
                    A refusal the server did send — the offline case never gets here, because
                    `onDiscard` treats an unreachable server as nothing to delete. Without this
                    the button would simply do nothing and the hiker would press it again.
                  */}
                  {remove.error ? (
                    <p className="text-caption text-survey" role="alert">
                      {remove.error.message} The hike is still here.
                    </p>
                  ) : null}
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmDiscard(true)}
                  className={`${HEIGHT.touch} inline-flex items-center self-start text-caption text-ink-muted underline decoration-bezel underline-offset-4 transition-colors duration-quick hover:text-survey hover:decoration-survey`}
                >
                  Discard this recording
                </button>
              )}
            </div>
          )}

          <LifelinePanel
            activityId={recorder.activityId}
            trailId={recorder.trailId ?? trail?.id ?? null}
            trailName={trail?.name ?? null}
            position={recorder.position}
            eleM={lastEleM}
          />

          {trail ? (
            <p className="text-caption text-ink-muted">
              Following{' '}
              <Link
                href={`/trails/${trail.slug}`}
                className="text-ink underline decoration-bezel underline-offset-4 hover:decoration-ink"
              >
                {trail.name}
              </Link>
              . Wrong-turn alerts are on.
            </p>
          ) : null}
        </div>

        {/*
          The ledge. One row, one job: whatever the phase is for.

          `clear-home-indicator` is margin rather than padding for the reason its own note
          gives — margin lifts the whole box clear of the strip at the bottom of a modern
          iPhone, and what shows through underneath is the shell's own canvas, so there is no
          seam. `env()` is zero everywhere without an inset, which includes every desktop.

          It is labelled because it is the last thing in the column now rather than the middle:
          a reader arriving here by keyboard should be told what the group is, not just given
          two buttons after a safety panel.
        */}
        <div
          role="group"
          aria-label="Recording controls"
          className="clear-home-indicator flex shrink-0 flex-col gap-sm border-t border-bezel bg-canvas px-lg py-md lg:px-xl lg:py-lg"
        >
          {live ? (
            <div className="flex gap-sm">
              {running ? (
                <button
                  type="button"
                  onClick={recorder.pause}
                  className={`${BUTTON} ${SECONDARY} ${HEIGHT.field} flex-1 px-lg`}
                >
                  Pause
                </button>
              ) : (
                <button
                  type="button"
                  onClick={recorder.resume}
                  className={`${BUTTON} ${PRIMARY} ${HEIGHT.field} flex-1 px-lg`}
                >
                  Resume
                </button>
              )}
              <button
                type="button"
                onClick={() => setFinishing(true)}
                className={`${BUTTON} ${running ? SECONDARY : PRIMARY} ${HEIGHT.field} flex-1 px-lg`}
              >
                Finish
              </button>
            </div>
          ) : (
            <>
              {startError ? (
                <p className="text-caption text-survey" role="alert">
                  {startError}
                </p>
              ) : null}
              <button
                type="button"
                onClick={onStartPress}
                disabled={start.isPending}
                className={`${BUTTON} ${PRIMARY} ${HEIGHT.field} w-full px-lg text-body-lg`}
              >
                {start.isPending ? 'Starting' : trail ? `Record ${trail.name}` : 'Start recording'}
              </button>
            </>
          )}
        </div>
      </div>

      {finishing ? (
        <FinishDialog
          units={units}
          defaultName={defaultActivityName(
            activityType,
            recorder.startedAt ?? new Date(),
            trail?.name ?? null,
          )}
          defaultVisibility={defaultVisibility}
          hasTrail={recorder.trailId !== null}
          distanceM={recorder.stats.distanceM}
          elapsedS={elapsedS}
          saving={finish.isPending || recorder.phase === 'saving'}
          error={saveError ?? finish.error?.message ?? null}
          onCancel={() => setFinishing(false)}
          onConfirm={onFinish}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The instrument
// ---------------------------------------------------------------------------

interface InstrumentProps {
  units: UnitSystem;
  distanceM: number;
  elapsedS: number;
  movingS: number;
  gainM: number;
  avgSpeedMps: number | null;
  remainingM: number | null;
  idle: boolean;
}

function Instrument({
  units,
  distanceM,
  elapsedS,
  movingS,
  gainM,
  avgSpeedMps,
  remainingM,
  idle,
}: InstrumentProps) {
  const [value, unit] = splitMeasurement(formatDistance(distanceM, units));
  return (
    <div className="rounded-hair border border-bezel bg-surface">
      <div className="px-lg pb-md pt-lg">
        <p className="collar">Distance</p>
        <p
          className={`font-mono tabular-nums ${idle ? 'text-ink-muted' : 'text-ink'}`}
          // The one place in the product that goes past h1. A gauge face is read from
          // further away than a heading, and the leading is set explicitly because the
          // mono face's own is far too generous at this size.
          style={{ fontSize: 'var(--text-display)', lineHeight: '1.02' }}
        >
          {value}
          <span className="ml-xs align-baseline text-h4 text-ink-muted">{unit}</span>
        </p>
      </div>

      <div className="grid grid-cols-2 border-t border-bezel">
        <Dial label="Elapsed" value={formatClock(elapsedS)} idle={idle} />
        <Dial label="Moving" value={formatClock(movingS)} idle={idle} border />
        <Dial label="Ascent" value={formatElevation(gainM, units)} idle={idle} top />
        <Dial label="Pace" value={paceFromSpeed(avgSpeedMps, units)} idle={idle} border top />
        {remainingM != null ? (
          <Dial label="To finish" value={formatDistance(remainingM, units)} idle={idle} top wide />
        ) : null}
      </div>
    </div>
  );
}

function Dial({
  label,
  value,
  idle,
  border,
  top,
  wide,
}: {
  label: string;
  value: string;
  idle: boolean;
  border?: boolean;
  top?: boolean;
  wide?: boolean;
}) {
  return (
    <div
      className={`px-lg py-md ${border ? 'border-l border-bezel' : ''} ${
        top ? 'border-t border-bezel' : ''
      } ${wide ? 'col-span-2' : ''}`}
    >
      <p className="collar">{label}</p>
      <p
        className={`font-mono text-h4 tabular-nums ${idle ? 'text-ink-muted' : 'text-ink'}`}
        style={{ lineHeight: '1.3' }}
      >
        {value}
      </p>
    </div>
  );
}

/**
 * Split "4.82 km" into the number and its unit so the unit can be set smaller.
 *
 * A units suffix at display size is as loud as the measurement, and the measurement is the
 * only thing being read. Falls back to the whole string as the value if there is no space,
 * which keeps a future format from silently losing its tail.
 */
function splitMeasurement(formatted: string): [string, string] {
  const at = formatted.lastIndexOf(' ');
  return at === -1 ? [formatted, ''] : [formatted.slice(0, at), formatted.slice(at + 1)];
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

function Status({
  phase,
  accuracyM,
  weakSignal,
  pending,
  syncing,
  lastSyncAt,
  geoError,
  syncError,
  syncOffline,
  units,
}: {
  phase: RecorderPhase;
  accuracyM: number | null;
  weakSignal: boolean;
  pending: number;
  syncing: boolean;
  lastSyncAt: Date | null;
  geoError: string | null;
  syncError: string | null;
  /** Whether the last upload failure was the connection rather than the server. */
  syncOffline: boolean;
  units: UnitSystem;
}) {
  const gps =
    phase === 'paused'
      ? 'Paused'
      : phase === 'locating'
        ? 'Finding you'
        : weakSignal
          ? `Weak, ±${formatElevation(accuracyM ?? 0, units)}`
          : accuracyM != null
            ? `±${formatElevation(accuracyM, units)}`
            : 'Recording';

  // The clock time of the last upload, not "2 minutes ago". A relative figure has to tick to
  // stay true, and this line is not worth a second render loop; an absolute time is right
  // the moment it is printed and stays right.
  const sync = syncing
    ? 'Saving'
    : pending > 0
      ? `${pending} ${pending === 1 ? 'fix' : 'fixes'} to save`
      : lastSyncAt
        ? `Saved ${lastSyncAt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
        : 'Nothing to save yet';

  return (
    <div className="flex flex-col gap-xs">
      <dl className="grid grid-cols-2 gap-x-lg">
        <div>
          <dt className="collar">Signal</dt>
          <dd className={`font-mono text-caption ${weakSignal ? 'text-survey' : 'text-ink-muted'}`}>
            {gps}
          </dd>
        </div>
        <div>
          <dt className="collar">Upload</dt>
          <dd className="font-mono text-caption text-ink-muted">{sync}</dd>
        </div>
      </dl>
      {geoError ? (
        <p className="text-caption text-survey" role="alert">
          {geoError}
        </p>
      ) : null}
      {/*
        Two different things, and the trailing clause used to be glued to both. `syncError`
        carries every refusal, not only a transport failure: an expired session, or a
        recording at the 20,000-sample cap whose own message is "Finish it and start another".
        Promising those will go up when the connection comes back is false, and in the second
        case it contradicts the instruction it is appended to. A refusal prints the server's
        sentence alone; only a connection that was not there gets the reassurance.
      */}
      {syncError ? (
        <p className="text-caption text-ink-muted">
          {syncOffline
            ? `${syncError} Still recording — it will go up when the connection comes back.`
            : syncError}
        </p>
      ) : null}
    </div>
  );
}

/**
 * What the receipt says, once there is something to say.
 *
 * Split out only so the container above it can be permanent — the region has to exist before
 * it has any text, and that is easier to read when the text is somewhere else.
 */
function ReceiptBody({ receipt }: { receipt: Receipt }) {
  if (receipt.kind === 'offline') {
    // Water, because it is a condition of the network and not a fault of the hiker's.
    return (
      <>
        <p className="collar text-water">Saved on this device</p>
        <p className="mt-hair text-caption text-ink">
          It will be added to your account when you have a connection. You can start another hike
          now.
        </p>
        <Link
          href="/downloads"
          className={`${HEIGHT.touch} mt-xs inline-flex items-center text-caption text-ink underline decoration-bezel underline-offset-4 hover:decoration-ink`}
        >
          See what is waiting
        </Link>
      </>
    );
  }

  if (receipt.kind === 'held') {
    /*
     * Ink, not water and not survey. Nothing about the network failed and nothing about this
     * hiker's position or safety is at stake — a different account is signed in, which is a
     * fact about who the browser is acting as, and structure is the plate for that. The same
     * reasoning as the "Held for another account" block on `/downloads`, which this hike has
     * just joined.
     *
     * "the hiker who recorded it" rather than "you": on the one screen where this sentence can
     * appear, the person reading it is by definition not the person it is about.
     */
    return (
      <>
        <p className="collar text-ink">Kept on this device</p>
        <p className="mt-hair text-caption text-ink">
          Somebody else is signed in, so this hike was not added to an account. It goes to the hiker
          who recorded it when they sign back in.
        </p>
        <Link
          href="/downloads"
          className={`${HEIGHT.touch} mt-xs inline-flex items-center text-caption text-ink underline decoration-bezel underline-offset-4 hover:decoration-ink`}
        >
          See what is waiting
        </Link>
      </>
    );
  }

  /*
   * The tail the server would not take.
   *
   * Ink rather than survey: nothing here is about where the hiker is or whether they are safe,
   * which is the only thing that plate means on this screen. The sentence is the one the drain
   * prints for the same wall (`flushPendingActivities`), so a hiker who meets it in both places
   * meets it in the same words. No apology and no instruction, because there is nothing to do —
   * `append` refuses a finished recording permanently, so those fixes have nowhere left to go.
   */
  return (
    <>
      <p className="collar text-ink">Part of this hike was not sent</p>
      <p className="mt-hair text-caption text-ink">
        This hike was closed before all of it had been sent. What reached the server was kept; the
        last {receipt.lost === 1 ? 'fix' : `${receipt.lost} fixes`} could not be added.
      </p>
      <Link
        href={`/activities/${receipt.activityId}`}
        className={`${HEIGHT.touch} mt-xs inline-flex items-center text-caption text-ink underline decoration-bezel underline-offset-4 hover:decoration-ink`}
      >
        Open the hike
      </Link>
    </>
  );
}

function OffRouteBanner({
  distanceM,
  units,
  trailName,
}: {
  distanceM: number | null;
  units: UnitSystem;
  trailName: string;
}) {
  /*
   * The label is `text-ink`, not `text-survey`, and that is a contrast fix rather than a
   * change of plate.
   *
   * `SchemeColors` in `packages/ui` states the rule this broke: a plate's own wash is a fill,
   * not a text background. Measured in light mode, survey `#B4322A` on this banner's composited
   * background `#DFD7D0` is **4.30:1** at 11px bold — under the 4.5:1 that non-large text
   * needs, and axe agrees (`color-contrast[serious]`, 4.3). On bare canvas the same ink is
   * 4.97:1; it is the wash underneath it that costs the 0.7. Dark mode was never affected.
   *
   * The plate assignment is untouched — the 2px survey border and the survey wash still carry
   * it, which is what those are for. This is the one alert on the screen whose entire job is to
   * interrupt somebody, so it is the last place to be relying on a ratio that does not hold.
   */
  return (
    <div role="alert" className="rounded-hair border-2 border-survey bg-survey/10 px-md py-sm">
      <p className="collar text-ink">Off route</p>
      <p className="mt-hair font-mono text-title text-ink">
        {distanceM != null ? formatDistance(distanceM, units) : '—'} from {trailName}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Starting
// ---------------------------------------------------------------------------

/**
 * What there is to decide before pressing start.
 *
 * The button itself is not here — it lives on the control ledge below the scrollport, so that
 * it is on the glass at every viewport rather than at the end of however much this panel
 * happens to be. What is left is the two things that change what the press does: a recording
 * the server still has open, and what kind of outing this is.
 */
function StartPanel({
  openRecording,
  units,
  activityType,
  onActivityType,
  onAdopt,
}: {
  openRecording: ActivitySummary | null;
  units: UnitSystem;
  activityType: ActivityType;
  onActivityType: (type: ActivityType) => void;
  onAdopt: (open: ActivitySummary) => void;
}) {
  return (
    <div className="flex flex-col gap-md">
      {openRecording ? (
        <div className="rounded-hair border border-contour px-md py-sm">
          <p className="collar text-contour">Already recording</p>
          <p className="mt-hair text-caption text-ink">
            {openRecording.trail?.name ?? openRecording.name ?? 'A hike'}, started{' '}
            {openRecording.startedAt.toLocaleString(undefined, {
              weekday: 'short',
              hour: 'numeric',
              minute: '2-digit',
            })}
            {openRecording.distanceM > 0
              ? `, ${formatDistance(openRecording.distanceM, units)} so far`
              : ''}
            .
          </p>
          <p className="mt-xs text-caption text-ink-muted">
            Picking it up keeps what is already saved and carries on from here. Anything this device
            recorded before the interruption is gone; the rest is on the server.
          </p>
          <button
            type="button"
            onClick={() => onAdopt(openRecording)}
            className={`${BUTTON} ${PRIMARY} mt-sm ${HEIGHT.touch} px-md`}
          >
            Pick it back up
          </button>
        </div>
      ) : null}

      <fieldset className="flex flex-col gap-sm">
        <legend className="collar">What are you doing</legend>
        <div className="flex flex-wrap gap-xs">
          {COMMON_ACTIVITY_TYPES.map((type) => (
            <button
              key={type}
              type="button"
              aria-pressed={activityType === type}
              onClick={() => onActivityType(type)}
              className={`${BUTTON} ${HEIGHT.touch} px-md ${
                activityType === type ? PRIMARY : SECONDARY
              }`}
            >
              {ACTIVITY_TYPE_LABELS[type]}
            </button>
          ))}
        </div>
      </fieldset>

      <p className="text-caption text-ink-muted">
        Your position stays on this device until you finish. Keep this tab open — the screen can
        sleep, but a closed tab stops the recording.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Finishing
// ---------------------------------------------------------------------------

function FinishDialog({
  units,
  defaultName,
  defaultVisibility,
  hasTrail,
  distanceM,
  elapsedS,
  saving,
  error,
  onCancel,
  onConfirm,
}: {
  units: UnitSystem;
  defaultName: string;
  defaultVisibility: Visibility;
  hasTrail: boolean;
  distanceM: number;
  elapsedS: number;
  saving: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (input: {
    name: string;
    notes: string;
    visibility: Visibility;
    logCompletion: boolean;
  }) => Promise<void>;
}) {
  const ref = useRef<HTMLDialogElement | null>(null);
  const nameId = useId();
  const notesId = useId();
  const visibilityId = useId();
  const [name, setName] = useState(defaultName);
  const [notes, setNotes] = useState('');
  const [visibility, setVisibility] = useState<Visibility>(defaultVisibility);
  const [logCompletion, setLogCompletion] = useState(true);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  return (
    <dialog
      ref={ref}
      onCancel={(event) => {
        event.preventDefault();
        if (!saving) onCancel();
      }}
      // Tailwind's preflight zeroes a dialog's margin, which parks every modal in this
      // product against the top-left corner unless it says otherwise.
      className="m-auto w-[min(520px,calc(100vw-2rem))] rounded-hair border border-bezel bg-surface p-0 text-ink backdrop:bg-ink/60"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          // `onConfirm` handles every outcome it knows how to handle and leaves the phase
          // recoverable for the rest. A bare `void` here would surface anything it did not
          // as an unhandled rejection, which is noise rather than information.
          void onConfirm({ name, notes, visibility, logCompletion }).catch(() => undefined);
        }}
        className="flex flex-col gap-md p-lg"
      >
        <div>
          <p className="collar">Finish</p>
          <p className="mt-hair font-mono text-h4 text-ink">
            {formatDistance(distanceM, units)} · {formatClock(elapsedS)}
          </p>
        </div>

        <div>
          <label htmlFor={nameId} className="collar">
            Name
          </label>
          <input
            id={nameId}
            className="field mt-xs"
            value={name}
            maxLength={ACTIVITY_NAME_MAX}
            onChange={(event) => setName(event.target.value)}
          />
        </div>

        <div>
          <label htmlFor={notesId} className="collar">
            How was it
          </label>
          <textarea
            id={notesId}
            className="field mt-xs min-h-[96px]"
            value={notes}
            maxLength={ACTIVITY_NOTES_MAX}
            placeholder="Conditions, who you were with, where you stopped."
            onChange={(event) => setNotes(event.target.value)}
          />
        </div>

        <div>
          <label htmlFor={visibilityId} className="collar">
            Who can see it
          </label>
          <select
            id={visibilityId}
            className="field mt-xs"
            value={visibility}
            onChange={(event) => setVisibility(event.target.value as Visibility)}
          >
            {VISIBILITIES.map((option) => (
              <option key={option} value={option}>
                {VISIBILITY_LABELS[option]}
              </option>
            ))}
          </select>
        </div>

        {hasTrail ? (
          <label className="flex items-center gap-sm text-caption text-ink">
            <input
              type="checkbox"
              checked={logCompletion}
              onChange={(event) => setLogCompletion(event.target.checked)}
              className="size-4 accent-ink"
            />
            Add this trail to the ones I have done
          </label>
        ) : null}

        {error ? (
          <p className="text-caption text-survey" role="alert">
            {error}
          </p>
        ) : null}

        <div className="flex justify-end gap-sm">
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className={`${BUTTON} ${SECONDARY} ${HEIGHT.touch} px-lg`}
          >
            Keep recording
          </button>
          <button
            type="submit"
            disabled={saving}
            className={`${BUTTON} ${PRIMARY} ${HEIGHT.touch} px-lg`}
          >
            {saving ? 'Saving' : 'Save hike'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
