'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  LIFELINE_CONTACT_NAME_MAX,
  LIFELINE_MESSAGE_MAX,
  LIFELINE_PING_INTERVAL_S,
  LIFELINE_PRESET_MINUTES,
  formatSpan,
  isStalePing,
  type LngLat,
} from '@switchback/core';
import { askAgain } from '../../lib/after-write';
import { useTRPC } from '../../trpc/react';
import { BUTTON, DANGER, HEIGHT, PRIMARY, SECONDARY, toggle } from '../controls';

/**
 * Lifeline, from the hiker's side.
 *
 * The follow page is written for somebody worried in a kitchen. This is written for the
 * person on the hill, and it has a different problem: everything here happens in the two
 * minutes before setting off, in a car park, one-handed, and anything that takes longer than
 * that does not get used — which for a safety feature means it does not exist.
 *
 * So the whole setup is three taps. A name, a return time from a row of presets, go. The
 * message box is there and is genuinely useful to a searcher, and it is also the field people
 * skip, so nothing depends on it. No date picker: a duration has no time zone, no AM/PM, and
 * no way to be a day out by accident.
 *
 * **It is quiet until it is running.** Closed, it is one line of prose and one button, because
 * the instrument above it is what somebody opened this screen for. Open and live, it is the
 * link and the clock and nothing else — the two things a hiker checks.
 *
 * **The panel keeps the position current itself.** A ping is not a side effect of recording:
 * somebody who just wants their partner to see where they are should not have to record a
 * hike to get it, so the loop here runs on its own cadence and takes the recorder's fix when
 * there is a fresh one going spare. What it will not do is send an old fix — see `freshFix`.
 */

export interface LifelinePanelProps {
  /** The recording this Lifeline should ride on, so finishing the hike ends it too. */
  activityId: string | null;
  trailId: string | null;
  trailName: string | null;
  /** The recorder's latest position, when one is being recorded. */
  position: LngLat | null;
  /** Elevation of that position, where the device reports one. */
  eleM: number | null;
}

/**
 * What "push it back" offers, in minutes from now.
 *
 * Shorter than the starting presets on purpose. Somebody extending is already out and already
 * behind, and the honest answer to "how much longer?" from halfway up is usually under an
 * hour. Offering another eight hours would invite a hiker to silence the thing rather than
 * answer it.
 */
const EXTEND_MINUTES = [30, 60, 120, 240] as const;

