import type { Metadata } from 'next';
import { ATTRIBUTION, ATTRIBUTION_CORRECTIONS, ATTRIBUTION_SOURCES, BRAND } from '@switchback/core';
import { SiteNav } from '@/components/site-nav';
import { Wordmark } from '@/components/wordmark';

/**
 * Sources and licences.
 *
 * Not a footer obligation discharged in six point type. OpenStreetMap is ODbL, which means
 * attribution **and** share-alike on a derived database; the DEMs and the weather are CC-BY.
 * Each of those is a condition on using the data at all, so this page states what came from
 * where in plain terms and links the licence.
 *
 * The list itself lives in `@switchback/core`, because the iOS app publishes the same one and
 * a licence statement that differs between the two clients means one of them is wrong.
 *
 * `data-scheme="sheet"` because this is a reading page. The rest of the app is `field` — the
 * dark instrument scheme — and prose set on a map-dark canvas is the thing that scheme is
 * worst at.
 */

export const metadata: Metadata = {
  title: 'Sources and licences',
  description: `Where ${BRAND.name}'s trail, elevation, imagery and weather data comes from, and under which licences.`,
};

const SOURCES = ATTRIBUTION_SOURCES;

export default function AttributionPage() {
  return (
    <div data-scheme="sheet" className="min-h-dvh bg-canvas text-ink">
      <header className="mx-auto flex max-w-[760px] items-center justify-between px-xl py-lg">
        <Wordmark />
        <SiteNav />
      </header>

      <main className="mx-auto max-w-[760px] px-xl pb-5xl">
        <p className="collar">Sources</p>
        <h1 className="mt-lg text-h3 font-bold text-balance">
          Everything on the map came from somewhere.
        </h1>
        <p className="mt-lg max-w-measure-wide text-body-lg text-ink-muted">
          {BRAND.name} holds no proprietary trail data. The routes, the ground under them and the
          weather over them are open data, used under the licences below.
        </p>

        <dl className="mt-3xl border-t border-bezel">
          {SOURCES.map((source) => {
            const credit = ATTRIBUTION[source.key];
            return (
              <div
                key={source.key}
                className="grid gap-sm border-b border-bezel py-xl sm:grid-cols-[13rem_1fr] sm:items-baseline sm:gap-xl"
              >
                <dt className="collar">{source.what}</dt>
                <dd>
                  <a
                    href={credit.href}
                    className="text-body font-medium text-ink underline decoration-bezel underline-offset-4 hover:decoration-ink"
                  >
                    {credit.label}
                  </a>
                  <p className="mt-xs max-w-measure text-caption text-ink-muted">{source.detail}</p>
                  <p className="mt-sm font-mono text-micro text-ink-muted">{credit.licence}</p>
                </dd>
              </div>
            );
          })}
        </dl>

        <section className="mt-3xl">
          <h2 className="collar">Corrections</h2>
          <p className="mt-md max-w-measure-wide text-body text-ink-muted">
            {ATTRIBUTION_CORRECTIONS.upstream}
          </p>
          <p className="mt-md text-caption text-ink-muted">
            <a
              href={ATTRIBUTION_CORRECTIONS.osmHref}
              className="text-ink underline decoration-bezel underline-offset-4 hover:decoration-ink"
            >
              Fix it on OpenStreetMap
            </a>
            {' · Anything else: '}
            <a
              href={`mailto:${BRAND.supportEmail}`}
              className="text-ink underline decoration-bezel underline-offset-4 hover:decoration-ink"
            >
              {BRAND.supportEmail}
            </a>
          </p>
        </section>
      </main>
    </div>
  );
}
