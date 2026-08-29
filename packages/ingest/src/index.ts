/**
 * @switchback/ingest — OpenStreetMap in, trails out. Lazy per z9 tile, subdivided when one will
 * not fit; see `pipeline.ts` for the orchestration and `overpass.ts` for the etiquette the
 * public instances require.
 */

export * from './overpass';
export * from './deadline';
export * from './assemble';
export * from './elevate';
export * from './terrain-cache';
export * from './terrain-cache-dir';
export * from './terrain-cache-r2';
export * from './derive';
export * from './enrich';
export * from './photo-subject';
export * from './feature-index';
export * from './geocode';
export * from './jobs';
export * from './dead-jobs';
export * from './backpressure';
export * from './pool';
export * from './subdivide';
export * from './coverage';
export * from './drain-slot';
export * from './maintenance';
export * from './pipeline';
export * from './publish';
export * from './network';
export * from './config';
export * from './handlers';

export { trailIdentityMode } from './identity';
export type { TrailIdentityMode } from './identity';
