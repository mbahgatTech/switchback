-- Ingest metrics 06 (Q6): the split-and-redo cycle — how often it happens, whether the children
-- land, and what the cycle costs. SELECT only: no write, no DDL.
--
-- Subdivision replaces a z9 parent with its four z10 children. The parent keeps its row, carries
-- `lastError = 'split into 4 tiles at z10'`, and cannot go `ready` until `rollUp` sees all four
-- children settled. A quadkey is a prefix code, so `child.quadkey LIKE parent.quadkey || '_'` is a
-- range scan on the primary key and needs no second column.
--
-- Subdivision is gated: `subdivideMaxZoom` returns `INGEST_ZOOM` — disabling splits — unless
-- `INGEST_SUBDIVIDE_MAX_ZOOM` is set past 9 *and* `INGEST_TRAIL_IDENTITY` is `claim`. An empty S1
-- means the gate is shut, not that dense tiles do not exist.

\echo '=== S1: the tile table by zoom ==='
select length(quadkey)                                        as z,
       count(*)                                               as tiles,
       count(*) filter (where status = 'ready')               as ready,
       count(*) filter (where status = 'empty')               as empty,
       count(*) filter (where status = 'pending')             as pending,
       count(*) filter (where status = 'running')             as running,
       count(*) filter (where status = 'failed')              as failed,
       sum("trailCount")                                      as trails
  from ingest_tiles
 group by 1
 order by 1;

\echo ''
\echo '=== S2: parents carrying a split marker, and what became of them ==='
select status                                                 as parent_status,
       count(*)                                               as parents,
       round(avg("fetchMs") / 1000.0, 1)                      as mean_parent_fetch_s,
       min("createdAt") at time zone 'utc'                    as oldest,
       max("updatedAt") at time zone 'utc'                    as latest_touch
  from ingest_tiles
 where "lastError" like 'split into %'
 group by status
 order by parents desc;

\echo ''
\echo '=== S3: per parent — do the children actually land? ==='
select parent.quadkey,
       parent.status                                                          as parent_status,
       parent."trailCount"                                                    as parent_trails,
       round(parent."fetchMs" / 1000.0, 1)                                    as parent_fetch_s,
       count(child.quadkey)                                                   as children,
       count(child.quadkey) filter (where child.status in ('ready', 'empty')) as settled,
       count(child.quadkey) filter (where child.status = 'failed')            as failed,
       count(child.quadkey) filter (where child.status = 'pending')           as pending,
       sum(child."trailCount")                                                as child_trails,
       round(sum(child."fetchMs") / 1000.0, 1)                                as child_fetch_s,
       max(child.attempts)                                                    as worst_child_attempts
  from ingest_tiles parent
  left join ingest_tiles child
    on child.quadkey like parent.quadkey || '_'
 where parent."lastError" like 'split into %'
 group by parent.quadkey, parent.status, parent."trailCount", parent."fetchMs"
 order by parent.quadkey;

\echo ''
\echo '=== S4: orphaned splits — the predicate countOrphanedSplits sweeps on ==='
-- The marker alone is not distress: a parent midway through a legitimate subdivision carries it for
-- as long as its four children take. Orphanhood is the marker *and* an incomplete child set.
select count(*) filter (where children = 4)                   as complete_child_sets,
       count(*) filter (where children <> 4)                  as orphaned,
       count(*)                                               as marked_parents
  from (select parent.quadkey,
               (select count(*) from ingest_tiles child
                 where child.quadkey like parent.quadkey || '_') as children
          from ingest_tiles parent
         where parent."lastError" like 'split into %') marked;

\echo ''
\echo '=== S5: child outcomes in aggregate — did splitting work? ==='
select case when status in ('ready', 'empty') then 'settled'
            when status = 'failed'            then 'failed'
            else                                   status::text
       end                                                    as outcome,
       count(*)                                               as child_tiles,
       round(100.0 * count(*) / sum(count(*)) over (), 1)     as pct,
       round(avg("fetchMs") / 1000.0, 1)                      as mean_fetch_s,
       round(avg(attempts)::numeric, 2)                       as mean_attempts,
       sum("trailCount")                                      as trails
  from ingest_tiles
 where length(quadkey) > 9
 group by 1
 order by child_tiles desc;

\echo ''
\echo '=== S6: what the cycle cost — parent invocations thrown away against child work done ==='
-- `parent_fetch_s` is Overpass time spent on invocations that produced no tile: the parent ran out
-- of clock, subdivided, and its own fetch bought nothing but the decision to split.
select (select round(sum("fetchMs") / 1000.0, 1) from ingest_tiles
         where "lastError" like 'split into %')                        as parent_fetch_s_discarded,
       (select count(*) from ingest_tiles where "lastError" like 'split into %')
                                                                       as parents_split,
       (select round(sum("fetchMs") / 1000.0, 1) from ingest_tiles where length(quadkey) > 9)
                                                                       as child_fetch_s,
       (select count(*) from ingest_tiles where length(quadkey) > 9)   as child_tiles,
       (select count(*) from ingest_jobs
         where kind = 'ingest_tile' and length(payload->>'quadkey') > 9)
                                                                       as child_jobs,
       (select count(*) from ingest_jobs
         where kind = 'ingest_tile' and length(payload->>'quadkey') > 9 and status = 'dead')
                                                                       as child_jobs_dead;

\echo ''
\echo '=== S7: trails owned below z9 — the corpus effect of splitting ==='
-- A split cuts fresh interior seam and a seam fragments any trail crossing it unless `TrailWay` is
-- deciding identity. This is the count that says whether that has happened yet.
select length(quadkey)  as owning_z,
       count(*)         as trails
  from trails
 group by 1
 order by 1;
