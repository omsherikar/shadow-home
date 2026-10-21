import { describe, expect, test } from 'vitest';
import type { ToolCall } from '../turn/types.ts';
import {
  ask,
  awaitsAnswer,
  CONVERSATION_KEY,
  clockAt,
  detailsFor,
  followUpsFor,
  glanceFor,
  KEEP_ENTRIES,
  KEEP_MESSAGES,
  loadConversation,
  type Message,
  problemWords,
  saveConversation,
  splitFollowUps,
  stopped,
  toKeep,
  withEvent,
} from './conversation.ts';

const call = (name: string, structuredContent: Record<string, unknown>, isError = false) =>
  ({ name, arguments: {}, result: { content: [], structuredContent, isError } }) as ToolCall;

const preview = (extra: Record<string, unknown>) => ({
  planId: 'p1',
  kind: 'plan',
  verdict: 'UNSAFE',
  tier: 'T3',
  diff: [{ target: 'plug_tv' }],
  violations: [],
  ...extra,
});

const WEEKEND = call(
  'preview_plan',
  preview({
    repair: { planId: 'p2', verdict: 'SAFE' },
    violations: [
      {
        rule: 'R3',
        text: "Don't let the garage pipes freeze.",
        author: 'om',
        priority: 'safety',
      },
    ],
  }),
);

const labels = (calls: ToolCall[]) => followUpsFor(calls).map((f) => f.label);

describe('an answer as it streams', () => {
  const start = (): Message => {
    const [, alexa] = ask([], 't1', "I'm away for the weekend", {
      text: "I'm away for the weekend",
      history: [],
    });
    if (!alexa) throw new Error('no answer');
    return alexa;
  };

  test('starts thinking, keeping the exact request to retry', () => {
    const request = {
      text: 'Yes.',
      history: [{ name: 'preview_plan', arguments: {}, structuredContent: { planId: 'p1' } }],
      screen: 'On screen, the person tapped “Why”.',
    };
    const messages = ask([], 't1', 'Run the safer plan', request);
    expect(messages).toEqual([
      { id: 't1-you', who: 'you', text: 'Run the safer plan' },
      { id: 't1-alexa', who: 'alexa', text: '', phase: 'thinking', steps: [], request },
    ]);
  });

  test('words add up as they arrive; a step shows working, then done in place', () => {
    let m = withEvent(start(), { type: 'text', delta: 'Let me ' }, 0);
    m = withEvent(m, { type: 'text', delta: 'check.' }, 0);
    expect(m).toMatchObject({ text: 'Let me check.', phase: 'talking' });
    const step = { type: 'step', id: 's1', tool: 'preview_plan', label: 'Checking' } as const;
    m = withEvent(m, { ...step, state: 'running' }, 0);
    expect(m.phase).toBe('working');
    expect(m.steps).toEqual([{ id: 's1', label: 'Checking', state: 'running' }]);
    m = withEvent(m, { ...step, state: 'done' }, 0);
    expect(m.steps).toEqual([{ id: 's1', label: 'Checking', state: 'done' }]);
  });

  test('a call puts its verdict and details on the answer before it finishes', () => {
    const m = withEvent(start(), { type: 'call', call: WEEKEND }, 0);
    expect(m.verdict).toBe('UNSAFE');
    expect(m.details).toEqual([
      "R3: “Don't let the garage pipes freeze.” Om’s rule, safety priority.",
    ]);
    expect(m.phase).toBe('thinking');
  });

  test('done replaces what streamed with what she says, and a commit makes it Done', () => {
    let m = withEvent(start(), { type: 'text', delta: 'It is safe, I think' }, 0);
    const commit = call('commit_plan', { status: 'committed', applied: [] });
    m = withEvent(m, { type: 'done', turn: { say: 'Done: 10 changes.', calls: [commit] } }, 0);
    expect(m).toMatchObject({ text: 'Done: 10 changes.', phase: 'done', verdict: 'DONE' });
  });

  test('an error keeps when to come back, from the time it arrived', () => {
    const m = withEvent(
      start(),
      { type: 'error', message: 'Too many requests.', retryable: true, retryAfterMs: 60_000 },
      1_000,
    );
    expect(m).toMatchObject({ phase: 'failed' });
    expect(m.problem).toEqual({ message: 'Too many requests.', retryable: true, retryAt: 61_000 });
  });

  test('stopped keeps what came, and a step still running no longer is', () => {
    let m = withEvent(start(), { type: 'text', delta: 'Checking' }, 0);
    m = withEvent(
      m,
      { type: 'step', id: 's1', tool: 'preview_plan', label: 'Checking', state: 'running' },
      0,
    );
    expect(stopped(m)).toMatchObject({
      text: 'Checking',
      phase: 'stopped',
      steps: [{ id: 's1', state: 'failed' }],
    });
  });
});

