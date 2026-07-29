import { ImageResponse } from 'next/og';
import { SCHEMES } from '@switchback/ui';

/**
 * Home-screen icons at the two sizes an installable app has to provide.
 *
 * Rendered rather than committed as binaries, for the same reason as `apple-icon.tsx`: the
 * mark's geometry lives in `src/components/blaze.tsx` and `icon.svg`, and a committed PNG is
 * a copy that goes stale silently.
 *
 * Drawn inside 80% of the frame because Android may crop these to a circle, a squircle, or
 * a rounded square depending on the launcher. `maskable` promises the platform that anything
 * outside that safe zone is expendable — and the promise has to be kept here, not just made
 * in the manifest.
 */

const SIZES = [192, 512] as const;

export function generateStaticParams() {
  return SIZES.map((size) => ({ size: String(size) }));
}

export async function GET(_request: Request, context: { params: Promise<{ size: string }> }) {
  const { size: raw } = await context.params;
  const size = Number(raw);
  if (!SIZES.includes(size as (typeof SIZES)[number])) {
    return new Response('Not found', { status: 404 });
  }

  // The mark occupies the middle 62.5% — inside the 80% maskable safe zone with room to
  // breathe, which at 192 px is the difference between a logo and a sticker.
  const mark = Math.round(size * 0.625);

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
      <svg width={mark} height={mark} viewBox="0 0 32 32">
        <rect x="11" y="4" width="7" height="11" fill={SCHEMES.sheet.canvas} />
        <rect x="14" y="17" width="7" height="11" fill={SCHEMES.sheet.canvas} />
      </svg>
    </div>,
    { width: size, height: size },
  );
}
