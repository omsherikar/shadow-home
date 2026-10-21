import { expect, type Page, test } from '@playwright/test';

const WEEKEND = "I'm away for the weekend, set the house to away.";

interface Mic {
  live: unknown;
  starts: number;
  settings: { continuous: boolean; interimResults: boolean }[];
}

/**
 * A stand-in for Chrome's speech recognition: the test says what the microphone hears
 * (`window.hear`), and it reaches the session that's listening, if one is. No microphone, no
 * audio and nothing sent to Google.
 */
async function fakeMic(page: Page) {
  await page.addInitScript(() => {
    type Handler = ((e: unknown) => void) | null;
    const w = window as unknown as { mic: Mic; hear(text: string): boolean };
    class FakeRecognition {
      lang = '';
      continuous = false;
      interimResults = false;
      onresult: Handler = null;
      onerror: Handler = null;
      onend: (() => void) | null = null;
      start() {
        w.mic.live = this;
        w.mic.starts += 1;
        w.mic.settings.push({ continuous: this.continuous, interimResults: this.interimResults });
      }
      stop() {
        this.end();
      }
      abort() {
        this.end();
      }
      end() {
        if (w.mic.live === this) w.mic.live = null;
        setTimeout(() => this.onend?.(), 0);
      }
    }
    w.mic = { live: null, starts: 0, settings: [] };
    w.hear = (text) => {
      const rec = w.mic.live as FakeRecognition | null;
      if (!rec) return false;
      const result = Object.assign([{ transcript: text }], { isFinal: true });
      rec.onresult?.({ resultIndex: 0, results: [result] });
      return true;
    };
    for (const name of ['webkitSpeechRecognition', 'SpeechRecognition']) {
      Object.defineProperty(window, name, { value: FakeRecognition, configurable: true });
    }
  });
}

/** The microphone hears `text`, once a session is listening for it. */
async function hear(page: Page, text: string) {
  await expect
    .poll(() =>
      page.evaluate((t) => (window as unknown as { hear(t: string): boolean }).hear(t), text),
    )
    .toBe(true);
}

/** The text of each turn the page sends, in order. */
function turnsSent(page: Page): string[] {
  const sent: string[] = [];
  page.on('request', (r) => {
    if (r.url().endsWith('/api/turn') && r.method() === 'POST') {
      sent.push((JSON.parse(r.postData() ?? '{}') as { text: string }).text);
    }
  });
  return sent;
}

/** A clip of silence `ms` long, as WAV: something the browser can play to its end. */
function silence(ms: number): Buffer {
  const rate = 8000;
  const samples = Math.round((rate * ms) / 1000);
  const wav = Buffer.alloc(44 + samples, 128);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + samples, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate, 28);
  wav.writeUInt16LE(1, 32);
  wav.writeUInt16LE(8, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(samples, 40);
  return wav;
}

/**
 * /api/speak answers every sentence with a clip of silence `ms` long, and notes what was asked
 * for; nothing is ever sent to a real voice. The page's speaker is a stand-in too: each clip
 * "plays" on the page's own timers and ends after its length, as a speaker would, so when she
 * finishes doesn't depend on the machine's audio output (CI has none). Stop pauses it.
 */
async function stubSpeech(page: Page, ms = 100): Promise<string[]> {
  const spoken: string[] = [];
  await page.route('**/api/speak', async (route) => {
    spoken.push((route.request().postDataJSON() as { text: string }).text);
    await route.fulfill({ status: 200, contentType: 'audio/wav', body: silence(ms) });
  });
  await page.addInitScript((length) => {
    const playing = new WeakMap<HTMLMediaElement, ReturnType<typeof setTimeout>>();
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
      // As a real element does: "playing" once it starts, "ended" after its length.
      setTimeout(() => this.dispatchEvent(new Event('playing')), 0);
      playing.set(
        this,
        setTimeout(() => this.dispatchEvent(new Event('ended')), length),
      );
      return Promise.resolve();
    };
    HTMLMediaElement.prototype.pause = function (this: HTMLMediaElement) {
      clearTimeout(playing.get(this));
    };
  }, ms);
  return spoken;
}

const pill = (page: Page) => page.locator('.hands-free');
const view = (page: Page) => page.frameLocator('.view iframe');

test.describe.configure({ mode: 'serial' });

// Each test starts from the demo's own home, and leaves it so for the tests after it.
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
test.afterEach(async ({ request }) => {
  await request.post('/api/demo');
});

