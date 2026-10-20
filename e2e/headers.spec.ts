import { expect, test } from '@playwright/test';

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
