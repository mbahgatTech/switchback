import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ReportReason, ReportSubject } from '@switchback/core';
import {
  MODERATION_CONTACT,
  REPORT_DETAIL_MAX,
  REPORT_REASONS,
  REPORT_REASON_HINT,
  REPORT_REASON_LABEL,
} from '@switchback/core';
import { CONTROL_HEIGHT, nativeTheme } from '@switchback/ui';
import { useTRPC } from '@/api/trpc';
import { useAuth } from '@/auth/context';
import { Mark } from '@/components/marks';

/**
 * "Report" — telling us about somebody else's writing or photograph, from the phone.
 *
 * **The half of notice-and-takedown that iOS was missing.** The app already rendered other
 * people's reports and photographs, and already drew the tombstone when one came down; it
 * had no way to file the complaint that produces a tombstone in the first place. Meanwhile
 * `/terms` told every reader that "every report and every photograph has a Report control
 * next to it", which was true of the website and false here — so somebody who found a
 * photograph of their own house on a trail screen had the email address and no page in the
 * app that told them even that. A takedown lever with no inbox on half the surfaces is the
 * failure the moderation work exists to close.
 *
 * **It works signed out**, for the same reason the website's does: the person most likely to
 * need it has no account and is not going to make one to tell us. Signed in, the email field
 * disappears — we already have an address.
 *
 * **The quietest control on the row.** No border, `inkMuted`, last in the order, at the full
 * touch height all the same. A report button that competes with the rest of the row gets
 * pressed by mistake, and a queue full of mis-taps is a queue the operator stops reading,
 * which costs the genuine report its answer.
 *
 * A screen rather than an in-place panel, matching `report-form.tsx` next door and for the
 * same reason: this form has a multi-line field, and a text input inside a long scroll on a
 * phone means the keyboard covers what is being typed.
 */

const theme = nativeTheme('sheet');

export interface ReportSheetProps {
  subject: ReportSubject;
  subjectId: string;
  /** What is being reported, for the title and the label a screen reader hears. */
  what: string;
  visible: boolean;
  onClose: () => void;
}

