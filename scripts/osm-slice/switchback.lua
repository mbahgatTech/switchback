-- osm2pgsql flex style for the slices the ingest queries read. `SB_SLICE` picks one: `trail`
-- mirrors buildTileQuery, `network` buildNetworkQuery, `context` the feature and region pair.

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

--- The node classes buildFeatureQuery names, by the key each is matched on.
local FEATURE_NATURAL = {
  peak = true, hill = true, saddle = true, spring = true, water = true, cave_entrance = true,
}
local FEATURE_AMENITY = { parking = true, toilets = true, shelter = true, drinking_water = true }
local FEATURE_TOURISM = { camp_site = true, alpine_hut = true, wilderness_hut = true, viewpoint = true }
local FEATURE_BARRIER = { gate = true, stile = true }

--- `admin_level` values buildRegionQuery accepts.
local ADMIN_LEVEL = { ['2'] = true, ['4'] = true, ['5'] = true, ['6'] = true }

--- The only keys `pickRegion` reads. Projecting to them is what keeps an admin row near 100 bytes
--- rather than the 40 kB the United States relation carries in name translations alone.
local REGION_KEYS = { 'admin_level', 'name', 'name:en', 'ISO3166-1', 'ISO3166-1:alpha2' }

local ways, relations, feature_nodes, feature_ways, admin_areas

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
elseif slice == 'context' then
  feature_nodes = osm2pgsql.define_node_table('feature_node', {
    { column = 'tags', type = 'jsonb' },
    { column = 'geom', type = 'point', projection = 4326 },
  }, { schema = schema })

  -- `geom` is dropped after load, once `center` has been taken from its envelope. Overpass's
  -- `out center` is the centre of the bounding box, not a centroid, so the ring has to survive
  -- long enough to be measured and no longer.
  feature_ways = osm2pgsql.define_way_table('feature_way', {
    { column = 'tags', type = 'jsonb' },
    { column = 'geom', type = 'linestring', projection = 4326 },
  }, { schema = schema })

  admin_areas = osm2pgsql.define_relation_table('admin_area', {
    { column = 'tags', type = 'jsonb' },
    { column = 'geom', type = 'multipolygon', projection = 4326 },
  }, { schema = schema })
else
  ways = osm2pgsql.define_way_table('network_way', {
    { column = 'tags', type = 'jsonb' },
    { column = 'geom', type = 'linestring', projection = 4326 },
  }, { schema = schema })
end

--- True when a node carries one of the eleven waypoint classes the feature query names.
local function is_feature_node(tags)
  return FEATURE_NATURAL[tags.natural] or FEATURE_AMENITY[tags.amenity]
    or FEATURE_TOURISM[tags.tourism] or FEATURE_BARRIER[tags.barrier]
    or tags.mountain_pass == 'yes' or tags.waterway == 'waterfall'
    or tags.ford == 'yes' or tags.information == 'guidepost'
end

--- Tags reduced to the keys a reader actually reads, so unread translations cost no disk.
local function project(tags, keys)
  local kept = {}
  for _, key in ipairs(keys) do
    if tags[key] ~= nil then kept[key] = tags[key] end
  end
  return kept
end

function osm2pgsql.process_node(object)
  if slice ~= 'context' then return end
  if not is_feature_node(object.tags) then return end
  feature_nodes:insert({ tags = object.tags, geom = object:as_point() })
end

function osm2pgsql.process_way(object)
  if #object.nodes < 2 then return end
  local tags = object.tags

  if slice == 'context' then
    -- `way["amenity"="parking"]` and `way["natural"="glacier"]["name"]`, and nothing else: the
    -- other nine classes are node-only statements in buildFeatureQuery.
    local wanted = tags.amenity == 'parking'
      or (tags.natural == 'glacier' and tags.name ~= nil)
    if not wanted then return end
    local geom = object:as_linestring()
    if geom:is_null() then return end
    feature_ways:insert({ tags = tags, geom = geom })
    return
  end

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
  local tags = object.tags

  if slice == 'context' then
    if tags.boundary ~= 'administrative' then return end
    if not ADMIN_LEVEL[tags.admin_level] then return end
    -- A state extract carries the level-2 relation with most of its member ways outside, so the
    -- ring cannot close and the geometry comes back null. Kept anyway: what `is_in` loses when
    -- that happens is the finding, and a dropped row would hide it.
    admin_areas:insert({ tags = project(tags, REGION_KEYS), geom = object:as_multipolygon() })
    return
  end

  if slice ~= 'trail' then return end
  if not ROUTE[tags.route] then return end

  local members = {}
  for _, member in ipairs(object.members) do
    members[#members + 1] = {
      type = MEMBER_TYPE[member.type] or member.type,
      ref = member.ref,
      role = member.role,
    }
  end
  if #members == 0 then return end

  relations:insert({ tags = tags, members = members, geom = object:as_multilinestring() })
end
