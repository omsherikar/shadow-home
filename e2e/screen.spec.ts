import { expect, type Page, test } from '@playwright/test';

const WEEKEND = "I'm away for the weekend, set the house to away.";
const DISHWASHER = "Run the dishwasher at 2 AM when power's cheap.";

const view = (page: Page) => page.frameLocator('.view iframe');
const said = (page: Page) => page.locator('.caption .said');

async function say(page: Page, text: string) {
  await page.getByLabel('Say something').fill(text);
  await page.getByRole('button', { name: 'Say it' }).click();
}

test.describe.configure({ mode: 'serial' });

test('a preview_plan call shows the diff and timeline on the screen', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Home mode')).toBeVisible();
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
  await expect(v.getByRole('img', { name: 'Timeline' })).toBeVisible();
  await expect(v.getByRole('button', { name: /Do it with 4 fixes\s*Say “yes”/ })).toBeVisible();
  await expect(said(page)).toHaveText(
    "Blocked: that breaks 4 house rules. No coffee maker running when nobody's home. That's Om's rule. Do it with 4 fixes instead?",
  );
  await page.screenshot({ path: 'test-results/weekend-preview.png' });

  // A tap is the yes: the repair commits, and the screen offers to undo it.
  await v.getByRole('button', { name: /Do it with 4 fixes/ }).click();
  await expect(v.getByText('DONE', { exact: true })).toBeVisible();
  await expect(said(page)).toContainText('Done');
  await page.screenshot({ path: 'test-results/weekend-done.png' });

  await v.getByRole('button', { name: /^Undo/ }).click();
  await expect(v.getByRole('heading', { name: 'Putting back' })).toBeVisible();
  // Undoing unlocks the front door again, so the undo itself needs a yes (T2).
  const yes = v.getByRole('button', { name: /Yes, undo it\s*Say “yes”/ });
  await expect(yes).toBeVisible();
  await page.screenshot({ path: 'test-results/weekend-undo.png' });

  // The tap is that yes: the view approves with the token only the screen has, then commits.
  await yes.click();
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
  await page.screenshot({ path: 'test-results/dishwasher-preview.png' });

  await say(page, 'yes');
  await expect(v.getByText('DONE', { exact: true })).toBeVisible();
  // Held for 2 AM, so it shows as a later change that can still be undone.
  await expect(v.getByRole('heading', { name: 'Scheduled: Dishwasher on.' })).toBeVisible();
  await expect(v.locator('.chip.later', { hasText: 'Dishwasher on' })).toBeVisible();
  await page.screenshot({ path: 'test-results/dishwasher-done.png' });
});
