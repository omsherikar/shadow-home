import { expect, type Page, test } from '@playwright/test';
import { tap } from './tap.ts';

const WEEKEND = "I'm away for the weekend, set the house to away.";
const CHECKING = "Checking the plan on your home's twin";

const view = (page: Page) => page.frameLocator('.view iframe');
const conversation = (page: Page) => page.getByRole('list', { name: 'Conversation' });
const lastAnswer = (page: Page) => conversation(page).locator('li.alexa').last();
const composer = (page: Page) => page.getByLabel('Say something to Alexa');

async function say(page: Page, text: string) {
  await composer(page).fill(text);
  await page.getByRole('button', { name: 'Send' }).click();
}

/**
 * Plays each turn back as the event stream the turn route sends: the scripted model's own turn,
 * asked for as JSON, then its steps (running), held until the test lets the turn go on, then the
 * steps done, each call, the words a few at a time, and done. So the page streams the same way
 * whether or not the server it runs against streams yet.
 */
async function holdTurns(page: Page) {
  await page.addInitScript((label) => {
    const real = window.fetch.bind(window);
    let release = () => {};
    let held = new Promise<void>((r) => {
      release = r;
    });
    (window as unknown as { releaseTurn(): void }).releaseTurn = () => {
      release();
      held = new Promise<void>((r) => {
        release = r;
      });
    };
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.endsWith('/api/turn') || init?.method !== 'POST') return real(input, init);
      const headers = { ...(init.headers as Record<string, string>), accept: 'application/json' };
      const turn = (await (await real(input, { ...init, headers })).json()) as {
        say: string;
        calls: { name: string }[];
      };
      const gate = held;
      const encoder = new TextEncoder();
      const event = (type: string, data: unknown) =>
        encoder.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      const step = (i: number, tool: string, state: string) =>
        event('step', { id: `s${i}`, tool, label, state });
      const body = new ReadableStream<Uint8Array>({
        async start(c) {
          c.enqueue(encoder.encode(': open\n\n'));
          for (const [i, call] of turn.calls.entries()) c.enqueue(step(i, call.name, 'running'));
          await gate;
          for (const [i, call] of turn.calls.entries()) {
            c.enqueue(step(i, call.name, 'done'));
            c.enqueue(event('call', { call }));
          }
          for (const words of turn.say.match(/\S+\s*/g) ?? [])
            c.enqueue(event('text', { delta: words }));
          c.enqueue(event('done', turn));
          c.close();
        },
      });
      return new Response(body, {
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      });
    };
  }, CHECKING);
}

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

