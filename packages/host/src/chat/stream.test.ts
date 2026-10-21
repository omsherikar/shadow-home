import { describe, expect, test } from 'vitest';
import type { TurnRequest } from '../turn/types.ts';
import { eventFrom, eventParser, refusal, streamTurn, type TurnEvent } from './stream.ts';

const CALL = {
  name: 'preview_plan',
  arguments: { intent: 'Away for the weekend' },
  result: {
    content: [{ type: 'text', text: 'Blocked.' }],
    structuredContent: { verdict: 'UNSAFE', tier: 'T3' },
  },
  resourceUri: 'ui://shadow-home/plan-view.html',
};

/** A typical preview turn, as the contract writes it. */
const PREVIEW_TURN = [
  ': connected',
  '',
  'event: text',
  'data: {"delta":"Let me check "}',
  '',
  'event: step',
  'data: {"id":"s1","tool":"preview_plan","label":"Checking the plan on your home\'s twin","state":"running"}',
  '',
  ': still working',
  '',
  'event: step',
  'data: {"id":"s1","tool":"preview_plan","label":"Checking the plan on your home\'s twin","state":"done"}',
  '',
  'event: call',
  `data: ${JSON.stringify({ call: CALL })}`,
  '',
  'event: text',
  'data: {"delta":"that first."}',
  '',
  'event: done',
  `data: ${JSON.stringify({ say: 'Blocked: that breaks 4 house rules.', calls: [CALL] })}`,
  '',
  '',
].join('\n');

const REQUEST: TurnRequest = { text: "I'm away for the weekend", history: [] };

describe('reading the event stream', () => {
  test('gives each event of a preview turn in order, skipping keep-alives', () => {
    const events = eventParser().push(PREVIEW_TURN);
    expect(events.map((e) => e.type)).toEqual(['text', 'step', 'step', 'call', 'text', 'done']);
    expect(events[1]).toEqual({
      type: 'step',
      id: 's1',
      tool: 'preview_plan',
      label: "Checking the plan on your home's twin",
      state: 'running',
    });
    expect(events[2]).toMatchObject({ type: 'step', id: 's1', state: 'done' });
    expect(events[3]).toEqual({ type: 'call', call: CALL });
    expect(events[5]).toEqual({
      type: 'done',
      turn: { say: 'Blocked: that breaks 4 house rules.', calls: [CALL] },
    });
  });

  test('gives the same events however the text is cut into chunks', () => {
    const whole = eventParser().push(PREVIEW_TURN);
    for (const size of [1, 2, 3, 7, 16, 61]) {
      const parser = eventParser();
      const events: TurnEvent[] = [];
      for (let i = 0; i < PREVIEW_TURN.length; i += size) {
        events.push(...parser.push(PREVIEW_TURN.slice(i, i + size)));
      }
      expect(events, `chunks of ${size}`).toEqual(whole);
    }
  });

  test('reads \\r\\n and \\r line ends, even with a \\r\\n split across chunks', () => {
    const crlf = PREVIEW_TURN.replaceAll('\n', '\r\n');
    const whole = eventParser().push(PREVIEW_TURN);
    expect(eventParser().push(crlf)).toEqual(whole);
    expect(eventParser().push(PREVIEW_TURN.replaceAll('\n', '\r'), true)).toEqual(whole);
    // Until the stream ends, a last \r may be half of a \r\n.
    expect(eventParser().push(PREVIEW_TURN.replaceAll('\n', '\r'))).toEqual(whole.slice(0, -1));
    const parser = eventParser();
    const cut = crlf.indexOf('\r\n') + 1;
    expect([...parser.push(crlf.slice(0, cut)), ...parser.push(crlf.slice(cut))]).toEqual(whole);
  });

  test('gives an event only at the blank line after it, and drops one left unfinished', () => {
    const parser = eventParser();
    expect(parser.push('event: text\ndata: {"delta":"Hi"}\n')).toEqual([]);
    expect(parser.push('\n')).toEqual([{ type: 'text', delta: 'Hi' }]);
    expect(parser.push('event: text\ndata: {"delta":"never finished"}')).toEqual([]);
  });

  test('takes "data:" with or without the space, and joins several data lines', () => {
    const events = eventParser().push(
      'event:text\ndata:{"delta":"a"}\n\nevent: text\ndata: {"delta":\ndata: "b"}\n\n',
    );
    expect(events).toEqual([
      { type: 'text', delta: 'a' },
      { type: 'text', delta: 'b' },
    ]);
  });

  test('skips events it does not know, and data that is not what its type carries', () => {
    const events = eventParser().push(
      [
        'event: progress\ndata: {"percent":50}\n',
        'event: text\ndata: not json\n',
        'event: step\ndata: {"id":"s1","tool":"preview_plan","label":"x","state":"thinking"}\n',
        'event: call\ndata: {"call":{"name":"undo"}}\n',
        'data: {"delta":"no type"}\n',
        'event: text\n',
        'event: text\ndata: {"delta":"kept"}\n',
        '',
      ].join('\n'),
    );
    expect(events).toEqual([{ type: 'text', delta: 'kept' }]);
  });

  test("reads the turn route's own encoding: keep-alives first, a failed step, then the error", () => {
    const sent = [
      ': keep-alive\n\n',
      `event: step\ndata: ${JSON.stringify({ id: 's1', tool: 'commit_plan', label: 'Making the change', state: 'running' })}\n\n`,
      ': keep-alive\n\n',
      `event: step\ndata: ${JSON.stringify({ id: 's1', tool: 'commit_plan', label: 'Making the change', state: 'failed' })}\n\n`,
      `event: error\ndata: ${JSON.stringify({ message: 'Sorry, something went wrong.', retryable: true })}\n\n`,
    ].join('');
    expect(eventParser().push(sent)).toEqual([
      { type: 'step', id: 's1', tool: 'commit_plan', label: 'Making the change', state: 'running' },
      { type: 'step', id: 's1', tool: 'commit_plan', label: 'Making the change', state: 'failed' },
      { type: 'error', message: 'Sorry, something went wrong.', retryable: true },
    ]);
  });

  test('reads an error, with and without when to try again', () => {
    expect(eventFrom('error', '{"message":"Busy","retryable":true,"retryAfterMs":120000}')).toEqual(
      { type: 'error', message: 'Busy', retryable: true, retryAfterMs: 120000 },
    );
    expect(eventFrom('error', '{"message":"No","retryable":false}')).toEqual({
      type: 'error',
      message: 'No',
      retryable: false,
    });
    expect(eventFrom('error', '{"message":"Busy","retryable":true,"retryAfterMs":-1}')).toBeNull();
  });
});

