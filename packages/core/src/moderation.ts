/**
 * Taking something down, and being told about it in the first place.
 *
 * **Hiding is soft and reversible.** Every takedown sets a timestamp; nothing deletes a row or
 * an object — an appeal has to be answerable and a notice-and-takedown process has to say what
 * it removed and when. The row survives and its page prints a tombstone.
 *
 * **Every aggregate excludes hidden content** — average rating, report count, conditions tally,
 * photo counts, hero photograph, a hiker's totals. A rating nobody may read that is still inside
 * the mean corresponds to nothing anybody said.
 *
 * Automated image classification is deliberately absent: uploads are a presigned `PUT` straight
 * to the bucket, so no point in the architecture sees the bytes.
 */
import { z } from 'zod';
import { BRAND } from './brand';

export const USER_ROLES = ['member', 'moderator', 'admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_ROLE_LABEL: Readonly<Record<UserRole, string>> = {
  member: 'Member',
  moderator: 'Moderator',
  admin: 'Administrator',
};

/** Who may hide and unhide content. An explicit list, not a rank comparison: a `>=` written
 * against declaration order silently grants the takedown lever to any role added later. */
export function canModerate(role: UserRole | null | undefined): boolean {
  return role === 'moderator' || role === 'admin';
}

/** Who may change somebody's role. Narrower than `canModerate` on purpose — otherwise the first
 * moderator can quietly become the last administrator. */
export function canAdminister(role: UserRole | null | undefined): boolean {
  return role === 'admin';
}

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

/** The reasons, in the order the form offers them — by how often each is the real answer, not by
 * severity. `misinformation` is a trail-safety claim, not a general truth judgement. */
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
 * What a client sends to file a complaint. **No `reporterId`** — the server takes that from the
 * session, because an id on the wire is a way to file in somebody else's name. `contactEmail` is
 * optional and so is being signed in: a process that only accepts complaints from members is not
 * a takedown process.
 */
export const reportSubmitSchema = z.object({
  subject: z.enum(REPORT_SUBJECTS),
  subjectId: z.string().min(1).max(64),
  reason: z.enum(REPORT_REASONS),
  detail: z.string().trim().max(REPORT_DETAIL_MAX).nullish(),
  contactEmail: z.string().trim().email('That does not look like an email address.').nullish(),
});
export type ReportSubmit = z.infer<typeof reportSubmitSchema>;

/** Where to write when the in-product control is not the right route — a rights holder with a
 * formal notice, a police request, somebody who cannot reach the page at all. */
export const MODERATION_CONTACT = {
  email: BRAND.supportEmail,
  /** What we undertake to do, stated as a number so it can be held to. */
  responseDays: 5,
} as const;

/**
 * What a reader is told where hidden content used to be. It says what happened and not what the
 * content was — repeating the accusation is half of publishing it.
 */
export const REMOVED_NOTICE = 'Removed by a moderator after a report.';

/** The same fact, addressed to the person who wrote it, who is owed the way to argue. */
export const REMOVED_NOTICE_OWN = `Removed by a moderator after a report. Write to ${MODERATION_CONTACT.email} if you think that was wrong.`;
