import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BRAND } from '@switchback/core';
import { CONTROL_HEIGHT, nativeTheme } from '@switchback/ui';
import { useAuth } from '@/auth/context';
import { type SignInOutcome, resumeSignIn, signInWithBrowser } from '@/auth/handshake';

/**
 * Sign in.
 *
 * The website's sign-in page is a **title block** — the boxed panel at the corner of a survey
 * drawing where the sheet is identified and, in the last field, signed. This is the same
 * structure on a narrower sheet, and for the same reason: every row states a fact about the
 * account, and the last one is the field a person fills in.
 *
 * `sheet` rather than `field`, matching the profile and trail screens. Dark chrome is for the
 * map; this is prose.
 *
 * What it does *not* do is offer a choice of provider. That choice lives on the web page this
 * screen opens, which already renders exactly the providers the deployment has configured — so
 * the app never has a Microsoft button that works and an Apple button that does not, and never
 * needs shipping an update the day the Apple enrolment lands.
 *
 * Two ways in, and the screen has to survive both:
 *
 * - **The browser sheet returns.** `signInWithBrowser` resolves and this component is still
 *   mounted, holding the verifier in a local.
 * - **iOS reclaimed the app** while the sheet was open. The deep link arrives as a cold start,
 *   expo-router routes it here, and `code`/`state` are in the params. The verifier comes back
 *   out of the Keychain instead.
 */

const theme = nativeTheme('sheet');

/**
 * What an account holds, in the order it matters. Kept word-for-word with the website's.
 *
 * Two products saying the same three things differently is how a person starts wondering
 * whether they are the same account.
 */
const FIELDS = [
  { label: 'Saves', body: 'Lists, favourites, and the trails you have finished.' },
  { label: 'Records', body: 'Activities you record, reviews you write, photographs you add.' },
  {
    label: 'Syncs',
    body: 'One account across the website and this app. What you download on one is there on the other.',
  },
] as const;

type Phase =
  | { kind: 'idle' }
  /** The browser sheet is up, or a claim is in flight. Either way: hands off. */
  | { kind: 'working' }
  | { kind: 'failed'; reason: string };

export default function SignInScreen() {
  const insets = useSafeAreaInsets();
  const { status } = useAuth();
  const params = useLocalSearchParams<{ code?: string; state?: string; error?: string }>();

  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  /*
   * Params survive a re-render, so without this the resume effect would fire again every time
   * the screen updates — spending a one-time code that has already been spent and turning a
   * successful sign-in into an `already_claimed` error a beat later.
   */
  const handled = useRef(false);

  const settle = useCallback((outcome: SignInOutcome) => {
    if (outcome.kind === 'failed') setPhase({ kind: 'failed', reason: outcome.reason });
    // `signedIn` is left in `working`: the effect below navigates away, and flipping the
    // button back to "Sign in" for the frame before that reads as a failure.
    else if (outcome.kind === 'cancelled') setPhase({ kind: 'idle' });
  }, []);

  // The cold-start path. Runs once, on whatever the deep link brought.
  useEffect(() => {
    if (handled.current) return;
    const { code, state, error } = params;

    if (error) {
      handled.current = true;
      setPhase({ kind: 'failed', reason: 'Sign-in did not complete in the browser. Try again.' });
      return;
    }
    if (!code || !state) return;

    handled.current = true;
    setPhase({ kind: 'working' });
    void resumeSignIn(state, code).then(settle);
  }, [params, settle]);

  /*
   * One exit for both ways of arriving here signed in — a sign-in that just completed, and a
   * stale link opened by somebody who already has a session. A sign-in screen with a live
   * session is a dead end that looks like a bug.
   */
  useEffect(() => {
    if (status !== 'signedIn') return;
    if (router.canGoBack()) router.back();
    else router.replace('/profile');
  }, [status]);

  const begin = useCallback(() => {
    setPhase({ kind: 'working' });
    void signInWithBrowser().then(settle);
  }, [settle]);

  const working = phase.kind === 'working' || status === 'loading';

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
      >
        <Pressable
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={theme.space.md}
          style={styles.back}
        >
          <Text style={styles.backLabel}>← Back</Text>
        </Pressable>

        <Text style={styles.collar}>Account</Text>
        <Text style={styles.title}>Sign in to {BRAND.name}</Text>
        <Text style={styles.lede}>
          Every trail, every profile and every forecast works signed out. An account is what makes
          it remember.
        </Text>

        <View style={styles.block}>
          {FIELDS.map((field, index) => (
            <Field key={field.label} label={field.label} first={index === 0}>
              <Text style={styles.fieldBody}>{field.body}</Text>
            </Field>
          ))}

          {phase.kind === 'failed' ? (
            <Field label="Fault" first={false} emphasis>
              <Text style={styles.fieldFault}>{phase.reason}</Text>
            </Field>
          ) : null}

          <Field label="Signed" first={false}>
            <Pressable
              onPress={begin}
              disabled={working}
              accessibilityRole="button"
              accessibilityState={{ disabled: working, busy: working }}
              accessibilityLabel="Continue in the browser"
              style={({ pressed }) => [
                styles.action,
                pressed ? styles.actionPressed : null,
                working ? styles.actionWorking : null,
              ]}
            >
              {working ? (
                <ActivityIndicator color={theme.color.canvas} size="small" />
              ) : (
                <Text style={styles.actionLabel}>
                  {phase.kind === 'failed' ? 'Try again' : 'Continue in the browser'}
                </Text>
              )}
            </Pressable>

            {/*
             * Said plainly, because a browser opening over the app is the moment somebody
             * wonders whether they have left it. Naming what will happen before it happens is
             * cheaper than an explanation afterwards.
             */}
            <Text style={styles.fieldNote}>
              {working
                ? 'Finish signing in in the browser. This screen is waiting.'
                : `Signing in happens on ${BRAND.name}'s own site, in a browser, so your password is never typed into this app. It closes itself when you are done.`}
            </Text>
          </Field>
        </View>

        <Text style={styles.footnote}>
          We store the name, email address and avatar the provider returns, and nothing else from
          it.
        </Text>
      </ScrollView>
    </>
  );
}

