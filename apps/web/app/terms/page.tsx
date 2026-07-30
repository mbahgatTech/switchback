import type { Metadata } from 'next';
import { BRAND, MODERATION_CONTACT, REPORT_DETAIL_MAX } from '@switchback/core';
import { SiteFooter } from '@/components/site-footer';
import { SiteNav } from '@/components/site-nav';
import { Wordmark } from '@/components/wordmark';

/**
 * The rules, in the fewest words that can actually be held to.
 *
 * **Written to be read, and therefore short.** A terms page nobody finishes protects nobody:
 * it is the document a person is pointed at when their report is taken down, and if they
 * cannot find the sentence it broke then the takedown reads as arbitrary however carefully
 * it was decided. So this is nine paragraphs in the same voice as the rest of the product —
 * sentence case, plain verbs, active voice — and it says what we will do rather than what we
 * reserve the right to do.
 *
 * It is deliberately not a licence agreement and does not pretend to be one. There is no
 * limitation of liability, no arbitration clause, no severability boilerplate, because
 * writing those without a lawyer produces a document that is unenforceable *and* unreadable.
 * What it does have is the part that has to be true today: what you may post, what happens
 * when somebody complains, that removals are reversible, and how to argue with one.
 *
 * `data-scheme="sheet"` because this is a reading page. The rest of the app is `field`, the
 * dark instrument scheme, and prose set on a map-dark canvas is the thing it is worst at.
 */

export const metadata: Metadata = {
  title: 'Terms',
  description: `What you may post on ${BRAND.name}, what happens when somebody reports it, and how to appeal.`,
};

/** The date the wording last changed. Printed, because "we may update these" is not a date. */
const LAST_CHANGED = '30 July 2026';

