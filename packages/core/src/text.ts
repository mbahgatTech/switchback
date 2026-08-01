/** Small text helpers shared by both clients. */

/**
 * The noun for a count, not the phrase — call sites set the number in the mono face and the
 * label in the text face. Compared by magnitude, so −1 takes the singular and 0 the plural.
 */
export function plural(count: number, singular: string, pluralForm?: string): string {
  return Math.abs(count) === 1 ? singular : (pluralForm ?? `${singular}s`);
}

/**
 * A URL segment from a name a person typed. Not the trail slugifier in `@switchback/ingest`,
 * which folds in a region and is tuned for OSM names. `fallback` is required and per-call
 * because it appears in a URL the user sees: an empty segment would collide with the
 * collection route above it.
 */
export function slugify(name: string, fallback: string): string {
  const slug = name
    .normalize('NFKD')
    // Strip combining marks so "Cadair Idris" and "Cadaïr Idris" land on the same segment.
    .replace(/[̀-ͯ]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 60)
    // The slice can leave a trailing hyphen behind that the trim above already passed.
    .replace(/-+$/u, '');
  return slug || fallback;
}
