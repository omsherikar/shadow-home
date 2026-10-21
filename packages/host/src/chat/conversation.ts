/**
 * The conversation as the chat shows it: what the person said, and Alexa's answers as they arrive,
 * with the steps she took, the verdict and what to offer next. Pure functions over plain data, so
 * the chat is a drawing of these and they can be tested without a browser.
 */
import { type Chip, chipFor } from '../stage/stage.ts';
import type { Names, ToolCall, TurnRequest } from '../turn/types.ts';
import type { StepState, TurnEvent } from './stream.ts';

export interface Step {
  id: string;
  label: string;
  state: StepState;
}

/**
 * Where an answer is: waiting for its first word or step (thinking), running tools (working),
 * writing (talking), finished, stopped by the person, or failed.
 */
export type Phase = 'thinking' | 'working' | 'talking' | 'done' | 'stopped' | 'failed';

export interface Problem {
  message: string;
  retryable: boolean;
  /** For a limit: when a turn can go through again (ms since 1970). */
  retryAt?: number;
}

/** Something the person can tap to answer, and the words it sends. */
export interface FollowUp {
  label: string;
  says: string;
}

export interface Message {
  id: string;
  who: 'you' | 'alexa';
  text: string;
  /** Alexa's answers only, from here down. */
  phase?: Phase;
  steps?: Step[];
  verdict?: Chip;
  /** What the details view lists: rule numbers, whose rule, which wins. */
  details?: string[];
  problem?: Problem;
  /** For a retry: the request this answers, exactly as it was sent. */
  request?: TurnRequest;
}

/**
 * The person's line and Alexa's answer, waiting for its first event. The answer keeps the request
 * it was sent for, so a retry sends exactly that again.
 */
export function ask(
  messages: Message[],
  id: string,
  said: string,
  request: TurnRequest,
): Message[] {
  return [
    ...messages,
    { id: `${id}-you`, who: 'you', text: said },
    { id: `${id}-alexa`, who: 'alexa', text: '', phase: 'thinking', steps: [], request },
  ];
}

/** Alexa's answer with one more event from the stream. `now` dates a limit's retry time. */
export function withEvent(m: Message, event: TurnEvent, now: number, names?: Names): Message {
  switch (event.type) {
    case 'text':
      return { ...m, text: m.text + event.delta, phase: 'talking' };
    case 'step': {
      const steps = m.steps ?? [];
      const step = { id: event.id, label: event.label, state: event.state };
      const known = steps.some((s) => s.id === event.id);
      return {
        ...m,
        steps: known ? steps.map((s) => (s.id === event.id ? step : s)) : [...steps, step],
        phase: event.state === 'running' ? 'working' : m.phase === 'thinking' ? 'working' : m.phase,
      };
    }
    case 'call':
      return withCalls(m, [event.call], names);
    case 'done':
      // What the guard settled on replaces whatever was streamed.
      return { ...withCalls(m, event.turn.calls, names), text: event.turn.say, phase: 'done' };
    case 'error':
      return {
        ...m,
        phase: 'failed',
        problem: {
          message: event.message,
          retryable: event.retryable,
          ...(event.retryAfterMs !== undefined ? { retryAt: now + event.retryAfterMs } : {}),
        },
      };
  }
}

/** The verdict and details from a turn's calls; a later verdict replaces an earlier one. */
function withCalls(m: Message, calls: ToolCall[], names?: Names): Message {
  let verdict = m.verdict;
  for (const c of calls) {
    verdict = chipFor(c.name, c.result.structuredContent as Record<string, unknown>) ?? verdict;
  }
  const details = calls.flatMap((c) => detailsFor(c, names));
  return {
    ...m,
    ...(verdict ? { verdict } : {}),
    ...(details.length > 0 ? { details } : {}),
  };
}

/** The person stopped the answer: what came so far stays, and any step still running stops. */
export function stopped(m: Message): Message {
  return {
    ...m,
    phase: 'stopped',
    steps: (m.steps ?? []).map((s) => (s.state === 'running' ? { ...s, state: 'failed' } : s)),
  };
}

/** Replace one message by its ID. */
export function replace(messages: Message[], id: string, f: (m: Message) => Message): Message[] {
  return messages.map((m) => (m.id === id ? f(m) : m));
}

/** "3:40 PM", in the visitor's own time (or the zone given). */
export function clockAt(ms: number, timeZone?: string): string {
  return new Date(ms).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  });
}

/** The words for an answer that failed, with when to come back for a limit. */
export function problemWords(p: Problem, timeZone?: string): string {
  if (p.retryAt === undefined) return p.message;
  return `${p.message.replace(/\s*Try again later\.?$/, '')} Try again at ${clockAt(p.retryAt, timeZone)}.`;
}

// The details view

interface ViolationLike {
  rule: string;
  text: string;
  author: string;
  priority?: string;
}

interface ConflictLike {
  rule: string;
  text: string;
  priority: string;
  winner: string;
}

/**
 * What the details view lists for a call: each broken rule with its number, whose rule it is and
 * its priority; for a new rule, what it clashes with and which wins by priority. The answer and the
 * screen say the same in plain words; this keeps the numbers for anyone who wants them.
 */
export function detailsFor(call: ToolCall, names?: Names): string[] {
  const sc = call.result.structuredContent as Record<string, unknown> | undefined;
  if (!sc || call.result.isError) return [];
  const who = (id: string) => names?.members[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
  const preview = (p: unknown) =>
    ((p as { violations?: ViolationLike[] } | undefined)?.violations ?? []).map(
      (v) =>
        `${v.rule}: “${v.text}” ${who(v.author)}’s rule${v.priority ? `, ${v.priority} priority` : ''}.`,
    );
  switch (call.name) {
    case 'preview_plan':
      return preview(sc);
    case 'undo':
      return preview(sc.preview);
    case 'commit_plan':
      return preview(sc.freshPreview);
    case 'add_house_rule':
      return ((sc.conflicts as ConflictLike[] | undefined) ?? []).map(
        (c) =>
          `Clashes with ${c.rule}: “${c.text}” (${c.priority} priority). ${c.winner === c.rule ? `${c.rule} wins by priority` : 'The new rule wins by priority'}.`,
      );
    default:
      return [];
  }
}
