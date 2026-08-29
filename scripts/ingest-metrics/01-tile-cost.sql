-- Ingest metrics 01 (Q1): what a tile costs, and how that cost scales with what is in it.
-- SELECT only: no write, no DDL.
--
-- `ingest_tiles."fetchMs"` is written on two different events and they must not be pooled:
--   * `processTile` writes the Overpass wall clock of a *successful* fetch;
--   * `splitTile` writes the wall clock of the invocation that ran out of clock and subdivided.
-- The second is a censored observation — the tile cost at least that much, and the true figure is
-- unknown — so every section below separates them on the split marker in `lastError`.

\echo '=== T1: fetchMs percentiles, successful fetches only, by zoom ==='
select length(quadkey)                                                          as z,
       count(*)                                                                 as tiles,
       min("fetchMs")                                                           as min_ms,
       round(percentile_cont(0.50) within group (order by "fetchMs")::numeric)  as p50_ms,
       round(percentile_cont(0.75) within group (order by "fetchMs")::numeric)  as p75_ms,
       round(percentile_cont(0.90) within group (order by "fetchMs")::numeric)  as p90_ms,
       round(percentile_cont(0.95) within group (order by "fetchMs")::numeric)  as p95_ms,
       round(percentile_cont(0.99) within group (order by "fetchMs")::numeric)  as p99_ms,
       max("fetchMs")                                                           as max_ms,
       round(avg("fetchMs")::numeric)                                           as mean_ms
  from ingest_tiles
 where "fetchMs" is not null
   and ("lastError" is null or "lastError" not like 'split into %')
 group by rollup (length(quadkey))
 order by 1 nulls last;

\echo ''
\echo '=== T2: the same percentiles for tiles that ran out of clock and split (censored) ==='
select count(*)                                                                 as split_tiles,
       round(percentile_cont(0.50) within group (order by "fetchMs")::numeric)  as p50_ms,
       round(percentile_cont(0.95) within group (order by "fetchMs")::numeric)  as p95_ms,
       max("fetchMs")                                                           as max_ms
  from ingest_tiles
 where "fetchMs" is not null and "lastError" like 'split into %';

\echo ''
\echo '=== T3: trailCount distribution across every settled tile ==='
select case when "trailCount" = 0                  then 'a. 0'
            when "trailCount" between 1   and 9    then 'b. 1-9'
            when "trailCount" between 10  and 49   then 'c. 10-49'
            when "trailCount" between 50  and 99   then 'd. 50-99'
            when "trailCount" between 100 and 249  then 'e. 100-249'
            when "trailCount" between 250 and 499  then 'f. 250-499'
            when "trailCount" between 500 and 999  then 'g. 500-999'
            else                                        'h. 1000+'
       end                                                                      as trail_bucket,
       count(*)                                                                 as tiles,
       round(100.0 * count(*) / sum(count(*)) over (), 1)                       as pct_of_tiles,
       sum("trailCount")                                                        as trails,
       round(100.0 * sum("trailCount") / nullif(sum(sum("trailCount")) over (), 0), 1)
                                                                                as pct_of_trails
  from ingest_tiles
 where status in ('ready', 'empty')
 group by 1
 order by 1;

\echo ''
\echo '=== T4: the cross-tabulation — fetch cost by trailCount bucket ==='
-- `ms_per_trail` is the linearity test read directly: flat across buckets means linear, rising
-- means super-linear, falling means a fixed overhead that dominates small tiles.
select case when "trailCount" = 0                  then 'a. 0'
            when "trailCount" between 1   and 9    then 'b. 1-9'
            when "trailCount" between 10  and 49   then 'c. 10-49'
            when "trailCount" between 50  and 99   then 'd. 50-99'
            when "trailCount" between 100 and 249  then 'e. 100-249'
            when "trailCount" between 250 and 499  then 'f. 250-499'
            when "trailCount" between 500 and 999  then 'g. 500-999'
            else                                        'h. 1000+'
       end                                                                      as trail_bucket,
       count(*)                                                                 as tiles,
       round(avg("trailCount")::numeric, 1)                                     as mean_trails,
       round(percentile_cont(0.50) within group (order by "fetchMs")::numeric)  as p50_ms,
       round(percentile_cont(0.90) within group (order by "fetchMs")::numeric)  as p90_ms,
       max("fetchMs")                                                           as max_ms,
       round((avg("fetchMs") / nullif(avg("trailCount"), 0))::numeric, 1)       as ms_per_trail
  from ingest_tiles
 where "fetchMs" is not null
   and ("lastError" is null or "lastError" not like 'split into %')
 group by 1
 order by 1;

\echo ''
\echo '=== T5: regression — is fetchMs linear in trailCount? ==='
-- The first four columns fit fetchMs = slope * trails + intercept. `loglog_exponent` fits
-- fetchMs ~ trails^k over the tiles where both are positive: k near 1 is linear, k above 1 is not.
select count(*)                                                  as n,
       round(corr("fetchMs", "trailCount")::numeric, 3)          as pearson_r,
       round(regr_slope("fetchMs", "trailCount")::numeric, 2)    as slope_ms_per_trail,
       round(regr_intercept("fetchMs", "trailCount")::numeric)   as intercept_ms,
       round(regr_r2("fetchMs", "trailCount")::numeric, 3)       as r_squared,
       round((select regr_slope(ln("fetchMs"), ln("trailCount"))
                from ingest_tiles
               where "fetchMs" > 0 and "trailCount" > 0
                 and ("lastError" is null or "lastError" not like 'split into %'))::numeric, 3)
                                                                 as loglog_exponent
  from ingest_tiles
 where "fetchMs" is not null
   and ("lastError" is null or "lastError" not like 'split into %');

\echo ''
\echo '=== T6: where the tail starts — fetchMs decile boundaries ==='
select decile,
       min("fetchMs")    as floor_ms,
       max("fetchMs")    as ceiling_ms,
       count(*)          as tiles,
       max("trailCount") as max_trails
  from (select "fetchMs", "trailCount",
               ntile(10) over (order by "fetchMs") as decile
          from ingest_tiles
         where "fetchMs" is not null
           and ("lastError" is null or "lastError" not like 'split into %')) ranked
 group by decile
 order by decile;

\echo ''
\echo '=== T7: how many tiles are dense, against three candidate thresholds ==='
-- 60s is a tenth of the host kill deadline; 190s is `OVERPASS_MAX_TOTAL_MS`, the point past which
-- one query has spent its whole retry budget; 540s is 90% of `functionTimeout`.
select count(*)                                                as tiles_with_a_fetch,
       count(*) filter (where "fetchMs" >=  60000)             as over_60s,
       count(*) filter (where "fetchMs" >= 190000)             as over_190s,
       count(*) filter (where "fetchMs" >= 540000)             as over_540s,
       count(*) filter (where "trailCount" >= 500)             as over_500_trails,
       count(*) filter (where "lastError" like 'split into %') as carried_split_marker
  from ingest_tiles
 where "fetchMs" is not null;

\echo ''
\echo '=== T8: the twenty most expensive tiles ==='
select quadkey,
       length(quadkey)                        as z,
       status,
       "trailCount",
       "fetchMs",
       attempts,
       "fetchedAt" at time zone 'utc'         as fetched_at_utc,
       left(coalesce("lastError", ''), 60)    as last_error
  from ingest_tiles
 where "fetchMs" is not null
 order by "fetchMs" desc
 limit 20;
