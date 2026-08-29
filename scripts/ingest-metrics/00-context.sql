-- Ingest metrics 00: what database this is, and what time span the rest of the set can honestly
-- cover. Run this first — every other file's numbers are meaningless without C2's span.
-- SELECT only: no write, no DDL.

\echo '=== C1: connection, clock, and read-only state ==='
select current_user,
       current_database(),
       inet_server_addr()                        as server,
       now() at time zone 'utc'                  as read_at_utc,
       current_setting('transaction_read_only')  as read_only;

\echo ''
\echo '=== C2: table sizes and the observable span ==='
-- `enqueue` revives a finished row in place, so `createdAt` is the first enqueue a dedupeKey ever
-- had and `completedAt` is only the most recent completion. Every rate below is therefore exact
-- for recent hours and a lower bound for older ones.
select 'ingest_jobs'                                as relation,
       count(*)                                     as rows,
       min("createdAt")   at time zone 'utc'        as oldest_created,
       max("createdAt")   at time zone 'utc'        as newest_created,
       max("completedAt") at time zone 'utc'        as newest_completed
  from ingest_jobs
union all
select 'ingest_tiles',
       count(*),
       min("createdAt")  at time zone 'utc',
       max("createdAt")  at time zone 'utc',
       max("fetchedAt")  at time zone 'utc'
  from ingest_tiles
union all
select 'routing_tiles',
       count(*),
       min("createdAt")  at time zone 'utc',
       max("createdAt")  at time zone 'utc',
       max("fetchedAt")  at time zone 'utc'
  from routing_tiles
 order by 1;

\echo ''
\echo '=== C3: storage, against the 85% admission ceiling ==='
-- `MAX_STORAGE_FRACTION` is 0.85 of `DATABASE_SIZE_LIMIT_BYTES`, which nothing in Postgres knows.
-- The two candidate plan sizes are printed so the fraction can be read against whichever is set.
select pg_size_pretty(pg_database_size(current_database()))                            as db_size,
       pg_database_size(current_database())                                            as db_bytes,
       round(100.0 * pg_database_size(current_database()) / 34359738368, 1)            as pct_of_32gb,
       round(100.0 * pg_database_size(current_database()) / 68719476736, 1)            as pct_of_64gib;

\echo ''
\echo '=== C4: the ten largest relations ==='
select relname,
       pg_size_pretty(pg_total_relation_size(c.oid)) as total_size
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r'
 order by pg_total_relation_size(c.oid) desc
 limit 10;
