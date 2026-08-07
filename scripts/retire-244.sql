-- #244: retire the z10 debris left by the pre-merge subdivision runs.
--
-- Deletes only rows that are provably untouched — pending, never fetched, zero attempts, zero
-- trails — so a child that had actually ingested would be left behind and visible in the after
-- counts rather than silently dropped. One transaction; re-running it is a no-op.

begin;

\echo '=== BEFORE ==='
select (select count(*) from ingest_tiles where z = 10)                       as z10_tiles,
       (select count(*) from ingest_jobs
         where "dedupeKey" ~ ':[0-9]{10}$' and status = 'queued')             as z10_jobs,
       (select count(*) from trails where quadkey ~ '^[0-9]{10}$')            as trails_owned_by_z10;

delete from ingest_jobs
 where "dedupeKey" ~ ':[0-9]{10}$'
   and kind = 'ingest_tile'
   and status = 'queued'
   and attempts = 0
   and "lockedAt" is null;

delete from ingest_tiles
 where z = 10
   and status = 'pending'
   and "fetchedAt" is null
   and attempts = 0
   and "trailCount" = 0;

\echo ''
\echo '=== AFTER — any non-zero here is a child that had really ingested and was kept ==='
select (select count(*) from ingest_tiles where z = 10)                       as z10_tiles,
       (select count(*) from ingest_jobs
         where "dedupeKey" ~ ':[0-9]{10}$' and status = 'queued')             as z10_jobs,
       (select count(*) from trails where quadkey ~ '^[0-9]{10}$')            as trails_owned_by_z10;

\echo ''
\echo '=== The six parents are untouched and keep their own jobs ==='
select t.quadkey, t.status as tile_status, t.attempts as tile_attempts,
       j.status as job_status, j.attempts as job_attempts
from ingest_tiles t
left join ingest_jobs j on j."dedupeKey" = 'ingest_tile:' || t.quadkey
where t.quadkey in ('031313112','120221231','120230202','120230203','120230212','120230220')
order by t.quadkey;

commit;
