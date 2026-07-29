/**
 * Page sizes that more than one module has to agree on.
 *
 * These would live beside the components that ask for them — and they did — except that a
 * page size is part of a React Query key, and `@/offline` seeds those keys from a copy on
 * disk so that a trail opened without a signal renders from storage instead of an error.
 * A seeded key that differs from the live one by a single number seeds nothing: the screen
 * shows the empty state, on a phone that has the whole trail saved on it.
 *
 * So the number is written once, here, and imported by both sides. Changing it changes
 * what a download reproduces, which is the property that matters.
 */

/** How many frames the trail gallery asks for. More than fits the strip, fewer than a page. */
export const GALLERY_LIMIT = 24;

/**
 * Reports per page on a trail.
 *
 * Smaller than the website's eight because these sit at the bottom of a long scroll on a
 * short screen, and a first page that outruns the thumb is a page nobody reaches the end of.
 */
export const REVIEW_PAGE_SIZE = 5;
