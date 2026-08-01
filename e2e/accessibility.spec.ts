import { AxeBuilder } from '@axe-core/playwright';
import type { Result } from 'axe-core';
import type { Page, TestInfo } from '@playwright/test';
import { SHEET_AT_VESPER, VESPER, expect, expectTrailsLanded, sheetOf, test } from './fixtures';

/**
 * The accessibility gate: zero WCAG 2.1 A/AA violations on every route shape.
 * Axe only sees machine-checkable failures, so a green run is a floor, not a certificate.
 * First interactions are wrapped in `toPass`: these buttons are server-rendered, and a click
 * that lands before React attaches its handler is swallowed in silence.
 */

/**
 * Conformance target. AAA is excluded (7:1 body contrast no map chrome meets); `best-practice`
 * is excluded because it encodes axe's house opinions rather than the standard.
 */
const WCAG_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/**
 * One line per failing element. Axe nests nodes inside a per-rule violation, so asserting on
 * the raw array prints one entry however many elements are wrong and buries the selectors.
 */
function eachFailure(violations: Result[]): string[] {
  return violations.flatMap((violation) =>
    violation.nodes.map((node) => {
      const where = node.target.join(' ');
      // Drop `failureSummary`'s "Fix any of the following:" preamble; the reasons are the part
      // that differs between two nodes failing the same rule.
      const why = (node.failureSummary ?? violation.help)
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.endsWith(':'))
        .join(' · ');
      return `${violation.id} [${violation.impact ?? 'n/a'}] ${where} — ${why}`;
    }),
  );
}

/**
 * Audit whatever is currently on screen. The full result is attached rather than printed: it
 * carries the incomplete checks, so a rule that errored out cannot pass as "no violations".
 */
async function audit(
  page: Page,
  info: TestInfo,
  tune: (builder: AxeBuilder) => AxeBuilder = (builder) => builder,
): Promise<void> {
  const results = await tune(new AxeBuilder({ page }).withTags(WCAG_AA)).analyze();

  await info.attach('axe.json', {
    body: JSON.stringify(results, null, 2),
    contentType: 'application/json',
  });

  expect(eachFailure(results.violations)).toEqual([]);
}

/** Auditing a skeleton audits the skeleton; every route here server-renders its `<h1>`. */
async function settled(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 60_000 });
}

/**
 * Every control and figure, scrolled into view inside whatever box owns it, plus whichever
 * still ended up outside the window. Also reports page scroll: a browser will programmatically
 * scroll an `overflow:hidden` box, dragging the header off with no gesture that brings it back.
 */
async function survey(page: Page): Promise<{
  counted: number;
  stranded: string[];
  pageScrollY: number;
  headerTop: number;
}> {
  return page.evaluate(() => {
    const bottom = window.innerHeight;
    const named = (el: Element): string =>
      (el.getAttribute('aria-label') ?? el.textContent ?? el.tagName).trim().slice(0, 40);
    // Figures as well as controls: a statistic you cannot get to is as broken as a button
    // you cannot press, and on this screen the statistics are the point.
    const targets = [
      ...document.querySelectorAll(
        'main button, main a[href], main input, main select, main textarea, main .collar',
      ),
    ].filter((el) => el.getClientRects().length > 0);
    const stranded: string[] = [];
    for (const el of targets) {
      el.scrollIntoView({ block: 'nearest' });
      const box = el.getBoundingClientRect();
      if (box.bottom > bottom + 1 || box.top < -1) stranded.push(named(el));
    }
    const header = document.querySelector('header');
    return {
      counted: targets.length,
      stranded,
      pageScrollY: window.scrollY,
      headerTop: header ? Math.round(header.getBoundingClientRect().top) : 0,
    };
  });
}

/** Somewhere to stand while the recorder is driven. Vesper Peak, the corpus's own trail. */
const TRAILHEAD = { latitude: 48.01213, longitude: -121.51188 };

