-- osm2pgsql flex style for the two slices the ingest queries read. `SB_SLICE` picks one:
-- `trail` mirrors buildTileQuery, `network` mirrors buildNetworkQuery.

local slice = os.getenv('SB_SLICE') or 'trail'
local schema = os.getenv('SB_SCHEMA') or 'osm'

--- `route` values buildTileQuery accepts.
local ROUTE = { hiking = true, foot = true, walking = true, running = true }

--- `highway` values buildNetworkQuery accepts, which is HIGHWAY_KIND's key set.
local NETWORK_HIGHWAY = {
  path = true, footway = true, track = true, bridleway = true, steps = true,
  cycleway = true, pedestrian = true, living_street = true, residential = true,
  unclassified = true, tertiary = true, service = true, road = true,
}

local BARRED_ACCESS = { private = true, no = true }
local BARRED_FOOT = { private = true, no = true, use_sidepath = true }
local BARRED_SERVICE = { driveway = true, parking_aisle = true, ['drive-through'] = true }

--- Overpass member types, spelled as the JSON reader expects rather than osm2pgsql's initials.
local MEMBER_TYPE = { n = 'node', w = 'way', r = 'relation' }

local ways, relations

if slice == 'trail' then
  ways = osm2pgsql.define_way_table('trail_way', {
    { column = 'tags', type = 'jsonb' },
    { column = 'geom', type = 'linestring', projection = 4326 },
  }, { schema = schema })

  relations = osm2pgsql.define_relation_table('trail_relation', {
    { column = 'tags', type = 'jsonb' },
    { column = 'members', type = 'jsonb' },
    { column = 'geom', type = 'multilinestring', projection = 4326 },
  }, { schema = schema })
else
  ways = osm2pgsql.define_way_table('network_way', {
    { column = 'tags', type = 'jsonb' },
    { column = 'geom', type = 'linestring', projection = 4326 },
  }, { schema = schema })
end

function osm2pgsql.process_way(object)
  if #object.nodes < 2 then return end
  local tags = object.tags

  if slice == 'network' then
    if not NETWORK_HIGHWAY[tags.highway] then return end
    if BARRED_ACCESS[tags.access] then return end
    if BARRED_FOOT[tags.foot] then return end
    if BARRED_SERVICE[tags.service] then return end
  end

  -- The trail slice keeps every way the filtered extract carries. A route relation's members
  -- are any highway class, and dropping them loses the relation's geometry, not just a way.
  local geom = object:as_linestring()
  if geom:is_null() then return end
  ways:insert({ tags = tags, geom = geom })
end

function osm2pgsql.process_relation(object)
  if slice ~= 'trail' then return end
  if not ROUTE[object.tags.route] then return end

  local members = {}
  for _, member in ipairs(object.members) do
    members[#members + 1] = {
      type = MEMBER_TYPE[member.type] or member.type,
      ref = member.ref,
      role = member.role,
    }
  end
  if #members == 0 then return end

  relations:insert({ tags = object.tags, members = members, geom = object:as_multilinestring() })
end
