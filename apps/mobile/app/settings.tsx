import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Constants from 'expo-constants';
import { Stack, router } from 'expo-router';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { SelfProfile, UnitSystem, Visibility } from '@switchback/core';
import { BRAND, UNIT_SYSTEMS, VISIBILITIES, plural, usernameSchema } from '@switchback/core';
import { CONTROL_HEIGHT, nativeTheme } from '@switchback/ui';
import { askAgain } from '@/api/after-write';
import { useTRPC } from '@/api/trpc';
import { useAuth } from '@/auth/context';

/**
 * Settings, laid out as the margin block of a map sheet: each section prints its current value
 * beside its own heading, so the whole configuration reads on one scroll. Units come first
 * because the phone is the instrument. Each section commits on its own, never as you type.
 */

const theme = nativeTheme('sheet');

const UNIT_LABEL: Record<UnitSystem, string> = {
  metric: 'Kilometres and metres',
  imperial: 'Miles and feet',
};

/** The same figure again, short enough to sit in a heading. */
const UNIT_READING: Record<UnitSystem, string> = {
  metric: 'km · m · °C',
  imperial: 'mi · ft · °F',
};

const VISIBILITY_LABEL: Record<Visibility, string> = {
  private: 'Only me',
  followers: 'People who follow me',
  public: 'Anyone',
};

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const trpc = useTRPC();
  const { status } = useAuth();

  const signedIn = status === 'signedIn';
  const me = useQuery({ ...trpc.me.get.queryOptions(), enabled: signedIn });

  if (status === 'loading' || (signedIn && me.isPending)) {
    return (
      <Chrome insets={insets}>
        <ActivityIndicator color={theme.color.inkMuted} style={styles.pending} />
      </Chrome>
    );
  }

  if (!signedIn) {
    return (
      <Chrome insets={insets}>
        <View style={styles.head}>
          <Text style={styles.title}>Settings</Text>
        </View>
        <Text style={styles.prose}>
          Units, your name and who sees your hikes are kept with your account, so they follow you to
          every device you sign in on. Sign in to change them.
        </Text>
        <Pressable
          onPress={() => router.push('/signin')}
          accessibilityRole="button"
          style={({ pressed }) => [styles.action, pressed ? styles.actionDim : null]}
        >
          <Text style={styles.actionLabel}>Sign in</Text>
        </Pressable>
      </Chrome>
    );
  }

  if (me.isError || !me.data) {
    return (
      <Chrome insets={insets}>
        <View style={styles.head}>
          <Text style={styles.title}>Settings</Text>
        </View>
        <Text style={styles.prose}>{me.error?.message ?? 'The server did not answer.'}</Text>
        <Pressable
          onPress={() => void me.refetch()}
          accessibilityRole="button"
          style={({ pressed }) => [styles.action, pressed ? styles.actionDim : null]}
        >
          <Text style={styles.actionLabel}>Try again</Text>
        </Pressable>
      </Chrome>
    );
  }

  const profile = me.data;

  return (
    <Chrome insets={insets}>
      <View style={styles.head}>
        {profile.email ? (
          <Text style={styles.collar} numberOfLines={1}>
            {profile.email}
          </Text>
        ) : null}
        <Text style={styles.title}>Settings</Text>
      </View>

      <Reading me={profile} />
      <Sharing me={profile} />
      <Identity me={profile} />
      <Home me={profile} />
      <Devices />
    </Chrome>
  );
}

/**
 * The declaration every other number on the phone is drawn against. The tapped option goes
 * selected immediately — the mutation's own variables are the truth while it is in flight, and
 * a control that stays on the old answer for 300 ms gets pressed again.
 */
function Reading({ me }: { me: SelfProfile }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const update = useMutation(
    trpc.me.update.mutationOptions({
      onSuccess: () => void askAgain(queryClient, trpc.me.pathFilter()),
    }),
  );

  const units = (update.isPending ? update.variables.units : undefined) ?? me.units;

  return (
    <Section
      title="How it reads"
      reading={UNIT_READING[units]}
      note="Distances, heights and temperatures everywhere in the app and on the website."
    >
      <Choice
        options={UNIT_SYSTEMS.map((system) => ({ value: system, label: UNIT_LABEL[system] }))}
        value={units}
        onChoose={(next) => update.mutate({ units: next })}
        pending={update.isPending}
      />
      {update.isError ? <Text style={styles.error}>{update.error.message}</Text> : null}
    </Section>
  );
}

