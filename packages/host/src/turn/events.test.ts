import { describe, expect, test } from 'vitest';
import {
  encodeEvent,
  eventStream,
  KEEP_ALIVE,
  stepLabel,
  type TurnEvent,
  wantsEvents,
} from './events.ts';
import { readEvents } from './test-helpers.ts';

describe('the turn as Server-Sent Events', () => {
  test('each event is its type and one line of JSON, then a blank line', () => {
    const event: TurnEvent = { event: 'text', data: { delta: 'Two lines:\nhere.' } };
    expect(encodeEvent(event)).toBe('event: text\ndata: {"delta":"Two lines:\\nhere."}\n\n');
    expect(
      encodeEvent({
        event: 'step',
        data: {
          id: 's1',
          tool: 'preview_plan',
          label: stepLabel('preview_plan'),
          state: 'running',
        },
      }),
    ).toBe(
      'event: step\ndata: {"id":"s1","tool":"preview_plan","label":"Checking the plan on your home\'s twin","state":"running"}\n\n',
    );
    expect(KEEP_ALIVE.startsWith(':')).toBe(true);
  });

  test('a step is labelled from a fixed list, never from what the model wrote', () => {
    expect(stepLabel('commit_plan')).toBe('Making the change');
    expect(stepLabel('a tool nobody listed')).toBe('Working on it');
    expect(stepLabel('constructor')).toBe('Working on it');
  });

  test('only a client that asks for an event stream gets one', () => {
    const asking = (accept?: string) =>
      new Request('http://localhost/api/turn', accept ? { headers: { accept } } : {});
    expect(wantsEvents(asking('text/event-stream'))).toBe(true);
    expect(wantsEvents(asking('text/event-stream, application/json;q=0.5'))).toBe(true);
    expect(wantsEvents(asking('application/json'))).toBe(false);
    expect(wantsEvents(asking())).toBe(false);
  });
});

describe('a streamed response', () => {
  test('is sent as it happens, unbuffered, and ends after done; later events are dropped', async () => {
    let release: () => void = () => {};
    const response = eventStream(async (send) => {
      send({ event: 'text', data: { delta: 'Checking.' } });
      await new Promise<void>((r) => {
        release = r;
      });
      send({ event: 'done', data: { say: 'Done.', calls: [] } });
      send({ event: 'text', data: { delta: 'too late' } });
    });
    expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    // The keep-alive and the first event are readable before the turn has finished.
    let seen = '';
    while (!seen.includes('Checking.')) {
      const { value } = await reader.read();
      seen += decoder.decode(value);
    }
    expect(seen).toBe(`${KEEP_ALIVE}event: text\ndata: {"delta":"Checking."}\n\n`);
    release();
    let rest = '';
    for (let r = await reader.read(); !r.done; r = await reader.read()) {
      rest += decoder.decode(r.value);
    }
    expect(rest).toBe('event: done\ndata: {"say":"Done.","calls":[]}\n\n');
  });

  test('a turn that throws still ends, with an error the person can retry', async () => {
    const response = eventStream(async () => {
      throw new Error('a message that quotes the conversation');
    });
    expect(await readEvents(response)).toEqual([
      { event: 'error', data: { message: 'Sorry, something went wrong.', retryable: true } },
    ]);
  });

  test('a client that goes away stops the turn: the request aborts, or the stream is cancelled', async () => {
    const left = new AbortController();
    let signal: AbortSignal | undefined;
    eventStream(
      async (_, s) => {
        signal = s;
        await new Promise(() => {});
      },
      { signal: left.signal },
    );
    expect(signal?.aborted).toBe(false);
    left.abort();
    expect(signal?.aborted).toBe(true);

    let cancelled: AbortSignal | undefined;
    const response = eventStream(async (_, s) => {
      cancelled = s;
      await new Promise(() => {});
    });
    await response.body?.cancel();
    expect(cancelled?.aborted).toBe(true);
  });
});
