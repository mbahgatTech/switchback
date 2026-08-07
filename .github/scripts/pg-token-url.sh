# Exports DATABASE_URL and DIRECT_DATABASE_URL carrying a freshly minted Entra access token.
#
# Sourced, not executed, so the exports land in the calling step and nowhere else — the token
# authenticates a Postgres administrator, and `$GITHUB_ENV` would hand it to every later step.
# Requires PGHOST, PGUSER and PGDATABASE, and an `azure/login` earlier in the job.
set -euo pipefail

: "${PGHOST:?PGHOST is required}"
: "${PGUSER:?PGUSER is required}"
: "${PGDATABASE:?PGDATABASE is required}"

_token="$(az account get-access-token --tenant f0f92920-ce90-42c9-b87f-3ea8644bccd8 \
  --resource-type oss-rdbms --query accessToken -o tsv)"
echo "::add-mask::$_token"

# Percent-encoded before it reaches the userinfo of a URL: a JWT is base64url and carries no
# reserved character today, but a `+` or `/` from a future encoding would silently truncate the
# authority rather than fail.
_encoded="$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.stdin.read().strip(), safe=""))' <<< "$_token")"
echo "::add-mask::$_encoded"

# Both TLS parameters, because the two readers of this string honour different ones. Three
# consumers read it, all in ci.yml: a node-postgres `pg.Client`, `prisma db push`, and
# `apply-spatial.ts`, which builds a `PrismaClient`. No libpq process reads this URL — the
# libpq callers elsewhere are driven by PG* variables and PGSSLROOTCERT.
#
# Prisma's engines read `sslmode` but understand only disable/prefer/require, so `verify-full`
# leaves them at their default; `sslaccept=strict` is the key they verify on, and it is chain
# plus hostname. node-postgres is the mirror image: `verify-full` makes it verify chain and
# hostname, and it ignores `sslaccept` entirely, sending no SSLRequest when that is all it is
# given. Neither parameter makes TLS mandatory for a Prisma engine — `require_secure_transport
# = ON` on the server does. See the measurement in infra/azure/postgres.bicep.
_url="postgresql://${PGUSER}:${_encoded}@${PGHOST}:5432/${PGDATABASE}?sslmode=verify-full&sslaccept=strict"
echo "::add-mask::$_url"

export DATABASE_URL="$_url"
export DIRECT_DATABASE_URL="$_url"
unset _token _encoded _url
