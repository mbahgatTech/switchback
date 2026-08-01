import type { Metadata } from 'next';
import Link from 'next/link';
import { BRAND, MODERATION_CONTACT, REPORT_SUBJECTS } from '@switchback/core';
import type { ReportSubject } from '@switchback/core';
import { ReportForm } from '@/components/moderation/report-control';
import { SiteFooter } from '@/components/site-footer';
import { SiteNav } from '@/components/site-nav';
import { Wordmark } from '@/components/wordmark';
import { caller } from '@/trpc/server';

/**
 * Report something from somewhere other than the page it is on — the in-content control assumes
 * the complainant can reach the content, and the most urgent complainants frequently cannot.
 *
 * With `?subject=…&id=…` it is the form. Without them it explains where the control is and gives
 * an address to write to; it deliberately offers no free-text "paste a link" box, because a queue
 * of complaints filed against nothing cannot be worked and looks like it did something.
 */

export const metadata: Metadata = {
  title: 'Report content',
  description: `How to report a trail report or a photograph on ${BRAND.name}, and what happens next.`,
};

function asSubject(value: string | undefined): ReportSubject | null {
  return REPORT_SUBJECTS.find((subject) => subject === value) ?? null;
}

export default async function ReportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = params.subject;
  const subject = asSubject(Array.isArray(raw) ? raw[0] : raw);
  const idRaw = params.id;
  const subjectId = (Array.isArray(idRaw) ? idRaw[0] : idRaw)?.trim() ?? '';

  // Read so the form can drop the email field for somebody we can already reach. Reporting needs
  // no account — `moderation.report` is public — so a null viewer is ordinary, not a redirect.
  const viewer = await caller.me.get();
  const targeted = subject !== null && subjectId.length > 0 && subjectId.length <= 64;

  return (
    <div data-scheme="sheet" className="min-h-dvh bg-canvas text-ink">
      <header className="mx-auto flex max-w-[760px] items-center justify-between px-xl py-lg">
        <Wordmark />
        <SiteNav />
      </header>

      <main className="mx-auto max-w-[760px] px-xl pb-5xl">
        <p className="collar">Report</p>
        <h1 className="mt-lg text-h3 font-bold text-balance">
          {targeted ? 'Tell us what is wrong with it.' : 'Something here should not be.'}
        </h1>

        {targeted ? (
          <>
            <p className="mt-lg max-w-measure-wide text-body-lg text-ink-muted">
              A person reads this. There is no automatic filter on {BRAND.name}, and we would rather
              say so than imply a machine is watching.
            </p>

            <section className="mt-3xl border-t border-bezel pt-lg">
              <ReportForm subject={subject} subjectId={subjectId} isViewerKnown={viewer !== null} />
            </section>
          </>
        ) : (
          <>
            <p className="mt-lg max-w-measure-wide text-body-lg text-ink-muted">
              Two kinds of thing on {BRAND.name} are written by other people: trail reports and
              photographs. Both can be reported, and you do not need an account to do it.
            </p>

            <section className="mt-3xl border-t border-bezel pt-lg">
              <h2 className="collar">On the page</h2>
              <div className="mt-md max-w-measure-wide space-y-md text-body leading-relaxed">
                <p>
                  Every trail report carries a <strong>Report</strong> control at the end of it.
                  Every photograph carries one in the viewer — open the picture from the gallery and
                  the control is there. Both are in the iPhone app too.
                </p>
                <p>
                  You will be asked what is wrong and, if you are not signed in, for an email
                  address so we can answer. The address is optional; an anonymous report is still a
                  report, we just cannot reply to it.
                </p>
              </div>
            </section>

            <section className="mt-3xl border-t border-bezel pt-lg">
              <h2 className="collar">If you cannot reach the page</h2>
              <div className="mt-md max-w-measure-wide space-y-md text-body leading-relaxed">
                <p>
                  Write to{' '}
                  <a
                    href={`mailto:${MODERATION_CONTACT.email}`}
                    className="text-ink underline decoration-bezel underline-offset-4 hover:decoration-ink"
                  >
                    {MODERATION_CONTACT.email}
                  </a>{' '}
                  and tell us what and where — the trail name is enough to find it.
                </p>
                <p>
                  For a copyright claim, tell us where the original is published and that the work
                  is yours. That is what we need to take it down.
                </p>
              </div>
            </section>

            <section className="mt-3xl border-t border-bezel pt-lg">
              <h2 className="collar">What happens next</h2>
              <div className="mt-md max-w-measure-wide space-y-md text-body leading-relaxed">
                <p>
                  {/*
                   * The space lives inside the template literal on purpose. Written the obvious
                   * way — `{responseDays} days.` — the compiler drops it and the page reads "5days",
                   * because this text node runs on past the end of the line and its leading space is
                   * trimmed with the newline. It is not a line-ending artefact; it survives
                   * converting the file to LF, and it shipped into the screenshots in this pull
                   * request before anyone read them closely. Keeping the number and its unit in one
                   * string puts the space somewhere no JSX whitespace rule reaches.
                   */}
                  We answer within {`${MODERATION_CONTACT.responseDays} days`}. Something dangerous,
                  or somebody&rsquo;s private information, comes down faster than that — before we
                  have finished deciding the rest.
                </p>
                <p>
                  Then one of two things: we take it down, or we leave it up and tell you why.
                  Reporting something does not remove it, and nothing is removed automatically
                  however many reports it gets.
                </p>
                <p>
                  A removal is reversible and is recorded. The full rules are on the{' '}
                  <Link
                    href="/terms"
                    className="text-ink underline decoration-bezel underline-offset-4 hover:decoration-ink"
                  >
                    terms page
                  </Link>
                  , including how to argue with one.
                </p>
              </div>
            </section>
          </>
        )}

        <SiteFooter />
      </main>
    </div>
  );
}
