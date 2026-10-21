import type { Model, ModelInput, ModelStep, Names, Remembered } from './types.ts';

/** What a real model sent to preview_plan for a beat, recorded for demo mode to replay. */
export interface RecordedPlan {
  actions: Record<string, unknown>[];
  requestedBy?: string;
  presenceSchedule?: { from: string; to: string; presence: unknown }[];
  planEnd?: string;
}

/** The preview_plan arguments a turn sent, without the intent (demo mode says its own words). */
export function recordedFrom(calls: { name: string; arguments: Record<string, unknown> }[]) {
  const preview = calls.find((c) => c.name === 'preview_plan');
  if (!preview || !Array.isArray(preview.arguments.actions)) return null;
  const { intent: _, ...rest } = preview.arguments;
  return rest as unknown as RecordedPlan;
}

/** A beat of fixtures/demo-script.json: a line to say and the plan or rule it should produce. */
export interface Beat {
  id: string;
  say: string | string[];
  author?: string;
  context?: {
    /** The home time the scene happens at. */
    now?: string;
    presenceSchedule?: { from: string; to: string; presence: unknown }[];
    planEnd?: string | null;
  };
  draftPlanExample?: Record<string, unknown>[];
  recordedPlan?: RecordedPlan | null;
  /** For a house-rule beat: the rule the compiler should produce. */
  expected?: { template?: string; compiled?: Record<string, unknown>; priority?: string };
}

/** A whole reply that means yes: "yes", "okay, do it", "yes please". Not "okay, what changed?". */
const YES = /^(yes|yeah|yep|sure|ok|okay|go ahead|do it)( (please|do it|go ahead|thanks))*$/;
const NO = /^(no|nope|cancel|never ?mind|stop|keep it)\b/;
/** Someone going out with nothing else to change: "I'm heading out", "we're leaving now". */
const LEAVING = /^(im|i am|were|we are) (heading out|leaving|going out|off)( now)?$/;
/** How long the house is checked empty when someone leaves without saying when they'll be back. */
const LEAVING_HOURS = 4;
/** A question about the last answer: "why?", "why not?", "how come?", "why is that?". */
const WHY = /^(why|how come)\b/;

/**
 * A stand-in for the model that knows the demo lines. It drafts the scripted plan for a demo
 * request, checks the house when someone leaves, answers yes and no to the last question asked,
 * says why from the last answer's reason, undoes, and reads the log. It speaks only from the
 * server's speech fields, so it never says anything a tool didn't. `home.now` is the home's time,
 * as the real model is told it.
 */
export function scriptedModel(beats: Beat[], home?: { now: string }): Model {
  return {
    async next(input: ModelInput): Promise<ModelStep> {
      const last = input.thisTurn.at(-1);
      if (last) {
        const structured = last.result.structuredContent as Record<string, unknown> | undefined;
        return { say: spokenFrom(structured, last.result.content) };
      }
      return firstStep(normalise(input.text), input, beats, home?.now);
    },
  };
}

