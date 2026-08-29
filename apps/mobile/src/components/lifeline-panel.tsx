import { useCallback, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pressable, Share, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  LIFELINE_CONTACT_NAME_MAX,
  LIFELINE_MESSAGE_MAX,
  LIFELINE_PRESET_MINUTES,
  formatSpan,
  isStalePing,
} from '@switchback/core';
import { CONTROL_HEIGHT, nativeTheme } from '@switchback/ui';
import { askAgain } from '@/api/after-write';
import { useTRPC } from '@/api/trpc';
import { useAuth } from '@/auth/context';
import { apiBaseUrl } from '@/config';
import { useLifelinePings } from '@/record/lifeline';

/**
 * Lifeline, on the recorder.
 *
 * Leaving word: who is expecting you, when, and a link that shows where you got to. It sits
 * under the recorder's controls because that is where somebody is standing when they set off,
 * and it works whether or not they are recording anything — plenty of people want their
 * partner to see a dot without wanting a track on their record.
 *
 * The sending is done by the hiker, not by us. There is no mail transport in this product, so
 * a form that asked for a contact's email would be promising to tell somebody and then not
 * telling them. Instead: a name, so the panel can say whose link it is, and the system share
 * sheet, which reaches whichever app that person actually reads.
 *
 * **The panel draws; it does not ping.** Positions are sent by `@/record/lifeline`, a module
 * driven from the app root, because a loop living here would stop the moment somebody tapped
 * another tab — and a safety feature that quietly stops while still saying "Lifeline running"
 * is worse than no feature. This file only reports what that loop has managed.
 */

const theme = nativeTheme('field');

/**
 * Extension offers, in minutes from now.
 *
 * Shorter than the starting presets and starting shorter still. Somebody pushing a return time
 * back is usually on a hill, behind schedule, and wanting half an hour — not choosing a hike
 * length. Every button is labelled with the clock time it produces, so nobody has to do the
 * arithmetic in the wind.
 */
const EXTEND_MINUTES = [30, 60, 120, 240] as const;

