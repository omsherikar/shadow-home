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
// These tests are about her voice, not the house: without WebGL the page is the device alone (as
// it is for anyone without it), so the 3D house drawing in software (CI has no GPU) doesn't compete
// with the servers for the machine while a turn is timed.
test.beforeEach(async ({ page }) => {
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
});

test.beforeEach(async ({ request }) => {
  await request.post('/api/demo');
  // One scripted turn first (it costs nothing and changes nothing): the first turn after the
  // servers start pays for warming the dev server's turn path, and a test should time only itself.
  await request.post('/api/turn', { data: { text: 'hello', history: [] } });
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

test('Stop silences her at once: nothing more is asked for, and nothing on its way plays', async ({
  page,
}) => {
  // The first clip comes at once; the second is held until the test lets it go, so Stop lands
  // while it's on its way, however slow the machine.
  let second = () => {};
  const secondHeld = new Promise<void>((r) => {
    second = r;
  });
  let asked = 0;
  await page.route('**/api/speak', async (route) => {
    asked += 1;
    if (asked === 2) await secondHeld;
    await route
      .fulfill({ status: 200, contentType: 'audio/mpeg', body: Buffer.alloc(0) })
      .catch(() => undefined);
  });
  // Counts each clip the page starts to play.
  await page.addInitScript(() => {
    const w = window as unknown as { plays: number };
    w.plays = 0;
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
      w.plays += 1;
      return play.call(this);
    };
  });
  const plays = () => page.evaluate(() => (window as unknown as { plays: number }).plays);
  await holdTheEnd(page);
  await page.goto('/?speak=1');
  await page.getByRole('button', { name: WEEKEND }).click();
  // The second sentence is asked for only once the first clip has come: it's now on its way.
  await expect
    .poll(async () => (await heard(page)).map((h) => h.text))
    .toEqual(SENTENCES.slice(0, 2));

  await page.getByRole('button', { name: 'Stop' }).click();
  const answer = page.getByRole('list', { name: 'Conversation' }).locator('li.alexa').last();
  await expect(answer.getByText('Stopped.')).toBeVisible();
  // What had been asked for when Stop took effect, and what had played.
  const atStop = await heard(page);
  const playedAtStop = await plays();
  expect(atStop[0]?.text).toBe(SENTENCES[0]);

  // The held clip arrives, and the turn's end is let through: none of it is said or asked for.
  second();
  await page.evaluate(() => (window as unknown as { releaseDone(): void }).releaseDone());
  await page.waitForTimeout(3000);
  expect(await heard(page)).toEqual(atStop);
  expect(await plays()).toBe(playedAtStop);
});
