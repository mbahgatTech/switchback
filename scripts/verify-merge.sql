-- Validates the mergeTrailGeometry primitive against real fragmented pairs.
-- SELECT only: no write, no DDL.

\echo '=== M1: fragmented way-trail pairs — concatenation vs geometric union ==='
with pairs as (
  select a.id as a_id, b.id as b_id, a.name,
         a.quadkey as a_qk, b.quadkey as b_qk,
         a."lengthM" as a_len, b."lengthM" as b_len,
         st_linemerge(st_unaryunion(st_collect(a.geom, b.geom))) as merged
  from trails a
  join trails b
    on b.name = a.name
   and b."osmType" = 'way'
   and a."osmType" = 'way'
   and b.quadkey is distinct from a.quadkey
   and b.id > a.id
   and st_dwithin(a.geom::geography, b.geom::geography, 50)
  where a.name <> ''
  limit 400
)
select geometrytype(merged)                                  as merged_type,
       count(*)                                              as pairs,
       round(avg(a_len + b_len))                             as avg_concat_m,
       round(avg(st_length(merged::geography))::numeric)     as avg_union_m,
       round(avg(a_len + b_len - st_length(merged::geography))::numeric) as avg_overstate_m
from pairs
group by 1
order by 2 desc;

\echo ''
\echo '=== M2: the exact expression mergeTrailGeometry runs, on one real pair ==='
with pairs as (
  select a.id as a_id, b.id as b_id, a.name, a."lengthM" as a_len, b."lengthM" as b_len
  from trails a
  join trails b
    on b.name = a.name
   and b."osmType" = 'way' and a."osmType" = 'way'
   and b.quadkey is distinct from a.quadkey
   and b.id > a.id
   and st_dwithin(a.geom::geography, b.geom::geography, 50)
  where a.name <> ''
  order by a."lengthM" + b."lengthM" desc
  limit 1
),
merged as (
  select p.name, p.a_len, p.b_len,
         st_linemerge(st_unaryunion(st_collect(ta.geom, tb.geom))) as g
  from pairs p join trails ta on ta.id = p.a_id join trails tb on tb.id = p.b_id
),
longest as (
  select name, a_len, b_len,
         case when geometrytype(g) = 'MULTILINESTRING'
              then (select d.geom from st_dump(g) d order by st_length(d.geom::geography) desc limit 1)
              else g end as g
  from merged
)
select name,
       a_len, b_len, a_len + b_len            as concatenated_m,
       round(st_length(g::geography)::numeric) as union_m,
       geometrytype(g)                         as result_type,
       st_npoints(g)                           as vertices
from longest;
