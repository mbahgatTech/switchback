/**
 * The credit line under a seeded photograph.
 *
 * Commons and Mapillary images arrive under CC BY and CC BY-SA variants, which require the
 * author's name, a notice referring to the licence, and a link to the material itself. A name
 * printed as plain text meets none of those, so both the author and the licence are anchors:
 * the first to the file's own page, which carries the full notices, the second to the deed.
 */

import { licenceUri } from '@switchback/core';

export interface PhotoCreditLineProps {
  credit: string;
  /** The file's page upstream. Null for a reader's own upload, which needs no link. */
  sourceUrl?: string | null;
  licence?: string | null;
}

const LINK = 'underline decoration-dotted underline-offset-2 hover:text-ink';

export function PhotoCreditLine({ credit, sourceUrl, licence }: PhotoCreditLineProps) {
  const deed = licenceUri(licence);
  return (
    <>
      {sourceUrl ? (
        <a href={sourceUrl} target="_blank" rel="noopener noreferrer nofollow" className={LINK}>
          {credit}
        </a>
      ) : (
        credit
      )}
      {licence ? (
        <>
          {' · '}
          {deed ? (
            <a href={deed} target="_blank" rel="noopener noreferrer nofollow" className={LINK}>
              {licence}
            </a>
          ) : (
            licence
          )}
        </>
      ) : null}
    </>
  );
}