/** The control this phase exists for, without scrolling anything. */
async function primaryOnScreen(page: Page, name: string): Promise<void> {
  const box = await page.getByRole('button', { name, exact: true }).boundingBox();
  const height = page.viewportSize()?.height ?? 0;
  expect(box, `${name} has no box`).not.toBeNull();
  expect(box ? box.y + box.height : Infinity).toBeLessThanOrEqual(height);
}

/**
 * What percentage of an element is inside its own scroll container, not the window.
 * `overflow-y-auto` clips its children, so an element can be inside the viewport and painted
 * nowhere. Callers assert a floor, not presence: `> 0` passes on an alert clipped to one percent.
 */
async function onGlass(page: Page, selector: string, text: string): Promise<number> {
  return page.evaluate(
    ({ selector: css, text: label }) => {
      const el = [...document.querySelectorAll(css)].find((node) =>
        (node.textContent ?? '').includes(label),
      );
      if (!el) return -1;
      const port = el.closest('.overflow-y-auto') ?? document.documentElement;
      const box = el.getBoundingClientRect();
      const clip = port.getBoundingClientRect();
      const visible = Math.max(0, Math.min(box.bottom, clip.bottom) - Math.max(box.top, clip.top));
      return box.height === 0 ? 0 : Math.round((visible / box.height) * 100);
    },
    { selector, text },
  );
}

/**
 * Leave the readout where a hiker who has looked below the fold leaves it. Returns the scroll
 * offset so a caller can fail loudly when the column did not overflow and proves nothing.
 */
async function scrollReadoutToBottom(page: Page): Promise<number> {
  return page.evaluate(() => {
    const port = document.querySelector('main .overflow-y-auto');
    if (!(port instanceof HTMLElement)) return -1;
    port.scrollTop = port.scrollHeight;
    return port.scrollTop;
  });
}

/**
 * Press start and wait for the first fix good enough to turn `locating` into `recording`.
 * The press is retried because a click landing before React hydrates is swallowed in silence;
 * the position is nudged because a watch will not redeliver its one mocked position.
 */
async function beginRecording(
  page: Page,
  at: { latitude: number; longitude: number },
): Promise<void> {
  const startButton = page.getByRole('button', { name: /^(Start recording|Record )/ });
  await expect(async () => {
    if (await startButton.isVisible()) await startButton.click();
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible({
      timeout: 1_000,
    });
  }).toPass({ timeout: 60_000 });

  await expect(async () => {
    await page.context().setGeolocation({
      latitude: at.latitude + Math.random() / 10_000,
      longitude: at.longitude + Math.random() / 10_000,
    });
    await expect(page.getByText('Finding you')).toBeHidden({ timeout: 1_000 });
  }).toPass({ timeout: 60_000 });
}

/**
 * The distinct page shapes, not every route — detail pages reuse their index's components.
 * `/` is excluded on purpose: its shell `<h1>` is `sr-only`, so `settled()` returns before the
 * sheet has any trails and the audit would report a clean page having read almost none of it.
 */
const ROUTES: { name: string; path: string }[] = [
  { name: 'the nearby list', path: '/nearby' },
  { name: 'a trail', path: `/trails/${VESPER.slug}` },
  { name: 'the route planner', path: '/plan' },
  { name: 'the recorder', path: '/record' },
  { name: 'saved trails', path: '/lists' },
  { name: 'your hikes', path: '/activities' },
  { name: 'planned routes', path: '/routes' },
  { name: 'downloads', path: '/downloads' },
  { name: 'settings', path: '/settings' },
  { name: 'attribution', path: '/attribution' },
  { name: 'the offline page', path: '/offline' },
];

