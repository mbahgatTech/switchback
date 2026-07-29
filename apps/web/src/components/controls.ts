/**
 * The control vocabulary for the working screens.
 *
 * Written once because the alternative has already been observed: two files spelling out
 * their own `border-bezel text-ink-muted hover:…` stay identical for about a week. It started
 * on the record screen and moved up here when the route planner became the third surface
 * needing the same four buttons — a shared string is what keeps "the quiet outline" one thing
 * rather than three that nearly match.
 *
 * **`DANGER` is survey red, and survey red is safety.** It marks the position dot, the
 * wrong-turn banner, an overdue Lifeline, a leg of a route with no path under it, and the
 * confirmations that throw something away. Not on the record button, however much a record
 * button wants to be red: a control that shares a colour with a wrong-turn alert is a control
 * that makes the alert mean less.
 */

export const BUTTON =
  'inline-flex items-center justify-center gap-xs rounded-hair border text-caption font-medium transition-colors duration-quick ease-standard disabled:cursor-not-allowed disabled:opacity-45';

/**
 * The same button, lettered as a collar.
 *
 * `BUTTON` sets the label in sentence-case caption text; this one hands the lettering to
 * `.collar` — Archivo, condensed, 700, uppercase at 0.14em — and is otherwise identical.
 * Which of the two a screen wants is a question about the label, not about the button:
 * "Save changes" is a sentence and reads as one; SAVE, CANCEL, DELETE LIST are labels on an
 * instrument, and the collar is the voice this product labels instruments in.
 *
 * It exists because it was already there, fifty-odd times, spelled out by hand — the string
 * `collar min-h-[34px] rounded-hair border border-bezel px-md transition-colors
 * duration-quick ease-standard hover:border-ink hover:text-ink` was typed into eleven files.
 * A handful of those had drifted: `disabled:opacity-40` against everyone else's 45, a
 * `transition-opacity` where the neighbour used `transition-colors`, two that centred their
 * label with `leading-[34px]` instead of flexbox. None of that was decided; it is just what
 * happens to a string that is copied rather than imported.
 */
export const BUTTON_COLLAR =
  'collar inline-flex items-center justify-center gap-xs rounded-hair border transition-colors duration-quick ease-standard disabled:cursor-not-allowed disabled:opacity-45';

export const PRIMARY = 'border-ink bg-ink text-canvas hover:bg-ink/90';
export const SECONDARY = 'border-bezel text-ink-muted hover:border-ink-muted hover:text-ink';
export const DANGER = 'border-survey text-survey hover:bg-survey hover:text-canvas';

/**
 * The affirmative that is not yet the primary one.
 *
 * Ink outline, transparent, filling on hover. It marks the action a panel exists to perform
 * when that panel is not the page — "Add to list" inside the save sheet, "Write a review",
 * "Plan a route" on an empty shelf — where a solid ink button would outweigh the page's own
 * primary action sitting a few centimetres away.
 */
export const OUTLINE = 'border-ink text-ink hover:bg-ink hover:text-canvas';

/**
 * No border at all: the way out of something.
 *
 * Cancel, Dismiss, Not now. It is a real button with a real hit area and it is deliberately
 * the quietest thing in its row, because in every pair it appears in, the other button is
 * the one the user came for.
 */
export const GHOST = 'border-transparent hover:text-ink';

/**
 * Three sizes, and no fourth.
 *
 * This used to read "these carry no size — every screen sets its own minimum height at the
 * call site", on the reasoning that a glove wants a bigger button than a mouse. The reasoning
 * is right and the licence was wrong: what it actually produced was twelve heights across the
 * web app — 26, 30, 32, 34, 36, 38, 40, 41, 42, 44, 52, 60 — most of them a single file's
 * guess at "a bit bigger than the last one". A reader cannot see a ladder with nine rungs; it
 * just reads as controls that do not quite line up.
 *
 * The three rungs and the reasoning for each are `CONTROL_HEIGHT` in
 * `packages/ui/src/tokens/space.ts`, where the phone reads the same numbers — these strings
 * are only that ladder spelled as Tailwind minimums. They are written out rather than
 * interpolated because Tailwind v4 finds classes by scanning source text: a template literal
 * would generate nothing. `apps/web/test/conventions.test.ts` is what keeps the two in step,
 * and fails the build on a fourth rung.
 *
 * **What the ladder does not govern: a control set inside a sentence.** The `.dial` in
 * "Leaving Wed 29 Jul at 07:00", and the words that follow "Hiked 27 Jul ·" — Log another
 * day, Add, Cancel — are 15 to 19 px tall, and that is the right height for them. Their size
 * is the line-height of the prose they sit in, so a rung would not make them easier to hit;
 * it would open the line they are part of and stop them reading as part of it. This is the
 * Inline exception WCAG 2.5.8 writes down for exactly this shape: "the target is in a
 * sentence, or its size is otherwise constrained by the line-height of non-target text."
 *
 * The test of which side of the line a control falls on is whether removing it would leave a
 * gap in a sentence. If it would, it is a word; if it would leave a gap in a row, it is a
 * control and it takes a rung.
 */
export const HEIGHT = {
  panel: 'min-h-[34px]',
  touch: 'min-h-[48px]',
  field: 'min-h-[56px]',
} as const;

/**
 * The touch rung as a target, around a mark that has to stay small.
 *
 * `HEIGHT.touch` is the answer wherever the button can simply be bigger. A few controls
 * cannot: the × on a 76×102 photo thumbnail, the dismiss on an upload row, the star that
 * unfavourites a card. Grown to 48 px they stop being a corner mark and start covering the
 * thing they annotate — so the *mark* stays 22–24 px and the *target* is a centred, invisible
 * 48 px box laid over it. The visible design is unchanged; the finger gets what the finger
 * needs, and it is the same 48 as everywhere else rather than a per-file guess at "close
 * enough". Overlap with a neighbour is deliberate and harmless: these marks sit in corners
 * with nothing else within 24 px of them.
 *
 * The element must establish a containing block of its own — `relative` or `absolute`, which
 * every current caller already has — or the box will centre on some ancestor instead.
 */
export const HIT =
  "before:absolute before:left-1/2 before:top-1/2 before:size-[48px] before:-translate-x-1/2 before:-translate-y-1/2 before:content-['']";

/** A choice among choices: pressed is filled, unpressed is the quiet outline. */
export function toggle(pressed: boolean): string {
  return pressed ? PRIMARY : SECONDARY;
}
