'use client';

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ACTIVITY_NAME_MAX,
  ACTIVITY_NOTES_MAX,
  ACTIVITY_TYPE_LABELS,
  ACTIVITY_TYPES,
  VISIBILITIES,
  VISIBILITY_LABELS,
  type ActivityDetail,
} from '@switchback/core';
import { askAgain } from '../../lib/after-write';
import { FIT_MIME, GPX_MIME, decodeBase64, saveBlob } from '../../lib/download';
import { useTRPC } from '../../trpc/react';
import { BUTTON_COLLAR, DANGER, GHOST, HEIGHT, PRIMARY, SECONDARY } from '../controls';

/**
 * What the hiker can do to their own hike.
 *
 * Closed until asked for, like {@link ListSettings}, and for the same reason: the page is
 * for reading a hike, not for administering one. What is always visible is the export,
 * because that one is not an edit — it is the promise that the recording is yours and can
 * leave, and a promise kept behind a disclosure is a promise nobody finds.
 *
 * **Two formats, both named.** GPX goes to another mapping app; FIT goes to a watch, which
 * will not read GPX. A format picker would be one control that produces two files and forces
 * a decision before the press; two buttons let the label answer the question.
 *
 * **Visibility is a sentence before it is a control.** A hike carries a start time and a
 * home trailhead, which together say a good deal about where somebody lives and when they
 * are out. The current state is written in words above the selector rather than left to be
 * inferred from which option happens to be highlighted.
 */

/**
 * The current visibility as a sentence, not as the bare option label.
 *
 * `VISIBILITY_LABELS` is written for a select, where the question — "who can see it" — is
 * already in the label above the control. Standing alone in a row beside two bordered
 * buttons, "Anyone" is a fragment that reads as a third, disabled button. This is the
 * sentence the disclosure above promises.
 */
const VISIBILITY_SENTENCE: Record<ActivityDetail['visibility'], string> = {
  private: 'Only you can see this hike',
  followers: 'People who follow you can see this hike',
  public: 'Anyone can see this hike',
};