function Sharing({ me }: { me: SelfProfile }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const update = useMutation(
    trpc.me.update.mutationOptions({
      onSuccess: () => void askAgain(queryClient, trpc.me.pathFilter()),
    }),
  );

  const visibility =
    (update.isPending ? update.variables.defaultActivityVisibility : undefined) ??
    me.defaultActivityVisibility;

  return (
    <Section
      title="Who sees a hike you record"
      reading={VISIBILITY_LABEL[visibility].toLowerCase()}
      note="The setting new recordings start with. Each hike can still be changed on its own afterwards."
    >
      <Choice
        options={VISIBILITIES.map((value) => ({ value, label: VISIBILITY_LABEL[value] }))}
        value={visibility}
        onChoose={(next) => update.mutate({ defaultActivityVisibility: next })}
        pending={update.isPending}
      />
      {update.isError ? <Text style={styles.error}>{update.error.message}</Text> : null}
    </Section>
  );
}

/**
 * Name, handle and bio — the three that are published. State is seeded from the props at mount
 * and never re-seeded: another section invalidating the profile query must not overwrite what
 * somebody is halfway through typing.
 */
function Identity({ me }: { me: SelfProfile }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const [name, setName] = useState(me.name ?? '');
  const [username, setUsername] = useState(me.username ?? '');
  const [bio, setBio] = useState(me.bio ?? '');

  const update = useMutation(
    trpc.me.update.mutationOptions({
      onSuccess: () => void askAgain(queryClient, trpc.me.pathFilter()),
    }),
  );

  const trimmed = username.trim();
  const parsed = usernameSchema.safeParse(trimmed);
  const changed = trimmed !== (me.username ?? '');

  // Debounced: this is a query per keystroke against a unique index.
  const settled = useDebounced(trimmed, 250);

  const availability = useQuery({
    ...trpc.me.usernameAvailable.queryOptions({ username: settled }),
    enabled: changed && parsed.success && settled === trimmed,
    staleTime: 30_000,
  });

  const dirty = name.trim() !== (me.name ?? '') || changed || bio.trim() !== (me.bio ?? '');

  const problem =
    changed && trimmed.length > 0 && !parsed.success
      ? (parsed.error.issues[0]?.message ?? 'Not a usable handle.')
      : changed && availability.data?.available === false
        ? availability.data.reason === 'reserved'
          ? 'That one is spoken for by the app itself.'
          : 'Somebody already has that one.'
        : null;

  const blocked = problem !== null || (changed && parsed.success && availability.isLoading);

  function save(): void {
    if (!dirty || blocked) return;
    update.mutate({
      name: name.trim() || null,
      // An empty box means "leave it alone", not "release my handle": a username is a URL
      // other people hold, and backspacing it would break every link without saying so.
      ...(changed && trimmed ? { username: trimmed } : {}),
      bio: bio.trim() || null,
    });
  }

  return (
    <Section
      title="Who you are"
      reading={me.username ? `@${me.username}` : 'no handle'}
      note="Your name and anything you write here appear on your profile and on every trail report you file."
    >
      <Field label="Name">
        <TextInput
          value={name}
          onChangeText={setName}
          maxLength={80}
          placeholder="Unnamed hiker"
          placeholderTextColor={theme.color.inkMuted}
          selectionColor={theme.color.inkMuted}
          accessibilityLabel="Your name"
          style={styles.input}
        />
      </Field>

      <Field
        label="Username"
        hint={trimmed ? `${BRAND.domain}/u/${trimmed}` : 'gives you a public address'}
      >
        {/*
         * Lowercased as it is typed, not on submit: the schema only takes lowercase and the
         * keyboard capitalises the first letter, so correcting it silently at save is worse.
         */}
        <TextInput
          value={username}
          onChangeText={(next) => setUsername(next.toLowerCase().replace(/\s+/gu, ''))}
          maxLength={30}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          placeholder="coldbeck"
          placeholderTextColor={theme.color.inkMuted}
          selectionColor={theme.color.inkMuted}
          accessibilityLabel="Your username"
          style={[styles.input, styles.mono]}
        />
        {problem !== null ? (
          <Text style={styles.error}>{problem}</Text>
        ) : changed && availability.data?.available ? (
          <Text style={styles.free}>Free. It is yours when you save.</Text>
        ) : null}
      </Field>

      <Field label="About you" hint={`${bio.trim().length}/500`}>
        <TextInput
          value={bio}
          onChangeText={setBio}
          maxLength={500}
          multiline
          placeholder="Two sentences is plenty. Where you hike, and what you hike in."
          placeholderTextColor={theme.color.inkMuted}
          selectionColor={theme.color.inkMuted}
          accessibilityLabel="About you"
          style={[styles.input, styles.multiline]}
        />
      </Field>

      <View style={styles.saveRow}>
        <Pressable
          onPress={save}
          disabled={!dirty || blocked || update.isPending}
          accessibilityRole="button"
          accessibilityState={{ disabled: !dirty || blocked || update.isPending }}
          style={({ pressed }) => [
            styles.save,
            !dirty || blocked || update.isPending ? styles.saveOff : null,
            pressed ? styles.savePressed : null,
          ]}
        >
          <Text style={styles.saveLabel}>{update.isPending ? 'Saving…' : 'Save'}</Text>
        </Pressable>
        <Text style={styles.hint}>
          {update.isError
            ? ''
            : update.isSuccess && !dirty
              ? 'Saved.'
              : dirty
                ? 'Unsaved changes.'
                : ''}
        </Text>
      </View>
      {update.isError ? <Text style={styles.error}>{update.error.message}</Text> : null}
    </Section>
  );
}

