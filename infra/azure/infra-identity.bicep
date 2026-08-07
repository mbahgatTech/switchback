// The identity `.github/workflows/infrastructure.yml` deploys these templates as.
//
// Separate from `id-switchback-postgres-ci` on purpose. That one holds **zero** Azure RBAC, which
// is the property that makes a leak of it unable to touch the resource group; giving it
// Contributor to save a resource would spend exactly that property. This identity is the one that
// carries the privilege, and it carries nothing else.
//
// The Contributor grant is not declared here — see `grantInfraIdentityContributor` in main.bicep.
// Creating the identity is safe and reversible; granting a public repository's workflows write
// access to production is the decision, and it is kept where a reader of the top-level template
// cannot miss it.

@description('Azure region. Inherited from main.bicep.')
param location string

param identityName string

@description('''
Repository the federated credential trusts, in GitHub's immutable subject form —
`<owner>@<ownerId>/<repo>@<repoId>`. See the parameter of the same name in ci-identity.bicep for
why the readable form fails the exchange.
''')
param repository string

@description('Branch whose workflow runs may assume this identity.')
param branch string

param tags object

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: identityName
  location: location
  tags: tags
}

// One branch, not a list. A second credential for the `pull_request` subject would let any fork's
// pull request assume an identity with write access to production, in a public repository.
resource masterCredential 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: identity
  name: 'github-${replace(branch, '/', '-')}'
  properties: {
    issuer: 'https://token.actions.githubusercontent.com'
    subject: 'repo:${repository}:ref:refs/heads/${branch}'
    audiences: ['api://AzureADTokenExchange']
  }
}

output principalId string = identity.properties.principalId
output clientId string = identity.properties.clientId
output name string = identity.name
