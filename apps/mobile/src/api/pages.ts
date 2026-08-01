/**
 * Page sizes more than one module has to agree on. A page size is part of a React Query key, and
 * `@/offline` seeds those keys from disk — a seeded key off by one number seeds nothing, and the
 * screen shows its empty state on a phone holding the whole trail.
 */

/** How many frames the trail gallery asks for. More than fits the strip, fewer than a page. */
export const GALLERY_LIMIT = 24;

/**
 * Reports per page on a trail. Smaller than the website's eight: these sit at the bottom of a
 * long scroll, and a first page that outruns the thumb is one nobody reaches the end of.
 */
export const REVIEW_PAGE_SIZE = 5;
