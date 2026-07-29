/**
 * Requeue jobs that failed for a reason that has since been fixed.
 *
 * A `dead` job is not a job that can never succeed — it is a job that exhausted its
 * attempts against the code as it stood. When the defect that killed it is repaired, the
 * work is still owed, and the queue has no way to know that on its own. This is the
 * manual counterpart to the automatic backoff: an operator saying "the reason is gone."
 *
 *   npx tsx scripts/requeue-jobs.ts --kind enrich_trail
 *   npx tsx scripts/requeue-jobs.ts --kind enrich_trail --match "primaryPhotoId"
 *
 * Resets `attempts` to 0 and `runAfter` to now, so a requeued job runs immediately with a
 * full budget rather than resuming a backoff it earned under the old bug, and clears the
 * `completedAt` the drainer stamped when it gave up — a queued job that claims to have
 * finished is a row every later query has to second-guess.
 */
import { JobKind, prisma } from '@switchback/db';

/**
 * Every kind the queue knows, read from the enum rather than listed by hand.
 *
 * The hand-written version went stale the moment route planning introduced a kind, and it
 * went stale in the worst possible direction: the kinds this refused to accept —
 * `ingest_route` and `ingest_network` — were precisely the two that had started dying. An
 * operator repair tool that cannot name the broken thing is worse than none, because it
 * reads as "nothing dead to requeue". Deriving it means a new kind is requeueable the day
 * the schema gains it.
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

  // Grouped so the operator sees what they are reviving, not just a count. A dead job with
  // an error nobody recognises is a reason to stop, not to retry harder.
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
