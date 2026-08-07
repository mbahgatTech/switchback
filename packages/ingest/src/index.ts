/**
 * @switchback/ingest — OpenStreetMap in, trails out. Lazy per z9 tile, subdivided when one will
 * not fit; see `pipeline.ts` for the orchestration and `overpass.ts` for the etiquette the
 * public instances require.
 */

export * from './overpass';
export * from './deadline';
export * from './assemble';
export * from './elevate';
export * from './derive';
export * from './enrich';
export * from './geocode';
export * from './jobs';
export * from './backpressure';
export * from './pool';
export * from './subdivide';
export * from './coverage';
export * from './pipeline';
export * from './publish';
export * from './network';
export * from './config';
export * from './handlers';

// The flag, not the mechanism: `trails.bySlug` has to gate its `trail_slug_aliases` read on the
// same setting that writes the table, and nothing outside ingest resolves a claim itself.
export { trailIdentityMode } from './identity';
export type { TrailIdentityMode } from './identity';
