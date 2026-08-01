/**
 * Taking something down, and being told about it in the first place.
 *
 * Two halves of one obligation. The lever — hide a review, hide a photograph, and put it
 * back — is worth nothing without an inbox, because the operator is not the person who
 * finds the problem. And an inbox is worth nothing without the lever, because a complaint
 * you cannot act on is a complaint you have merely logged.
 *
 * **Hiding is soft and it is reversible.** Every takedown here sets a timestamp; nothing
 * deletes a row and nothing deletes an object from the bucket. Three reasons, in the order
 * they will actually come up: takedowns are sometimes wrong and an appeal has to be
 * answerable; a notice-and-takedown process has to be able to say what it removed, when,
 * and on whose complaint; and content that vanishes with no trace reads to its author as a
 * bug in the product rather than as a decision somebody made. So the review's row survives
 * and its page prints a tombstone.
 *
 * **What hidden content does to the numbers.** Every aggregate excludes it — the average
 * rating, the report count, the sixty-day conditions tally, a trail's photo count, the hero
 * photograph, a hiker's totals. This is not tidiness. A rating nobody is permitted to read
 * that is still inside the mean is a number on a card that no longer corresponds to
 * anything anybody said, and it drifts further every time somebody is moderated.
 *
 * **What is deliberately not here: automated image classification.** At this volume it
 * costs more in engineering than it saves, and the upload path is a presigned `PUT`
 * straight to the bucket — there is no point in the architecture where our code sees the
 * bytes. Adding one would mean adding a whole ingest hop to gain a filter that a
 * determined poster routes around anyway. The answer at this size is a report button and
 * somebody who reads the queue.
 */
import { z } from 'zod';
import { BRAND } from './brand';

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

export const USER_ROLES = ['member', 'moderator', 'admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_ROLE_LABEL: Readonly<Record<UserRole, string>> = {
  member: 'Member',
  moderator: 'Moderator',
  admin: 'Administrator',
};

/**
 * Who may hide and unhide content.
 *
 * A function over an explicit list rather than an ordering comparison, because "admin
 * outranks moderator" is a fact about *this* pair of roles and not a property of the enum.
 * The day a fourth role lands — a read-only auditor, say — a `>=` written against
 * declaration order silently grants it the takedown lever, and a list does not.
 */
export function canModerate(role: UserRole | null | undefined): boolean {
  return role === 'moderator' || role === 'admin';
}

/**
 * Who may change somebody's role.
 *
 * Narrower than `canModerate` on purpose. Handing out the takedown lever must not hand out
 * the ability to appoint people, or the first moderator can quietly become the last
 * administrator. This is the one privilege that is not delegable.
 */
export function canAdminister(role: UserRole | null | undefined): boolean {
  return role === 'admin';
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export const REPORT_SUBJECTS = ['review', 'photo'] as const;
export type ReportSubject = (typeof REPORT_SUBJECTS)[number];

export const REPORT_SUBJECT_LABEL: Readonly<Record<ReportSubject, string>> = {
  review: 'A trail report',
  photo: 'A photograph',
};

export const REPORT_REASONS = [
  'spam',
  'harassment',
  'hate',
  'sexual',
  'violence',
  'personal_information',
  'copyright',
  'misinformation',
  'other',
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

/**
 * The reasons, in the order the form offers them.
 *
 * Ordered by how often each is the real answer, not by severity — a picker sorted by how
 * bad the worst case is puts the rarest option first and makes everybody read the whole
 * list. `misinformation` is worded as a trail-safety claim rather than as a general truth
 * judgement, because on this product that is what it means and the general version is not
 * something a two-person operation can adjudicate.
 */
export const REPORT_REASON_LABEL: Readonly<Record<ReportReason, string>> = {
  spam: 'Spam or advertising',
  personal_information: "Someone's private information",
  harassment: 'Harassment or abuse of a person',
  hate: 'Hate speech',
  sexual: 'Sexual content',
  violence: 'Violence or self-harm',
  copyright: 'Copyright — this is my work',
  misinformation: 'Dangerously wrong about the trail',
  other: 'Something else',
};

/** A sentence under each option, for the ones where the label alone leaves a question. */
export const REPORT_REASON_HINT: Readonly<Record<ReportReason, string | null>> = {
  spam: null,
  personal_information: 'An address, a phone number, a face, a car registration.',
  harassment: null,
  hate: null,
  sexual: null,
  violence: null,
  copyright: 'Tell us where the original is published and we will take this down.',
  misinformation: 'A route description that would put somebody in danger.',
  other: 'Tell us what is wrong in the box below.',
};

export const REPORT_STATUSES = ['open', 'upheld', 'dismissed'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const REPORT_STATUS_LABEL: Readonly<Record<ReportStatus, string>> = {
  open: 'Open',
  upheld: 'Removed',
  dismissed: 'Left up',
};

/** Long enough to explain a copyright claim, short enough that nobody pastes a novel. */
export const REPORT_DETAIL_MAX = 2_000;

/** The moderator's own note on a takedown. Never shown to the reader; read on appeal. */
export const MODERATION_NOTE_MAX = 500;

/**
 * What a client sends to file a complaint.
 *
 * **No `reporterId` field.** The server takes that from the session and nowhere else, for
 * the same reason no procedure in `me` accepts a user id: a reporter id on the wire is a
 * way to file a complaint in somebody else's name.
 *
 * `contactEmail` is optional and so is being signed in. Somebody who has found a
 * photograph of their own front door on a trail page is not going to create an account to
 * tell us about it, and a takedown process that only accepts complaints from members is
 * not a takedown process.
 */
export const reportSubmitSchema = z.object({
  subject: z.enum(REPORT_SUBJECTS),
  subjectId: z.string().min(1).max(64),
  reason: z.enum(REPORT_REASONS),
  detail: z.string().trim().max(REPORT_DETAIL_MAX).nullish(),
  contactEmail: z.string().trim().email('That does not look like an email address.').nullish(),
});
export type ReportSubmit = z.infer<typeof reportSubmitSchema>;

/**
 * Where to write when the in-product control is not the right route — a rights holder with
 * a formal notice, a police request, somebody who cannot reach the page at all.
 */
export const MODERATION_CONTACT = {
  email: BRAND.supportEmail,
  /** What we undertake to do, stated as a number so it can be held to. */
  responseDays: 5,
} as const;

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * What a reader is told where hidden content used to be.
 *
 * One sentence, and it does not apologise and does not editorialise. It says what happened
 * — this was removed, by us, after a complaint — and it does not say what the content was
 * or what was wrong with it, because repeating the accusation is half of publishing it.
 */
export const REMOVED_NOTICE = 'Removed by a moderator after a report.';

/** The same fact, addressed to the person who wrote it, who is owed the way to argue. */
export const REMOVED_NOTICE_OWN = `Removed by a moderator after a report. Write to ${MODERATION_CONTACT.email} if you think that was wrong.`;
