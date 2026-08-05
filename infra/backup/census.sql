-- A fingerprint of a Switchback database, designed so that two runs of this file against two
-- databases holding the same data produce byte-identical output. `diff` is then the whole
-- comparison, which is why nothing here prints a version, a hostname or a timestamp.
--
-- Run it with `psql -tAq -f census.sql`, inside a transaction. Against production that
-- transaction imports pg_dump's exported snapshot, so the census describes exactly the rows
-- the dump contains rather than the rows that existed a minute later.
--
-- Every line is `kind|…`. Raw rather than hashed wherever the value is small enough to read,
-- because a diff that says which index is missing is worth more than one that says a hash
-- moved. The only hash is the per-table row digest, where raw is 26,000 lines.
--
-- Nothing here writes, and nothing here prints a row of user data.

-- Rendering settings that a row digest depends on. Both sides are PostgreSQL 17 today, so
-- these change nothing; they are pinned because the first time this file is pointed at a
-- different major version, an unpinned DateStyle would report every table as corrupt.
SET LOCAL extra_float_digits = 3;
SET LOCAL DateStyle = 'ISO, MDY';
SET LOCAL IntervalStyle = 'postgres';
SET LOCAL TimeZone = 'UTC';
SET LOCAL bytea_output = 'hex';
-- `public` is on the path so PostGIS functions resolve unqualified and, more importantly, so
-- pg_get_indexdef and format_type deparse operator classes the same way on both sides.
SET LOCAL search_path = pg_catalog, public;

-- Byte order versus dictionary order. A restore succeeds under either, which is what makes a
-- mismatch dangerous: `ORDER BY name` silently reorders and the partial unique index on
-- trail_lists is rebuilt under different rules.
SELECT 'db|collate|' || datcollate || '|' || datctype
  FROM pg_database
 WHERE datname = current_database();

-- Names only. Production runs PostGIS 3.6.1 and the rehearsal container 3.5, and the version
-- skew is recorded in the run log rather than asserted here.
SELECT 'ext|' || extname FROM pg_extension ORDER BY extname;

-- Owner and ACL per table. `sbapp` is the credential Vercel carries, and its grants are the
-- compensating control infra/azure/postgres.bicep names for a firewall spanning the internet.
-- A dump that has lost them restores an application that cannot serve a page.
SELECT 'tbl|' || c.relname || '|' || pg_get_userbyid(c.relowner) || '|' ||
       coalesce(array_to_string(c.relacl, ','), '-')
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r'
 ORDER BY c.relname;

-- Ordinal position is computed rather than read from attnum: a table that has ever had a
-- column dropped carries a gap on the source and none on a freshly restored copy, which would
-- report a flawless restore as a schema mismatch.
--
-- `not_null` rather than `notnull` for the alias: NOTNULL is a postfix operator in
-- PostgreSQL, so `notnull || '|'` is a syntax error rather than a column reference.
SELECT 'col|' || relname || '|' || pos || '|' || attname || '|' || typ || '|' || not_null || '|' || def
  FROM (
    SELECT c.relname,
           row_number() OVER (PARTITION BY c.relname ORDER BY a.attnum) AS pos,
           a.attname,
           format_type(a.atttypid, a.atttypmod) AS typ,
           a.attnotnull::text AS not_null,
           coalesce(pg_get_expr(d.adbin, d.adrelid), '-') AS def
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
     WHERE n.nspname = 'public' AND c.relkind = 'r'
  ) s
 ORDER BY relname, pos;

-- Definitions, not names. An index that rebuilt against the wrong operator class is present,
-- valid, and unused by the planner — 3,850 ms versus 178 ms on /nearby, and invisible to a
-- row count.
SELECT 'idx|' || tablename || '|' || indexname || '|' || indexdef
  FROM pg_indexes
 WHERE schemaname = 'public'
 ORDER BY tablename, indexname;

SELECT 'idxinvalid|' || count(*)::text
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indexrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND NOT i.indisvalid;

-- Primary keys, uniques, checks and foreign keys in one list. Foreign keys are the ones that
-- prove pg_restore's post-data section actually ran.
SELECT 'con|' || rel.relname || '|' || con.conname || '|' || con.contype::text || '|' ||
       pg_get_constraintdef(con.oid)
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = con.connamespace
 WHERE n.nspname = 'public'
 ORDER BY rel.relname, con.conname;

SELECT 'seq|' || c.relname
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'S'
 ORDER BY c.relname;

-- Geometry, read through PostGIS rather than as bytes. The row digests below already compare
-- the stored geometry byte for byte; these lines exist so that a failure names the damage.
--
-- Lengths are rounded per row and summed as numeric, not summed as float and rounded. A
-- restore changes the physical order of the table, float addition is not associative, and an
-- order-dependent total would drift on a perfect restore.
SELECT 'geo|trails|not_null|' || count(geom)::text FROM public.trails;
SELECT 'geo|trails|null|' || (count(*) FILTER (WHERE geom IS NULL))::text FROM public.trails;
SELECT 'geo|trails|npoints|' || coalesce(sum(ST_NPoints(geom)), 0)::text FROM public.trails;
SELECT 'geo|trails|length_m|' ||
       coalesce(sum(round(ST_Length(geom::geography)::numeric, 3)), 0)::text
  FROM public.trails;
