import {
  capitalise,
  changePhrase,
  clock,
  count,
  midnights,
  sameMinute,
  shortName,
  valuePhrase,
  when,
} from './format.ts';
import type {
  Commit,
  DiffRow,
  Names,
  Preview,
  RepairChange,
  Undo,
  Value,
  Violation,
} from './types.ts';

/** The screen is read from across a room: at most this many rows of changes. */
export const MAX_ROWS = 5;
/** At most this many broken rules get their own card; the rest are counted. */
export const MAX_CARDS = 4;
const MAX_ROUTINE_LANES = 3;

export type Tone = 'safe' | 'blocked' | 'unsure' | 'done' | 'neutral';

export interface Chip {
  text: string;
  /** flagged: it breaks a rule. fixed: the repair changed it. later: it runs at a later time. */
  tone?: 'flagged' | 'fixed' | 'later';
}

/** The changes in one room, or "Home" for the mode and routines. */
export interface Row {
  place: string;
  chips: Chip[];
}

/** One broken rule, as a chain: what caused it, when it breaks, whose rule, and the fix. */
export interface Card {
  /** The rule's ID, which the timeline marks too. */
  id: string;
  cause: string;
  at: string;
  breaks?: string;
  rule: string;
  author: string;
  fix?: string;
}

export interface Mark {
  atMs: number;
  label: string;
  tone?: 'blocked';
}

export interface Lane {
  label: string;
  marks: Mark[];
}

export interface Timeline {
  startMs: number;
  endMs: number;
  days: { atMs: number; label: string }[];
  lanes: Lane[];
}

export type Action =
  | { kind: 'commit'; planId: string; safePartOnly?: boolean }
  | { kind: 'undo'; token: string }
  | { kind: 'dismiss' };

/** An on-screen control and the words that do the same thing by voice. */
export interface Control {
  label: string;
  say: string;
  action: Action;
  primary?: boolean;
}

export interface Screen {
  tone: Tone;
  icon: string;
  word: string;
  headline: string;
  reason?: string;
  ask?: string;
  rowsTitle: string;
  rows: Row[];
  cards: Card[];
  notes: string[];
  timeline?: Timeline;
  controls: Control[];
}

/** What to draw for a tool result's structured content, or null if it isn't one of ours. */
export function screenFor(content: unknown, names?: Names): Screen | null {
  if (!content || typeof content !== 'object') return null;
  if ('cannotUndo' in content) return undoScreen(content as Undo, names);
  if ('applied' in content) return commitScreen(content as Commit, names);
  if ('verdict' in content && 'diff' in content) return previewScreen(content as Preview, names);
  return null;
}

const DISMISS: Action = { kind: 'dismiss' };
const CANCEL: Control = { label: 'Cancel', say: 'cancel', action: DISMISS };

export function previewScreen(p: Preview, names?: Names): Screen {
  const look = badge(p);
  const offered = offeredAlternative(p);
  const fixes = offered === 'repair' && p.repair ? p.repair.changes : [];
  const notes = [...p.invalid.map((i) => i.message), ...p.unknowns.map((u) => withNames(u, names))];
  if (p.violations.length > MAX_CARDS) {
    notes.push(`${count(p.violations.length - MAX_CARDS, 'more rule', 'more rules')} broken`);
  }
  return {
    ...look,
    headline: p.speech.headline,
    // With broken rules on screen, the cards say why; the spoken reason repeats the first one.
    ...(p.speech.reason && p.violations.length === 0 ? { reason: p.speech.reason } : {}),
    ...(p.speech.ask ? { ask: p.speech.ask } : {}),
    rowsTitle:
      p.kind === 'undo'
        ? 'Putting back'
        : fixes.length > 0
          ? `With ${count(fixes.length, 'fix', 'fixes')}`
          : 'What changes',
    rows:
      offered === 'repair' && p.repair
        ? repairRows(p, p.repair.diff, fixes, names)
        : diffRows(p.diff, p.horizon.start, flaggedDevices(p.violations), names),
    cards: p.violations.slice(0, MAX_CARDS).map((v) => card(v, p, fixes, names)),
    notes,
    ...timelineFor(p, names),
    controls: previewControls(p, offered),
  };
}

