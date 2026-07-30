'use client';

/**
 * "Report" — the control that makes a takedown process possible, and the form behind it.
 *
 * Every other button in this product does something to the reader's own things. This one
 * accuses somebody else's, which is why it is shaped the way it is:
 *
 * **It is the quietest control on the row.** Collar lettering, no border, `ink-muted`, and
 * it sits after everything else. A report button that competes with "Show more" gets pressed
 * by mistake, and a queue full of mis-taps is a queue the operator stops reading — which
 * costs the genuine report its answer. It keeps a full panel-height hit area all the same:
 * quiet is not the same as hard to press, and the person who needs this is often upset.
 *
 * **It works signed out.** The person who finds a photograph of their own front door on a
 * trail page is not going to make an account to tell us about it, and a complaints box that
 * only members can reach is not a complaints box. Signed in, the email field disappears —
 * we already have one.
 *
 * **It never says "thank you for your report".** The confirmation states what happened and
 * what happens next, with a number on it, because what somebody wants after pressing this is
 * not warmth. It is to know that a human will look, and roughly when.
 *
 * The form is exported on its own because `/report` renders it as a page: somebody who
 * cannot reach the content — a rights holder working from a screenshot, a phone that will
 * not load the gallery — must not be dependent on a control that lives next to it.
 */

import { useEffect, useId, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  MODERATION_CONTACT,
  REPORT_DETAIL_MAX,
  REPORT_REASONS,
  REPORT_REASON_HINT,
  REPORT_REASON_LABEL,
} from '@switchback/core';
import type { ReportReason, ReportSubject } from '@switchback/core';
import { useTRPC } from '../../trpc/react';
import { BUTTON, BUTTON_COLLAR, GHOST, HEIGHT, OUTLINE, SECONDARY } from '../controls';

export interface ReportFormProps {
  subject: ReportSubject;
  subjectId: string;
  /** True when we already know how to reach them, which removes the email field. */
  isViewerKnown: boolean;
  /** Rendered under the buttons; the dialog passes a Cancel, the page passes nothing. */
  onCancel?: () => void;
  /** Called when the reader dismisses the confirmation. Absent leaves it on screen. */
  onDone?: () => void;
}

/**
 * The fields, the submit, and the two things that can come back.
 *
 * The reason list is radios rather than a `<select>`. It is nine options a person is
 * choosing between while upset, and a dropdown hides eight of them behind a tap — this is
 * one of the few places in the product where the whole vocabulary being visible at once is
 * worth the vertical space.
 */
