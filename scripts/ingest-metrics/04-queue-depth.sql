-- Ingest metrics 04 (Q4): queue depth now, queue depth historically, and what the backlog is worth
-- in hours. SELECT only: no write, no DDL.
--
-- `MAX_TILE_QUEUE_DEPTH` is 600 and `admitIngest` compares it against exactly one number: rows
-- whose `kind` is one of `ingest_tile`, `refresh_tile`, `ingest_network` and whose `status` is
-- `queued` or `running`. Q2 reproduces that number and nothing else; every other section is
-- context around it.
--
-- **A refusal leaves no row.** `admitIngest` returns `'queue-depth'` and writes a `console.warn`;
-- nothing is persisted. Whether ingest was ever actually refused is answerable only from the
-- drainer's logs — grep the Vercel runtime logs for `ingest refused: queue depth`. Q4 below
-- reconstructs when the ceiling *would* have been tripped, which is the nearest the database can
-- come and is not the same claim.

\echo '=== Q1: current depth, every kind against every status ==='
select kind,
       count(*) filter (where status = 'queued')  as queued,
       count(*) filter (where status = 'running') as running,
       count(*) filter (where status = 'failed')  as failed,
       count(*) filter (where status = 'done')    as done,
       count(*) filter (where status = 'dead')    as dead,
       count(*)                                   as total
  from ingest_jobs
 group by rollup (kind)
 order by kind nulls last;

\echo ''
\echo '=== Q2: the number admitIngest actually compares to 600 ==='
select sum(case when kind in ('ingest_tile', 'refresh_tile', 'ingest_network') then 1 else 0 end)
                                                                       as request_depth,
       600                                                             as ceiling,
       round(100.0 * sum(case when kind in ('ingest_tile', 'refresh_tile', 'ingest_network')
                              then 1 else 0 end) / 600.0, 1)           as pct_of_ceiling,
       sum(case when kind in ('enrich_trail', 'ingest_route') then 1 else 0 end)
                                                                       as derived_depth,
       20000                                                           as derived_warn_depth
  from ingest_jobs
 where status in ('queued', 'running');

\echo ''
\echo '=== Q3: how old the backlog is ==='
select kind,
       count(*)                                                  as queued,
       count(*) filter (where "runAfter" <= now())               as due_now,
       min("runAfter")  at time zone 'utc'                       as oldest_due,
       min("createdAt") at time zone 'utc'                       as oldest_created,
       max("createdAt") at time zone 'utc'                       as newest_created
  from ingest_jobs
 where status = 'queued'
 group by kind
 order by queued desc;

\echo ''
\echo '=== Q4: reconstructed depth per day — request kinds only ==='
-- A sweep line over enqueue and completion edges. Two caveats, both of which make this a floor
-- rather than a reading: a row revived by `enqueue` keeps its original `createdAt` and loses its
-- old `completedAt`, so an earlier cycle contributes an unmatched +1; and rows deleted by hand
-- (`scripts/retire-244.sql` did exactly that) contribute neither edge.
with edges as (
  select "createdAt" as at, 1 as delta
    from ingest_jobs
   where kind in ('ingest_tile', 'refresh_tile', 'ingest_network')
  union all
  select "completedAt", -1
    from ingest_jobs
   where kind in ('ingest_tile', 'refresh_tile', 'ingest_network')
     and "completedAt" is not null
), swept as (
  select at, sum(delta) over (order by at, delta desc) as depth from edges
)
select date_trunc('day', at) at time zone 'utc'  as day_utc,
       max(depth)                                 as peak_depth,
       round(avg(depth))                          as mean_depth,
       min(depth)                                 as trough_depth,
       count(*)                                   as edges
  from swept
 group by 1
 order by 1 desc;

\echo ''
\echo '=== Q5: how close that reconstruction ever came to the ceiling ==='
with edges as (
  select "createdAt" as at, 1 as delta
    from ingest_jobs
   where kind in ('ingest_tile', 'refresh_tile', 'ingest_network')
  union all
  select "completedAt", -1
    from ingest_jobs
   where kind in ('ingest_tile', 'refresh_tile', 'ingest_network')
     and "completedAt" is not null
), swept as (
  select at, sum(delta) over (order by at, delta desc) as depth from edges
)
select max(depth)                                  as all_time_peak,
       min(at) filter (where depth >= 600) at time zone 'utc' as first_at_or_past_600,
       max(at) filter (where depth >= 600) at time zone 'utc' as last_at_or_past_600,
       count(*) filter (where depth >= 600)        as edges_at_or_past_600,
       count(*) filter (where depth >= 480)        as edges_past_80pct,
       count(distinct date_trunc('day', at)) filter (where depth >= 600) as days_at_or_past_600
  from swept;

\echo ''
\echo '=== Q6: the backlog in hours, at the rate the last seven days actually achieved ==='
-- `MAX_TILE_QUEUE_DEPTH` is documented as "roughly an hour of drain". This is that claim, checked:
-- request depth divided by the request-kind completion rate over active hours in the last week.
with rate as (
  select count(*)::numeric
         / nullif(count(distinct date_trunc('hour', "completedAt")), 0) as per_active_hour
    from ingest_jobs
   where "completedAt" >= now() - interval '7 days'
     and kind in ('ingest_tile', 'refresh_tile', 'ingest_network')
), depth as (
  select count(*) filter (where kind in ('ingest_tile', 'refresh_tile', 'ingest_network'))
                                                          as request_depth,
         count(*) filter (where kind in ('enrich_trail', 'ingest_route'))
                                                          as derived_depth
    from ingest_jobs
   where status in ('queued', 'running')
)
select depth.request_depth,
       depth.derived_depth,
       round(rate.per_active_hour, 1)                                          as request_jobs_per_active_hour,
       round(depth.request_depth / nullif(rate.per_active_hour, 0), 1)         as backlog_hours,
       round(600 / nullif(rate.per_active_hour, 0), 1)                         as hours_the_600_ceiling_buys
  from depth, rate;
