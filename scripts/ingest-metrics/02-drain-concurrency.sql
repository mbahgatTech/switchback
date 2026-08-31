-- Ingest metrics 02 (Q2): the drain concurrency actually achieved, not the invocation count.
-- SELECT only: no write, no DDL.
--
-- `lockedAt` and `completedAt` bound one drain and survive the outcome — `writeOutcome` fences on
-- `status`, so the status change releases the lease and the pair stays as the record of who ran the
-- work. Concurrency is therefore a question about overlapping intervals, and D1 is the sweep line
-- `docs/architecture.md` carries, verbatim. `INGEST_MAX_DRAINERS` is the bound it must not exceed.
--
-- D1-D3 count only kinds that reach an Overpass mirror, because that is all the bound covers:
-- `enrich_trail` fetches Wikimedia and Mapillary and drains beside a tile by design. The filter
-- mirrors `OVERPASS_FREE_JOB_KINDS` in `packages/ingest/src/backpressure.ts` and must follow it.
-- D4 and D6 stay unfiltered — they answer what ran, not what the bound allows.
--
-- Two limits are load-bearing. A row revived by `enqueue` has its `completedAt` cleared, so only
-- the most recent drain of each dedupeKey is visible: read this over hours, not months. And a job
-- still `running` contributes no end edge, so an open lease is invisible here — D5 counts those.
--
-- Override the window with `-v win_hours=24`.

\if :{?win_hours}
\else
  \set win_hours 1
\endif

\echo '=== D1: peak concurrent drains in the window (docs/architecture.md, verbatim shape) ==='
select :'win_hours' as window_hours,
       max(concurrent) as peak
  from (
    select sum(delta) over (order by at, delta desc) as concurrent
      from (select "lockedAt" as at, 1 as delta from ingest_jobs
             where "completedAt" >= now() - (:'win_hours' || ' hours')::interval
               and "lockedAt" is not null and kind <> 'enrich_trail'
            union all
            select "completedAt" as at, -1 from ingest_jobs
             where "completedAt" >= now() - (:'win_hours' || ' hours')::interval
               and "lockedAt" is not null and kind <> 'enrich_trail') edges
  ) swept;

\echo ''
\echo '=== D2: peak per day over the last 30 days ==='
select day, max(concurrent) as peak, count(*) as lease_edges
  from (
    select date_trunc('day', at) as day,
           sum(delta) over (partition by date_trunc('day', at) order by at, delta desc) as concurrent
      from (select "lockedAt" as at, 1 as delta from ingest_jobs
             where "completedAt" >= now() - interval '30 days' and "lockedAt" is not null
               and kind <> 'enrich_trail'
            union all
            select "completedAt" as at, -1 from ingest_jobs
             where "completedAt" >= now() - interval '30 days' and "lockedAt" is not null
               and kind <> 'enrich_trail') edges
  ) swept
 group by day
 order by day;

\echo ''
\echo '=== D3: time spent at each concurrency level in the window ==='
-- A peak of 2 held for one second is a different system from a peak of 2 held for an hour, and
-- only the time-weighted view tells them apart. `seconds` sums the gaps between successive edges.
with edges as (
  select "lockedAt" as at, 1 as delta from ingest_jobs
   where "completedAt" >= now() - (:'win_hours' || ' hours')::interval and "lockedAt" is not null
     and kind <> 'enrich_trail'
  union all
  select "completedAt" as at, -1 from ingest_jobs
   where "completedAt" >= now() - (:'win_hours' || ' hours')::interval and "lockedAt" is not null
     and kind <> 'enrich_trail'
), swept as (
  select at,
         sum(delta) over (order by at, delta desc)  as concurrent,
         lead(at)   over (order by at, delta desc)  as next_at
    from edges
)
select concurrent,
       count(*)                                                     as intervals,
       round(sum(extract(epoch from (next_at - at)))::numeric, 1)   as seconds,
       round(100.0 * sum(extract(epoch from (next_at - at)))::numeric
             / nullif(sum(sum(extract(epoch from (next_at - at)))::numeric) over (), 0), 1) as pct_of_span
  from swept
 where next_at is not null
 group by concurrent
 order by concurrent;

\echo ''
\echo '=== D4: which processes drained, and how much each ran (last 24h and last 7d) ==='
select '24h' as window, "lockedBy", count(*) as jobs,
       min("lockedAt")   at time zone 'utc' as first_lock,
       max("completedAt") at time zone 'utc' as last_complete
  from ingest_jobs
 where "completedAt" >= now() - interval '24 hours'
 group by 1, 2
union all
select '7d', "lockedBy", count(*),
       min("lockedAt")    at time zone 'utc',
       max("completedAt") at time zone 'utc'
  from ingest_jobs
 where "completedAt" >= now() - interval '7 days'
 group by 1, 2
 order by 1, 3 desc;

\echo ''
\echo '=== D5: open leases right now — invisible to the sweep above ==='
select count(*)                                                                  as running_rows,
       count(*) filter (where "lockedAt" < now() - interval '12 minutes')         as past_lease_timeout,
       min("lockedAt") at time zone 'utc'                                         as oldest_lock,
       string_agg(distinct "lockedBy", ', ')                                      as holders
  from ingest_jobs
 where status = 'running';

\echo ''
\echo '=== D6: lease duration distribution, by kind, over the last 7 days ==='
-- The service time one drain actually costs. Multiplied by the concurrency above it gives the
-- theoretical throughput ceiling to check 03-throughput.sql against.
select kind,
       count(*)                                                                       as drains,
       round(percentile_cont(0.50) within group (order by secs)::numeric, 1)          as p50_s,
       round(percentile_cont(0.90) within group (order by secs)::numeric, 1)          as p90_s,
       round(percentile_cont(0.99) within group (order by secs)::numeric, 1)          as p99_s,
       round(max(secs)::numeric, 1)                                                   as max_s,
       round(avg(secs)::numeric, 1)                                                   as mean_s
  from (select kind, extract(epoch from ("completedAt" - "lockedAt")) as secs
          from ingest_jobs
         where "completedAt" >= now() - interval '7 days'
           and "lockedAt" is not null
           and "completedAt" > "lockedAt") d
 group by kind
 order by drains desc;
