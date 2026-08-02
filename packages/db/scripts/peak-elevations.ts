/**
 * Overpass QL for fetching an OSM feature's own `ele` by id, and the key the two backfills
 * agree on. Its own module so a test can read the query without running a script around it.
 */

/** The element types a waypoint can point at. Prisma's `OsmElementType`, spelled out. */
export type OsmType = 'node' | 'way' | 'relation';

/**
 * How a fetched height is keyed — by element type as well as id, because OSM numbers nodes,
 * ways and relations in separate sequences and node 1 is not way 1. Shared so the writer and
 * the reader of the scratch file cannot drift apart on the spelling.
 */
export function osmKey(osmType: OsmType, osmId: bigint | number | string): string {
  return `${osmType}/${String(osmId)}`;
}

/**
 * `ele` for a batch of elements, selected by id. Two choices carry the etiquette. Selecting by
 * id rather than by bounding box asks the server for exactly the features we already know we
 * want, with no spatial index to walk; and `out tags` returns no geometry, which is the whole
 * weight of a response — a batch of peaks answers in tens of kilobytes.
 *
 * `[timeout:60]` is generous for work this small, and bounds a pathological batch rather than
 * letting it hold a slot. Throws on an empty batch: `node(id:);` is a syntax error, which
 * Overpass answers 400 and the client — rightly — refuses to retry.
 */
export function tagsByIdQuery(
  osmType: OsmType,
  ids: readonly (bigint | number)[],
  options: { timeoutS?: number } = {},
): string {
  if (ids.length === 0) throw new Error(`refusing to ask Overpass for zero ${osmType} ids`);
  const timeout = options.timeoutS ?? 60;
  return `[out:json][timeout:${timeout}];
${osmType}(id:${ids.map(String).join(',')});
out tags;`;
}
