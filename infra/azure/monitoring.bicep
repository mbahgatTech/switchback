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
// is also not dedicated, and by a wide margin: measured for July 2026, `rg-mazenbahgat-8881`
// alone billed 179.85 USD of a 191.39 USD subscription total, against a 150 USD credit. That
// is why there are two budgets — the cliff at subscription scope in main.bicep, and this
// file's `switchback-database` at resource-group scope, which is the only one whose number is
// about Postgres.
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

@description('Budget for this resource group alone, in USD. See main.bicep.')
param workloadBudgetUsd int

@description('First day of the budget window, UTC, as `yyyy-MM-01`. Fixed, not `utcNow()`.')
param budgetStartDate string

@description('Last day of the budget window, UTC.')
param budgetEndDate string

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
server, the three thresholds on this file's resource-group budget, and the two on the
subscription budget in main.bicep.

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

@description('''
The budget for **this workload**, evaluated against this resource group only.

`main.bicep` also declares a subscription-scoped budget pegged to the monthly credit, and the
two are not redundant — they answer different questions, and until this revision only the
subscription one existed, which meant neither question was answered.

The subscription is the thing that gets *disabled*: exceed the credit with the spending limit
on and every resource in it is deallocated, including this server, regardless of whose spend
did it. So the cliff has to be watched at subscription scope.

But that scope cannot tell you anything about Postgres. Measured for July 2026, subscription
spend was 191.39 USD, of which 179.85 came from `rg-mazenbahgat-8881` and 0.00 from this
resource group. A 150 USD subscription budget is therefore at 128% before this database bills
a cent, and graded thresholds on it fire from birth on somebody else's Front Door.

This one is scoped to `rg-switchback-prod-northcentralus`, so its number is the database and
nothing else. Steady state ~57 USD against 150 is ~38%, which puts every threshold below the
line with room, and each threshold names a real event rather than a fraction:

  50%  (75 USD)  — an autogrow step, or Microsoft Defender for open-source relational
                   databases being switched on. Both are legitimate; both should be a message
                   rather than a discovery on next month's bill.
  75%  (112 USD) — approaching the General Purpose escalation's ~137 USD. If nobody
                   deliberately escalated the tier, this is the signal something is wrong.
  90%  (135 USD) — this workload alone is about to consume the whole credit, which means the
                   spending limit deallocates it and the site goes down.

`Actual` rather than `Forecasted` throughout, for the same reason as the subscription budget:
a forecast over a nearly flat line is noise, and a false alarm trains a shrug.
''')
resource workloadBudget 'Microsoft.Consumption/budgets@2023-05-01' = {
  name: 'switchback-database'
  properties: {
    category: 'Cost'
    timeGrain: 'Monthly'
    amount: workloadBudgetUsd
    timePeriod: {
      startDate: budgetStartDate
      endDate: budgetEndDate
    }
    notifications: {
      half: {
        enabled: true
        operator: 'GreaterThan'
        threshold: 50
        thresholdType: 'Actual'
        contactEmails: [alertEmailAddress]
        contactGroups: [actionGroup.id]
      }
      threeQuarters: {
        enabled: true
        operator: 'GreaterThan'
        threshold: 75
        thresholdType: 'Actual'
        contactEmails: [alertEmailAddress]
        contactGroups: [actionGroup.id]
      }
      nearlyOut: {
        enabled: true
        operator: 'GreaterThan'
        threshold: 90
        thresholdType: 'Actual'
        contactEmails: [alertEmailAddress]
        contactGroups: [actionGroup.id]
      }
    }
  }
}
