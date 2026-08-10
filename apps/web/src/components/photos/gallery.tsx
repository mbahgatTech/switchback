'use client';

/**
 * The photographs on a trail page.
 *
 * A contact strip rather than a grid, because the set is heterogeneous by nature — a handful
 * of pictures somebody took last week alongside whatever Commons happens to hold — and a grid
 * makes a thin set look like a gap where a full one should be. A strip of six is a strip of
 * six; a grid of six with nine empty cells is a page that failed to load.
 *
 * **Each frame states where along the trail it was taken.** That line is the reason the
 * section exists in this form: a picture of a summit block is worth more when it says *5.1 km
 * in*, because the reader is looking at the elevation profile two sections up and can place
 * it. The coordinate comes out of the file's own EXIF, is only kept when it falls near this
 * trail, and simply does not print when it is absent — which is most of the seeded ones.
 *
 * **The credit is not garnish.** Commons and Mapillary photographs arrive under CC variants
 * that require attribution by name, so it prints under every frame whether or not anybody
 * wrote a caption.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation } from '@tanstack/react-query';
import {
  MAX_CAPTION_LENGTH,
  blurhashAverageColor,
  canModerate,
  formatDistance,
} from '@switchback/core';
import type { UnitSystem, UserRole } from '@switchback/core';
import type { TrailPhoto } from '@switchback/api/routers/photos';
import { useTRPC } from '../../trpc/react';
import { useUnitsOr } from '../units';
import { PhotoUploader } from './uploader';
import { PhotoCreditLine } from './credit';
import { Photograph, PhotographMissing, PhotographUnavailable } from './photograph';
import { ModerateControl, ReportControl } from '../moderation/report-control';
import { BUTTON_COLLAR, DANGER, HEIGHT, OUTLINE, SECONDARY } from '../controls';

export interface PhotoGalleryProps {
  trailId: string;
  trailName: string;
  /** Where to send someone who has to sign in first, so they come back here. */
  trailPath: string;
  initial: TrailPhoto[];
  isViewerKnown: boolean;
  /**
   * Whether to draw a take-down control under a frame. `member` for everybody who is not an
   * operator. It decides what is drawn and nothing about what is permitted —
   * `moderatorProcedure` re-reads the column server-side on every call.
   */
  viewerRole?: UserRole;
  units?: UnitSystem;
}

function creditOf(photo: TrailPhoto): string {
  if (photo.author) return photo.author.name ?? photo.author.username ?? 'A hiker';
  if (photo.attribution) return photo.attribution;
  return photo.source.charAt(0).toUpperCase() + photo.source.slice(1);
}

/** `September 2024` — the month is as precise as a photograph's date needs to be. */
function monthOf(value: Date | string | null): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

