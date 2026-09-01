-- Bytes per unit area, per slice. `:box_*` bound a fixture tile; the whole-table ratio carries
-- index and page overhead onto the per-tile row bytes, which `pg_column_size` alone omits.
\set ON_ERROR_STOP on

WITH box AS (
  SELECT ST_MakeEnvelope(:box_w, :box_s, :box_e, :box_n, 4326) AS g
),
area AS (
  SELECT ST_Area(g::geography) / 1e6 AS km2 FROM box
),
totals AS (
  SELECT 'trail_way' AS slice_table,
         pg_total_relation_size('osm.trail_way'::regclass) AS total_bytes,
         (SELECT sum(pg_column_size(t.*)) FROM osm.trail_way t) AS row_bytes,
         (SELECT sum(pg_column_size(t.*)) FROM osm.trail_way t, box WHERE t.geom && box.g) AS box_row_bytes,
         (SELECT count(*) FROM osm.trail_way t, box WHERE t.geom && box.g) AS box_rows
  UNION ALL
  SELECT 'trail_relation',
         pg_total_relation_size('osm.trail_relation'::regclass),
         (SELECT sum(pg_column_size(t.*)) FROM osm.trail_relation t),
         (SELECT sum(pg_column_size(t.*)) FROM osm.trail_relation t, box WHERE t.geom && box.g),
         (SELECT count(*) FROM osm.trail_relation t, box WHERE t.geom && box.g)
  UNION ALL
  SELECT 'network_way',
         pg_total_relation_size('osm.network_way'::regclass),
         (SELECT sum(pg_column_size(t.*)) FROM osm.network_way t),
         (SELECT sum(pg_column_size(t.*)) FROM osm.network_way t, box WHERE t.geom && box.g),
         (SELECT count(*) FROM osm.network_way t, box WHERE t.geom && box.g)
)
SELECT slice_table,
       total_bytes,
       box_rows,
       round((total_bytes::numeric / NULLIF(row_bytes, 0)), 3) AS overhead_factor,
       round(box_row_bytes * (total_bytes::numeric / NULLIF(row_bytes, 0))) AS tile_bytes,
       round((SELECT km2 FROM area)::numeric, 1) AS tile_km2,
       round(box_row_bytes * (total_bytes::numeric / NULLIF(row_bytes, 0)) / (SELECT km2 FROM area)::numeric, 1) AS bytes_per_km2
FROM totals
ORDER BY slice_table;
