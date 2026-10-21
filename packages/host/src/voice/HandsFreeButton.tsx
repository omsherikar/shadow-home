import type { Mode } from './machine.ts';

const LABELS: Record<Mode, string> = {
  off: 'Start hands-free',
  idle: 'Listening for “Alexa”',
  awake: "I'm listening",
  thinking: 'Hands-free on',
  speaking: 'Hands-free on',
  answer: 'Listening for your answer',
};

/** What Chrome does with the microphone, said wherever hands-free is offered. */
export const PRIVACY =
  'While hands-free is on, Chrome sends what the microphone hears to Google to recognise speech.';

/**
 * Hands-free, always in view: one tap starts it, and from then on it says what she's listening
 * for, with a way to turn it off. Where the browser can't recognise speech, it says so.
 */
export function HandsFreeButton({
  mode,
  available,
  resumable,
  onStart,
  onStop,
}: {
  mode: Mode;
  available: boolean | null;
  /** Left on before a reload: the tap resumes it. */
  resumable: boolean;
  onStart(): void;
  onStop(): void;
}) {
  if (available === null) return null;
  if (!available) {
    return (
      <button type="button" className="hands-free unavailable" onClick={onStart}>
        Hands-free needs Chrome
      </button>
    );
  }
  const on = mode !== 'off';
  return (
    <>
      <button
        type="button"
        className={`hands-free ${mode}`}
        aria-pressed={on}
        aria-describedby="hands-free-privacy"
        title={
          on ? `Turn off hands-free. ${PRIVACY}` : `Say “Alexa” instead of tapping. ${PRIVACY}`
        }
        onClick={on ? onStop : onStart}
      >
        <span className="hf-dot" aria-hidden="true" />
        <span className="hf-label">
          {!on && resumable ? 'Tap to resume hands-free' : LABELS[mode]}
        </span>
        {on ? <span className="hf-off">Turn off</span> : null}
      </button>
      <span id="hands-free-privacy" className="sr-only">
        {PRIVACY}
      </span>
    </>
  );
}
