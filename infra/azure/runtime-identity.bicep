// The identity the runtime clients are being consolidated onto — Vercel production, Vercel preview
// and the ingest worker — so that one principal, one Postgres role and one grant set are what
// there is to audit.
//
// **Declared, not yet in force.** Today Vercel authenticates by password (`DATABASE_AUTH` is set
// by no consumer) and the ingest worker runs as its own system-assigned principal,
// `3db30cfd-ea61-47ce-9b03-8b34ebc420b0`. The cutover that makes this identity the one they use is
// sequenced in infra/azure/README.md and is gated on each consumer being proved on a token while
// passwords still work. Nothing here performs it.
//
// Declared here rather than in ingest.bicep because it is not only the worker's identity: it is
// the database principal for the web application as well, and two templates declaring one resource
// is how drift starts. ingest.bicep takes `resourceId` below as a parameter.
//
// **The identity, and nothing the identity is granted.** Its Service Bus role assignments belong
// to ingest.bicep, which owns the namespace and the queue they are scoped to; declaring them here
// too would recreate that drift one layer down, two templates computing one `guid()` against one
// queue. What this principal holds live is Data Sender on `ingest-jobs` and nothing else: Data
// Receiver was deleted, because this identity rides on every Vercel deployment and Receive is
// standing authority to drain the production queue from an unreviewed preview.
//
// The identity is not an administrator of anything. Its intended database privilege is
// `sbapp_runtime` — a role that does not exist until the `provision` action renames `sbapp_vercel`
// — and see infra/postgres-identity/ for the privilege set, which is a SQL object no template can
// declare.

@description('Azure region. Inherited from main.bicep.')
param location string

@description('''
Name of the shared identity. `id-switchback-vercel-publisher` is the deployed name and changing
it creates a second identity rather than renaming this one — ARM cannot rename a UAMI. The name
reads narrower than the role it is being given; the Postgres role and this file carry the accurate
name instead.
''')
param identityName string

@description('Vercel team slug. Appears in the OIDC issuer, the subject and the audience.')
param vercelTeamSlug string

@description('Vercel project name. Appears in the subject of both credentials.')
param vercelProjectName string

param tags object

// ARM cannot rename a user-assigned identity, so the resource name still says `vercel-publisher`
// while the identity is being made to serve three consumers. The tag is where a portal reader is
// told otherwise, and it is one of the two places the narrow name is corrected — the other is the
// Postgres role.
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