/**
 * One field of the title block: a label in the collar voice, the value beneath it.
 *
 * Stacked rather than the website's two columns. A fixed label column costs 88 points of a
 * 375-point sheet and buys an alignment nobody reads down.
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
  children: React.ReactNode;
}) {
  return (
    <View style={[styles.field, first ? null : styles.fieldRuled]}>
      <Text style={[styles.fieldLabel, emphasis ? styles.fieldLabelEmphasis : null]}>{label}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.color.canvas },
  content: { paddingHorizontal: theme.space.xl },

  back: { alignSelf: 'flex-start', paddingVertical: theme.space.xs, marginBottom: theme.space.xl },
  backLabel: { ...theme.collarLabel, color: theme.color.inkMuted },

  collar: { ...theme.collarLabel, color: theme.color.inkMuted },
  title: {
    ...theme.text('h3', { weight: 'bold' }),
    color: theme.color.ink,
    marginTop: theme.space.md,
  },
  lede: {
    ...theme.text('body', { family: 'text' }),
    color: theme.color.inkMuted,
    marginTop: theme.space.lg,
  },

  block: {
    marginTop: theme.space['2xl'],
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.bezel,
  },
  field: {
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.lg,
    gap: theme.space.xs,
  },
  fieldRuled: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.color.bezel },
  fieldLabel: { ...theme.collarLabel, color: theme.color.inkMuted },
  fieldLabelEmphasis: { color: theme.color.ink },
  fieldBody: { ...theme.text('body', { family: 'text' }), color: theme.color.inkMuted },
  fieldFault: { ...theme.text('body', { family: 'text' }), color: theme.color.ink },
  fieldNote: {
    ...theme.text('caption', { family: 'text' }),
    color: theme.color.inkMuted,
    marginTop: theme.space.sm,
  },

  action: {
    minHeight: CONTROL_HEIGHT.touch,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radius.hair,
    backgroundColor: theme.color.woodland,
    paddingHorizontal: theme.space.lg,
    marginTop: theme.space.xs,
  },
  actionPressed: { opacity: 0.9 },
  actionWorking: { opacity: 0.7 },
  actionLabel: { ...theme.text('body', { weight: 'semibold' }), color: theme.color.canvas },

  footnote: {
    ...theme.text('caption', { family: 'text' }),
    color: theme.color.inkMuted,
    marginTop: theme.space.xl,
  },
});