-- A lost SRID is the classic dump/restore casualty: every row count stays perfect and every
-- ::geography cast silently computes the wrong distance.
SELECT 'geo|trails|srids|' ||
       coalesce(array_to_string(array_agg(DISTINCT ST_SRID(geom) ORDER BY ST_SRID(geom)), ','), '-')
  FROM public.trails
 WHERE geom IS NOT NULL;

SELECT 'geo|activities|not_null|' || count(geom)::text FROM public.activities;
SELECT 'geo|activities|null|' || (count(*) FILTER (WHERE geom IS NULL))::text FROM public.activities;
SELECT 'geo|activities|npoints|' || coalesce(sum(ST_NPoints(geom)), 0)::text FROM public.activities;
SELECT 'geo|activities|srids|' ||
       coalesce(array_to_string(array_agg(DISTINCT ST_SRID(geom) ORDER BY ST_SRID(geom)), ','), '-')
  FROM public.activities
 WHERE geom IS NOT NULL;

SELECT 'geo|waypoints|not_null|' || count(point)::text FROM public.waypoints;
SELECT 'geo|waypoints|null|' || (count(*) FILTER (WHERE point IS NULL))::text FROM public.waypoints;
SELECT 'geo|waypoints|npoints|' || coalesce(sum(ST_NPoints(point)), 0)::text FROM public.waypoints;
SELECT 'geo|waypoints|srids|' ||
       coalesce(array_to_string(array_agg(DISTINCT ST_SRID(point) ORDER BY ST_SRID(point)), ','), '-')
  FROM public.waypoints
 WHERE point IS NOT NULL;

-- spatial_ref_sys, which is not one table but two things wearing one name.
--
-- PostGIS registers it with pg_extension_config_dump under a filter — measured, not assumed:
-- `WHERE NOT (srid BETWEEN 2000 AND 2217 OR …)`, several hundred ranges long. So pg_dump
-- carries only the rows *outside* the catalogue that PostGIS itself ships, and `CREATE
-- EXTENSION postgis` on the restore side supplies the rest. Two consequences this file is
-- built around:
--
--   * Comparing the whole table across two PostGIS builds compares their shipped catalogues,
--     which says nothing about the backup. 3.6.1 and 3.5 legitimately disagree.
--   * The rows outside that catalogue are the only ones the backup is responsible for, and
--     they are compared byte for byte, below, using each side's own filter to identify them.
--
-- What a shipped SRID owes the data is existence, not a byte-identical definition: a geometry
-- whose SRID has no row here cannot be cast to geography at all, and every distance query in
-- the product does exactly that.
SELECT 'srs|used|' || u.srid || '|' || CASE WHEN s.srid IS NULL THEN 'MISSING' ELSE 'present' END
  FROM (
    SELECT DISTINCT ST_SRID(geom) AS srid FROM public.trails WHERE geom IS NOT NULL
    UNION
    SELECT DISTINCT ST_SRID(point) FROM public.waypoints WHERE point IS NOT NULL
    UNION
    SELECT DISTINCT ST_SRID(geom) FROM public.activities WHERE geom IS NOT NULL
  ) u
  LEFT JOIN public.spatial_ref_sys s ON s.srid = u.srid
 ORDER BY u.srid;

-- Every SRID somebody added by hand, with its definition. The filter is read from the
-- installed extension rather than restated here, so this selects exactly the set pg_dump
-- carries on whichever PostGIS build it is run against.
SELECT format(
         $q$SELECT 'srs|added|' || t.srid || '|' || md5(t.*::text)
              FROM public.spatial_ref_sys t %s ORDER BY t.srid$q$,
         u.cond)
  FROM pg_extension e,
       unnest(e.extconfig, e.extcondition) AS u (tbl, cond)
 WHERE e.extname = 'postgis' AND u.tbl = 'public.spatial_ref_sys'::regclass AND u.cond <> ''
\gexec

-- Row count and a content digest for every table in `public`, generated per table so the set
-- is discovered rather than listed — a table added to schema.prisma after this file was
-- written is still compared. spatial_ref_sys is the one exclusion, for the reason above.
--
-- The digest is order-independent: each row is hashed, the hashes are sorted, and the
-- concatenation is hashed again. Physical order changes on every restore and means nothing.
-- `t.*::text` reaches the geometry and tsvector columns that schema.prisma declares
-- Unsupported, which Prisma Client cannot select at all.
SELECT format(
         $q$SELECT 'rows|' || %1$L || '|' || (SELECT count(*) FROM public.%1$I)::text || '|' ||
                   (SELECT coalesce(md5(string_agg(h, '' ORDER BY h)), '-')
                      FROM (SELECT md5(t.*::text) AS h FROM public.%1$I t) z)$q$,
         tablename)
  FROM pg_tables
 WHERE schemaname = 'public' AND tablename <> 'spatial_ref_sys'
 ORDER BY tablename
\gexec
