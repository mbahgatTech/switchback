// Non-secret parameters for infra/azure/ingest.bicep. Committed on purpose.
//
// Two values are not here and must never be. `databaseUrl` is `@secure()` with no default and
// `mapillaryToken` is `@secure()`; a `.bicepparam` has to assign every required parameter, so both
// are read from the environment — the one place that is neither this file, nor argv, nor a log
// line. `readEnvironmentVariable` runs at *build* time, so the variables have to be exported in the
// shell that runs `az deployment`:
//
//   export INGEST_DATABASE_URL="$(...)"          # the application login, same string Vercel holds
//   export INGEST_OVERPASS_USER_AGENT="Switchback/0.1 (+https://switchback-three.vercel.app/attribution)"
//   export INGEST_TRAIL_IDENTITY=claim           # the live value; there is no default, state it
//   export INGEST_SUBDIVIDE_MAX_ZOOM=11          # the live value; there is no default, state it
//   export INGEST_PACKAGE_URL="$(az functionapp config appsettings list \
//     -g rg-switchback-prod-northcentralus -n func-switchback-ingest-37ywppu5p7fri \
//     --query "[?name=='WEBSITE_RUN_FROM_PACKAGE'].value | [0]" -o tsv)"
//   az deployment group create \
//     --name switchback-ingest --resource-group rg-switchback-prod-northcentralus \
//     --template-file infra/azure/ingest.bicep \
//     --parameters infra/azure/ingest.bicepparam
//   unset INGEST_DATABASE_URL
//
// Those five exports are the whole set with no fallback: `databaseUrl`, `overpassUserAgent`,
// `ingestTrailIdentity`, `ingestSubdivideMaxZoom` and `packageUrl`. Every one of them names a live
// control that a default would silently overwrite, so an unset variable fails the build with
// `BCP427` rather than deploying a changed estate. `TERRAIN_TILE_URL` and `MAPILLARY_TOKEN` do have
// fallbacks, and their fallbacks match what the app already holds.

using './ingest.bicep'

param location = 'northcentralus'
param namespacePrefix = 'sb-switchback-prod'
param queueName = 'ingest-jobs'
param functionAppPrefix = 'func-switchback-ingest'

// Created by monitoring.bicep. Referenced `existing`, never redeployed from here.
param logAnalyticsWorkspaceName = 'log-switchback-prod'
param alertActionGroupName = 'ag-switchback-prod'

// How deep subdivision may go. The live app holds `11`, and an application-settings write replaces
// the collection whole — so a fallback here would silently write `9` on any deploy from a shell that
// forgot to export it, and `9` turns subdivision off: `canSubdivide(9, 9)` is false, so a dense z9
// tile is failed rather than split. That is the 540 s overrun class subdivision exists to bound, so
// there is no safe default in either direction. An unset variable fails the build with `BCP427`.
// The pairing with `ingestTrailIdentity` is enforced in code as well: `subdivideMaxZoom` reads the
// ceiling as `9` whatever is deployed unless identity is `claim`.
param ingestSubdivideMaxZoom = readEnvironmentVariable('INGEST_SUBDIVIDE_MAX_ZOOM')

// The package the Function App runs from. No fallback for the same reason as the two flags: an
// application-settings write replaces the collection whole, so any value here that is not the live
// one leaves the app running a different build — or, before this parameter existed, no build at all.
// Read the live value first; the deploy block above shows the command.
param packageUrl = readEnvironmentVariable('INGEST_PACKAGE_URL')

// The live Function App reads `claim`, and an application-settings write replaces the collection
// whole. A fallback here would therefore take identity off the worker on any deploy from a shell
// that forgot to export it — silently, with nothing in the output naming the flag, and without
// touching Vercel. So there is none: an unset variable fails the build with `BCP427` before
// anything reaches Azure. The polarity is the opposite of the ceiling above, whose fallback is
// both the safe direction and the deployed value.
param ingestTrailIdentity = readEnvironmentVariable('INGEST_TRAIL_IDENTITY')

// The two halves of the Vercel OIDC subject the publisher credential trusts. Renaming either on
// Vercel breaks the token exchange silently — the claim follows the new name and the credential
// does not — so they are parameters rather than literals buried in the template.
param vercelTeamSlug = 'mbahgattechs-projects'
param vercelProjectName = 'switchback'

// Leave empty to use the pipeline's default terrain source. Not a secret; kept as a parameter so a
// deployment can point the worker at a mirror without a code change.
param terrainTileUrl = readEnvironmentVariable('TERRAIN_TILE_URL', '')

// Overpass fair use asks an automated client to identify itself with a contact address, and
// `OverpassClient` throws on a blank one. No fallback default: a worker that runs unattended under a
// placeholder user agent is precisely the client that rule exists to stop.
param overpassUserAgent = readEnvironmentVariable('INGEST_OVERPASS_USER_AGENT')

// Secrets. No fallback default on the connection string — a missing INGEST_DATABASE_URL must fail
// the build loudly rather than deploy a worker that cannot reach the database.
param databaseUrl = readEnvironmentVariable('INGEST_DATABASE_URL')
param mapillaryToken = readEnvironmentVariable('MAPILLARY_TOKEN', '')

// The shared terrarium tile cache. Fallbacks are empty on all four, because the safe direction
// here is unambiguous: an unset variable turns the cache off and the worker fetches from the
// origin, which is what it did before the cache existed. Nothing is lost but the speed-up, so a
// `BCP427` would refuse a deploy over something no operator has to remember.
param terrainCacheAccountId = readEnvironmentVariable('TERRAIN_CACHE_R2_ACCOUNT_ID', '')
param terrainCacheAccessKeyId = readEnvironmentVariable('TERRAIN_CACHE_R2_ACCESS_KEY_ID', '')
param terrainCacheSecretAccessKey = readEnvironmentVariable('TERRAIN_CACHE_R2_SECRET_ACCESS_KEY', '')
param terrainCacheBucket = readEnvironmentVariable('TERRAIN_CACHE_R2_BUCKET', '')

// A literal, not an environment read, because this is the one parameter whose omission is silent
// and fatal. `optionalWorkerSettings` emits `DATABASE_AUTH` only when this is not `password`, and
// an application-settings write replaces the collection whole — so a deployment that left this at
// the template's `password` default would delete `DATABASE_AUTH=entra` from the live app. The
// deployed `DATABASE_URL` is passwordless (`entraPoolConfig` refuses one that is not), so the
// worker would then fall back to password auth with no password and stop reaching Postgres.
param databaseAuth = 'entra'