describe('the words for a problem', () => {
  test('a limit says the time to come back, in the time zone given', () => {
    const at = Date.UTC(2026, 9, 21, 22, 40);
    expect(clockAt(at, 'America/Los_Angeles')).toBe('3:40 PM');
    expect(
      problemWords(
        {
          message: "I've had a lot of requests this hour. Try again later.",
          retryable: true,
          retryAt: at,
        },
        'America/Los_Angeles',
      ),
    ).toBe("I've had a lot of requests this hour. Try again at 3:40 PM.");
  });

  test('anything else is its message as it came', () => {
    expect(
      problemWords({ message: 'Something went wrong on my side. Try again.', retryable: true }),
    ).toBe('Something went wrong on my side. Try again.');
  });
});

describe('what to offer next', () => {
  test('a blocked plan with a safe fix: the safer plan, why, or not', () => {
    expect(followUpsFor([WEEKEND])).toEqual([
      { label: 'Run the safer plan', says: 'Yes.' },
      { label: 'Why?', says: 'Why?' },
      { label: "Don't run", says: 'No.' },
    ]);
  });

  test('leaving with nothing to run, the fix is the plan: "Fix it"', () => {
    const leaving = call('preview_plan', preview({ diff: [], repair: { verdict: 'SAFE' } }));
    expect(labels([leaving])).toEqual(['Fix it', 'Why?', "Don't run"]);
  });

  test("a plan that can't be confirmed: run it anyway, why, or not", () => {
    const blind = call('preview_plan', preview({ verdict: 'UNPROVEN', tier: 'T4' }));
    expect(followUpsFor([blind])).toEqual([
      { label: 'Run it anyway', says: 'Yes.' },
      { label: 'Why?', says: 'Why?' },
      { label: "Don't run", says: 'No.' },
    ]);
    const part = call('preview_plan', preview({ tier: 'T4', safePart: { planId: 'p3' } }));
    expect(labels([part])).toEqual(['Just the part you can confirm', 'Run it anyway', "Don't run"]);
  });

  test('the same choices as the screen for a yes, a safe part, or a refusal', () => {
    expect(labels([call('preview_plan', preview({ verdict: 'SAFE', tier: 'T2' }))])).toEqual([
      'Yes, run it',
      'Why?',
      "Don't run",
    ]);
    expect(labels([call('preview_plan', preview({ safePart: { planId: 'p3' } }))])).toEqual([
      'Just the safe part',
      'Why?',
      "Don't run",
    ]);
    expect(labels([call('preview_plan', preview({ tier: 'T5' }))])).toEqual(['Why?']);
    expect(labels([call('preview_plan', preview({}))])).toEqual(['Why?']);
  });

  test('after a commit, Undo; an undo asks to undo it or keep it', () => {
    const commit = call('commit_plan', { status: 'committed' });
    expect(followUpsFor([WEEKEND, commit])).toEqual([{ label: 'Undo', says: 'Undo.' }]);
    const undo = call('undo', {
      status: 'preview',
      preview: preview({ kind: 'undo', tier: 'T2' }),
    });
    expect(labels([undo])).toEqual(['Yes, undo it', 'Why?', 'Keep it']);
  });

  test('a stale plan checked again offers what the fresh check offers', () => {
    const refused = call('commit_plan', {
      status: 'refused',
      freshPreview: preview({ repair: { verdict: 'SAFE' } }),
    });
    expect(labels([refused])).toEqual(['Run the safer plan', 'Why?', "Don't run"]);
  });

  test('the log offers to undo only when something can be', () => {
    expect(labels([call('get_activity_log', { entries: [{ undoable: true }] })])).toEqual([
      'Undo the last change',
    ]);
    expect(labels([call('get_activity_log', { entries: [{ undoable: false }] })])).toEqual([]);
  });

  test('nothing after talk, a failed call or a new rule', () => {
    expect(followUpsFor([])).toEqual([]);
    expect(followUpsFor([call('preview_plan', preview({}), true)])).toEqual([]);
    expect(followUpsFor([call('add_house_rule', { status: 'added', conflicts: [] })])).toEqual([]);
  });
});

