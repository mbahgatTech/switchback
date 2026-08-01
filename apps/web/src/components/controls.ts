/**
 * The control vocabulary for the working screens, so "the quiet outline" stays one thing.
 * `DANGER` is survey red, which means safety and nothing else — never on the record button.
 */

export const BUTTON =
  'inline-flex items-center justify-center gap-xs rounded-hair border text-caption font-medium transition-colors duration-quick ease-standard disabled:cursor-not-allowed disabled:opacity-45';

/**
 * The same button lettered as a collar. Which of the two a screen wants is a question about the
 * label: "Save changes" is a sentence; SAVE, CANCEL, DELETE LIST are labels on an instrument.
 */
export const BUTTON_COLLAR =
  'collar inline-flex items-center justify-center gap-xs rounded-hair border transition-colors duration-quick ease-standard disabled:cursor-not-allowed disabled:opacity-45';

export const PRIMARY = 'border-ink bg-ink text-canvas hover:bg-ink/90';
export const SECONDARY = 'border-bezel text-ink-muted hover:border-ink-muted hover:text-ink';
export const DANGER = 'border-survey text-survey hover:bg-survey hover:text-canvas';

/**
 * The affirmative that is not yet the primary one: the action a panel exists to perform when
 * that panel is not the page, where solid ink would outweigh the page's own primary action.
 */
export const OUTLINE = 'border-ink text-ink hover:bg-ink hover:text-canvas';

/** No border at all: the way out. Cancel, Dismiss, Not now — the quietest thing in its row. */
export const GHOST = 'border-transparent hover:text-ink';

/**
 * Three rungs and no fourth. The numbers and the reasoning are `CONTROL_HEIGHT` in
 * `packages/ui/src/tokens/space.ts`, which the phone reads too; these are that ladder spelled
 * as Tailwind minimums. Written out rather than interpolated because Tailwind v4 scans source
 * text and a template literal would generate nothing. `apps/web/test/conventions.test.ts`
 * keeps the two in step and fails the build on a fourth rung.
 *
 * A control set inside a sentence takes no rung: its size is constrained by the line-height of
 * the prose around it, which is the Inline exception WCAG 2.5.8 writes down.
 */
export const HEIGHT = {
  panel: 'min-h-[34px]',
  touch: 'min-h-[48px]',
  field: 'min-h-[56px]',
} as const;

/**
 * The touch rung as a target around a mark that has to stay small — the × on a photo thumbnail,
 * the star on a card. The mark stays 22–24 px and the target is a centred, invisible 48 px box.
 * The element must establish its own containing block (`relative` or `absolute`), or the box
 * centres on some ancestor instead.
 */
export const HIT =
  "before:absolute before:left-1/2 before:top-1/2 before:size-[48px] before:-translate-x-1/2 before:-translate-y-1/2 before:content-['']";

/** A choice among choices: pressed is filled, unpressed is the quiet outline. */
export function toggle(pressed: boolean): string {
  return pressed ? PRIMARY : SECONDARY;
}
