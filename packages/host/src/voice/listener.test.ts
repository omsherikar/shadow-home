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

  test('starts again whenever it ends or fails, and waits longer while it keeps failing', () => {
    const l = listening();
    l.listener.resume();
    vi.advanceTimersByTime(RESUME_MS);
    vi.advanceTimersByTime(2000);
    // Silence: Chrome ends the session; it starts again soon.
    l.sessions[0]?.fail('no-speech');
    vi.advanceTimersByTime(restartDelay(0));
    expect(l.sessions).toHaveLength(2);
    vi.advanceTimersByTime(2000);
    // The network fails twice: it waits longer each time.
    l.sessions[1]?.fail('network');
    vi.advanceTimersByTime(restartDelay(1) - 1);
    expect(l.sessions).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(l.sessions).toHaveLength(3);
    vi.advanceTimersByTime(2000);
    l.sessions[2]?.fail('network');
    vi.advanceTimersByTime(restartDelay(2));
    expect(l.sessions).toHaveLength(4);
    // Hearing something again resets the wait.
    l.sessions[3]?.say('hello');
    vi.advanceTimersByTime(2000);
    l.sessions[3]?.stop();
    vi.advanceTimersByTime(restartDelay(0));
    expect(l.sessions).toHaveLength(5);
    expect(l.errors).toEqual([
      ['no-speech', false],
      ['network', false],
      ['network', false],
    ]);
  });

  test('a refused microphone stops it for good, and says so', () => {
    const l = listening();
    l.listener.resume();
    vi.advanceTimersByTime(RESUME_MS);
    l.sessions[0]?.fail('not-allowed');
    vi.advanceTimersByTime(10_000);
    expect(l.sessions).toHaveLength(1);
    expect(l.errors).toEqual([['not-allowed', true]]);
  });
});
