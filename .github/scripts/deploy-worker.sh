#!/usr/bin/env bash
#
# Publish the ingest worker bundle to the Function App, and then prove the app is running it.
#
# This is the only thing that writes `WEBSITE_RUN_FROM_PACKAGE`. `infra/azure/ingest.bicep`
# deliberately does not declare that setting — an ARM application-settings write replaces the
# collection whole and would fight the zip push — so a template deploy leaves the app codeless
# until this script runs. Template first, then this. Both CI and a human invoke this same file so
# the sequence cannot exist in two versions.
#
# **The verification is the point.** An exit code from `config-zip` says a blob was uploaded and a
# setting was written; it says nothing about what the host is executing, which is exactly the gap
# that left a five-week-old build in production under a green pipeline. So this asserts two
# independent things, and fails if either is missing:
#
#   1. the package setting names a different blob than it did before this run — the deploy was not
#      a silent no-op;
#   2. `switchback-ingest-queue-health build=<commit>` appears in Application Insights with a
#      timestamp after the deploy began. The marker is emitted by the first statement of the
#      `ingestPump` handler, on a two-minute timer, ahead of the `INGEST_QUEUE_DRIVER` guard; the
#      commit is substituted into the bundle by `apps/ingest-worker/scripts/bundle.ts`, so it
#      travels inside the zip. Without it the check degrades to liveness — any build already
#      carrying the current `health.ts` satisfies a bare marker, so a package that failed to mount
#      would pass on the previous build's heartbeat.
#
# Usage: deploy-worker.sh <zip-path> <commit>
# Environment: RESOURCE_GROUP, FUNCTION_APP, APP_INSIGHTS.

set -euo pipefail

ZIP="${1:?usage: deploy-worker.sh <zip-path> <commit>}"
COMMIT="${2:?usage: deploy-worker.sh <zip-path> <commit>}"
RESOURCE_GROUP="${RESOURCE_GROUP:-rg-switchback-prod-northcentralus}"
FUNCTION_APP="${FUNCTION_APP:-func-switchback-ingest-37ywppu5p7fri}"
APP_INSIGHTS="${APP_INSIGHTS:-appi-switchback-ingest}"

# How long to wait for a heartbeat. The pump fires every two minutes and Application Insights
# ingests within about two more, against a cold start that can take one — so twelve minutes is
# roughly three chances rather than a margin on one.
HEARTBEAT_TIMEOUT_S="${HEARTBEAT_TIMEOUT_S:-720}"
HEARTBEAT="switchback-ingest-queue-health build=${COMMIT}"

test -f "$ZIP" || { echo "::error::no bundle at $ZIP"; exit 1; }

# The heartbeat proof is an Application Insights query, and that command lives in an extension
# `ubuntu-latest` does not preinstall. Establishing it here rather than discovering it inside the
# poll loop, where a missing extension is indistinguishable from a host that never started.
az monitor app-insights component show --app "$APP_INSIGHTS" -g "$RESOURCE_GROUP" -o none 2>/dev/null || {
  echo "::error::'az monitor app-insights' is unavailable, so the deploy cannot be verified."
  echo "::error::Run 'az extension add --name application-insights' before this script."
  exit 1
}

# Identifies the blob without exposing the SAS query string the setting also carries. Never echo
# the setting itself: this repository is public and that value is a bearer credential for the
# package.
package_blob() {
  az functionapp config appsettings list -g "$RESOURCE_GROUP" -n "$FUNCTION_APP" \
    --query "[?name=='WEBSITE_RUN_FROM_PACKAGE'].value | [0]" -o tsv 2>/dev/null |
    sed -e 's/?.*$//' -e 's#^.*/##'
}

before="$(package_blob)"
started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "deploying $(basename "$ZIP") at ${COMMIT} to $FUNCTION_APP; package before this run: ${before:-<unset>}"

az functionapp deployment source config-zip \
  -g "$RESOURCE_GROUP" -n "$FUNCTION_APP" --src "$ZIP" -o none

# Not optional. After the package changes, a Consumption app whose scale controller still holds the
# old trigger set comes back reporting `0 functions loaded`, `az functionapp function list` returns
# nothing, and nothing ever wakes it — a restart does not fix it because there is no trigger to
# scale on.
az rest --method POST -o none --url \
  "https://management.azure.com/subscriptions/$(az account show --query id -o tsv)/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.Web/sites/${FUNCTION_APP}/syncfunctiontriggers?api-version=2023-12-01"

after="$(package_blob)"
echo "package after this run: ${after:-<unset>}"
if [ -z "$after" ]; then
  echo "::error::WEBSITE_RUN_FROM_PACKAGE is unset after the push — the app has no code to run."
  exit 1
fi
if [ "$after" = "$before" ]; then
  echo "::error::the package blob did not change. The push was a no-op and the app is still on ${before}."
  exit 1
fi

echo "waiting up to ${HEARTBEAT_TIMEOUT_S}s for '${HEARTBEAT}' emitted after ${started_at}"
deadline=$(( $(date +%s) + HEARTBEAT_TIMEOUT_S ))
while :; do
  # A query that errors and a query that returns zero rows mean different things: the first is a
  # broken credential or a throttled workspace, the second is a host that is not running the
  # package. Conflating them under `|| true` is how a twelve-minute wait ends by naming the wrong
  # cause and sending the on-caller to `az webapp log tail` for a host that is fine.
  if ! beats="$(az monitor app-insights query --app "$APP_INSIGHTS" -g "$RESOURCE_GROUP" --offset 1h \
    --analytics-query "traces | where timestamp > datetime(${started_at}) | where message has \"${HEARTBEAT}\" | summarize heartbeats = count()" \
    --query "tables[0].rows[0][0]" -o tsv)"; then
    echo "::warning::the Application Insights query failed; retrying until the deadline."
    beats=''
  fi

  if [ -n "${beats:-}" ] && [ "$beats" -gt 0 ] 2>/dev/null; then
    echo "the running app emitted ${beats} '${HEARTBEAT}' line(s) after the deploy began."
    exit 0
  fi

  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "::error::no heartbeat naming ${COMMIT} in Application Insights within ${HEARTBEAT_TIMEOUT_S}s."
    echo "::error::The package was replaced but the host is not running it. Check the host log:"
    echo "::error::  az webapp log tail -g ${RESOURCE_GROUP} -n ${FUNCTION_APP}"
    exit 1
  fi
  sleep 30
done
