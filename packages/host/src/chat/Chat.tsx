'use client';

import { type FormEvent, type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { CHIPS } from '../stage/stage.ts';
import { MAX_TEXT } from '../turn/bounds.ts';
import { type FollowUp, type Message, problemWords, type Step } from './conversation.ts';

/** What the person can see Alexa doing. */
export type Activity = 'idle' | 'listening' | 'thinking' | 'working' | 'answering' | 'speaking';

export interface ChatProps {
  messages: Message[];
  /** What to offer after the last answer; the starters when there's nothing to follow up. */
  followUps: FollowUp[];
  starters: FollowUp[];
  activity: Activity;
  /** While listening: the words heard so far. */
  heard: string;
  /** Connected, and not playing the demo. */
  ready: boolean;
  micAvailable: boolean;
  /** What the empty text box says: shorter on a phone. */
  placeholder: string;
  /** A line from the page itself: the demo finished, the mic is blocked. */
  notice: string | null;
  onSend(says: string, label?: string): void;
  onMic(): void;
  /** Stop the answer coming in, or the voice. */
  onStop(): void;
  onRetry(m: Message): void;
  /** The small menu: "Play the demo", a new conversation. */
  menu: ReactNode;
}

const ACTIVITY_WORDS: Record<Activity, string> = {
  idle: '',
  listening: 'Listening',
  thinking: 'Thinking',
  working: 'Checking your home',
  answering: 'Answering',
  speaking: 'Speaking',
};

/**
 * Talking to Alexa: the conversation as bubbles, with her steps under each answer while they run,
 * and a composer that's always there (type, talk or tap a suggestion).
 */
export function Chat(props: ChatProps) {
  const { messages, activity, ready } = props;
  const [draft, setDraft] = useState('');
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const following = useRef(true);
  const busy = activity === 'thinking' || activity === 'working' || activity === 'answering';
  const live = busy || activity === 'speaking';
  const last = messages.at(-1);
  // The newest finished answer, for screen readers: whole answers, not every word as it streams.
  const finished = messages.findLast((m) => m.who === 'alexa' && m.phase === 'done');

  // Follow the newest message, unless the person has scrolled up to read.
  const onScroll = () => {
    const el = list.current;
    if (el) following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs whenever the conversation changes
  useLayoutEffect(() => {
    // A new question from the person always brings the view down to it.
    if (last?.who === 'you' || last?.phase === 'thinking') following.current = true;
    const el = list.current;
    if (el && following.current) el.scrollTop = el.scrollHeight;
  }, [messages, props.followUps]);

  // What was pressed (a suggestion, Send, Try again) goes away once it's used, so focus comes back
  // to the text box, where a keyboard carries on. Not on a touch screen, where that would open
  // the keyboard over the answer.
  const refocus = () => {
    if (window.matchMedia('(pointer: fine)').matches) input.current?.focus({ preventScroll: true });
  };
  const send = (says: string, label?: string) => {
    props.onSend(says, label);
    refocus();
  };
  const retry = (m: Message) => {
    props.onRetry(m);
    refocus();
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!draft.trim() || busy || !ready) return;
    send(draft);
    setDraft('');
  };

  const offers = props.followUps.length > 0 ? props.followUps : props.starters;
  const empty = messages.length === 0;
  return (
    <div className={empty ? 'chat empty' : 'chat'} data-activity={activity}>
      <header className="chat-head">
        <Ring activity={activity} />
        <p className="chat-title">
          Alexa
          <span className="chat-state" aria-live="polite">
            {ACTIVITY_WORDS[activity]}
          </span>
        </p>
        {props.menu}
      </header>
      <div className="chat-scroll" ref={list} onScroll={onScroll}>
        {empty ? (
          <div className="welcome">
            <p className="welcome-words">
              Ask me to change something at home. I'll try it on a copy of your house first, and
              tell you if it would break one of your house rules.
            </p>
          </div>
        ) : null}
        <ol className="messages" aria-label="Conversation">
          {messages.map((m) =>
            m.who === 'you' ? (
              <li key={m.id} className="msg you">
                <span className="who">You</span>
                <p className="said">{m.text}</p>
              </li>
            ) : (
              <Answer key={m.id} m={m} latest={m === last} onRetry={retry} />
            ),
          )}
        </ol>
        {props.notice ? <p className="chat-notice">{props.notice}</p> : null}
      </div>
      <p className="sr-only" aria-live="polite">
        {finished ? finished.text : ''}
      </p>
      {offers.length > 0 && !busy ? (
        <div className="offers">
          {offers.map((o) => (
            <button
              key={o.label}
              type="button"
              className="offer"
              disabled={!ready}
              onClick={() => send(o.says, o.label)}
            >
              {o.label}
            </button>
          ))}
        </div>
      ) : null}
      <form className="composer" onSubmit={submit}>
        {props.micAvailable ? (
          <button
            type="button"
            className="round mic"
            aria-label={activity === 'listening' ? 'Stop listening' : 'Talk'}
            aria-pressed={activity === 'listening'}
            disabled={!ready || busy}
            onClick={props.onMic}
          >
            <MicIcon />
          </button>
        ) : null}
        <input
          ref={input}
          aria-label="Say something to Alexa"
          placeholder={activity === 'listening' ? 'Listening…' : props.placeholder}
          maxLength={MAX_TEXT}
          value={activity === 'listening' ? props.heard : draft}
          readOnly={activity === 'listening'}
          onChange={(e) => setDraft(e.target.value)}
          disabled={!ready}
          enterKeyHint="send"
        />
        {live ? (
          <button type="button" className="round stop" aria-label="Stop" onClick={props.onStop}>
            <StopIcon />
          </button>
        ) : (
          <button
            type="submit"
            className="round send"
            aria-label="Send"
            disabled={!ready || !draft.trim()}
          >
            <SendIcon />
          </button>
        )}
      </form>
    </div>
  );
}

function Answer({
  m,
  latest,
  onRetry,
}: {
  m: Message;
  latest: boolean;
  onRetry(m: Message): void;
}) {
  const steps = m.steps ?? [];
  const finished = m.phase === 'done' || m.phase === 'stopped' || m.phase === 'failed';
  const look = m.verdict ? CHIPS[m.verdict] : null;
  return (
    <li className="msg alexa" data-phase={m.phase}>
      <span className="who">Alexa</span>
      {look ? (
        <span className={`verdict-pill ${look.tone}`}>
          <span aria-hidden="true">{look.icon}</span> {look.word}
        </span>
      ) : null}
      {m.text ? (
        <p className="said">{m.text}</p>
      ) : m.phase === 'thinking' ? (
        <p className="said waiting">
          <span className="dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span className="sr-only">Thinking</span>
        </p>
      ) : null}
      {steps.length > 0 ? <Steps steps={steps} open={!finished} /> : null}
      {m.phase === 'stopped' ? <p className="aside">Stopped.</p> : null}
      {m.problem ? (
        <div className="problem" role="alert">
          <p>{problemWords(m.problem)}</p>
          {m.problem.retryable && m.problem.retryAt === undefined && latest && m.request ? (
            <button type="button" className="retry" onClick={() => onRetry(m)}>
              Try again
            </button>
          ) : null}
        </div>
      ) : null}
      {m.details && m.details.length > 0 ? (
        <details className="more">
          <summary>Details</summary>
          <ul>
            {m.details.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </li>
  );
}

/** Her steps: each one live while the answer comes, then folded into one line. */
function Steps({ steps, open }: { steps: Step[]; open: boolean }) {
  const items = (
    <ol className="steps">
      {steps.map((s) => (
        <li key={s.id} className={`step ${s.state}`}>
          <span className="step-mark" aria-hidden="true" />
          {s.label}
          <span className="sr-only">
            {s.state === 'running' ? ' (working)' : s.state === 'failed' ? ' (didn’t finish)' : ''}
          </span>
        </li>
      ))}
    </ol>
  );
  if (open) return items;
  return (
    <details className="steps-done">
      <summary>
        What I did ({steps.length} {steps.length === 1 ? 'step' : 'steps'})
      </summary>
      {items}
    </details>
  );
}

/** The Echo's light ring, as Alexa's mark: it moves while she listens, thinks or speaks. */
function Ring({ activity }: { activity: Activity }) {
  return <span className={`ring ${activity}`} aria-hidden="true" />;
}

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor" />
      <path
        d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path
        d="M12 19V5M5.5 11.5 12 5l6.5 6.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor" />
    </svg>
  );
}
