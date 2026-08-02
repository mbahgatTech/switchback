/**
 * What a trail is called on screen. One module because `displayName` is derived and nullable,
 * and a dozen call sites each falling back to `name` their own way is a dozen chances to blank one.
 */

/**
 * The two fields titling needs. `displayName` is optional rather than `string | null` because
 * a trail the offline layer stored before that column existed has no such key at all.
 */
export interface TitledTrail {
  /** The name OpenStreetMap gave the path. Immutable, and always the fallback. */
  name: string;
  displayName?: string | null;
}

/** The derived title where there is a usable one. Absent, null and blank all count as none. */
export function displayNameOf(trail: TitledTrail): string | null {
  const derived = trail.displayName;
  return derived != null && derived.trim() !== '' ? derived : null;
}

/** The title to print — "Vesper Peak via Headlee Pass Trail", else "Headlee Pass Trail". */
export function trailTitle(trail: TitledTrail): string {
  return displayNameOf(trail) ?? trail.name;
}
