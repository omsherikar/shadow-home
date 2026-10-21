import { expect, type Page, test } from '@playwright/test';

const WEEKEND = "I'm away for the weekend, set the house to away.";
const SENTENCES = [
  'Blocked: that breaks 4 house rules.',
  "No coffee maker running when nobody's home.",
  "That's Om's rule.",
  'Do it with 4 fixes instead?',
];

interface Heard {
  text: string;
  /** Whether the turn had ended (its `done` had reached the page) when this was asked for. */
  ended: boolean;
}

/**
 * Passes the turn route's own stream through (the scripted model's turn) but holds back its `done`
 * until the test lets it go, and notes each sentence the page asks /api/speak for, with whether
 * the turn had ended by then.
 */
async function holdTheEnd(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { releaseDone(): void; ended: boolean; heard: Heard[] };
    const real = window.fetch.bind(window);
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    w.releaseDone = () => release();
    w.ended = false;
    w.heard = [];
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/api/speak')) {
        w.heard.push({ text: JSON.parse(String(init?.body)).text, ended: w.ended });
        return real(input, init);
      }
      if (!url.endsWith('/api/turn')) return real(input, init);
      const res = await real(input, init);
      if (!res.body) return res;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      let buffer = '';
      const body = new ReadableStream<Uint8Array>({
        async start(c) {
          // As a real response does: aborting the request (Stop) fails the body at once.
          init?.signal?.addEventListener('abort', () => {
            reader.cancel().catch(() => undefined);
            try {
              c.error(new DOMException('The request was aborted.', 'AbortError'));
            } catch {
              // Already closed.
            }
          });
          for (;;) {
            const { done, value } = await reader.read();
            if (value) buffer += decoder.decode(value, { stream: true });
            // Whole events go on as they come; the turn's end waits for the test.
            for (let cut = buffer.indexOf('\n\n'); cut !== -1; cut = buffer.indexOf('\n\n')) {
              const event = buffer.slice(0, cut + 2);
              buffer = buffer.slice(cut + 2);
              if (event.startsWith('event: done')) {
                await gate;
                w.ended = true;
              }
              try {
                c.enqueue(encoder.encode(event));
              } catch {
                // The page stopped listening (Stop).
                return;
              }
            }
            if (done) break;
          }
          c.close();
        },
      });
      return new Response(body, { status: res.status, headers: res.headers });
    };
  });
}

const heard = (page: Page) => page.evaluate(() => (window as unknown as { heard: Heard[] }).heard);

// Each test starts from the demo's own home, whatever the tests before it committed, so the
// weekend answer is the one these sentences are.
test.beforeEach(async ({ request }) => {
  await request.post('/api/demo');
});

/** /api/speak answers every sentence with an empty clip: no voice is ever asked for. */
async function stubSpeech(page: Page) {
  await page.route('**/api/speak', (route) =>
    route.fulfill({ status: 200, contentType: 'audio/mpeg', body: Buffer.alloc(0) }),
  );
}

test('each sentence is asked for as soon as it is finished, the first before the turn has ended', async ({
  page,
}) => {
  await stubSpeech(page);
  await holdTheEnd(page);
  // The browser tests run silent; this page speaks, to the stub.
  await page.goto('/?speak=1');
  await page.getByRole('button', { name: WEEKEND }).click();
  await expect.poll(async () => (await heard(page)).length).toBeGreaterThan(0);
  const early = await heard(page);
  expect(early[0]).toEqual({ text: SENTENCES[0], ended: false });
  // The turn is still running, and the last sentence, not yet finished, hasn't been asked for.
  await expect(
    page.getByRole('list', { name: 'Conversation' }).locator('li.alexa').last(),
  ).not.toHaveAttribute('data-phase', 'done');
  expect(early.map((h) => h.text)).not.toContain(SENTENCES[3]);

  await page.evaluate(() => (window as unknown as { releaseDone(): void }).releaseDone());
  await expect.poll(async () => (await heard(page)).map((h) => h.text)).toEqual(SENTENCES);
  expect((await heard(page)).at(-1)?.ended).toBe(true);
});

test('a silent page asks for no voice at all', async ({ page }) => {
  await stubSpeech(page);
  await holdTheEnd(page);
  await page.goto('/');
  await page.getByRole('button', { name: WEEKEND }).click();
  await page.evaluate(() => (window as unknown as { releaseDone(): void }).releaseDone());
  await expect(
    page.getByRole('list', { name: 'Conversation' }).locator('li.alexa').last(),
  ).toHaveAttribute('data-phase', 'done');
  await page.waitForTimeout(1000);
  expect(await heard(page)).toEqual([]);
});

test('Stop silences her at once: nothing more is asked for', async ({ page }) => {
  // Each clip takes a while to come, as a real voice's would.
  await page.route('**/api/speak', async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route
      .fulfill({ status: 200, contentType: 'audio/mpeg', body: Buffer.alloc(0) })
      .catch(() => undefined);
  });
  await holdTheEnd(page);
  await page.goto('/?speak=1');
  await page.getByRole('button', { name: WEEKEND }).click();
  await expect.poll(async () => (await heard(page)).length).toBe(1);
  await page.getByRole('button', { name: 'Stop' }).click();
  await page.evaluate(() => (window as unknown as { releaseDone(): void }).releaseDone());
  await page.waitForTimeout(3000);
  expect((await heard(page)).map((h) => h.text)).toEqual([SENTENCES[0]]);
});
