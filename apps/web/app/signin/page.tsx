import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { BRAND } from '@switchback/core';
import { auth, signIn } from '@/auth';
import { caller } from '@/trpc/server';
import { MicrosoftSignInButton } from '@/components/auth/microsoft-button';
import { AppleSignInButton } from '@/components/auth/apple-button';
import { Wordmark } from '@/components/wordmark';

/**
 * Sign in.
 *
 * `auth.ts` names this route for both `pages.signIn` and `pages.error`, so it is reached
 * three ways: a user choosing to sign in, Auth.js bouncing a failed exchange here with
 * `?error=`, and a protected route sending someone here with `?callbackUrl=`. All three
 * are the same page with a different field filled in, which is why the structure is a
 * **title block** — the boxed panel at the corner of a survey drawing where the sheet is
 * identified and, in the last field, signed. Every row is a fact about the sheet; the
 * signature field is the one that is blank until a person fills it. That is exactly the
 * shape of this page, so it is the structure rather than a decoration applied to it.
 *
 * `data-scheme="sheet"` for the same reason `/attribution` uses it: this is a reading page,
 * and the dark instrument scheme is worst at prose.
 *
 * An error prints as another field, set in ink with the label carrying the emphasis. Not in
 * the survey plate — red is reserved for the user and their safety, and a failed OAuth
 * round trip is neither. Spending it here is how it stops meaning anything on a ridge.
 */

export const metadata: Metadata = {
  title: 'Sign in',
  description: `Sign in to ${BRAND.name} to keep lists, record activities, and carry them between the web and iOS.`,
  // Nothing here is worth indexing, and an error variant of it even less so.
  robots: { index: false, follow: false },
};

/**
 * What an account actually holds, in the order it matters.
 *
 * Deliberately not a feature list. Everything below is something the product already
 * stores against a user id — promising anything else here would make the first row of the
 * title block a lie.
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
 * Auth.js reports failures as a code in the query string and nothing else — the codes are
 * `ErrorPageParam` and `SignInPageErrorParam` in `@auth/core`. Both land here, so both are
 * translated here.
 *
 * Each message says what happened and what to do about it. `OAuthAccountNotLinked` is the
 * one that earns its length: it is the case where the user is certain they have an account,
 * and they are right — they just made it with the other button.
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

/**
 * Reduce `callbackUrl` to a path on this origin.
 *
 * Auth.js validates the destination itself before redirecting, so this is defence in depth
 * rather than the only guard — but this page also renders the value into a form and
 * redirects an already-signed-in visitor to it, and both of those are ours to get right.
 * A same-origin path only: an absolute URL, a protocol-relative `//evil.example`, or the
 * backslash variant some parsers read as one, all fall back to the front page.
 */
function safeCallback(value: string | string[] | undefined): string {
  const url = Array.isArray(value) ? value[0] : value;
  if (!url || !url.startsWith('/')) return '/';
  if (url.startsWith('//') || url.startsWith('/\\')) return '/';
  return url;
}

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
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
    code === 'SessionRequired'
      ? { label: 'Reason', body: SESSION_REQUIRED }
      : code
        ? { label: 'Fault', body: FAULTS[code] ?? GENERIC_FAULT }
        : null;

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

            {/*
             * Said once, under the buttons, rather than as a third disabled control. A
             * button that cannot be pressed is worse than an absent one: it reads as
             * broken rather than as not yet built.
             */}
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

/**
 * One field of the title block: a label in the collar voice, a value beside it.
 *
 * The label column is fixed on a wide sheet and stacks above the value on a narrow one —
 * a title block is a grid because paper does not reflow, and this is not paper.
 */
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
