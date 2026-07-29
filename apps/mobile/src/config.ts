import Constants from 'expo-constants';

/**
 * Where the API lives.
 *
 * In production this is a constant. In development it is a small puzzle worth solving
 * properly: the app runs in Expo Go *on a phone*, so `localhost` is the phone itself and
 * points at nothing. The usual workaround is to paste a LAN IP into a file and re-paste it
 * every time the router reassigns one.
 *
 * Metro already knows the answer. Expo exposes the host the bundle was served from, and
 * the machine serving the bundle is the machine running `next dev` — so the API is that
 * same host on port 3000, derived rather than configured.
 */
const DEV_API_PORT = 3000;

/**
 * Both fields below are read as `unknown` and narrowed rather than trusted.
 *
 * That is not defensive habit: `extra` is typed `Record<string, any>` because its contents
 * are whatever `app.config.ts` put there, and `expoGoConfig` is populated only under Expo
 * Go — it is absent in a dev client and in a release build. Narrowing turns both into the
 * `string | null` the rest of the file already has to handle.
 */
function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function field(source: unknown, key: string): string | null {
  if (typeof source !== 'object' || source === null) return null;
  return nonEmptyString((source as Record<string, unknown>)[key]);
}

function configuredApiUrl(): string | null {
  const fromExtra = field(Constants.expoConfig?.extra, 'apiUrl');
  if (fromExtra) return fromExtra;
  // `EXPO_PUBLIC_*` is inlined by Metro at bundle time, so this is a literal by the time it
  // runs. Checked second: an explicit value in `extra` came from the same variable anyway,
  // and this branch is the escape hatch for a bundle built without app.config.ts running.
  return nonEmptyString(process.env.EXPO_PUBLIC_API_URL);
}

function metroHost(): string | null {
  /**
   * `hostUri` is "192.168.1.42:8081" in Expo Go and on a dev client. `debuggerHost` is the
   * older field, still the only one populated in some Expo Go builds — hence both.
   */
  const hostUri =
    nonEmptyString(Constants.expoConfig?.hostUri) ?? field(Constants.expoGoConfig, 'debuggerHost');
  if (!hostUri) return null;
  return nonEmptyString(hostUri.split(':')[0]);
}

export function apiBaseUrl(): string {
  const configured = configuredApiUrl();
  if (configured) return configured.replace(/\/+$/, '');

  const host = metroHost();
  if (host) return `http://${host}:${DEV_API_PORT}`;

  /**
   * Reached only in a production bundle with no `EXPO_PUBLIC_API_URL`, which is a build
   * misconfiguration rather than a runtime condition — every request would 404 against a
   * host that does not exist. Failing here names the actual problem.
   */
  throw new Error(
    'No API URL: set EXPO_PUBLIC_API_URL in the root .env before building a release bundle.',
  );
}

export const trpcUrl = (): string => `${apiBaseUrl()}/api/trpc`;
export const authUrl = (path: string): string => `${apiBaseUrl()}/api/auth/mobile/${path}`;
