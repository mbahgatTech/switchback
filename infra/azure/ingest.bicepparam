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
//   az deployment group create \
//     --name switchback-ingest --resource-group rg-switchback-prod-northcentralus \
//     --template-file infra/azure/ingest.bicep \
//     --parameters infra/azure/ingest.bicepparam
//   unset INGEST_DATABASE_URL
//
// **A template deployment alone leaves the app codeless.** Linux Consumption runs from a package URL
// that `.github/scripts/deploy-worker.sh` writes into the same application-settings collection an
// ARM deployment replaces wholesale, so the deploy above and the package push always run
// together, template first. The symptom in between is `0 functions found` and `No job functions
// found` in `traces`, with `az functionapp function list` returning nothing — read that as "the
// package setting was replaced", not as a broken bundle. See the note beside the Function App in
// ingest.bicep.

using './ingest.bicep'

param location = 'northcentralus'
param namespacePrefix = 'sb-switchback-prod'
param queueName = 'ingest-jobs'
param functionAppPrefix = 'func-switchback-ingest'

// Created by monitoring.bicep. Referenced `existing`, never redeployed from here.
param logAnalyticsWorkspaceName = 'log-switchback-prod'
param alertActionGroupName = 'ag-switchback-prod'

// How deep subdivision may go. `9` is off, and off is what an unset variable resolves to: unlike
// the driver above, only one direction of this flag is dangerous. A split cuts fresh interior
// seam through tiles that are currently whole, and a multi-way trail crossing one is written back
// truncated plus a duplicate — permanently, because `commitTrail` only upserts. Deleting the
// setting stops new splits and does not undo that, so both of these default off and the ceiling
// is inert on its own: `subdivideMaxZoom` reads it as 9 unless identity is `claim`.
param ingestSubdivideMaxZoom = readEnvironmentVariable('INGEST_SUBDIVIDE_MAX_ZOOM', '9')

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

// A literal, not an environment read, because this is the one parameter whose omission is silent
// and fatal. `optionalWorkerSettings` emits `DATABASE_AUTH` only when this is not `password`, and
// an application-settings write replaces the collection whole — so a deployment that left this at
// the template's `password` default would delete `DATABASE_AUTH=entra` from the live app. The
// deployed `DATABASE_URL` is passwordless (`entraPoolConfig` refuses one that is not), so the
// worker would then fall back to password auth with no password and stop reaching Postgres.
param databaseAuth = 'entra'
