import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { BRAND } from '@switchback/core';
import { auth, signIn } from '@/auth';
import { safeCallback } from '@/lib/safe-callback';
import { caller } from '@/trpc/server';
import { MicrosoftSignInButton } from '@/components/auth/microsoft-button';
import { AppleSignInButton } from '@/components/auth/apple-button';
import { Wordmark } from '@/components/wordmark';

/**
 * Sign in. `auth.ts` names this route for both `pages.signIn` and `pages.error`, so it is reached
 * three ways — a deliberate sign-in, an Auth.js `?error=` bounce, and a protected route's
 * `?callbackUrl=`. All three are this page with a different field filled in, which is why it is
 * built as a title block: every row a fact about the sheet, the last one blank until signed.
 *
 * An error prints as another field, in ink rather than the survey plate. Red is reserved for the
 * reader's safety, and spending it here is how it stops meaning anything on a ridge.
 */

export const metadata: Metadata = {
  title: 'Sign in',
  description: `Sign in to ${BRAND.name} to keep lists, record activities, and carry them between the web and iOS.`,
  // Nothing here is worth indexing, and an error variant of it even less so.
  robots: { index: false, follow: false },
};

/**
 * What an account actually holds. Deliberately not a feature list: everything below is something
 * the product already stores against a user id.
 */
const FIELDS = [
  {
    label: 'Saves',
    body: 'Lists, favourites, and the trails you have finished.',
  },
  {
    label: 'Records',
    body: 'Activities you record, reviews you write, photographs you add.',
  },
  {
    label: 'Syncs',
    body: 'One account across the website and the iOS app. What you download on one is there on the other.',
  },
] as const;

/**
 * Auth.js reports failures as a query-string code and nothing else — `ErrorPageParam` and
 * `SignInPageErrorParam` in `@auth/core`. Both land here, so both are translated here.
 */
const GENERIC_FAULT = 'Sign-in did not complete. Try again.';

const FAULTS: Record<string, string> = {
  Configuration:
    'Sign-in is not configured on this deployment. The provider credentials are missing or wrong, and nothing you do from here will change that.',
  AccessDenied:
    'The provider declined the request. That usually means consent was cancelled, or the account sits outside a directory this app is allowed to read.',
  Verification: 'That link has expired or has already been used. Start again for a new one.',
  OAuthAccountNotLinked:
    'That email address already has an account here, created with the other provider. Sign in the way you did the first time — the two can be linked afterwards.',
  OAuthSignin: 'The handoff to the provider did not complete. Try again.',
  OAuthCallbackError: 'The provider returned a response we could not read. Try again.',
  OAuthCreateAccount: 'The account could not be created. Try again.',
  EmailCreateAccount: 'The account could not be created. Try again.',
  Callback: 'The sign-in could not be completed. Try again.',
  EmailSignin: 'That sign-in email could not be sent. Try again.',
  CredentialsSignin: 'Those credentials were not accepted.',
  Signin: GENERIC_FAULT,
};

/** Not a fault. Somewhere sent the user here because it needed an account, which is a reason. */
const SESSION_REQUIRED = 'That page keeps things against your account, so it needs one first.';

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The receipt from "Sign out everywhere" — that button ends the browser it was pressed in, so the
 * reader lands here either way, and this is the difference between "I did that" and "something
 * logged me out". Ranked above an `?error=`. The counts come out of the query string, so they are
 * a claim the reader's own browser made: parsed as integers, clamped, never rendered raw.
 */
