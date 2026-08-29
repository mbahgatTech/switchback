import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import type { ExpoConfig } from 'expo/config';

/**
 * Expo config.
 *
 * A `.ts` config rather than `app.json` for one reason: Expo would otherwise read a
 * `.env` sitting next to this file, and this repo deliberately has exactly one, at the
 * root, shared by the web app (through `dotenv-cli`), Prisma, and vitest. Loading it here
 * keeps that single-source rule intact rather than starting a second copy that drifts.
 */
loadEnv({ path: path.resolve(__dirname, '../../.env') });

/**
 * Bundle identifier / App ID.
 *
 * Also what Apple puts in the `aud` of a *native* identity token, which the server checks
 * against `AUTH_APPLE_BUNDLE_ID` — the two strings have to match exactly. See
 * docs/auth-apple.md for why that is a different value from `AUTH_APPLE_ID`.
 */
const BUNDLE_ID = process.env.AUTH_APPLE_BUNDLE_ID ?? 'app.switchback.ios';

const config: ExpoConfig = {
  name: 'Switchback',
  slug: 'switchback',
  version: '0.1.0',
  orientation: 'portrait',
  scheme: 'switchback',
  userInterfaceStyle: 'automatic',
  // No `newArchEnabled`: React Native 0.86 removed the old architecture entirely, and SDK
  // 57 dropped the flag from `ExpoConfig` along with it. Setting it is now a type error,
  // which is how this comment came to exist.
  // iOS only, on purpose. The "web version" of Switchback is `apps/web` — a real Next.js
  // site with server rendering and its own routes — not React Native compiled to DOM, so
  // there is no react-native-web here and no android/ directory to keep in sync.
  platforms: ['ios'],
  ios: {
    bundleIdentifier: BUNDLE_ID,
    supportsTablet: true,
    infoPlist: {
      // Recording an activity is the whole point of Phase 4, and iOS shows these strings
      // verbatim in the permission dialog. Written now so the prompts are never the
      // placeholder text an Expo template ships with.
      //
      // The when-in-use string describes background recording because that is what when-in-use
      // buys here: with `location` in `UIBackgroundModes`, this is the authorization the track
      // actually runs on. Describing only the on-screen map would be asking for one thing and
      // doing another, and leaving the honest sentence attached to the "Always" prompt most
      // people decline.
      NSLocationWhenInUseUsageDescription:
        'Switchback records your hike — including with the screen off and the phone in your pocket — and shows your position on the trail.',
      NSLocationAlwaysAndWhenInUseUsageDescription:
        'Switchback keeps recording your route and can alert you if you leave the trail, even with the screen off. Allowing this also lets iOS restart the recording if it ever has to close the app.',
      NSMotionUsageDescription:
        'Step and elevation data makes your recorded activity stats more accurate.',
      /**
       * Read-only, and only for the pictures somebody picks. There is no
       * `NSPhotoLibraryAddUsageDescription` because nothing here writes back to the camera
       * roll, and no `NSCameraUsageDescription` because the picker never opens the camera —
       * asking for either would be a permission dialog for a capability the app does not have.
       */
      NSPhotoLibraryUsageDescription:
        'Choose photographs from your library to add to a trail. They are resized on this phone before they are sent.',
      ITSAppUsesNonExemptEncryption: false,
      /**
       * The explore map is a `WebView` pointed at our own Next.js server, which in
       * development is `http://<this-machine>:3000` on the LAN. App Transport Security
       * blocks plain HTTP by default and a blocked frame is a blank rectangle with no
       * error anywhere the app can see it. `NSAllowsLocalNetworking` permits exactly the
       * private address ranges and nothing on the open internet — unlike
       * `NSAllowsArbitraryLoads`, it does not need an App Store justification.
       */
      NSAppTransportSecurity: { NSAllowsLocalNetworking: true },
    },
  },
  plugins: [
    'expo-router',
    'expo-secure-store',
    /**
     * Background location. `isIosBackgroundLocationEnabled` is what puts `location` into
     * `UIBackgroundModes`, and without that key iOS suspends the app at the lock screen and
     * `startLocationUpdatesAsync` throws rather than registering the task — which is exactly
     * how `@/record/background` detects a host that cannot carry a hike.
     *
     * `locationAlwaysPermission: false` deletes `NSLocationAlwaysUsageDescription`. The plugin
     * would otherwise write its own placeholder prose into it. It is the older of the two:
     * `NSLocationAlwaysAndWhenInUseUsageDescription`, set above, replaced it in iOS 11 and is the
     * one iOS 15 shows.
     * The three strings this app does define are left alone: the plugin only fills a key that
     * has no value yet.
     */
    [
      'expo-location',
      {
        isIosBackgroundLocationEnabled: true,
        locationAlwaysPermission: false,
      },
    ],
  ],
  experiments: {
    typedRoutes: true,
  },
  extra: {
    /**
     * Where the API lives. Unset in development, where `src/config.ts` derives it from the
     * Metro host instead — a phone running Expo Go cannot reach `localhost`, and hardcoding
     * a LAN IP means editing a file every time the router hands out a new lease.
     */
    apiUrl: process.env.EXPO_PUBLIC_API_URL ?? null,
  },
};

export default config;