test('one tap, then by voice alone: a request, her question aloud, and the answer to it', async ({
  page,
}) => {
  await fakeMic(page);
  const spoken = await stubSpeech(page);
  const sent = turnsSent(page);
  // This page speaks (to the stub), as hands-free does.
  await page.goto('/?speak=1');
  await expect(pill(page)).toHaveText('Start hands-free');
  await page.locator('.chat-head').screenshot({ path: 'test-results/hands-free-off.png' });

  // The one tap.
  await pill(page).click();
  await expect(pill(page)).toContainText('Listening for “Alexa”');
  await expect(pill(page)).toHaveAttribute('title', /sends what the microphone hears to Google/);
  await page.locator('.chat-head').screenshot({ path: 'test-results/hands-free-idle.png' });

  // Speech without the wake word isn't for her.
  await hear(page, 'turn off the lights');
  await page.waitForTimeout(1000);
  expect(sent).toEqual([]);

  // The wake word and a request in one breath.
  await hear(page, `Alexa, ${WEEKEND}`);
  await expect.poll(() => sent).toEqual([WEEKEND]);
  await expect(view(page).getByText('Not safe', { exact: true })).toBeVisible();
  // She says her question aloud, then listens for the answer with no wake word.
  await expect.poll(() => spoken).toContain('Do it with 4 fixes instead?');
  await expect(pill(page)).toContainText('Listening for your answer');
  await expect(page.locator('.chat-state')).toHaveText('Listening for your answer');
  await page.locator('.chat-head').screenshot({ path: 'test-results/hands-free-answer.png' });

  await hear(page, 'yes');
  await expect.poll(() => sent).toEqual([WEEKEND, 'yes']);
  await expect(view(page).getByText('Done', { exact: true })).toBeVisible();
  // Nothing more to answer: back to listening for "Alexa".
  await expect(pill(page)).toContainText('Listening for “Alexa”');
  await hear(page, 'yes');
  await page.waitForTimeout(1000);
  expect(sent).toEqual([WEEKEND, 'yes']);

  // Listening continuously, with words as they come.
  const settings = await page.evaluate(() => (window as unknown as { mic: Mic }).mic.settings);
  expect(settings.every((s) => s.continuous && s.interimResults)).toBe(true);
});

test('"Alexa" alone: she listens for the request, which needs no wake word', async ({ page }) => {
  await fakeMic(page);
  await stubSpeech(page);
  const sent = turnsSent(page);
  await page.goto('/?speak=1');
  await pill(page).click();
  await hear(page, 'Alexa');
  await expect(pill(page)).toContainText("I'm listening");
  await expect(page.locator('.chat-state')).toHaveText('Listening');
  await page.locator('.chat-head').screenshot({ path: 'test-results/hands-free-awake.png' });
  await hear(page, 'what did you change while I was away');
  await expect.poll(() => sent).toEqual(['what did you change while I was away']);
});

test('when the browser ends the session, the microphone starts again by itself', async ({
  page,
}) => {
  await fakeMic(page);
  await page.goto('/');
  await pill(page).click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { mic: Mic }).mic.starts))
    .toBe(1);
  // Chrome ends a session after a while of silence.
  await page.evaluate(() => {
    const live = (window as unknown as { mic: { live: { end(): void } | null } }).mic.live;
    live?.end();
  });
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { mic: Mic }).mic.starts))
    .toBe(2);
});

test('remembered across a reload, it waits for one tap to resume, even with the microphone allowed', async ({
  page,
  context,
  baseURL,
}) => {
  await context.grantPermissions(['microphone'], { origin: baseURL ?? '' });
  await fakeMic(page);
  await page.goto('/');
  await pill(page).click();
  await expect(pill(page)).toContainText('Listening for “Alexa”');
  await page.reload();
  // Not listening on its own: without a tap the browser would hold her voice back.
  await expect(pill(page)).toContainText('Tap to resume hands-free');
  await page.waitForTimeout(1000);
  expect(await page.evaluate(() => (window as unknown as { mic: Mic }).mic.starts)).toBe(0);
  await pill(page).click();
  await expect(pill(page)).toContainText('Listening for “Alexa”');
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { mic: Mic }).mic.starts))
    .toBe(1);
  // Turned off, it stays off.
  await pill(page).click();
  await expect(pill(page)).toHaveText('Start hands-free');
  await page.reload();
  await expect(pill(page)).toHaveText('Start hands-free');
});