test('her steps show as the turn runs, the screen draws the check, then the steps fold away', async ({
  page,
}) => {
  await holdTurns(page);
  // Counts each time the conversation is saved.
  await page.addInitScript(() => {
    const w = window as unknown as { saves: number };
    w.saves = 0;
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (this: Storage, key: string, value: string) {
      if (key === 'shadow-home/conversation') w.saves += 1;
      return setItem.call(this, key, value);
    };
  });
  const saves = () => page.evaluate(() => (window as unknown as { saves: number }).saves);
  await page.goto('/');
  await page.getByRole('button', { name: WEEKEND }).click();
  const answer = lastAnswer(page);
  const step = answer.locator('.step', { hasText: CHECKING });
  await expect(step).toHaveClass(/running/);
  await expect(page.getByText('Checking your home', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
  // Nothing on screen yet: the check hasn't finished.
  await expect(page.getByText('Home mode')).toBeVisible();
  await page.screenshot({ path: 'test-results/chat-steps-running.png' });

  const before = await saves();
  await page.evaluate(() => (window as unknown as { releaseTurn(): void }).releaseTurn());
  await expect(view(page).getByText('Not safe', { exact: true })).toBeVisible();
  await expect(answer.locator('.said')).toHaveText(
    "Blocked: that breaks 4 house rules. No coffee maker running when nobody's home. That's Om's rule. Do it with 4 fixes instead?",
  );
  await expect(answer.locator('.verdict-pill')).toHaveText(/Not safe/);
  await expect(answer.getByText(/^What I did \(\d+ steps?\)$/)).toBeVisible();
  await expect(step).toBeHidden();
  // What to say next fits the answer.
  for (const name of ['Run the safer plan', 'Why?', "Don't run"]) {
    await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
  }
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
  // Saved once, when the turn ended, not on each of the words as they came.
  await page.waitForTimeout(500);
  expect((await saves()) - before).toBe(1);
  await page.screenshot({ path: 'test-results/chat-steps-done.png' });
});

test('Stop drops what was already on its way: no plan drawn, no answer, nothing to say next', async ({
  page,
}) => {
  // The rest of the turn arrives in one piece after Stop, as it would when already sent.
  await holdTurns(page);
  await page.goto('/');
  await page.getByRole('button', { name: WEEKEND }).click();
  await expect(lastAnswer(page).locator('.step', { hasText: CHECKING })).toHaveClass(/running/);
  await page.getByRole('button', { name: 'Stop' }).click();
  await page.evaluate(() => (window as unknown as { releaseTurn(): void }).releaseTurn());
  await expect(lastAnswer(page).getByText('Stopped.')).toBeVisible();
  await page.waitForTimeout(2000);
  await expect(page.getByText('Home mode')).toBeVisible();
  await expect(view(page).getByText('Not safe', { exact: true })).toHaveCount(0);
  await expect(lastAnswer(page).locator('.said')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Run the safer plan' })).toHaveCount(0);
  // The question was never asked, so nothing is waiting for a yes, and the request is still new.
  await page.getByRole('button', { name: WEEKEND }).click();
  await expect(lastAnswer(page).locator('.step', { hasText: CHECKING })).toHaveClass(/running/);
  await page.evaluate(() => (window as unknown as { releaseTurn(): void }).releaseTurn());
  await expect(view(page).getByText('Not safe', { exact: true })).toBeVisible();
});

test('a follow-up answers her question: the safer plan runs, then Undo is offered', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: WEEKEND }).click();
  await expect(view(page).getByText('Not safe', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Run the safer plan', exact: true }).click();
  // The suggestion is gone once used; focus is back in the text box, not lost to the page.
  await expect(composer(page)).toBeFocused();
  await expect(conversation(page).locator('li.you').last()).toHaveText(/Run the safer plan/);
  await expect(view(page).getByText('Done', { exact: true })).toBeVisible();
  await expect(lastAnswer(page).locator('.said')).toHaveText('Done: 10 changes.');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeVisible();
});

test('Stop drops the turn: nothing it would have shown arrives, and the chat is ready again', async ({
  page,
}) => {
  let aborted = false;
  page.on('requestfailed', (r) => {
    if (r.url().endsWith('/api/turn')) aborted = true;
  });
  await page.route('**/api/turn', async (route) => {
    await new Promise((r) => setTimeout(r, 4000));
    await route.continue().catch(() => undefined);
  });
  await page.goto('/');
  await page.getByRole('button', { name: WEEKEND }).click();
  // She's thinking: the turn is under way.
  await expect(page.locator('.chat-state')).toHaveText('Thinking');
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(lastAnswer(page).getByText('Stopped.')).toBeVisible();
  await expect.poll(() => aborted).toBe(true);
  await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0);
  await expect(composer(page)).toBeEnabled();
  // Long after the server would have answered, the screen still shows the home.
  await page.waitForTimeout(5000);
  await expect(page.getByText('Home mode')).toBeVisible();
  await expect(view(page).getByText('Not safe', { exact: true })).toHaveCount(0);
});

test('an error is plain words with Try again, which sends the same words again', async ({
  page,
}) => {
  let turns = 0;
  await page.route('**/api/turn', async (route) => {
    turns += 1;
    if (turns === 1) {
      await route.fulfill({ status: 500, json: { error: 'boom' } });
      return;
    }
    await route.fallback();
  });
  await page.goto('/');
  await page.getByRole('button', { name: WEEKEND }).click();
  const problem = lastAnswer(page).getByRole('alert');
  await expect(problem).toHaveText(/Something went wrong on my side\. Try again\./);
  await expect(problem).not.toContainText('500');
  await page.screenshot({ path: 'test-results/chat-error.png' });
  await problem.getByRole('button', { name: 'Try again' }).click();
  await expect(composer(page)).toBeFocused();
  await expect(view(page).getByText('Not safe', { exact: true })).toBeVisible();
  expect(turns).toBe(2);
  // The answer that failed gives way to the one that worked: the request shows once.
  await expect(conversation(page).locator('li.you', { hasText: WEEKEND })).toHaveCount(1);
  await expect(conversation(page).getByRole('alert')).toHaveCount(0);
});

test('Try again sends the very same request: a failed "yes" still commits what was asked', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: WEEKEND }).click();
  await expect(view(page).getByRole('button', { name: /Do it with 4 fixes/ })).toBeVisible();
  let failed = false;
  await page.route('**/api/turn', async (route) => {
    if (!failed) {
      failed = true;
      await route.fulfill({ status: 502, json: { error: 'down' } });
      return;
    }
    await route.fallback();
  });
  await say(page, 'yes');
  const problem = lastAnswer(page).getByRole('alert');
  await expect(problem).toHaveText(/Something went wrong on my side/);
  // Nothing came of it, so the plan isn't set aside and its question is still open.
  await expect(page.getByText('This plan was set aside. Ask again to act on it.')).toHaveCount(0);
  await problem.getByRole('button', { name: 'Try again' }).click();
  await expect(view(page).getByText('Done', { exact: true })).toBeVisible();
  await expect(lastAnswer(page).locator('.said')).toHaveText('Done: 10 changes.');
});

