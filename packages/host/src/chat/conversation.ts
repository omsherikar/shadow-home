/**
 * The conversation as the chat shows it: what the person said, and Alexa's answers as they arrive,
 * with the steps she took, the verdict and what to offer next. Pure functions over plain data, so
 * the chat is a drawing of these and they can be tested without a browser.
 */
import { z } from 'zod';
import { type Chip, chipFor } from '../stage/stage.ts';
import type { Names, Remembered, ToolCall, TurnRequest } from '../turn/types.ts';
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

// What to offer next

const WHY: FollowUp = { label: 'Why?', says: 'Why?' };
const YES = 'Yes.';
const NO = 'No.';

interface PreviewLike {
  kind?: string;
  tier?: string;
  diff?: unknown[];
  repair?: { verdict?: string } | null;
  safePart?: unknown;
}

/**
 * What to offer after a turn, from what it ended on: the answers to the question the screen asks
 * (the same choices as its buttons), "Why?" where something was refused or can't be confirmed, and
 * Undo after a change. Each sends words both the assistant and the scripted demo understand.
 */
export function followUpsFor(calls: ToolCall[]): FollowUp[] {
  const last = calls.at(-1);
  if (!last || last.result.isError) return [];
  const sc = last.result.structuredContent as Record<string, unknown> | undefined;
  if (!sc) return [];
  switch (last.name) {
    case 'preview_plan':
      return forPreview(sc as PreviewLike);
    case 'undo':
      return sc.preview ? forPreview(sc.preview as PreviewLike) : [];
    case 'commit_plan':
      if (sc.status === 'committed') return [{ label: 'Undo', says: 'Undo.' }];
      if (sc.status === 'needs_confirmation') {
        return [
          { label: 'Yes, do it', says: YES },
          { label: "Don't run", says: NO },
        ];
      }
      return sc.freshPreview ? forPreview(sc.freshPreview as PreviewLike) : [];
    case 'get_activity_log': {
      const entries = sc.entries as { undoable?: boolean }[] | undefined;
      return entries?.some((e) => e.undoable)
        ? [{ label: 'Undo the last change', says: 'Undo.' }]
        : [];
    }
    default:
      return [];
  }
}

function forPreview(p: PreviewLike): FollowUp[] {
  const undo = p.kind === 'undo';
  const no: FollowUp = undo ? { label: 'Keep it', says: NO } : { label: "Don't run", says: NO };
  switch (p.tier) {
    case 'T0':
    case 'T1':
      return [{ label: undo ? 'Undo it' : 'Run it', says: YES }, no];
    case 'T2':
      return [{ label: undo ? 'Yes, undo it' : 'Yes, run it', says: YES }, WHY, no];
    case 'T3':
      if (p.repair?.verdict === 'SAFE') {
        // Nothing in the plan to run (someone heading out): the fix is the whole plan.
        const label = p.diff?.length === 0 ? 'Fix it' : 'Run the safer plan';
        return [{ label, says: YES }, WHY, no];
      }
      if (p.safePart)
        return [{ label: 'Just the safe part', says: 'Just the safe part.' }, WHY, no];
      return [WHY];
    case 'T4':
      if (p.safePart) {
        return [
          { label: 'Just the part you can confirm', says: 'Just the part you can confirm.' },
          { label: 'Run it anyway', says: 'Run it anyway.' },
          no,
        ];
      }
      return [{ label: 'Run it anyway', says: YES }, WHY, no];
    case 'T5':
      return [WHY];
    default:
      return [];
  }
}

/**
 * Whether an answer waits for a reply: it ends with a question (the engine's ask, "Do it with 4
 * fixes instead?"), or what the turn ended on still needs a yes or a no. Hands-free listens for
 * that reply without the wake word.
 */