describe('on a phone', () => {
  test("the strip takes the screen's answers, and the chat keeps Why?", () => {
    expect(splitFollowUps(followUpsFor([WEEKEND]))).toEqual({
      answers: [
        { label: 'Run the safer plan', says: 'Yes.' },
        { label: "Don't run", says: 'No.' },
      ],
      rest: [{ label: 'Why?', says: 'Why?' }],
    });
  });

  test("the strip shows a result's verdict and headline", () => {
    const blocked = call(
      'preview_plan',
      preview({ speech: { headline: 'Blocked: that breaks 4 house rules.' } }),
    );
    expect(glanceFor(blocked)).toEqual({
      verdict: 'UNSAFE',
      headline: 'Blocked: that breaks 4 house rules.',
    });
    const done = call('commit_plan', {
      status: 'committed',
      speech: { headline: 'Done: 10 changes.' },
    });
    expect(glanceFor(done)).toEqual({ verdict: 'DONE', headline: 'Done: 10 changes.' });
    const rule = call('add_house_rule', { status: 'added', speech: { headline: 'Rule added.' } });
    expect(glanceFor(rule)).toEqual({ headline: 'Rule added.' });
    expect(glanceFor(call('get_activity_log', { entries: [] }))).toEqual({
      headline: 'What changed',
    });
    expect(glanceFor(call('get_home_state', { mode: 'home' }))).toBeNull();
    expect(glanceFor(call('preview_plan', preview({}), true))).toBeNull();
  });
});

describe('whether an answer waits for a reply', () => {
  test('a question at the end does', () => {
    expect(
      awaitsAnswer('Blocked: that breaks 4 house rules. Do it with 4 fixes instead?', []),
    ).toBe(true);
    expect(awaitsAnswer('Shall I fix it?” ', [])).toBe(true);
  });
});

describe('the details view', () => {
  test("a new rule's clash says which wins by priority", () => {
    const rule = call('add_house_rule', {
      conflicts: [
        {
          rule: 'R6',
          text: 'Unlock the doors when the smoke alarm goes off.',
          priority: 'safety',
          winner: 'R6',
        },
      ],
    });
    expect(detailsFor(rule)).toEqual([
      'Clashes with R6: “Unlock the doors when the smoke alarm goes off.” (safety priority). R6 wins by priority.',
    ]);
  });

  test("whose rule uses the household's names when the server sent them", () => {
    const names = { devices: {}, routines: {}, members: { om: 'Om', maya: 'Maya' } };
    const v = {
      rule: 'R2',
      text: 'Keep the aquarium heater on.',
      author: 'maya',
      priority: 'comfort',
    };
    expect(detailsFor(call('preview_plan', preview({ violations: [v] })), names)).toEqual([
      'R2: “Keep the aquarium heater on.” Maya’s rule, comfort priority.',
    ]);
  });
});

function memory() {
  const items = new Map<string, string>();
  return {
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, v),
    items,
  };
}

