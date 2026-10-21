import { expect, type Page, test } from '@playwright/test';

const WEEKEND = "I'm away for the weekend, set the house to away.";

const composer = (page: Page) => page.getByLabel('Say something to Alexa');

test.describe.configure({ mode: 'serial' });

// Some of these change the home; the next test starts from the demo's own.
test.afterEach(async ({ request }) => {
  await request.post('/api/demo');
});

test('a first visit: the composer, what Alexa does, and requests to tap', async ({ page }) => {
  await page.goto('/');
  await expect(composer(page)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
  await expect(page.getByText(/^Ask me to change something at home\./)).toBeVisible();
  await expect(page.getByRole('button', { name: WEEKEND })).toBeVisible();
  // Nothing to open first: no drawer.
  await expect(page.getByRole('button', { name: /demo controls/i })).toHaveCount(0);
});
