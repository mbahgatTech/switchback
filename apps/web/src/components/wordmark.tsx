import Link from 'next/link';
import { BRAND } from '@switchback/core';
import { Blaze } from './blaze';

/**
 * The name and the blaze, in the one arrangement they are ever drawn in.
 *
 * This was hand-assembled in the header of all nineteen page files — the same `Blaze size={20}`
 * beside the same `text-body font-semibold tracking-[-0.01em]`, copied forward each time a
 * route was added. Nineteen copies of three utilities is nineteen chances for one of them to
 * miss a change, and the tracking is the tell: `--text-body` is set at 0, so the −0.01em is a
 * deliberate tightening that belongs to the wordmark specifically. Left inline it reads as a
 * stray magic number in twenty files; named here it is the one place the mark is specified.
 *
 * `large` is for a page that leads with the mark rather than with an instrument. `/nearby` is
 * the only one: its heading sits a good distance below, so the mark is not competing with
 * anything directly beneath it and is set a step up. On the map shell the header is a neatline
 * one line tall, and a larger mark there just eats map.
 *
 * `home` is off wherever the mark would link to the page it is already on — today that is `/`,
 * the map. A link to where you are is an announced destination that goes nowhere.
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