function firstStep(text: string, input: ModelInput, beats: Beat[], now?: string): ModelStep {
  if (WHY.test(text)) return { say: why(input.history) };
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
  const rule = beat?.expected;
  if (beat && rule?.template && rule.compiled) {
    // The rule as the compiler should produce it, recorded in the demo script.
    return call('add_house_rule', {
      text: input.text,
      author: beat.author ?? 'om',
      rule: { template: rule.template, priority: rule.priority, params: rule.compiled },
    });
  }
  if (beat?.recordedPlan) return call('preview_plan', { intent: input.text, ...beat.recordedPlan });
  if (now && LEAVING.test(text)) {
    // From the start of this minute, so whatever is wrong is put right now, not a minute on.
    const from = `${now.slice(0, 16)}:00${zoneOf(now)}`;
    return call('preview_plan', {
      intent: input.text,
      requestedBy: 'om',
      actions: [],
      presenceSchedule: [{ from, to: hoursLater(from, LEAVING_HOURS), presence: 'nobody' }],
    });
  }
  if (beat?.draftPlanExample) {
    const context = beat.context ?? {};
    return call('preview_plan', {
      intent: input.text,
      requestedBy: beat.author ?? 'om',
      actions: beat.draftPlanExample,
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
 * Why, from the last answer that gave a reason: the reason the server gave, and its question
 * again while it's still open, so a yes still answers it.
 */
function why(history: Remembered[]): string {
  const last = history.findLast((h) => speechOf(h.structuredContent)?.headline);
  const speech = speechOf(last?.structuredContent);
  if (!speech?.reason) return "That's all the check told me.";
  const open = last !== undefined && openQuestion(history) !== null && lastAnswer(history) === last;
  return open && speech.ask ? `${speech.reason} ${speech.ask}` : speech.reason;
}

function speechOf(sc: Record<string, unknown> | undefined) {
  return sc?.speech as { headline?: string; reason?: string; ask?: string } | undefined;
}

/**
 * The last thing in the conversation that can be answered: neither the assistant's own words nor
 * a "why?", which leave a question open.
 */
function lastAnswer(history: Remembered[]): Remembered | undefined {
  return history.findLast(
    (h) =>
      h.name !== 'said' &&
      !(h.name === 'heard' && WHY.test(normalise(String(h.arguments.text ?? '')))),
  );
}

/**
 * The question still open: the one asked by the last thing in the conversation. Anything said or
 * tapped since (a "no", Cancel, another request) closes it, so a later yes can't answer it; the
 * assistant's own words (asking the question) and a "why?" don't.
 */
function openQuestion(history: Remembered[]): { preview?: PreviewLike; confirm?: string } | null {
  const last = lastAnswer(history);
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

const PRONOUNS = new Set(['it', 'that', 'this', 'them', 'those', 'everything', 'all']);

/**
 * The devices "undo the …" names, by whole words: "the thermostat" is the one whose name says it
 * with the fewest other words ("Main thermostat", not "Garage heater thermostat"), "the lights" is
 * every light, and "it" names no device in particular (the whole last change).
 */
export function devicesNamed(words: string, names?: Names): string[] {
  const asked = normalise(words)
    .split(' ')
    .filter((w) => w && w !== 'the');
  if (!names || asked.length === 0 || asked.every((w) => PRONOUNS.has(w))) return [];
  const stem = (w: string) => w.replace(/s$/, '');
  const wanted = asked.map(stem);
  const matches = Object.entries(names.devices).filter(([, d]) => {
    const own = normalise(d.name).split(' ').map(stem);
    return wanted.every((w) => own.includes(w));
  });
  const plural = asked.at(-1)?.endsWith('s') === true;
  if (plural || matches.length <= 1) return matches.map(([id]) => id);
  const size = (name: string) => name.split(' ').length;
  const fewest = Math.min(...matches.map(([, d]) => size(d.name)));
  return matches.filter(([, d]) => size(d.name) === fewest).map(([id]) => id);
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
  const groups = structured?.groups as { label: string }[] | undefined;
  if (groups) {
    if (groups.length === 0) return 'Nothing has changed.';
    const labels = groups.slice(0, 3).map((g) => g.label.replace(/[.!?]+$/, ''));
    const more = groups.length > 3 ? `, and ${groups.length - 3} more` : '';
    return `Here's what changed: ${labels.join('; ')}${more}. Say undo to put something back.`;
  }
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

/** The UTC offset an ISO time ends with: "-06:00", or "Z". */
function zoneOf(iso: string): string {
  return /(Z|[+-]\d{2}:\d{2})$/.exec(iso)?.[0] ?? 'Z';
}

/** An ISO time some hours later, written in the same offset: "2027-01-18T11:15:00-06:00". */
function hoursLater(iso: string, hours: number): string {
  const zone = zoneOf(iso);
  const sign = zone.startsWith('-') ? -1 : 1;
  const [h = 0, m = 0] = zone === 'Z' ? [] : zone.slice(1).split(':').map(Number);
  const local = new Date(Date.parse(iso) + hours * 3_600_000 + sign * (h * 60 + m) * 60_000);
  return `${local.toISOString().slice(0, 19)}${zone}`;
}

function call(name: string, args: Record<string, unknown>): ModelStep {
  return { call: { name, arguments: args } };
}

function commit(args: Record<string, unknown>): ModelStep {
  return call('commit_plan', args);
}
