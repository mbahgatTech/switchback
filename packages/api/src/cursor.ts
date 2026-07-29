/**
 * An offset in a cursor's clothing.
 *
 * Keyset pagination would be stabler, but it needs the sort key in the cursor and the trail
 * search alone has eight sort orders, two of which are ranked outside the database entirely.
 * Offsets are defensible here because the sets these queries range over barely move
 * mid-session: a tile landing between pages adds trails, and the duplicate-row risk that
 * creates is bounded by how fast ingest runs. Reviews move slower still.
 *
 * Opaque so the shape can change without a client release — which is the whole reason this
 * is base64 of JSON rather than the number itself.
 */
export function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset }), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const offset = (parsed as { o?: unknown }).o;
    return typeof offset === 'number' && Number.isInteger(offset) && offset >= 0 ? offset : 0;
  } catch {
    // A cursor we cannot read is a client bug or a stale bookmark. Page 1 is a kinder
    // answer than a 400 in the middle of an infinite scroll.
    return 0;
  }
}
