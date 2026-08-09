#!/usr/bin/env bash
#
# Publish the ingest worker bundle to the Function App, and then prove the app is running it.
#
# This is the only thing that uploads the bundle and points `WEBSITE_RUN_FROM_PACKAGE` at it.
# `infra/azure/ingest.bicep` declares that setting from its `packageUrl` parameter, so a template
# deploy writes back whatever `INGEST_PACKAGE_URL` names — it cannot upload a per-commit zip, which
# is what this does. Both CI and a human invoke this same file so the sequence cannot exist in two
# versions.
#
# **Upload the blob, then name it — never `az functionapp deployment source config-zip`.** Linux
# Consumption runs from an external package URL and has no `scm` site to extract into, so the CLI
# has to pick the blob path over the Kudu one. It picks by reading the *plan* to see whether it is
# Consumption, inside a bare `except:` — and the deploy identity is Website Contributor on the site
# only, which does not carry read on the plan resource. The lookup fails, is swallowed, the app is
# treated as non-Consumption, and the fallback is a Kudu `/api/zipdeploy` that the platform refuses
# with **409** precisely because `WEBSITE_RUN_FROM_PACKAGE` names an external URL. Same command,
# same app: it works for an operator who can read the plan and fails in CI. Doing the two steps
# here removes the guess.
#
# **The URL carries no SAS.** `config-zip` mints one with a 520-week expiry — a ten-year bearer
# credential for the package, in an application setting, in a public repository. `ingest.bicep`
# grants the Function App's system-assigned identity Storage Blob Data Reader on the container
# instead, which is the mechanism Microsoft documents for external package URLs and recommends over
# a SAS. So the setting is an ordinary URL: nothing to redact, rotate, or outlive its usefulness.
#
# **The verification is the point.** An exit code says a blob was uploaded and a setting was
# written; it says nothing about what the host is executing, which is exactly the gap that left a
# five-week-old build in production under a green pipeline. So this asserts two independent things,
# and fails if either is missing:
#
#   1. the live setting names the blob this run uploaded — the ARM write landed, on this app;
#   2. `switchback-ingest-queue-health build=<commit>` appears in Application Insights with a
#      timestamp after the deploy began. The marker is emitted by the first statement of the
#      `ingestPump` handler, on a two-minute timer; the
#      commit is substituted into the bundle by `apps/ingest-worker/scripts/bundle.ts`, so it
#      travels inside the zip. Without it the check degrades to liveness — any build already
#      carrying the current `health.ts` satisfies a bare marker, so a package that failed to mount
#      would pass on the previous build's heartbeat.
#
# Usage: deploy-worker.sh <zip-path> <commit>
# Environment: RESOURCE_GROUP, FUNCTION_APP, APP_INSIGHTS, STORAGE_ACCOUNT.
#
# **Build the zip with something that writes POSIX separators.** CI uses `zip -qr`; on Windows
# PowerShell's `Compress-Archive` writes `\` in archive names, so `node_modules/@azure/functions`
# arrives as one flat entry and the host reports `0 functions found` with
# `Cannot find module '@azure/functions'` — a package that uploads, sets and then does nothing.
# The heartbeat check below is what catches it.

set -euo pipefail

ZIP="${1:?usage: deploy-worker.sh <zip-path> <commit>}"
COMMIT="${2:?usage: deploy-worker.sh <zip-path> <commit>}"
RESOURCE_GROUP="${RESOURCE_GROUP:-rg-switchback-prod-northcentralus}"
FUNCTION_APP="${FUNCTION_APP:-func-switchback-ingest-37ywppu5p7fri}"
APP_INSIGHTS="${APP_INSIGHTS:-appi-switchback-ingest}"
STORAGE_ACCOUNT="${STORAGE_ACCOUNT:-stsbingest37ywppu5p7fri}"
CONTAINER=function-releases

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

# Reduces the setting to a blob name. Used for reporting only, and it strips the query string
# because the value this script writes is not the only value that can be there: anything written by
# `az functionapp deployment source config-zip` carries a SAS, and this repository is public.
package_blob() {
  az functionapp config appsettings list -g "$RESOURCE_GROUP" -n "$FUNCTION_APP" \
    --query "[?name=='WEBSITE_RUN_FROM_PACKAGE'].value | [0]" -o tsv 2>/dev/null |
    sed -e 's/?.*$//' -e 's#^.*/##'
}

# A fresh name every run. The platform requires a restart when a package changes *behind* an
# unchanged URL, and never needs one when the URL itself moves — so uniqueness is what makes the
# trigger sync below sufficient.
BLOB="${COMMIT}-$(date -u +%Y%m%dT%H%M%SZ).zip"
PACKAGE_URL="https://${STORAGE_ACCOUNT}.blob.core.windows.net/${CONTAINER}/${BLOB}"

started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "deploying $(basename "$ZIP") at ${COMMIT} to $FUNCTION_APP; package before this run: $(package_blob)"

az storage blob upload --auth-mode login --overwrite false -o none \
  --account-name "$STORAGE_ACCOUNT" --container-name "$CONTAINER" --name "$BLOB" --file "$ZIP"

# Bytes on the wire, not the exit code of the command that sent them. A short blob mounts as a
# corrupt zip and the host reports `0 functions found`, which reads identically to a package that
# never arrived — twelve minutes later, when the heartbeat has not come.
uploaded="$(az storage blob show --auth-mode login --account-name "$STORAGE_ACCOUNT" \
  --container-name "$CONTAINER" --name "$BLOB" --query properties.contentLength -o tsv)"
local_size="$(wc -c <"$ZIP" | tr -d '[:space:]')"
if [ "$uploaded" != "$local_size" ]; then
  echo "::error::${BLOB} is ${uploaded} bytes and the bundle is ${local_size}. The upload was truncated."
  exit 1
fi
echo "uploaded ${BLOB} (${uploaded} bytes)"

az functionapp config appsettings set -g "$RESOURCE_GROUP" -n "$FUNCTION_APP" -o none \
  --settings "WEBSITE_RUN_FROM_PACKAGE=${PACKAGE_URL}"

# Not optional. After the package changes, a Consumption app whose scale controller still holds the
# old trigger set comes back reporting `0 functions loaded`, `az functionapp function list` returns
# nothing, and nothing ever wakes it — a restart does not fix it because there is no trigger to
# scale on.
az rest --method POST -o none --url \
  "https://management.azure.com/subscriptions/$(az account show --query id -o tsv)/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.Web/sites/${FUNCTION_APP}/syncfunctiontriggers?api-version=2023-12-01"

after="$(az functionapp config appsettings list -g "$RESOURCE_GROUP" -n "$FUNCTION_APP" \
  --query "[?name=='WEBSITE_RUN_FROM_PACKAGE'].value | [0]" -o tsv)"
if [ "$after" != "$PACKAGE_URL" ]; then
  echo "::error::WEBSITE_RUN_FROM_PACKAGE names $(package_blob), not ${BLOB}. The settings write did not land."
  exit 1
fi
echo "package after this run: ${PACKAGE_URL}"

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
