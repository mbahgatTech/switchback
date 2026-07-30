/**
 * What is actually running here.
 *
 * One flat object naming the commit this deployment was built from. It exists because the
 * pipeline in `.github/workflows/ci.yml` has no Vercel credential to ask with — Vercel will
 * not let a CLI-issued token mint an API token, so the deploy job triggers a build through a
 * deploy hook and then has no privileged way to learn whether that build ever went live.
 *
 * This is the unprivileged way. The job knows the SHA it pushed; it polls this endpoint until
 * the production alias reports the same one back. That is a stronger check than asking Vercel
 * for a deployment state, because it is end-to-end: it proves the build finished, the alias
 * moved, and the running app can serve a request — not merely that a record somewhere reads
 * READY.
 *
 * `commit` is null in local development and in any build without git metadata, which the
 * pipeline treats as a failure rather than a pass. Silence and success must not look alike to
 * something whose whole job is to tell them apart.
 *
 * Nothing secret is here. The commit of a deployment is inferable from the public site's asset
 * hashes anyway, and this repository is private; what it buys is a way to answer "is my fix
 * live yet" without opening a dashboard.
 */
export const runtime = 'nodejs';

/**
 * Never cached, anywhere.
 *
 * A statically rendered copy would be correct — Vercel keys build output per deployment, so
 * the value could not go stale across a promotion. The reason not to rely on that is the CDN
 * in front of it: a poll that reads a shared cache entry written seconds before the alias
 * moved would report the old commit and the pipeline would conclude the deploy had not
 * happened. The endpoint is hit a few dozen times per deploy, so the cost of being certain is
 * a rounding error.
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
      // `production` | `preview` | `development`. The pipeline asserts on it so a preview
      // URL accidentally standing in for the production alias cannot pass as one.
      environment: read('VERCEL_ENV') ?? 'development',
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
