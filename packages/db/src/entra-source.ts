import { ClientAssertionCredential, DefaultAzureCredential } from '@azure/identity';
import { getVercelOidcToken } from '@vercel/oidc';
import type { TokenSource } from './entra-token';

/** Where a process gets its database access tokens, and how it proves who it is. */

export const POSTGRES_SCOPE = 'https://ossrdbms-aad.database.windows.net/.default';

/**
 * How this process authenticates to Postgres. One setting rather than three, because the
 * combinations that are not listed here are all misconfigurations.
 *
 * `password` is the default so that deploying this code changes nothing until a consumer is
 * deliberately moved.
 */
export type DatabaseAuthMode = 'password' | 'entra' | 'entra-vercel';

export function databaseAuthMode(env: NodeJS.ProcessEnv = process.env): DatabaseAuthMode {
  const mode = env.DATABASE_AUTH;
  if (mode === 'entra' || mode === 'entra-vercel') return mode;
  if (mode !== undefined && mode !== 'password') {
    throw new Error(`DATABASE_AUTH must be password, entra or entra-vercel; got "${mode}".`);
  }
  return 'password';
}

/**
 * Vercel has no managed identity, so it proves itself with an OIDC token Azure trades for an
 * access token against the federated credential on `id-switchback-vercel-publisher`.
 *
 * `getVercelOidcToken` is *referenced* here and called later, which Vercel's OIDC reference
 * requires: on a deployed function the token is not in the environment at all, it arrives as
 * the `x-vercel-oidc-token` header of the request in scope. No custom audience — the deployed
 * federated credentials trust Vercel's default, `https://vercel.com/mbahgattechs-projects`.
 */
function vercelCredential(env: NodeJS.ProcessEnv): ClientAssertionCredential {
  const tenantId = env.AZURE_TENANT_ID;
  const clientId = env.AZURE_CLIENT_ID;
  if (!tenantId || !clientId) {
    throw new Error('entra-vercel needs AZURE_TENANT_ID and AZURE_CLIENT_ID.');
  }
  return new ClientAssertionCredential(tenantId, clientId, () => getVercelOidcToken());
}

export function createEntraTokenSource(
  mode: DatabaseAuthMode,
  env: NodeJS.ProcessEnv = process.env,
): TokenSource {
  if (mode === 'password') throw new Error('createEntraTokenSource called in password mode.');
  // `DefaultAzureCredential` covers the Function App's managed identity, a workload identity,
  // and an operator's `az login` without any of them being named here.
  const credential = mode === 'entra-vercel' ? vercelCredential(env) : new DefaultAzureCredential();

  return async () => {
    const token = await credential.getToken(POSTGRES_SCOPE);
    if (!token) throw new Error('Entra returned no token for the Postgres scope.');
    return token;
  };
}
