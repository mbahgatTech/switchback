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

/**
 * The one production database server. Named here so the rule below can refuse it by identity
 * rather than by convention; the same host appears in `.github/workflows/ci.yml`.
 */
const PRODUCTION_DATABASE_HOST = 'psql-switchback-prod-37ywppu5p7fri.postgres.database.azure.com';

/** The host of a connection string, or nothing when it will not parse. */
function databaseHost(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

const base = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  /**
   * Which Vercel environment this process is. Set by the platform, absent everywhere else —
   * so the production-database rule below is inert in CI, on a laptop and in the Azure worker.
   */
  VERCEL_ENV: z.enum(['production', 'preview', 'development']).optional(),

  /**
   * Optional in the schema so a Vercel Preview can build; the rule below still requires it
   * everywhere else. Preview has no database of its own and must not hold Production's.
   */
  DATABASE_URL: z.string().url().optional(),
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
   * Where and as whom to publish. All three are public identifiers, which is the point: the
   * publisher authenticates with the deployment's Vercel OIDC token, exchanged for an Entra
   * access token against a federated identity credential — there is no key to hold.
   * `AZURE_CLIENT_ID` is the publisher managed identity's client id, not an app registration.
   *
   * Optional here and required below, because a deployment is allowed to have no broker — a local
   * `next dev` against a scratch database has none — but one that publishes must name all three.
   */
  SERVICE_BUS_NAMESPACE: z.string().min(1).optional(),
  AZURE_TENANT_ID: z.string().uuid().optional(),
  AZURE_CLIENT_ID: z.string().uuid().optional(),
  SERVICE_BUS_QUEUE: z.string().min(1).default('ingest-jobs'),

  /**
   * Overpass etiquette, read from `process.env` by `@switchback/ingest`'s own singleton rather
   * than from here — so these two entries buy nothing but the startup error, which is the whole
   * point. `getOverpass` falls back to a sane default on a mistyped value, and a fail-safe
   * default is not the same as being told: `OVERPASS_MAX_CONCURRENT=two` silently halves nothing
   * and doubles nothing, it just is not what the operator typed. Both are hand-set in the Vercel
   * dashboard and the Azure portal, which is where typos come from.
   */
  OVERPASS_MAX_CONCURRENT: z.coerce.number().int().positive().optional(),
  OVERPASS_MAX_TOTAL_MS: z.coerce.number().int().positive().optional(),

  /**
   * Processes that may hold Overpass-making work at once, fleet-wide. `OVERPASS_MAX_CONCURRENT`
   * above bounds one `OverpassClient`; this is the factor that makes the documented figure true
   * across processes — `packages/ingest/src/drain-slot.ts` enforces it in Postgres. Declared here
   * for the startup error rather than for the value: nothing in a Vercel function drains.
   */
  INGEST_MAX_DRAINERS: z.coerce.number().int().positive().optional(),

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
   * A Vercel Preview has no database, and that must not stop it building.
   *
   * Preview holds no `DATABASE_URL` because it may not hold Production's (below) and there is no
   * second server. `next build` evaluates this module while collecting page data, so a required
   * `DATABASE_URL` turned every Preview build into `Invalid environment: DATABASE_URL: Required`
   * and every pull request into a red check that said nothing about the change under review — the
   * condition that teaches a reader to ignore a failing gate. A preview therefore builds and
   * degrades: `PrismaClient` constructs without the variable and fails at the first query, so the
   * pages that need no data render and the ones that do return an error.
   *
   * Required everywhere else, including a laptop and CI, where the fix is the missing variable.
   */
  if (!env.DATABASE_URL && env.VERCEL_ENV !== 'preview') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['DATABASE_URL'],
      message:
        'DATABASE_URL is required. Only a Vercel Preview deployment, which has no database, may omit it.',
    });
  }

  /*
   * A Vercel environment that is not Production must not point at the production database.
   *
   * The Postgres firewall is a single rule spanning 0.0.0.0–255.255.255.255, so reachability is
   * not the control; holding the connection string is. A Preview deployment runs unreviewed branch
   * code against whatever that string names, with nothing between a push and the write. Ingestion
   * is not part of that exposure — the Vercel-side drainers are deleted and the Function App is
   * the only process that ingests — but every table a request can reach is. Refusing at startup is
   * what stops the variable being re-added later without anyone noticing.
   */
  for (const key of ['DATABASE_URL', 'DIRECT_DATABASE_URL'] as const) {
    if (env.VERCEL_ENV && env.VERCEL_ENV !== 'production') {
      if (databaseHost(env[key]) === PRODUCTION_DATABASE_HOST) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} names the production database ${PRODUCTION_DATABASE_HOST} in the ${env.VERCEL_ENV} environment. Only Production may hold it.`,
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
   * Publishing is the only way a queued tile reaches a drainer, so a deployment that names one of
   * these and not the others enqueues rows nobody wakes for. All three or none.
   */
  const broker = ['SERVICE_BUS_NAMESPACE', 'AZURE_TENANT_ID', 'AZURE_CLIENT_ID'] as const;
  const named = broker.filter((key) => env[key]);
  if (named.length > 0 && named.length < broker.length) {
    for (const key of broker) {
      if (!env[key]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} is required once any Service Bus publisher variable is set — without all three every queued tile is published nowhere.`,
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
