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
 * Filing a report, from the trail.
 *
 * The same field card the website prints, in the same order, because the order is the
 * argument rather than the layout: what you thought is one line of it and the rest is what
 * was actually there — the day, the ground, the way you travelled. A rating tells the next
 * hiker whether they will enjoy it; the conditions tell them whether to bring different
 * boots, and only one of those two facts goes stale in a fortnight.
 *
 * **A screen, not an expanding block.** The website opens the form in place under the
 * reports. That does not survive the translation: this form has a multi-line field in it,
 * and a text input inside a long scroll on a phone means the keyboard covers what you are
 * typing while the reports you were reading get shoved somewhere off screen. A slide-up
 * screen is what the hardware already does for composing anything, and it gives the writer
 * the whole display for the one thing they came here to do.
 *
 * **Rating is the only required field.** Everything else is optional and none of it nagged
 * for: a form that refuses "four, no comment" collects fewer reports and no more information.
 *
 * **The date is a rail of days, not a calendar.** This is the one form in the product most
 * likely to be filled in within an hour of the hike it describes, standing next to the car.
 * A wheel picker to say *today* is three gestures for the answer that is right nine times
 * out of ten. The fortnight is one tap each, and *Earlier* opens a typed date for the hike
 * somebody is writing up in January — which the website supports and this must not drop.
 *
 * **Photographs are not filed here.** They go through the strip further up the same screen,
 * where the rest of somebody's pictures of this trail already are. The website can afford a
 * second uploader inside the form because it has the width to show both; on a phone it would
 * be two controls that do the same thing on one small screen, and the one that is already
 * there works whether or not anyone is writing a report.
 */

const theme = nativeTheme('sheet');

const RATINGS = [1, 2, 3, 4, 5] as const;

/**
 * What each rating means, said in words.
 *
 * Bare numbers make everyone's four a different four. These are deliberately about the hike
 * and not about enthusiasm — "would do it again" is a fact a reader can act on in a way that
 * "great!" is not.
 */
const RATING_HINT: Readonly<Record<number, string>> = {
  1: 'Would not go back',
  2: 'Disappointing',
  3: 'Worth doing once',
  4: 'Would do it again',
  5: 'One of the best',
};

/**
 * How far back the rail of days reaches.
 *
 * A fortnight. Long enough to cover the hike somebody meant to write up last weekend and
 * didn't, short enough that the rail is still a rail rather than a scroll with an end nobody
 * reaches. Anything older is a typed date, and typing one is the rarer act.
 */
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

  /**
   * The fortnight, newest first.
   *
   * Built once for the life of the screen. It goes one day stale if somebody leaves the trail
   * page open across midnight, which costs them a chip labelled *Today* that means yesterday
   * — against rebuilding this list on every keystroke in the notes field.
   */
  const days = useMemo(() => {
    const today = todayLocal();
    return Array.from({ length: RAIL_DAYS }, (_, index) => addDays(today, -index));
  }, []);

  /**
   * Fill the form in from the server's copy, and only while it is closed.
   *
   * The guard is the whole point: `mine.data` changes identity after every successful save,
   * and without it a re-render halfway through a second edit would overwrite what the person
   * is currently typing with what they last published.
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
   * What is wrong with the typed date, if anything, in the schema's own words.
   *
   * Held off until all eight digits are in. Telling somebody that `2026-0` is not a date
   * while they are three keystrokes into typing one is technically true and useless.
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
     * The author of a removed report is told before they type, not after.
     *
     * `reviews.mine` returns the hidden row, but `toReview` empties it on the way out:
     * rating and body come back null, conditions empty, activity null, helpful count zero.
     * Only the dates and the author survive. So opening the form on it would show a blank
     * screen where their report was — reading as though the app had lost it rather than
     * removed it — and both buttons on that screen are refused server-side: `reviews.upsert`
     * will not edit a hidden row and `reviews.remove` will not delete one. Offering the
     * screen at all invites the two actions that cannot succeed. The notice carries the
     * address, which is the move that is actually available.
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
      // Copied out of state rather than passed by reference: the input schema takes a mutable
      // array, and handing zod the same array this component is still rendering from is an
      // aliasing bug waiting for the first `.sort()` anyone adds upstream.
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
            // Lets the notes field lift clear of the keyboard without a
            // `KeyboardAvoidingView` wrapping — and without the layout jump one causes on a
            // screen whose content is already taller than the display.
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

            {/* ── Rating ──────────────────────────────────────────────────────────────── */}
            <View style={styles.field}>
              <Text style={styles.fieldLabel}>How was it</Text>
              {/*
               * The five cells are the scale bar the reports are read with, at a size a thumb
               * can hit — you fill the same instrument you have been reading. The division
               * rules change colour with the fill exactly as they do there: woodland across
               * the empty cells, canvas across the filled ones, so a five still reads as five
               * divisions rather than one solid block.
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

            {/* ── When ────────────────────────────────────────────────────────────────── */}
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
                   * and `numbers-and-punctuation` hands somebody a keyboard they can type
                   * `2026/7/4` on — which is a date, and is not one this schema takes. Masking
                   * makes the malformed string unreachable rather than rejected.
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

            {/* ── How ─────────────────────────────────────────────────────────────────── */}
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

            {/* ── Conditions ──────────────────────────────────────────────────────────── */}
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

            {/* ── Notes ───────────────────────────────────────────────────────────────── */}
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

            {/* ── Actions ─────────────────────────────────────────────────────────────── */}
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
             * Two taps to withdraw, and the second one is the only control on this screen
             * allowed the survey plate — not because losing a report is dangerous, but
             * because it is the one thing here that destroys something. It says what will go.
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
 * One stop on a rail — a day, or a way of travelling.
 *
 * Not `Chip` from `./chip`. That one is built for a rail of twenty-four hours where the
 * label is two mono digits; these carry sentence-case words at a size somebody reads rather
 * than scans, and the tap target has to clear 44pt without slop because two of these rails
 * sit directly above a scrolling form.
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
  // ── Signed out ──
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

  // ── Removed by a moderator ──
  // Survey, and a hairline: this is about the reader's own standing on the site rather than
  // about the trail, which is the one thing that plate means.
  removed: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.survey,
    borderRadius: theme.radius.hair,
    padding: theme.space.lg,
  },
  removedProse: { ...theme.text('body', { family: 'text' }), color: theme.color.ink },

  // ── The way in ──
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

  // ── The form ──
  screen: { flex: 1, backgroundColor: theme.color.canvas },
  body: { gap: theme.space.xl, paddingHorizontal: theme.space.xl },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { ...theme.text('h4', { weight: 'medium' }), color: theme.color.ink },
  close: { padding: theme.space.xs },

  field: { gap: theme.space.sm },
  fieldLabel: { ...theme.collarLabel, color: theme.color.inkMuted },
  hint: { ...theme.text('caption', { family: 'text' }), color: theme.color.inkMuted },

  // ── Rating ──
  scale: {
    flexDirection: 'row',
    alignSelf: 'flex-start',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.woodland,
    borderRadius: theme.radius.hair,
    overflow: 'hidden',
  },
  // Wider than tall because the row is five of them and the number wants room, but the height
  // is the touch rung like every other control in this form — it was 44, which is Apple's
  // floor rather than ours, and the only raw number in a stylesheet that reaches for
  // `CONTROL_HEIGHT.touch` five other times.
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

  // ── Rails ──
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

  // ── Typed fields ──
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

  // ── Actions ──
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
