// The identity every runtime client authenticates as — Vercel production, Vercel preview and the
// ingest worker. One principal, one Postgres role, one grant set to audit.
//
// Declared here rather than in ingest.bicep because it is no longer the worker's identity: it is
// the database principal for the web application as well, and two templates declaring one
// resource is how drift starts. ingest.bicep takes `resourceId` below as a parameter.
//
// The identity is not an administrator of anything. It reads and writes rows as `sbapp_runtime`
// and moves messages on one queue; see infra/postgres-identity/ for the privilege set, which is
// a SQL object no template can declare.

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

@description('''
Service Bus namespace holding the ingest queue, or empty to declare no queue grant.

The namespace and the queue are declared by ingest.bicep, which owns them. Only the grant is
here, and only the one the shared identity is missing — see the role assignment below.
''')
param serviceBusNamespaceName string = ''

@description('Queue the ingest worker receives from. Ignored when the namespace name is empty.')
param serviceBusQueueName string = ''

param tags object

var serviceBusDataReceiverRoleId = '4f6d3b9b-027b-4f4c-9142-0e5a2a2247e0'
var serviceBusDataSenderRoleId = '69a216fc-b8fb-44d8-bc22-1f3c2cd27a39'
var grantQueueAccess = !empty(serviceBusNamespaceName) && !empty(serviceBusQueueName)

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

resource queue 'Microsoft.ServiceBus/namespaces/queues@2022-10-01-preview' existing = if (grantQueueAccess) {
  name: '${serviceBusNamespaceName}/${serviceBusQueueName}'
}

// The two grants this identity holds on the ingest queue, and the whole of what it may do in
// Azure. Send is what a Vercel request does when it enqueues a tile; Receive is what the worker
// does when it drains one. Both are the same principal now, so the worker's own Sender grant
// becomes redundant and three assignments collapse to two.
//
// The Sender assignment is already live as `f1b97f59-263a-5e18-a1c0-40ce18436d52`, declared by
// ingest.bicep as the publisher grant. `guid()` is computed from the queue id, this identity's
// resource id and the role id — the same three values ingest.bicep uses, because the publisher
// *is* this identity — so redeclaring it reconciles the existing assignment rather than creating
// a second one beside it. Confirmed: what-if reports that exact name as a modification, not a
// creation. The `principalId` it shows changing is an unresolved `reference()` in the preview and
// evaluates to the same `c9bfba39-…`.
resource runtimeSender 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (grantQueueAccess) {
  scope: queue
  name: guid(queue.id, identity.id, serviceBusDataSenderRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      serviceBusDataSenderRoleId
    )
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// Receive is the grant this identity does not hold today, and the one whose absence fails
// silently: the worker stops draining on a timer, with no error and no failed request.
resource runtimeReceiver 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (grantQueueAccess) {
  scope: queue
  name: guid(queue.id, identity.id, serviceBusDataReceiverRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      serviceBusDataReceiverRoleId
    )
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

output resourceId string = identity.id
output principalId string = identity.properties.principalId
output clientId string = identity.properties.clientId
output name string = identity.name