test('the hourly limit says when to come back', async ({ page }) => {
  await page.route('**/api/turn', (route) =>
    route.fulfill({
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      body: `event: error\ndata: ${JSON.stringify({
        message: "I've had a lot of requests this hour. Try again later.",
        retryable: true,
        retryAfterMs: 20 * 60_000,
      })}\n\n`,
    }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: WEEKEND }).click();
  const problem = lastAnswer(page).getByRole('alert');
  await expect(problem).toHaveText(
    /^I've had a lot of requests this hour\. Try again at \d{1,2}:\d\d (AM|PM)\.$/,
  );
  // Nothing to retry until then.
  await expect(problem.getByRole('button')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/chat-limit.png' });
});

test("a later turn sets the plan on screen aside, so its buttons can't act on it", async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: WEEKEND }).click();
  await expect(view(page).getByRole('button', { name: /Do it with 4 fixes/ })).toBeVisible();
  await say(page, 'hello');
  await expect(lastAnswer(page)).toHaveAttribute('data-phase', 'done');
  await expect(page.getByText('This plan was set aside. Ask again to act on it.')).toBeVisible();
  const frame = page.locator('.view iframe');
  const box = await frame.boundingBox();
  if (!box) throw new Error('The plan view is not on screen.');
  const hit = await page.evaluate((p) => document.elementFromPoint(p.x, p.y)?.tagName, {
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
  });
  expect(hit).not.toBe('IFRAME');
  const doIt = view(page).getByRole('button', { name: /Do it with 4 fixes/ });
  // By keyboard: the view is inert, so Tab never reaches its button to press it, even from the
  // control just before it on the screen.
  await page.getByRole('button', { name: 'Home screen' }).focus();
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Tab');
    await expect(doIt).not.toBeFocused();
  }
  await composer(page).focus();
  // Through the bridge: a click the view makes itself still reaches no server tool.
  await doIt.evaluate((el) => (el as HTMLElement).click());
  await expect(
    view(page).getByText('This plan was set aside. Ask again to act on it.'),
  ).toBeVisible();
  await page.waitForTimeout(1000);
  await expect(view(page).getByText('Done', { exact: true })).toHaveCount(0);
  await expect(conversation(page).locator('li.alexa .said', { hasText: /^Done/ })).toHaveCount(0);
  // A new check brings the screen back, and finds the plan as blocked as before: nothing ran.
  await page.getByRole('button', { name: WEEKEND }).click();
  await expect(page.getByText('This plan was set aside. Ask again to act on it.')).toHaveCount(0);
  await expect(lastAnswer(page).locator('.said')).toHaveText(
    /^Blocked: that breaks 4 house rules\./,
  );
});

test('a tap after a reload adds its own line, with no key the chat already has', async ({
  page,
}) => {
  const repeated: string[] = [];
  page.on('console', (m) => {
    if (/same key/i.test(m.text())) repeated.push(m.text());
  });
  for (let visit = 0; visit < 2; visit++) {
    if (visit === 0) await page.goto('/');
    else await page.reload();
    await page.getByRole('button', { name: WEEKEND }).click();
    await tap(page, view(page).getByRole('button', { name: /^Cancel/ }));
    await expect(conversation(page).locator('li.you .said', { hasText: /^Cancel$/ })).toHaveCount(
      visit + 1,
    );
  }
  expect(repeated).toEqual([]);
});

test('the conversation is kept across a reload, with no question left open', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: WEEKEND }).click();
  await expect(lastAnswer(page)).toHaveAttribute('data-phase', 'done');
  await page.reload();
  await expect(conversation(page).locator('li.you', { hasText: WEEKEND })).toBeVisible();
  await expect(lastAnswer(page).locator('.said')).toHaveText(
    /^Blocked: that breaks 4 house rules\./,
  );
  // The screen no longer shows the plan, so a yes can't commit it.
  await say(page, 'yes');
  await expect(lastAnswer(page).locator('.said')).toHaveText("There's nothing waiting for a yes.");
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('the page stacks and the composer stays whole at the bottom', async ({ page }) => {
    await page.goto('/');
    const input = composer(page);
    await expect(input).toBeVisible();
    const inside = async () => {
      for (const control of [input, page.getByRole('button', { name: 'Send' })]) {
        const box = await control.boundingBox();
        if (!box) throw new Error('A control is not on screen.');
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(390);
        expect(box.y + box.height).toBeLessThanOrEqual(844);
        // Nothing covers it.
        const hit = await control.evaluate((el) => {
          const r = el.getBoundingClientRect();
          const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          return at !== null && (el === at || el.contains(at));
        });
        expect(hit).toBe(true);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        390,
      );
    };
    await inside();
    // A short placeholder that fits.
    await expect(input).toHaveAttribute('placeholder', 'Ask Alexa');
    // The house is there when asked for.
    await expect(page.getByRole('button', { name: 'Show the house' })).toBeVisible();
    await page.screenshot({ path: 'test-results/chat-phone-empty.png' });
    await page.getByRole('button', { name: WEEKEND }).click();
    await expect(lastAnswer(page).locator('.said')).toHaveText(
      /^Blocked: that breaks 4 house rules\./,
    );
    await inside();
    await page.screenshot({ path: 'test-results/chat-phone-answer.png' });
  });
});
