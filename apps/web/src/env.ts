import { z } from 'zod';

/**
 * The single server-side allowlist for environment variables, parsed once at module load so a
 * missing one is a startup error naming it. Everything reading `process.env` imports from here.
 *
 * `SKIP_ENV_VALIDATION` is for `next build` where no secrets exist (a Docker image, a CI
 * typecheck). It is not for local development: the fix there is the missing variable.
 */

const bool = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

const base = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  DATABASE_URL: z.string().url(),
  /** Optional because only the Prisma CLI reads it (`directUrl`) — but migrations need it set. */
  DIRECT_DATABASE_URL: z.string().url().optional(),

  /** Also signs the mobile access tokens — see `@switchback/api/tokens`. */
  AUTH_SECRET: z.string().min(32, 'AUTH_SECRET must be at least 32 characters'),
  AUTH_URL: z.string().url().optional(),

  /** Optional in development so the app starts before Azure exists; required in production below. */
  AUTH_MICROSOFT_ENTRA_ID_ID: z.string().min(1).optional(),
  AUTH_MICROSOFT_ENTRA_ID_SECRET: z.string().min(1).optional(),
  /** `/common` accepts both work/school and personal Microsoft accounts. */
  AUTH_MICROSOFT_ENTRA_ID_ISSUER: z
    .string()
    .url()
    .default('https://login.microsoftonline.com/common/v2.0'),
  /** Only when the iOS app has its own Entra registration; one registration can carry both. */
  AUTH_MICROSOFT_ENTRA_ID_MOBILE_ID: z.string().min(1).optional(),

  AUTH_APPLE_ENABLED: bool,
  /** The Services ID, not the App ID. Apple uses it as the OAuth client_id. */
  AUTH_APPLE_ID: z.string().min(1).optional(),
  /**
   * The App ID (bundle identifier). Native Apple sign-in puts *this* in the identity token's
   * `aud` where the web flow puts the Services ID above — swapping them fails every native login.
   */
  AUTH_APPLE_BUNDLE_ID: z.string().min(1).optional(),
  AUTH_APPLE_TEAM_ID: z.string().min(1).optional(),
  AUTH_APPLE_KEY_ID: z.string().min(1).optional(),
  /** The full `.p8` contents; a shell `.env` writes its newlines as `\n`, unescaped here. */
  AUTH_APPLE_PRIVATE_KEY: z.string().min(1).optional(),

  CRON_SECRET: z.string().min(16).optional(),

  /**
   * Which queue drives ingest. `postgres` drains inline and on the cron; `servicebus` publishes
   * a wake-up signal per queued tile and leaves the drain to the Function App. Read at the point
   * of use by `@switchback/ingest`'s `ingestQueueDriver`, which treats anything unrecognised as
   * `postgres` — the enum here is what turns a typo into a startup error instead.
   */
  INGEST_QUEUE_DRIVER: z.enum(['postgres', 'servicebus']).default('postgres'),
  /**
   * Where and as whom to publish. All three are public identifiers, which is the point: the
   * publisher authenticates with the deployment's Vercel OIDC token, exchanged for an Entra
   * access token against a federated identity credential — there is no key to hold.
   * `AZURE_CLIENT_ID` is the publisher managed identity's client id, not an app registration.
   */
  SERVICE_BUS_NAMESPACE: z.string().min(1).optional(),
  AZURE_TENANT_ID: z.string().uuid().optional(),
  AZURE_CLIENT_ID: z.string().uuid().optional(),
  SERVICE_BUS_QUEUE: z.string().min(1).default('ingest-jobs'),

  /**
   * Cloudflare R2. All optional — `packages/api/storage` falls back to a local filesystem driver,
   * so uploads work with no Cloudflare account. Filling in *some* of them is refused below.
   */
  R2_ACCOUNT_ID: z.string().min(1).optional(),
  R2_ACCESS_KEY_ID: z.string().min(1).optional(),
  R2_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  R2_BUCKET: z.string().min(1).optional(),
  /** Public origin objects are served from — a custom domain or the bucket's r2.dev URL. */
  R2_PUBLIC_URL: z.string().url().optional(),
});

/**
 * Cross-field rules. Apple's variables are useless individually — a Services ID with no signing
 * key cannot mint a client secret — so they are validated as a set, and only when the flag is on.
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
   * R2 is all or nothing: the storage driver picks itself by whether the whole set is present, so
   * a half-configured deploy silently writes photographs to a serverless container that is thrown
   * away minutes later, every upload appearing to succeed.
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

  /*
   * The flag on its own publishes nowhere: `publishIngestSignals` would log and give up, every
   * tile falling to the once-a-day cron with nothing on the map saying so. Naming the variables
   * at startup is the difference between a misconfiguration and a slow leak.
   */
  if (env.INGEST_QUEUE_DRIVER === 'servicebus') {
    for (const key of ['SERVICE_BUS_NAMESPACE', 'AZURE_TENANT_ID', 'AZURE_CLIENT_ID'] as const) {
      if (!env[key]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} is required when INGEST_QUEUE_DRIVER=servicebus — without it every queued tile is published nowhere.`,
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
 * A `.env` has no syntax for "absent" — the convention is `KEY=""`, which arrives as an empty
 * string. Without this, `.optional()` never fires and every placeholder in `.env.example` fails.
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
     * The escape hatch skips the checks, not the coercions: every boolean arrives as a string and
     * `"false"` is truthy, so returning `process.env` unchanged switches Apple sign-in on for any
     * build that opted out of validation.
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