function badge(p: Preview): Pick<Screen, 'tone' | 'icon' | 'word'> {
  if (p.tier === 'T5') return { tone: 'blocked', icon: '✋', word: 'UNSAFE' };
  if (p.verdict === 'UNSAFE') return { tone: 'blocked', icon: '✕', word: 'UNSAFE' };
  if (p.verdict === 'UNPROVEN') return { tone: 'unsure', icon: '?', word: 'UNPROVEN' };
  return { tone: 'safe', icon: '✓', word: 'SAFE' };
}

/** The alternative the spoken question offers; the same choice the engine's speech makes. */
export function offeredAlternative(p: Preview): 'repair' | 'safe_part' | null {
  if (p.tier === 'T3' && p.repair?.verdict === 'SAFE') return 'repair';
  if ((p.tier === 'T3' || p.tier === 'T4') && p.safePart) return 'safe_part';
  return null;
}

/**
 * The same choices for a plan and for an undo: an undo is checked like any plan, so it can be
 * blocked, unproven or need a yes too. Only the words change ("Undo it", "Keep it").
 */
function previewControls(p: Preview, offered: 'repair' | 'safe_part' | null): Control[] {
  const commit = (planId: string, safePartOnly = false): Action =>
    safePartOnly ? { kind: 'commit', planId, safePartOnly } : { kind: 'commit', planId };
  const undo = p.kind === 'undo';
  const cancel: Control = undo ? { label: 'Keep it', say: 'cancel', action: DISMISS } : CANCEL;
  switch (p.tier) {
    case 'T0':
    case 'T1':
      return [
        { label: undo ? 'Undo it' : 'Do it', say: 'yes', action: commit(p.planId), primary: true },
        cancel,
      ];
    case 'T2':
      return [
        {
          label: undo ? 'Yes, undo it' : 'Yes, do it',
          say: 'yes',
          action: commit(p.planId),
          primary: true,
        },
        cancel,
      ];
    case 'T3':
      if (offered === 'repair' && p.repair) {
        const n = count(p.repair.changes.length, 'fix', 'fixes');
        return [
          { label: `Do it with ${n}`, say: 'yes', action: commit(p.repair.planId), primary: true },
          cancel,
        ];
      }
      if (offered === 'safe_part') {
        return [
          {
            label: 'Just the safe part',
            say: 'yes',
            action: commit(p.planId, true),
            primary: true,
          },
          cancel,
        ];
      }
      return [{ label: 'OK', say: 'okay', action: DISMISS, primary: true }];
    case 'T4':
      if (offered === 'safe_part') {
        return [
          {
            label: 'Just the part I can confirm',
            say: 'yes',
            action: commit(p.planId, true),
            primary: true,
          },
          { label: 'Run it anyway', say: 'run it anyway', action: commit(p.planId) },
          cancel,
        ];
      }
      return [{ label: 'Run it anyway', say: 'yes', action: commit(p.planId) }, cancel];
    case 'T5':
      return [{ label: 'OK', say: 'okay', action: DISMISS, primary: true }];
  }
}