/** The form, as its own screen. Rendered by `ReportControl` and by the photograph viewer. */
export function ReportSheet({ subject, subjectId, what, visible, onClose }: ReportSheetProps) {
  const trpc = useTRPC();
  const insets = useSafeAreaInsets();
  const { status } = useAuth();
  const isViewerKnown = status === 'signedIn';

  const [reason, setReason] = useState<ReportReason>('spam');
  const [detail, setDetail] = useState('');
  const [email, setEmail] = useState('');

  const file = useMutation(trpc.moderation.report.mutationOptions());
  const hint = REPORT_REASON_HINT[reason];
  // Whether there is anywhere to send the answer. Promising a reply to somebody who left no
  // address contradicts the caption on the field two rows above it.
  const canReply = isViewerKnown || email.trim().length > 0;

  function close(): void {
    file.reset();
    setReason('spam');
    setDetail('');
    setEmail('');
    onClose();
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={close}>
      <View style={styles.screen}>
        <ScrollView
          contentContainerStyle={[
            styles.body,
            { paddingTop: insets.top + theme.space.lg, paddingBottom: insets.bottom + 64 },
          ]}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          automaticallyAdjustKeyboardInsets
        >
          <View style={styles.head}>
            <Text style={styles.title}>Report {what}</Text>
            <Pressable
              onPress={close}
              accessibilityRole="button"
              accessibilityLabel="Close"
              hitSlop={theme.space.md}
              style={styles.close}
            >
              <Mark shape="close" size={16} color={theme.color.inkMuted} />
            </Pressable>
          </View>

          {file.isSuccess ? (
            <>
              {/*
               * Announced rather than merely drawn: the control that was pressed is gone and
               * VoiceOver would otherwise say nothing at all about a screen that changed
               * completely under it.
               */}
              <Text
                accessibilityLiveRegion="polite"
                accessibilityRole="summary"
                style={styles.prose}
              >
                {canReply
                  ? `We have it. A moderator reads every report and answers within ${String(MODERATION_CONTACT.responseDays)} days. If it needs taking down sooner, it will be.`
                  : `We have it. A moderator reads every report within ${String(MODERATION_CONTACT.responseDays)} days. You did not leave an address, so there is nowhere to send the answer — if it comes down, you will see that on the trail.`}
              </Text>
              <Text style={styles.hint}>
                Nothing on the screen changes yet. Removing something is a decision somebody makes,
                not one this button makes for them.
              </Text>
              <View style={styles.actions}>
                <Pressable onPress={close} accessibilityRole="button" style={styles.file}>
                  <Text style={styles.fileLabel}>Close</Text>
                </Pressable>
              </View>
            </>
          ) : (
            <>
              <Text style={styles.hint}>
                Tell us what is wrong with it. This goes to a person, not a filter.
              </Text>

              <View style={styles.field}>
                <Text style={styles.fieldLabel}>What is wrong</Text>
                <View style={styles.reasons}>
                  {REPORT_REASONS.map((option) => (
                    <Pressable
                      key={option}
                      onPress={() => setReason(option)}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: reason === option }}
                      style={styles.reason}
                    >
                      <Text
                        style={[
                          styles.reasonLabel,
                          reason === option ? styles.reasonLabelOn : null,
                        ]}
                      >
                        {REPORT_REASON_LABEL[option]}
                      </Text>
                    </Pressable>
                  ))}
                </View>
                {hint === null ? null : <Text style={styles.hint}>{hint}</Text>}
              </View>

              <View style={styles.field}>
                <Text style={styles.fieldLabel}>Anything else</Text>
                <TextInput
                  value={detail}
                  onChangeText={setDetail}
                  maxLength={REPORT_DETAIL_MAX}
                  multiline
                  placeholderTextColor={theme.color.inkMuted}
                  selectionColor={theme.color.inkMuted}
                  accessibilityLabel="Anything else about this report"
                  style={[styles.input, styles.notes]}
                />
              </View>

              {isViewerKnown ? null : (
                <View style={styles.field}>
                  <Text style={styles.fieldLabel}>Your email, if you want an answer</Text>
                  <TextInput
                    value={email}
                    onChangeText={setEmail}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="email-address"
                    placeholderTextColor={theme.color.inkMuted}
                    selectionColor={theme.color.inkMuted}
                    accessibilityLabel="Your email address"
                    style={styles.input}
                  />
                  <Text style={styles.hint}>
                    Optional. We use it to reply about this report and for nothing else.
                  </Text>
                </View>
              )}

              {file.isError ? (
                /*
                 * Says what happened and what to do about it. A stale id — the review was
                 * deleted between the screen loading and the send — comes back NOT_FOUND, and
                 * telling that reader to try again advises an action that cannot ever work.
                 */
                <Text accessibilityLiveRegion="assertive" style={styles.error}>
                  {file.error.data?.code === 'NOT_FOUND'
                    ? `That is not on the site any more — it was deleted or already removed, so there is nothing left to report. Write to ${MODERATION_CONTACT.email} if there is more to it than that.`
                    : file.error.data?.code === 'TOO_MANY_REQUESTS'
                      ? file.error.message
                      : `That report did not send. Try again, or write to ${MODERATION_CONTACT.email} and say which trail it was on.`}
                </Text>
              ) : null}

              <View style={styles.actions}>
                <Pressable
                  onPress={() =>
                    file.mutate({
                      subject,
                      subjectId,
                      reason,
                      detail: detail.trim() || null,
                      // Never sent for a signed-in reporter: we have their address, and asking
                      // for a second one is a way to answer the wrong person.
                      contactEmail: isViewerKnown || !email.trim() ? null : email.trim(),
                    })
                  }
                  disabled={file.isPending}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: file.isPending }}
                  style={({ pressed }) => [
                    styles.file,
                    file.isPending ? styles.fileOff : null,
                    pressed ? styles.filePressed : null,
                  ]}
                >
                  <Text style={styles.fileLabel}>
                    {file.isPending ? 'Sending…' : 'Send report'}
                  </Text>
                </Pressable>
                <Pressable
                  onPress={close}
                  disabled={file.isPending}
                  accessibilityRole="button"
                  style={styles.cancel}
                >
                  <Text style={styles.cancelLabel}>Cancel</Text>
                </Pressable>
              </View>
            </>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

