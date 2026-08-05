-- The database `rehearse-locally.sh` builds to exercise census.sql: the column types, index
-- shapes, grants and PostGIS features the real schema uses, small enough to run in seconds.
--
-- Four of these details are load-bearing rather than decorative, and each is here because it
-- is a way a dump/restore comparison can be wrong while looking right:
--
--   * a column added and dropped, so the census is compared across a source that carries an
--     attnum gap and a restored copy that does not;
--   * a trail with NULL geometry, which a restore can turn into an empty geometry;
--   * grants to a second role, so the ACL lines are non-trivial on both sides;
--   * an SRID added by hand, which is the only part of spatial_ref_sys a dump carries.

CREATE EXTENSION postgis;
CREATE EXTENSION pg_trgm;
CREATE EXTENSION btree_gist;

CREATE TABLE trails (
  id text PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  "lengthM" double precision,
  "bboxW" double precision,
  "bboxE" double precision,
  "bboxS" double precision,
  "bboxN" double precision,
  tags jsonb,
  "searchVector" tsvector,
  centroid geometry(Point, 4326),
  geom geometry(LineString, 4326),
  "createdAt" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE waypoints (
  id text PRIMARY KEY,
  "trailId" text NOT NULL REFERENCES trails (id) ON DELETE CASCADE,
  "eleM" double precision,
  point geometry(Point, 4326)
);

CREATE TABLE activities (
  id text PRIMARY KEY,
  geom geometry(LineString, 4326)
);

CREATE TABLE reviews (
  id text PRIMARY KEY,
  "trailId" text NOT NULL REFERENCES trails (id) ON DELETE CASCADE,
  rating integer NOT NULL,
  CONSTRAINT reviews_rating_range CHECK (rating >= 1 AND rating <= 5)
);

ALTER TABLE trails ADD COLUMN legacy text;
ALTER TABLE trails DROP COLUMN legacy;

INSERT INTO trails (id, slug, name, "lengthM", "bboxW", "bboxE", "bboxS", "bboxN", tags, "searchVector", centroid, geom)
SELECT
  'trail-' || i,
  'trail-' || i,
  'Trail ' || i,
  1000.0 + i,
  -122.0, -121.0, 47.0, 49.0,
  jsonb_build_object('sac_scale', 'hiking', 'n', i),
  to_tsvector('simple', 'trail ' || i),
  ST_SetSRID(ST_MakePoint(-121.5, 48.0 + i / 1000.0), 4326),
  ST_SetSRID(
    ST_MakeLine(ARRAY[
      ST_MakePoint(-121.5, 48.0 + i / 1000.0),
      ST_MakePoint(-121.4, 48.1 + i / 1000.0),
      ST_MakePoint(-121.3, 48.2 + i / 1000.0)
    ]), 4326)
FROM generate_series(1, 500) AS i;

INSERT INTO trails (id, slug, name) VALUES ('trail-null', 'trail-null', 'No geometry');

INSERT INTO waypoints (id, "trailId", "eleM", point)
SELECT 'wp-' || i, 'trail-' || i, 100.0 + i,
       ST_SetSRID(ST_MakePoint(-121.45, 48.05 + i / 1000.0), 4326)
FROM generate_series(1, 500) AS i;

INSERT INTO activities (id, geom)
SELECT 'act-' || i,
       ST_SetSRID(ST_MakeLine(ST_MakePoint(-121.5, 48.0), ST_MakePoint(-121.4, 48.1)), 4326)
FROM generate_series(1, 10) AS i;

INSERT INTO reviews (id, "trailId", rating)
SELECT 'rev-' || i, 'trail-' || i, 1 + (i % 5) FROM generate_series(1, 50) AS i;

CREATE INDEX trails_geom_gist ON trails USING GIST (geom);
CREATE INDEX trails_geom_geography_gist ON trails USING GIST ((geom::geography));
CREATE INDEX trails_bbox_gist ON trails USING GIST ("bboxW", "bboxE", "bboxS", "bboxN");
CREATE INDEX trails_search_vector_gin ON trails USING GIN ("searchVector");
CREATE INDEX trails_name_trgm ON trails USING GIN (name gin_trgm_ops);
CREATE INDEX waypoints_point_gist ON waypoints USING GIST (point);
CREATE INDEX activities_geom_gist ON activities USING GIST (geom);

REVOKE ALL ON SCHEMA public FROM sbapp;
GRANT USAGE ON SCHEMA public TO sbapp;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO sbapp;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO sbapp;

INSERT INTO spatial_ref_sys (srid, auth_name, auth_srid, srtext, proj4text)
VALUES (990000, 'switchback', 990000, 'LOCAL_CS["switchback-rehearsal"]', '+proj=longlat +datum=WGS84 +no_defs');

ANALYZE;
