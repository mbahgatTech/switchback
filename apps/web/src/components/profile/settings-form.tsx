'use client';

import { useEffect, useId, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { SelfProfile, ThemePreference, UnitSystem, Visibility } from '@switchback/core';
import { THEME_PREFERENCES, UNIT_SYSTEMS, VISIBILITIES, usernameSchema } from '@switchback/core';
import { rememberTheme } from '../../lib/theme-action';
import { useTRPC } from '../../trpc/react';
import { BUTTON_COLLAR, DANGER, HEIGHT, PRIMARY } from '../controls';

/**
 * Settings.
 *
 * Three questions in the order somebody actually asks them: who you are, how you want the
 * numbers written, and where "near me" points before you grant location permission. Each
 * section commits on its own, because they are unrelated decisions — one Save at the bottom
 * of a page like this makes changing your units feel like it might also publish your bio.
 *
 * Nothing here saves as you type. A profile is public, and a field that writes on every
 * keystroke publishes every draft of a sentence you were still working out.
 */

const UNIT_LABEL: Record<UnitSystem, string> = {
  metric: 'Kilometres and metres',
  imperial: 'Miles and feet',
};

const VISIBILITY_LABEL: Record<Visibility, string> = {
  private: 'Only me',
  followers: 'People who follow me',
  public: 'Anyone',
};

/**
 * "Follow the device" rather than "System" or "Auto".
 *
 * This is the default every account starts on, so it is the one label that has to explain
 * itself — a reader who has never touched this setting should be able to read the selected
 * option and understand why the site went dark at sunset. The collar control has room for
 * one word and says "Auto"; here there is room for the sentence, so it says it.
 */
const THEME_LABEL: Record<ThemePreference, string> = {
  system: 'Follow the device',
  light: 'Light',
  dark: 'Dark',
};

/** Pressed and unpressed, in the vocabulary the rest of the product uses for both. */
const PRESSED = 'border-ink bg-ink text-canvas';
const UNPRESSED = 'border-bezel text-ink-muted hover:border-ink-muted hover:text-ink';

export function SettingsForm({ me }: { me: SelfProfile }) {
  return (
    <div className="mt-xl flex flex-col gap-3xl">
      <Identity me={me} />
      <Preferences me={me} />
      <Home me={me} />
      <Devices />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Who you are
// ---------------------------------------------------------------------------

function Identity({ me }: { me: SelfProfile }) {
  const trpc = useTRPC();
  const router = useRouter();

  const [name, setName] = useState(me.name ?? '');
  const [username, setUsername] = useState(me.username ?? '');
  const [bio, setBio] = useState(me.bio ?? '');
  const nameId = useId();
  const usernameId = useId();
  const bioId = useId();

  const update = useMutation(
    trpc.me.update.mutationOptions({
      // The header, the nav and `/u/<name>` are all server-rendered from this row, so a
      // refresh is the update — re-rendering only this form would leave the page disagreeing
      // with itself about who you are.
      onSuccess: () => router.refresh(),
    }),
  );

  const trimmed = username.trim().toLowerCase();
  const parsed = usernameSchema.safeParse(trimmed);
  const changed = trimmed !== (me.username ?? '');

  // Typing a handle is a query per keystroke against a unique index. A quarter second is
  // long enough to catch the pause after a word and short enough that the answer is there
  // before the finger leaves the key.
  const debounced = useDebounced(trimmed, 250);

  const availability = useQuery(
    trpc.me.usernameAvailable.queryOptions(
      { username: debounced },
      { enabled: changed && parsed.success && debounced === trimmed, staleTime: 30_000 },
    ),
  );

  const dirty = name.trim() !== (me.name ?? '') || changed || bio.trim() !== (me.bio ?? '');

  const usernameProblem =
    changed && trimmed.length > 0 && !parsed.success
      ? (parsed.error.issues[0]?.message ?? 'Not a usable handle.')
      : changed && availability.data?.available === false
        ? availability.data.reason === 'reserved'
          ? 'That one is spoken for by the site itself.'
          : 'Somebody already has that one.'
        : null;

  const blocked = usernameProblem !== null || (changed && parsed.success && availability.isLoading);

  return (
    <Section
      title="Who you are"
      note="Your name and anything you write here appear on your profile and on every trail report you post."
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!dirty || blocked) return;
          update.mutate({
            name: name.trim() || null,
            // An empty box means "leave it alone", not "release my handle" — a username is
            // a URL other people have, and clearing it by backspacing would break every
            // link to you without ever saying so.
            ...(changed && trimmed ? { username: trimmed } : {}),
            bio: bio.trim() || null,
          });
        }}
        className="flex max-w-[520px] flex-col gap-lg"
      >
        <Field id={nameId} label="Name">
          <input
            id={nameId}
            value={name}
            maxLength={80}
            placeholder="Unnamed hiker"
            onChange={(event) => setName(event.target.value)}
            className="field"
          />
        </Field>

        <Field
          id={usernameId}
          label="Username"
          hint={
            trimmed
              ? `switchback.app/u/${trimmed}`
              : 'Choose one and your profile gets a public address.'
          }
        >
          <input
            id={usernameId}
            value={username}
            maxLength={30}
            spellCheck={false}
            autoCapitalize="none"
            placeholder="coldbeck"
            onChange={(event) => setUsername(event.target.value)}
            aria-invalid={usernameProblem !== null}
            aria-describedby={`${usernameId}-status`}
            className="field"
          />
          <p id={`${usernameId}-status`} role="status" className="mt-xs text-micro">
            {usernameProblem ? (
              <span className="text-survey">{usernameProblem}</span>
            ) : changed && availability.data?.available ? (
              <span className="text-woodland">Free. It is yours when you save.</span>
            ) : (
              <span className="sr-only">No problems.</span>
            )}
          </p>
        </Field>

        <Field id={bioId} label="About you" hint={`${bio.trim().length}/500`}>
          <textarea
            id={bioId}
            value={bio}
            rows={3}
            maxLength={500}
            placeholder="Two sentences is plenty. Where you hike, and what you hike in."
            onChange={(event) => setBio(event.target.value)}
            className="field resize-y"
          />
        </Field>

        <Save
          dirty={dirty}
          blocked={blocked}
          pending={update.isPending}
          saved={update.isSuccess && !dirty}
          error={update.error?.message ?? null}
        />
      </form>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// How it reads
// ---------------------------------------------------------------------------

function Preferences({ me }: { me: SelfProfile }) {
  const trpc = useTRPC();
  const router = useRouter();
  const update = useMutation(trpc.me.update.mutationOptions({ onSuccess: () => router.refresh() }));
  const [themePending, startThemeTransition] = useTransition();

  return (
    <Section
      title="How it reads"
      note="Distances, heights and temperatures everywhere in the product, on both this site and the app — and which light you read them in."
    >
      <Choice
        legend="Units"
        options={UNIT_SYSTEMS.map((system) => ({ value: system, label: UNIT_LABEL[system] }))}
        value={me.units}
        onChoose={(units) => update.mutate({ units })}
        pending={update.isPending}
      />

      {/*
       * Two writes, deliberately. The account is what carries the choice to a second device;
       * the cookie is what carries it through signing out, and is the only record the collar
       * control on a signed-out page has to read. Writing one without the other is how a
       * setting appears to forget itself at the moment somebody is watching it.
       */}
      <Choice
        legend="Theme"
        legendNote="The printed map sheet stays light whatever you pick here — dark ink on paper is a spent cartridge, not a dark map."
        options={THEME_PREFERENCES.map((theme) => ({ value: theme, label: THEME_LABEL[theme] }))}
        value={me.theme}
        onChoose={(theme: ThemePreference) => {
          startThemeTransition(async () => {
            await rememberTheme(theme);
            update.mutate({ theme });
          });
        }}
        pending={update.isPending || themePending}
      />

      <Choice
        legend="Who sees a hike you record"
        legendNote="The default for new activities. Each one can still be changed on its own."
        options={VISIBILITIES.map((visibility) => ({
          value: visibility,
          label: VISIBILITY_LABEL[visibility],
        }))}
        value={me.defaultActivityVisibility}
        onChoose={(defaultActivityVisibility) => update.mutate({ defaultActivityVisibility })}
        pending={update.isPending}
      />

      {update.isError ? <p className="text-caption text-survey">{update.error.message}</p> : null}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Where you start from
// ---------------------------------------------------------------------------

function Home({ me }: { me: SelfProfile }) {
  const trpc = useTRPC();
  const router = useRouter();

  const [query, setQuery] = useState('');
  const searchId = useId();
  const debounced = useDebounced(query.trim(), 300);

  const update = useMutation(
    trpc.me.update.mutationOptions({
      onSuccess: () => {
        setQuery('');
        router.refresh();
      },
    }),
  );

  // The gazetteer allows about one request a second and is shared with everyone else using
  // it, so this waits for a pause in typing rather than firing per keystroke.
  const results = useQuery(
    trpc.places.search.queryOptions(
      { q: debounced, limit: 5 },
      { enabled: debounced.length >= 2, staleTime: 5 * 60_000 },
    ),
  );

  return (
    <Section
      title="Where you start from"
      note="Where the map opens, and what “near me” means before you grant location permission."
    >
      <p className="font-text text-body text-ink">
        {me.home?.name ? (
          <>
            Currently <span className="text-ink">{me.home.name}</span>.
          </>
        ) : (
          'Not set. The map opens wherever it last was.'
        )}
      </p>

      <div className="max-w-[520px]">
        <label htmlFor={searchId} className="collar">
          Search for a town, park or valley
        </label>
        <input
          id={searchId}
          value={query}
          maxLength={120}
          placeholder="Bethesda, Gwynedd"
          onChange={(event) => setQuery(event.target.value)}
          className="field mt-xs"
        />

        {results.data && results.data.places.length > 0 ? (
          <ul className="mt-sm flex flex-col border-t border-bezel">
            {results.data.places.map((place) => (
              <li key={place.id}>
                <button
                  type="button"
                  disabled={update.isPending}
                  onClick={() =>
                    update.mutate({
                      home: { at: [place.lng, place.lat], name: place.name },
                    })
                  }
                  className="flex w-full items-baseline justify-between gap-md border-b border-bezel py-sm text-left transition-colors duration-quick ease-standard hover:border-ink-muted disabled:opacity-40"
                >
                  <span className="min-w-0">
                    <span className="text-body text-ink">{place.name}</span>{' '}
                    <span className="hydrography text-caption text-ink-muted">{place.context}</span>
                  </span>
                  <span className="collar shrink-0">{place.label}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : results.data?.unavailable ? (
          <p className="mt-sm text-caption text-ink-muted">
            The place index is not answering. Trail search is unaffected — try again shortly.
          </p>
        ) : debounced.length >= 2 && !results.isLoading ? (
          <p className="mt-sm text-caption text-ink-muted">Nothing by that name.</p>
        ) : null}
      </div>

      {me.home ? (
        <button
          type="button"
          disabled={update.isPending}
          onClick={() => update.mutate({ home: null })}
          className={`collar ${HEIGHT.panel} w-fit rounded-hair border px-md transition-colors duration-quick ease-standard disabled:opacity-40 ${UNPRESSED}`}
        >
          Clear it
        </button>
      ) : null}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

function Devices() {
  const trpc = useTRPC();
  const devices = useQuery(trpc.me.devices.queryOptions());
  const signOut = useMutation(
    trpc.me.signOutEverywhere.mutationOptions({ onSuccess: () => void devices.refetch() }),
  );

  const list = devices.data ?? [];

  return (
    <Section
      title="Signed in on"
      note="Phones and tablets holding a long-lived token. This browser is signed out from the button in the header."
    >
      {list.length === 0 ? (
        <p className="font-text text-body text-ink-muted">
          {devices.isLoading ? 'Checking…' : 'No apps signed in.'}
        </p>
      ) : (
        <ul className="flex max-w-[520px] flex-col border-t border-bezel">
          {list.map((device) => (
            <li
              key={device.id}
              className="flex items-baseline justify-between gap-md border-b border-bezel py-sm"
            >
              <span className="text-body text-ink">{device.deviceName ?? 'An unnamed device'}</span>
              <span className="font-mono text-micro text-ink-muted">
                since {device.createdAt.toLocaleDateString('en-GB')}
              </span>
            </li>
          ))}
        </ul>
      )}

      {list.length > 0 ? (
        <div className="flex flex-wrap items-center gap-md">
          <button
            type="button"
            disabled={signOut.isPending}
            onClick={() => signOut.mutate()}
            className={`${BUTTON_COLLAR} ${DANGER} ${HEIGHT.panel} px-md`}
          >
            {signOut.isPending ? 'Signing out…' : 'Sign out everywhere'}
          </button>
          <span className="text-caption text-ink-muted">
            Every app has to sign in again. Anything recorded but not yet synced stays on the
            device.
          </span>
        </div>
      ) : null}

      {signOut.isSuccess ? (
        <p role="status" className="text-caption text-ink-muted">
          Signed out of {signOut.data.devicesSignedOut}{' '}
          {signOut.data.devicesSignedOut === 1 ? 'device' : 'devices'}.
        </p>
      ) : null}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-t border-bezel pt-lg">
      <h2 className="collar">{title}</h2>
      <p className="mt-xs max-w-measure font-text text-caption text-ink-muted">{note}</p>
      <div className="mt-lg flex flex-col gap-lg">{children}</div>
    </section>
  );
}

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-md">
        <label htmlFor={id} className="collar">
          {label}
        </label>
        {hint ? <span className="font-mono text-micro text-ink-muted">{hint}</span> : null}
      </div>
      <div className="mt-xs">{children}</div>
    </div>
  );
}

/**
 * A short set of mutually exclusive answers, as buttons rather than a dropdown.
 *
 * Two or three options are worth showing at once: a select hides the alternatives behind a
 * click and turns "which one am I on" into a thing you have to open a menu to learn.
 */
function Choice<T extends string>({
  legend,
  legendNote,
  options,
  value,
  onChoose,
  pending,
}: {
  legend: string;
  legendNote?: string;
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChoose: (value: T) => void;
  pending: boolean;
}) {
  return (
    <fieldset>
      <legend className="collar">{legend}</legend>
      {legendNote ? (
        <p className="mt-xs max-w-measure font-text text-caption text-ink-muted">{legendNote}</p>
      ) : null}
      <div className="mt-sm flex flex-wrap gap-sm">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={option.value === value}
            disabled={pending || option.value === value}
            onClick={() => onChoose(option.value)}
            className={`collar ${HEIGHT.panel} rounded-hair border px-md transition-colors duration-quick ease-standard disabled:cursor-default ${
              option.value === value ? PRESSED : UNPRESSED
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * The save control, and everything it has to say.
 *
 * Present but inert when there is nothing to save, rather than appearing when the form goes
 * dirty — a button that materialises under the cursor moves the thing you were about to
 * click. What changes is what it says.
 */
function Save({
  dirty,
  blocked,
  pending,
  saved,
  error,
}: {
  dirty: boolean;
  blocked: boolean;
  pending: boolean;
  saved: boolean;
  error: string | null;
}) {
  return (
    <div className="flex flex-wrap items-center gap-md">
      <button
        type="submit"
        disabled={!dirty || blocked || pending}
        className={`${BUTTON_COLLAR} ${PRIMARY} ${HEIGHT.panel} px-md`}
      >
        {pending ? 'Saving…' : 'Save'}
      </button>
      <span role="status" className="text-caption text-ink-muted">
        {error ? (
          <span className="text-survey">{error}</span>
        ) : saved ? (
          'Saved.'
        ) : dirty ? (
          'Unsaved changes.'
        ) : (
          ''
        )}
      </span>
    </div>
  );
}

/**
 * A value that settles.
 *
 * Both live checks on this page reach something with a rate limit behind it — a unique index
 * and a shared public gazetteer — so they wait for a pause in typing rather than firing on
 * every keystroke.
 */
function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);

  return useMemo(() => settled, [settled]);
}