export function awaitsAnswer(say: string, calls: ToolCall[]): boolean {
  if (/\?["'”’)]*\s*$/.test(say)) return true;
  return followUpsFor(calls).some((f) => f.says === NO);
}

/**
 * On a phone the device folds into a strip, which carries the answers to the screen's question
 * (its buttons); the chat keeps the rest ("Why?").
 */
export function splitFollowUps(all: FollowUp[]): { answers: FollowUp[]; rest: FollowUp[] } {
  return {
    answers: all.filter((f) => f.says !== WHY.says),
    rest: all.filter((f) => f.says === WHY.says),
  };
}

/** What a result puts on the phone's strip: its verdict, if it has one, and its headline. */
export interface Glance {
  verdict?: Chip;
  headline: string;
}

/** The strip's verdict and headline for a call, or null for one that puts nothing on screen. */
export function glanceFor(call: ToolCall): Glance | null {
  const sc = call.result.structuredContent as Record<string, unknown> | undefined;
  if (!sc || call.result.isError) return null;
  if (call.name === 'get_activity_log') return { headline: 'What changed' };
  if (!['preview_plan', 'undo', 'commit_plan', 'add_house_rule'].includes(call.name)) return null;
  const headline = (sc.speech as { headline?: unknown } | undefined)?.headline;
  if (typeof headline !== 'string') return null;
  const verdict = chipFor(call.name, sc);
  return verdict ? { verdict, headline } : { headline };
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

// Kept across a reload

export const CONVERSATION_KEY = 'shadow-home/conversation';
/** The most messages kept, and the longest any one is when kept. */
export const KEEP_MESSAGES = 40;
const KEEP_TEXT = 1200;
/** The most steps and details one answer keeps. */
const KEEP_LIST = 12;
/** The most history entries kept: as many as the browser sends with a turn. */
export const KEEP_ENTRIES = 41;
/** The most of the model's history kept, in characters of JSON. */
const KEEP_HISTORY = 120_000;

const keptMessage = z.object({
  id: z.string().max(80),
  who: z.enum(['you', 'alexa']),
  text: z.string(),
  phase: z.enum(['done', 'stopped']).optional(),
  steps: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
        state: z.enum(['running', 'done', 'failed']),
      }),
    )
    .optional(),
  verdict: z.enum(['SAFE', 'UNSAFE', 'UNPROVEN', 'DONE']).optional(),
  details: z.array(z.string()).optional(),
});

const keptEntry = z.object({
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
  by: z.literal('screen').optional(),
});

const keptLists = z.object({ messages: z.array(z.unknown()), history: z.array(z.unknown()) });

export type Kept = { messages: Message[]; history: Remembered[] };

/**
 * The conversation as kept: the last KEEP_MESSAGES finished messages, each cut to KEEP_TEXT with
 * at most KEEP_LIST steps and details, and the last KEEP_ENTRIES of the history the model reads,
 * oldest first out past KEEP_HISTORY. Both saving and loading go through it, so what is saved is
 * always what loads.
 */
export function toKeep(messages: Message[], history: Remembered[]): Kept {
  const done = messages
    .filter((m) => m.who === 'you' || m.phase === 'done' || m.phase === 'stopped')
    .slice(-KEEP_MESSAGES)
    .map(({ problem: _p, request: _r, ...m }) => ({
      ...m,
      text: m.text.slice(0, KEEP_TEXT),
      ...(m.steps ? { steps: m.steps.slice(-KEEP_LIST) } : {}),
      ...(m.details ? { details: m.details.slice(0, KEEP_LIST) } : {}),
    }));
  const h = history.slice(-KEEP_ENTRIES);
  while (h.length > 0 && JSON.stringify(h).length > KEEP_HISTORY) h.shift();
  return { messages: done, history: h };
}

/** Save the conversation; if storage refuses (a private window, a full quota), it isn't kept. */
export function saveConversation(storage: Pick<Storage, 'setItem'> | null, k: Kept): void {
  try {
    storage?.setItem(CONVERSATION_KEY, JSON.stringify(toKeep(k.messages, k.history)));
  } catch {
    // Nothing to do: the conversation still holds until the page reloads.
  }
}

/**
 * The conversation kept last time, checked message by message and entry by entry: one that
 * doesn't read is dropped, and the rest are cut to the caps, so nothing else is lost with it. A
 * question still open isn't kept open: after a reload the screen no longer shows it, so the
 * history says it was closed.
 */
export function loadConversation(storage: Pick<Storage, 'getItem'> | null): Kept {
  try {
    const raw = storage?.getItem(CONVERSATION_KEY);
    if (!raw) return { messages: [], history: [] };
    const lists = keptLists.safeParse(JSON.parse(raw));
    if (!lists.success) return { messages: [], history: [] };
    const readable = <T>(schema: z.ZodType<T>, items: unknown[]) =>
      items.flatMap((item) => {
        const r = schema.safeParse(item);
        return r.success ? [r.data] : [];
      });
    const k = toKeep(
      readable(keptMessage, lists.data.messages) as Message[],
      readable(keptEntry, lists.data.history) as Remembered[],
    );
    const last = k.history.at(-1);
    return {
      messages: k.messages,
      history:
        last && last.name !== 'closed'
          ? [...k.history, { name: 'closed', arguments: {} }]
          : k.history,
    };
  } catch {
    return { messages: [], history: [] };
  }
}

/** Forget the conversation (a new one, or the demo starting over). */
export function forgetConversation(storage: Pick<Storage, 'removeItem'> | null): void {
  try {
    storage?.removeItem(CONVERSATION_KEY);
  } catch {
    // Nothing to do.
  }
}