/** A fetch that answers with `body` in the given chunks, and records what it was asked. */
function answering(
  body: string | string[],
  init: { status?: number; type?: string; headers?: Record<string, string> } = {},
) {
  const asked: { url: string; init: RequestInit }[] = [];
  const chunks = [body].flat();
  const fake = (async (url: string, req: RequestInit) => {
    asked.push({ url, init: req });
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c));
        controller.close();
      },
    });
    return new Response(stream, {
      status: init.status ?? 200,
      headers: { 'content-type': init.type ?? 'text/event-stream; charset=utf-8', ...init.headers },
    });
  }) as unknown as typeof fetch;
  return { fake, asked };
}

async function all(events: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe('a turn as it streams', () => {
  test('asks for a stream, sends the request as JSON, and gives every event to done', async () => {
    const { fake, asked } = answering(PREVIEW_TURN.match(/[\s\S]{1,40}/g) ?? []);
    const events = await all(streamTurn(REQUEST, { fetch: fake }));
    expect(events.map((e) => e.type)).toEqual(['text', 'step', 'step', 'call', 'text', 'done']);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.url).toBe('/api/turn');
    expect(asked[0]?.init.method).toBe('POST');
    expect(asked[0]?.init.headers).toMatchObject({
      accept: 'text/event-stream',
      'content-type': 'application/json',
    });
    expect(JSON.parse(String(asked[0]?.init.body))).toEqual(REQUEST);
  });

  test("from a server that answers with JSON (today's route), gives one done", async () => {
    const turn = { say: 'Okay, nothing changed.', calls: [] };
    const { fake } = answering(JSON.stringify(turn), { type: 'application/json' });
    expect(await all(streamTurn(REQUEST, { fetch: fake }))).toEqual([{ type: 'done', turn }]);
  });

  test('JSON that is not a turn is an error in plain words', async () => {
    const { fake } = answering('{"say":3}', { type: 'application/json' });
    const [event] = await all(streamTurn(REQUEST, { fetch: fake }));
    expect(event).toMatchObject({ type: 'error', retryable: true });
  });

  test('stops at the error that ends a turn, with when to try again', async () => {
    const { fake } = answering(
      'event: error\ndata: {"message":"I\'ve had a lot of requests this hour.","retryable":true,"retryAfterMs":120000}\n\nevent: text\ndata: {"delta":"after"}\n\n',
    );
    expect(await all(streamTurn(REQUEST, { fetch: fake }))).toEqual([
      {
        type: 'error',
        message: "I've had a lot of requests this hour.",
        retryable: true,
        retryAfterMs: 120000,
      },
    ]);
  });

  test('a stream that ends before done or error ends with an error to retry', async () => {
    const { fake } = answering('event: text\ndata: {"delta":"Let me"}\n\n');
    const events = await all(streamTurn(REQUEST, { fetch: fake }));
    expect(events[0]).toEqual({ type: 'text', delta: 'Let me' });
    expect(events[1]).toMatchObject({ type: 'error', retryable: true });
    expect(events).toHaveLength(2);
  });

  test('a refusal before streaming is plain words, never a status code', async () => {
    for (const status of [400, 403, 500, 502]) {
      const { fake } = answering('{"error":"Bad turn request"}', {
        status,
        type: 'application/json',
      });
      const events = await all(streamTurn(REQUEST, { fetch: fake }));
      expect(events).toHaveLength(1);
      const [e] = events;
      expect(e?.type).toBe('error');
      if (e?.type !== 'error') continue;
      expect(e.message).not.toMatch(/\d{3}|failed|error/i);
      expect(e.retryable).toBe(status >= 500);
    }
    expect(refusal(429, '90')).toMatchObject({ retryable: true, retryAfterMs: 90_000 });
    expect(refusal(429, null)).not.toHaveProperty('retryAfterMs');
  });

  test('no connection is an error to retry', async () => {
    const offline = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const events = await all(streamTurn(REQUEST, { fetch: offline }));
    expect(events).toEqual([expect.objectContaining({ type: 'error', retryable: true })]);
  });

  test('aborting stops the turn: the request is cancelled and nothing more comes', async () => {
    const controller = new AbortController();
    const slow = (async (_url: string, init: RequestInit) => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(encoder.encode('event: text\ndata: {"delta":"Checking"}\n\n'));
          init.signal?.addEventListener('abort', () =>
            c.error(new DOMException('aborted', 'AbortError')),
          );
        },
      });
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
    }) as unknown as typeof fetch;
    const events: TurnEvent[] = [];
    for await (const e of streamTurn(REQUEST, { fetch: slow, signal: controller.signal })) {
      events.push(e);
      controller.abort();
    }
    // Nothing after the abort, not even an error: the person stopped it.
    expect(events).toEqual([{ type: 'text', delta: 'Checking' }]);
  });

  test('aborting stops at once, even with the rest of the turn already in hand', async () => {
    // The whole turn arrives in one chunk, so every event is parsed before the first is read.
    const { fake } = answering(PREVIEW_TURN);
    const controller = new AbortController();
    const events: TurnEvent[] = [];
    for await (const e of streamTurn(REQUEST, { fetch: fake, signal: controller.signal })) {
      events.push(e);
      controller.abort();
    }
    expect(events.map((e) => e.type)).toEqual(['text']);
  });

  test('aborted while JSON is read, it gives nothing', async () => {
    const controller = new AbortController();
    const turn = { say: 'Okay.', calls: [] };
    const late = (async () => {
      const res = Response.json(turn);
      controller.abort();
      return res;
    }) as unknown as typeof fetch;
    expect(await all(streamTurn(REQUEST, { fetch: late, signal: controller.signal }))).toEqual([]);
  });

  test('aborted before the server answers, it ends with nothing', async () => {
    const controller = new AbortController();
    controller.abort();
    const refusing = (async (_url: string, init: RequestInit) => {
      if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      throw new Error('should have been aborted');
    }) as unknown as typeof fetch;
    expect(await all(streamTurn(REQUEST, { fetch: refusing, signal: controller.signal }))).toEqual(
      [],
    );
  });

  test('stopping early cancels the download', async () => {
    let cancelled = false;
    const endless = (async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        pull(c) {
          c.enqueue(encoder.encode('event: text\ndata: {"delta":"more "}\n\n'));
        },
        cancel() {
          cancelled = true;
        },
      });
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
    }) as unknown as typeof fetch;
    for await (const e of streamTurn(REQUEST, { fetch: endless })) {
      expect(e.type).toBe('text');
      break;
    }
    expect(cancelled).toBe(true);
  });
});