export function LifelinePanel({
  activityId,
  trailId,
  trailName,
  position,
  eleM,
}: LifelinePanelProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const active = useQuery(trpc.lifeline.active.queryOptions());
  const session = active.data ?? null;

  const [open, setOpen] = useState(false);
  const [contactName, setContactName] = useState('');
  const [message, setMessage] = useState('');
  const [minutes, setMinutes] = useState<number>(LIFELINE_PRESET_MINUTES[1] ?? 240);
  const [confirmCancel, setConfirmCancel] = useState(false);

  const nameId = useId();
  const messageId = useId();

  const refresh = useCallback(async (): Promise<void> => {
    await askAgain(queryClient, trpc.lifeline.pathFilter());
  }, [queryClient, trpc]);

  const create = useMutation(
    trpc.lifeline.create.mutationOptions({
      onSuccess: () => {
        setOpen(false);
        setMessage('');
        void refresh();
      },
    }),
  );
  const extend = useMutation(
    trpc.lifeline.extend.mutationOptions({ onSuccess: () => void refresh() }),
  );
  const end = useMutation(
    trpc.lifeline.end.mutationOptions({
      onSuccess: () => {
        setConfirmCancel(false);
        void refresh();
      },
    }),
  );

  const { lastPingAt, pingError } = usePings(session?.id ?? null, position, eleM);

  // Coarse on purpose: everything shown here is rounded to the minute, so a per-second tick
  // would redraw the same characters sixty times over and keep a phone's screen busy for it.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!session) return;
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, [session]);

  const heard = lastPingAt ?? session?.lastPingAt ?? null;
  const link = useShareLink(session?.token ?? null);

  if (active.isPending) return null;

  // ---------------------------------------------------------------------------
  // Running
  // ---------------------------------------------------------------------------

  if (session) {
    const late = session.status === 'overdue';
    const leftS = Math.round((session.expectedReturnAt.getTime() - now.getTime()) / 1000);
    const stale = isStalePing(heard, now);

    return (
      <section
        className={`rounded-hair border ${late ? 'border-survey' : 'border-bezel'} bg-surface`}
      >
        <header className="flex items-baseline justify-between gap-sm border-b border-bezel px-md py-sm">
          <h2 className="collar">Lifeline</h2>
          <p className={`text-caption ${late ? 'text-survey' : 'text-ink-muted'}`}>
            {late ? `${formatSpan(-leftS)} overdue` : `${formatSpan(leftS)} left`}
          </p>
        </header>

        <div className="flex flex-col gap-md px-md py-md">
          <p className="text-caption text-ink">
            {session.contactName ? `${session.contactName} can` : 'Anyone with the link can'} see
            where you are until{' '}
            <span className={`font-mono ${late ? 'text-survey' : 'text-ink'}`}>
              {clock(session.expectedReturnAt)}
            </span>
            .
          </p>

          <div className="flex gap-xs">
            <input
              readOnly
              value={link.url}
              onFocus={(event) => event.currentTarget.select()}
              aria-label="Link to send"
              className="min-w-0 flex-1 rounded-hair border border-bezel bg-canvas px-sm py-xs font-mono text-micro text-ink-muted focus-visible:text-ink"
            />
            <button
              type="button"
              onClick={() => void link.copy()}
              className={`${BUTTON} ${SECONDARY} ${HEIGHT.touch} shrink-0 px-md`}
            >
              {link.copied ? 'Copied' : 'Copy'}
            </button>
            {link.canShare ? (
              <button
                type="button"
                onClick={() => void link.share(trailName)}
                className={`${BUTTON} ${SECONDARY} ${HEIGHT.touch} shrink-0 px-md`}
              >
                Send
              </button>
            ) : null}
          </div>

          {/*
           * The one figure that says whether the link is doing anything. A Lifeline whose
           * position stopped an hour ago still looks alive from the hiker's side unless the
           * screen says otherwise, and the hiker is the only one who can fix it.
           */}
          <p className={`text-micro ${stale ? 'text-survey' : 'text-ink-muted'}`}>
            {heard
              ? `Position sent ${formatSpan(Math.max(0, Math.round((now.getTime() - heard.getTime()) / 1000)))} ago`
              : 'No position sent yet'}
            {stale && heard ? ' — they are seeing an old one' : null}
          </p>
          {/*
           * On its own line rather than tacked onto the one above, which used to read
           * "Position sent 1 min ago · No position to send" — two true clauses that
           * contradict each other when set as one sentence. Separated, they are what they
           * are: when the last one landed, and what is happening now.
           */}
          {pingError ? <p className="text-micro text-ink-muted">{pingError}</p> : null}

          <div>
            <p className="collar">Push it back to</p>
            <div className="mt-xs flex flex-wrap gap-xs">
              {EXTEND_MINUTES.map((m) => (
                <button
                  key={m}
                  type="button"
                  disabled={extend.isPending}
                  onClick={() => extend.mutate({ id: session.id, minutes: m })}
                  className={`${BUTTON} ${SECONDARY} ${HEIGHT.touch} px-sm`}
                >
                  {clock(new Date(now.getTime() + m * 60_000))}
                </button>
              ))}
            </div>
          </div>

          <div className="flex gap-sm">
            <button
              type="button"
              disabled={end.isPending}
              onClick={() => end.mutate({ id: session.id, outcome: 'completed' })}
              className={`${BUTTON} ${PRIMARY} ${HEIGHT.touch} flex-1 px-lg`}
            >
              {end.isPending ? 'Ending' : "I'm back"}
            </button>
          </div>

          {confirmCancel ? (
            <div className="flex items-center gap-sm rounded-hair border border-survey px-sm py-xs">
              <p className="flex-1 text-micro text-ink">
                Call it off? The link stops showing where you are.
              </p>
              <button
                type="button"
                disabled={end.isPending}
                onClick={() => end.mutate({ id: session.id, outcome: 'cancelled' })}
                className={`${BUTTON} ${DANGER} ${HEIGHT.touch} px-sm`}
              >
                Call off
              </button>
              <button
                type="button"
                onClick={() => setConfirmCancel(false)}
                className={`${BUTTON} ${SECONDARY} ${HEIGHT.touch} px-sm`}
              >
                Keep
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmCancel(true)}
              className="self-start text-micro text-ink-muted underline decoration-bezel underline-offset-4 transition-colors duration-quick hover:text-survey hover:decoration-survey"
            >
              Call it off instead
            </button>
          )}

          {end.error || extend.error ? (
            <p className="text-micro text-survey" role="alert">
              {(end.error ?? extend.error)?.message}
            </p>
          ) : null}
        </div>
      </section>
    );
  }

  // ---------------------------------------------------------------------------
  // Not running
  // ---------------------------------------------------------------------------

  if (!open) {
    return (
      <section className="rounded-hair border border-bezel px-md py-md">
        <h2 className="collar">Lifeline</h2>
        <p className="mt-xs text-caption text-ink-muted">
          Send somebody a link that shows where you are and when you said you would be back.
        </p>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={`${BUTTON} ${SECONDARY} mt-sm ${HEIGHT.touch} px-md`}
        >
          Tell somebody
        </button>
      </section>
    );
  }

  const returnAt = new Date(Date.now() + minutes * 60_000);

  return (
    <section className="rounded-hair border border-bezel bg-surface">
      <header className="flex items-baseline justify-between gap-sm border-b border-bezel px-md py-sm">
        <h2 className="collar">Lifeline</h2>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-micro text-ink-muted underline decoration-bezel underline-offset-4 hover:text-ink"
        >
          Not now
        </button>
      </header>

      <div className="flex flex-col gap-md px-md py-md">
        <div>
          <label htmlFor={nameId} className="collar">
            Who is expecting you
          </label>
          <input
            id={nameId}
            value={contactName}
            onChange={(event) => setContactName(event.target.value)}
            maxLength={LIFELINE_CONTACT_NAME_MAX}
            placeholder="Mum, Dave, the shop"
            autoComplete="off"
            className="mt-xs w-full rounded-hair border border-bezel bg-canvas px-sm py-xs text-caption text-ink placeholder:text-ink-muted"
          />
        </div>

        <div>
          <p className="collar">Back by</p>
          <div className="mt-xs flex flex-wrap gap-xs">
            {LIFELINE_PRESET_MINUTES.map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={minutes === m}
                onClick={() => setMinutes(m)}
                className={`${BUTTON} ${toggle(minutes === m)} ${HEIGHT.touch} px-sm`}
              >
                {clock(new Date(Date.now() + m * 60_000))}
              </button>
            ))}
          </div>
          <p className="mt-xs text-micro text-ink-muted">
            {formatSpan(minutes * 60)} from now — {stamp(returnAt)}. You can push it back from the
            hill.
          </p>
        </div>

        <div>
          <label htmlFor={messageId} className="collar">
            Anything they should know
          </label>
          <textarea
            id={messageId}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            maxLength={LIFELINE_MESSAGE_MAX}
            rows={2}
            placeholder="Parked at the top car park, going up the north ridge, back the same way."
            className="mt-xs w-full rounded-hair border border-bezel bg-canvas px-sm py-xs font-text text-caption text-ink placeholder:text-ink-muted"
          />
        </div>

        <button
          type="button"
          disabled={create.isPending}
          onClick={() =>
            create.mutate({
              minutes,
              ...(activityId ? { activityId } : {}),
              ...(trailId ? { trailId } : {}),
              ...(contactName.trim() ? { contactName: contactName.trim() } : {}),
              ...(message.trim() ? { message: message.trim() } : {}),
            })
          }
          className={`${BUTTON} ${PRIMARY} ${HEIGHT.touch} px-lg`}
        >
          {create.isPending ? 'Starting' : 'Start Lifeline'}
        </button>

        {create.error ? (
          <p className="text-micro text-survey" role="alert">
            {create.error.message}
          </p>
        ) : null}

        {/*
         * Said here rather than discovered later. Somebody handing out a link that shows their
         * position deserves to know exactly what it does and exactly when it stops — and the
         * sentence about nobody being alerted is the one this product must never soften,
         * because there is no mail or SMS transport behind it to make it untrue.
         */}
        <p className="text-micro leading-relaxed text-ink-muted">
          The link shows your last position and your return time, and stops showing anything the
          moment you finish this hike or tap &ldquo;I&rsquo;m back&rdquo;. Nobody is alerted if you
          are late — the person you send it to is.
        </p>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Keeping the position current
