'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { FIT_MIME, GPX_MIME, decodeBase64, saveBlob } from '../../lib/download';
import { useTRPC } from '../../trpc/react';
import { HEIGHT } from '../controls';

/**
 * Take the trail away as a file.
 *
 * **One control with two segments, not two buttons.** The row this sits in already holds
 * four verbs, and a fifth and sixth would flatten it into a toolbar where nothing leads.
 * Both segments do the same thing — hand you the trail — and differ only in what reads the
 * result, so the label carries the verb once and the segments carry the formats. That is
 * also the honest shape of the choice: nobody wants "an export", they want the one their
 * device will open.
 *
 * The distinction is worth stating plainly because it is the whole reason for two: GPX goes
 * to another map app, and FIT goes to a watch, which will not navigate a GPX route without
 * converting it and losing the climb profile on the way.
 *
 * Neither file exists until pressed. A trail's 25 m profile is thousands of points, and
 * building both eagerly for a page that is usually only read would be a few hundred
 * kilobytes spent on a control most visitors never touch.
 */

const GROUP = `inline-flex ${HEIGHT.touch} items-stretch overflow-hidden rounded-hair border border-bezel`;

/**
 * The label sits at the collar's own muted ink and the formats at full ink, so the group
 * reads as one quiet noun followed by two live choices rather than as three buttons.
 */
const SEGMENT =
  'collar border-l border-bezel px-md text-ink transition-colors duration-quick ease-standard hover:bg-woodland-wash disabled:opacity-40 disabled:hover:bg-transparent';

export function TrailExport({ trailId }: { trailId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const [exporting, setExporting] = useState<'gpx' | 'fit' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function download(format: 'gpx' | 'fit'): Promise<void> {
    setExporting(format);
    setError(null);
    try {
      if (format === 'gpx') {
        const file = await queryClient.fetchQuery(trpc.trails.gpx.queryOptions({ trailId }));
        saveBlob(new Blob([file.xml], { type: GPX_MIME }), file.filename);
      } else {
        const file = await queryClient.fetchQuery(trpc.trails.fit.queryOptions({ trailId }));
        saveBlob(new Blob([decodeBase64(file.base64)], { type: FIT_MIME }), file.filename);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That file did not build.');
    } finally {
      setExporting(null);
    }
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-sm">
      <span className={GROUP}>
        <span className="collar flex items-center px-md">Export</span>
        <button
          type="button"
          onClick={() => void download('gpx')}
          disabled={exporting !== null}
          className={SEGMENT}
        >
          {exporting === 'gpx' ? '…' : 'GPX'}
        </button>
        <button
          type="button"
          onClick={() => void download('fit')}
          disabled={exporting !== null}
          className={SEGMENT}
          title="A course file for a Garmin or other GPS watch"
        >
          {exporting === 'fit' ? '…' : 'FIT'}
        </button>
      </span>
      {error ? (
        <span role="status" className="text-caption text-survey">
          {error}
        </span>
      ) : null}
    </span>
  );
}
