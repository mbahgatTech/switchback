/**
 * Requeue jobs that failed for a reason since fixed — a `dead` job is one that exhausted its
 * attempts against the code as it stood, and the queue cannot know the reason is gone.
 *
 *   npx tsx scripts/requeue-jobs.ts --kind enrich_trail
 *   npx tsx scripts/requeue-jobs.ts --kind enrich_trail --match "primaryPhotoId"
 *
 * Resets `attempts`, `maxAttempts` and `runAfter` so a requeued job runs immediately with a full
 * budget rather than resuming a backoff earned under the old bug, and clears the `completedAt` the
 * drainer stamped when it gave up. `maxAttempts` matters as much as `attempts`:
 * `reconcileDeadJobs` raises it per revival and past its ceiling when it abandons a job, and these
 * rows are exactly the ones it has abandoned — so without the reset a requeue hands out nine
 * attempts and re-buries the job outside every rung of that reconciler.
 */
import { JobKind, prisma } from '@switchback/db';
import { DEFAULT_MAX_ATTEMPTS } from '@switchback/ingest';

/**
 * Read from the enum, not listed by hand: the hand-written version went stale in the worst
 * direction — the kinds it refused were exactly the ones that had started dying, so it read
 * as "nothing dead to requeue".
 */
const KINDS: readonly string[] = Object.values(JobKind);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const kindArg = arg('kind');
  const match = arg('match');

  if (kindArg !== undefined && !KINDS.includes(kindArg)) {
    throw new Error(`--kind must be one of ${KINDS.join(', ')}`);
  }
  const kind = kindArg as JobKind | undefined;

  const where = {
    status: 'dead' as const,
    ...(kind ? { kind } : {}),
    ...(match ? { lastError: { contains: match } } : {}),
  };

  const doomed = await prisma.ingestJob.findMany({
    where,
    select: { id: true, kind: true, lastError: true },
  });

  if (doomed.length === 0) {
    console.log('nothing dead to requeue');
    return;
  }

  // Grouped so the operator sees what they are reviving: a dead job with an error nobody
  // recognises is a reason to stop, not to retry harder.
  const byError = new Map<string, number>();
  for (const job of doomed) {
    const key = (job.lastError ?? 'no error recorded').slice(0, 100);
    byError.set(key, (byError.get(key) ?? 0) + 1);
  }
  for (const [error, count] of [...byError].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(4)}  ${error}`);
  }

  const { count } = await prisma.ingestJob.updateMany({
    where,
    data: {
      status: 'queued',
      attempts: 0,
      maxAttempts: DEFAULT_MAX_ATTEMPTS,
      runAfter: new Date(),
      lastError: null,
      lockedAt: null,
      lockedBy: null,
      completedAt: null,
    },
  });
  console.log(`\nrequeued ${count}`);
}

void main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
