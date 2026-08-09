/**
 * What is actually running here: the commit this deployment was built from.
 *
 * `.github/workflows/ci.yml` has no Vercel credential to ask with, so it polls this until the
 * production alias reports back the SHA it pushed — an end-to-end check that the build finished,
 * the alias moved and the app serves requests, rather than a record somewhere reading READY.
 * `commit` is null without git metadata, which the pipeline treats as a failure, not a pass.
 */
import { alarmSink } from '@switchback/db/token-alarm';

export const runtime = 'nodejs';

/**
 * The CDN is the reason, not the render: a poll reading a shared cache entry written seconds
 * before the alias moved would report the old commit and fail the deploy.
 */
export const dynamic = 'force-dynamic';

/** Blank rather than the string "undefined", which is the shape a shell heredoc leaves behind. */
function read(name: string): string | null {
  const value = process.env[name];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function GET(): Response {
  return Response.json(
    {
      commit: read('VERCEL_GIT_COMMIT_SHA'),
      ref: read('VERCEL_GIT_COMMIT_REF'),
      // The pipeline asserts on this so a preview URL cannot stand in for the production alias.
      environment: read('VERCEL_ENV') ?? 'development',
      // Which channel a token-refresh alarm would leave on. Configuration, not a counter: an
      // instance's own tally would be invisible here anyway, since the reader almost never
      // reaches the instance that raised one. `console` means the only durable signal is the
      // site failing, which is what makes this checkable before anything is cut over to tokens.
      alarms: alarmSink(),
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
