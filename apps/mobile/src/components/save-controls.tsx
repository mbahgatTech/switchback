import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  EMPTY_SAVE_STATE,
  LIST_NAME_MAX,
  formatDateLabel,
  plural,
  todayLocal,
} from '@switchback/core';
import { CONTROL_HEIGHT, nativeTheme } from '@switchback/ui';
import { askAgain } from '@/api/after-write';
import { useTRPC } from '@/api/trpc';
import { useAuth } from '@/auth/context';
import { Mark, type MarkShape } from '@/components/marks';

/**
 * What this trail is to you.
 *
 * Three marks and a shelf, the same four controls the website draws, in the same order and
 * with the same shapes — ring the ones worth returning to, flag the ones still ahead, tick
 * the ones done, and file the rest on a list the marks are not specific enough for. The two
 * clients share the drawings rather than the idea, so a ring here and a ring in a browser are
 * the same annotation on the same sheet.
 *
 * **The phone is where this gets used.** On the website marking a trail done is an act of
 * bookkeeping done at a desk, later. Here it is a tap in a car park with the boots still on,
 * which is why the tick logs today on the first press without asking, and why *Log another
 * day* — the correction — is the smaller control underneath rather than a dialog in the way.
 *
 * **Two of the three are toggles and the third is not, and the row does not pretend
 * otherwise.** Ring and flag are opinions, revisable at no cost. A tick is a claim about a
 * day you were somewhere and it carries a date whether or not anyone asked for one, so
 * un-ticking with several hikes on the record asks first: "no I haven't" quietly deleting
 * three dated entries is not what the gesture means.
 *
 * **Ink, not survey.** Every pressed control in this product is ink on canvas. Red stays
 * where the sign-in screen put it — the reader and their safety — and three filled red
 * buttons on a trail screen is how a colour that has to still mean something on a ridge stops
 * meaning anything.
 */

const theme = nativeTheme('sheet');

interface MarkDef {
  shape: MarkShape;
  label: string;
  /** Said in place of the label when the mark is set, for the screen reader. */
  pressedLabel: string;
}

const RING: MarkDef = { shape: 'ring', label: 'Favourite', pressedLabel: 'Favourited' };
const FLAG: MarkDef = {
  shape: 'flag',
  label: 'Want to do',
  pressedLabel: 'On your want-to-do list',
};
const TICK: MarkDef = { shape: 'tick', label: 'Done', pressedLabel: 'Marked done' };

const MARKS = [RING, FLAG, TICK];

