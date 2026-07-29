import { z } from 'zod';

/**
 * Environment validation.
 *
 * Parsed once at module load so a missing variable is a startup error naming the variable,
 * rather than an `undefined` that travels three layers down and surfaces as a 500 from
 * Microsoft's token endpoint at 2am. Everything that reads `process.env` on the server
 * imports from here instead.
 *
 * `SKIP_ENV_VALIDATION` exists for `next build` in contexts that have no secrets — a
 * Docker image build, a CI typecheck. It is not for local development: if you find
 * yourself setting it to make `npm run dev` start, the fix is the missing variable.
 */

const bool = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

const base = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  DATABASE_URL: z.string().url(),
  DIRECT_DATABASE_URL: z.string().url().optional(),

  /** Also signs the mobile access tokens — see `@switchback/api/tokens`. */
  AUTH_SECRET: z.string().min(32, 'AUTH_SECRET must be at least 32 characters'),
  AUTH_URL: z.string().url().optional(),

  /**
   * Optional in development so the app starts before you have registered anything in
   * Azure — the provider is simply not offered, and `health.config` reports it as absent
   * so both clients hide the button. Required in production, enforced below: a deployed
   * Switchback with no way to sign in is a broken deploy, not a degraded one.
   */
  AUTH_MICROSOFT_ENTRA_ID_ID: z.string().min(1).optional(),
  AUTH_MICROSOFT_ENTRA_ID_SECRET: z.string().min(1).optional(),
  /** `/common` accepts both work/school and personal Microsoft accounts. */
  AUTH_MICROSOFT_ENTRA_ID_ISSUER: z
    .string()
    .url()
    .default('https://login.microsoftonline.com/common/v2.0'),
  /**
   * Only needed if the iOS app has its own Entra registration. One registration can carry
   * both a Web and an iOS/macOS platform configuration, in which case the client id is
   * shared and this stays unset.
   */
  AUTH_MICROSOFT_ENTRA_ID_MOBILE_ID: z.string().min(1).optional(),

  AUTH_APPLE_ENABLED: bool,
  /** The Services ID, not the App ID. Apple uses it as the OAuth client_id. */
  AUTH_APPLE_ID: z.string().min(1).optional(),
  /**
   * The App ID (bundle identifier). Native Apple sign-in puts *this* in the identity
   * token's `aud`, where the web flow puts the Services ID above — they are different
   * strings and swapping them fails verification on every native login.
   */
  AUTH_APPLE_BUNDLE_ID: z.string().min(1).optional(),
  AUTH_APPLE_TEAM_ID: z.string().min(1).optional(),
  AUTH_APPLE_KEY_ID: z.string().min(1).optional(),
  /**
   * The full contents of the `.p8`, newlines and all. In a shell `.env` those newlines
   * have to be written as `\n` inside quotes, so they are unescaped here.
   */
  AUTH_APPLE_PRIVATE_KEY: z.string().min(1).optional(),

  CRON_SECRET: z.string().min(16).optional(),

  /**
   * Cloudflare R2, where user photographs live.
   *
   * All optional, because the app is fully usable without them: `packages/api/storage` falls
   * back to a local filesystem driver that stands in for the bucket, and uploads work on a
   * laptop with no Cloudflare account. What is *not* allowed is filling in some of them —
   * see the cross-field rule below.
   */
  R2_ACCOUNT_ID: z.string().min(1).optional(),
  R2_ACCESS_KEY_ID: z.string().min(1).optional(),
  R2_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  R2_BUCKET: z.string().min(1).optional(),
  /** Public origin objects are served from — a custom domain or the bucket's r2.dev URL. */
  R2_PUBLIC_URL: z.string().url().optional(),
});

/**
 * Cross-field rules.
 *
 * Apple's variables are useless individually — a Services ID with no signing key cannot
 * mint a client secret, and a signing key with no App ID cannot verify a native login —
 * so they are validated as a set, and only when the flag that would use them is on.
 */
const schema = base.superRefine((env, ctx) => {
  if (env.NODE_ENV === 'production') {
    for (const key of ['AUTH_MICROSOFT_ENTRA_ID_ID', 'AUTH_MICROSOFT_ENTRA_ID_SECRET'] as const) {
      if (!env[key]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} is required in production — otherwise nobody can sign in.`,
        });
      }
    }
  }

  /*
   * R2 is all or nothing.
   *
   * The storage driver picks itself by whether the whole set is present, and a *partially*
   * configured deploy therefore falls back to the local filesystem driver — writing user
   * photographs to a serverless container that is discarded minutes later, silently, with
   * every upload appearing to succeed. Better to refuse to start and name the missing key.
   */
  const r2 = [
    'R2_ACCOUNT_ID',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
    'R2_BUCKET',
    'R2_PUBLIC_URL',
  ] as const;
  const filled = r2.filter((key) => env[key]);
  if (filled.length > 0 && filled.length < r2.length) {
    for (const key of r2) {
      if (!env[key]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} is required once any R2_* variable is set — a half-configured bucket falls back to local disk and loses every upload.`,
        });
      }
    }
  }

  if (!env.AUTH_APPLE_ENABLED) return;
  for (const key of [
    'AUTH_APPLE_ID',
    'AUTH_APPLE_BUNDLE_ID',
    'AUTH_APPLE_TEAM_ID',
    'AUTH_APPLE_KEY_ID',
    'AUTH_APPLE_PRIVATE_KEY',
  ] as const) {
    if (!env[key]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `${key} is required when AUTH_APPLE_ENABLED=true. See docs/auth-apple.md.`,
      });
    }
  }
});

/**
 * A `.env` file has no syntax for "absent" — the convention is `KEY=""`, which arrives as
 * an empty string rather than `undefined`. Without this, `.optional()` never fires for an
 * unfilled placeholder and every blank line in `.env.example` fails its own `min()` check.
 * Whitespace-only counts as blank too: a key someone half-filled and reverted is not set.
 */
function present(source: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(source).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim() !== '',
    ),
  );
}

function parse(): z.infer<typeof schema> {
  if (process.env.SKIP_ENV_VALIDATION) {
    /*
     * The escape hatch skips the *checks*. It must not skip the *coercions*.
     *
     * Every boolean in this schema arrives from the environment as a string, and the string
     * `"false"` is truthy. Returning `process.env` unchanged therefore switched Apple sign-in
     * on for any build that opted out of validation — which threw on the first render of any
     * page, because the client secret it then tried to sign has no key. A build that turns a
     * feature on by declining to look at the environment is a worse failure than the missing
     * variable the flag was set to get past.
     */
    return {
      ...(process.env as unknown as z.infer<typeof schema>),
      AUTH_APPLE_ENABLED: process.env.AUTH_APPLE_ENABLED === 'true',
    };
  }
  const result = schema.safeParse(present(process.env));
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`Invalid environment:\n${lines.join('\n')}`);
  }
  return result.data;
}

export const env = parse();

/** Normalised for `jose`, which wants real newlines in a PKCS#8 PEM. */
export function applePrivateKey(): string {
  const raw = env.AUTH_APPLE_PRIVATE_KEY;
  if (!raw) throw new Error('AUTH_APPLE_PRIVATE_KEY is not set');
  return raw.replace(/\\n/g, '\n');
}
