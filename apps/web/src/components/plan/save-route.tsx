'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { ActivityType, RoutePlan, UnitSystem, Visibility } from '@switchback/core';
import {
  ACTIVITY_TYPES,
  ACTIVITY_TYPE_LABELS,
  PLANNED_ROUTE_VISIBILITIES,
  ROUTE_DESCRIPTION_MAX,
  ROUTE_NAME_MAX,
  VISIBILITY_LABELS,
  formatDistance,
  formatElevation,
} from '@switchback/core';
import { BUTTON, HEIGHT, PRIMARY, SECONDARY } from '../controls';

/**
 * Naming a route, which is the moment it stops being a sketch.
 *
 * The same modal shape the recorder uses to close a hike, and the same reason for the
 * repetition being deliberate rather than lazy: both are the one step where a thing the user
 * made gets a name and an audience, and a product that asks those two questions in two
 * different layouts is telling the reader they are two different questions.
 *
 * The stats above the form are not decoration. "Save route" on its own gives no chance to
 * notice that the line currently measures 41 km when the hike in mind was nine — and the
 * distance is the one figure that catches a stray click on the far side of the valley.
 */

export interface SaveRouteProps {
  plan: RoutePlan;
  units: UnitSystem;
  saving: boolean;
  error: string | null;
  /** True when this is a route that already exists, which changes every verb on screen. */
  editing: boolean;
  /** What the fields open with — the saved values when editing, sensible defaults when not. */
  initial: {
    name: string;
    description: string;
    activityType: ActivityType;
    visibility: Visibility;
  };
  onCancel: () => void;
  onConfirm: (input: {
    name: string;
    description: string;
    activityType: ActivityType;
    visibility: Visibility;
  }) => void;
}

export function SaveRoute({
  plan,
  units,
  saving,
  error,
  editing,
  initial,
  onCancel,
  onConfirm,
}: SaveRouteProps) {
  const ref = useRef<HTMLDialogElement | null>(null);
  const nameId = useId();
  const descriptionId = useId();
  const activityId = useId();
  const visibilityId = useId();

  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [activityType, setActivityType] = useState<ActivityType>(initial.activityType);
  const [visibility, setVisibility] = useState<Visibility>(initial.visibility);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const unroutable = plan.legs.filter((leg) => !leg.snapped && leg.reason !== 'freehand').length;

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
          onConfirm({ name: name.trim(), description, activityType, visibility });
        }}
        className="flex flex-col gap-md p-lg"
      >
        <div>
          <p className="collar">{editing ? 'Save changes' : 'Save this route'}</p>
          <p className="mt-hair font-mono text-h4 text-ink">
            {formatDistance(plan.stats.lengthM, units)} · {formatElevation(plan.stats.gainM, units)}{' '}
            up
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
            required
            autoFocus
            maxLength={ROUTE_NAME_MAX}
            placeholder="Ridge loop from the north car park"
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </div>

        <div>
          <label htmlFor={descriptionId} className="collar">
            Notes
          </label>
          <textarea
            id={descriptionId}
            className="field mt-xs min-h-[96px]"
            value={description}
            maxLength={ROUTE_DESCRIPTION_MAX}
            placeholder="Where to park, which junction to watch for, when the creek is crossable."
            onChange={(event) => {
              setDescription(event.target.value);
            }}
          />
        </div>

        <div className="grid grid-cols-2 gap-md">
          <div>
            <label htmlFor={activityId} className="collar">
              Getting there by
            </label>
            <select
              id={activityId}
              className="field mt-xs"
              value={activityType}
              onChange={(event) => {
                setActivityType(event.target.value as ActivityType);
              }}
            >
              {ACTIVITY_TYPES.map((option) => (
                <option key={option} value={option}>
                  {ACTIVITY_TYPE_LABELS[option]}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor={visibilityId} className="collar">
              Who can see it
            </label>
            <select
              id={visibilityId}
              className="field mt-xs"
              value={visibility}
              onChange={(event) => {
                setVisibility(event.target.value as Visibility);
              }}
            >
              {PLANNED_ROUTE_VISIBILITIES.map((option) => (
                <option key={option} value={option}>
                  {VISIBILITY_LABELS[option]}
                </option>
              ))}
            </select>
          </div>
        </div>

        {unroutable > 0 ? (
          <p className="text-caption text-survey">
            {unroutable === 1 ? 'One stretch has' : `${String(unroutable)} stretches have`} no path
            under {unroutable === 1 ? 'it' : 'them'}. Saved as drawn — check the ground before you
            rely on {unroutable === 1 ? 'it' : 'them'}.
          </p>
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
            Keep editing
          </button>
          <button
            type="submit"
            disabled={saving || name.trim().length === 0}
            className={`${BUTTON} ${PRIMARY} ${HEIGHT.touch} px-lg`}
          >
            {saving ? 'Saving' : editing ? 'Save changes' : 'Save route'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
