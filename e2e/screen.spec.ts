import { expect, type Locator, type Page, test } from '@playwright/test';

const WEEKEND = "I'm away for the weekend, set the house to away.";
const DISHWASHER = "Run the dishwasher at 2 AM when power's cheap.";

const view = (page: Page) => page.frameLocator('.view iframe');
const said = (page: Page) => page.locator('.caption .said');

/** The demo controls sit in a drawer beside the house; without the house they're under the device. */
async function openControls(page: Page) {
  await expect(page.getByLabel('Say something')).toBeAttached();
  const handle = page.getByRole('button', { name: 'Demo controls', exact: true });
  if (await handle.isVisible()) await handle.click();
  await expect(page.getByLabel('Say something')).toBeVisible();
}

/**
 * Tap a control in the plan view with the pointer, as a person would. Beside the house the device is
 * zoomed out to fit, and Playwright places clicks inside a zoomed frame as if it weren't, so this
 * clicks where the control really shows and leaves the browser to decide what's there.
 */
async function tap(page: Page, control: Locator) {
  await expect(control).toBeVisible();
  const frame = page.locator('.view iframe');
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

/** The house's overlay, which says whether a plan is playing in the shadow twin. */
const playing = (page: Page) => page.locator('.pins');

async function say(page: Page, text: string) {
  await openControls(page);
  await page.getByLabel('Say something').fill(text);
  await page.getByRole('button', { name: 'Say it' }).click();
}

test.describe.configure({ mode: 'serial' });

test('the house is drawn beside the device, and house-only mode is remembered', async ({
  page,
}) => {
  await page.goto('/');
  const house = page.getByRole('region', { name: 'The house' });
  const device = page.getByRole('region', { name: 'The device' });
  await expect(house.locator('canvas')).toBeVisible();
  await expect(house.getByRole('heading', { name: 'Cedar Hollow' })).toBeVisible();
  await expect(house.locator('.room-label', { hasText: 'Garage' })).toBeVisible();
  await expect(house.getByText(/^Friday, \d+:\d\d PM$/)).toBeVisible();
  await expect(device.getByText('Home mode')).toBeVisible();
  await page.screenshot({ path: 'test-results/house-split.png' });

  await house.getByRole('button', { name: 'House only' }).click();
  await expect(device).toBeHidden();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Show the device' })).toBeVisible();
  await expect(device).toBeHidden();
  await page.screenshot({ path: 'test-results/house-only.png' });

  await page.getByRole('button', { name: 'Show the device' }).click();
  await expect(device.getByText('Home mode')).toBeVisible();
});

test('without WebGL the house steps aside and the device works as before', async ({ page }) => {
  await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      kind: string,
      ...rest: unknown[]
    ) {
      return /webgl/i.test(kind) ? null : getContext.call(this, kind, ...(rest as []));
    } as typeof getContext;
  });
  await page.goto('/');
  await expect(page.getByText('Home mode')).toBeVisible();
  await expect(page.getByRole('region', { name: 'The house' })).toHaveCount(0);
  await expect(page.locator('canvas')).toHaveCount(0);
  // No drawer: the controls are under the device, as before.
  await expect(page.getByRole('button', { name: /demo controls/i })).toHaveCount(0);
  await expect(page.getByLabel('Say something')).toBeVisible();
  await page.getByRole('button', { name: WEEKEND }).click();
  await expect(view(page).getByText('UNSAFE', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/no-webgl.png' });
});

// The house's code (three.js and the scene) arrives in its own chunk after the page, then its
// models; either can fail on a flaky network or across a deploy.
for (const [what, url] of [
  ['its code', /src_house_House_tsx/],
  ['its models', /\/house\/models\//],
] as const) {
  test(`if the house can't load ${what}, the device carries on alone`, async ({ page }) => {
    let blocked = 0;
    await page.route(url, (route) => {
      blocked += 1;
      return route.abort();
    });
    await page.goto('/');
    await expect(page.getByText('Home mode')).toBeVisible();
    await expect(page.getByRole('region', { name: 'The house' })).toHaveCount(0);
    expect(blocked).toBeGreaterThan(0);
    await page.getByRole('button', { name: WEEKEND }).click();
    await expect(view(page).getByText('UNSAFE', { exact: true })).toBeVisible();
  });
}

test('a checked plan plays forward in the house, then the plan with its fixes', async ({
  page,
}) => {
  await page.goto('/');
  await openControls(page);
  await page.getByRole('button', { name: WEEKEND }).click();
  const house = page.getByRole('region', { name: 'The house' });
  await expect(playing(page)).toHaveAttribute('data-playing', 'yes');
  // The engine's own run: R3 breaks where the preview says, with its words and whose rule it is,
  // on the house's card while the playback stops there.
  const r3 = house
    .getByRole('status')
    .filter({ hasText: 'R3 breaks Sat 10:37 PM' })
    .filter({ hasText: "Don't let the garage pipes freeze." })
    .filter({ hasText: 'Om’s rule' });
  await expect(r3).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: 'test-results/house-r3.png' });
  // Then the same plan with its fixes, to the end of the weekend.
  const fixes = house.getByRole('button', { name: 'With 4 fixes' });
  await expect(fixes).toBeVisible({ timeout: 30_000 });
  await expect(house.locator('.run-chip')).toHaveAttribute('data-run', 'fixed');
  await expect(house.getByText(/^Sunday, 6:00 PM$/)).toBeVisible();
  await page.screenshot({ path: 'test-results/house-fixed.png' });
  // Either run can be played again.
  await house.getByRole('button', { name: 'Your plan' }).click();
  await expect(house.locator('.run-chip')).toHaveAttribute('data-run', 'plan');
  // Cancel on the screen: nothing changes, and the house goes back to the home as it is.
  await tap(page, view(page).getByRole('button', { name: /^Cancel/ }));
  await expect(playing(page)).toHaveAttribute('data-playing', 'no');
});

