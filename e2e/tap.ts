import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Tap a control in the plan view with the pointer, as a person would. Beside the house the device is
 * zoomed out to fit, and Playwright places clicks inside a zoomed frame as if it weren't, so this
 * clicks where the control really shows and leaves the browser to decide what's there.
 */
export async function tap(page: Page, control: Locator) {
  await expect(control).toBeVisible();
  const frame = page.locator('.view iframe');
  // Just after a layout change the device is still being zoomed to its new room: measure once it
  // holds still, or the tap lands where the control was.
  let before = '';
  await expect
    .poll(
      async () => {
        const now = JSON.stringify(await frame.boundingBox());
        const still = now === before;
        before = now;
        return still;
      },
      { intervals: [150] },
    )
    .toBe(true);
  const box = await frame.boundingBox();
  if (!box) throw new Error('The plan view is not on screen.');
  const scale = await frame.evaluate(
    (el) => el.getBoundingClientRect().width / (el as HTMLElement).offsetWidth,
  );
  const at = await control.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  const x = box.x + at.x * scale;
  const y = box.y + at.y * scale;
  // Nothing covers the control: the view is on top there on the page, and the control in the view.
  const onPage = await page.evaluate((p) => document.elementFromPoint(p.x, p.y)?.tagName, { x, y });
  expect(onPage, 'what the page has at the tap').toBe('IFRAME');
  const inView = await control.evaluate((el, p) => {
    const hit = el.ownerDocument.elementFromPoint(p.x, p.y);
    return hit !== null && el.contains(hit);
  }, at);
  expect(inView, 'the control is what the view has at the tap').toBe(true);
  await page.mouse.click(x, y);
}
