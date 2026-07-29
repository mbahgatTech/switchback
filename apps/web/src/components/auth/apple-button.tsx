/**
 * Apple's sign-in button, to Apple's own specification.
 *
 * The second of exactly two controls on this site that are deliberately not in this site's
 * voice — see `microsoft-button.tsx` for the argument, which is the same one. The
 * difference is that Apple's version is not a courtesy: the Human Interface Guidelines and
 * the App Store review process both require the published mark, the published wording, and
 * the published proportions, so a hand-rolled "Continue with Apple" is a control that would
 * have to be rebuilt before the provider could ship anyway.
 *
 * Every measurement lives in `.apple-signin` in `globals.css`, derived from a single
 * `--apple-h`, because Apple states them as ratios of the button's height rather than as
 * pixels. Writing them as pixels would be correct once and wrong the moment anybody changed
 * the row.
 *
 * **The variant is chosen by CSS, not by us**, for the same reason as the Microsoft button:
 * a server component cannot know how `system` resolves for this reader, and `light-dark()`
 * lets the cascade answer it after the HTML has been sent. Apple's rule is black on light
 * and white on dark, which is exactly what that pair expresses.
 */

/**
 * Apple's logo, as Apple draws it.
 *
 * A trademark reproduced under the one use Apple grants it — inside their own sign-in
 * button, unmodified, at their proportions. It is not in `packages/ui` and never will be:
 * nothing about this glyph is ours to reuse anywhere else on the site.
 */
function AppleLogo() {
  return (
    <svg
      viewBox="0 0 814 1000"
      aria-hidden
      focusable="false"
      // Optically centred rather than mechanically: the mark's leaf sits above the round of
      // the body, so a glyph aligned on its bounding box reads a hair low against text.
      className="mb-[0.08em] h-[0.9em] shrink-0"
      fill="currentColor"
    >
      <path d="M788.1 340.9c-5.8 4.5-108.2 62.2-108.2 190.5 0 148.4 130.3 200.9 134.2 202.2-.6 3.2-20.7 71.9-68.7 141.9-42.8 61.6-87.5 123.1-155.5 123.1s-85.5-39.5-164-39.5c-76.5 0-103.7 40.8-165.9 40.8s-105.6-57-155.5-127C46.7 790.7 0 663 0 541.8c0-194.4 126.4-297.5 250.8-297.5 66.1 0 121.2 43.4 162.7 43.4 39.5 0 101.1-46 176.3-46 28.5 0 130.9 2.6 198.3 99.2zm-234-181.5c31.1-36.9 53.1-88.1 53.1-139.3 0-7.1-.6-14.3-1.9-20.1-50.6 1.9-110.8 33.7-147.1 75.8-28.5 32.4-55.1 83.6-55.1 135.5 0 7.8 1.3 15.6 1.9 18.1 3.2.6 8.4 1.3 13.6 1.3 45.4 0 102.5-30.4 135.5-71.3z" />
    </svg>
  );
}

export interface AppleSignInButtonProps {
  /**
   * Apple publishes three titles and they are not interchangeable.
   *
   * `in` for a returning account, `up` for a new one, and `continue` where the page cannot
   * tell — which is this page, most of the time, since a first-time reader and a returning
   * one arrive at the same URL.
   */
  action?: 'in' | 'up' | 'continue';
}

const TITLES = {
  in: 'Sign in with Apple',
  up: 'Sign up with Apple',
  continue: 'Continue with Apple',
} as const;

export function AppleSignInButton({ action = 'continue' }: AppleSignInButtonProps) {
  return (
    <button type="submit" className="apple-signin">
      <AppleLogo />
      {/* One string, not an interpolation — three text nodes with comment separators
          between them is what copy-paste and translation tooling would see. */}
      <span>{TITLES[action]}</span>
    </button>
  );
}