export function LifelinePanel({
  activityId,
  trailId,
  trailName,
}: {
  activityId: string | null;
  trailId: string | null;
  trailName: string | null;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const pings = useLifelinePings();

  const { status } = useAuth();
  // Account-scoped: the active session belongs to a reader. Ungated it fires as nobody through
  // the reset that follows every identity change, and 401s.
  const active = useQuery({
    ...trpc.lifeline.active.queryOptions(),
    enabled: status === 'signedIn',
  });
  const session = active.data ?? null;

  const [open, setOpen] = useState(false);
  const [contactName, setContactName] = useState('');
  const [message, setMessage] = useState('');
  const [minutes, setMinutes] = useState<number>(LIFELINE_PRESET_MINUTES[1] ?? 240);
  const [callingOff, setCallingOff] = useState(false);

  /**
   * The clock this panel reasons against, moved on every half minute.
   *
   * Every relative figure here — time left, how old the last position is, what time each
   * extension button lands on — is a difference against now, and a `now` captured at mount
   * would be wrong within a minute of somebody looking at it. Thirty seconds rather than one:
   * the readings are all rounded to minutes anyway, and a countdown that ticks every second
   * turns leaving word into a stopwatch.
   */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(tick);
  }, []);

  const create = useMutation(trpc.lifeline.create.mutationOptions());
  const extend = useMutation(trpc.lifeline.extend.mutationOptions());
  const end = useMutation(trpc.lifeline.end.mutationOptions());

  /**
   * One invalidation covers the whole feature.
   *
   * The ping loop at the app root watches the same `lifeline.active` key, so refreshing it
   * here is also what starts and stops the loop. Neither piece has to know the other exists.
   */
  const refresh = useCallback(() => {
    void askAgain(queryClient, trpc.lifeline.pathFilter());
  }, [queryClient, trpc]);

  const onStart = useCallback(() => {
    create.mutate(
      {
        minutes,
        ...(activityId ? { activityId } : {}),
        ...(trailId ? { trailId } : {}),
        ...(contactName.trim() ? { contactName: contactName.trim() } : {}),
        ...(message.trim() ? { message: message.trim() } : {}),
      },
      {
        onSuccess: () => {
          setOpen(false);
          // The message described one hike; the name is the same person next time.
          setMessage('');
          refresh();
        },
      },
    );
  }, [activityId, contactName, create, message, minutes, refresh, trailId]);

  /**
   * Hand the link over.
   *
   * The system sheet rather than a copy button: it carries Messages, Mail, WhatsApp and the
   * clipboard in one control, and the hiker is the one who knows which of those the person
   * expecting them actually opens. A dismissed sheet rejects on iOS, which is not an error.
   */
  const onShare = useCallback(() => {
    if (!session) return;
    void Share.share({
      message: trailName
        ? `I'm hiking ${trailName}. This link shows where I am and when I said I would be back.`
        : 'I am out hiking. This link shows where I am and when I said I would be back.',
      url: `${apiBaseUrl()}/lifeline/${session.token}`,
    }).catch(() => undefined);
  }, [session, trailName]);

  // Nothing at all until we know — a panel that offers to start a Lifeline and then swaps
  // itself for a running one is a control that moves under a thumb already heading for it.
  if (active.isPending) return null;

  if (session) {
    const leftS = (session.expectedReturnAt.getTime() - now) / 1000;
    const overdue = leftS < 0;
    const lastPing = pings.lastPingAt ?? session.lastPingAt;
    const stale = isStalePing(lastPing, new Date(now));

    return (
      <View style={styles.panel}>
        <View style={styles.head}>
          <Text style={styles.collar}>Lifeline</Text>
          <Text style={[styles.left, overdue ? styles.alarm : null]}>
            {overdue ? `${formatSpan(-leftS)} overdue` : `${formatSpan(leftS)} left`}
          </Text>
        </View>

        <Text style={styles.prose}>
          {session.contactName ? `${session.contactName} can` : 'Anyone with the link can'} see
          where you are until {clock(session.expectedReturnAt)}.
        </Text>

        <Pressable
          onPress={onShare}
          accessibilityRole="button"
          style={({ pressed }) => [styles.ghost, pressed ? styles.ghostPressed : null]}
        >
          <Text style={styles.ghostLabel}>Send the link</Text>
        </Pressable>
        {/* Selectable, so the link is still reachable if the share sheet has nothing useful. */}
        <Text style={styles.url} selectable numberOfLines={1}>
          {apiBaseUrl()}/lifeline/{session.token}
        </Text>

        <Text style={[styles.note, stale ? styles.alarm : null]}>
          {lastPing
            ? `Position sent ${formatSpan((now - lastPing.getTime()) / 1000)} ago${
                stale ? ' — they are seeing an old one' : ''
              }`
            : 'No position sent yet.'}
        </Text>
        {/*
         * Why a position has not landed, in the muted plate. A ping that fails is a phone in a
         * valley, which is the ordinary state of a hike — the figure above is the honest alarm
         * and this is only the reason behind it.
         */}
        {pings.error ? <Text style={styles.note}>{pings.error}</Text> : null}

        <Text style={styles.collar}>Push it back to</Text>
        <View style={styles.chips}>
          {EXTEND_MINUTES.map((span) => (
            <Pressable
              key={span}
              onPress={() =>
                extend.mutate({ id: session.id, minutes: span }, { onSuccess: refresh })
              }
              disabled={extend.isPending}
              accessibilityRole="button"
              accessibilityLabel={`Back by ${clock(new Date(now + span * 60_000))}`}
              style={({ pressed }) => [styles.chip, pressed ? styles.chipPressed : null]}
            >
              <Text style={styles.chipLabel}>{clock(new Date(now + span * 60_000))}</Text>
            </Pressable>
          ))}
        </View>

        <Pressable
          onPress={() =>
            end.mutate({ id: session.id, outcome: 'completed' }, { onSuccess: refresh })
          }
          disabled={end.isPending}
          accessibilityRole="button"
          style={({ pressed }) => [styles.primary, pressed ? styles.primaryPressed : null]}
        >
          <Text style={styles.primaryLabel}>{end.isPending ? 'Closing…' : "I'm back"}</Text>
        </Pressable>

        {/*
         * Calling off is not the same as being back, and it confirms. "I'm back" tells the
         * follower a true thing; this one stops the link without saying anything happened, and
         * a mis-tap that silently ends somebody's Lifeline is the one mistake this panel must
         * not make easy. Survey, because it destroys the thing somebody is relying on.
         */}
        {callingOff ? (
          <View style={styles.confirm}>
            <Text style={styles.confirmProse}>
              The link stops working and {session.contactName ?? 'whoever has it'} is told nothing
              more.
            </Text>
            <View style={styles.confirmRow}>
              <Pressable
                onPress={() =>
                  end.mutate(
                    { id: session.id, outcome: 'cancelled' },
                    {
                      onSuccess: () => {
                        setCallingOff(false);
                        refresh();
                      },
                    },
                  )
                }
                accessibilityRole="button"
                style={({ pressed }) => [styles.destructive, pressed ? styles.chipPressed : null]}
              >
                <Text style={styles.destructiveLabel}>Call off</Text>
              </Pressable>
              <Pressable
                onPress={() => setCallingOff(false)}
                accessibilityRole="button"
                style={({ pressed }) => [styles.chip, pressed ? styles.chipPressed : null]}
              >
                <Text style={styles.chipLabel}>Keep it running</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <Pressable
            onPress={() => setCallingOff(true)}
            accessibilityRole="button"
            style={styles.quiet}
          >
            <Text style={styles.quietLabel}>Call it off instead</Text>
          </Pressable>
        )}

        {extend.isError ? <Text style={styles.problem}>{extend.error.message}</Text> : null}
        {end.isError ? <Text style={styles.problem}>{end.error.message}</Text> : null}
      </View>
    );
  }

  if (!open) {
    return (
      <View style={styles.panel}>
        <Text style={styles.collar}>Lifeline</Text>
        <Text style={styles.prose}>
          Send somebody a link that shows where you are and when you said you would be back.
        </Text>
        <Pressable
          onPress={() => setOpen(true)}
          accessibilityRole="button"
          style={({ pressed }) => [styles.ghost, pressed ? styles.ghostPressed : null]}
        >
          <Text style={styles.ghostLabel}>Tell somebody</Text>
        </Pressable>
      </View>
    );
  }

  const returnAt = new Date(now + minutes * 60_000);

  return (
    <View style={styles.panel}>
      <View style={styles.head}>
        <Text style={styles.collar}>Lifeline</Text>
        <Pressable onPress={() => setOpen(false)} accessibilityRole="button" style={styles.quiet}>
          <Text style={styles.quietLabel}>Not now</Text>
        </Pressable>
      </View>

      <Text style={styles.collar}>Who is expecting you</Text>
      <TextInput
        value={contactName}
        onChangeText={setContactName}
        placeholder="Mum, Dave, the shop"
        placeholderTextColor={theme.color.inkMuted}
        maxLength={LIFELINE_CONTACT_NAME_MAX}
        autoCapitalize="words"
        accessibilityLabel="Who is expecting you"
        style={styles.field}
      />

      <Text style={styles.collar}>Back by</Text>
      <View style={styles.chips}>
        {LIFELINE_PRESET_MINUTES.map((span) => {
          const chosen = span === minutes;
          return (
            <Pressable
              key={span}
              onPress={() => setMinutes(span)}
              accessibilityRole="radio"
              accessibilityState={{ selected: chosen }}
              accessibilityLabel={`Back by ${clock(new Date(now + span * 60_000))}`}
              style={[styles.chip, chosen ? styles.chipChosen : null]}
            >
              <Text style={[styles.chipLabel, chosen ? styles.chipLabelChosen : null]}>
                {clock(new Date(now + span * 60_000))}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <Text style={styles.note}>
        {formatSpan(minutes * 60)} from now — {stamp(returnAt)}
      </Text>

      <Text style={styles.collar}>Anything they should know</Text>
      <TextInput
        value={message}
        onChangeText={setMessage}
        placeholder="Up by the east ridge, down the same way. Blue jacket."
        placeholderTextColor={theme.color.inkMuted}
        maxLength={LIFELINE_MESSAGE_MAX}
        multiline
        accessibilityLabel="Anything they should know"
        style={[styles.field, styles.fieldTall]}
      />

      <Pressable
        onPress={onStart}
        disabled={create.isPending}
        accessibilityRole="button"
        style={({ pressed }) => [
          styles.primary,
          pressed ? styles.primaryPressed : null,
          create.isPending ? styles.primaryDisabled : null,
        ]}
      >
        <Text style={styles.primaryLabel}>{create.isPending ? 'Starting…' : 'Start Lifeline'}</Text>
      </Pressable>

      {create.isError ? <Text style={styles.problem}>{create.error.message}</Text> : null}

      {/*
       * What it does and does not do, before anybody relies on it. The last sentence is the
       * one that must never be softened: this is not a rescue service, and somebody who
       * believes it is may leave word with a person who has not been asked to watch a clock.
       */}
      <Text style={styles.caveat}>
        The link shows your last position and your return time, and stops showing anything the
        moment you finish this hike or tap “I&apos;m back”. Your position only goes up while
        Switchback is on screen — lock the phone and the last one sent stands until you come back.
        Nobody is alerted if you are late; the person you send it to is.
      </Text>
    </View>
  );
}

/** "14:20". The time somebody says out loud, in whatever format their phone is set to. */
function clock(at: Date): string {
  return at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/**
 * "Sat 18:30" — the day as well, because a preset can land tomorrow.
 *
 * Only used where the hiker is choosing a return time. Once one is running, the panel says
 * how long is left, which never needs a weekday.
 */
function stamp(at: Date): string {
  return at.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

const styles = StyleSheet.create({
  /**
   * A bounded plate rather than another stripe of the recorder.
   *
   * Everything above this on the Record screen is the instrument — clock, readings, the two
   * controls that run a hike. This is a different kind of thing: an arrangement with a person
   * who is not here. The hairline box says so without needing a heading to explain it.
   */
  panel: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.bezel,
    borderRadius: theme.radius.hair,
    padding: theme.space.lg,
    gap: theme.space.md,
  },

  head: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
  collar: { ...theme.collarLabel, color: theme.color.inkMuted },
  left: { ...theme.text('caption', { family: 'mono' }), color: theme.color.ink },
  alarm: { color: theme.color.survey },

  prose: { ...theme.text('body', { family: 'text' }), color: theme.color.ink },
  note: { ...theme.text('micro', { family: 'mono' }), color: theme.color.inkMuted },
  problem: { ...theme.text('caption', { family: 'text' }), color: theme.color.survey },
  caveat: { ...theme.text('micro', { family: 'text' }), color: theme.color.inkMuted },

  // Water: this is the link itself, and it is the one string here somebody may need to read
  // character by character off a screen to type into another device.
  url: { ...theme.text('micro', { family: 'mono' }), color: theme.color.water },

  field: {
    ...theme.text('body', { family: 'text' }),
    color: theme.color.ink,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.bezel,
    borderRadius: theme.radius.hair,
    backgroundColor: theme.color.surface,
    paddingHorizontal: theme.space.md,
    paddingVertical: theme.space.md,
  },
  fieldTall: { minHeight: 88, textAlignVertical: 'top' },

  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.sm },
  chip: {
    minHeight: CONTROL_HEIGHT.touch,
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.bezel,
    borderRadius: theme.radius.hair,
    paddingHorizontal: theme.space.md,
  },
  chipChosen: { borderColor: theme.color.ink, backgroundColor: theme.color.ink },
  chipPressed: { backgroundColor: theme.color.surface },
  chipLabel: { ...theme.text('caption', { family: 'mono' }), color: theme.color.inkMuted },
  chipLabelChosen: { color: theme.color.canvas },

  primary: {
    height: CONTROL_HEIGHT.field,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.color.ink,
    borderRadius: theme.radius.hair,
  },
  primaryPressed: { backgroundColor: theme.color.inkMuted },
  primaryDisabled: { backgroundColor: theme.color.bezel },
  primaryLabel: { ...theme.collarLabel, color: theme.color.canvas },

  ghost: {
    height: CONTROL_HEIGHT.field,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.ink,
    borderRadius: theme.radius.hair,
  },
  ghostPressed: { backgroundColor: theme.color.surface },
  ghostLabel: { ...theme.collarLabel, color: theme.color.ink },

  // No border and no plate: a way out of a decision, not a control competing with the one
  // above it. Still 44pt of target, because it is a real thing people tap.
  quiet: { minHeight: CONTROL_HEIGHT.touch, justifyContent: 'center' },
  quietLabel: { ...theme.text('caption', { family: 'text' }), color: theme.color.inkMuted },

  confirm: {
    gap: theme.space.sm,
    borderLeftWidth: 2,
    borderLeftColor: theme.color.survey,
    paddingLeft: theme.space.md,
  },
  confirmProse: { ...theme.text('caption', { family: 'text' }), color: theme.color.ink },
  confirmRow: { flexDirection: 'row', gap: theme.space.sm },
  destructive: {
    minHeight: CONTROL_HEIGHT.touch,
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.survey,
    borderRadius: theme.radius.hair,
    paddingHorizontal: theme.space.md,
  },
  destructiveLabel: { ...theme.collarLabel, color: theme.color.survey },
});