/**
 * Home, searched by name rather than taken from the GPS: settings get filled in at the kitchen
 * table, and "near me" is meant to point at the hills somebody drives to.
 */
function Home({ me }: { me: SelfProfile }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const [query, setQuery] = useState('');
  const settled = useDebounced(query.trim(), 300);

  const update = useMutation(
    trpc.me.update.mutationOptions({
      onSuccess: () => {
        setQuery('');
        void askAgain(queryClient, trpc.me.pathFilter());
      },
    }),
  );

  // The gazetteer allows about one request a second and is shared, so this waits for a pause.
  const results = useQuery({
    ...trpc.places.search.queryOptions({ q: settled, limit: 5 }),
    enabled: settled.length >= 2,
    staleTime: 5 * 60_000,
  });

  const places = results.data?.places ?? [];

  return (
    <Section
      title="Where you start from"
      reading={me.home?.name ?? 'not set'}
      note="Where the map opens, and what “near me” means before you let the app read your location."
    >
      <Field label="Search for a town, park or valley">
        <TextInput
          value={query}
          onChangeText={setQuery}
          maxLength={120}
          autoCorrect={false}
          placeholder="Bethesda, Gwynedd"
          placeholderTextColor={theme.color.inkMuted}
          selectionColor={theme.color.inkMuted}
          accessibilityLabel="Search for somewhere to set as home"
          style={styles.input}
        />
      </Field>

      {places.length > 0 ? (
        <View style={styles.results}>
          {places.map((place) => (
            <Pressable
              key={place.id}
              onPress={() =>
                update.mutate({ home: { at: [place.lng, place.lat], name: place.name } })
              }
              disabled={update.isPending}
              accessibilityRole="button"
              accessibilityLabel={`Set home to ${place.name}, ${place.context}`}
              style={({ pressed }) => [styles.result, pressed ? styles.resultPressed : null]}
            >
              <View style={styles.resultText}>
                <Text style={styles.resultName} numberOfLines={1}>
                  {place.name}
                </Text>
                <Text style={styles.resultContext} numberOfLines={1}>
                  {place.context}
                </Text>
              </View>
              <Text style={styles.resultKind}>{place.label}</Text>
            </Pressable>
          ))}
        </View>
      ) : results.data?.unavailable ? (
        <Text style={styles.hint}>
          The place index is not answering. Trail search is unaffected — try again shortly.
        </Text>
      ) : settled.length >= 2 && !results.isFetching ? (
        <Text style={styles.hint}>Nothing by that name.</Text>
      ) : null}

      {me.home ? (
        <Pressable
          onPress={() => update.mutate({ home: null })}
          disabled={update.isPending}
          accessibilityRole="button"
          accessibilityLabel={`Clear ${me.home.name ?? 'your home'}`}
          style={({ pressed }) => [styles.action, pressed ? styles.actionDim : null]}
        >
          <Text style={styles.actionLabel}>Clear it</Text>
        </Pressable>
      ) : null}

      {update.isError ? <Text style={styles.error}>{update.error.message}</Text> : null}
    </Section>
  );
}

