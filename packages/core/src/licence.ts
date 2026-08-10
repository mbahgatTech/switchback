/**
 * Licence identifiers as Commons writes them, mapped to the deed a credit line has to link to.
 * CC BY-SA 4.0 §3.a.1(C) requires a notice referring to the licence; a bare "CC BY-SA 4.0" in
 * text is a name, not a notice.
 */

/** Where the deed for a Creative Commons identifier lives, or null when there is nothing to link. */
export function licenceUri(identifier: string | null | undefined): string | null {
  if (!identifier) return null;
  const licence = identifier.trim();

  if (/^cc0/i.test(licence)) return 'https://creativecommons.org/publicdomain/zero/1.0/';
  if (/^(?:public domain|pd(?:[ -]|$))/i.test(licence)) {
    return 'https://en.wikipedia.org/wiki/Public_domain';
  }

  // "CC BY-SA 4.0", "CC BY 2.0" — the parts are the deed's own path segments.
  const cc = /^cc[ -]((?:by)(?:-(?:sa|nc|nd))*)[ -]([\d.]+)$/i.exec(licence);
  if (cc) return `https://creativecommons.org/licenses/${cc[1]!.toLowerCase()}/${cc[2]}/`;

  return null;
}

/**
 * The one-line credit a seeded photograph must carry. Returns the parts rather than a string so
 * the caller can hyperlink them — the licence and the file page are both required to be links,
 * and a component that receives pre-joined text cannot make them so.
 */
export interface PhotoCredit {
  /** Who took it. */
  author: string;
  /** The file's own page, which carries the full licence and notices. */
  sourceUrl: string | null;
  licence: string | null;
  licenceUri: string | null;
}

/** Whether a licence obliges us to name the author — every CC variant except CC0 and PD. */
export function requiresAttribution(identifier: string | null | undefined): boolean {
  if (!identifier) return false;
  return /^cc[ -]by/i.test(identifier.trim());
}
