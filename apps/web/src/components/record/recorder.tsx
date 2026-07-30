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
import { BUTTON, DANGER, HEIGHT, PRIMARY, SECONDARY } from '../controls';
import { LifelinePanel } from './lifeline-panel';
import { RecordMap } from './record-map';
import { useRecorder, type RecorderPhase } from './use-recorder';

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

export function Recorder({ units, defaultVisibility, trail, openRecording }: RecorderProps) {
  const trpc = useTRPC();
  const router = useRouter();

  const [activityType, setActivityType] = useState<ActivityType>('hiking');
  const [follow, setFollow] = useState(true);
  const [finishing, setFinishing] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const route = useMemo<readonly LngLat[] | null>(
    () => trail?.geometry.coordinates ?? null,
    [trail],
  );

  const append = useMutation(trpc.activities.append.mutationOptions());
  const appendRef = useRef(append);
  appendRef.current = append;

  const recorder = useRecorder({
    onFlush: (id, fixes) => appendRef.current.mutateAsync({ id, fixes }),
    route,
    routeLengthM: trail?.lengthM ?? null,
  });

  const start = useMutation(
    trpc.activities.start.mutationOptions({
      onSuccess: (activity) => {
        setStartError(null);
        recorder.begin({
          id: activity.id,
          startedAt: activity.startedAt,
          trailId: activity.trail?.id ?? null,
        });
      },
      onError: (err) => setStartError(err.message),
    }),
  );

  const finish = useMutation(trpc.activities.finish.mutationOptions());
  const remove = useMutation(trpc.activities.remove.mutationOptions());

  const running = recorder.phase === 'recording' || recorder.phase === 'locating';
  const live = running || recorder.phase === 'paused';

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
    recorder.stop();
    // Everything still in the buffer goes up before the recording is closed, because
    // `finish` computes the hike from what is stored and nothing else.
    try {
      await recorder.flush();
    } catch {
      // Reported by the recorder already. Closing anyway is the right call: the alternative
      // is a hike that cannot be ended because the last minute will not upload.
    }
    const saved = await finish.mutateAsync({
      id,
      name: input.name.trim() || null,
      notes: input.notes.trim() || null,
      visibility: input.visibility,
      trailId: recorder.trailId,
      logCompletion: input.logCompletion,
    });
    recorder.forget();
    setFinishing(false);
    router.push(`/activities/${saved.id}`);
  }

  async function onDiscard(): Promise<void> {
    const id = recorder.activityId;
    if (id) await remove.mutateAsync({ id });
    recorder.forget();
    setConfirmDiscard(false);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
      <div className="relative h-[46dvh] shrink-0 lg:h-auto lg:flex-1">
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

      <div className="flex w-full flex-col gap-lg border-t border-bezel px-lg py-lg lg:w-[420px] lg:shrink-0 lg:border-l lg:border-t-0 lg:px-xl">
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
            units={units}
          />
        ) : null}

        {!live ? (
          <StartPanel
            trail={trail}
            openRecording={openRecording}
            units={units}
            activityType={activityType}
            onActivityType={setActivityType}
            starting={start.isPending}
            error={startError}
            onStart={() =>
              start.mutate({
                activityType,
                ...(trail ? { trailId: trail.id } : {}),
              })
            }
            onAdopt={(open) => {
              setStartError(null);
              recorder.begin({
                id: open.id,
                startedAt: open.startedAt,
                trailId: open.trail?.id ?? null,
                resumed: true,
              });
            }}
          />
        ) : (
          <div className="flex flex-col gap-sm">
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

            {confirmDiscard ? (
              <div className="flex items-center gap-sm rounded-hair border border-survey px-md py-sm">
                <p className="flex-1 text-caption text-ink">
                  Throw this hike away? It cannot be recovered.
                </p>
                <button
                  type="button"
                  onClick={() => void onDiscard()}
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
            ) : (
              <button
                type="button"
                onClick={() => setConfirmDiscard(true)}
                className="self-start text-caption text-ink-muted underline decoration-bezel underline-offset-4 transition-colors duration-quick hover:text-survey hover:decoration-survey"
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
          error={finish.error?.message ?? null}
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
      {syncError ? (
        <p className="text-caption text-ink-muted">
          {syncError} Still recording — it will go up when the connection comes back.
        </p>
      ) : null}
    </div>
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
  return (
    <div role="alert" className="rounded-hair border-2 border-survey bg-survey/10 px-md py-sm">
      <p className="collar text-survey">Off route</p>
      <p className="mt-hair font-mono text-title text-ink">
        {distanceM != null ? formatDistance(distanceM, units) : '—'} from {trailName}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Starting
// ---------------------------------------------------------------------------

function StartPanel({
  trail,
  openRecording,
  units,
  activityType,
  onActivityType,
  starting,
  error,
  onStart,
  onAdopt,
}: {
  trail: RecorderTrail | null;
  openRecording: ActivitySummary | null;
  units: UnitSystem;
  activityType: ActivityType;
  onActivityType: (type: ActivityType) => void;
  starting: boolean;
  error: string | null;
  onStart: () => void;
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

      <button
        type="button"
        onClick={onStart}
        disabled={starting}
        className={`${BUTTON} ${PRIMARY} ${HEIGHT.field} w-full px-lg text-body-lg`}
      >
        {starting ? 'Starting' : trail ? `Record ${trail.name}` : 'Start recording'}
      </button>

      {error ? (
        <p className="text-caption text-survey" role="alert">
          {error}
        </p>
      ) : null}

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
          void onConfirm({ name, notes, visibility, logCompletion });
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
