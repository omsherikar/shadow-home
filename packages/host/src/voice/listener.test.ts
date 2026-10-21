import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Recognition, RecognitionResult } from '../device/voice.ts';
import { continuousListener, RESUME_MS, restartDelay } from './listener.ts';

/** A stand-in for the browser's speech recognition, recording each session it starts. */
function fakeRecognition() {
  const sessions: FakeRec[] = [];
  class FakeRec implements Recognition {
    lang = '';
    interimResults = false;
    continuous = false;
    onresult: Recognition['onresult'] = null;
    onerror: Recognition['onerror'] = null;
    onend: Recognition['onend'] = null;
    started = false;
    aborted = false;
    start() {
      this.started = true;
      sessions.push(this);
    }
    stop() {
      this.onend?.();
    }
    abort() {
      this.aborted = true;
      this.onend?.();
    }
    say(text: string, isFinal = true) {
      const result = Object.assign([{ transcript: text }], {
        isFinal,
      }) as unknown as RecognitionResult;
      this.onresult?.({ resultIndex: 0, results: [result] });
    }
    fail(error: string) {
      this.onerror?.({ error });
      this.onend?.();
    }
  }
  return { Ctor: FakeRec, sessions };
}

function listening() {
  const { Ctor, sessions } = fakeRecognition();
  const finals: string[] = [];
  const interims: string[] = [];
  const errors: [string, boolean][] = [];
  const listener = continuousListener(Ctor, {
    onFinal: (t) => finals.push(t),
    onInterim: (t) => interims.push(t),
    onError: (e, lasting) => errors.push([e, lasting]),
  });
  return { listener, sessions, finals, interims, errors };
}

describe('waiting before starting again', () => {
  test('soon after a normal end, then longer while it keeps failing, never past 5 s', () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(restartDelay)).toEqual([
      250, 500, 1000, 2000, 4000, 5000, 5000,
    ]);
  });
});

describe('the microphone, listening without a break', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test('listens continuously, with words as they come, and passes on each finished piece', () => {
    const l = listening();
    l.listener.resume();
    vi.advanceTimersByTime(RESUME_MS);
    expect(l.sessions).toHaveLength(1);
    const rec = l.sessions[0];
    expect(rec).toMatchObject({ continuous: true, interimResults: true, lang: 'en-US' });
    rec?.say('Alexa I', false);
    rec?.say("Alexa, I'm away for the weekend");
    expect(l.interims).toContain('Alexa I');
    expect(l.finals).toEqual(["Alexa, I'm away for the weekend"]);
  });
});
