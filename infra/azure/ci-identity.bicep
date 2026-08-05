// The identity CI authenticates to Postgres as, so no connection string has to be stored.
//
// A user-assigned managed identity rather than an app registration with a secret, for the same
// reason the Vercel publisher is one: a federated credential trades an OIDC token the platform
// already mints for an Azure access token, and there is nothing left to rotate or leak.
//
// The Postgres *role* this identity logs in as is not here. ARM cannot run SQL; see
// infra/postgres-identity/.

@description('Azure region. Inherited from main.bicep.')
param location string

param identityName string

@description('owner/repo the federated credentials trust, e.g. mbahgatTech/switchback.')
param repository string

@description('Branches whose workflow runs may assume this identity.')
param branches string[]

param tags object

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: identityName
  location: location
  tags: tags
}

// One credential per branch, because a subject is an exact string — GitHub's OIDC subject
// carries the ref, and there is no wildcard. `master` is the only one that matters in steady
// state: `ci.yml`'s schema push runs on a push to master and nowhere else.
//
// The audience is GitHub's own, not Azure's tenant: `api://AzureADTokenExchange` is what the
// `azure/login` action requests, and a mismatch fails at the exchange with an error that names
// neither side.
// `@batchSize(1)` is required, not tidiness: Entra refuses concurrent federated-credential
// writes under one managed identity outright —
// `ConcurrentFederatedIdentityCredentialsWritesForSingleManagedIdentity` — and ARM would
// otherwise issue every element of this loop at once.
@batchSize(1)
resource branchCredentials 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = [
  for branch in branches: {
    parent: identity
    name: 'github-${replace(branch, '/', '-')}'
    properties: {
      issuer: 'https://token.actions.githubusercontent.com'
      subject: 'repo:${repository}:ref:refs/heads/${branch}'
      audiences: ['api://AzureADTokenExchange']
    }
  }
]

output principalId string = identity.properties.principalId
output clientId string = identity.properties.clientId
output name string = identity.name
