import { expect, test } from '@playwright/test';
import { PROBE_SESSION_TOKEN, VESPER } from './fixtures';
import type { BrowserContext, Page } from '@playwright/test';

/**
 * Two separate claims: that every page is painted out of one palette in both modes (asked of
 * the browser, because a pale panel three scrolls down is what an eye slides past), and that
 * an explicit choice is remembered with the right precedence between account, browser and OS.
 */

/** Mirrors `THEME_COOKIE` in `apps/web/src/lib/theme.ts` — the wire contract under test. */
const THEME_COOKIE = 'sb-theme';

/**
 * One of each kind of page rather than every route: a palette leak is a component-level
 * defect, and every component in the app appears somewhere in this list.
 */
const ROUTES = [
  '/',
  '/nearby',
  `/trails/${VESPER.slug}`,
  '/plan',
  '/record',
  '/lists',
  '/activities',
  '/routes',
  '/profile',
  '/settings',
  '/downloads',
  '/offline',
  '/attribution',
  '/signin',
];

interface Findings {
  mode: string;
  slabs: string[];
  contrast: string[];
}

/** Self-contained because it runs inside `evaluate`, where nothing from this module is in scope. */
function audit(mode: 'dark' | 'light'): Findings {
  const parse = (c: string): number[] | null => {
    const m = /rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?/.exec(c);
    return m ? [+m[1]!, +m[2]!, +m[3]!, m[4] === undefined ? 1 : +m[4]] : null;
  };
  const lum = (rgb: number[]): number => {
    const f = (v: number): number => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(rgb[0]!) + 0.7152 * f(rgb[1]!) + 0.0722 * f(rgb[2]!);
  };
  const ratio = (a: number[], b: number[]): number => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x! + 0.05) / (y! + 0.05);
  };
  /** `fg` composited onto an opaque `bg`. */
  const over = (fg: number[], bg: number[]): number[] =>
    [0, 1, 2].map((i) => fg[i]! * fg[3]! + bg[i]! * (1 - fg[3]!));

  /**
   * The colour actually behind an element. Reading the parent's `background-color` naively
   * gives `rgba(0,0,0,0)` on almost every wrapper, scoring a black backdrop and reporting
   * failures nobody can see; this hikes to the first opaque layer and composites back down.
   */
  const backdrop = (el: Element): number[] => {
    const stack: number[][] = [];
    for (let n: Element | null = el; n; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c[3]! > 0) stack.push(c);
      if (c && c[3] === 1) break;
    }
    let out = [0, 0, 0];
    for (let i = stack.length - 1; i >= 0; i--) out = over(stack[i]!, out);
    return out;
  };

  const label = (el: Element): string => {
    const cls = el.className?.toString?.().trim().split(/\s+/).slice(0, 3).join('.') ?? '';
    return el.tagName.toLowerCase() + (el.id ? `#${el.id}` : cls ? `.${cls}` : '');
  };

  /*
   * The print sheet is paper by definition; the map canvas is cartography, where inverted
   * terrain shading is unreadable (the reader gets a layer switcher instead); `nextjs-portal`
   * is the dev server's own toolbar and does not ship.
   */
  const skip = (el: Element): boolean =>
    el.closest('[data-print-sheet], .maplibregl-map, nextjs-portal') !== null ||
    ['IMG', 'CANVAS', 'SVG', 'PATH', 'SCRIPT', 'STYLE'].includes(el.tagName);

  const slabs: string[] = [];
  const contrast: string[] = [];
  const seen = new Set<string>();

  for (const el of document.querySelectorAll('body *')) {
    if (skip(el)) continue;
    const box = el.getBoundingClientRect();
    if (box.width < 4 || box.height < 4) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') continue;

    /*
     * A large area painted out of the current palette. Controls are exempt: a primary button
     * is `bg-ink text-canvas`, so it is light-on-dark in dark mode by design. Its text still
     * has to clear the contrast check below, which is what protects the reader.
     */
    const own = parse(cs.backgroundColor);
    const control = el.closest('button, a, summary, [role="button"], [role="tab"]') !== null;
    const wrong =
      mode === 'dark' ? lum(own ?? [0, 0, 0]) > 0.5 : lum(own ?? [255, 255, 255]) < 0.12;
    if (own && own[3]! > 0.5 && !control && box.width * box.height > 20_000 && wrong) {
      const key = `slab:${label(el)}`;
      if (!seen.has(key)) {
        seen.add(key);
        slabs.push(
          `${label(el)} bg=${cs.backgroundColor} ${Math.round(box.width)}×${Math.round(box.height)}`,
        );
      }
    }

    // Only elements that own their text, or every ancestor is reported for the same string.
    const text = [...el.childNodes]
      .filter((n) => n.nodeType === 3)
      .map((n) => (n.textContent ?? '').trim())
      .join(' ')
      .trim();
    if (!text) continue;

    const fg = parse(cs.color);
    if (!fg || fg[3] === 0) continue;
    const bg = backdrop(el);
    const r = ratio(over(fg, bg), bg);
    const size = parseFloat(cs.fontSize);
    const bold = +cs.fontWeight >= 700;
    // AA's large-text threshold: 24px, or 18.66px when bold.
    const need = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;
    if (r < need) {
      const key = `c:${label(el)}:${cs.color}`;
      if (!seen.has(key)) {
        seen.add(key);
        contrast.push(
          `${label(el)} ${r.toFixed(2)}:1 (needs ${need}) ${cs.color} on ` +
            `rgb(${bg.map(Math.round).join(',')}) — "${text.slice(0, 40)}"`,
        );
      }
    }
  }

  return { mode: document.documentElement.dataset.mode ?? '(unset)', slabs, contrast };
}

