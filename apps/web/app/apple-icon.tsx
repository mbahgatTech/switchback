import { ImageResponse } from 'next/og';
import { SCHEMES } from '@switchback/ui';

/**
 * The home-screen icon.
 *
 * Rendered rather than committed as a binary, so the one place the mark's geometry lives is
 * still `src/components/blaze.tsx` and a change to it does not leave a stale PNG behind.
 *
 * iOS ignores transparency and alpha-composites the icon onto white, and it applies its own
 * corner radius — so this is drawn edge to edge with no rounding and no padding beyond the
 * mark's own margin.
 */

export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

export default function AppleIcon() {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: SCHEMES.sheet.woodland,
      }}
    >
      {/* The 32-unit tile from `icon.svg`, scaled up. */}
      <svg width="180" height="180" viewBox="0 0 32 32">
        <rect x="11" y="4" width="7" height="11" fill={SCHEMES.sheet.canvas} />
        <rect x="14" y="17" width="7" height="11" fill={SCHEMES.sheet.canvas} />
      </svg>
    </div>,
    size,
  );
}
