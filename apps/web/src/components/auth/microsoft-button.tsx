/**
 * Microsoft's sign-in button, to Microsoft's own specification — the recognition is the
 * affordance, and their brand guidelines are not negotiable in the way our conventions are.
 * The rules this breaks are confined to `.ms-signin` in `globals.css` and nothing here is
 * exported into `packages/ui`.
 *
 * The light/dark variant is chosen by `light-dark()` in the cascade rather than by us: a
 * server component cannot know how `system` resolves for this reader.
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
   * `in` for an existing account, `up` for a new one. Microsoft publishes both and they are
   * not interchangeable: "Sign up" says a returning reader's account is not the one asked for.
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
