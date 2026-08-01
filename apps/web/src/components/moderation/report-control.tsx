'use client';

/**
 * "Report" — the control that makes a takedown process possible, and the form behind it.
 *
 * The quietest control on its row, because a queue full of mis-taps is a queue the operator
 * stops reading; it keeps a full panel-height hit area all the same. It works signed out — a
 * complaints box only members can reach is not a complaints box. The form is exported on its
 * own because `/report` renders it as a page, for somebody who cannot reach the content.
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
 * The fields, the submit, and the two things that can come back. Radios rather than a
 * `<select>`: nine options a person is choosing between while upset, and a dropdown hides
 * eight of them behind a tap.
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
   * Sending the report unmounts the submit button, dropping focus to `<body>` — or, inside
   * the sheet, to the `<dialog>` itself, where the reader hunts blind for Close. Moving focus
   * to the confirmation reads it out; `role="status"` covers the page version.
   */
  useEffect(() => {
    if (file.isSuccess) confirmationRef.current?.focus();
  }, [file.isSuccess]);

  if (file.isSuccess) {
    /*
     * Whether there is anywhere to send the answer. Promising every reporter a reply — including
     * the one we have no address for — contradicts what the email field says two lines above.
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
          // Never sent for a signed-in reporter: asking for a second address is a way to end
          // up replying to the wrong person.
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
         * Branched on the code, because "try again" is wrong for half of them: a stale deep
         * link answers NOT_FOUND, and telling that reader to retry advises an action that is
         * guaranteed to fail forever. `role="alert"` because it appears after a press.
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
       * `m-auto` is load-bearing: a modal `<dialog>` is centred by the UA's own `margin: auto`,
       * and Tailwind's preflight resets `dialog { margin: 0 }`, pinning it to the top-left.
       * Opaque canvas and a hairline, no shadow — a trail page can have the map behind it.
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
           * Keyed on `open` so the form is a fresh mount each time: a report that has been
           * sent must not be re-sendable by reopening the sheet.
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
 * The other half of the lever, where the operator stands. Deliberately as quiet as the report
 * control beside it: survey red in a stranger's row reads as an accusation against them, and
 * hiding is reversible anyway. Drawn only for operators, but `moderatorProcedure` is what
 * enforces that — a forged role here buys a button and a FORBIDDEN.
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
