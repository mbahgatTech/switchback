/**
 * Whether the reader has asked their machine for less motion. One predicate rather than one
 * per component, so the map and the control that labels it cannot disagree. Read on demand
 * rather than subscribed to — a `matchMedia` listener would tear down a running animation.
 */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}
