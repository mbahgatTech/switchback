import { AxeBuilder } from '@axe-core/playwright';
import type { Result } from 'axe-core';
import type { Page, TestInfo } from '@playwright/test';
import { SHEET_AT_VESPER, VESPER, expect, expectTrailsLanded, sheetOf, test } from './fixtures';

/**
 * The accessibility gate.
 *
 * The plan names "Lighthouse PWA + a11y ≥ 95" as a quality gate and nothing in this repo
 * implemented it. This is that gate, built the way it should have been in the first place.
 *
 * **Why axe rather than a Lighthouse score.** Lighthouse's accessibility category *is* axe —
 * it runs axe-core, then converts the pass/fail list into a weighted number. Everything in
 * the number comes from here; the number itself adds a threshold that behaves badly as a
 * gate. A page with one serious violation can score 96 and pass, and a page that grows two
 * new elements can drop below 95 without any new defect. Worse, a score is a thing you
 * screenshot once, whereas this runs on every `npm run test:e2e` and names the element.
 *
 * So the bar here is stricter than the plan asked for: **zero** WCAG 2.1 A/AA violations on
 * every route, not a score above ninety-five.
 *
 * **What this cannot see.** Axe finds machine-checkable failures — contrast, names, roles,
 * order, labelling. Roughly half of WCAG is judgement no tool can make: whether alt text
 * says the right thing, whether focus order matches reading order, whether an error message
 * is actually actionable. A green run here is a floor, not a certificate. The judgement half
 * is what the `impeccable` finish reviews are for.
 */

/**
 * The conformance target: WCAG 2.1, levels A and AA.
 *
 * AA is the level every accessibility regulation in the world actually cites, and 2.1 is the
 * version that added the criteria a *trail* app leans on hardest — reflow, non-text contrast,
 * and pointer target size all come from 2.1 and all matter on a phone held at arm's length in
 * bad light. AAA is deliberately not here: it requires 7:1 body contrast, which no map chrome
 * on earth satisfies, and gating on a level even the W3C says is not achievable site-wide
 * would mean permanently ignoring the result.
 *
 * `best-practice` is excluded from the gate for a different reason: those rules encode axe's
 * house opinions rather than the standard, and a gate should fail on the standard.
 */
const WCAG_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/**
 * One line per failing element, which is what a person fixing this needs.
 *
 * Axe returns a violation per *rule* with the offending nodes nested inside it, so the
 * obvious `expect(violations).toEqual([])` prints one entry no matter how many elements are
 * wrong and buries the selectors in a JSON tree Playwright truncates. Flattening to a node
 * per line means the assertion diff is the fix list: rule, severity, selector, and the
 * specific reason this element failed — a contrast ratio, a missing name.
 */