export function ReportForm({
  subject,
  subjectId,
  isViewerKnown,
  onCancel,
  onDone,
}: ReportFormProps) {
  const trpc = useTRPC();
  const fieldId = useId();

  const [reason, setReason] = useState<ReportReason>('spam');
  const [detail, setDetail] = useState('');
  const [email, setEmail] = useState('');

  const file = useMutation(trpc.moderation.report.mutationOptions());
  const hint = REPORT_REASON_HINT[reason];
  const confirmationRef = useRef<HTMLParagraphElement>(null);

  /*
   * Sending the report destroys the control that had focus.
   *
   * On success this component returns a different subtree, so the submit button unmounts and
   * focus falls to `<body>` — or, inside the sheet, to the `<dialog>` itself. A screen reader
   * announces nothing, and in the dialog the reader is left in a panel they were never told
   * had changed, hunting blind for Close. Moving focus to the confirmation reads it out and
   * puts the ring somewhere the keyboard can carry on from; `role="status"` below covers the
   * page version, where focus may already be elsewhere.
   */
  useEffect(() => {
    if (file.isSuccess) confirmationRef.current?.focus();
  }, [file.isSuccess]);

  if (file.isSuccess) {
    /*
     * Whether there is anywhere to send the answer. Two lines above, the email field says
     * "we use it to reply about this report"; `/report` says an anonymous report is still a
     * report, "we just cannot reply to it". Promising every reporter an answer in five days
     * — including the one we have no address for — makes the one screen they see after
     * filing contradict the rest of the surface.
     */
    const canReply = isViewerKnown || Boolean(file.variables?.contactEmail);

    return (
      <div>
        <p
          ref={confirmationRef}
          tabIndex={-1}
          role="status"
          className="max-w-measure text-body leading-relaxed focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ink"
        >
          {canReply
            ? `We have it. A moderator reads every report and answers within ${MODERATION_CONTACT.responseDays} days. If it needs taking down sooner, it will be.`
            : `We have it. A moderator reads every report within ${MODERATION_CONTACT.responseDays} days. You did not leave an address, so there is nowhere to send the answer — if it comes down, you will see that on the page. If it needs taking down sooner, it will be.`}
        </p>
        <p className="mt-sm max-w-measure text-caption text-ink-muted">
          Nothing on the page changes yet. Removing something is a decision somebody makes, not one
          this button makes for them.
        </p>
        {onDone ? (
          <div className="mt-lg flex justify-end">
            <button
              type="button"
              onClick={onDone}
              className={`${BUTTON_COLLAR} ${SECONDARY} ${HEIGHT.touch} px-md`}
            >
              Close
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        file.mutate({
          subject,
          subjectId,
          reason,
          detail: detail.trim() || null,
          // Never sent for a signed-in reporter: we have their address already, and asking
          // for a second one is a way to end up replying to the wrong person.
          contactEmail: isViewerKnown || !email.trim() ? null : email.trim(),
        });
      }}
    >
      <p className="max-w-measure text-caption text-ink-muted">
        Tell us what is wrong with it. This goes to a person, not a filter.
      </p>

      <fieldset className="mt-lg border-0 p-0">
        <legend className="collar">What is wrong</legend>
        <div className="mt-sm flex flex-col gap-hair border-t border-bezel">
          {REPORT_REASONS.map((option) => (
            <label
              key={option}
              className="flex cursor-pointer items-baseline gap-sm border-b border-bezel py-sm text-body"
            >
              <input
                type="radio"
                name={`${fieldId}-reason`}
                value={option}
                checked={reason === option}
                onChange={() => setReason(option)}
              />
              <span>{REPORT_REASON_LABEL[option]}</span>
            </label>
          ))}
        </div>
      </fieldset>

      {hint !== null ? (
        <p className="mt-sm max-w-measure text-caption text-ink-muted">{hint}</p>
      ) : null}

      <label htmlFor={`${fieldId}-detail`} className="collar mt-lg block">
        Anything else
      </label>
      <textarea
        id={`${fieldId}-detail`}
        value={detail}
        maxLength={REPORT_DETAIL_MAX}
        rows={3}
        onChange={(event) => setDetail(event.target.value)}
        className="field mt-xs w-full"
      />

      {isViewerKnown ? null : (
        <>
          <label htmlFor={`${fieldId}-email`} className="collar mt-lg block">
            Your email, if you want an answer
          </label>
          <input
            id={`${fieldId}-email`}
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="field mt-xs w-full"
          />
          <p className="mt-xs max-w-measure text-caption text-ink-muted">
            Optional. We use it to reply about this report and for nothing else.
          </p>
        </>
      )}

      {file.isError ? (
        /*
         * Survey plate. This is the one line on the sheet that is about the reader's own
         * position in the process rather than about the content, and it is the plate this
         * product uses for exactly that. It says what happened and gives the way round it.
         *
         * **Branched on the code, because "try again" is wrong for half of them.** The most
         * likely failure on `/report` is a stale deep link — an operator forwarded a URL, a
         * rights holder is working from a screenshot, and the review has since been deleted
         * — which `locateSubject` answers with NOT_FOUND. Telling that reader the report did
         * not send and to try again advises an action that is guaranteed to fail forever,
         * about a thing that is already gone. `role="alert"` because the paragraph appears
         * after a press, next to a button that has quietly gone from "Sending…" back to
         * "Send report".
         */
        <p
          role="alert"
          className="mt-lg max-w-measure rounded-hair border border-survey px-md py-sm text-caption text-survey"
        >
          {file.error.data?.code === 'NOT_FOUND'
            ? `That is not on the site any more — it was deleted or already removed, so there is nothing left to report. Write to ${MODERATION_CONTACT.email} if there is more to it than that.`
            : file.error.data?.code === 'TOO_MANY_REQUESTS'
              ? file.error.message
              : `That report did not send. Try again, or write to ${MODERATION_CONTACT.email} and say which page it was on.`}
        </p>
      ) : null}

      <div className="mt-lg flex flex-wrap justify-end gap-sm">
        {onCancel ? (
          <button
            type="button"
            onClick={onCancel}
            className={`${BUTTON} ${GHOST} ${HEIGHT.touch} px-md`}
          >
            Cancel
          </button>
        ) : null}
        <button
          type="submit"
          disabled={file.isPending}
          className={`${BUTTON} ${OUTLINE} ${HEIGHT.touch} px-md`}
        >
          {file.isPending ? 'Sending…' : 'Send report'}
        </button>
      </div>
    </form>
  );
}

export interface ReportControlProps extends Omit<ReportFormProps, 'onCancel' | 'onDone'> {
  /** What the control is about, for the label a screen reader reads. */
  what: string;
}

/** The inline button, and the sheet it opens. */
export function ReportControl({ subject, subjectId, isViewerKnown, what }: ReportControlProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const node = dialogRef.current;
    if (!node) return;
    if (open && !node.open) node.showModal();
    if (!open && node.open) node.close();
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`${BUTTON_COLLAR} ${GHOST} ${HEIGHT.panel} px-sm text-ink-muted hover:text-ink`}
      >
        <span aria-hidden>Report</span>
        <span className="sr-only">Report {what}</span>
      </button>

      {/*
       * `m-auto` is load-bearing. A modal `<dialog>` is centred by the UA's own
       * `inset: 0; margin: auto`, and Tailwind's preflight resets `dialog { margin: 0 }`,
       * which leaves it pinned to the top-left corner against the backdrop.
       *
       * Opaque canvas and a hairline, no shadow: a trail page can have the map behind it.
       */}
      <dialog
        ref={dialogRef}
        onClose={() => setOpen(false)}
        aria-labelledby={titleId}
        className="m-auto w-full max-w-[min(30rem,92vw)] rounded-hair border border-bezel bg-canvas p-0 text-ink backdrop:bg-ink/85"
      >
        <div className="p-lg">
          <h2 id={titleId} className="collar mb-md">
            Report {what}
          </h2>
          {/*
           * Keyed on `open` so the form is a fresh mount each time the sheet is opened. A
           * report that has been sent must not be re-sendable by reopening the sheet, and a
           * half-written one is not worth keeping across a dismissal.
           */}
          <ReportForm
            key={open ? 'open' : 'closed'}
            subject={subject}
            subjectId={subjectId}
            isViewerKnown={isViewerKnown}
            onCancel={() => setOpen(false)}
            onDone={() => setOpen(false)}
          />
        </div>
      </dialog>
    </>
  );
}