/**
 * Everything holding a credential, including the phone reading this.
 *
 * The list is `me.devices` — refresh tokens, so phones and tablets. The button is
 * `me.signOutEverywhere`, which is wider: it also deletes browser sessions and stamps the
 * account so live access tokens stop being accepted. Describe the two separately, or the sheet
 * takes down a signed-in laptop unannounced. The count is of phones, because the list is; a
 * number for browsers would be invented.
 */
function Devices() {
  const trpc = useTRPC();
  const { signOut } = useAuth();
  const devices = useQuery(trpc.me.devices.queryOptions());
  const [confirming, setConfirming] = useState(false);

  const revoke = useMutation(
    trpc.me.signOutEverywhere.mutationOptions({
      onSuccess: () => {
        // This phone's own refresh token is one of the ones just revoked, so the local copy has
        // to go now — otherwise the app renders a signed-in account for another fifteen minutes.
        void signOut().then(() => router.replace('/you'));
      },
    }),
  );

  const list = devices.data ?? [];

  // Which row is this phone, claimed only when exactly one device reports this name — two
  // phones called "iPhone" are common enough that a guess would be a label that lies.
  const here = typeof Constants.deviceName === 'string' ? Constants.deviceName : null;
  const named = here === null ? [] : list.filter((device) => device.deviceName === here);
  const hereId = named.length === 1 ? (named[0]?.id ?? null) : null;

  return (
    <Section
      title="Signed in on"
      reading={devices.isPending ? '—' : `${list.length} ${plural(list.length, 'device')}`}
      note="Phones and tablets holding a long-lived credential for this account."
    >
      {list.length === 0 ? (
        <Text style={styles.prose}>{devices.isPending ? 'Checking…' : 'No apps signed in.'}</Text>
      ) : (
        <View style={styles.devices}>
          {list.map((device) => (
            <View key={device.id} style={styles.device}>
              <Text style={styles.deviceName} numberOfLines={1}>
                {device.deviceName ?? 'An unnamed device'}
                {device.id === hereId ? ' · this phone' : ''}
              </Text>
              <Text style={styles.deviceSince}>since {stamp(device.createdAt)}</Text>
            </View>
          ))}
        </View>
      )}

      {confirming ? (
        <View style={styles.danger}>
          <Text style={styles.dangerProse}>
            {list.length === 1
              ? 'This phone signs out, and so does any browser signed in to this account.'
              : list.length > 1
                ? `All ${list.length} phones sign out, this one included, and so does any browser signed in to this account.`
                : 'Any browser signed in to this account signs out, and this phone with it.'}{' '}
            Anything recorded but not yet uploaded stays on the device it was recorded on.
          </Text>
          <View style={styles.dangerActions}>
            <Pressable
              onPress={() => revoke.mutate()}
              disabled={revoke.isPending}
              accessibilityRole="button"
              style={({ pressed }) => [styles.destructive, pressed ? styles.actionDim : null]}
            >
              <Text style={styles.destructiveLabel}>
                {revoke.isPending ? 'Signing out…' : 'Sign out everywhere'}
              </Text>
            </Pressable>
            <Pressable
              onPress={() => setConfirming(false)}
              disabled={revoke.isPending}
              accessibilityRole="button"
              style={styles.quiet}
            >
              <Text style={styles.quietLabel}>Stay signed in</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        /*
         * Offered even with an empty list: the button revokes browsers and live access tokens
         * too, so gating it on "a phone is signed in" would hide the compromise control from
         * exactly the reader whose browser was taken.
         */
        <Pressable
          onPress={() => setConfirming(true)}
          accessibilityRole="button"
          style={styles.quiet}
        >
          <Text style={styles.quietLabel}>Sign out everywhere</Text>
        </Pressable>
      )}

      {revoke.isError ? <Text style={styles.error}>{revoke.error.message}</Text> : null}
    </Section>
  );
}