// ---------------------------------------------------------------------------

interface Fix {
  at: number;
  lng: number;
  lat: number;
  eleM: number | null;
}

/**
 * The ping loop.
 *
 * Runs while a Lifeline is live and stops the instant it is not, which is what makes the
 * promise on the follow page mechanical rather than a matter of trust: the position is not
 * withheld after a hike ends, it stops being sent.
 *
 * One immediate ping on start, then every `LIFELINE_PING_INTERVAL_S`. The first one matters
 * more than the cadence — a hiker who sets off, hands over the link and loses signal for
 * forty minutes should still have given their contact a dot at the car park.
 */
function usePings(
  sessionId: string | null,
  position: LngLat | null,
  eleM: number | null,
): { lastPingAt: Date | null; pingError: string | null } {
  const trpc = useTRPC();
  const ping = useMutation(trpc.lifeline.ping.mutationOptions());
  const pingRef = useRef(ping);
  pingRef.current = ping;

  // The recorder's latest fix, stamped, in a ref so a new fix every second does not tear the
  // interval down and build it again.
  const recorded = useRef<Fix | null>(null);
  useEffect(() => {
    if (!position) return;
    recorded.current = { at: Date.now(), lng: position[0], lat: position[1], eleM };
  }, [position, eleM]);

  const [lastPingAt, setLastPingAt] = useState<Date | null>(null);
  const [pingError, setPingError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) {
      setLastPingAt(null);
      setPingError(null);
      return;
    }
    let cancelled = false;

    const send = async (): Promise<void> => {
      const fix = await freshFix(recorded.current);
      if (!fix) {
        if (!cancelled) setPingError('Waiting for a GPS fix.');
        return;
      }
      try {
        const { at } = await pingRef.current.mutateAsync({
          id: sessionId,
          lng: fix.lng,
          lat: fix.lat,
          eleM: fix.eleM,
          batteryPct: await batteryPct(),
        });
        if (cancelled) return;
        setLastPingAt(at);
        setPingError(null);
      } catch (error) {
        // Never surfaced as an alarm. A failed ping is a phone in a valley, which is the
        // normal state of affairs on a hike, and the follow page already says how old the
        // last position is — which is the honest version of the same fact.
        if (!cancelled) setPingError(error instanceof Error ? error.message : 'Could not send');
      }
    };

    void send();
    const timer = window.setInterval(() => void send(), LIFELINE_PING_INTERVAL_S * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [sessionId]);

  return { lastPingAt, pingError };
}

