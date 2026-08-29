-- Ingest metrics 05 (Q5): what actually fails, in what proportion.
-- SELECT only: no write, no DDL.
--
-- The buckets below are the literal messages the code writes, not guesses:
--   deadline          `IngestDeadlineError`   packages/ingest/src/deadline.ts
--   lease expired     `reclaimExpiredJobs`    packages/ingest/src/jobs.ts
--   breaker open      `OverpassUnavailableError`, overpass.ts
--   overpass status   `Overpass <status> from <endpoint>`, overpass.ts
--   overpass remark   `Overpass reported "<remark>" from <endpoint>`, overpass.ts
--   overpass budget   `Overpass gave up after <n> ms`, overpass.ts
--   split marker      `split into <n> tiles at z<n>`, subdivide.ts (tiles only, not a failure)
--   subtree stuck     `switchback-ingest-subtree-stuck`, subdivide.ts (tiles only)
--   deploy skew       `no handler registered for job kind "<kind>"`, jobs.ts (a defer, not a fail)
--
-- **Claim conflicts are not in this table.** `writeOutcome` returns false when a lease has already
-- been reclaimed and `drainJobs` counts that as `lost` in its own log line; nothing is written to
-- the row. The database-side trace of the same event is a stale lease — F5 — and the
-- `lease expired` bucket that the reaper leaves behind afterwards.
--
-- `lastError` is not cleared on a retry: a `queued` row carries the reason its last attempt failed.
-- Every section therefore reports `status` beside the bucket, because a bucket on a `done` row is
-- history and the same bucket on a `dead` row is a live failure.

\echo '=== F1: ingest_jobs failure taxonomy, by status ==='
select case
         when "lastError" is null                                              then 'z. none'
         when "lastError" like 'ingest deadline for this invocation%'          then 'a. deadline kill'
         when "lastError" like 'lease expired after%'                          then 'b. lease expired (worker lost)'
         when "lastError" like 'Overpass circuit breaker open%'                then 'c. overpass breaker open'
         when "lastError" like 'Overpass 429%' or "lastError" like '%429%'     then 'd. overpass rate limited (429)'
         when "lastError" ~ '^Overpass [0-9]{3} from '                         then 'e. overpass http status'
         when "lastError" like 'Overpass reported%'                            then 'f. overpass remark'
         when "lastError" like 'Overpass gave up after%'                       then 'g. overpass total budget spent'
         when "lastError" like 'Overpass returned unparseable JSON%'           then 'h. overpass unparseable'
         when "lastError" like 'Overpass request failed%'                      then 'i. overpass unclassified'
         when "lastError" like 'http%'                                         then 'j. transport error at a mirror'
         when "lastError" like 'no handler registered for job kind%'           then 'k. deploy skew (deferred)'
         when "lastError" like 'job payload missing%'                          then 'l. malformed payload'
         when "lastError" like 'terrain tile%'                                 then 'm. terrain fetch'
         when "lastError" like '%failed to commit'                             then 'n. trail commit'
         else                                                                       'y. unclassified'
       end                                                        as bucket,
       count(*)                                                   as jobs,
       count(*) filter (where status = 'dead')                    as dead,
       count(*) filter (where status = 'queued')                  as queued,
       count(*) filter (where status = 'running')                 as running,
       count(*) filter (where status = 'done')                    as done,
       round(100.0 * count(*) / sum(count(*)) over (), 1)         as pct
  from ingest_jobs
 group by 1
 order by 1;

\echo ''
\echo '=== F2: the same taxonomy for ingest_tiles ==='
select case
         when "lastError" is null                                              then 'z. none'
         when "lastError" like 'split into %'                                  then 'A. split marker (not a failure)'
         when "lastError" like '%switchback-ingest-subtree-stuck%'             then 'B. subtree stuck'
         when "lastError" like 'ingest deadline for this invocation%'          then 'a. deadline kill'
         when "lastError" like 'Overpass circuit breaker open%'                then 'c. overpass breaker open'
         when "lastError" like '%429%'                                         then 'd. overpass rate limited (429)'
         when "lastError" ~ '^Overpass [0-9]{3} from '                         then 'e. overpass http status'
         when "lastError" like 'Overpass reported%'                            then 'f. overpass remark'
         when "lastError" like 'Overpass gave up after%'                       then 'g. overpass total budget spent'
         when "lastError" like 'Overpass returned unparseable JSON%'           then 'h. overpass unparseable'
         when "lastError" like 'http%'                                         then 'j. transport error at a mirror'
         when "lastError" like '%failed to commit'                             then 'n. trail commit'
         else                                                                       'y. unclassified'
       end                                                        as bucket,
       count(*)                                                   as tiles,
       count(*) filter (where status = 'failed')                  as failed,
       count(*) filter (where status = 'ready')                   as ready,
       count(*) filter (where status = 'empty')                   as empty,
       count(*) filter (where status = 'pending')                 as pending,
       count(*) filter (where status = 'running')                 as running,
       round(100.0 * count(*) / sum(count(*)) over (), 1)         as pct
  from ingest_tiles
 group by 1
 order by 1;

\echo ''
\echo '=== F3: every distinct message, normalised — the check on F1 and F2 ==='
-- Digits and URLs collapsed so one message with a thousand variants groups as one row. Read this
-- against F1 and F2: a frequent message here with no bucket above means the taxonomy is incomplete.
select relation, sample, count(*) as rows
  from (
    select 'ingest_jobs' as relation,
           left(regexp_replace(regexp_replace("lastError", 'https?://[^ ]+', 'URL', 'g'),
                               '[0-9]+', 'N', 'g'), 120) as sample
      from ingest_jobs
     where "lastError" is not null
    union all
    select 'ingest_tiles',
           left(regexp_replace(regexp_replace("lastError", 'https?://[^ ]+', 'URL', 'g'),
                               '[0-9]+', 'N', 'g'), 120)
      from ingest_tiles
     where "lastError" is not null
  ) normalised
 group by relation, sample
 order by rows desc
 limit 40;

\echo ''
\echo '=== F4: the four counts the question asks for outright ==='
select (select count(*) from ingest_jobs  where status = 'dead')                        as jobs_dead_now,
       (select count(*) from ingest_tiles where "lastError" like 'split into %')         as tiles_with_split_marker,
       (select count(*) from ingest_tiles where "lastError" like '%switchback-ingest-subtree-stuck%')
                                                                                         as tiles_subtree_stuck,
       (select count(*) from ingest_jobs  where status = 'running'
                                            and "lockedAt" < now() - interval '12 minutes')
                                                                                         as stale_leases;

\echo ''
\echo '=== F5: dead jobs — when they died, and of what ==='
select date_trunc('day', "completedAt") at time zone 'utc'   as died_on_utc,
       kind,
       count(*)                                              as dead,
       left(min("lastError"), 90)                            as sample_error
  from ingest_jobs
 where status = 'dead'
 group by 1, 2
 order by 1 desc nulls last, 3 desc;

\echo ''
\echo '=== F6: attempts spent, by kind and status ==='
-- `maxAttempts` is 5. A `dead` row at fewer than 5 attempts was retired by the reaper's double
-- increment rather than by exhausting the ladder honestly, which is a different failure mode.
select kind, status,
       count(*)                                  as jobs,
       round(avg(attempts)::numeric, 2)          as mean_attempts,
       max(attempts)                             as max_attempts_seen,
       count(*) filter (where attempts >= 5)     as at_or_past_ladder
  from ingest_jobs
 group by kind, status
 order by kind, status;
