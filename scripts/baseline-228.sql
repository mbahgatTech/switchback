-- #254 baseline for issue #228, taken against the two tiles that actually split
-- (120230203, 120230212) while all 24 z10 children are still status='pending'
-- with fetchedAt IS NULL. Read-only.

\echo '=== B1: child ingest state — baseline is only valid while every row is pending/NULL ==='
select t.quadkey, t.z, t.status, t."fetchedAt", t.attempts, t."trailCount"
from ingest_tiles t
where t.quadkey like '120230203%' or t.quadkey like '120230212%'
order by t.quadkey;

\echo ''
\echo '=== B2: per-parent-tile trail population, by owning quadkey ==='
select t.quadkey,
       count(*)                                            as trails,
       count(distinct t.name)                              as distinct_names,
       count(*) filter (where t."osmType" = 'way')         as way_trails,
       count(*) filter (where t."osmType" = 'relation')    as relation_trails,
       sum(t."lengthM")                                    as total_length_m
from trails t
where t.quadkey in ('120230203', '120230212')
group by t.quadkey
order by t.quadkey;

\echo ''
\echo '=== B3: trails intersecting each parent box, regardless of owning quadkey ==='
select b.quadkey,
       count(*)                                         as trails_intersecting,
       count(distinct t.name)                           as distinct_names,
       count(*) filter (where t.quadkey <> b.quadkey)   as owned_by_another_tile
from (values
        ('120230203', 11.953125, 46.07323062540836, 12.65625,  46.55886030311718),
        ('120230212', 12.65625,  46.07323062540836, 13.359375, 46.55886030311718)
     ) as b(quadkey, w, s, e, n)
join trails t
  on t.geom && st_makeenvelope(b.w, b.s, b.e, b.n, 4326)
group by b.quadkey
order by b.quadkey;

\echo ''
\echo '=== B4: names already spanning the 120230203 | 120230212 seam (fragmentation today) ==='
select count(*) as seam_names
from (
  select t.name
  from trails t
  where t.quadkey in ('120230203', '120230212')
    and t.name <> ''
  group by t.name
  having count(distinct t.quadkey) > 1
) s;

\echo ''
\echo '=== B5: corpus-wide fragmentation — way-trails in a name group spanning >1 quadkey ==='
select count(*)                                                  as fragmented_way_trails,
       (select count(*) from trails where "osmType" = 'way')      as total_way_trails,
       round(100.0 * count(*)
             / nullif((select count(*) from trails where "osmType" = 'way'), 0), 1) as pct
from trails t
where t."osmType" = 'way'
  and t.name <> ''
  and exists (
    select 1 from trails o
    where o.name = t.name
      and o."osmType" = 'way'
      and o.quadkey is distinct from t.quadkey
      and o.quadkey is not null
  );

\echo ''
\echo '=== B6: corpus totals ==='
select count(*)                                             as trails,
       count(*) filter (where "osmType" = 'way')            as way,
       count(*) filter (where "osmType" = 'relation')       as relation,
       (select count(*) from waypoints)                     as waypoints
from trails;
