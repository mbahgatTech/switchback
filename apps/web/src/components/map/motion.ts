/**
 * Whether the reader has asked their machine for less motion.
 *
 * A single predicate rather than one per component, because the two callers have to agree:
 * the map decides whether to animate and the control decides what to call the button, and a
 * button reading "Fly the route" over a map that will show a still is worse than either
 * behaviour on its own.
 *
 * Read at the moment it is needed rather than subscribed to. The setting is an operating
 * system preference that nobody changes mid-flight, and a `matchMedia` listener would mean
 * tearing down a running animation from inside a media query.
 */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}