export default function TermsPage() {
  return (
    <div data-scheme="sheet" className="min-h-dvh bg-canvas text-ink">
      <header className="mx-auto flex max-w-[760px] items-center justify-between px-xl py-lg">
        <Wordmark />
        <SiteNav />
      </header>

      <main className="mx-auto max-w-[760px] px-xl pb-5xl">
        <p className="collar">Terms</p>
        <h1 className="mt-lg text-h3 font-bold text-balance">
          What you may post, and what we will do about it.
        </h1>
        <p className="mt-lg max-w-measure-wide text-body-lg text-ink-muted">
          {BRAND.name} carries two kinds of thing people write: trail reports and photographs. These
          are the rules for both, and the rules we hold ourselves to when somebody complains about
          one.
        </p>
        <p className="mt-sm font-mono text-micro text-ink-muted">Last changed {LAST_CHANGED}</p>

        <Clause title="Using the site">
          <p>
            You need an account to post a report or a photograph. You do not need one to read
            anything, and you do not need one to report something — see below.
          </p>
          <p>
            One account per person. Keep your sign-in to yourself: anything posted from your account
            is treated as yours.
          </p>
        </Clause>

        <Clause title="What you post stays yours">
          <p>
            Your reports and photographs are your work. Posting them here gives us permission to
            show them on {BRAND.name} and in the app, and to make the thumbnails and offline copies
            that requires. It gives us nothing else — we do not sell them, and we do not license
            them on to anybody.
          </p>
          <p>
            Post only what is yours to post. A photograph you took is yours; one you found is not.
          </p>
        </Clause>

        <Clause title="What must not be here">
          <p>Do not post:</p>
          <ul className="ml-lg list-disc space-y-xs">
            <li>somebody else&rsquo;s work, without their permission;</li>
            <li>
              somebody&rsquo;s private information — an address, a phone number, a car registration,
              a face they did not agree to;
            </li>
            <li>abuse of a person, hate speech, or threats;</li>
            <li>sexual content;</li>
            <li>advertising;</li>
            <li>
              a route description you know to be wrong in a way that would put somebody in danger.
            </li>
          </ul>
          <p>
            A report can be scathing about a trail. That is what the one-star reports are for, and
            they are the most useful ones on the site — the closed bridge and the washed-out ford
            get written down there. Being rude about the path is fine. Being cruel to a person is
            not.
          </p>
        </Clause>

        <Clause title="Reporting something">
          <p>
            Every report and every photograph has a <strong>Report</strong> control next to it. You
            do not need an account to use it, and you do not have to leave an email address — though
            we cannot answer you if you do not.
          </p>
          <p>
            If you cannot reach the page, write to{' '}
            <a
              href={`mailto:${MODERATION_CONTACT.email}`}
              className="text-ink underline decoration-bezel underline-offset-4 hover:decoration-ink"
            >
              {MODERATION_CONTACT.email}
            </a>{' '}
            and tell us what and where. For a copyright claim, tell us where the original is
            published.
          </p>
        </Clause>

        <Clause title="What we do with a report">
          <p>
            A person reads it. Not a filter — there is no automatic classifier on this site, and we
            would rather say so than imply a machine is watching.
          </p>
          <p>
            We answer within {MODERATION_CONTACT.responseDays} days. Something that is dangerous or
            is somebody&rsquo;s private information comes down faster than that, before we have
            finished deciding the rest.
          </p>
          <p>
            The outcome is one of two things: we take it down, or we leave it up and tell you why.
            Reporting something does not remove it, and nothing is removed automatically however
            many reports it gets.
          </p>
        </Clause>

        <Clause title="What taking something down means">
          <p>
            It is hidden, not destroyed. A removed report leaves a line on the trail page saying it
            was removed — the page does not pretend it was never written — and its rating stops
            counting toward the trail&rsquo;s average. A removed photograph leaves the gallery, and
            you will see it marked as removed in your own.
          </p>
          <p>
            We keep the record of what was removed and why, because a takedown that cannot be shown
            is one that cannot be checked. We can put it back, and we do when we got it wrong.
          </p>
        </Clause>

        <Clause title="If we got it wrong">
          <p>
            Write to{' '}
            <a
              href={`mailto:${MODERATION_CONTACT.email}`}
              className="text-ink underline decoration-bezel underline-offset-4 hover:decoration-ink"
            >
              {MODERATION_CONTACT.email}
            </a>
            . Say what was removed and why you think it should not have been. A different person
            reads an appeal from the one who made the decision, wherever there is more than one of
            us to ask.
          </p>
        </Clause>

        <Clause title="Your account">
          <p>
            You can delete your own reports and photographs at any time. Deleting a report removes
            it and takes its rating out of the trail&rsquo;s average.
          </p>
          <p>
            We may suspend an account that keeps posting things that have to be removed. We will say
            why.
          </p>
        </Clause>

        <Clause title="The trail data is not ours">
          <p>
            The routes, the ground under them and the weather over them are open data, used under
            the licences on the{' '}
            <a
              href="/attribution"
              className="text-ink underline decoration-bezel underline-offset-4 hover:decoration-ink"
            >
              sources page
            </a>
            . None of it is a guarantee that a path exists, is passable, or is safe. Read the
            reports, check the forecast, and make your own decision at the trailhead.
          </p>
        </Clause>

        <Clause title="Changes">
          <p>
            If these change in a way that affects what you may post, or what we do with a report, we
            will say so on this page and change the date at the top.
          </p>
        </Clause>

        <p className="mt-3xl max-w-measure text-caption text-ink-muted">
          A report may be up to {REPORT_DETAIL_MAX.toLocaleString()} characters, which is more than
          anybody needs to explain what is wrong with a photograph.
        </p>

        <SiteFooter />
      </main>
    </div>
  );
}

/**
 * One clause: a collar heading and its prose.
 *
 * Ruled off at the top rather than boxed. The hairline is the whole of the structure here —
 * these are sections of one document, not nine cards, and a border on four sides would say
 * they were separable.
 */
function Clause({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-3xl border-t border-bezel pt-lg">
      <h2 className="collar">{title}</h2>
      <div className="mt-md max-w-measure-wide space-y-md text-body leading-relaxed">
        {children}
      </div>
    </section>
  );
}
