import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { TRPCError } from '@trpc/server';
import type { TrailDetail } from '@switchback/core';
import { Sheet } from '@/components/print/sheet';
import { viewerUnits } from '@/lib/units';
import { caller } from '@/trpc/server';

/**
 * The print sheet, on its own route.
 *
 * A separate page rather than a print stylesheet over the trail page, and the reason is that
 * they are different documents. The trail page is a reading order — name, figures, photos,
 * reviews, what else is nearby — and a print rule over it can only hide things. A sheet is a
 * composition at a stated ratio, and the ratio is a decision the reader has to be able to make
 * *before* the paper comes out. That needs controls, and controls need a page.
 *
 * It also means the sheet has a URL. A hiker can send one.
 */

interface PageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const trail = await loadTrail(slug);
  if (!trail) return { title: 'Not found' };

  return {
    title: `${trail.name} — sheet`,
    // Not a page anyone should land on from a search: it is a printer's view of a page that
    // already ranks, and indexing both splits the trail's own result.
    robots: { index: false, follow: true },
  };
}

async function loadTrail(slug: string): Promise<TrailDetail | null> {
  try {
    return await caller.trails.bySlug({ slug });
  } catch (error) {
    if (error instanceof TRPCError && error.code === 'NOT_FOUND') return null;
    throw error;
  }
}

export default async function TrailPrintPage({ params }: PageProps) {
  const { slug } = await params;
  const [trail, units] = await Promise.all([loadTrail(slug), viewerUnits()]);
  if (!trail) notFound();

  return (
    <div data-print-root data-scheme="sheet" className="min-h-dvh bg-canvas text-ink">
      <Sheet trail={trail} units={units} />
    </div>
  );
}
