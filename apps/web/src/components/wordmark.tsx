import Link from 'next/link';
import { BRAND } from '@switchback/core';
import { Blaze } from './blaze';

/**
 * The name and the blaze, in the one arrangement they are ever drawn in. The −0.01em tracking
 * belongs to the wordmark specifically; `--text-body` is set at 0.
 */

export interface WordmarkProps {
  /** One step up, for a page that opens with the mark rather than an instrument. */
  large?: boolean;
  /** Link to `/`. Off on `/` itself, which is already there. */
  home?: boolean;
}

export function Wordmark({ large = false, home = true }: WordmarkProps) {
  const inner = (
    <>
      <Blaze size={large ? 24 : 20} className="text-woodland" />
      <span className={`${large ? 'text-title' : 'text-body'} font-semibold tracking-[-0.01em]`}>
        {BRAND.name}
      </span>
    </>
  );

  if (!home) return <span className="flex items-center gap-sm">{inner}</span>;

  return (
    <Link href="/" className="flex items-center gap-sm rounded-hair">
      {inner}
    </Link>
  );
}
