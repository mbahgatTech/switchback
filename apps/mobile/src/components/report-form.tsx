import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ActivityType, TrailCondition } from '@switchback/core';
import {
  ACTIVITY_TYPES,
  ACTIVITY_TYPE_LABELS,
  REVIEW_BODY_MAX,
  TRAIL_CONDITIONS,
  addDays,
  formatDateLabel,
  formatDayLabel,
  REMOVED_NOTICE_OWN,
  hikedOnSchema,
  todayLocal,
} from '@switchback/core';
import { CONTROL_HEIGHT, nativeTheme } from '@switchback/ui';
import { askAgain } from '@/api/after-write';
import { useTRPC } from '@/api/trpc';
import { useAuth } from '@/auth/context';
import { Mark } from '@/components/marks';
import { ConditionToggle } from './condition-chip';

/**
 * Filing a report, from the trail — the same field card the website prints, in the same order.
 *
 * A slide-up screen rather than the website's in-place block: a multi-line field inside a long
 * scroll means the keyboard covers what is being typed. Rating is the only required field.
 * The date is a rail of days rather than a calendar, with *Earlier* opening a typed date for a
 * hike written up in January. Photographs are filed through the strip further up the screen,
 * not here.
 */

const theme = nativeTheme('sheet');

const RATINGS = [1, 2, 3, 4, 5] as const;

/**
 * What each rating means, said in words — bare numbers make everyone's four a different four.
 * Deliberately about the hike rather than enthusiasm: "would do it again" is actionable.
 */
const RATING_HINT: Readonly<Record<number, string>> = {
  1: 'Would not go back',
  2: 'Disappointing',
  3: 'Worth doing once',
  4: 'Would do it again',
  5: 'One of the best',
};

/** How far back the rail of days reaches. Anything older is a typed date. */
const RAIL_DAYS = 14;

