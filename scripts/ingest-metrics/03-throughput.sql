-- Ingest metrics 03 (Q3): real drain throughput — jobs and tiles finished per hour.
-- SELECT only: no write, no DDL.
--
-- Read this over recent hours. `enqueue` revives a finished row in place and clears `completedAt`,
-- so a job completed twice is only ever counted once, at its latest completion: the further back a
-- bucket sits, the more of its work has been overwritten by a later cycle, and every count here is
-- a lower bound for old buckets and exact for fresh ones. `ingest_tiles."fetchedAt"` carries the
-- same last-write-wins shape, which is why R4 exists — two independent undercounts that agree are
-- worth more than either alone.
--
-- Override the window with `-v win_hours=48`.

\if :{?win_hours}
\else
  \set win_hours 168
\endif

\echo '=== R1: jobs finished per hour, by kind, over the window ==='
select date_trunc('hour', "completedAt") at time zone 'utc'  as hour_utc,
       kind,
       count(*)                                              as finished,
       count(*) filter (where status = 'done')               as done,
       count(*) filter (where status = 'dead')               as dead
  from ingest_jobs
 where "completedAt" >= now() - (:'win_hours' || ' hours')::interval
 group by 1, 2
 order by 1 desc, 2;

\echo ''
\echo '=== R2: the headline rate — hourly throughput distribution over active hours ==='
-- Active hours only: an idle hour is not evidence about capacity, and averaging it in is how a
-- drain that runs for twenty minutes a day reports a rate an order of magnitude below its own.
select scope,
       count(*)                                                            as active_hours,
       min(n)                                                              as min_per_hour,
       round(percentile_cont(0.50) within group (order by n)::numeric, 1)  as p50_per_hour,
       round(percentile_cont(0.90) within group (order by n)::numeric, 1)  as p90_per_hour,
       max(n)                                                              as max_per_hour,
       round(avg(n)::numeric, 1)                                           as mean_per_hour,
       sum(n)                                                              as total
  from (
    select 'all jobs' as scope, date_trunc('hour', "completedAt") as h, count(*) as n
      from ingest_jobs
     where "completedAt" >= now() - (:'win_hours' || ' hours')::interval
     group by 1, 2
    union all
    select 'tile jobs (ingest_tile + refresh_tile)', date_trunc('hour', "completedAt"), count(*)
      from ingest_jobs
     where "completedAt" >= now() - (:'win_hours' || ' hours')::interval
       and kind in ('ingest_tile', 'refresh_tile')
     group by 1, 2
    union all
    select 'tile jobs that succeeded', date_trunc('hour', "completedAt"), count(*)
      from ingest_jobs
     where "completedAt" >= now() - (:'win_hours' || ' hours')::interval
       and kind in ('ingest_tile', 'refresh_tile') and status = 'done'
     group by 1, 2
  ) hourly
 group by scope
 order by scope;

\echo ''
\echo '=== R3: the same rate per day, so a burst is not mistaken for a rate ==='
select date_trunc('day', "completedAt") at time zone 'utc'            as day_utc,
       count(*)                                                        as jobs_finished,
       count(distinct date_trunc('hour', "completedAt"))               as active_hours,
       round(count(*)::numeric
             / nullif(count(distinct date_trunc('hour', "completedAt")), 0), 1)
                                                                       as per_active_hour,
       count(*) filter (where kind in ('ingest_tile', 'refresh_tile')) as tile_jobs
  from ingest_jobs
 where "completedAt" >= now() - interval '30 days'
 group by 1
 order by 1 desc;

\echo ''
\echo '=== R4: corroboration — tiles whose fetch landed, per hour, from ingest_tiles ==='
select date_trunc('hour', "fetchedAt") at time zone 'utc'     as hour_utc,
       count(*)                                                as tiles_fetched,
       sum("trailCount")                                       as trails,
       round(sum("fetchMs") / 1000.0, 1)                       as overpass_seconds,
       round(100.0 * sum("fetchMs") / (3600 * 1000.0), 1)      as pct_of_one_serial_hour
  from ingest_tiles
 where "fetchedAt" >= now() - (:'win_hours' || ' hours')::interval
 group by 1
 order by 1 desc;

\echo ''
\echo '=== R5: the ceiling the fetch time implies, against the rate observed ==='
-- `serial_tiles_per_hour` is 3600 divided by the mean successful fetch, which is what one drainer
-- at one request in flight could manage if nothing else cost anything. The measured rate above
-- must sit at or below it times the concurrency 02-drain-concurrency.sql reports.
select round(avg("fetchMs") / 1000.0, 1)                        as mean_fetch_s,
       round(percentile_cont(0.50) within group (order by "fetchMs")::numeric / 1000.0, 1)
                                                                as p50_fetch_s,
       round((3600000.0 / nullif(avg("fetchMs"), 0))::numeric, 1) as serial_tiles_per_hour,
       round((3600000.0 / nullif(percentile_cont(0.50) within group (order by "fetchMs"), 0))::numeric, 1)
                                                                as serial_tiles_per_hour_at_p50
  from ingest_tiles
 where "fetchMs" is not null
   and ("lastError" is null or "lastError" not like 'split into %');
