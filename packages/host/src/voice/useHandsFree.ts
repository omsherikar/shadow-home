'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { recognitionCtor, speech } from '../device/voice.ts';
import { earcon, readyEarcon } from './earcon.ts';
import { continuousListener, GAVE_UP, type Listener } from './listener.ts';
import { type HandsFree, type HandsFreeEvent, hears, next, OFF } from './machine.ts';

/** Hands-free is remembered across reloads, in the browser's local storage. */
export const HANDS_FREE_KEY = 'shadow-home/hands-free';

const NEEDS_CHROME =
  'Hands-free needs a browser that recognises speech, such as Chrome. You can type instead.';
const MIC_REFUSED =
  "Hands-free needs the microphone. Allow it in your browser's settings for this site, then turn it on again.";
const UNAVAILABLE = "Hands-free stopped: speech recognition isn't available right now.";

function remembered(): boolean {
  try {
    return window.localStorage.getItem(HANDS_FREE_KEY) === 'on';
  } catch {
    return false;
  }
}

function remember(on: boolean): void {
  try {
    if (on) window.localStorage.setItem(HANDS_FREE_KEY, 'on');
    else window.localStorage.removeItem(HANDS_FREE_KEY);
  } catch {
    // Not kept: it lasts until the page reloads.
  }
}

/**
 * Whether the microphone should listen: in a state that listens, and only while the page is in
 * view, so a hidden tab sends nothing to be recognised.
 */
export function shouldListen(state: HandsFree, visible: boolean): boolean {
  return visible && hears(state.mode);
}

export interface HandsFreeControls {
  state: HandsFree;
  /** Whether the browser can recognise speech; null until known, after the first render. */
  available: boolean | null;
  /** Left on before a reload: one tap resumes it (the tap browsers want for sound). */
  resumable: boolean;
  /** The words so far, while she listens for a request or an answer. */
  heard: string;
  problem: string | null;
  turnOn(): void;
  turnOff(): void;
  /** The mic button while hands-free is on: listen for a request now. */
  wake(): void;
  turnStarted(): void;
  /** The turn and its voice are over; `asked`: it ended asking something. */
  turnEnded(asked: boolean): void;
  stopped(): void;
}

/**
 * Hands-free: the microphone listening for "Alexa", then for the request, and after a question
 * for the answer, never while she thinks or speaks. `onRequest` is what was asked, to be sent as a
 * turn like anything typed. The state machine (machine.ts) decides; this does what it says.
 */
export function useHandsFree(options: {
  onRequest(text: string): void;
  silent: boolean;
}): HandsFreeControls {
  const [state, setState] = useState<HandsFree>(OFF);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [heard, setHeard] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [resumable, setResumable] = useState(false);
  const [visible, setVisible] = useState(true);
  const current = useRef<HandsFree>(OFF);
  const latest = useRef(options);
  latest.current = options;
  const listener = useRef<Listener | null>(null);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  const dispatch = useCallback((event: HandsFreeEvent) => {
    const step = next(current.current, event);
    current.current = step.state;
    setState(step.state);
    for (const effect of step.effects) {
      if (effect.kind === 'send') latest.current.onRequest(effect.text);
      if (effect.kind === 'earcon' && !latest.current.silent) earcon();
      if (effect.kind === 'timer') {
        const timer = setTimeout(() => {
          timers.current.delete(timer);
          dispatch({ type: 'timeout', epoch: effect.epoch });
        }, effect.ms);
        timers.current.add(timer);
      }
    }
  }, []);

  // The microphone, once, after the first render. Left on before a reload, hands-free waits for a
  // tap to resume: without one, the browser would hold her voice back, and she'd listen for
  // answers to questions nobody heard.
  useEffect(() => {
    const Ctor = recognitionCtor();
    setAvailable(Ctor !== undefined);
    if (!Ctor) return;
    listener.current = continuousListener(Ctor, {
      onFinal: (text) => dispatch({ type: 'heard', text }),
      onInterim: (text) => {
        const { mode } = current.current;
        setHeard(mode === 'awake' || mode === 'answer' ? text : '');
      },
      onError: (error, lasting) => {
        dispatch({ type: 'mic-error', lasting });
        if (lasting) {
          remember(false);
          setResumable(false);
          setProblem(error === GAVE_UP ? UNAVAILABLE : MIC_REFUSED);
        }
      },
    });
    setResumable(remembered());
    const pending = timers.current;
    return () => {
      listener.current?.pause();
      listener.current = null;
      for (const t of pending) clearTimeout(t);
    };
  }, [dispatch]);

  // In view or not: a hidden tab pauses the microphone, and showing it again resumes it.
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== 'hidden');
    update();
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);

  // The microphone follows the state: on while listening and in view, off while she thinks or
  // speaks, or the tab is hidden.
  useEffect(() => {
    if (shouldListen(state, visible)) listener.current?.resume();
    else listener.current?.pause();
    if (state.mode !== 'awake' && state.mode !== 'answer') setHeard('');
  }, [state, visible]);

  // Her voice, as the speech queue reports it: nothing is heard while she speaks.
  useEffect(() => speech.watch((on) => dispatch({ type: 'speaking', on })), [dispatch]);

  const turnOn = useCallback(() => {
    if (!recognitionCtor()) {
      setProblem(NEEDS_CHROME);
      return;
    }
    // Inside the tap: browsers allow the microphone prompt and sound from here on.
    readyEarcon();
    remember(true);
    setResumable(false);
    setProblem(null);
    dispatch({ type: 'on' });
  }, [dispatch]);
  const turnOff = useCallback(() => {
    remember(false);
    setResumable(false);
    dispatch({ type: 'off' });
  }, [dispatch]);
  const wake = useCallback(() => dispatch({ type: 'wake' }), [dispatch]);
  const turnStarted = useCallback(() => dispatch({ type: 'turn-started' }), [dispatch]);
  const turnEnded = useCallback(
    (asked: boolean) => dispatch({ type: 'turn-ended', asked }),
    [dispatch],
  );
  const stopped = useCallback(() => dispatch({ type: 'stopped' }), [dispatch]);

  return {
    state,
    available,
    resumable,
    heard,
    problem,
    turnOn,
    turnOff,
    wake,
    turnStarted,
    turnEnded,
    stopped,
  };
}
