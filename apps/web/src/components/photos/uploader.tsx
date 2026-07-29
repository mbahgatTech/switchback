'use client';

/**
 * Adding photographs.
 *
 * The bytes never touch our API. `presign` authorises two objects, the browser `PUT`s them
 * straight at the store, and `commit` writes the row once they have landed — so a 4 MB
 * upload is between the phone and the bucket, and a serverless function is not held open for
 * the length of somebody's uplink. What arrives here is the consequence: the work in this
 * component is a queue, not a request.
 *
 * **One at a time, on purpose.** Six photographs in parallel share the same uplink and finish
 * at the same moment they would have finished in sequence — except that in parallel every one
 * of them sits at 0% until they all complete at once. Sequential gives the person a count
 * that moves: *third of six*. The only thing lost is a little latency on a fast connection.
 *
 * **A failure is per photograph, never per batch.** Five uploads and one refusal leaves five
 * photographs on the trail and one row saying what went wrong, because re-picking six files
 * to retry one is a punishment for the wrong mistake.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { MAX_PHOTOS_PER_TRAIL_PER_USER, formatBytes } from '@switchback/core';
import type { UploadTicket } from '@switchback/core';
import type { TrailPhoto } from '@switchback/api/routers/photos';
import { PHOTO_ACCEPT, preparePhoto } from '../../lib/photo-prepare';
import { useTRPC } from '../../trpc/react';
import { BUTTON_COLLAR, GHOST, HEIGHT } from '../controls';

export interface PhotoUploaderProps {
  trailId: string;
  /** Called once per photograph, as each one lands, so the gallery fills in as it goes. */
  onUploaded: (photo: TrailPhoto) => void;
  /**
   * The call to action, when "Add photographs" is not what this instance is asking for.
   *
   * The report form asks for the photographs of one particular hike rather than for the
   * trail's gallery in general, and a control that says the same thing in both places would
   * make the second one look like it had been dropped there by accident.
   */
  label?: string;
  /** The line under it. Keep it about what happens to the file. */
  hint?: string;
}

const DEFAULT_LABEL = 'Add photographs';
const DEFAULT_HINT =
  'Drop them here or choose files. They are resized in your browser before they are sent, and ' +
  'the camera data — including where the picture was taken — is stripped unless the spot falls ' +
  'on this trail.';

type Stage = 'preparing' | 'sending' | 'saving' | 'failed';

interface QueueItem {
  id: string;
  name: string;
  previewUrl: string | null;
  stage: Stage;
  error: string | null;
}

/** What each stage says while it is happening. Verbs, because something is happening. */
const STAGE_LABEL: Readonly<Record<Stage, string>> = {
  preparing: 'Resizing',
  sending: 'Sending',
  saving: 'Filing',
  failed: 'Failed',
};