export function commitScreen(c: Commit, names?: Names): Screen {
  const speech = {
    headline: c.speech.headline,
    ...(c.speech.reason ? { reason: c.speech.reason } : {}),
    ...(c.speech.ask ? { ask: c.speech.ask } : {}),
  };
  if (c.status === 'refused' && c.freshPreview) {
    const fresh = previewScreen(c.freshPreview, names);
    return { ...fresh, notes: ['The home changed since that check, so I checked again.'] };
  }
  if (c.status === 'committed') {
    const items = [
      ...c.applied.map((ch) => ({ ...ch, later: false })),
      ...c.held.map((ch) => ({ ...ch, later: true })),
    ];
    return {
      tone: 'done',
      icon: '✓',
      word: 'DONE',
      ...speech,
      rowsTitle: 'Changed',
      rows: limitRows(
        group(
          items.map((ch) => ({
            ...place(ch.target, ch.attr, names),
            chip: {
              text: changeText(ch.target, ch.attr, ch.from, ch.to, names),
              ...(ch.later ? { tone: 'later' as const } : {}),
            },
          })),
        ),
      ),
      cards: [],
      notes: c.held.length > 0 ? ['Changes marked later can still be undone before they run.'] : [],
      controls: c.undoToken
        ? [
            { label: 'Undo', say: 'undo', action: { kind: 'undo', token: c.undoToken } },
            { label: 'Close', say: 'thanks', action: DISMISS, primary: true },
          ]
        : [{ label: 'Close', say: 'thanks', action: DISMISS, primary: true }],
    };
  }
  if (c.status === 'needs_confirmation') {
    return {
      tone: 'unsure',
      icon: '?',
      word: 'NEEDS A YES',
      ...speech,
      rowsTitle: 'What changes',
      rows: [],
      cards: [],
      notes: [],
      controls: [
        {
          label: 'Yes',
          say: 'yes',
          action: { kind: 'commit', planId: c.planId },
          primary: true,
        },
        CANCEL,
      ],
    };
  }
  return {
    tone: 'blocked',
    icon: '✕',
    word: 'NOT DONE',
    ...speech,
    rowsTitle: 'What changes',
    rows: [],
    cards: [],
    notes: [],
    controls: [{ label: 'OK', say: 'okay', action: DISMISS, primary: true }],
  };
}

export function undoScreen(u: Undo, names?: Names): Screen {
  const cannot = u.cannotUndo.map(
    (c) => `${deviceName(c.target, names)} can't be put back: ${c.why}.`,
  );
  if (u.status === 'preview' && u.preview) {
    const s = previewScreen(u.preview, names);
    return {
      ...s,
      headline: u.speech.headline,
      ...(u.speech.reason ? { reason: u.speech.reason } : {}),
      ...(u.speech.ask ? { ask: u.speech.ask } : {}),
      notes: [...u.notes, ...cannot, ...s.notes],
    };
  }
  return {
    tone: 'neutral',
    icon: '–',
    word: 'NOTHING TO UNDO',
    headline: u.speech.headline,
    ...(u.speech.reason ? { reason: u.speech.reason } : {}),
    rowsTitle: 'What changes',
    rows: [],
    cards: [],
    notes: [...u.notes, ...cannot],
    controls: [{ label: 'OK', say: 'okay', action: DISMISS, primary: true }],
  };
}

// Rows

interface Placed {
  place: string;
  /** Rooms keep their order of first appearance; "Home" rows go last unless flagged. */
  home: boolean;
  chip: Chip;
}

function diffRows(diff: DiffRow[], now: string, flagged: Set<string>, names?: Names): Row[] {
  return limitRows(group(diff.map((r) => placedRow(r, now, names, flagged))));
}

function placedRow(
  r: DiffRow,
  now: string,
  names: Names | undefined,
  flagged = new Set<string>(),
): Placed {
  const later = !sameMinute(r.at, now);
  const text = changeText(r.target, r.attr, r.from, r.to, names, r.kind === 'routine');
  const tone: Chip['tone'] = flagged.has(r.target) ? 'flagged' : later ? 'later' : undefined;
  return {
    ...place(r.target, r.attr, names, r.kind === 'routine'),
    chip: { text: later ? `${text} at ${clock(r.at)}` : text, ...(tone ? { tone } : {}) },
  };
}

/**
 * The repaired plan, with what each fix changed marked: devices it left as they were
 * ("Freezer stays on"), values it moved and routines it paused.
 */
function repairRows(p: Preview, diff: DiffRow[], fixes: RepairChange[], names?: Names): Row[] {
  const fixed = new Set(fixes.map((f) => f.target));
  const placed: Placed[] = diff.map((r) => {
    const row = placedRow(r, p.horizon.start, names);
    return fixed.has(r.target) ? { ...row, chip: { text: row.chip.text, tone: 'fixed' } } : row;
  });
  for (const f of fixes) {
    if (f.kind !== 'leave_out' && f.kind !== 'drop_action') continue;
    for (const kept of keptRows(p, f)) {
      placed.push({
        ...place(kept.target, kept.attr, names),
        chip: { text: stays(kept, names, true), tone: 'fixed' },
      });
    }
  }
  return limitRows(group(placed));
}