/** The inline trigger and the sheet behind it — what a review row renders. */
export function ReportControl({
  subject,
  subjectId,
  what,
}: {
  subject: ReportSubject;
  subjectId: string;
  what: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={`Report ${what}`}
        hitSlop={theme.space.sm}
        style={styles.trigger}
      >
        <Text style={styles.triggerLabel}>Report</Text>
      </Pressable>

      <ReportSheet
        subject={subject}
        subjectId={subjectId}
        what={what}
        visible={open}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

const styles = StyleSheet.create({
  trigger: { alignSelf: 'flex-start', minHeight: CONTROL_HEIGHT.panel, justifyContent: 'center' },
  triggerLabel: { ...theme.collarLabel, color: theme.color.inkMuted },

  screen: { flex: 1, backgroundColor: theme.color.canvas },
  body: { gap: theme.space.xl, paddingHorizontal: theme.space.xl },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { ...theme.text('h4', { weight: 'medium' }), color: theme.color.ink, flexShrink: 1 },
  close: { padding: theme.space.xs },

  prose: { ...theme.text('body', { family: 'text' }), color: theme.color.ink },
  hint: { ...theme.text('caption', { family: 'text' }), color: theme.color.inkMuted },

  field: { gap: theme.space.sm },
  fieldLabel: { ...theme.collarLabel, color: theme.color.inkMuted },

  /*
   * Nine options in a ruled list, all visible. The website makes the same choice and for the
   * same reason: this is a list somebody reads while upset, and a picker that hides eight of
   * them behind a tap is one more thing between them and being heard.
   */
  reasons: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.color.bezel },
  reason: {
    minHeight: CONTROL_HEIGHT.touch,
    justifyContent: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.color.bezel,
  },
  reasonLabel: { ...theme.text('body', { family: 'text' }), color: theme.color.inkMuted },
  // The chosen one goes to full ink. No tick and no fill: the weight of the line is the
  // selection, which is how every other list in this app marks one.
  reasonLabelOn: { color: theme.color.ink },

  input: {
    ...theme.text('body', { family: 'text' }),
    color: theme.color.ink,
    backgroundColor: theme.color.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.bezel,
    borderRadius: theme.radius.hair,
    paddingHorizontal: theme.space.md,
    paddingVertical: theme.space.sm,
  },
  notes: { minHeight: 96, textAlignVertical: 'top' },

  actions: { flexDirection: 'row', alignItems: 'center', gap: theme.space.md },
  file: {
    minHeight: CONTROL_HEIGHT.touch,
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.ink,
    borderRadius: theme.radius.hair,
    paddingHorizontal: theme.space.lg,
  },
  fileOff: { opacity: 0.45 },
  filePressed: { opacity: 0.55 },
  fileLabel: { ...theme.collarLabel, color: theme.color.ink },
  cancel: { minHeight: CONTROL_HEIGHT.touch, justifyContent: 'center' },
  cancelLabel: { ...theme.collarLabel, color: theme.color.inkMuted },

  // Survey: the one line here about the reader's own position in the process rather than
  // about the content.
  error: {
    ...theme.text('caption', { family: 'text' }),
    color: theme.color.survey,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.survey,
    borderRadius: theme.radius.hair,
    paddingHorizontal: theme.space.md,
    paddingVertical: theme.space.sm,
  },
});