export function ActivitySettings({ activity }: { activity: ActivityDetail }) {
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();

  const [open, setOpen] = useState(false);
  const [name, setName] = useState(activity.name ?? '');
  const [notes, setNotes] = useState(activity.notes ?? '');
  const [visibility, setVisibility] = useState(activity.visibility);
  const [activityType, setActivityType] = useState(activity.activityType);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [exporting, setExporting] = useState<'gpx' | 'fit' | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const nameId = useId();
  const notesId = useId();
  const visibilityId = useId();
  const typeId = useId();

  function settle(): void {
    void askAgain(queryClient, trpc.activities.pathFilter());
    router.refresh();
  }

  const update = useMutation(
    trpc.activities.update.mutationOptions({
      onSuccess: () => {
        setOpen(false);
        settle();
      },
    }),
  );

  const remove = useMutation(
    trpc.activities.remove.mutationOptions({
      onSuccess: () => {
        settle();
        router.replace('/profile');
      },
    }),
  );

  /**
   * Fetched on the press rather than with the page.
   *
   * The GPX of a six-hour hike is a megabyte of XML that most readers will never ask for,
   * and it is the same bytes the track above was already drawn from. Loading it eagerly
   * would double the page for a button. FIT is a tenth of that, and still not worth
   * fetching until somebody wants it.
   *
   * Branching inside rather than taking the procedure as an argument: the two return
   * different shapes — text against base64 bytes — so there is nothing to parameterise that
   * would not immediately need narrowing again on the other side.
   */
  async function download(format: 'gpx' | 'fit'): Promise<void> {
    setExporting(format);
    setExportError(null);
    try {
      if (format === 'gpx') {
        const file = await queryClient.fetchQuery(
          trpc.activities.gpx.queryOptions({ id: activity.id }),
        );
        saveBlob(new Blob([file.xml], { type: GPX_MIME }), file.filename);
      } else {
        const file = await queryClient.fetchQuery(
          trpc.activities.fit.queryOptions({ id: activity.id }),
        );
        saveBlob(new Blob([decodeBase64(file.base64)], { type: FIT_MIME }), file.filename);
      }
    } catch (error) {
      setExportError(error instanceof Error ? error.message : 'That file did not build.');
    } finally {
      setExporting(null);
    }
  }

  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-md">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={`${BUTTON_COLLAR} ${SECONDARY} ${HEIGHT.panel} px-md`}
        >
          Edit hike
        </button>
        <button
          type="button"
          onClick={() => void download('gpx')}
          disabled={exporting !== null}
          className={`${BUTTON_COLLAR} ${SECONDARY} ${HEIGHT.panel} px-md`}
        >
          {exporting === 'gpx' ? 'Building…' : 'Download GPX'}
        </button>
        <button
          type="button"
          onClick={() => void download('fit')}
          disabled={exporting !== null}
          className={`${BUTTON_COLLAR} ${SECONDARY} ${HEIGHT.panel} px-md`}
          title="For a Garmin or other GPS watch"
        >
          {exporting === 'fit' ? 'Building…' : 'Download FIT'}
        </button>
        <span className="text-caption text-ink-muted">
          {VISIBILITY_SENTENCE[activity.visibility]}
        </span>
        {exportError ? <span className="text-caption text-survey">{exportError}</span> : null}
      </div>
    );
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        update.mutate({
          id: activity.id,
          ...(name.trim() ? { name: name.trim() } : {}),
          notes: notes.trim() || null,
          visibility,
          activityType,
        });
      }}
      className="rounded-hair border border-bezel bg-surface p-md sm:p-lg"
    >
      <fieldset disabled={update.isPending || remove.isPending} className="border-0 p-0">
        <div>
          <label htmlFor={nameId} className="collar">
            Name
          </label>
          <input
            id={nameId}
            value={name}
            maxLength={ACTIVITY_NAME_MAX}
            onChange={(event) => setName(event.target.value)}
            placeholder="What you would call this afternoon"
            className="mt-sm w-full rounded-hair border border-bezel bg-canvas px-sm py-xs text-body text-ink placeholder:text-ink-muted"
          />
        </div>

        <div className="mt-lg">
          <label htmlFor={notesId} className="collar">
            Notes
          </label>
          <textarea
            id={notesId}
            value={notes}
            maxLength={ACTIVITY_NOTES_MAX}
            rows={4}
            onChange={(event) => setNotes(event.target.value)}
            placeholder="Conditions, who you were with, where you stopped."
            className="mt-sm w-full rounded-hair border border-bezel bg-canvas px-sm py-sm font-text text-body leading-relaxed text-ink placeholder:text-ink-muted"
          />
        </div>

        <div className="mt-lg grid gap-lg sm:grid-cols-2">
          <div>
            <label htmlFor={typeId} className="collar">
              Activity
            </label>
            <select
              id={typeId}
              value={activityType}
              onChange={(event) =>
                setActivityType(event.target.value as ActivityDetail['activityType'])
              }
              className="field mt-sm w-full"
            >
              {ACTIVITY_TYPES.map((type) => (
                <option key={type} value={type}>
                  {ACTIVITY_TYPE_LABELS[type]}
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
              value={visibility}
              onChange={(event) =>
                setVisibility(event.target.value as ActivityDetail['visibility'])
              }
              className="field mt-sm w-full"
            >
              {VISIBILITIES.map((option) => (
                <option key={option} value={option}>
                  {VISIBILITY_LABELS[option]}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="mt-lg flex flex-wrap items-center gap-sm border-t border-bezel pt-md">
          <button type="submit" className={`${BUTTON_COLLAR} ${PRIMARY} ${HEIGHT.panel} px-lg`}>
            {update.isPending ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              setConfirmingDelete(false);
              setName(activity.name ?? '');
              setNotes(activity.notes ?? '');
              setVisibility(activity.visibility);
              setActivityType(activity.activityType);
            }}
            className={`${BUTTON_COLLAR} ${GHOST} ${HEIGHT.panel} px-md`}
          >
            Cancel
          </button>

          <div className="ml-auto flex flex-wrap items-center gap-sm">
            {confirmingDelete ? (
              <>
                <span className="text-caption text-ink-muted">
                  Delete this hike and its track? It cannot be recovered.
                </span>
                <button
                  type="button"
                  onClick={() => remove.mutate({ id: activity.id })}
                  className={`${BUTTON_COLLAR} ${DANGER} ${HEIGHT.panel} px-md`}
                >
                  {remove.isPending ? 'Deleting…' : 'Delete it'}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(false)}
                  className={`${BUTTON_COLLAR} ${GHOST} ${HEIGHT.panel} px-sm`}
                >
                  Keep it
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmingDelete(true)}
                className={`${BUTTON_COLLAR} ${GHOST} ${HEIGHT.panel} px-md`}
              >
                Delete hike
              </button>
            )}
          </div>
        </div>

        {update.isError || remove.isError ? (
          <p className="mt-md text-caption text-survey">
            {update.error?.message ?? remove.error?.message ?? 'That did not save. Try again.'}
          </p>
        ) : null}
      </fieldset>
    </form>
  );
}