function signedOutNotice(
  devices: string | string[] | undefined,
  browsers: string | string[] | undefined,
): { label: string; body: string } | null {
  const raw = firstParam(devices);
  if (raw === undefined) return null;

  const count = (value: string | undefined): number => {
    const parsed = Number.parseInt(value ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 9999) : 0;
  };
  const apps = count(raw);
  const seats = count(firstParam(browsers));

  const parts: string[] = [];
  if (apps > 0) parts.push(`${apps} ${apps === 1 ? 'app' : 'apps'}`);
  if (seats > 0) parts.push(`${seats} ${seats === 1 ? 'browser' : 'browsers'}`);

  return {
    label: 'Done',
    body:
      parts.length > 0
        ? `Every session on the account has ended — ${parts.join(' and ')}, this one included. Sign in again below.`
        : 'Every session on the account has ended, this one included. Sign in again below.',
  };
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const callbackUrl = safeCallback(params.callbackUrl);

  const [session, config] = await Promise.all([auth(), caller.health.config()]);

  // Already signed in. Landing on a sign-in form with a live session is a dead end that
  // looks like a bug, so honour where they were going instead.
  if (session?.user) redirect(callbackUrl);

  const code = firstParam(params.error);
  const notice =
    signedOutNotice(params.signedOut, params.browsers) ??
    (code === 'SessionRequired'
      ? { label: 'Reason', body: SESSION_REQUIRED }
      : code
        ? { label: 'Fault', body: FAULTS[code] ?? GENERIC_FAULT }
        : null);

  const anyProvider = config.providers.microsoft || config.providers.apple;

  return (
    <div data-scheme="sheet" className="min-h-dvh bg-canvas text-ink">
      <header className="mx-auto flex max-w-[640px] items-center justify-between px-xl py-lg">
        <Wordmark />
        <Link href="/" className="collar rounded-hair hover:text-ink">
          Explore
        </Link>
      </header>

      <main className="mx-auto max-w-[640px] px-xl pb-5xl">
        <p className="collar">Account</p>
        <h1 className="mt-lg text-h4 font-bold text-balance sm:text-h3">Sign in to {BRAND.name}</h1>
        <p className="mt-lg max-w-measure font-text text-body text-ink-muted">
          Every trail, every profile and every forecast on this site works signed out. An account is
          what makes it remember.
        </p>

        <dl className="mt-2xl border border-bezel">
          {FIELDS.map((field, index) => (
            <Field key={field.label} label={field.label} first={index === 0}>
              <span className="font-text text-body text-ink-muted">{field.body}</span>
            </Field>
          ))}

          {notice ? (
            <Field label={notice.label} first={false} emphasis>
              <span className="font-text text-body text-ink">{notice.body}</span>
            </Field>
          ) : null}

          <Field label="Signed" first={false}>
            {anyProvider ? (
              <div className="flex flex-wrap items-center gap-md">
                {config.providers.microsoft ? (
                  <form
                    action={async () => {
                      'use server';
                      await signIn('microsoft-entra-id', { redirectTo: callbackUrl });
                    }}
                  >
                    <MicrosoftSignInButton />
                  </form>
                ) : null}

                {config.providers.apple ? (
                  <form
                    action={async () => {
                      'use server';
                      await signIn('apple', { redirectTo: callbackUrl });
                    }}
                  >
                    <AppleSignInButton />
                  </form>
                ) : null}
              </div>
            ) : (
              <span className="font-text text-body text-ink">
                No sign-in provider is enabled on this deployment, so there is nothing to sign with
                yet. Everything else on the site still works.
              </span>
            )}

            {/* A sentence, not a third disabled control: a button that cannot be pressed reads
             * as broken rather than as not yet built. */}
            {!config.providers.apple && config.providers.microsoft ? (
              <p className="mt-md font-text text-caption text-ink-muted">
                Sign in with Apple is built and switched off until the developer enrolment is in
                place.
              </p>
            ) : null}
          </Field>
        </dl>

        <p className="mt-xl max-w-measure font-text text-caption text-ink-muted">
          We store the name, email address and avatar the provider returns, and nothing else from
          it. Sources and licences are on the{' '}
          <Link
            href="/attribution"
            className="rounded-hair underline decoration-bezel underline-offset-4 hover:decoration-ink"
          >
            attribution page
          </Link>
          .
        </p>
      </main>
    </div>
  );
}

/** One field of the title block: a collar label, a value beside it, stacking on a narrow sheet. */
function Field({
  label,
  first,
  emphasis,
  children,
}: {
  label: string;
  first: boolean;
  emphasis?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={`flex flex-col gap-xs px-lg py-lg sm:flex-row sm:gap-xl ${
        first ? '' : 'border-t border-bezel'
      }`}
    >
      <dt
        className={`collar sm:w-[5.5rem] sm:shrink-0 sm:pt-[0.35em] ${emphasis ? 'text-ink' : ''}`}
      >
        {label}
      </dt>
      <dd className="min-w-0 flex-1">{children}</dd>
    </div>
  );
}