/** The original diff rows a leave-out or drop fix keeps as they are. */
function keptRows(p: Preview, f: RepairChange): DiffRow[] {
  if (f.kind === 'leave_out') return p.diff.filter((r) => r.target === f.target);
  return p.diff.filter((r) => r.actionIndex === f.actionIndex);
}

function stays(r: DiffRow, names: Names | undefined, short: boolean): string {
  const name = short ? shortDevice(r.target, names) : deviceName(r.target, names);
  if (r.kind === 'mode') return `${capitalise(String(r.from))} mode stays`;
  return `${name} stays ${valuePhrase(r.attr, r.from)}`;
}

function group(items: Placed[]): Row[] {
  const rows = new Map<string, Row & { home: boolean; flagged: boolean }>();
  for (const it of items) {
    let row = rows.get(it.place);
    if (!row) {
      row = { place: it.place, chips: [], home: it.home, flagged: false };
      rows.set(it.place, row);
    }
    row.chips.push(it.chip);
    if (it.chip.tone === 'flagged') row.flagged = true;
  }
  const all = [...rows.values()];
  const rank = (r: { home: boolean; flagged: boolean }) => (r.flagged ? 0 : r.home ? 2 : 1);
  return all
    .map((r, i) => ({ r, i }))
    .sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i)
    .map(({ r }) => ({ place: r.place, chips: r.chips }));
}

/** At most MAX_ROWS rows: past that, the last row counts what's left, room by room. */
function limitRows(rows: Row[]): Row[] {
  if (rows.length <= MAX_ROWS) return rows;
  const kept = rows.slice(0, MAX_ROWS - 1);
  const rest = rows.slice(MAX_ROWS - 1);
  return [
    ...kept,
    {
      place: 'Also',
      chips: rest.map((r) => ({
        text: `${r.place}: ${count(r.chips.length, 'change', 'changes')}`,
      })),
    },
  ];
}

function place(
  target: string,
  attr: string,
  names: Names | undefined,
  routine = false,
): Omit<Placed, 'chip'> {
  if (routine || attr === 'mode' || attr === 'pausedUntil' || !names?.devices[target]) {
    return { place: 'Home', home: true };
  }
  return { place: names.devices[target].room, home: false };
}

function changeText(
  target: string,
  attr: string,
  from: Value | null,
  to: Value,
  names: Names | undefined,
  routine = false,
): string {
  if (routine || attr === 'pausedUntil') {
    return `${routineName(target, names)} ${valuePhrase('pausedUntil', to)}`;
  }
  return changePhrase(shortDevice(target, names), attr, from, to);
}

function flaggedDevices(violations: Violation[]): Set<string> {
  return new Set(violations.flatMap((v) => (v.cause?.source === 'plan' ? [v.cause.device] : [])));
}

// Cards

function card(v: Violation, p: Preview, fixes: RepairChange[], names?: Names): Card {
  const c = v.cause;
  const by = !c ? 'The plan' : c.source === 'plan' ? 'Your plan' : sourceName(c.source, names);
  const what = c ? `: ${changePhrase(deviceName(c.device, names), c.attr, c.from, c.to)}` : '';
  const fix = fixes.find((f) => f.rule === v.rule);
  const fixText = fix ? fixLabel(fix, p, names) : undefined;
  return {
    id: v.rule,
    cause: `${by}${what}`,
    at: when(c?.at ?? v.firstAt, p.horizon.start),
    ...(c && !sameMinute(c.at, v.firstAt) ? { breaks: `Breaks ${clock(v.firstAt)}` } : {}),
    rule: v.text,
    author: memberName(v.author, names),
    ...(fixText ? { fix: fixText } : {}),
  };
}

