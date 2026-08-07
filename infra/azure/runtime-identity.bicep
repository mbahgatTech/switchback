// The identity every runtime client authenticates as — Vercel production, Vercel preview and the
// ingest worker. One principal, one Postgres role, one grant set to audit.
//
// Declared here rather than in ingest.bicep because it is no longer the worker's identity: it is
// the database principal for the web application as well, and two templates declaring one resource
// is how drift starts. ingest.bicep takes `resourceId` below as a parameter.
//
// **The identity, and nothing the identity is granted.** Its Service Bus role assignments are
// declared by ingest.bicep, which owns the namespace and the queue they are scoped to. Declaring
// them here as well would recreate the drift this file exists to avoid, one layer down: two
// templates computing one `guid()` against one queue, each able to reconcile it away from the
// other. A grant belongs with the resource it is granted on.
//
// The identity is not an administrator of anything. It reads and writes rows as `sbapp_runtime`
// and, once ingest.bicep grants it, moves messages on one queue; see infra/postgres-identity/ for
// the privilege set, which is a SQL object no template can declare.

@description('Azure region. Inherited from main.bicep.')
param location string

@description('''
Name of the shared identity. `id-switchback-vercel-publisher` is the deployed name and changing
it creates a second identity rather than renaming this one — ARM cannot rename a UAMI. The name
reads narrower than the role it now holds; the Postgres role and this file carry the accurate
name instead.
''')
param identityName string

@description('Vercel team slug. Appears in the OIDC issuer, the subject and the audience.')
param vercelTeamSlug string

@description('Vercel project name. Appears in the subject of both credentials.')
param vercelProjectName string

param tags object

// ARM cannot rename a user-assigned identity, so the resource name still says `vercel-publisher`
// while the identity serves three consumers. The tag is where a portal reader is told otherwise,
// and it is one of the two places the narrow name is corrected — the other is the Postgres role.
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
