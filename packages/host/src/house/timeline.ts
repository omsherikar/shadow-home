/**
 * The timeline under the house: a run's hours from start to end, with its nights shaded, a
 * marker for each moment that matters (a rule breaking, the plan acting, a routine, someone
 * leaving or coming home) and the playhead. Pure functions of the run.
 */
import { daylight, type LiveDevice } from './looks.ts';
import { twilightsBetween } from './pacing.ts';
import { type Break, homeIso, presenceAt, type Run } from './playback.ts';
import { changeWords, stepWords } from './words.ts';

export type MarkerKind = Break['kind'] | 'plan' | 'routine' | 'leaves' | 'arrives';

export interface Marker {
  atMs: number;
  kind: MarkerKind;
  /** What happens then, in plain words. */
  label: string;
}

const RULE_WORDS: Record<Break['kind'], string> = {
  violation: 'A house rule breaks',
  not_robust: 'A house rule might break',
  unknown: 'The twin can’t confirm a reading',
  guard: 'The rule starts guarding',
};

/**
 * The run's markers, earliest first: its breaks, the plan's own steps, the routines' changes, and
 * the household leaving or coming home by the presence the check used.
 */
export function markersOf(
  run: Run,
  devices: LiveDevice[] | null,
  household: Record<string, 'home' | 'away'>,
): Marker[] {
  const of = (id: string) => devices?.find((d) => d.id === id);
  const out: Marker[] = [];
  for (const b of run.breaks) {
    out.push({ atMs: b.atMs, kind: b.kind, label: b.text || RULE_WORDS[b.kind] });
  }
  for (const s of run.steps) {
    out.push({ atMs: s.atMs, kind: 'plan', label: stepWords(s.changes, devices) });
  }
  for (const c of run.changes) {
    if (c.source === 'plan' || c.device === 'home') continue;
    out.push({ atMs: c.atMs, kind: 'routine', label: changeWords(c, of(c.device)) });
  }
  const edges = [...new Set(run.presence.flatMap((w) => [w.fromMs, w.toMs]))];
  for (const at of edges) {
    if (at < run.startMs || at > run.endMs) continue;
    const home = (t: number) =>
      Object.values(presenceAt(household, run.presence, t)).filter((p) => p === 'home').length;
    const before = home(at - 1);
    const after = home(at);
    if (after < before) out.push({ atMs: at, kind: 'leaves', label: leaving(before - after) });
    if (after > before) out.push({ atMs: at, kind: 'arrives', label: arriving(after - before) });
  }
  return out
    .filter((m) => m.atMs >= run.startMs && m.atMs <= run.endMs)
    .sort((a, b) => a.atMs - b.atMs);
}

const leaving = (n: number) => (n === 1 ? 'Someone leaves' : `${n} people leave`);
const arriving = (n: number) => (n === 1 ? 'Someone comes home' : `${n} people come home`);

/** The stretches of a run that are night outside (the sky darker than half light). */
export function nightsOf(run: Run): { fromMs: number; toMs: number }[] {
  const turns = twilightsBetween(run.startMs, run.endMs, run.offset);
  const darkAt = (ms: number) => daylight(homeIso(ms, run.offset)).day < 0.5;
  const out: { fromMs: number; toMs: number }[] = [];
  let from: number | null = darkAt(run.startMs) ? run.startMs : null;
  for (const t of turns) {
    if (from === null) from = t;
    else {
      out.push({ fromMs: from, toMs: t });
      from = null;
    }
  }
  if (from !== null) out.push({ fromMs: from, toMs: run.endMs });
  return out.filter((n) => n.toMs > n.fromMs);
}