/**
 * The other half of the lever, where the operator stands.
 *
 * Deliberately the same size and quietness as the report control beside it. A moderator's
 * remove is a `DANGER`-plated button everywhere else in this product; here it is not,
 * because this one sits inline on somebody else's writing on a public page, and survey red
 * in a stranger's row reads as an accusation against them rather than as a tool. It is also
 * not destructive: hiding is reversible, which is what the second label says.
 *
 * **Rendered only for operators, and that is not what enforces it.** `moderatorProcedure` in
 * `packages/api/src/trpc.ts` is; this component simply declines to draw a control that would
 * always fail. Anybody who forges `role` on their own client gets a button and a FORBIDDEN.
 */
export function ModerateControl({
  subject,
  subjectId,
  hidden,
  onDone,
}: {
  subject: ReportSubject;
  subjectId: string;
  hidden: boolean;
  onDone: () => void;
}) {
  const trpc = useTRPC();
  const hide = useMutation(trpc.moderation.hide.mutationOptions({ onSuccess: onDone }));
  const unhide = useMutation(trpc.moderation.unhide.mutationOptions({ onSuccess: onDone }));
  const busy = hide.isPending || unhide.isPending;

  return (
    <button
      type="button"
      disabled={busy}
      onClick={() =>
        hidden
          ? unhide.mutate({ subject, subjectId, note: null })
          : hide.mutate({ subject, subjectId, note: null })
      }
      className={`${BUTTON_COLLAR} ${SECONDARY} ${HEIGHT.panel} px-sm`}
    >
      {busy ? 'Working…' : hidden ? 'Put back' : 'Take down'}
    </button>
  );
}