test('a hidden tab pauses the microphone, and showing it again resumes', async ({ page }) => {
  await fakeMic(page);
  await page.goto('/');
  await pill(page).click();
  const mic = () => page.evaluate(() => (window as unknown as { mic: Mic }).mic);
  await expect.poll(async () => (await mic()).live !== null).toBe(true);
  const shown = (hidden: boolean) =>
    page.evaluate((h) => {
      Object.defineProperty(document, 'visibilityState', {
        value: h ? 'hidden' : 'visible',
        configurable: true,
      });
      document.dispatchEvent(new Event('visibilitychange'));
    }, hidden);
  await shown(true);
  await expect.poll(async () => (await mic()).live).toBe(null);
  await page.waitForTimeout(1000);
  expect((await mic()).live).toBe(null);
  await shown(false);
  await expect.poll(async () => (await mic()).starts).toBe(2);
});

test('Stop while she asks her question opens no window for an answer', async ({ page }) => {
  await fakeMic(page);
  // Each sentence takes a while to say, so Stop comes in the middle of her question.
  await stubSpeech(page, 4000);
  const sent = turnsSent(page);
  await page.goto('/?speak=1');
  await pill(page).click();
  await hear(page, `Alexa, ${WEEKEND}`);
  await expect(page.locator('.chat-state')).toHaveText('Speaking');
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(pill(page)).toContainText('Listening for “Alexa”');
  await page.waitForTimeout(1500);
  await expect(pill(page)).not.toContainText('Listening for your answer');
  // A stray "yes" is not for her.
  await hear(page, 'yes');
  await page.waitForTimeout(1000);
  expect(sent).toEqual([WEEKEND]);
});

test('the mic button while she speaks stops her and listens for a request', async ({ page }) => {
  await fakeMic(page);
  await stubSpeech(page, 4000);
  const sent = turnsSent(page);
  await page.goto('/?speak=1');
  await pill(page).click();
  await hear(page, `Alexa, ${WEEKEND}`);
  await expect(page.locator('.chat-state')).toHaveText('Speaking');
  await page.getByRole('button', { name: 'Talk' }).click();
  await expect(pill(page)).toContainText("I'm listening");
  await hear(page, 'no');
  await expect.poll(() => sent).toEqual([WEEKEND, 'no']);
});

test('while she listens for an answer, the text box still takes typing, and typing ends the window', async ({
  page,
}) => {
  await fakeMic(page);
  await stubSpeech(page);
  const sent = turnsSent(page);
  await page.goto('/?speak=1');
  await pill(page).click();
  await hear(page, `Alexa, ${WEEKEND}`);
  await expect(pill(page)).toContainText('Listening for your answer');
  const box = page.getByLabel('Say something to Alexa');
  await expect(box).toBeEditable();
  await box.fill('no');
  await box.press('Enter');
  await expect.poll(() => sent).toEqual([WEEKEND, 'no']);
  await expect(pill(page)).toContainText('Listening for “Alexa”');
});

test('when the browser holds her voice back, she offers a tap to hear her, and opens no window', async ({
  page,
}) => {
  await fakeMic(page);
  await stubSpeech(page);
  await page.addInitScript(() => {
    HTMLMediaElement.prototype.play = () =>
      Promise.reject(new DOMException('play() needs a tap', 'NotAllowedError'));
  });
  const sent = turnsSent(page);
  await page.goto('/?speak=1');
  await pill(page).click();
  await hear(page, `Alexa, ${WEEKEND}`);
  await expect(page.getByRole('button', { name: 'Tap to hear Alexa' })).toBeVisible();
  // Her question wasn't heard, so nothing listens for its answer.
  await expect(pill(page)).toContainText('Listening for “Alexa”');
  await hear(page, 'yes');
  await page.waitForTimeout(1000);
  expect(sent).toEqual([WEEKEND]);
});

test('without speech recognition, it says it needs Chrome, and typing works as before', async ({
  page,
}) => {
  await page.addInitScript(() => {
    for (const name of ['webkitSpeechRecognition', 'SpeechRecognition']) {
      Object.defineProperty(window, name, { value: undefined, configurable: true });
    }
  });
  await page.goto('/');
  await expect(pill(page)).toHaveText('Hands-free needs Chrome');
  await pill(page).click();
  await expect(page.getByText(/^Hands-free needs a browser that recognises speech/)).toBeVisible();
  await page.getByLabel('Say something to Alexa').fill(WEEKEND);
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(view(page).getByText('Not safe', { exact: true })).toBeVisible();
});
