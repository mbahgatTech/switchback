/**
 * @switchback/ingest — OpenStreetMap in, trails out.
 *
 * The pipeline is lazy by design: nothing is imported ahead of time, and a tile is only
 * fetched when somebody looks at it. See `pipeline.ts` for the orchestration and
 * `overpass.ts` for why the client is as careful as it is.
 */

export * from './overpass';
export * from './assemble';
export * from './elevate';
export * from './derive';
export * from './enrich';
export * from './geocode';
export * from './jobs';
export * from './pool';
export * from './coverage';
export * from './pipeline';
export * from './network';
export * from './config';
export * from './handlers';
