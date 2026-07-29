/**
 * Small text helpers shared by both clients.
 *
 * Only things where getting it wrong is visible to a reader. "1 hikes on the record" is the
 * kind of sentence that tells someone the product was assembled rather than written, and it
 * happens because the count and the noun are decided in different places — so they are
 * decided here, once, together.
 */

/**
 * The noun for a count, not the phrase.
 *
 * Returning the word alone rather than "3 hikes" is deliberate: every figure in this product
 * sets its number in the mono face and its label in the text face, so the call site needs to
 * wrap the number itself. `{n} {plural(n, 'hike')}` reads the same as the sentence it makes.
 *
 * English pluralisation is irregular enough that guessing is worse than asking, so the
 * default is a bare `-s` and anything else is passed in. The count is compared by magnitude,
 * so a delta of −1 takes the singular the way "−1 hike" reads, and zero takes the plural
 * because "0 hikes" is how English says nothing at all.
 */
export function plural(count: number, singular: string, pluralForm?: string): string {
  return Math.abs(count) === 1 ? singular : (pluralForm ?? `${singular}s`);
}

/**
 * A URL segment from a name a person typed.
 *
 * Deliberately not the trail slugifier in `@switchback/ingest`: that one folds in a region
 * and is tuned for names that came out of OSM. This one runs on free text, which means it
 * has to survive emoji, a name that is entirely punctuation, and a name in a script with no
 * ASCII in it at all — hence the required `fallback`, because an empty segment would collide
 * with the collection route above it.
 *
 * The fallback is a parameter rather than a constant because the word appears in the URL a
 * user then sees and shares. A route that saved as `/routes/list` because its name was "🏔"
 * is a small thing that reads as carelessness.
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
