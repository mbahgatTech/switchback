// The identity Vercel production and Vercel preview both federate to, so that one principal, one
// Postgres role and one grant set are what there is to audit across the two of them.
//
// **Declared, not yet in force.** Vercel authenticates by password as `sbapp` — no Vercel
// environment sets `DATABASE_AUTH`, so `databaseAuthMode()` resolves to `password` — and its
// Entra-mapped role `sbapp_vercel` waits unused. The Function App does set it, to `entra`, and
// carries its traffic as `sbapp_func`. The cutover is sequenced in infra/azure/README.md and is
// gated on each consumer being proved on a token while passwords still work. Nothing here
// performs it.
//
// **The ingest worker is not one of these clients.** It runs as its own system-assigned principal
// `3db30cfd-ea61-47ce-9b03-8b34ebc420b0`, whose Postgres role is `sbapp_func`. Its Service Bus
// trigger receives as whatever principal the site runs under, so an app running as this identity
// would need Data Receiver on `ingest-jobs` put back on an identity every Vercel preview carries.
//
// Declared here because it is the web application's database principal, not the worker's.
// **ingest.bicep declares the same identity, and the same two federated credentials, itself** — it
// takes no resource id from this template. Two templates own one resource and the last deploy
// wins, and that drift is live: the identity's `component` tag reads `ingest-worker`,
// ingest.bicep's default, not the value set below. Converging the two declarations is an
// infrastructure change, not a documentation one.
//
// **The identity, and nothing the identity is granted.** Its Service Bus role assignment belongs
// to ingest.bicep, which owns the namespace and the queue it is scoped to; declaring it here too
// would recreate that drift one layer down, two templates computing one `guid()` against one
// queue. The grant this principal holds live is **Data Sender on `ingest-jobs`, and only that**.
// Data Receiver was revoked on 2026-08-08 — it was drain capability for every Vercel deployment,
// previews included, and the worker never needed it, because the worker receives as the Function
// App's own system-assigned principal.
//
// The identity is not an administrator of anything. Its database privilege is `sbapp_vercel`,
// which holds exactly what `sbapp` holds, by membership. See infra/postgres-identity/ for the
// privilege set — a SQL object no template can declare.

@description('Azure region. Inherited from main.bicep.')
param location string

@description('''
Name of the shared identity. `id-switchback-vercel-publisher` is the deployed name and changing
it creates a second identity rather than renaming this one — ARM cannot rename a UAMI.
''')
param identityName string

@description('Vercel team slug. Appears in the OIDC issuer, the subject and the audience.')
param vercelTeamSlug string

@description('Vercel project name. Appears in the subject of both credentials.')
param vercelProjectName string

param tags object

// Two consumers, both Vercel: production and preview. `vercel-publisher` is an accurate name for
// what this identity is, and `sbapp_vercel` for the role it holds — neither needs correcting by a
// tag. **This value does not reach the deployed resource.** ingest.bicep declares the same identity
// with its own `tags`, and the live `component` is `ingest-worker`; trust the templates over the
// portal tag until the two declarations are converged.
var identityTags = union(tags, { component: 'runtime-identity' })

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: identityName
  location: location
  tags: identityTags
}

// Entra matches issuer, subject and audience exactly and case-sensitively, with no wildcard, so
// preview needs its own credential. Renaming the Vercel team or the project breaks the exchange
// silently: the assertion follows the new name and the credential does not.
resource production 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: identity
  name: 'vercel-switchback-production'
  properties: {
    issuer: 'https://oidc.vercel.com/${vercelTeamSlug}'
    subject: 'owner:${vercelTeamSlug}:project:${vercelProjectName}:environment:production'
    audiences: ['https://vercel.com/${vercelTeamSlug}']
  }
}

// Sequential, not decorative: Entra refuses concurrent federated-credential writes under one
// identity with `ConcurrentFederatedIdentityCredentialsWritesForSingleManagedIdentity`, and ARM
// would otherwise issue both at once.
resource preview 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: identity
  name: 'vercel-switchback-preview'
  properties: {
    issuer: 'https://oidc.vercel.com/${vercelTeamSlug}'
    subject: 'owner:${vercelTeamSlug}:project:${vercelProjectName}:environment:preview'
    audiences: ['https://vercel.com/${vercelTeamSlug}']
  }
  dependsOn: [production]
}

output resourceId string = identity.id
output principalId string = identity.properties.principalId
output clientId string = identity.properties.clientId
output name string = identity.name
