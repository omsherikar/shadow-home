import type { FollowUp, Glance } from '../chat/conversation.ts';
import type { LiveHome } from '../house/looks.ts';
import { CHIPS } from '../stage/stage.ts';
import { capitalise, peopleHome } from './cards.tsx';

export interface StripProps {
  /** What the screen shows, in brief; null when it shows the home. */
  glance: Glance | null;
  home: LiveHome | null;
  /** A later turn set the plan aside: nothing on it answers any more. */
  stale: boolean;
  /** The screen's own choices, as the chat would send them. */
  answers: FollowUp[];
  ready: boolean;
  onOpen(): void;
  onAnswer(f: FollowUp): void;
}

/**
 * The device on a phone, where its screen would be too small to read: the verdict, the headline
 * and the screen's buttons. A tap on it opens the whole screen; the chat under it says the rest.
 */
export function Strip({ glance, home, stale, answers, ready, onOpen, onAnswer }: StripProps) {
  const look = glance?.verdict ? CHIPS[glance.verdict] : null;
  const headline = glance?.headline ?? (home ? `${capitalise(home.mode)} mode` : 'Shadow Home');
  const hint = stale
    ? 'Set aside: ask again to act on it.'
    : glance === null && home
      ? peopleHome(home)
      : 'Tap to see the screen.';
  return (
    <div className={look ? `strip ${look.tone}` : 'strip'}>
      <button type="button" className="strip-open" onClick={onOpen}>
        {look ? (
          <span className={`verdict-pill ${look.tone}`}>
            <span aria-hidden="true">{look.icon}</span> {look.word}
          </span>
        ) : null}
        <span className="strip-headline">{headline}</span>
        <span className="strip-hint">{hint}</span>
      </button>
      {answers.length > 0 && !stale ? (
        <div className="strip-answers">
          {answers.map((a, i) => (
            <button
              key={a.label}
              type="button"
              className={i === 0 ? 'offer first' : 'offer'}
              disabled={!ready}
              onClick={() => onAnswer(a)}
            >
              {a.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