test.describe('Accessibility', () => {
  for (const route of ROUTES) {
    test(`${route.name} has no WCAG A/AA violations`, async ({ signedInPage: page }, info) => {
      await page.goto(route.path, { waitUntil: 'domcontentloaded' });
      await settled(page);
      await audit(page, info);
    });
  }

  /** Waits on `data-trails` rather than `settled`: the sheet paints its chrome before the tile query lands. */
  test('the map sheet has no WCAG A/AA violations', async ({ signedInPage: page }, info) => {
    await page.goto(SHEET_AT_VESPER, { waitUntil: 'domcontentloaded' });
    await expectTrailsLanded(sheetOf(page));
    await audit(page, info);
  });

  /**
   * Signed out is a different page, not the same page with fewer buttons: the header, the save
   * controls and `/signin` itself are markup the signed-in runs above never reach.
   */
  test('signing in has no WCAG A/AA violations', async ({ page }, info) => {
    await page.goto('/signin', { waitUntil: 'domcontentloaded' });
    await settled(page);
    await audit(page, info);
  });

  test('a trail read by a signed-out visitor has no WCAG A/AA violations', async ({
    page,
  }, info) => {
    await page.goto(`/trails/${VESPER.slug}`, { waitUntil: 'domcontentloaded' });
    await settled(page);
    await audit(page, info);
  });

  /** The report form open — an audit with it closed behind a button sees none of its markup. */
  test('the report form has no WCAG A/AA violations', async ({ signedInPage: page }, info) => {
    await page.goto(`/trails/${VESPER.slug}`, { waitUntil: 'domcontentloaded' });
    await settled(page);

    const rating = page.locator('label:has(input[name="rating"][value="5"])');
    await expect(async () => {
      await page.getByRole('button', { name: /Report on this trail|Edit your report/u }).click();
      await expect(rating).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 60_000 });

    await audit(page, info);
  });

  /**
   * The nav disclosure at 320px — every audit above runs at a width where the panel is
   * `display:none`, so axe has never seen its markup. Escape and focus are asserted here
   * because this is the only spec in the suite that opens the menu.
   */
  test('the navigation index has no WCAG A/AA violations at 320px', async ({
    signedInPage: page,
  }, info) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto('/lists', { waitUntil: 'domcontentloaded' });
    await settled(page);

    const index = page.getByRole('button', { name: 'Index' });
    const panel = page.locator('#site-nav-menu');
    await expect(async () => {
      await index.click();
      await expect(panel.getByRole('link', { name: 'Downloads' })).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 60_000 });

    await expect(index).toHaveAttribute('aria-expanded', 'true');
    await audit(page, info);

    await page.keyboard.press('Escape');
    await expect(index).toHaveAttribute('aria-expanded', 'false');
    await expect(index).toBeFocused();
  });

  /**
   * The same at 320px, on the neatline that also carries the ODbL credit. Every map sets
   * `attributionControl: false`, so the link in the page is the entire credit for the screen —
   * hence the assertion that it is visible with the disclosure still shut.
   */
  test('the map sheet navigation has no WCAG A/AA violations at 320px', async ({
    signedInPage: page,
  }, info) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto(SHEET_AT_VESPER, { waitUntil: 'domcontentloaded' });
    await expectTrailsLanded(sheetOf(page));

    const index = page.getByRole('button', { name: 'Index' });
    const panel = page.locator('#site-nav-menu');

    // Before anything is opened. ODbL is a condition of showing the data, not a thing to be
    // put one tap behind a control named for something else.
    await expect(page.getByRole('link', { name: '© OSM' })).toBeVisible();

    await expect(async () => {
      await index.click();
      await expect(panel.getByRole('link', { name: /OpenStreetMap/u })).toBeVisible({
        timeout: 1_000,
      });
    }).toPass({ timeout: 60_000 });

    await audit(page, info);
  });

  /**
   * Reachability, not axe. `/record` is `h-dvh overflow-hidden`, so a readout column taller
   * than the window is not scrollable by any gesture: every control keeps its name, role and
   * contrast and the audit passes while "Start recording" sits below the bottom of the phone.
   * That is a WCAG 1.4.10 reflow failure no rule engine sees, so it is asserted by geometry.
   * Run with the Lifeline form open too — it is the tallest thing the column ever holds.
   */
  test('every control on the recorder is reachable at 320px', async ({ signedInPage: page }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto('/record', { waitUntil: 'domcontentloaded' });
    await settled(page);

    await primaryOnScreen(page, 'Start recording');
    const shut = await survey(page);
    expect(shut.counted).toBeGreaterThan(5);
    expect(shut.stranded, 'controls stranded outside the viewport').toEqual([]);
    expect(shut.pageScrollY).toBe(0);
    expect(shut.headerTop, 'the header was dragged off screen').toBe(0);

    // The tall state.
    const tell = page.getByRole('button', { name: 'Tell somebody' });
    await expect(async () => {
      await tell.click();
      await expect(page.getByRole('button', { name: 'Start Lifeline' })).toBeAttached({
        timeout: 1_000,
      });
    }).toPass({ timeout: 60_000 });

    await primaryOnScreen(page, 'Start recording');
    const open = await survey(page);
    expect(open.counted).toBeGreaterThan(shut.counted);
    expect(open.stranded, 'controls stranded with the Lifeline form open').toEqual([]);
    expect(open.pageScrollY).toBe(0);
    expect(open.headerTop, 'the header was dragged off screen').toBe(0);
  });

  /**
   * The same claim in the live phases, from a scrolled readout — the test above only sees
   * `idle` at scroll zero, the one configuration in which nothing can be wrong. Geometry is
   * measured against the scrollport, not the viewport: `overflow-y-auto` clips its children,
   * so an element can sit inside the window and be painted nowhere.
   */
  test('the recorder keeps its instrument and its alerts on the glass once recording', async ({
    signedInPage: page,
  }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.context().grantPermissions(['geolocation']);
    await page.context().setGeolocation(TRAILHEAD);
    await page.goto('/record', { waitUntil: 'domcontentloaded' });
    await settled(page);

    // Pressed from a scrolled column, because choosing anything but Hiking is below the fold here.
    await page.getByRole('button', { name: 'Trail running' }).scrollIntoViewIfNeeded();
    await expect(async () => {
      await page.getByRole('button', { name: 'Trail running' }).click();
      await expect(page.getByRole('button', { name: 'Trail running' })).toHaveAttribute(
        'aria-pressed',
        'true',
        { timeout: 1_000 },
      );
    }).toPass({ timeout: 60_000 });

    // Left where a reader who looked below the fold leaves it; nothing scrolls back on its own.
    const scrolled = await page.evaluate(() => {
      const port = document.querySelector('main .overflow-y-auto');
      if (!(port instanceof HTMLElement)) return -1;
      port.scrollTop = port.scrollHeight;
      return port.scrollTop;
    });
    expect(
      scrolled,
      'the readout does not scroll at 320px, so this proves nothing',
    ).toBeGreaterThan(0);

    await page.getByRole('button', { name: 'Start recording' }).click();
    // `locating` becomes `recording` on the first fix good enough to trust. Nudged, because a
    // watch that has already delivered its one mocked position will not deliver another.
    await expect(async () => {
      await page.context().setGeolocation({
        latitude: TRAILHEAD.latitude + Math.random() / 10_000,
        longitude: TRAILHEAD.longitude + Math.random() / 10_000,
      });
      await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible({
        timeout: 1_000,
      });
    }).toPass({ timeout: 60_000 });

    // The primary control for this phase and the signature instrument, both without scrolling.
    await primaryOnScreen(page, 'Pause');
    await primaryOnScreen(page, 'Finish');
    const distance = await onGlass(page, '.collar', 'Distance');
    expect(
      distance,
      'the distance gauge is not fully on screen when a hike begins',
    ).toBeGreaterThan(80);

    const recording = await survey(page);
    expect(recording.stranded, 'controls stranded while recording').toEqual([]);
    expect(recording.pageScrollY).toBe(0);
    expect(recording.headerTop, 'the header was dragged off screen').toBe(0);

    // Paused is the phase a restored recording comes back in, and it swaps the primary control.
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await primaryOnScreen(page, 'Resume');
    const paused = await survey(page);
    expect(paused.stranded, 'controls stranded while paused').toEqual([]);
  });

  /**
   * The off-route banner and the finish receipt: the two things that actually rendered at zero
   * percent visible, and neither is entered anywhere else in the suite. The recording test
   * above measures the distance gauge, which is the first item in the column and so the least
   * likely thing to be clipped.
   */
  test('the wrong-turn alert is on the glass from a scrolled readout', async ({
    signedInPage: page,
  }) => {
    // The wait below is allowed 150 s against a 120 s per-test budget from `playwright.config.ts`.
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 320, height: 568 });
    await page.context().grantPermissions(['geolocation']);
    await page.context().setGeolocation(TRAILHEAD);
    // With the trail, because the watchdog needs a route to be off.
    await page.goto(`/record?trail=${VESPER.slug}`, { waitUntil: 'domcontentloaded' });
    await settled(page);

    await beginRecording(page, TRAILHEAD);
    expect(
      await scrollReadoutToBottom(page),
      'the readout does not scroll at 320px, so this proves nothing',
    ).toBeGreaterThan(0);

    /*
     * About a kilometre off the line, and held there. `DEFAULT_OFF_ROUTE_CONFIG` wants three
     * consecutive fixes over at least forty-five seconds, so this nudges the position until
     * the banner arrives rather than sleeping: each nudge is what makes a new fix arrive.
     */
    const banner = page.getByRole('alert').filter({ hasText: 'Off route' });
    await expect(async () => {
      await page.context().setGeolocation({
        latitude: TRAILHEAD.latitude + 0.01 + Math.random() / 100_000,
        longitude: TRAILHEAD.longitude + 0.01 + Math.random() / 100_000,
      });
      await expect(banner).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 150_000 });

    // Present is not the claim; painted is.
    const visible = await onGlass(page, '[role="alert"]', 'Off route');
    expect(visible, 'the wrong-turn alert is clipped by its own scrollport').toBeGreaterThan(80);
  });

  test('the receipt for a hike finished with no connection is on the glass, and takes focus', async ({
    signedInPage: page,
  }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.context().grantPermissions(['geolocation']);
    await page.context().setGeolocation(TRAILHEAD);
    await page.goto('/record', { waitUntil: 'domcontentloaded' });
    await settled(page);

    await beginRecording(page, TRAILHEAD);
    expect(
      await scrollReadoutToBottom(page),
      'the readout does not scroll at 320px, so this proves nothing',
    ).toBeGreaterThan(0);

    // No bars: `finish` cannot reach the server, so the hike is written to the device and the
    // receipt is the only thing that says where it went.
    await page.context().setOffline(true);
    try {
      await page.getByRole('button', { name: 'Finish', exact: true }).click();
      await page.getByRole('button', { name: 'Save hike' }).click();

      await expect(page.getByText('Saved on this device')).toBeVisible({ timeout: 60_000 });
      const visible = await onGlass(page, '[role="status"]', 'Saved on this device');
      expect(visible, 'the finish receipt is clipped by its own scrollport').toBeGreaterThan(80);

      // The one ending that does not navigate: the dialog unmounts while its opener is replaced
      // on the ledge, which otherwise drops the caret to `<body>` with nothing said.
      const landed = await page.evaluate(
        () => document.activeElement?.getAttribute('role') ?? document.activeElement?.tagName ?? '',
      );
      expect(landed, 'focus was dropped when the hike was saved').toBe('status');
    } finally {
      await page.context().setOffline(false);
    }
  });
});
