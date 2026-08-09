#!/usr/bin/env bash
# One deployment command for both what-if and apply, so the preview and the write cannot drift.
#
#   infra-deploy.sh what-if|create runtime-identity|main
#
# `main` is subscription-scoped because it declares the resource group; `runtime-identity` is
# scoped to the group it lives in. Both are Incremental — see the workflow header for why that
# is stated rather than left to the default.
set -euo pipefail

action="${1:?what-if or create}"
template="${2:?runtime-identity or main}"

: "${RESOURCE_GROUP:?RESOURCE_GROUP is required}"
: "${TAGS:?TAGS is required}"

case "$template" in
  runtime-identity)
    az deployment group "$action" \
      --resource-group "$RESOURCE_GROUP" \
      --mode Incremental \
      --name switchback-runtime-identity \
      --template-file infra/azure/runtime-identity.bicep \
      --parameters location=northcentralus \
                   identityName=id-switchback-vercel-publisher \
                   vercelTeamSlug=mbahgattechs-projects \
                   vercelProjectName=switchback \
                   tags="$TAGS"
    ;;
  main)
    # The parameter and the server must already agree. `passwordAuthEnabled` defaults to true, so a
    # server flipped to Disabled by the targeted `az` call and a parameter left behind means this
    # deployment switches password authentication back on and reports success for it.
    bash .github/scripts/assert-password-auth-param.sh

    # No PGADMIN_PASSWORD is exported here on purpose. main.bicepparam falls back to empty and
    # postgres.bicep then omits the property, so this run cannot rotate the admin credential.
    # `deployDatabase=false` because charset and collation are fixed by CREATE DATABASE and the
    # provider rejects a PUT restating them — see the parameter's description.
    #
    # `DEPLOY_DELETE_LOCK=false` because this workflow deploys as `id-switchback-infra-deploy`,
    # which does not exist yet and, when created from main.bicep, would hold Contributor and
    # nothing else. Contributor excludes
    # `Microsoft.Authorization/*/Write`, so a template declaring the resource group's
    # `CanNotDelete` lock fails preflight — `what-if` with `InvalidTemplateDeployment` and the
    # apply with `AuthorizationFailed` — whether or not an identical lock already exists, because
    # ARM authorizes the action rather than the diff. The lock is placed and maintained by an
    # Owner out of band; Incremental mode does not delete what this run stops declaring, so
    # skipping the declaration leaves the live lock in place. See main.bicepparam, which binds
    # this variable and records the measured permission set.
    export DEPLOY_DELETE_LOCK=false
    az deployment sub "$action" \
      --location northcentralus \
      --name switchback-db \
      --template-file infra/azure/main.bicep \
      --parameters infra/azure/main.bicepparam \
      --parameters deployDatabase=false
    ;;
  *)
    echo "::error::unknown template '$template'"
    exit 1
    ;;
esac
