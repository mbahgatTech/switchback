'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { PlannedRouteDetail } from '@switchback/core';
import { askAgain } from '../../lib/after-write';
import { FIT_MIME, GPX_MIME, decodeBase64, saveBlob } from '../../lib/download';
import { useTRPC } from '../../trpc/react';
import { BUTTON_COLLAR, DANGER, GHOST, HEIGHT, PRIMARY, SECONDARY } from '../controls';

/**
 * What can be done to a saved route.
 *
 * Three verbs and a sentence, in the order they are wanted: open it in the planner, take it
 * away as a file, and — last, unstyled, and behind a confirmation — delete it.
 *
 * **The export is always visible, and the edit is not a disclosure.** A route is a small
 * thing made of a name and some points, so the "edit" here is just the planner with the
 * points already in it; there is no second form to reveal. That is also why deleting is the
 * only destructive control on the page and can afford to sit in plain sight rather than
 * inside a settings panel — there is nothing else in the panel.
 *
 * **Two file formats, side by side, both named.** GPX goes to another mapping app; FIT goes
 * to a watch, which will not read GPX. A format picker would be one control that produces
 * two files and forces a decision before the press; two buttons let the label answer the
 * question. Neither is fetched until pressed — the file is built from the 25 m profile
 * rather than the drawn geometry, so it is tens of kilobytes rather than hundreds, but it is
 * still bytes nobody asked for until they ask.
 */

const VISIBILITY_SENTENCE: Record<PlannedRouteDetail['visibility'], string> = {
  private: 'Only you can see this route',
  followers: 'People who follow you can see this route',
  public: 'Anyone with the link can see this route',
};

export function RouteActions({ route }: { route: PlannedRouteDetail }) {
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();

  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [exporting, setExporting] = useState<'gpx' | 'fit' | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const remove = useMutation(
    trpc.routes.remove.mutationOptions({
      onSuccess: () => {
        void askAgain(queryClient, trpc.routes.pathFilter());
        router.replace('/routes');
      },
    }),
  );

  /**
   * Build one file and hand it over.
   *
   * Branching inside rather than taking the procedure as an argument: the two return
   * different shapes — text against base64 bytes — so there is nothing to parameterise that
   * would not immediately need narrowing again on the other side.
   */
  async function download(format: 'gpx' | 'fit'): Promise<void> {
    setExporting(format);
    setExportError(null);
    try {
      if (format === 'gpx') {
        const file = await queryClient.fetchQuery(trpc.routes.gpx.queryOptions({ id: route.id }));
        saveBlob(new Blob([file.xml], { type: GPX_MIME }), file.filename);
      } else {
        const file = await queryClient.fetchQuery(trpc.routes.fit.queryOptions({ id: route.id }));
        saveBlob(new Blob([decodeBase64(file.base64)], { type: FIT_MIME }), file.filename);
      }
    } catch (error) {
      setExportError(error instanceof Error ? error.message : 'That file did not build.');
    } finally {
      setExporting(null);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-md">
      {route.editable ? (
        <Link
          href={`/plan?route=${encodeURIComponent(route.id)}`}
          className={`${BUTTON_COLLAR} ${PRIMARY} ${HEIGHT.panel} px-md`}
        >
          Edit in planner
        </Link>
      ) : (
        <Link
          href={`/plan?route=${encodeURIComponent(route.id)}`}
          className={`${BUTTON_COLLAR} ${SECONDARY} ${HEIGHT.panel} px-md`}
        >
          Open a copy in the planner
        </Link>
      )}

      <button
        type="button"
        onClick={() => void download('gpx')}
        disabled={exporting !== null}
        className={`${BUTTON_COLLAR} ${SECONDARY} ${HEIGHT.panel} px-md`}
      >
        {exporting === 'gpx' ? 'Building…' : 'Download GPX'}
      </button>

      <button
        type="button"
        onClick={() => void download('fit')}
        disabled={exporting !== null}
        className={`${BUTTON_COLLAR} ${SECONDARY} ${HEIGHT.panel} px-md`}
        title="For a Garmin or other GPS watch"
      >
        {exporting === 'fit' ? 'Building…' : 'Download FIT'}
      </button>

      {route.editable ? (
        <span className="text-caption text-ink-muted">{VISIBILITY_SENTENCE[route.visibility]}</span>
      ) : null}

      {exportError ? <span className="text-caption text-survey">{exportError}</span> : null}

      {route.editable ? (
        <span className="ml-auto flex flex-wrap items-center gap-sm">
          {confirmingDelete ? (
            <>
              <span className="text-caption text-ink-muted">
                Delete this route? It cannot be recovered.
              </span>
              <button
                type="button"
                onClick={() => {
                  remove.mutate({ id: route.id });
                }}
                disabled={remove.isPending}
                className={`${BUTTON_COLLAR} ${DANGER} ${HEIGHT.panel} px-md`}
              >
                {remove.isPending ? 'Deleting…' : 'Delete it'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmingDelete(false);
                }}
                className={`${BUTTON_COLLAR} ${GHOST} ${HEIGHT.panel} px-sm`}
              >
                Keep it
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => {
                setConfirmingDelete(true);
              }}
              className={`${BUTTON_COLLAR} ${GHOST} ${HEIGHT.panel} px-md`}
            >
              Delete route
            </button>
          )}
        </span>
      ) : null}

      {remove.isError ? (
        <p className="w-full text-caption text-survey">
          {remove.error.message || 'That did not delete. Try again.'}
        </p>
      ) : null}
    </div>
  );
}
