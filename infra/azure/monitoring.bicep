// The two things that have to exist before anything can tell you something went wrong: a
// place for logs to land, and a way for an alert to reach a person.
//
// Split into its own module because both are resource-group-scoped while `main.bicep` is
// subscription-scoped (it creates the group), and because the server template should take
// their ids as parameters rather than reach for them — postgres.bicep stays a description of
// a database.
//
// ---------------------------------------------------------------------------------------
//
// **Why this is not optional decoration.**
//
// Two of this design's central arguments are unobservable without it.
//
// The first is the budget cliff. The subscription paying for this carries a monthly credit
// with the spending limit *on*: when the credit is consumed the subscription is disabled and
// every resource in it is deallocated. postgres.bicep sizes the server to ~38% of the credit
// specifically to stay clear of that, and README.md repeats the reasoning — but nothing was
// watching the number. The first notice of the cliff would have been the site being down,
// with a recovery that is either "wait for the next billing month" or "remove the spending
// limit, converting the subscription to pay-as-you-go". Neither is five minutes. The credit
// is also not dedicated: the same subscription already carries `rg-mazenbahgat-8881` with a
// WAF policy in it, and a WAF policy exists to be attached to something that bills by the
// hour.
//
// The second is the connection ceiling. Production connects to Neon's *pooled* endpoint
// today; on Burstable there is no PgBouncer, so after cutover every client connection lands
// on Postgres directly against a 414-connection ceiling, where the failure mode is
// `FATAL: sorry, too many clients already` on every request rather than a slowdown.
//
// **Cost.** Log Analytics bills on ingestion with a free allowance well above what a
// connection log for one database produces, and the retention here is the 30-day minimum
// which is not separately billed. Metric alerts are ~$0.10 per rule per month. Action groups
// with an email receiver are free. The whole of this file is inside the rounding error on a
// $57 database, which is the only reason it is acceptable to add it to a budget that has a
// cliff at the end.

@description('Region for the workspace. Same as the server.')
param location string

@description('Tags, inherited from main.bicep.')
param tags object

@description('''
Email address that receives budget and metric alerts.

The one place in this design where a real address is written down. That is deliberate: an
action group with no receiver is a rule that fires into nothing, which is worse than no rule
because the portal shows it as configured.
''')
param alertEmailAddress string

// ---------------------------------------------------------------------------------------

@description('''
Where `PostgreSQLLogs` — including the log_connections / log_disconnections lines
postgres.bicep turns on — are shipped so they can be queried.

Flexible Server's own server logs are short-retention and are not queryable; without a
destination those two server parameters produce records nobody can search, which is close
enough to not having them. 30 days is the minimum retention and is the right amount here: the
question this answers is "did something connect that should not have", and that is asked
within days of a suspicion, not months.

`PerGB2018` is the only sensible SKU and carries a monthly free ingestion allowance far above
one database's connection log.
''')
resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'log-switchback-prod'
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
    features: {
      enableLogAccessUsingOnlyResourcePermissions: true
    }
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

@description('''
The single destination for every alert in this deployment — the two metric alerts on the
server and the three thresholds on the consumption budget.

One group rather than one per alert, so that changing where alerts go is one edit. The short
name is limited to 12 characters by Azure and appears in the SMS/email subject line.
''')
resource actionGroup 'Microsoft.Insights/actionGroups@2023-01-01' = {
  name: 'ag-switchback-prod'
  location: 'global'
  tags: tags
  properties: {
    groupShortName: 'switchback'
    enabled: true
    emailReceivers: [
      {
        name: 'owner'
        emailAddress: alertEmailAddress
        // Azure's own budget/alert email, not the "common alert schema" webhook payload.
        useCommonAlertSchema: true
      }
    ]
  }
}

output workspaceId string = workspace.id
output actionGroupId string = actionGroup.id
