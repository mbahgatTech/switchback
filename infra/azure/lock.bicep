// The `CanNotDelete` lock on the resource group.
//
// A file of its own for a reason that is purely mechanical rather than editorial: a management
// lock is an extension resource, `main.bicep` is deployed at subscription scope, and Bicep
// refuses to let a subscription-scoped file declare a resource whose scope is a resource group
// inside it — `BCP139: A resource's scope must match the scope of the Bicep file for it to be
// deployable. You must use modules to deploy resources to a different scope.` A module is the
// documented way across that boundary, so this is the module.
//
// **The reasoning about what the lock defends and what it does not is in main.bicep**, beside
// the module declaration, where someone reading the shape of the deployment will actually meet
// it. The short version: this resource group holds the Postgres server and its only backups,
// and deleting a Flexible Server takes the backups with it. Nothing here soft-deletes.
//
// One thing worth repeating in this file, because it is the thing that surprises people:
// creating this needs `Microsoft.Authorization/locks/write`, which built-in **Contributor**
// does not have. Deploying the parent template as a Contributor with `deployDeleteLock` left
// at its default fails on this module with `AuthorizationFailed` and deploys nothing else.
// That is not a bug in the template — see the parameter's description in main.bicep for the
// escape hatch and for why the default is nonetheless `true`.

@description('Name of the lock, as it appears in the portal and in `az lock list`.')
param lockName string

@description('''
Text shown to whoever runs into the lock. It is the only explanation they get at the moment
they are blocked, so it says what the group holds, what deleting it costs, and where the
declaration lives — rather than "do not delete", which tells a person nothing they had not
already worked out from being stopped.
''')
param lockNotes string

// `CanNotDelete` rather than `ReadOnly`, deliberately. `ReadOnly` would also block every
// legitimate change — a tier escalation, a parameter write, a backup-retention change, the
// redeploy README.md calls a no-op — and locks that block ordinary work get removed and not
// put back. This blocks exactly one verb, which is the one that is irreversible.
resource lock 'Microsoft.Authorization/locks@2020-05-01' = {
  name: lockName
  properties: {
    level: 'CanNotDelete'
    notes: lockNotes
  }
}

output lockId string = lock.id