/** Let the route settle: fonts resolved, first data in, layout no longer moving. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {
    // A page with a live map never goes idle; the palette is a property of the DOM, not of
    // how many tiles have landed.
  });
}

for (const mode of ['dark', 'light'] as const) {
  test(`every page is painted in the ${mode} palette`, async ({ browser, baseURL }) => {
    // Fourteen routes, each compiled on demand by the dev server on a cold run.
    test.setTimeout(300_000);
    const origin = baseURL ?? 'http://localhost:3000';
    const context = await browser.newContext({
      baseURL: origin,
      viewport: { width: 1400, height: 900 },
      // The opposite of the cookie, deliberately: if the cookie is not honoured the page
      // comes back in the wrong palette and every assertion below inverts loudly.
      colorScheme: mode === 'dark' ? 'light' : 'dark',
    });
    await context.addCookies([
      { name: 'authjs.session-token', value: PROBE_SESSION_TOKEN, url: origin },
      { name: THEME_COOKIE, value: mode, url: origin },
    ]);
    const page = await context.newPage();

    const failures: string[] = [];
    for (const route of ROUTES) {
      await page.goto(route, { waitUntil: 'domcontentloaded' });
      await settle(page);
      const found = await page.evaluate(audit, mode);
      expect(found.mode, `${route} did not resolve to ${mode}`).toBe(mode);
      for (const s of found.slabs) failures.push(`${route}  out-of-palette: ${s}`);
      for (const c of found.contrast) failures.push(`${route}  contrast:       ${c}`);
    }
    await context.close();

    expect(failures.join('\n'), `${mode} palette findings`).toBe('');
  });
}

interface Resolved {
  /** `data-mode` on `<html>`, or `(unset)` — which is itself meaningful. */
  attr: string;
  canvas: string;
}

async function resolve(
  context: BrowserContext,
  origin: string,
  cookie: 'dark' | 'light' | null,
): Promise<Resolved> {
  if (cookie) await context.addCookies([{ name: THEME_COOKIE, value: cookie, url: origin }]);
  const page = await context.newPage();
  await page.goto('/settings', { waitUntil: 'domcontentloaded' });
  const out = await page.evaluate(() => ({
    attr: document.documentElement.dataset.mode ?? '(unset)',
    canvas: getComputedStyle(document.documentElement).backgroundColor,
  }));
  await page.close();
  return out;
}

/**
 * The verified palette values. A test that only checked `data-mode` would pass while the
 * stylesheet painted the opposite, which is the failure that matters.
 */
const CANVAS = { dark: 'rgb(17, 24, 25)', light: 'rgb(228, 233, 227)' };

for (const os of ['dark', 'light'] as const) {
  const other = os === 'dark' ? 'light' : 'dark';

  test(`with no preference stored, a ${os} device gets the ${os} palette`, async ({
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({ baseURL: baseURL ?? '', colorScheme: os });
    const r = await resolve(context, baseURL ?? '', null);
    await context.close();
    /*
     * The attribute stays *unset* on purpose: the stylesheet's `prefers-color-scheme`
     * fallbacks key on `html:not([data-mode])`, so a device that switches to dark at dusk
     * with the tab open follows along without a round trip.
     */
    expect(r.attr).toBe('(unset)');
    expect(r.canvas).toBe(CANVAS[os]);
  });

  test(`a browser choice of ${other} overrides a ${os} device`, async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL: baseURL ?? '', colorScheme: os });
    const r = await resolve(context, baseURL ?? '', other);
    await context.close();
    expect(r.attr).toBe(other);
    expect(r.canvas).toBe(CANVAS[other]);
  });
}

test('an account set to system falls through to the browser choice', async ({
  browser,
  baseURL,
}) => {
  const origin = baseURL ?? 'http://localhost:3000';
  const context = await browser.newContext({ baseURL: origin, colorScheme: 'light' });
  await context.addCookies([
    { name: 'authjs.session-token', value: PROBE_SESSION_TOKEN, url: origin },
  ]);
  const r = await resolve(context, origin, 'dark');
  await context.close();
  // The probe account ships as `theme: 'system'`, meaning "I have not chosen" rather than
  // "follow the OS on the server" — so the cookie, not the device, decides.
  expect(r.attr).toBe('dark');
  expect(r.canvas).toBe(CANVAS.dark);
});
