import type { Model, ModelInput, ModelStep, Names, Remembered } from './types.ts';

/** A beat of fixtures/demo-script.json: a line to say and the plan it should produce. */
export interface Beat {
  id: string;
  say: string | string[];
  author?: string;
  context?: {
    presenceSchedule?: { from: string; to: string; presence: unknown }[];
    planEnd?: string | null;
  };
  draftPlanExample?: Record<string, unknown>[];
  recordedPlan?: Record<string, unknown>[] | null;
}

/** A whole reply that means yes: "yes", "okay, do it", "yes please". Not "okay, what changed?". */
const YES = /^(yes|yeah|yep|sure|ok|okay|go ahead|do it)( (please|do it|go ahead|thanks))*$/;
const NO = /^(no|nope|cancel|never ?mind|stop|keep it)\b/;

/**
 * A stand-in for the model that knows the demo lines. It drafts the scripted plan for a demo
 * request, answers yes and no to the last question asked, undoes, and reads the log. It speaks
 * only from the server's speech fields, which is what the real model is told to do too.
 */
export function scriptedModel(beats: Beat[]): Model {
  return {
    async next(input: ModelInput): Promise<ModelStep> {
      const last = input.thisTurn.at(-1);
      if (last) {
        const structured = last.result.structuredContent as Record<string, unknown> | undefined;
        return { say: spokenFrom(structured, last.result.content) };
      }
      return firstStep(normalise(input.text), input, beats);
    },
  };
}

function firstStep(text: string, input: ModelInput, beats: Beat[]): ModelStep {
  if (YES.test(text))
    return answerYes(input.history) ?? { say: "There's nothing waiting for a yes." };
  if (NO.test(text)) return { say: 'Okay, nothing changed.' };
  if (/\b(just|only) the (safe )?part\b/.test(text)) {
    const p = openQuestion(input.history)?.preview;
    if (p?.safePart) return commit({ planId: p.planId, safePartOnly: true, confirmed: true });
    return { say: "There's no safe part on offer." };
  }
  if (/\brun it anyway\b/.test(text)) {
    const p = openQuestion(input.history)?.preview;
    if (p?.tier === 'T4') return commit({ planId: p.planId, confirmed: true });
    return { say: "There's nothing waiting to run." };
  }
  const undo = /^undo\b(?: the)?(.*)$/.exec(text);
  if (undo) {
    const devices = devicesNamed(undo[1]?.trim() ?? '', input.names);
    return call('undo', { token: 'last', ...(devices.length > 0 ? { devices } : {}) });
  }
  if (/\bwhat (did you change|changed|happened)\b/.test(text)) return call('get_activity_log', {});
  const beat = bestBeat(text, beats);
  const actions = beat?.recordedPlan ?? beat?.draftPlanExample;
  if (beat && actions) {
    const context = beat.context ?? {};
    return call('preview_plan', {
      intent: input.text,
      requestedBy: beat.author ?? 'om',
      actions,
      ...(context.presenceSchedule?.length ? { presenceSchedule: context.presenceSchedule } : {}),
      ...(context.planEnd ? { planEnd: context.planEnd } : {}),
    });
  }
  return { say: 'Without a model I only know the demo requests. Try one of the suggestions.' };
}

interface PreviewLike {
  planId: string;
  kind?: string;
  tier: string;
  repair?: { planId: string; verdict: string } | null;
  safePart?: { planId: string } | null;
}

/**
 * The question still open: the one asked by the last thing in the conversation. Anything said or
 * tapped since (a "no", Cancel, another request) closes it, so a later yes can't answer it.
 */
function openQuestion(history: Remembered[]): { preview?: PreviewLike; confirm?: string } | null {
  const last = history.at(-1);
  const sc = last?.structuredContent;
  if (!last || !sc) return null;
  if (last.name === 'preview_plan') return { preview: sc as unknown as PreviewLike };
  if (last.name === 'undo') return sc.preview ? { preview: sc.preview as PreviewLike } : null;
  if (last.name === 'commit_plan') {
    if (sc.status === 'needs_confirmation' && typeof sc.planId === 'string') {
      return { confirm: sc.planId };
    }
    if (sc.freshPreview) return { preview: sc.freshPreview as PreviewLike };
  }
  return null;
}

/** What a yes commits: whatever the open question offered. */
function answerYes(history: Remembered[]): ModelStep | null {
  const q = openQuestion(history);
  if (q?.confirm) return commit({ planId: q.confirm, confirmed: true });
  if (q?.preview) return yesTo(q.preview);
  return null;
}

function yesTo(p: PreviewLike): ModelStep | null {
  if (p.tier === 'T5') return { say: 'Okay.' };
  if (p.tier === 'T3') {
    if (p.repair?.verdict === 'SAFE') return commit({ planId: p.repair.planId, confirmed: true });
    if (p.safePart) return commit({ planId: p.planId, safePartOnly: true, confirmed: true });
    return { say: 'Okay.' };
  }
  if (p.tier === 'T4' && p.safePart) {
    return commit({ planId: p.planId, safePartOnly: true, confirmed: true });
  }
  return commit({ planId: p.planId, confirmed: true });
}

/** "thermostat" → every device whose name contains it. */
function devicesNamed(words: string, names?: Names): string[] {
  if (!words || !names) return [];
  return Object.entries(names.devices)
    .filter(([, d]) => d.name.toLowerCase().includes(words))
    .map(([id]) => id);
}

/** The demo line most like what was said, if enough of its words are there. */
export function bestBeat(text: string, beats: Beat[]): Beat | undefined {
  const said = new Set(contentWords(text));
  let best: { beat: Beat; score: number } | undefined;
  for (const beat of beats) {
    for (const line of [beat.say].flat()) {
      const words = contentWords(normalise(line));
      if (words.length === 0) continue;
      const score = words.filter((w) => said.has(w)).length / words.length;
      if (!best || score > best.score) best = { beat, score };
    }
  }
  return best && best.score >= 0.6 ? best.beat : undefined;
}

const FILLER = new Set([
  'when',
  'that',
  'with',
  'unless',
  'after',
  'while',
  'what',
  'your',
  'this',
]);

/** The words that carry meaning, without a plural or possessive "s": "power's" is "power". */
function contentWords(text: string): string[] {
  return text
    .split(' ')
    .filter((w) => w.length > 3 && !FILLER.has(w))
    .map((w) => w.replace(/s$/, ''));
}

/** Headline, reason and question, as the server wrote them. */
export function spokenFrom(
  structured: Record<string, unknown> | undefined,
  content: { type: string; text?: string }[] | undefined,
): string {
  const speech = structured?.speech as
    | { headline?: string; reason?: string; ask?: string }
    | undefined;
  if (speech?.headline)
    return [speech.headline, speech.reason, speech.ask].filter(Boolean).join(' ');
  return (
    (content ?? [])
      .map((c) => c.text ?? '')
      .join(' ')
      .trim() || 'Done.'
  );
}

export function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function call(name: string, args: Record<string, unknown>): ModelStep {
  return { call: { name, arguments: args } };
}

function commit(args: Record<string, unknown>): ModelStep {
  return call('commit_plan', args);
}
