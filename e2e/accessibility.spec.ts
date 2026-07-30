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
});