async function putObject(ticket: UploadTicket, body: Blob): Promise<void> {
  if (body.size > ticket.maxBytes) {
    throw new Error(
      `That came to ${formatBytes(body.size)}, over the ${formatBytes(ticket.maxBytes)} limit.`,
    );
  }
  // The local development driver returns a root-relative URL and the object store returns an
  // absolute one. `new URL(…, origin)` handles both — a base is ignored when the first
  // argument is already absolute.
  const response = await fetch(new URL(ticket.url, window.location.origin), {
    method: ticket.method,
    // Verbatim. The signature covers `content-type`, so letting `fetch` infer one from the
    // blob produces a signature mismatch rather than a helpful error.
    headers: ticket.headers,
    body,
  });
  if (!response.ok) {
    throw new Error(`The upload was refused (${response.status}).`);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'That did not upload.';
}

/**
 * The queued file's own thumbnail, and what stands in when it will not draw.
 *
 * `previewUrl` is an object URL for a file that exists only in this tab, which is why it is
 * a plain `<img>`: no image optimiser can fetch, resize, or cache a blob. It is also revoked
 * the moment the item leaves the queue, and a browser mid-paint when that happens draws the
 * broken-image glyph — a torn-page icon, 34 px square, in a row that is otherwise reporting
 * success. The dashed square is what this row shows before a preview exists. It is the right
 * thing to show after one stops existing too.
 */
function Thumb({ src }: { src: string | null }) {
  const [broken, setBroken] = useState(false);

  if (src === null || broken) {
    return (
      <span
        aria-hidden
        className="size-[34px] shrink-0 rounded-hair border border-dashed border-bezel"
      />
    );
  }

  return (
    /* eslint-disable-next-line @next/next/no-img-element */
    <img
      src={src}
      alt=""
      onError={() => setBroken(true)}
      className="size-[34px] shrink-0 rounded-hair border border-bezel object-cover"
    />
  );
}

export function PhotoUploader({ trailId, onUploaded, label, hint }: PhotoUploaderProps) {
  const trpc = useTRPC();
  const [items, setItems] = useState<QueueItem[]>([]);
  const [dragging, setDragging] = useState(false);
  const [running, setRunning] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const presign = useMutation(trpc.photos.presign.mutationOptions());
  const commit = useMutation(trpc.photos.commit.mutationOptions());

  // Held in a ref as well as in state so the unmount cleanup sees the current set without
  // taking `items` as a dependency, which would revoke a live preview on every render.
  const previews = useRef(new Set<string>());
  useEffect(() => {
    const urls = previews.current;
    return () => {
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, []);

  const update = useCallback((id: string, patch: Partial<QueueItem>): void => {
    setItems((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }, []);

  const drop = useCallback((id: string): void => {
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const run = useCallback(
    async (files: File[]): Promise<void> => {
      const images = files.filter((file) => file.type.startsWith('image/'));
      if (images.length === 0) return;

      // Trimmed here as well as enforced at commit, so a person who picks forty files is told
      // now rather than after twelve successes and twenty-eight refusals.
      const chosen = images.slice(0, MAX_PHOTOS_PER_TRAIL_PER_USER);
      const queued: QueueItem[] = chosen.map((file, index) => ({
        id: `${Date.now()}-${index}-${file.name}`,
        name: file.name,
        previewUrl: null,
        stage: 'preparing',
        error: null,
      }));
      setItems((current) => [...current, ...queued]);
      setRunning(true);

      for (const [index, file] of chosen.entries()) {
        const item = queued[index];
        if (!item) continue;
        try {
          const prepared = await preparePhoto(file);
          previews.current.add(prepared.previewUrl);
          update(item.id, { stage: 'sending', previewUrl: prepared.previewUrl });

          const grant = await presign.mutateAsync({
            contentType: prepared.contentType,
            bytes: prepared.full.size,
            trailId,
          });

          await putObject(grant.full, prepared.full);
          if (prepared.thumb) {
            // Best effort. A missing thumbnail costs a larger image in the strip; a failed
            // upload over one costs the photograph.
            await putObject(grant.thumb, prepared.thumb).catch(() => undefined);
          }

          update(item.id, { stage: 'saving' });
          const photo = await commit.mutateAsync({
            token: grant.token,
            trailId,
            width: prepared.width,
            height: prepared.height,
            blurhash: prepared.blurhash,
            caption: null,
            lng: prepared.lng,
            lat: prepared.lat,
            capturedAt: prepared.capturedAt,
          });

          onUploaded(photo);
          URL.revokeObjectURL(prepared.previewUrl);
          previews.current.delete(prepared.previewUrl);
          drop(item.id);
        } catch (error) {
          update(item.id, { stage: 'failed', error: messageOf(error) });
        }
      }

      setRunning(false);
    },
    [commit, drop, onUploaded, presign, trailId, update],
  );

  return (
    <div className="mt-md">
      {/*
       * A real `<label>` around a hidden file input rather than a button that clicks one.
       * Keyboard focus, the space bar, and the browser's own picker all work without a line
       * of code, and the drop target and the click target are then the same rectangle.
       */}
      <label
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          void run(Array.from(event.dataTransfer.files));
        }}
        className={`flex cursor-pointer flex-col items-center justify-center gap-xs rounded-hair border border-dashed px-md py-lg text-center transition-colors duration-quick ease-standard has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ink ${
          dragging ? 'border-woodland bg-woodland-wash' : 'border-bezel hover:border-ink-muted'
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          accept={PHOTO_ACCEPT}
          multiple
          disabled={running}
          className="sr-only"
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            // Cleared so choosing the same file twice in a row fires `change` the second time.
            event.target.value = '';
            void run(files);
          }}
        />
        <span className="collar text-ink">{running ? 'Uploading…' : (label ?? DEFAULT_LABEL)}</span>
        <span className="max-w-measure text-caption text-ink-muted">{hint ?? DEFAULT_HINT}</span>
      </label>

      {items.length > 0 ? (
        <ul className="mt-sm flex flex-col gap-hair">
          {items.map((item) => (
            <li
              key={item.id}
              className="flex items-center gap-sm rounded-hair border border-bezel bg-surface px-sm py-xs"
            >
              <Thumb src={item.previewUrl} />
              <span className="min-w-0 flex-1 truncate font-mono text-micro text-ink-muted">
                {item.name}
              </span>
              {item.stage === 'failed' ? (
                <>
                  <span className="text-caption text-survey">{item.error}</span>
                  <button
                    type="button"
                    onClick={() => drop(item.id)}
                    className={`${BUTTON_COLLAR} ${GHOST} ${HEIGHT.panel} shrink-0 px-sm`}
                  >
                    Dismiss
                  </button>
                </>
              ) : (
                <span className="collar shrink-0 text-ink-muted">{STAGE_LABEL[item.stage]}</span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
