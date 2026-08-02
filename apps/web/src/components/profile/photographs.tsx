import Link from 'next/link';
import { REMOVED_NOTICE_OWN, blurhashAverageColor } from '@switchback/core';
import { Photograph, PhotographMissing } from '../photos/photograph';

/**
 * Your own photographs, including the ones a moderator took down.
 *
 * **This exists because the takedown notice had nowhere to appear.** `photos.mine` is the
 * only query in the product that returns a hidden photograph, and for a while nothing called
 * it — so a removed frame simply vanished from the trail gallery and the person who uploaded
 * it was never told, which is the exact failure the review tombstone was built to avoid, and
 * which the terms page ("you will see it marked as removed in your own") said we did not do.
 * A photograph that disappears with no notice reads as a bug in the product rather than as a
 * decision somebody made and can argue with — and the person it was made against is the one
 * who has to be able to argue.
 *
 * **Only on your own page.** The section is rendered by `/profile` and by `/u/<name>` when
 * that name is yours. A stranger's copy of the same page must not carry it: the row for a
 * removed photograph states that something of theirs was removed, which is not a fact about
 * them anybody else is owed.
 *
 * The removed row carries no image and no caption — `toPhoto` blanked both server-side before
 * the shape left the API, so this component could not print them if it tried. What it carries
 * is the plate: survey, the reader's own position and their safety, which is what a notice
 * addressed to you about your own standing on the site is.
 */

export interface MyPhotograph {
  id: string;
  url: string | null;
  thumbUrl: string | null;
  blurhash: string | null;
  caption: string | null;
  hidden: boolean;
  createdAt: Date;
  /** Already resolved through `trailTitle` by the router — printed as it stands. */
  trail: { title: string; slug: string } | null;
}

export function YourPhotographs({ photographs }: { photographs: MyPhotograph[] }) {
  if (photographs.length === 0) return null;

  return (
    <section className="mt-3xl">
      <h2 className="collar">Your photographs</h2>

      <ul className="mt-md grid grid-cols-2 gap-md sm:grid-cols-3 lg:grid-cols-4">
        {photographs.map((photo) => {
          const wash = blurhashAverageColor(photo.blurhash);
          const where = photo.trail?.title ?? 'A trail';

          return (
            <li key={photo.id}>
              {photo.hidden ? (
                /*
                 * A hairline frame in the survey plate with the notice inside it, at the same
                 * size as a frame — not a grey box and not a gap. The border is what says
                 * something is missing here on purpose; the sentence says who removed it and
                 * where to write. No shadow and no overlay: the tile is the notice.
                 */
                <div className="flex h-[136px] flex-col justify-center rounded-hair border border-survey px-sm py-xs">
                  <p className="font-mono text-micro text-survey">Removed</p>
                  <p className="mt-xs text-micro leading-relaxed text-ink">{REMOVED_NOTICE_OWN}</p>
                </div>
              ) : (
                <Photograph
                  src={photo.thumbUrl ?? photo.url}
                  alt={photo.caption ?? `Your photograph of ${where}`}
                  loading="lazy"
                  style={wash ? { backgroundColor: wash } : undefined}
                  className="h-[136px] w-full rounded-hair border border-bezel object-cover"
                  fallback={<PhotographMissing className="h-[136px] w-full" />}
                />
              )}

              <p className="mt-xs truncate font-mono text-micro text-ink-muted">
                {photo.trail ? (
                  <Link
                    href={`/trails/${photo.trail.slug}`}
                    className="rounded-hair hover:text-ink"
                  >
                    {photo.trail.title}
                  </Link>
                ) : (
                  where
                )}
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