/** The scroll container and the way back, shared by every state this screen has. */
function Chrome({
  insets,
  children,
}: {
  insets: { top: number; bottom: number };
  children: React.ReactNode;
}) {
  return (
    <>
      {/* Overrides the root's dark canvas, or the push transition flashes field over sheet. */}
      <Stack.Screen options={{ contentStyle: { backgroundColor: theme.color.canvas } }} />
      <ScrollView
        style={styles.screen}
        contentContainerStyle={[
          styles.content,
          {
            paddingTop: insets.top + theme.space.md,
            paddingBottom: insets.bottom + theme.space['4xl'],
          },
        ]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        automaticallyAdjustKeyboardInsets
      >
        <Pressable
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/you'))}
          accessibilityRole="button"
          accessibilityLabel="Back to your record"
          hitSlop={theme.space.md}
          style={styles.back}
        >
          <Text style={styles.backLabel}>← Your record</Text>
        </Pressable>
        {children}

        {/*
         * Outside `children`, so it is on the screen in all four states including signed out:
         * attribution is a condition of the map licences and does not wait for an account.
         */}
        <Pressable
          onPress={() => router.push('/attribution')}
          accessibilityRole="button"
          accessibilityLabel="Sources and licences"
          style={({ pressed }) => [styles.sources, pressed ? styles.actionDim : null]}
        >
          <Text style={styles.collar}>Where the map comes from</Text>
          <Text style={styles.sectionReading}>ODbL · CC BY →</Text>
        </Pressable>
      </ScrollView>
    </>
  );
}

/**
 * One margin block: what it declares, what it currently reads, and why it matters. The reading
 * sits on the heading line so the screen scans as a specification.
 */
function Section({
  title,
  reading,
  note,
  children,
}: {
  title: string;
  reading: string;
  note: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHead}>
        <Text style={styles.collar}>{title}</Text>
        <Text style={styles.sectionReading} numberOfLines={1}>
          {reading}
        </Text>
      </View>
      <Text style={styles.note}>{note}</Text>
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.field}>
      <View style={styles.fieldHead}>
        <Text style={styles.fieldLabel}>{label}</Text>
        {hint === undefined ? null : (
          <Text style={styles.fieldHint} numberOfLines={1}>
            {hint}
          </Text>
        )}
      </View>
      {children}
    </View>
  );
}

/**
 * Mutually exclusive answers, stacked rather than in a row: three sentence-length options at a
 * 44pt tap target do not fit across a phone, and a row that wraps reads as a second question.
 */
