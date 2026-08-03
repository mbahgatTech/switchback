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
//   export INGEST_QUEUE_DRIVER=postgres          # or servicebus; there is no default, state it
//   az deployment group create \
//     --name switchback-ingest --resource-group rg-switchback-prod-northcentralus \
//     --template-file infra/azure/ingest.bicep \
//     --parameters infra/azure/ingest.bicepparam
//   unset INGEST_DATABASE_URL
//
// **A template deployment alone leaves the app codeless.** Linux Consumption runs from a package URL
// that `az functionapp deployment source config-zip` writes into the same application-settings
// collection an ARM deployment replaces wholesale, so the deploy above and the zip push always run
// together, template first. See the note beside the Function App in ingest.bicep.

using './ingest.bicep'

param location = 'northcentralus'
param namespacePrefix = 'sb-switchback-prod'
param queueName = 'ingest-jobs'
param functionAppPrefix = 'func-switchback-ingest'

// Created by monitoring.bicep. Referenced `existing`, never redeployed from here.
param logAnalyticsWorkspaceName = 'log-switchback-prod'
param alertActionGroupName = 'ag-switchback-prod'

// Which queue drives ingest, on this side. Vercel's own INGEST_QUEUE_DRIVER must agree: set only
// one and the Postgres drain and the worker both claim from `ingest_jobs` at once.
//
// No fallback default. A deployment overwrites the Function App's INGEST_QUEUE_DRIVER with
// whatever this resolves to, so a default would let a routine deploy re-arm the fan-out an
// operator had just rolled back. Stating it is one word; guessing it wrong is an outage.
param ingestQueueDriver = readEnvironmentVariable('INGEST_QUEUE_DRIVER')

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
