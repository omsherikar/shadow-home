import { expect, type Page, test } from '@playwright/test';

const WEEKEND = "I'm away for the weekend, set the house to away.";
const CHECKING = "Checking the plan on your home's twin";

const view = (page: Page) => page.frameLocator('.view iframe');
const conversation = (page: Page) => page.getByRole('list', { name: 'Conversation' });
const lastAnswer = (page: Page) => conversation(page).locator('li.alexa').last();
const composer = (page: Page) => page.getByLabel('Say something to Alexa');

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
