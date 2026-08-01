import Link from 'next/link';
import { BRAND, MODERATION_CONTACT } from '@switchback/core';

/**
 * The foot of a reading page, and it exists so the notice-and-takedown route is *findable*:
 * the people who most need it often cannot reach the page the report control sits on — a
 * rights holder working from a screenshot, a phone that will not load the gallery.
 *
 * Four links and a line of type, not a sitemap: `site-nav-menu.tsx` carries the places you can
 * go, and what belongs here is the small print. No plate and no fill, the same treatment as
 * every other marginal note in this product.
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