function eachFailure(violations: Result[]): string[] {
  return violations.flatMap((violation) =>
    violation.nodes.map((node) => {
      const where = node.target.join(' ');
      // `failureSummary` opens with "Fix any of the following:" and then lists the reasons
      // one per line. The preamble is noise repeated on every row; the reasons are the part
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
 * Audit whatever is currently on screen.
 *
 * The full axe result is attached to the report rather than printed. It carries the passes
 * and the incomplete checks as well as the failures, which is the difference between "no
 * violations" and "no violations *and* the contrast rule actually ran" — a rule that errored
 * out is reported as incomplete, and a gate that could not tell those apart would go green
 * the day axe stopped working.
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

/**
 * Wait for the page to mean something before auditing it.
 *
 * Auditing a skeleton audits the skeleton. Every route here renders its `<h1>` from the
 * server, so the heading arriving is the cheapest honest signal that the real document is on
 * screen — and if a route ever loses its `<h1>` this fails loudly here rather than quietly
 * passing an audit of a spinner.
 */
async function settled(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 60_000 });
}

/**
 * Every control and figure on the page, scrolled into view inside whatever box owns it, and
 * whichever of them still ended up outside the window.
 *
 * The page itself must not have moved: a browser will programmatically scroll an
 * `overflow:hidden` box, and doing that on this screen drags the wordmark and the map off the
 * top with no gesture that brings them back.
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
    // Controls and figures both: a statistic you cannot get to is as broken as a button
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
 *
 * The distinction is the whole point. `overflow-y-auto` clips its children, so an element can
 * be inside the viewport and painted nowhere — which is exactly how an alert inserted at the
 * top of a scrolled readout fails. A viewport-only check passes on all of them.
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
 * The routes, and what each one is here to cover.
 *
 * Not every page in the app — `/u/[username]`, `/lists/[key]`, `/activities/[id]` and
 * `/routes/[id]` are built from the same components as their index pages and would audit the
 * same markup twice. These eleven are the distinct *shapes*: a list of nearby trails, a dense
 * data page, two live-instrument pages, four list pages, a form, and two static documents.
 *
 * `/` is deliberately not among them. It is the map now, and `settled()` is the wrong wait for
 * it: the shell's `<h1>` is `sr-only`, which Playwright still counts as visible, so an audit
 * would run against a sheet whose index is empty and report a clean page having read almost
 * none of it. The map is audited by its own test below, on the state a hiker actually reads.
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

  /**
   * The map sheet, audited with trails actually on it.
   *
   * This one gets its own test because `settled` is the wrong wait here: the sheet paints its
   * chrome long before the tile query lands, and an audit run in that window would check an
   * empty index and miss every trail row — which is most of the page's interactive content.
   * `expectTrailsLanded` reads the same `data-trails` attribute the rest of the suite trusts,
   * so this audits the sheet in the state a hiker actually reads.
   */
  test('the map sheet has no WCAG A/AA violations', async ({ signedInPage: page }, info) => {
    await page.goto(SHEET_AT_VESPER, { waitUntil: 'domcontentloaded' });
    await expectTrailsLanded(sheetOf(page));
    await audit(page, info);
  });

  /**
   * Signed out, which is a different page rather than the same page with fewer buttons.
   *
   * The header swaps the account menu for a sign-in link, the trail page swaps every save
   * control for a prompt, and none of that markup is exercised by the signed-in runs above.
   * `/signin` itself is only reachable in this state — signed in it redirects.
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

  /**
   * The report form, open.
   *
   * Forms are where accessibility is won or lost — a label that names nothing, a rating built
   * from radios with no group name, an error a screen reader never hears — and every one of
   * those defects is invisible to an audit of the page that has the form closed behind a
   * button. This opens it and audits the state a hiker types into.
   *
   * The click is retried for the reason documented at length in `review.spec.ts`: it is the
   * first interaction on the page, the button is server-rendered, and a click that lands
   * before React attaches its handler is swallowed in silence.
   */
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
   * The navigation, open, on the narrowest phone this product supports.
   *
   * Every audit above runs at the default viewport, where the nav is a plain row of links and
   * the disclosure is `display:none` — which means axe has never seen the panel's markup. The
   * failures this catches are the ones a disclosure actually ships with: a trigger with no
   * accessible name, an `aria-controls` pointing at nothing, muted collar text on a panel it
   * does not have the contrast for.
   *
   * The Escape and focus assertions are functional rather than axe's business, and they belong
   * here anyway: this is the only spec in the suite that opens the menu, and a disclosure whose
   * Escape handling is untested is a disclosure whose Escape handling regresses.
   */
  test('the navigation index has no WCAG A/AA violations at 320px', async ({
    signedInPage: page,
  }, info) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto('/lists', { waitUntil: 'domcontentloaded' });
    await settled(page);

    const index = page.getByRole('button', { name: 'Index' });
    const panel = page.locator('#site-nav-menu');
    // Retried for the reason given on the report form above: first interaction on the page,
    // server-rendered button, a click landing before hydration is swallowed in silence.
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
   * The same, on the neatline that has to carry the ODbL credit as well.
   *
   * The first assertion is the one worth stating plainly, because the suite previously
   * documented the opposite: the map does **not** keep MapLibre's own attribution control.
   * `map/trail-map.tsx` sets `attributionControl: false`, as do `plan-map.tsx` and
   * `record-map.tsx`, so the link in the page is the entire credit for the screen. There is no
   * second copy on the canvas to make hiding this one safe, which is why the credit rides the
   * nav's `beside` slot — outside the fold — and why the check here is that it is on screen
   * with the panel still shut.
   *
   * The panel-scoped locator that follows is scoped for a different reason than it used to be:
   * outside the panel there is now a credit reading "© OSM" at this width, so an unscoped
   * `/OpenStreetMap/` still matches one element but the intent is to assert the long form is
   * the one behind the disclosure.
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
   * The recorder, on the narrowest phone this product supports — reachability, not axe.
   *
   * This is the one shape axe cannot see. `/record` is a full-screen instrument: the shell is
   * `h-dvh overflow-hidden`, which is correct, and it means a readout column taller than the
   * window is not scrollable by any gesture at all. Every control still has a name, a role and
   * enough contrast, so an audit passes — and "Start recording" sits below the bottom of the
   * phone with no way to reach it. That is a WCAG 2.1 reflow failure (1.4.10: content must not
   * require scrolling in two dimensions, and must not be *lost*) and it is invisible to a rule
   * engine, so it is asserted here by geometry.
   *
   * Two claims, and they are different:
   *
   * 1. **Everything is reachable.** After `scrollIntoView` inside whatever scroll container it
   *    belongs to, every control and every collar-labelled figure is inside the viewport — and
   *    the page itself has not moved. The second half matters: before the fix the column *was*
   *    reachable by keyboard, because a browser will programmatically scroll an
   *    `overflow:hidden` box, and doing so dragged the wordmark and the map off the top of the
   *    screen with no gesture that could bring them back.
   * 2. **The primary action needs no scroll at all.** A hiker reaching for Finish in weather
   *    should not have to find it first. It is on the ledge, at a fixed place on the glass.
   *
   * Run with the Lifeline's setup form open as well as shut, because that form is the tallest
   * thing the column ever holds and is what strands controls on a desktop window too.
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

    // The tall state. Retried for the reason given on the navigation test above: a click that
    // lands before hydration is swallowed in silence.
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
   * The same claim, in the phases a hiker is actually in.
   *
   * The test above only ever sees `idle`, with the readout at scroll zero — which is the one
   * configuration in which nothing can be wrong. Everything that goes wrong on this screen
   * goes wrong in the other four phases, and all of it needs the readout to have been
   * scrolled, which is not an edge case: at 320px, five of the fourteen targets in the
   * recording phase are below the fold, so reading your GPS accuracy or reaching the Lifeline
   * means scrolling, and nothing scrolls back on its own.
   *
   * The second assertion is the one a viewport check cannot make. `overflow-y-auto` clips its
   * children, so an element can sit inside the window and be nowhere on the glass — measured
   * at top −430 against a scrollport of 276–487. So the geometry here is against the
   * scrollport's own box, not the viewport's.
   */
  test('the recorder keeps its instrument and its alerts on the glass once recording', async ({
    signedInPage: page,
  }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.context().grantPermissions(['geolocation']);
    await page.context().setGeolocation(TRAILHEAD);
    await page.goto('/record', { waitUntil: 'domcontentloaded' });
    await settled(page);

    // The press that begins a hike, made from a scrolled column — which is where it is made
    // in practice, because choosing anything but Hiking is below the fold at this width.
    await page.getByRole('button', { name: 'Trail running' }).scrollIntoViewIfNeeded();
    await expect(async () => {
      await page.getByRole('button', { name: 'Trail running' }).click();
      await expect(page.getByRole('button', { name: 'Trail running' })).toHaveAttribute(
        'aria-pressed',
        'true',
        { timeout: 1_000 },
      );
    }).toPass({ timeout: 60_000 });

    // Left where a reader who has looked at anything below the fold leaves it. Nothing on this
    // screen scrolls back on its own, so this is the ordinary state of the column, not a
    // contrived one — and it is the state every failure here needs.
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

    // The primary control for this phase, and the signature instrument, both without scrolling.
    // The instrument is measured against the scrollport rather than the window: a viewport
    // check passes on an element the scrollport has clipped to nothing.
    await primaryOnScreen(page, 'Pause');
    await primaryOnScreen(page, 'Finish');
    const distance = await onGlass(page, '.collar', 'Distance');
    expect(distance, 'the distance gauge is not on screen when a hike begins').toBeGreaterThan(0);

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
});