export function SaveControls({ trailId }: { trailId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { status } = useAuth();

  const signedIn = status === 'signedIn';

  const [shelfOpen, setShelfOpen] = useState(false);
  const [logging, setLogging] = useState(false);
  const [logDate, setLogDate] = useState('');
  const [confirmingForget, setConfirmingForget] = useState(false);
  const [newListName, setNewListName] = useState('');

  const state = useQuery({ ...trpc.lists.saveState.queryOptions({ trailId }), enabled: signedIn });
  // The shelf's contents are only ever read while it is open, so the query is too. Opening it
  // is the one moment in this component where a spinner is honest.
  const lists = useQuery({ ...trpc.lists.mine.queryOptions(), enabled: signedIn && shelfOpen });

  /** Every write here moves something `lists.*` answers, so they all settle the same way. */
  function settle(): void {
    void askAgain(queryClient, trpc.lists.pathFilter());
    // The header carries the popularity a logged hike just moved.
    void askAgain(queryClient, trpc.trails.bySlug.pathFilter());
  }

  const toggle = useMutation(trpc.lists.toggle.mutationOptions({ onSuccess: settle }));
  const record = useMutation(
    trpc.lists.recordCompletion.mutationOptions({
      onSuccess: () => {
        setLogging(false);
        setLogDate('');
        settle();
      },
    }),
  );
  const forget = useMutation(
    trpc.lists.forgetCompletion.mutationOptions({
      onSuccess: () => {
        setConfirmingForget(false);
        settle();
      },
    }),
  );
  const addTrail = useMutation(trpc.lists.addTrail.mutationOptions({ onSuccess: settle }));
  const removeTrail = useMutation(trpc.lists.removeTrail.mutationOptions({ onSuccess: settle }));
  const createList = useMutation(
    trpc.lists.create.mutationOptions({
      onSuccess: async (list) => {
        setNewListName('');
        // Made and filled in one gesture: nobody creates a list from a trail screen and then
        // means to leave that trail out of it.
        await addTrail.mutateAsync({ listId: list.id, trailId });
        settle();
      },
    }),
  );

  const error =
    toggle.error ??
    record.error ??
    forget.error ??
    addTrail.error ??
    removeTrail.error ??
    createList.error;

  /*
   * Signed out the row renders the same three shapes at the same size, as a way to sign in.
   * Nothing shifts when the screen comes back with an account behind it, and the controls
   * themselves say what an account is for better than a banner above them would.
   */
  if (!signedIn) {
    return (
      <View style={styles.row}>
        {MARKS.map((mark) => (
          <Pressable
            key={mark.shape}
            onPress={() => router.push('/signin')}
            accessibilityRole="button"
            accessibilityLabel={`${mark.label} — sign in first`}
            style={({ pressed }) => [styles.button, pressed ? styles.buttonPressed : null]}
          >
            <Mark shape={mark.shape} color={theme.color.inkMuted} />
            <Text style={styles.buttonLabel}>{mark.label}</Text>
          </Pressable>
        ))}
      </View>
    );
  }

  const saved = state.data ?? EMPTY_SAVE_STATE;
  const customLists = (lists.data ?? []).filter((list) => list.kind === 'custom');
  const busy = toggle.isPending || record.isPending || forget.isPending;

  function markDone(): void {
    if (saved.completedCount === 0) {
      record.mutate({ trailId, completedAt: todayLocal() });
      return;
    }
    // More than one hike on the record is more than one thing to lose, so it asks.
    if (saved.completedCount > 1 && !confirmingForget) {
      setConfirmingForget(true);
      return;
    }
    forget.mutate({ trailId });
  }

  return (
    <View style={styles.block}>
      <View style={styles.row}>
        <MarkButton
          def={RING}
          pressed={saved.favorite}
          disabled={busy}
          onPress={() => toggle.mutate({ trailId, kind: 'favorites' })}
        />
        <MarkButton
          def={FLAG}
          pressed={saved.wantToDo}
          disabled={busy}
          onPress={() => toggle.mutate({ trailId, kind: 'want_to_do' })}
        />
        <MarkButton
          def={TICK}
          pressed={saved.completedCount > 0}
          disabled={busy}
          onPress={markDone}
        />

        <Pressable
          onPress={() => setShelfOpen((open) => !open)}
          accessibilityRole="button"
          accessibilityState={{ expanded: shelfOpen }}
          style={({ pressed }) => [
            styles.button,
            saved.listIds.length > 0 ? styles.buttonHeld : null,
            pressed ? styles.buttonPressed : null,
          ]}
        >
          <Text
            style={[styles.buttonLabel, saved.listIds.length > 0 ? styles.buttonLabelHeld : null]}
          >
            {saved.listIds.length > 0
              ? `In ${saved.listIds.length} ${plural(saved.listIds.length, 'list')}`
              : 'Add to a list'}
          </Text>
        </Pressable>
      </View>

      {/* ── The hike, once there is one ─────────────────────────────────────────────── */}
      {saved.completedCount > 0 ? (
        <View style={styles.hiked}>
          <Text style={styles.hikedLine}>
            {`Hiked ${saved.lastCompletedAt ? formatDateLabel(saved.lastCompletedAt) : 'once'}${
              saved.completedCount > 1 ? ` · ${saved.completedCount} times` : ''
            }`}
          </Text>
          {logging ? (
            <View style={styles.logRow}>
              {/*
               * Digits only, dashes inserted as they arrive — the same masked field the report
               * form uses, for the same reason: this app has no date picker dependency, and a
               * number pad with a mask makes the malformed string unreachable rather than
               * rejected after the fact.
               */}
              <TextInput
                value={logDate}
                onChangeText={(next) => setLogDate(maskDate(next))}
                keyboardType="number-pad"
                placeholder={todayLocal()}
                placeholderTextColor={theme.color.inkMuted}
                selectionColor={theme.color.inkMuted}
                accessibilityLabel="Another day you hiked this, as year, month and day"
                style={styles.date}
              />
              <Pressable
                onPress={() => record.mutate({ trailId, completedAt: logDate })}
                disabled={logDate.length < 10 || record.isPending}
                accessibilityRole="button"
                style={styles.quiet}
              >
                <Text style={[styles.quietLabel, logDate.length < 10 ? styles.quietOff : null]}>
                  {record.isPending ? 'Adding…' : 'Add'}
                </Text>
              </Pressable>
              <Pressable
                onPress={() => setLogging(false)}
                accessibilityRole="button"
                style={styles.quiet}
              >
                <Text style={styles.quietLabel}>Cancel</Text>
              </Pressable>
            </View>
          ) : (
            <Pressable
              onPress={() => setLogging(true)}
              accessibilityRole="button"
              style={styles.quiet}
            >
              <Text style={styles.quietLabel}>Log another day</Text>
            </Pressable>
          )}
        </View>
      ) : null}

      {confirmingForget ? (
        <View style={styles.forget}>
          <Text style={styles.prose}>
            {saved.completedCount > 1
              ? `Forget all ${saved.completedCount} hikes on this trail?`
              : 'Forget that you hiked this?'}
          </Text>
          <View style={styles.row}>
            <Pressable
              onPress={() => forget.mutate({ trailId })}
              disabled={forget.isPending}
              accessibilityRole="button"
              style={({ pressed }) => [styles.destroy, pressed ? styles.destroyPressed : null]}
            >
              <Text style={styles.destroyLabel}>
                {forget.isPending
                  ? 'Forgetting…'
                  : saved.completedCount > 1
                    ? 'Forget them'
                    : 'Forget it'}
              </Text>
            </Pressable>
            <Pressable
              onPress={() => setConfirmingForget(false)}
              accessibilityRole="button"
              style={styles.quiet}
            >
              <Text style={styles.quietLabel}>Keep them</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {/* ── The shelf ───────────────────────────────────────────────────────────────── */}
      {shelfOpen ? (
        <View style={styles.shelf}>
          <Text style={styles.collar}>Your lists</Text>

          {lists.isPending ? (
            <Text style={styles.prose}>Fetching…</Text>
          ) : customLists.length === 0 ? (
            <Text style={styles.prose}>
              Nothing beyond the three you start with. A list is for a set with a reason — winter
              scrambles, hikes the dog can do, everything within an hour of home.
            </Text>
          ) : (
            /*
             * Bounded and scrollable rather than allowed to grow. This block sits inside the
             * trail screen's own scroll view, and forty lists would push the section, the
             * weather and the reports off the end of a screen somebody opened to read them.
             */
            <ScrollView style={styles.shelfScroll} nestedScrollEnabled>
              {customLists.map((list) => {
                const inIt = saved.listIds.includes(list.id);
                return (
                  <Pressable
                    key={list.id}
                    onPress={() =>
                      inIt
                        ? removeTrail.mutate({ listId: list.id, trailId })
                        : addTrail.mutate({ listId: list.id, trailId })
                    }
                    disabled={addTrail.isPending || removeTrail.isPending}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: inIt }}
                    accessibilityLabel={`${list.name} — ${list.trailCount} ${plural(list.trailCount, 'trail')}`}
                    style={({ pressed }) => [
                      styles.listRow,
                      inIt ? styles.listRowIn : null,
                      pressed ? styles.buttonPressed : null,
                    ]}
                  >
                    {/*
                     * The tick is the mark, not a checkbox glyph — the same shape the row above
                     * uses for "done", because both answer "is it in".
                     */}
                    <View style={[styles.box, inIt ? styles.boxIn : null]}>
                      {inIt ? <Mark shape="tick" size={11} color={theme.color.canvas} /> : null}
                    </View>
                    <Text
                      style={[styles.listName, inIt ? styles.listNameIn : null]}
                      numberOfLines={1}
                    >
                      {list.name}
                    </Text>
                    <Text style={styles.listCount}>{list.trailCount}</Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          )}

          <View style={styles.newList}>
            <Text style={styles.collar}>New list</Text>
            <View style={styles.logRow}>
              <TextInput
                value={newListName}
                onChangeText={setNewListName}
                maxLength={LIST_NAME_MAX}
                placeholder="Winter scrambles"
                placeholderTextColor={theme.color.inkMuted}
                selectionColor={theme.color.inkMuted}
                accessibilityLabel="Name for a new list"
                returnKeyType="done"
                onSubmitEditing={() => {
                  if (!newListName.trim()) return;
                  createList.mutate({ name: newListName.trim(), isPublic: false });
                }}
                style={styles.input}
              />
              <Pressable
                onPress={() => createList.mutate({ name: newListName.trim(), isPublic: false })}
                disabled={!newListName.trim() || createList.isPending}
                accessibilityRole="button"
                style={({ pressed }) => [
                  styles.make,
                  !newListName.trim() ? styles.makeOff : null,
                  pressed ? styles.makePressed : null,
                ]}
              >
                <Text style={styles.makeLabel}>{createList.isPending ? 'Making…' : 'Make it'}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      ) : null}

      {error ? <Text style={styles.error}>{error.message}</Text> : null}
    </View>
  );
}

function MarkButton({
  def,
  pressed,
  disabled,
  onPress,
}: {
  def: MarkDef;
  pressed: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ selected: pressed, disabled }}
      accessibilityLabel={pressed ? def.pressedLabel : def.label}
      style={({ pressed: down }) => [
        styles.button,
        pressed ? styles.buttonOn : null,
        disabled ? styles.buttonDim : null,
        down && !pressed ? styles.buttonPressed : null,
      ]}
    >
      <Mark shape={def.shape} color={pressed ? theme.color.canvas : theme.color.inkMuted} />
      <Text style={[styles.buttonLabel, pressed ? styles.buttonLabelOn : null]}>{def.label}</Text>
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
  block: { gap: theme.space.sm },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: theme.space.sm },

  button: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.xs,
    minHeight: CONTROL_HEIGHT.touch,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.bezel,
    borderRadius: theme.radius.hair,
    paddingHorizontal: theme.space.md,
    backgroundColor: theme.color.surface,
  },
  buttonOn: { borderColor: theme.color.ink, backgroundColor: theme.color.ink },
  // Held, not pressed: being on a list is a fact about the trail, and filling this the way a
  // mark fills would claim the shelf is a fourth mark.
  buttonHeld: { borderColor: theme.color.inkMuted },
  buttonPressed: { borderColor: theme.color.ink },
  buttonDim: { opacity: 0.5 },
  buttonLabel: { ...theme.text('caption', { weight: 'medium' }), color: theme.color.inkMuted },
  buttonLabelOn: { color: theme.color.canvas },
  buttonLabelHeld: { color: theme.color.ink },

  hiked: { gap: theme.space.xs },
  hikedLine: { ...theme.text('micro', { family: 'mono' }), color: theme.color.inkMuted },
  logRow: { flexDirection: 'row', alignItems: 'center', gap: theme.space.sm },
  quiet: {
    minHeight: CONTROL_HEIGHT.touch,
    justifyContent: 'center',
    paddingVertical: theme.space.xs,
  },
  quietLabel: { ...theme.collarLabel, color: theme.color.ink },
  quietOff: { opacity: 0.4 },

  forget: { gap: theme.space.sm },
  prose: { ...theme.text('caption', { family: 'text' }), color: theme.color.inkMuted },
  destroy: {
    minHeight: CONTROL_HEIGHT.touch,
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.survey,
    borderRadius: theme.radius.hair,
    paddingHorizontal: theme.space.md,
  },
  destroyPressed: { opacity: 0.55 },
  destroyLabel: { ...theme.collarLabel, color: theme.color.survey },

  shelf: {
    gap: theme.space.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.bezel,
    borderRadius: theme.radius.hair,
    backgroundColor: theme.color.surface,
    padding: theme.space.md,
  },
  collar: { ...theme.collarLabel, color: theme.color.inkMuted },
  shelfScroll: { maxHeight: 208 },
  listRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.sm,
    minHeight: CONTROL_HEIGHT.touch,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.bezel,
    borderRadius: theme.radius.hair,
    paddingHorizontal: theme.space.sm,
    marginBottom: theme.space.xs,
  },
  listRowIn: { borderColor: theme.color.ink },
  box: {
    width: 18,
    height: 18,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.bezel,
    borderRadius: theme.radius.hair,
  },
  boxIn: { borderColor: theme.color.ink, backgroundColor: theme.color.ink },
  listName: { ...theme.text('caption', { family: 'text' }), color: theme.color.inkMuted, flex: 1 },
  listNameIn: { color: theme.color.ink },
  listCount: { ...theme.text('micro', { family: 'mono' }), color: theme.color.inkMuted },

  newList: {
    gap: theme.space.xs,
    paddingTop: theme.space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.color.bezel,
  },
  input: {
    ...theme.text('caption', { family: 'text' }),
    color: theme.color.ink,
    flex: 1,
    minHeight: CONTROL_HEIGHT.touch,
    backgroundColor: theme.color.canvas,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.bezel,
    borderRadius: theme.radius.hair,
    paddingHorizontal: theme.space.sm,
  },
  date: {
    ...theme.text('caption', { family: 'mono' }),
    color: theme.color.ink,
    width: 132,
    minHeight: CONTROL_HEIGHT.touch,
    backgroundColor: theme.color.canvas,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.bezel,
    borderRadius: theme.radius.hair,
    paddingHorizontal: theme.space.sm,
  },
  make: {
    minHeight: CONTROL_HEIGHT.touch,
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.ink,
    borderRadius: theme.radius.hair,
    paddingHorizontal: theme.space.md,
  },
  // Outline buttons dim on press rather than filling. A fill would have to carry the label
  // to canvas with it, and a label that stays ink inside an ink fill is an invisible button.
  makePressed: { opacity: 0.55 },
  makeOff: { opacity: 0.4 },
  makeLabel: { ...theme.collarLabel, color: theme.color.ink },

  error: { ...theme.text('caption', { family: 'text' }), color: theme.color.survey },
});
