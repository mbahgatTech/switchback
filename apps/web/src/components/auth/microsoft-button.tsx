/**
 * Microsoft's sign-in button, to Microsoft's own specification.
 *
 * The one control on this site that is deliberately not in this site's voice. Everything else
 * here is field-guide type on a five-plate palette; this is 15px Segoe UI, a 21px four-square
 * mark, a 1px #8C8C8C rule, and a 41px box — because it is not our button. It is the button a
 * reader has already pressed on a dozen other sites, and the recognition *is* the affordance:
 * somebody who has to read a sign-in button to work out what it does has already been given a
 * reason to hesitate at the exact moment we are asking them to hand over an identity.
 *
 * Microsoft's brand guidelines ask for it too, and they are not negotiable in the way our own
 * conventions are. So the rules this component breaks — a hard-coded palette, a font stack
 * that is not one of ours, a pixel height instead of a space token — are all the same rule,
 * broken once, on purpose, and confined to `.ms-signin` in `globals.css`. Nothing here is
 * exported into `packages/ui` or `packages/core`, because none of it is ours to reuse.
 *
 * **The variant is chosen by CSS, not by us.** A server component cannot know which way
 * `system` resolves — that is the reader's OS answering a media query in their browser, after
 * the HTML has been sent. `light-dark()` moves the choice into the cascade, where the
 * `color-scheme` each palette block declares in `packages/ui/theme.css` already has the
 * answer. The button is correct in the first paint, on a page whose mode we never computed,
 * and it re-resolves by itself when somebody changes the setting.
 */

/** The four squares, in Microsoft's order and Microsoft's colours. */
const SQUARES = [
  { x: 0, y: 0, fill: '#F25022' },
  { x: 12, y: 0, fill: '#7FBA00' },
  { x: 0, y: 12, fill: '#00A4EF' },
  { x: 12, y: 12, fill: '#FFB900' },
] as const;

function Logo() {
  return (
    <svg viewBox="0 0 21 21" aria-hidden focusable="false" className="h-[21px] w-[21px] shrink-0">
      {SQUARES.map((square) => (
        <rect key={square.fill} x={square.x} y={square.y} width="9" height="9" fill={square.fill} />
      ))}
    </svg>
  );
}

export interface MicrosoftSignInButtonProps {
  /**
   * `in` for an existing account, `up` for a new one.
   *
   * Microsoft publishes both and they are not interchangeable: "Sign up" on a page a returning
   * reader landed on says their account is not the one being asked for.
   */
  action?: 'in' | 'up';
}

export function MicrosoftSignInButton({ action = 'in' }: MicrosoftSignInButtonProps) {
  return (
    <button type="submit" className="ms-signin">
      <Logo />
      {/* One string, not `Sign {action} with…` — that renders as three text nodes with
          comment separators between them, which is what copy-paste and translation see. */}
      <span>{action === 'up' ? 'Sign up with Microsoft' : 'Sign in with Microsoft'}</span>
    </button>
  );
}
