-- Indexes and constraints Prisma cannot express, applied by `npm run db:push`.
--
-- Three categories live here:
--
--   1. GIST indexes on PostGIS geometry. Prisma declares those columns `Unsupported`,
--      and it will not index a column it cannot type.
--   2. GIN indexes for search — one on the tsvector, one trigram index on the name for
--      fuzzy matching, which is what makes "yosimite falls" find Yosemite Falls.
--   3. A partial unique index. Prisma's `@@unique` is unconditional; the rule we need is
--      "at most one favourites list per user, but any number of custom lists", which is
--      only expressible with a WHERE clause.
--
-- Every statement is IF NOT EXISTS. This file is applied after every `prisma db push`,
-- including pushes that changed nothing, so it must be safe to run repeatedly.
--
-- Column identifiers are quoted because Prisma emits camelCase column names, which
-- Postgres would otherwise fold to lowercase.

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
-- Lets a GiST index cover plain scalar columns, which is what the bbox index below needs.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------------------
-- Spatial indexes
-- ---------------------------------------------------------------------------

-- Viewport search: ST_Intersects(geom, ST_MakeEnvelope(...)).
CREATE INDEX IF NOT EXISTS trails_geom_gist ON trails USING GIST ("geom");

-- Map browse: "bboxW" <= east AND "bboxE" >= west AND "bboxS" <= north AND "bboxN" >= south.
--
-- Four inequalities over four columns, which is exactly the shape a btree cannot serve — a
-- btree can range-scan the first column and no more, so four separate btrees would leave
-- Postgres bitmap-ANDing four low-selectivity scans. A multicolumn GiST (via btree_gist)
-- indexes the conjunction as one 4-dimensional region and answers it in a single scan.
--
-- This exists rather than routing map browse through `trails_geom_gist` because the
-- viewport predicate lives in a Prisma `where` alongside every facet: see the header of
-- packages/api/src/routers/trails.ts for why that matters more than the false positives a
-- bbox test admits.
CREATE INDEX IF NOT EXISTS trails_bbox_gist
  ON trails USING GIST ("bboxW", "bboxE", "bboxS", "bboxN");

-- "Near me" search: ST_DWithin("geom"::geography, point, radius).
--
-- Indexed on the *cast expression*, not on "geom" itself, and that is the entire reason this
-- is a second index rather than a reuse of the one above. A GiST index built with a geometry
-- operator class cannot serve a geography operator: ST_DWithin on a geography compares metres
-- on the spheroid, the planner finds nothing it can use, and it falls through to a sequential
-- scan of every trail in the table. Measured over 56k trails, the same query with the same
-- result set: 3,850 ms of parallel sequential scan before this index existed, 178 ms of index
-- scan after, and 512 buffers touched instead of 32,123.
--
-- The predicate must also carry a *constant* radius. The version this replaced pruned on
-- ST_DWithin("centroid"::geography, origin, radius + "lengthM") first, and a distance that
-- varies per row cannot be index-assisted at all — so the cheap prune was itself the
-- sequential scan it was supposed to avoid. See the note on trailIdsNear.
CREATE INDEX IF NOT EXISTS trails_geom_geography_gist
  ON trails USING GIST (("geom"::geography));

-- Superseded by the index above, which is what "near me" actually uses. The "centroid" column
-- is still written by writeTrailGeometry, but nothing reads it, and an unread index on a table
-- this size is write amplification paid on every ingested trail. Dropped rather than left
-- behind so that a database built from this file and one migrated by it agree.
DROP INDEX IF EXISTS trails_centroid_gist;

CREATE INDEX IF NOT EXISTS waypoints_point_gist ON waypoints USING GIST ("point");

-- Activity heatmap, and matching a recorded track to a trail.
CREATE INDEX IF NOT EXISTS activities_geom_gist ON activities USING GIST ("geom");

-- ---------------------------------------------------------------------------
-- Search
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS trails_search_vector_gin
  ON trails USING GIN ("searchVector");

-- Trigram index for misspellings and partial words, used with `name % :q` and ordered by
-- similarity. Complements the tsvector rather than replacing it: tsvector handles stemming
-- and phrase rank, trigram handles typos.
CREATE INDEX IF NOT EXISTS trails_name_trgm
  ON trails USING GIN ("name" gin_trgm_ops);

-- The same, for the derived display name — "Vesper Peak via Headlee Pass Trail". A second index
-- rather than one over both columns concatenated: `rankedTextIds` ORs two `%` predicates so that
-- either name alone can match, and a GIN index on an expression cannot serve a predicate over
-- one of its inputs. Only ~1.6% of rows are non-null, so it is a small index.
CREATE INDEX IF NOT EXISTS trails_display_name_trgm
  ON trails USING GIN ("displayName" gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- Constraints
-- ---------------------------------------------------------------------------

-- One favourites / completed / want-to-do list per user. Custom lists are exempt, which
-- is precisely why this cannot be a plain @@unique in the schema.
CREATE UNIQUE INDEX IF NOT EXISTS trail_lists_one_system_list_per_user
  ON trail_lists ("userId", "kind")
  WHERE "kind" <> 'custom';

-- Ratings are 1–5. Enforced here as well as in zod, because ingest and any future import
-- path write through the database, not through the API.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'reviews_rating_range'
  ) THEN
    ALTER TABLE reviews
      ADD CONSTRAINT reviews_rating_range CHECK ("rating" BETWEEN 1 AND 5);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'busyness_buckets_slot_range'
  ) THEN
    ALTER TABLE busyness_buckets
      ADD CONSTRAINT busyness_buckets_slot_range
      CHECK ("dayOfWeek" BETWEEN 0 AND 6 AND "hour" BETWEEN 0 AND 23);
  END IF;
END
$$;

-- Every statement here is guarded — twelve inline with IF NOT EXISTS, two by an
-- enclosing DO block — so re-applying the file is a no-op and `db push` may run it
-- on any deploy without checking whether a previous one already did.