export function ReportForm({ trailId }: { trailId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { status } = useAuth();
  const insets = useSafeAreaInsets();

  const signedIn = status === 'signedIn';

  const mine = useQuery({ ...trpc.reviews.mine.queryOptions({ trailId }), enabled: signedIn });
  const existing = mine.data ?? null;

  const [open, setOpen] = useState(false);
  const [rating, setRating] = useState<number | null>(null);
  const [hikedOn, setHikedOn] = useState('');
  const [typing, setTyping] = useState(false);
  const [typed, setTyped] = useState('');
  const [conditions, setConditions] = useState<readonly TrailCondition[]>([]);
  const [body, setBody] = useState('');
  const [activityType, setActivityType] = useState<ActivityType | ''>('');
  const [confirmingRemoval, setConfirmingRemoval] = useState(false);

  /** The fortnight, newest first. Built once, so it goes a day stale across midnight. */
  const days = useMemo(() => {
    const today = todayLocal();
    return Array.from({ length: RAIL_DAYS }, (_, index) => addDays(today, -index));
  }, []);

  /**
   * Fill the form in from the server's copy, and only while it is closed. `mine.data` changes
   * identity after every save, so without the guard a re-render mid-edit would overwrite what
   * the person is typing with what they last published.
   */
  useEffect(() => {
    if (open) return;
    const saved = existing?.hikedOn ?? '';
    const older = saved !== '' && !days.includes(saved);
    setRating(existing?.rating ?? null);
    setHikedOn(older ? '' : saved);
    setTyping(older);
    setTyped(older ? saved : '');
    setConditions(existing?.conditions ?? []);
    setBody(existing?.body ?? '');
    setActivityType(existing?.activityType ?? '');
  }, [existing, days, open]);

  /**
   * What is wrong with the typed date, in the schema's own words. Held off until all eight
   * digits are in — `2026-0` is not a date, and saying so mid-keystroke is useless.
   */
  const dateIssue = useMemo(() => {
    if (!typing || typed.length < 10) return null;
    const parsed = hikedOnSchema.safeParse(typed);
    if (parsed.success) return null;
    return parsed.error.issues[0]?.message ?? 'That date will not do.';
  }, [typing, typed]);

  const dayHiked = typing ? (dateIssue === null && typed.length === 10 ? typed : '') : hikedOn;

  /** Everything this write moved: the reports, the average on them, and the trail's own card. */
  function refresh(): void {
    void askAgain(queryClient, trpc.reviews.pathFilter());
    void askAgain(queryClient, trpc.trails.bySlug.pathFilter());
  }

  const save = useMutation(
    trpc.reviews.upsert.mutationOptions({
      onSuccess: () => {
        setOpen(false);
        setConfirmingRemoval(false);
        refresh();
      },
    }),
  );

  const remove = useMutation(
    trpc.reviews.remove.mutationOptions({
      onSuccess: () => {
        setOpen(false);
        setConfirmingRemoval(false);
        setRating(null);
        setHikedOn('');
        setTyping(false);
        setTyped('');
        setConditions([]);
        setBody('');
        setActivityType('');
        refresh();
      },
    }),
  );

  const busy = save.isPending || remove.isPending;

  if (!signedIn) {
    return (
      <View style={styles.prompt}>
        <Text style={styles.promptProse}>
          Hiked this one? Sign in to report what the ground was like. Conditions go stale fastest
          and are the hardest thing to get from a map.
        </Text>
        <Pressable
          onPress={() => router.push('/signin')}
          accessibilityRole="button"
          style={({ pressed }) => [styles.open, pressed ? styles.openPressed : null]}
        >
          <Text style={styles.openLabel}>Sign in</Text>
        </Pressable>
      </View>
    );
  }

  if (existing?.hidden) {
    /*
     * The author of a removed report is told before they type, not after. `reviews.mine`
     * returns the hidden row but `toReview` empties it, so the form would open on a blank
     * screen — and both its buttons are refused server-side: `upsert` will not edit a hidden
     * row and `remove` will not delete one. The notice carries the address instead.
     */
    return (
      <View style={styles.removed}>
        <Text style={styles.removedProse}>{REMOVED_NOTICE_OWN}</Text>
      </View>
    );
  }

  function toggle(condition: TrailCondition): void {
    setConditions((current) =>
      current.includes(condition)
        ? current.filter((value) => value !== condition)
        : [...current, condition],
    );
  }

  function submit(): void {
    if (rating === null) return;
    save.mutate({
      trailId,
      rating,
      body: body.trim() || null,
      hikedOn: dayHiked || null,
      // Copied rather than passed by reference: the input schema takes a mutable array, and
      // handing zod the array this component still renders from is an aliasing bug in waiting.
      conditions: [...conditions],
      ...(activityType ? { activityType } : {}),
    });
  }

  return (
    <View>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        style={({ pressed }) => [styles.open, pressed ? styles.openPressed : null]}
      >
        <Text style={styles.openLabel}>
          {existing === null ? 'Report on this trail' : 'Edit your report'}
        </Text>
      </Pressable>

      <Modal visible={open} animationType="slide" onRequestClose={() => setOpen(false)}>
        <View style={styles.screen}>
          <ScrollView
            contentContainerStyle={[
              styles.body,
              { paddingTop: insets.top + theme.space.lg, paddingBottom: insets.bottom + 64 },
            ]}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            // Lets the notes field lift clear of the keyboard without a `KeyboardAvoidingView`,
            // and without the layout jump one causes on content taller than the display.
            automaticallyAdjustKeyboardInsets
          >
            <View style={styles.head}>
              <Text style={styles.title}>
                {existing === null ? 'Report on this trail' : 'Your report'}
              </Text>
              <Pressable
                onPress={() => setOpen(false)}
                accessibilityRole="button"
                accessibilityLabel="Close without saving"
                hitSlop={theme.space.md}
                style={styles.close}
              >
                <Mark shape="close" size={16} color={theme.color.inkMuted} />
              </Pressable>
            </View>

            {/* Rating */}
            <View style={styles.field}>
              <Text style={styles.fieldLabel}>How was it</Text>
              {/*
               * The five cells are the scale bar the reports are read with, at a size a thumb
               * can hit. The division rules change colour with the fill exactly as they do
               * there, so a five still reads as five divisions rather than one solid block.
               */}
              <View style={styles.scale}>
                {RATINGS.map((value) => {
                  const filled = rating !== null && value <= rating;
                  return (
                    <Pressable
                      key={value}
                      onPress={() => setRating(value)}
                      disabled={busy}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: rating === value }}
                      accessibilityLabel={`${value} out of 5 — ${RATING_HINT[value] ?? ''}`}
                      style={[
                        styles.cell,
                        filled ? styles.cellFilled : null,
                        value === 1 ? null : filled ? styles.ruleOnFill : styles.rule,
                      ]}
                    >
                      <Text style={[styles.cellLabel, filled ? styles.cellLabelFilled : null]}>
                        {value}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              <Text style={styles.hint}>
                {rating === null
                  ? 'Pick a number to file the report.'
                  : (RATING_HINT[rating] ?? '')}
              </Text>
            </View>

            {/* When */}
            <View style={styles.field}>
              <Text style={styles.fieldLabel}>Hiked on</Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.rail}
                keyboardShouldPersistTaps="handled"
              >
                <Day
                  label="Not saying"
                  on={!typing && hikedOn === ''}
                  onPress={() => {
                    setTyping(false);
                    setHikedOn('');
                  }}
                />
                {days.map((date, index) => (
                  <Day
                    key={date}
                    label={index === 0 ? 'Today' : index === 1 ? 'Yesterday' : formatDayLabel(date)}
                    on={!typing && hikedOn === date}
                    onPress={() => {
                      setTyping(false);
                      setHikedOn(date);
                    }}
                  />
                ))}
                <Day label="Earlier…" on={typing} onPress={() => setTyping(true)} />
              </ScrollView>

              {typing ? (
                <View style={styles.typed}>
                  {/*
                   * Digits only, dashes inserted as they arrive. A number pad has no dash key
                   * and `numbers-and-punctuation` lets somebody type `2026/7/4`, which this
                   * schema does not take. Masking makes the malformed string unreachable.
                   */}
                  <TextInput
                    value={typed}
                    onChangeText={(next) => setTyped(maskDate(next))}
                    keyboardType="number-pad"
                    placeholder="YYYY-MM-DD"
                    placeholderTextColor={theme.color.inkMuted}
                    selectionColor={theme.color.inkMuted}
                    accessibilityLabel="The date you hiked it, as year, month and day"
                    style={[styles.input, styles.date]}
                  />
                  <Text style={styles.hint}>
                    {dateIssue ??
                      (dayHiked === ''
                        ? 'The day you were there.'
                        : `Hiked ${formatDateLabel(dayHiked)}.`)}
                  </Text>
                </View>
              ) : null}
            </View>

            {/* How */}
            <View style={styles.field}>
              <Text style={styles.fieldLabel}>Travelling by</Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.rail}
                keyboardShouldPersistTaps="handled"
              >
                <Day
                  label="Not saying"
                  on={activityType === ''}
                  onPress={() => setActivityType('')}
                />
                {ACTIVITY_TYPES.map((option) => (
                  <Day
                    key={option}
                    label={ACTIVITY_TYPE_LABELS[option]}
                    on={activityType === option}
                    onPress={() => setActivityType(option)}
                  />
                ))}
              </ScrollView>
            </View>

            {/* Conditions */}
            <View style={styles.field}>
              <Text style={styles.fieldLabel}>What was the ground like</Text>
              <View style={styles.tags}>
                {TRAIL_CONDITIONS.map((condition) => (
                  <ConditionToggle
                    key={condition}
                    condition={condition}
                    selected={conditions.includes(condition)}
                    onPress={() => toggle(condition)}
                  />
                ))}
              </View>
            </View>

            {/* Notes */}
            <View style={styles.field}>
              <Text style={styles.fieldLabel}>Anything else worth knowing</Text>
              <TextInput
                value={body}
                onChangeText={setBody}
                maxLength={REVIEW_BODY_MAX}
                multiline
                placeholder="Where the path is hard to follow, where the water is, what you wish you had known."
                placeholderTextColor={theme.color.inkMuted}
                selectionColor={theme.color.inkMuted}
                accessibilityLabel="Notes for the next hiker"
                style={[styles.input, styles.notes]}
              />
            </View>

            {/* Actions */}
            <View style={styles.actions}>
              <Pressable
                onPress={submit}
                disabled={rating === null || busy}
                accessibilityRole="button"
                accessibilityState={{ disabled: rating === null || busy }}
                style={({ pressed }) => [
                  styles.file,
                  rating === null || busy ? styles.fileOff : null,
                  pressed ? styles.filePressed : null,
                ]}
              >
                <Text style={styles.fileLabel}>
                  {save.isPending ? 'Filing…' : existing === null ? 'File report' : 'Update report'}
                </Text>
              </Pressable>
              <Pressable
                onPress={() => setOpen(false)}
                disabled={busy}
                accessibilityRole="button"
                style={styles.cancel}
              >
                <Text style={styles.cancelLabel}>Cancel</Text>
              </Pressable>
            </View>

            {save.isError ? <Text style={styles.error}>{save.error.message}</Text> : null}
            {remove.isError ? <Text style={styles.error}>{remove.error.message}</Text> : null}

            {/*
             * Two taps to withdraw, and the second is the only control here allowed the survey
             * plate — it is the one thing on this screen that destroys something.
             */}
            {existing === null ? null : (
              <View style={styles.danger}>
                {confirmingRemoval ? (
                  <>
                    <Text style={styles.dangerProse}>
                      Remove your report? The rating and everything you wrote goes with it.
                    </Text>
                    <View style={styles.dangerActions}>
                      <Pressable
                        onPress={() => remove.mutate({ trailId })}
                        disabled={busy}
                        accessibilityRole="button"
                        style={({ pressed }) => [
                          styles.removeConfirm,
                          pressed ? styles.removeConfirmPressed : null,
                        ]}
                      >
                        <Text style={styles.removeConfirmLabel}>
                          {remove.isPending ? 'Removing…' : 'Remove'}
                        </Text>
                      </Pressable>
                      <Pressable
                        onPress={() => setConfirmingRemoval(false)}
                        accessibilityRole="button"
                        style={styles.cancel}
                      >
                        <Text style={styles.cancelLabel}>Keep it</Text>
                      </Pressable>
                    </View>
                  </>
                ) : (
                  <Pressable
                    onPress={() => setConfirmingRemoval(true)}
                    accessibilityRole="button"
                    style={styles.cancel}
                  >
                    <Text style={styles.cancelLabel}>Remove your report</Text>
                  </Pressable>
                )}
              </View>
            )}
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

/**
 * One stop on a rail — a day, or a way of travelling. Not `Chip` from `./chip`: that one is
 * built for two mono digits, and these carry sentence-case words at a 44pt target without slop,
 * because two of these rails sit directly above a scrolling form.
 */
function Day({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected: on }}
      style={({ pressed }) => [
        styles.day,
        on ? styles.dayOn : null,
        pressed && !on ? styles.dayPressed : null,
      ]}
    >
      <Text style={[styles.dayLabel, on ? styles.dayLabelOn : null]}>{label}</Text>
    </Pressable>
  );
}

/** `20260704` → `2026-07-04`, growing a dash at a time as the digits arrive. */
function maskDate(input: string): string {
  const digits = input.replace(/[^0-9]/g, '').slice(0, 8);
  return [digits.slice(0, 4), digits.slice(4, 6), digits.slice(6, 8)]
    .filter((part) => part.length > 0)
    .join('-');
}

const styles = StyleSheet.create({
  prompt: {
    gap: theme.space.md,
    alignItems: 'flex-start',
    borderWidth: StyleSheet.hairlineWidth,
    borderStyle: 'dashed',
    borderColor: theme.color.bezel,
    borderRadius: theme.radius.hair,
    padding: theme.space.lg,
  },
  promptProse: { ...theme.text('body', { family: 'text' }), color: theme.color.inkMuted },

  // Survey and a hairline: this is about the reader's own standing on the site rather than
  // about the trail, which is the one thing that plate means.
  removed: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.survey,
    borderRadius: theme.radius.hair,
    padding: theme.space.lg,
  },
  removedProse: { ...theme.text('body', { family: 'text' }), color: theme.color.ink },

  open: {
    alignSelf: 'flex-start',
    minHeight: CONTROL_HEIGHT.touch,
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.ink,
    borderRadius: theme.radius.hair,
    paddingHorizontal: theme.space.lg,
  },
  // Dims rather than fills. A fill would have to carry the label to canvas with it, and a
  // label that stays ink inside an ink fill is an invisible button.
  openPressed: { opacity: 0.55 },
  openLabel: { ...theme.collarLabel, color: theme.color.ink },

  screen: { flex: 1, backgroundColor: theme.color.canvas },
  body: { gap: theme.space.xl, paddingHorizontal: theme.space.xl },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { ...theme.text('h4', { weight: 'medium' }), color: theme.color.ink },
  close: { padding: theme.space.xs },

  field: { gap: theme.space.sm },
  fieldLabel: { ...theme.collarLabel, color: theme.color.inkMuted },
  hint: { ...theme.text('caption', { family: 'text' }), color: theme.color.inkMuted },

  scale: {
    flexDirection: 'row',
    alignSelf: 'flex-start',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.woodland,
    borderRadius: theme.radius.hair,
    overflow: 'hidden',
  },
  // Wider than tall because the row is five of them, but the height is the touch rung like
  // every other control in this form.
  cell: {
    width: 52,
    height: CONTROL_HEIGHT.touch,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cellFilled: { backgroundColor: theme.color.woodland },
  cellLabel: { ...theme.text('body', { family: 'mono' }), color: theme.color.woodland },
  cellLabelFilled: { color: theme.color.canvas },
  rule: { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: theme.color.woodland },
  ruleOnFill: { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: theme.color.canvas },

  rail: { flexDirection: 'row', gap: theme.space.xs, paddingRight: theme.space.xl },
  day: {
    minHeight: CONTROL_HEIGHT.touch,
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.bezel,
    borderRadius: theme.radius.hair,
    paddingHorizontal: theme.space.md,
    backgroundColor: theme.color.surface,
  },
  dayOn: { borderColor: theme.color.ink, backgroundColor: theme.color.ink },
  dayPressed: { borderColor: theme.color.ink },
  dayLabel: { ...theme.text('caption', { weight: 'medium' }), color: theme.color.inkMuted },
  dayLabelOn: { color: theme.color.canvas },

  typed: { gap: theme.space.xs },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.xs },

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
  // Mono and narrow: a date is a reading, and it lines its digits up under the mask.
  date: { ...theme.text('body', { family: 'mono' }), alignSelf: 'flex-start', width: 168 },
  notes: { minHeight: 132, textAlignVertical: 'top' },

  actions: { flexDirection: 'row', alignItems: 'center', gap: theme.space.sm },
  file: {
    minHeight: CONTROL_HEIGHT.touch,
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.ink,
    borderRadius: theme.radius.hair,
    backgroundColor: theme.color.ink,
    paddingHorizontal: theme.space.xl,
  },
  filePressed: { opacity: 0.8 },
  fileOff: { opacity: 0.4 },
  fileLabel: { ...theme.collarLabel, color: theme.color.canvas },

  cancel: {
    minHeight: CONTROL_HEIGHT.touch,
    justifyContent: 'center',
    paddingHorizontal: theme.space.md,
  },
  cancelLabel: { ...theme.collarLabel, color: theme.color.inkMuted },

  error: { ...theme.text('caption', { family: 'text' }), color: theme.color.survey },

  danger: {
    gap: theme.space.sm,
    paddingTop: theme.space.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.color.bezel,
  },
  dangerProse: { ...theme.text('body', { family: 'text' }), color: theme.color.ink },
  dangerActions: { flexDirection: 'row', alignItems: 'center', gap: theme.space.sm },
  removeConfirm: {
    minHeight: CONTROL_HEIGHT.touch,
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.survey,
    borderRadius: theme.radius.hair,
    paddingHorizontal: theme.space.lg,
  },
  removeConfirmPressed: { opacity: 0.55 },
  removeConfirmLabel: { ...theme.collarLabel, color: theme.color.survey },
});