export function PhotoGallery({
  trailId,
  trailName,
  trailPath,
  initial,
  isViewerKnown,
  viewerRole = 'member',
  units: given,
}: PhotoGalleryProps) {
  const units = useUnitsOr(given);
  const trpc = useTRPC();
  const router = useRouter();

  const [photos, setPhotos] = useState<TrailPhoto[]>(initial);
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [caption, setCaption] = useState('');
  const dialogRef = useRef<HTMLDialogElement>(null);

  /**
   * Re-seed from the server's list when it changes.
   *
   * `initial` is a fresh array on every render of the page above, so this cannot simply run
   * on every change or a local addition would be wiped by the next render. The guard is a
   * stamp of the set — every id, and whether it is hidden — rather than the length it used
   * to be: a takedown by an operator leaves the length identical, because an operator's copy
   * of this list carries taken-down frames too, and the length guard therefore left the
   * lightbox holding a photograph it had just hidden and a button still offering to hide it.
   * Local additions still win, because the page above does not re-render when one arrives.
   */
  const stamp = initial.map((photo) => `${photo.id}${photo.hidden ? '!' : ''}`).join(',');
  useEffect(() => {
    setPhotos((current) =>
      current.map((photo) => `${photo.id}${photo.hidden ? '!' : ''}`).join(',') === stamp
        ? current
        : initial,
    );
  }, [stamp, initial]);

  const open = openIndex === null ? null : (photos[openIndex] ?? null);

  /*
   * The count over the strip is of frames a reader can actually look at. An operator's copy
   * of this list carries the taken-down ones too (see `trails.photos`), and "14 frames" over
   * a strip where one of them is a removal notice would be the one number on the page that
   * disagrees with `Trail.photoCount`, which excludes them.
   */
  const visible = photos.filter((photo) => !photo.hidden).length;

  useEffect(() => {
    const node = dialogRef.current;
    if (!node) return;
    if (open && !node.open) node.showModal();
    if (!open && node.open) node.close();
  }, [open]);

  useEffect(() => {
    setCaption(open?.caption ?? '');
  }, [open]);

  const step = useCallback(
    (delta: number): void => {
      setOpenIndex((current) => {
        if (current === null || photos.length === 0) return current;
        return (current + delta + photos.length) % photos.length;
      });
    },
    [photos.length],
  );

  const saveCaption = useMutation(
    trpc.photos.caption.mutationOptions({
      onSuccess: (_result, variables) => {
        setPhotos((current) =>
          current.map((photo) =>
            photo.id === variables.photoId ? { ...photo, caption: variables.caption } : photo,
          ),
        );
      },
    }),
  );

  const remove = useMutation(
    trpc.photos.remove.mutationOptions({
      onSuccess: (_result, variables) => {
        setPhotos((current) => current.filter((photo) => photo.id !== variables.photoId));
        setOpenIndex(null);
        // The hero at the top of the page is server rendered from the same set.
        router.refresh();
      },
    }),
  );

  const received = useCallback((photo: TrailPhoto): void => {
    // Prepended: a photograph somebody just took is the newest thing on the page, and seeing
    // it appear at the front is the confirmation that the upload worked.
    setPhotos((current) => [photo, ...current]);
  }, []);

  return (
    <section className="mt-3xl">
      <div className="flex flex-wrap items-baseline justify-between gap-sm">
        <h2 className="collar">Photographs</h2>
        {visible > 0 ? (
          <p className="font-mono text-micro text-ink-muted">
            {visible} {visible === 1 ? 'frame' : 'frames'}
          </p>
        ) : null}
      </div>

      {photos.length > 0 ? (
        <ul className="mt-md flex snap-x snap-mandatory gap-md overflow-x-auto pb-sm">
          {photos.map((photo, index) => {
            const wash = blurhashAverageColor(photo.blurhash);
            return (
              <li key={photo.id} className="w-[260px] shrink-0 snap-start">
                <button
                  type="button"
                  onClick={() => setOpenIndex(index)}
                  className="block w-full rounded-hair text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
                >
                  {/*
                   * The average colour of the photograph, painted under it from four bytes of
                   * BlurHash the uploader computed. On a slow connection a frame arrives as a
                   * plausible green or grey rather than a white hole, and the strip stops
                   * flashing as it loads. Costs nothing: it is one base-83 parse per frame.
                   */}
                  <Photograph
                    src={photo.thumbUrl ?? photo.url}
                    alt={photo.caption ?? `${trailName}, photographed by ${creditOf(photo)}`}
                    loading="lazy"
                    style={wash ? { backgroundColor: wash } : undefined}
                    className="h-[170px] w-full rounded-hair border border-bezel object-cover"
                    fallback={<PhotographMissing className="h-[170px] w-full" />}
                  />
                </button>
                <p className="mt-xs flex items-baseline justify-between gap-sm font-mono text-micro text-ink-muted">
                  <span className="truncate">
                    {/*
                     * Only an operator ever sees a hidden frame here — the server refuses
                     * `includeHidden` to anybody else — and it arrives with its URL already
                     * blanked, so the tile is a `PhotographMissing` plate. This line is what
                     * distinguishes "taken down" from "the file 404s", which are otherwise
                     * the same picture.
                     */}
                    {photo.hidden ? (
                      'Removed'
                    ) : (
                      <PhotoCreditLine
                        credit={creditOf(photo)}
                        sourceUrl={photo.sourceUrl}
                        licence={photo.license}
                      />
                    )}
                  </span>
                  {photo.distM !== null ? (
                    <span className="shrink-0 text-contour">
                      {formatDistance(photo.distM, units)} in
                    </span>
                  ) : null}
                </p>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-md max-w-measure text-body text-ink-muted">
          No photographs of this one yet. What it actually looks like — the ground, the crossing,
          the view from the top — is the thing a map cannot say.
        </p>
      )}

      {isViewerKnown ? (
        <PhotoUploader trailId={trailId} onUploaded={received} />
      ) : (
        <p className="mt-md text-caption text-ink-muted">
          <a
            href={`/signin?callbackUrl=${encodeURIComponent(trailPath)}`}
            className="underline decoration-bezel underline-offset-4 hover:decoration-ink"
          >
            Sign in
          </a>{' '}
          to add your own.
        </p>
      )}

      {/*
       * A native `<dialog>`. Escape closes it, focus is trapped, the rest of the page is
       * inert, and the backdrop exists — four behaviours that a div with `position: fixed`
       * has to reimplement badly.
       */}
      <dialog
        ref={dialogRef}
        onClose={() => setOpenIndex(null)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight') step(1);
          if (event.key === 'ArrowLeft') step(-1);
        }}
        className="m-auto w-full max-w-[min(1080px,92vw)] rounded-hair border border-bezel bg-canvas p-0 text-ink backdrop:bg-ink/85"
      >
        {open ? (
          <div className="flex flex-col">
            <Photograph
              src={open.url}
              alt={open.caption ?? `${trailName}, photographed by ${creditOf(open)}`}
              style={{
                backgroundColor: blurhashAverageColor(open.blurhash) ?? undefined,
                aspectRatio:
                  open.width && open.height ? `${open.width} / ${open.height}` : undefined,
              }}
              className="max-h-[72vh] w-full object-contain"
              fallback={<PhotographUnavailable />}
            />

            <div className="flex flex-wrap items-start gap-md border-t border-bezel p-md">
              <div className="min-w-0 flex-1">
                {open.hidden ? (
                  /*
                   * Only an operator gets here. It states what happened and leaves the caption
                   * field and the remove button off entirely — both are refused server-side on
                   * a hidden row, and drawing a control that always fails is worse than not
                   * drawing it. The put-back is in the group on the right.
                   */
                  <p className="max-w-measure rounded-hair border border-survey px-md py-sm text-caption text-survey">
                    Removed by a moderator. It is out of the gallery, out of the count, and out of
                    the running for the hero.
                  </p>
                ) : open.isMine ? (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      saveCaption.mutate({ photoId: open.id, caption: caption.trim() || null });
                    }}
                    className="flex flex-wrap items-center gap-sm"
                  >
                    <input
                      value={caption}
                      maxLength={MAX_CAPTION_LENGTH}
                      onChange={(event) => setCaption(event.target.value)}
                      placeholder="What is this — the crossing, the cairn, the turn people miss?"
                      className="field min-w-0 flex-1"
                    />
                    <button
                      type="submit"
                      disabled={saveCaption.isPending || (open.caption ?? '') === caption.trim()}
                      className={`${BUTTON_COLLAR} ${OUTLINE} ${HEIGHT.panel} px-md`}
                    >
                      {saveCaption.isPending ? 'Saving…' : 'Save caption'}
                    </button>
                  </form>
                ) : open.caption ? (
                  <p className="max-w-measure-wide font-text text-body leading-relaxed">
                    {open.caption}
                  </p>
                ) : null}

                <p className="mt-sm font-mono text-micro text-ink-muted">
                  <PhotoCreditLine
                    credit={creditOf(open)}
                    sourceUrl={open.sourceUrl}
                    licence={open.license}
                  />
                  {monthOf(open.capturedAt) ? ` · ${monthOf(open.capturedAt)}` : ''}
                  {open.distM !== null
                    ? ` · ${formatDistance(open.distM, units)} along the trail`
                    : ''}
                </p>
              </div>

              <div className="ml-auto flex shrink-0 items-center gap-xs">
                {photos.length > 1 ? (
                  <>
                    <button
                      type="button"
                      onClick={() => step(-1)}
                      aria-label="Previous photograph"
                      className={`${BUTTON_COLLAR} ${SECONDARY} ${HEIGHT.panel} px-md`}
                    >
                      ←
                    </button>
                    <span className="font-mono text-micro text-ink-muted">
                      {(openIndex ?? 0) + 1}/{photos.length}
                    </span>
                    <button
                      type="button"
                      onClick={() => step(1)}
                      aria-label="Next photograph"
                      className={`${BUTTON_COLLAR} ${SECONDARY} ${HEIGHT.panel} px-md`}
                    >
                      →
                    </button>
                  </>
                ) : null}

                {open.hidden ? null : open.isMine ? (
                  <button
                    type="button"
                    onClick={() => remove.mutate({ photoId: open.id })}
                    className={`${BUTTON_COLLAR} ${DANGER} ${HEIGHT.panel} px-md`}
                  >
                    {remove.isPending ? 'Removing…' : 'Remove'}
                  </button>
                ) : (
                  /*
                   * Reporting somebody else's frame, from the one place it is big enough to
                   * judge. The strip's thumbnails deliberately carry no control of their
                   * own: a report button on a 102px tile is a mis-tap waiting to happen,
                   * and nobody should be filing a complaint about a picture they have not
                   * actually looked at.
                   */
                  <ReportControl
                    subject="photo"
                    subjectId={open.id}
                    isViewerKnown={isViewerKnown}
                    what={`this photograph by ${creditOf(open)}`}
                  />
                )}

                {canModerate(viewerRole) ? (
                  <ModerateControl
                    subject="photo"
                    subjectId={open.id}
                    hidden={open.hidden}
                    onDone={() => {
                      // Both directions change what this frame is, and neither is something
                      // the lightbox can restate in place: the taken-down one loses its image
                      // and the put-back one regains it, both server-side. Close and reload
                      // from the server, which is also what settles the hero at the top of
                      // the page and the count over the strip.
                      setOpenIndex(null);
                      router.refresh();
                    }}
                  />
                ) : null}

                <button
                  type="button"
                  onClick={() => setOpenIndex(null)}
                  className={`${BUTTON_COLLAR} ${SECONDARY} ${HEIGHT.panel} px-md`}
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </dialog>
    </section>
  );
}
