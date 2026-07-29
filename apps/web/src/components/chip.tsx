'use client';

import { HEIGHT } from './controls';

/**
 * The chip — one filter value, on or off.
 *
 * A checkbox that looks like a button, and it is spelled that way in the DOM: `role` stays
 * `button` with `aria-pressed`, which is what a screen reader announces as "Hard, pressed".
 * A styled `<input type=checkbox>` would announce the same state but leaves the browser's
 * own box to be hidden, and hidden inputs are how keyboard focus gets lost.
 *
 * The pressed treatment is a filled bar, not a colour swap: the plate colours are a legend
 * in this product and a filter chip is not a legend entry. Weight carries state here for
 * the same reason it carries selection on the map.
 */

export interface ChipProps {
  label: string;
  pressed: boolean;
  onToggle: () => void;
  /** Optional count or unit shown after the label in mono. */
  detail?: string;
}

export function Chip({ label, pressed, onToggle, detail }: ChipProps) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onToggle}
      className={[
        `inline-flex ${HEIGHT.panel} items-center gap-xs rounded-hair border px-md`,
        'text-caption font-medium transition-colors duration-quick ease-standard',
        pressed
          ? 'border-ink bg-ink text-canvas'
          : 'border-bezel text-ink-muted hover:border-ink-muted hover:text-ink',
      ].join(' ')}
    >
      {label}
      {detail ? (
        <span className={pressed ? 'font-mono text-micro opacity-70' : 'font-mono text-micro'}>
          {detail}
        </span>
      ) : null}
    </button>
  );
}

/**
 * A labelled row of chips.
 *
 * The label is a collar — the marginalia voice of a sheet — because that is literally what
 * this panel is: the printed margin beside the map, carrying the legend and the index.
 */
export function ChipGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <fieldset className="border-0 p-0">
      <legend className="collar mb-sm p-0">{label}</legend>
      <div className="flex flex-wrap gap-xs">{children}</div>
    </fieldset>
  );
}