function Choice<T extends string>({
  options,
  value,
  onChoose,
  pending,
}: {
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChoose: (value: T) => void;
  pending: boolean;
}) {
  return (
    <View style={styles.choice}>
      {options.map((option) => {
        const on = option.value === value;
        return (
          <Pressable
            key={option.value}
            onPress={() => onChoose(option.value)}
            disabled={pending || on}
            accessibilityRole="radio"
            accessibilityState={{ selected: on, disabled: pending }}
            style={({ pressed }) => [
              styles.option,
              on ? styles.optionOn : null,
              pressed && !on ? styles.optionPressed : null,
            ]}
          >
            <Text style={[styles.optionLabel, on ? styles.optionLabelOn : null]}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * A value that settles. Both live lookups on this screen reach something rate-limited — a
 * unique index and a shared public gazetteer.
 */
function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);

  return settled;
}

/** "24 Jul 2026". Long enough to recognise a sign-in from two seasons ago. */
function stamp(at: Date): string {
  return at.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.color.canvas },
  content: { paddingHorizontal: theme.space.xl, gap: theme.space.lg },

  back: { alignSelf: 'flex-start', paddingVertical: theme.space.xs },
  backLabel: { ...theme.collarLabel, color: theme.color.inkMuted },

  pending: { marginTop: theme.space['4xl'] },
  head: { gap: theme.space.xs },
  collar: { ...theme.collarLabel, color: theme.color.inkMuted },
  title: { ...theme.text('h3', { weight: 'bold' }), color: theme.color.ink },
  prose: { ...theme.text('body', { family: 'text' }), color: theme.color.inkMuted },
  note: { ...theme.text('caption', { family: 'text' }), color: theme.color.inkMuted },
  hint: { ...theme.text('caption', { family: 'text' }), color: theme.color.inkMuted },
  error: { ...theme.text('caption', { family: 'text' }), color: theme.color.survey },
  free: { ...theme.text('caption', { family: 'text' }), color: theme.color.woodland },

  section: {
    gap: theme.space.xs,
    marginTop: theme.space.lg,
    paddingTop: theme.space.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.color.bezel,
  },
  sectionHead: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: theme.space.md,
  },
  // The current value, in the face every other instrument reading on the phone is set in.
  sectionReading: {
    ...theme.text('caption', { family: 'mono' }),
    color: theme.color.ink,
    flexShrink: 1,
    textAlign: 'right',
  },
  sectionBody: { gap: theme.space.md, marginTop: theme.space.md },

  // The licence declaration, set as a margin block with no body — there is nothing to set
  // here, only somewhere to go.
  sources: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: theme.space.md,
    minHeight: CONTROL_HEIGHT.touch,
    marginTop: theme.space.lg,
    paddingTop: theme.space.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.color.bezel,
  },

  choice: { gap: theme.space.xs },
  option: {
    minHeight: CONTROL_HEIGHT.touch,
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.bezel,
    borderRadius: theme.radius.hair,
    backgroundColor: theme.color.surface,
    paddingHorizontal: theme.space.lg,
  },
  optionOn: { borderColor: theme.color.ink, backgroundColor: theme.color.ink },
  // Border only. Filling on press would have to carry the label to canvas with it, and a
  // label that stays ink inside an ink fill is an invisible button.
  optionPressed: { borderColor: theme.color.ink },
  optionLabel: { ...theme.text('body'), color: theme.color.inkMuted },
  optionLabelOn: { color: theme.color.canvas },

  field: { gap: theme.space.xs },
  fieldHead: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: theme.space.md,
  },
  fieldLabel: { ...theme.collarLabel, color: theme.color.inkMuted },
  fieldHint: {
    ...theme.text('micro', { family: 'mono' }),
    color: theme.color.inkMuted,
    flexShrink: 1,
  },
  input: {
    ...theme.text('body', { family: 'text' }),
    color: theme.color.ink,
    backgroundColor: theme.color.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.bezel,
    borderRadius: theme.radius.hair,
    paddingHorizontal: theme.space.md,
    paddingVertical: theme.space.sm,
    minHeight: CONTROL_HEIGHT.touch,
  },
  mono: { ...theme.text('body', { family: 'mono' }) },
  multiline: { minHeight: 108, textAlignVertical: 'top' },

  saveRow: { flexDirection: 'row', alignItems: 'center', gap: theme.space.md },
  save: {
    minHeight: CONTROL_HEIGHT.touch,
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.ink,
    borderRadius: theme.radius.hair,
    backgroundColor: theme.color.ink,
    paddingHorizontal: theme.space.xl,
  },
  savePressed: { opacity: 0.8 },
  saveOff: { opacity: 0.4 },
  saveLabel: { ...theme.collarLabel, color: theme.color.canvas },

  action: {
    alignSelf: 'flex-start',
    minHeight: CONTROL_HEIGHT.touch,
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.ink,
    borderRadius: theme.radius.hair,
    paddingHorizontal: theme.space.lg,
  },
  actionDim: { opacity: 0.55 },
  actionLabel: { ...theme.collarLabel, color: theme.color.ink },

  quiet: { minHeight: CONTROL_HEIGHT.touch, justifyContent: 'center', alignSelf: 'flex-start' },
  quietLabel: { ...theme.text('caption', { family: 'text' }), color: theme.color.inkMuted },

  results: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.color.bezel },
  result: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.md,
    minHeight: CONTROL_HEIGHT.touch,
    paddingVertical: theme.space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.color.bezel,
  },
  resultPressed: { backgroundColor: theme.color.surface },
  resultText: { flex: 1, gap: theme.space.hair },
  resultName: { ...theme.text('body'), color: theme.color.ink },
  // Italic serif, the product's hydrography treatment for a place's setting.
  resultContext: {
    ...theme.text('caption', { family: 'text', weight: 'italic' }),
    color: theme.color.inkMuted,
  },
  resultKind: { ...theme.collarLabel, color: theme.color.inkMuted },

  devices: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.color.bezel },
  device: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: theme.space.md,
    paddingVertical: theme.space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.color.bezel,
  },
  deviceName: { ...theme.text('body'), color: theme.color.ink, flex: 1 },
  deviceSince: { ...theme.text('micro', { family: 'mono' }), color: theme.color.inkMuted },

  danger: {
    gap: theme.space.sm,
    borderLeftWidth: 2,
    borderLeftColor: theme.color.survey,
    paddingLeft: theme.space.md,
  },
  dangerProse: { ...theme.text('caption', { family: 'text' }), color: theme.color.ink },
  dangerActions: { flexDirection: 'row', alignItems: 'center', gap: theme.space.sm },
  destructive: {
    minHeight: CONTROL_HEIGHT.touch,
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.survey,
    borderRadius: theme.radius.hair,
    paddingHorizontal: theme.space.lg,
  },
  destructiveLabel: { ...theme.collarLabel, color: theme.color.survey },
});