test('with less motion, the house shows where each run ends, without the sweep', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  // House only, where a run that ends with several broken rules lists them in the house’s card.
  await page.addInitScript(() => {
    // The plan view's sandboxed frame has no storage; only the page needs this.
    try {
      localStorage.setItem('shadow-home/layout', 'house');
    } catch {}
  });
  await page.goto('/');
  await openControls(page);
  await page.getByRole('button', { name: WEEKEND }).click();
  const house = page.getByRole('region', { name: 'The house' });
  // The plan's end at once, with every rule it breaks.
  await expect(house.getByRole('button', { name: 'With 4 fixes' })).toBeVisible({
    timeout: 10_000,
  });
  await expect(house.locator('.run-chip')).toHaveAttribute('data-run', 'plan');
  await expect(house.getByRole('status')).toHaveCount(4);
  await house.getByRole('button', { name: 'With 4 fixes' }).click();
  await expect(house.locator('.run-chip')).toHaveAttribute('data-run', 'fixed');
  await expect(house.getByRole('status')).toHaveCount(0);
  await house.getByRole('button', { name: 'Show the device' }).click();
  await tap(page, view(page).getByRole('button', { name: /^Cancel/ }));
  await expect(playing(page)).toHaveAttribute('data-playing', 'no');
});

test('a home state the page doesn’t expect hides the house, and the device carries on', async ({
  page,
}) => {
  // The first reading of the home is real; every later one comes back malformed.
  let readings = 0;
  await page.route('**/mcp', async (route) => {
    const body = route.request().postData() ?? '';
    if (route.request().method() === 'POST' && body.includes('get_home_state') && ++readings > 1) {
      const { id } = JSON.parse(body) as { id: number };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: '?' }], structuredContent: { zones: 'warm' } },
        }),
      });
      return;
    }
    await route.continue();
  });
  await page.goto('/');
  const house = page.getByRole('region', { name: 'The house' });
  await expect(house.locator('canvas')).toBeVisible();
  await openControls(page);
  await page.getByRole('button', { name: WEEKEND }).click();
  await expect(view(page).getByText('UNSAFE', { exact: true })).toBeVisible();
  await expect(house).toHaveCount(0);
  // The device keeps the last good home.
  await page.getByRole('button', { name: 'Home screen' }).click();
  await expect(page.getByText('Home mode')).toBeVisible();
});

