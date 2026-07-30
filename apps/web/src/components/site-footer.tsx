import Link from 'next/link';
import { BRAND, MODERATION_CONTACT } from '@switchback/core';

/**
 * The foot of a reading page.
 *
 * **It exists for one reason, and it is not tidiness.** A notice-and-takedown process has to
 * be *findable* — a report control that only appears next to the content assumes the person
 * complaining can still reach the page, and the people who most need this often cannot: a
 * rights holder who was sent a screenshot, somebody who has been told their photograph is
 * here, anyone reading on a phone that will not load the gallery. So the route in is on
 * every page of the site, in the place people have looked for it since 1996.
 *
 * Four links and a line of type. Not a sitemap: `site-nav-menu.tsx` already carries the
 * places you can *go*, and repeating them here would make this chrome rather than a
 * colophon. What belongs here is the small print — what the rules are, how to complain, where
 * the data came from — which is exactly the set that has no place in a navigation index.
 *
 * `Link` for our own routes so the app shell is kept, a plain `mailto:` for the address.
 *
 * It carries no plate and no fill: a hairline above it and `ink-muted` type at caption size,
 * the same treatment as every other marginal note in this product. Depth here would make the
 * quietest block on the page the most structural-looking thing on it.
 */
export function SiteFooter() {
  return (
    <footer className="mt-5xl border-t border-bezel pt-lg">
      <nav aria-label="About this site">
        <ul className="flex flex-wrap items-baseline gap-x-lg gap-y-xs">
          <li>
            <FootLink href="/terms">Terms</FootLink>
          </li>
          <li>
            <FootLink href="/report">Report content</FootLink>
          </li>
          <li>
            <FootLink href="/attribution">Sources and licences</FootLink>
          </li>
          <li>
            <a
              href={`mailto:${MODERATION_CONTACT.email}`}
              className="collar text-ink-muted underline decoration-bezel underline-offset-4 hover:text-ink hover:decoration-ink"
            >
              {MODERATION_CONTACT.email}
            </a>
          </li>
        </ul>
      </nav>

      <p className="mt-md max-w-measure-wide text-caption text-ink-muted">
        {BRAND.name} holds no proprietary trail data. Reports and photographs are written by the
        people who hiked it, and are theirs.
      </p>
    </footer>
  );
}

function FootLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="collar text-ink-muted underline decoration-bezel underline-offset-4 hover:text-ink hover:decoration-ink"
    >
      {children}
    </Link>
  );
}