describe('the conversation across a reload', () => {
  const done = (id: string, text: string): Message => ({
    id,
    who: 'alexa',
    text,
    phase: 'done',
    steps: [],
  });

  test('comes back as it was, with any open question closed', () => {
    const storage = memory();
    const messages: Message[] = [
      { id: 'a-you', who: 'you', text: 'Hi' },
      done('a-alexa', 'Hello.'),
    ];
    const history = [
      { name: 'heard', arguments: { text: 'Hi' } },
      { name: 'preview_plan', arguments: {}, structuredContent: { planId: 'p1' } },
    ];
    saveConversation(storage, { messages, history });
    const back = loadConversation(storage);
    expect(back.messages).toEqual(messages);
    expect(back.history).toEqual([...history, { name: 'closed', arguments: {} }]);
  });

  test('keeps the last messages only, each cut short, and none still coming in', () => {
    const many = Array.from({ length: KEEP_MESSAGES + 10 }, (_, i) =>
      done(`m${i}`, 'x'.repeat(2000)),
    );
    const coming: Message = { id: 'live', who: 'alexa', text: 'Che', phase: 'talking' };
    const kept = toKeep([...many, coming], []);
    expect(kept.messages).toHaveLength(KEEP_MESSAGES);
    expect(kept.messages.at(-1)?.id).toBe(`m${KEEP_MESSAGES + 9}`);
    expect(kept.messages.every((m) => m.text.length <= 1200)).toBe(true);
  });

  test('a request kept for a retry is never saved', () => {
    const answer: Message = { ...done('a', 'Hi.'), request: { text: 'hi', history: [] } };
    expect(toKeep([answer], []).messages[0]).not.toHaveProperty('request');
  });

  test('survives reload after reload with a full history', () => {
    const storage = memory();
    const history = Array.from({ length: KEEP_ENTRIES }, (_, i) => ({
      name: 'heard',
      arguments: { text: `line ${i}` },
    }));
    const messages: Message[] = [
      { id: 'a-you', who: 'you', text: 'Hi' },
      done('a-alexa', 'Hello.'),
    ];
    saveConversation(storage, { messages, history });
    // Each load closes the question, one entry more; each save must still load.
    for (let reload = 0; reload < 3; reload++) {
      const back = loadConversation(storage);
      expect(back.messages).toEqual(messages);
      expect(back.history.at(-1)).toEqual({ name: 'closed', arguments: {} });
      saveConversation(storage, back);
    }
    expect(loadConversation(storage).history.length).toBeLessThanOrEqual(KEEP_ENTRIES + 1);
  });

  test('an answer with more steps and details than kept is cut, not lost', () => {
    const storage = memory();
    const long: Message = {
      ...done('a-alexa', 'Blocked.'),
      steps: Array.from({ length: 15 }, (_, i) => ({
        id: `s${i}`,
        label: 'Checking',
        state: 'done',
      })),
      details: Array.from({ length: 15 }, (_, i) => `R${i}: a rule.`),
    };
    saveConversation(storage, { messages: [long], history: [] });
    const [back] = loadConversation(storage).messages;
    expect(back?.steps).toHaveLength(12);
    expect(back?.details).toHaveLength(12);
    // Saved by an older page without the cuts, it still loads, cut on the way in.
    storage.items.set(CONVERSATION_KEY, JSON.stringify({ messages: [long], history: [] }));
    expect(loadConversation(storage).messages[0]?.details).toHaveLength(12);
  });

  test('a message or entry that does not read is dropped alone', () => {
    const storage = memory();
    storage.items.set(
      CONVERSATION_KEY,
      JSON.stringify({
        messages: [{ who: 'robot' }, { id: 'a-you', who: 'you', text: 'Hi' }],
        history: [{ name: 3 }, { name: 'heard', arguments: { text: 'Hi' } }],
      }),
    );
    expect(loadConversation(storage)).toEqual({
      messages: [{ id: 'a-you', who: 'you', text: 'Hi' }],
      history: [
        { name: 'heard', arguments: { text: 'Hi' } },
        { name: 'closed', arguments: {} },
      ],
    });
  });

  test('drops the oldest history past its cap', () => {
    const big = {
      name: 'get_activity_log',
      arguments: {},
      structuredContent: { x: 'y'.repeat(50_000) },
    };
    const kept = toKeep([], [big, big, big, { name: 'heard', arguments: { text: 'last' } }]);
    expect(kept.history.length).toBeLessThan(4);
    expect(kept.history.at(-1)).toEqual({ name: 'heard', arguments: { text: 'last' } });
  });

  test('starts afresh when what was kept is unreadable or storage refuses', () => {
    const storage = memory();
    storage.items.set(CONVERSATION_KEY, '{not json');
    expect(loadConversation(storage)).toEqual({ messages: [], history: [] });
    storage.items.set(CONVERSATION_KEY, JSON.stringify({ messages: 'many' }));
    expect(loadConversation(storage)).toEqual({ messages: [], history: [] });
    const refusing = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(loadConversation(refusing)).toEqual({ messages: [], history: [] });
    expect(() => saveConversation(refusing, { messages: [], history: [] })).not.toThrow();
    expect(loadConversation(null)).toEqual({ messages: [], history: [] });
  });
});
