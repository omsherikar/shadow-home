'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { recognitionCtor } from '../device/voice.ts';
import { earcon, readyEarcon } from './earcon.ts';
import { continuousListener, type Listener } from './listener.ts';
import { type HandsFree, type HandsFreeEvent, hears, next, OFF } from './machine.ts';

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
  /** The words so far, while she listens for a request or an answer. */
  heard: string;
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

  // The microphone, once, after the first render.
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
      onError: (_error, lasting) => dispatch({ type: 'mic-error', lasting }),
    });
    const pending = timers.current;
    return () => {
      listener.current?.pause();
      listener.current = null;
      for (const t of pending) clearTimeout(t);
    };
  }, [dispatch]);

  // The microphone follows the state: on while listening, off while she thinks or speaks.
  useEffect(() => {
    if (hears(state.mode)) listener.current?.resume();
    else listener.current?.pause();
    if (state.mode !== 'awake' && state.mode !== 'answer') setHeard('');
  }, [state]);

  const turnOn = useCallback(() => {
    if (!recognitionCtor()) return;
    // Inside the tap: browsers allow the microphone prompt and sound from here on.
    readyEarcon();
    dispatch({ type: 'on' });
  }, [dispatch]);
  const turnOff = useCallback(() => dispatch({ type: 'off' }), [dispatch]);
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
    heard,
    turnOn,
    turnOff,
    wake,
    turnStarted,
    turnEnded,
    stopped,
  };
}