/** "Garage freezer stays on", "Coffee at 7 paused until Sun 6:00 PM", "Garage heater holds 5 °C". */
export function fixLabel(f: RepairChange, p: Preview, names?: Names): string {
  const rows = p.repair?.diff.filter((r) => r.target === f.target) ?? [];
  switch (f.kind) {
    case 'pause_routine': {
      const until = rows.find((r) => r.attr === 'pausedUntil')?.to;
      return `${routineName(f.target, names)} ${valuePhrase('pausedUntil', until ?? null).replace('not set', 'paused')}`;
    }
    case 'nearest_value': {
      const setpoint = rows.find((r) => r.attr === 'heatingSetpointC');
      if (!setpoint) return f.description;
      return `${deviceName(f.target, names)} holds ${valuePhrase(setpoint.attr, setpoint.to)}`;
    }
    case 'leave_out':
    case 'drop_action': {
      const kept = keptRows(p, f);
      return kept.length > 0
        ? kept.map((r) => stays(r, names, false)).join(', ')
        : `${deviceName(f.target, names)} left as it is`;
    }
  }
}

// Timeline

function timelineFor(p: Preview, names?: Names): { timeline?: Timeline } {
  const startMs = Date.parse(p.horizon.start);
  const endMs = Date.parse(p.horizon.end);
  if (!(endMs - startMs >= 60_000)) return {};
  const bySource = new Map<string, Map<number, string[]>>();
  for (const e of p.timeline) {
    const atMs = Date.parse(e.at);
    let lane = bySource.get(e.source);
    if (!lane) {
      lane = new Map();
      bySource.set(e.source, lane);
    }
    const label = changeText(e.device, e.attr, e.from, e.to, names, e.attr === 'pausedUntil');
    lane.set(atMs, [...(lane.get(atMs) ?? []), label]);
  }
  const marks = (byTime: Map<number, string[]>): Mark[] =>
    [...byTime].map(([atMs, labels]) => ({
      atMs,
      label: labels.length === 1 ? (labels[0] ?? '') : count(labels.length, 'change', 'changes'),
    }));
  const lanes: Lane[] = [];
  const plan = bySource.get('plan');
  if (plan) lanes.push({ label: 'Your plan', marks: marks(plan) });
  const others = [...bySource].filter(([source]) => source !== 'plan');
  for (const [source, byTime] of others.slice(0, MAX_ROUTINE_LANES)) {
    lanes.push({ label: sourceName(source, names), marks: marks(byTime) });
  }
  if (p.violations.length > 0) {
    // Rules that break in the same minute share one mark: "R1, R2 break".
    const byMinute = new Map<number, string[]>();
    for (const v of p.violations) {
      const minute = Math.floor(Date.parse(v.firstAt) / 60_000) * 60_000;
      byMinute.set(minute, [...(byMinute.get(minute) ?? []), v.rule]);
    }
    lanes.push({
      label: 'House rules',
      marks: [...byMinute].map(([atMs, rules]) => ({
        atMs,
        label: `${rules.join(', ')} ${rules.length === 1 ? 'breaks' : 'break'}`,
        tone: 'blocked' as const,
      })),
    });
  }
  if (lanes.length === 0) return {};
  return { timeline: { startMs, endMs, days: midnights(p.horizon.start, p.horizon.end), lanes } };
}

// Names

function deviceName(id: string, names?: Names): string {
  if (id === 'home') return 'Home mode';
  return names?.devices[id]?.name ?? id;
}

function shortDevice(id: string, names?: Names): string {
  const d = names?.devices[id];
  return d ? shortName(d.name, d.room) : deviceName(id, names);
}

function routineName(id: string, names?: Names): string {
  return names?.routines[id] ?? id;
}

function memberName(id: string, names?: Names): string {
  return names?.members[id] ?? capitalise(id);
}

/** A timeline source: a routine's name, or "Scheduled" for a held write from an earlier commit. */
function sourceName(source: string, names?: Names): string {
  if (names?.routines[source]) return names.routines[source];
  if (source.startsWith('plan:')) return 'Scheduled';
  return source;
}

/** Swap device IDs in a server message for their names: "dishwasher_latch battery 4%". */
function withNames(text: string, names?: Names): string {
  if (!names) return text;
  return text.replace(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g, (id) => names.devices[id]?.name ?? id);
}
