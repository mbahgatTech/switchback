import type { Page } from '@playwright/test';
import { VESPER, expect, test } from './fixtures';

/**
 * The elevation graphic as a gesture surface. A press that begins on the plot used to put a
 * caret where the finger landed and start a selection with the same gesture, and a selection is
 * not bounded by the element it began in — so one press-and-drag swept the caption and the
 * stats below the graphic into a highlight instead of moving the cursor along the trail.
 *
 * Asserted in a real browser because `user-select` is the platform's, not ours: nothing below a
 * live selection model can say whether a drag selected anything.
 */

const CAPTION = /Hatching tightens as the ground steepens/u;

test.describe('The elevation graphic is a select-free zone', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`/trails/${VESPER.slug}`, { waitUntil: 'domcontentloaded' });
  });

  const selection = (page: Page) => page.evaluate(() => window.getSelection()?.toString() ?? '');

  test('a press-and-drag beginning on the plot selects nothing, on it or below it', async ({
    page,
  }) => {
    const plot = page.getByRole('slider', { name: 'Position along the trail' });
    await expect(plot).toBeVisible();
    const box = (await plot.boundingBox())!;
    const caption = page.getByText(CAPTION);
    const captionBox = (await caption.boundingBox())!;

    await page.mouse.move(box.x + box.width * 0.25, box.y + box.height / 2);
    await page.mouse.down();
    // A hold, not a click: the press is what used to drop the caret.
    await page.waitForTimeout(700);
    await page.mouse.move(box.x + box.width * 0.75, box.y + box.height / 2, { steps: 15 });
    // Down past the caption, which is the text the gesture used to drag into the highlight.
    await page.mouse.move(captionBox.x + captionBox.width * 0.8, captionBox.y + captionBox.height, {
      steps: 15,
    });
    await page.mouse.up();

    expect(await selection(page)).toBe('');
  });

  test('the same gesture over the prose beside it still selects, so only the plot is exempt', async ({
    page,
  }) => {
    const caption = page.getByText(CAPTION);
    await expect(caption).toBeVisible();
    const box = (await caption.boundingBox())!;

    await page.mouse.move(box.x + 4, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(700);
    await page.mouse.move(box.x + box.width - 4, box.y + box.height / 2, { steps: 15 });
    await page.mouse.up();

    // Without this the test above passes against a page that cannot select anything at all.
    expect(await selection(page)).not.toBe('');
  });
});