test('a preview_plan call shows the diff and the garage temperature on the screen', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByText('Home mode')).toBeVisible();
  await openControls(page);
  await page.getByRole('button', { name: WEEKEND }).click();

  const v = view(page);
  await expect(v.getByText('UNSAFE', { exact: true })).toBeVisible();
  await expect(
    v.getByRole('heading', { name: 'Blocked: that breaks 4 house rules.' }),
  ).toBeVisible();
  await expect(v.getByRole('heading', { name: 'With 4 fixes' })).toBeVisible();
  const rows = await v.locator('.row').count();
  expect(rows).toBeGreaterThan(0);
  expect(rows).toBeLessThanOrEqual(5);
  await expect(v.getByText('Freezer stays on', { exact: true })).toBeVisible();
  await expect(v.locator('.card')).toHaveCount(4);
  await expect(v.getByText('Breaks Sat 10:37 PM')).toBeVisible();
  // The garage's temperature, where R3 matters: it crosses 4 °C then, and the fixes hold it.
  const garage = v.getByRole('img', { name: 'Garage temperature' });
  await expect(garage).toBeVisible();
  await expect(garage.getByText('Sat 10:37 PM', { exact: true })).toBeVisible();
  await expect(garage.getByText('With 4 fixes', { exact: true })).toBeVisible();
  await expect(garage.getByText('Your plan', { exact: true })).toBeVisible();
  await expect(v.getByRole('button', { name: /Do it with 4 fixes\s*Say “yes”/ })).toBeVisible();
  await expect(said(page)).toHaveText(
    "Blocked: that breaks 4 house rules. No coffee maker running when nobody's home. That's Om's rule. Do it with 4 fixes instead?",
  );
  await page.screenshot({ path: 'test-results/weekend-preview.png' });

  // A tap is the yes: the repair commits, and the screen offers to undo it.
  await tap(page, v.getByRole('button', { name: /Do it with 4 fixes/ }));
  await expect(v.getByText('DONE', { exact: true })).toBeVisible();
  await expect(said(page)).toContainText('Done');
  await page.screenshot({ path: 'test-results/weekend-done.png' });

  await tap(page, v.getByRole('button', { name: /^Undo/ }));
  await expect(v.getByRole('heading', { name: 'Putting back' })).toBeVisible();
  // Undoing unlocks the front door again, so the undo itself needs a yes (T2).
  const yes = v.getByRole('button', { name: /Yes, undo it\s*Say “yes”/ });
  await expect(yes).toBeVisible();
  // It puts the garage heater back, so the garage is drawn again: holding, nothing marked.
  const held = v.getByRole('img', { name: 'Garage temperature' });
  await expect(held).toBeVisible();
  await expect(held.locator('.curve.held')).toHaveCount(1);
  await expect(held.locator('.break')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/weekend-undo.png' });

  // The tap is that yes: the view approves with the token only the screen has, then commits.
  await tap(page, yes);
  await expect(v.getByText('DONE', { exact: true })).toBeVisible();
  await expect(v.getByText('Front door lock unlocked', { exact: true })).toBeVisible();
});

test('saying it does what tapping does: a yes by voice commits what the screen asked', async ({
  page,
}) => {
  await page.goto('/');
  await say(page, DISHWASHER);
  const v = view(page);
  await expect(v.getByText('UNPROVEN', { exact: true })).toBeVisible();
  await expect(v.getByRole('button', { name: /Run it anyway\s*Say “yes”/ })).toBeVisible();
  // No temperature rule is involved, so the timeline is drawn instead.
  await expect(v.getByRole('img', { name: 'Timeline' })).toBeVisible();
  await expect(v.getByRole('img', { name: 'Garage temperature' })).toHaveCount(0);
  await page.screenshot({ path: 'test-results/dishwasher-preview.png' });

  await say(page, 'yes');
  await expect(v.getByText('DONE', { exact: true })).toBeVisible();
  // Held for 2 AM, so it shows as a later change that can still be undone.
  await expect(v.getByRole('heading', { name: 'Scheduled: Dishwasher on.' })).toBeVisible();
  await expect(v.locator('.chip.later', { hasText: 'Dishwasher on' })).toBeVisible();
  await page.screenshot({ path: 'test-results/dishwasher-done.png' });
});

test('the whole demo script plays in demo mode, with no manual steps', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/');
  await openControls(page);
  await page.getByRole('button', { name: 'Play the demo' }).click();
  await expect(page.getByText('Demo finished.')).toBeVisible({ timeout: 150_000 });
  const lines = await page
    .getByRole('list', { name: 'Conversation' })
    .locator('li')
    .allInnerTexts();
  const alexa = lines.filter((l) => l.startsWith('Alexa')).map((l) => l.replace(/^Alexa\s*/, ''));
  // Friday: blocked, then done with the fixes. The dishwasher can't be confirmed; no.
  expect(alexa[0]).toMatch(/^Blocked: that breaks 4 house rules\..*Do it with 4 fixes instead\?$/);
  expect(alexa[1]).toBe('Done: 10 changes.');
  expect(alexa[2]).toMatch(/^I can't confirm that's safe\..*Run it anyway\?$/);
  expect(alexa[3]).toBe('Okay, nothing changed.');
  // The new rule loses to the smoke rule.
  expect(alexa[4]).toBe('Rule added. It clashes with R6; R6 wins by priority.');
  // Sunday evening, without a manual step: the log, then the thermostat put back.
  expect(alexa[5]).toMatch(/^Here's what changed: I'm away for the weekend/);
  expect(alexa[6]).toMatch(/^Safe: Main thermostat to 20 °C\./);
  expect(alexa[7]).toBe('Done: Main thermostat to 20 °C.');
  // Monday morning, heading out: Coffee at 7 has the coffee maker on, and a yes switches it off.
  expect(alexa[8]).toBe(
    "Before you go: Coffee maker on. No coffee maker running when nobody's home. That's Om's rule. Shall I fix it?",
  );
  expect(alexa[9]).toBe('Done: Coffee maker off.');
  await expect(page.getByText(/^Mon \d+:\d\d AM$/)).toBeVisible();
  await page.screenshot({ path: 'test-results/demo-finished.png' });
});
