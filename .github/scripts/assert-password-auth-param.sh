#!/usr/bin/env bash
# Refuses a main.bicep deployment whose passwordAuthEnabled disagrees with the server's live
# authConfig, which is how a forgotten parameter silently switches password authentication back on.
set -euo pipefail

RESOURCE_GROUP="${RESOURCE_GROUP:-rg-switchback-prod-northcentralus}"
SERVER_NAME="${SERVER_NAME:-psql-switchback-prod-37ywppu5p7fri}"
PARAM_FILE="${PARAM_FILE:-infra/azure/main.bicepparam}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# `--outfile` rather than `--stdout`: the CLI writes stdout in the console code page, so a single
# non-ASCII character anywhere in the file makes the command raise instead of compiling.
az bicep build-params --file "$PARAM_FILE" --outfile "$work/params.json" > /dev/null

declared="$(node -e '
  const compiled = require(process.argv[1]);
  const value = compiled.parameters?.passwordAuthEnabled?.value;
  if (typeof value !== "boolean") {
    console.error("passwordAuthEnabled is absent or not a boolean");
    process.exit(2);
  }
  process.stdout.write(value ? "Enabled" : "Disabled");
' "$work/params.json")"

az postgres flexible-server show \
  -g "$RESOURCE_GROUP" -n "$SERVER_NAME" \
  --query authConfig.passwordAuth -o json > "$work/live.json"
live="$(tr -d '"' < "$work/live.json" | tr -d '[:space:]')"

# An unauthenticated or misdirected read returns nothing at all, which must fail rather than
# compare equal to nothing.
case "$live" in
  Enabled | Disabled) ;;
  *)
    echo "::error::live authConfig.passwordAuth read back as '$live' — not a verdict"
    exit 1
    ;;
esac

if [ "$declared" != "$live" ]; then
  echo "::error::$PARAM_FILE declares passwordAuth $declared and $SERVER_NAME is $live."
  echo "Deploying main.bicep would write $declared over the live setting. Reconcile them first:"
  echo "  the server is changed with 'az postgres flexible-server update --password-auth', and"
  echo "  the parameter is changed in $PARAM_FILE. Both, in the same change."
  exit 1
fi

echo "passwordAuth agrees: $PARAM_FILE says $declared, $SERVER_NAME is $live"
