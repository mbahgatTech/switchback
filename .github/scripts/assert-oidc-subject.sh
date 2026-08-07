#!/usr/bin/env bash
#
# Fail if the OIDC subject GitHub issues no longer matches the federated credential the worker
# deploy job assumes.
#
# The credential this checks was written against `repo:<owner>/<repo>:ref:refs/heads/master` and
# GitHub issues `repo:<owner>@<ownerId>/<repo>@<repoId>:ref:refs/heads/master`. Nothing caught it:
# the deploy job is gated on pushes to master, so the mismatch would first have surfaced as a red
# master and a Function App still serving whatever a human last pushed — B1's failure restored.
#
# So the check runs where it is cheap and unconditional: every push and every pull request, in the
# job that builds the bundle. It reads the expected prefix out of `infra/azure/ingest.bicep` rather
# than repeating it, so the template and the token cannot disagree without this saying so.
#
# Environment: ACTIONS_ID_TOKEN_REQUEST_URL, ACTIONS_ID_TOKEN_REQUEST_TOKEN (from `id-token: write`).

set -euo pipefail

TEMPLATE="${TEMPLATE:-infra/azure/ingest.bicep}"
AUDIENCE='api://AzureADTokenExchange'

expected="$(sed -n "s/^param workerDeploySubjectPrefix string = '\(.*\)'$/\1/p" "$TEMPLATE")"
test -n "$expected" || {
  echo "::error::no workerDeploySubjectPrefix in $TEMPLATE — this check has nothing to compare against."
  exit 1
}
echo "expected prefix: ${expected}"

# A pull request from a fork gets a read-only token and no OIDC minting endpoint. Skipping is
# correct there and only there: on a push, an absent endpoint means the workflow lost `id-token:
# write` and the check would otherwise pass by doing nothing.
if [ -z "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ]; then
  if [ "${GITHUB_EVENT_NAME:-}" = 'pull_request' ]; then
    echo "no OIDC endpoint on this event — fork pull requests cannot mint a token. Skipped."
    exit 0
  fi
  echo "::error::no ACTIONS_ID_TOKEN_REQUEST_URL. The job lost 'permissions: id-token: write'."
  exit 1
fi

token="$(curl -sSf -H "Authorization: bearer ${ACTIONS_ID_TOKEN_REQUEST_TOKEN}" \
  "${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=${AUDIENCE}" | jq -r .value)"

# Claims only. The signature half is Azure's to verify; printing the whole token would put a
# bearer credential in a public build log.
payload="$(printf '%s' "$token" | cut -d. -f2 | tr '_-' '/+')"
case $(( ${#payload} % 4 )) in
  2) payload="${payload}==" ;;
  3) payload="${payload}=" ;;
esac
subject="$(printf '%s' "$payload" | base64 -d 2>/dev/null | jq -r .sub)"

echo "issued subject : ${subject}"
echo "expected prefix: ${expected}"

case "$subject" in
  "${expected}:"*) ;;
  *)
    echo "::error::GitHub issues a subject this repository's federated credentials do not match."
    echo "::error::'azure/login' would fail with AADSTS70021 and no worker would deploy. Read the"
    echo "::error::live prefix with 'gh api repos/${GITHUB_REPOSITORY:-<owner>/<repo>}/actions/oidc/customization/sub'"
    echo "::error::and update workerDeploySubjectPrefix in ${TEMPLATE}, then redeploy the template."
    exit 1
    ;;
esac

# The other half of the subject, and the half a GitHub `environment:` declaration rewrites. The
# deploy job runs only on master, so that is the only suffix its credential can ever present.
if [ "${GITHUB_REF:-}" = 'refs/heads/master' ] && [ "$subject" != "${expected}:ref:refs/heads/master" ]; then
  echo "::error::on master the issued subject is '${subject}', not '${expected}:ref:refs/heads/master'."
  echo "::error::A job-level 'environment:' replaces the ref suffix with ':environment:<name>'."
  exit 1
fi

echo "the deploy credential's subject still matches what GitHub issues."