/**
 * A position worth sending, or nothing.
 *
 * The rule that makes this feature honest: **never ping with an old fix.** `lastPingAt` is
 * stamped server-side at the moment the ping lands, so sending a forty-minute-old position
 * would put "last heard: just now" under a dot on the wrong side of a mountain. Better by far
 * to send nothing and let the follow page report the position going stale, which is true.
 *
 * The recorder's fix is preferred when there is a fresh one, because it is already paid for —
 * the watch is running, the radio is warm, and asking the browser for a second fix would wake
 * the GPS a second time for the same answer.
 */
async function freshFix(recorded: Fix | null): Promise<Fix | null> {
  if (recorded && Date.now() - recorded.at < LIFELINE_PING_INTERVAL_S * 1000) return recorded;
  return currentPosition();
}

function currentPosition(): Promise<Fix | null> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return Promise.resolve(null);
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const alt = pos.coords.altitude;
        resolve({
          at: Date.now(),
          lng: pos.coords.longitude,
          lat: pos.coords.latitude,
          // Dropped rather than clamped when it is outside anywhere a person can stand. A
          // barometric altimeter indoors can report a kilometre underground, and one absurd
          // number must not cost the whole ping — the position is the part that matters.
          eleM: alt != null && Number.isFinite(alt) && alt > -500 && alt < 9_500 ? alt : null,
        });
      },
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 },
    );
  });
}

