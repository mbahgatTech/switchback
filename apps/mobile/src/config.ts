import Constants from 'expo-constants';

/**
 * Where the API lives. A constant in production; in development it is derived rather than
 * configured — a phone cannot reach `localhost`, but Expo exposes the host Metro served the
 * bundle from, and that machine is the one running `next dev`.
 */
const DEV_API_PORT = 3000;

/**
 * `extra` is typed `Record<string, any>` and `expoGoConfig` exists only under Expo Go, so both
 * are read as `unknown` and narrowed to the `string | null` the rest of the file handles.
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
  // `EXPO_PUBLIC_*` is inlined by Metro at bundle time and is readable by anyone holding the
  // app — never put a secret behind it. Checked second: it is the escape hatch for a bundle
  // built without app.config.ts running.
  return nonEmptyString(process.env.EXPO_PUBLIC_API_URL);
}

function metroHost(): string | null {
  // `hostUri` is "192.168.1.42:8081" in Expo Go and on a dev client; `debuggerHost` is the
  // older field, still the only one populated in some Expo Go builds — hence both.
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

  // Reached only in a production bundle with no `EXPO_PUBLIC_API_URL` — a build
  // misconfiguration, not a runtime condition. Failing here names the actual problem.
  throw new Error(
    'No API URL: set EXPO_PUBLIC_API_URL in the root .env before building a release bundle.',
  );
}

export const trpcUrl = (): string => `${apiBaseUrl()}/api/trpc`;
export const authUrl = (path: string): string => `${apiBaseUrl()}/api/auth/mobile/${path}`;
