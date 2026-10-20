import { type Home, own, type Plan, type Value } from '@shadow-home/twin';
import type { DiffRow } from './diff.ts';
import { ruleDevices } from './rules.ts';
import type { TierResult } from './tier.ts';
import type { CheckResult, Reason, Verdict } from './verdict.ts';

/** What Alexa speaks from. Data, not a script: each field fits in one breath. */
export interface Speech {
  /** At most 15 words. */
  headline: string;
  /** Why, at most 25 words. Absent for a plain SAFE. */
  reason?: string;
  /** The one question to ask, at most 25 words. Absent when nothing needs asking. */
  ask?: string;
}

export const SPEECH_LIMITS = { headline: 15, reason: 25, ask: 25 } as const;

export function wordCount(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

/** An alternative the preview can offer instead of the plan as asked. */
export interface OfferedAlternative {
  verdict: Verdict;
  tier: TierResult;
  diff: readonly DiffRow[];
  /** Number of repairs; 0 for the safe part. */
  fixes: number;
}

export interface Alternatives {
  repair: OfferedAlternative | null;
  safePart: OfferedAlternative | null;
}

/**
 * Which alternative the preview's question offers: for T3 a SAFE repair, else the safe part; for
 * T4 the safe part. A yes to that question is a yes to that alternative.
 */
export function offeredAlternative(
  tier: TierResult,
  alternatives: Alternatives,
): 'repair' | 'safe_part' | null {
  if (tier.tier === 'T3' && alternatives.repair?.verdict === 'SAFE') return 'repair';
  if ((tier.tier === 'T3' || tier.tier === 'T4') && alternatives.safePart) return 'safe_part';
  return null;
}

export function speech(
  home: Home,
  plan: Plan,
  result: CheckResult,
  tier: TierResult,
  diff: readonly DiffRow[],
  alternatives: Alternatives = { repair: null, safePart: null },
): Speech {
  const name = (id: string) => home.household.members.find((m) => m.id === id)?.name ?? id;
  const top = result.reasons[0];
  const offered = offeredAlternative(tier, alternatives);
  // A yes to "do it with the fix?" commits the fix, so the question carries the fix's own
  // consequence when it needs one (T2): the person hears it before saying yes.
  const offer = (question: string) => {
    const alt = offered === 'repair' ? alternatives.repair : alternatives.safePart;
    return alt?.tier.tier === 'T2' ? `${question} ${consequence(alt.tier, alt.diff)}` : question;
  };
  const out: Speech = (() => {
    if (leaving(plan)) {
      const fix = offered === 'repair' ? alternatives.repair : null;
      const words = beforeYouGo(home, plan, result, fix, name, offer);
      if (words) return words;
    }
    switch (tier.tier) {
      case 'T5':
        return {
          headline: "I can't do that.",
          reason: top && 'text' in top && top.text ? `${top.text} ${ownedBy(top, name)}` : '',
        };
      case 'T3': {
        const broken = result.reasons.filter((r) => r.kind === 'violation').length;
        const headline =
          broken === 0
            ? "I can't do that as asked."
            : broken === 1
              ? 'Blocked: that breaks a house rule.'
              : `Blocked: that breaks ${broken} house rules.`;
        const fixes = alternatives.repair?.fixes ?? 0;
        const ask =
          offered === 'repair'
            ? offer(`Do it with ${count(fixes, 'fix', 'fixes')} instead?`)
            : offered === 'safe_part'
              ? offer('Do just the safe part?')
              : undefined;
        return { headline, reason: reasonFor(home, plan, top, name), ...(ask ? { ask } : {}) };
      }
      case 'T4':
        return {
          headline: "I can't confirm that's safe.",
          reason: reasonFor(home, plan, top, name),
          ask:
            offered === 'safe_part' ? offer('Do just the part I can confirm?') : 'Run it anyway?',
        };
      case 'T2': {
        const row = diff.find((r) => tier.sensitive.includes(r.target));
        const what = row ? phrase(row) : 'this';
        return {
          headline: `Safe, but it needs a yes: ${what}.`,
          reason:
            tier.why === 'it weakens security' ? 'This weakens security.' : "This can't be undone.",
          ask: `${capitalise(row ? phrase(row) : 'go ahead')}?`,
        };
      }
      // A preview hasn't run anything yet: "Done" belongs to the commit (see planSummary).
      case 'T1':
        return {
          headline: `Safe: ${summary(diff)}.`,
          reason: `This affects ${list(tier.affects.map(name))}.`,
        };
      default:
        return { headline: `Safe: ${summary(diff)}.` };
    }
  })();
  return fit(out);
}

/** Someone leaving with nothing to change ("I'm heading out"): no actions, and someone away. */
function leaving(plan: Plan): boolean {
  return (
    plan.actions.length === 0 &&
    (plan.context.presenceSchedule ?? []).some((w) => w.presence !== 'everyone')
  );
}

/**
 * The check as someone leaves: what's still wrong in the house, and an offer to put it right
 * ("Before you go: Bedroom space heater on and Back door lock unlocked."). Nothing to run means
 * nothing to ask when the house is fine or can't be confirmed. Undefined when the usual words fit
 * (a schedule lint rejects).
 */
function beforeYouGo(
  home: Home,
  plan: Plan,
  result: CheckResult,
  fix: OfferedAlternative | null,
  name: (id: string) => string,
  offer: (question: string) => string,
): Speech | undefined {
  const top = result.reasons[0];
  if (result.verdict === 'SAFE') {
    return { headline: "You're all set: nothing needs changing before you go." };
  }
  if (result.verdict === 'UNPROVEN') {
    return {
      headline: "Before you go: I can't confirm the house will be safe.",
      reason: reasonFor(home, plan, top, name),
    };
  }
  const broken = result.reasons.filter((r) => r.kind === 'violation').length;
  if (broken === 0) return undefined;
  const reason = reasonFor(home, plan, top, name);
  const wrong = (fix?.diff ?? []).map(leftWrong);
  if (!fix || wrong.length === 0) {
    const rules = count(broken, 'house rule', 'house rules');
    return { headline: `Before you go: ${rules} would break while you're out.`, reason };
  }
  // Name two, or one if two don't fit in a headline, and count the rest.
  const named = (k: number) =>
    list([...wrong.slice(0, k), ...(wrong.length > k ? [`${wrong.length - k} more`] : [])]);
  let headline = `Before you go: ${named(2)}.`;
  if (wordCount(headline) > SPEECH_LIMITS.headline) headline = `Before you go: ${named(1)}.`;
  const n = fix.fixes;
  const ask = n === 1 ? 'Shall I fix it?' : n === 2 ? 'Shall I fix both?' : `Shall I fix all ${n}?`;
  return { headline, reason, ask: offer(ask) };
}

/** What a fix for someone leaving puts right, as it is now: "Back door lock unlocked". */
function leftWrong(row: DiffRow): string {
  if (row.kind === 'routine') return `${row.name} runs while you're out`;
  return row.from === null
    ? `${row.name} needs a change`
    : `${row.name} ${valuePhrase(row.attr, row.from)}`;
}

/** What a T2 plan's yes agrees to: "That leaves Back door lock unlocked." */
function consequence(tier: TierResult, diff: readonly DiffRow[]): string {
  if (tier.why !== 'it weakens security') return "That can't be undone.";
  const row = diff.find((r) => tier.sensitive.includes(r.target));
  return row ? `That leaves ${phrase(row)}.` : 'That weakens security.';
}

/** "Never turn off the garage freezer. That's Om's rule." or why a check is unknown. */
function reasonFor(
  home: Home,
  plan: Plan,
  r: Reason | undefined,
  name: (id: string) => string,
): string {
  if (!r) return '';
  if (r.kind === 'invalid') return r.message;
  if (r.kind === 'unknown') {
    if (!r.rule) return `I can't see far enough ahead: ${r.message}.`;
    const sensors = untrustedNames(home, plan, r.rule);
    return sensors.length > 0
      ? `${sensors.join(' and ')}, so I can't check "${trimStop(r.text ?? '')}".`
      : `I can't check "${trimStop(r.text ?? '')}".`;
  }
  const rule = `${r.text} ${ownedBy(r, name)}`;
  return r.kind === 'not_robust' ? `${rule} It could break if it's colder than forecast.` : rule;
}

function ownedBy(r: Reason, name: (id: string) => string): string {
  return 'author' in r && r.author ? `That's ${name(r.author)}'s rule.` : '';
}

/** "Dishwasher door latch battery is at 4%" for each untrusted sensor the rule reads. */
function untrustedNames(home: Home, plan: Plan, ruleId: string): string[] {
  const rule = home.rules.find((x) => x.id === ruleId);
  if (!rule) return [];
  const ids = new Set(ruleDevices(home, rule));
  const { lowBatteryPercent, staleSensorMinutes } = home.simulation;
  const out: string[] = [];
  for (const device of home.devices) {
    if (!ids.has(device.id) || !device.sensor) continue;
    const s = { ...device.sensor, ...own(plan.context.stateOverrides ?? {}, device.id)?.sensor };
    if (s.batteryPercent != null && s.batteryPercent < lowBatteryPercent) {
      out.push(`${device.name} battery is at ${s.batteryPercent}%`);
    } else if (
      s.lastReportMinutesAgo !== undefined &&
      s.lastReportMinutesAgo > staleSensorMinutes
    ) {
      out.push(`${device.name} hasn't reported for ${s.lastReportMinutesAgo} minutes`);
    }
  }
  return out;
}

/** "Living room lights brightness to 30", "Front door lock unlocked". */
function phrase(row: DiffRow): string {
  if (row.kind === 'mode') return `home mode to ${String(row.to)}`;
  if (row.kind === 'routine') return `pause ${row.name}`;
  return `${row.name} ${valuePhrase(row.attr, row.to)}`;
}

function valuePhrase(attr: string, v: Value): string {
  if (attr === 'onOff') return v ? 'on' : 'off';
  if (attr === 'lockState') return v === 'UNLOCKED' ? 'unlocked' : 'locked';
  if (attr === 'enabled') return v ? 'enabled' : 'disabled';
  if (attr === 'heatingSetpointC') return `to ${String(v)} °C`;
  if (attr === 'brightness') return `to ${String(v)}%`;
  if (attr === 'systemMode') return v === 'off' ? 'heating off' : `in ${String(v)} mode`;
  return `${attr} to ${String(v)}`;
}

function summary(diff: readonly DiffRow[]): string {
  return diff.length > 1 ? `${diff.length} changes, no house rule broken` : planSummary(diff);
}

/** What a plan does, in a few words: "Living room lights to 30%", "10 changes". */
export function planSummary(diff: readonly DiffRow[]): string {
  if (diff.length === 0) return 'nothing needed changing';
  if (diff.length === 1 && diff[0]) return phrase(diff[0]);
  return `${diff.length} changes`;
}

function count(n: number, one: string, many: string): string {
  return `${n === 1 ? 'one' : n} ${n === 1 ? one : many}`;
}

function list(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function trimStop(s: string): string {
  return s.replace(/[.!]$/, '');
}

/** Clip any field over its limit at a word boundary, so a long rule text can't break the contract. */
function fit(s: Speech): Speech {
  const clip = (text: string, max: number) => {
    const words = text.split(/\s+/).filter(Boolean);
    return words.length <= max ? words.join(' ') : `${words.slice(0, max - 1).join(' ')} …`;
  };
  const out: Speech = { headline: clip(s.headline, SPEECH_LIMITS.headline) };
  if (s.reason) out.reason = clip(s.reason, SPEECH_LIMITS.reason);
  if (s.ask) out.ask = clip(s.ask, SPEECH_LIMITS.ask);
  return out;
}