interface BatteryLike {
  level: number;
}

/**
 * Battery percentage, where the browser will say.
 *
 * A follower's first question about a phone that has gone quiet is whether it died, and this
 * is the difference between an answer and an hour of imagining. Not available on Safari or
 * Firefox, which is why every consumer of it treats null as ordinary.
 */
async function batteryPct(): Promise<number | null> {
  if (typeof navigator === 'undefined') return null;
  const getBattery = (navigator as Navigator & { getBattery?: () => Promise<BatteryLike> })
    .getBattery;
  if (typeof getBattery !== 'function') return null;
  try {
    const battery = await getBattery.call(navigator);
    const level = battery?.level;
    if (typeof level !== 'number' || !Number.isFinite(level)) return null;
    return Math.max(0, Math.min(100, Math.round(level * 100)));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The link
// ---------------------------------------------------------------------------

interface ShareLink {
  url: string;
  copied: boolean;
  canShare: boolean;
  copy: () => Promise<void>;
  share: (trailName: string | null) => Promise<void>;
}

function useShareLink(token: string | null): ShareLink {
  const [origin, setOrigin] = useState('');
  const [copied, setCopied] = useState(false);
  const [canShare, setCanShare] = useState(false);

  useEffect(() => {
    setOrigin(window.location.origin);
    setCanShare(typeof navigator.share === 'function');
  }, []);

  const url = useMemo(() => (token ? `${origin}/lifeline/${token}` : ''), [origin, token]);

  const copy = useCallback(async (): Promise<void> => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      // Clipboard access can be refused outright, and on a phone that is usually a permission
      // rather than a fault. The field is readable and selectable, so there is still a way.
      setCopied(false);
    }
  }, [url]);

  const share = useCallback(
    async (trailName: string | null): Promise<void> => {
      if (!url) return;
      try {
        await navigator.share({
          title: 'Where I am',
          text: trailName
            ? `I'm hiking ${trailName}. This shows where I am and when I'm due back.`
            : "I'm out hiking. This shows where I am and when I'm due back.",
          url,
        });
      } catch {
        // Dismissing the share sheet throws. Not an error, and not worth telling anybody.
      }
    },
    [url],
  );

  return { url, copied, canShare, copy, share };
}

// ---------------------------------------------------------------------------
// Clocks
// ---------------------------------------------------------------------------

function clock(at: Date): string {
  return at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

/** Day and time, for the one place a hike can be set to end tomorrow. */
function stamp(at: Date): string {
  return at.toLocaleString('en-GB', {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}
