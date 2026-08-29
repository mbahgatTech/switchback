import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import config from '../app.config';

/**
 * Background recording is half configuration. A task asked for at runtime on a host whose
 * `Info.plist` never declared the capability throws, and the hike stops at the lock screen with
 * nothing in the code to point at — so the declaration is gated here, where a build machine is
 * not needed to check it.
 *
 * `app.config.ts` is imported and evaluated rather than read as text: what ships is the resolved
 * object, and asserting on the source would pass a config that was correct but unreachable.
 */

const mobileRoot = fileURLToPath(new URL('..', import.meta.url));

/** The options Expo will hand `expo-location`'s config plugin, or nothing if it is not declared. */
function locationPluginOptions(): Record<string, unknown> | null {
  for (const entry of config.plugins ?? []) {
    if (!Array.isArray(entry) || entry[0] !== 'expo-location') continue;
    return (entry[1] ?? {}) as Record<string, unknown>;
  }
  return null;
}

describe('the iOS capability a recording needs to outlive the lock screen', () => {
  it('declares the expo-location plugin', () => {
    expect(locationPluginOptions()).not.toBeNull();
  });

  it('enables background location, which is what writes UIBackgroundModes', () => {
    expect(locationPluginOptions()?.isIosBackgroundLocationEnabled).toBe(true);
  });

  it('drops the pre-iOS-11 always key rather than let the plugin fill it with placeholder prose', () => {
    expect(locationPluginOptions()?.locationAlwaysPermission).toBe(false);
  });

  it('asks for Always in words that say what it is for', () => {
    const strings: Record<string, unknown> = config.ios?.infoPlist ?? {};
    const always = strings.NSLocationAlwaysAndWhenInUseUsageDescription;
    expect(typeof always).toBe('string');
    expect(String(always)).toMatch(/screen off/i);
  });
});

/** Every recorder source file, as `[repo-relative path, contents]`. */
function recorderSources(): [string, string][] {
  const dir = path.join(mobileRoot, 'src', 'record');
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map((entry) => [
      path.join('src', 'record', entry.name),
      readFileSync(path.join(dir, entry.name), 'utf8'),
    ]);
}

describe('nothing in the recorder reacts to the app going away', () => {
  /*
   * The rule earns its place by having been broken: recording used to stop at the lock screen,
   * and the cheapest way to reintroduce that is a well-meant `AppState` listener that pauses to
   * save battery. A source scan is the right instrument because the claim is about the absence
   * of code, and because there is no iOS simulator on this machine to observe it any other way.
   */
  it('has no AppState handler that names background or inactive', () => {
    const offenders = recorderSources()
      .filter(([, source]) => source.includes('AppState'))
      .filter(([, source]) => /['"](?:background|inactive)['"]/.test(source))
      .map(([file]) => file);
    expect(offenders, 'a hike must not pause because the phone went in a pocket').toEqual([]);
  });
});

describe('what the Record screen promises', () => {
  const screen = readFileSync(path.join(mobileRoot, 'app', '(tabs)', 'record.tsx'), 'utf8');

  it('no longer tells hikers that locking the phone stops the track', () => {
    expect(screen).not.toMatch(/the track stops until you come back/);
  });

  it('derives what it says about the screen from the recorder, not from a fixed promise', () => {
    expect(screen).toMatch(/trackingNote\(recording\)/);
    expect(screen).toMatch(/recording\.tracking === 'foreground'|tracking === 'foreground'/);
  });

  it('tells a hiker who allowed only "While Using" what that costs them', () => {
    expect(screen).toMatch(/mayNotSurviveTermination/);
    expect(screen).toMatch(/Always/);
  });
});
