import { expect, test } from '@playwright/test';

const WEEKEND = "I'm away for the weekend, set the house to away.";
const VIOLATION = 'Content policy violation:';

test('every response carries the security headers, and no X-Powered-By', async ({ request }) => {
  for (const path of ['/', '/api/turn']) {
    const headers = (await request.get(path)).headers();
    expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['permissions-policy']).toContain('microphone=(self)');
    expect(headers['x-powered-by']).toBeUndefined();
  }
});

test('the screen and the plan view in its frame break nothing in the content policy', async ({
  page,
}) => {
  const violations: string[] = [];
  page.on('console', (m) => {
    if (m.text().startsWith(VIOLATION)) violations.push(m.text());
  });
  // Runs in every frame, the plan view's srcdoc frame too, which takes the page's policy.
  await page.addInitScript((prefix) => {
    document.addEventListener('securitypolicyviolation', (e) =>
      console.error(`${prefix} ${e.effectiveDirective} ${e.blockedURI}`),
    );
  }, VIOLATION);

  await page.goto('/');
  await page.getByLabel('Say something').fill(WEEKEND);
  await page.getByRole('button', { name: 'Say it' }).click();
  const view = page.frameLocator('.view iframe');
  await expect(view.getByText('UNSAFE', { exact: true })).toBeVisible();
  await expect(view.getByRole('img', { name: 'Garage temperature' })).toBeVisible();
  expect(violations).toEqual([]);
});
