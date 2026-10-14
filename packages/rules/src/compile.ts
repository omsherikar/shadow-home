import { createHash } from 'node:crypto';
import { type CompiledRule, type Cond, compiledRuleSchema, type Home } from '@shadow-home/twin';
import { z } from 'zod';

/** One compile's answer: the rule as a template, or why the sentence fits none. */
export const compileAnswerSchema = z.object({
  rule: compiledRuleSchema
    .nullable()
    .describe('The rule as one of the five templates, or null if it fits none'),
  unsupported: z
    .string()
    .nullable()
    .describe('When rule is null: why, in one short sentence. Otherwise null.'),
});
export type CompileAnswer = z.infer<typeof compileAnswerSchema>;

/** One compiler: a model reading the person's sentence against the home. */
export type Compile = (input: { text: string; author: string; home: Home }) => Promise<unknown>;

export type CompileOutcome =
  /** Every compiler produced the same rule. */
  | { status: 'agreed'; rule: CompiledRule; hash: string }
  /** They read it differently: each distinct reading, so the person can say which they meant. */
  | { status: 'disagree'; readings: CompiledRule[]; unsupported: string[] }
  /** None could express it with the templates. */
  | { status: 'unsupported'; reason: string }
  /** A compiler didn't answer, or answered something that isn't a rule. */
  | { status: 'failed'; problems: string[] };

/**
 * Compile the sentence with each compiler (three by default, each a different model) and keep the
 * rule only if all of them agree on it exactly, after putting each into one normal form. A rule
 * that depends on which model read it is a rule nobody can be sure of.
 */
export async function compileRule(
  input: { text: string; author: string; home: Home },
  compilers: Compile[],
): Promise<CompileOutcome> {
  if (compilers.length === 0) return { status: 'failed', problems: ['No rule compilers'] };
  const settled = await Promise.allSettled(compilers.map((c) => c(input)));
  const problems: string[] = [];
  const answers: CompileAnswer[] = [];
  settled.forEach((s, i) => {
    if (s.status === 'rejected') {
      problems.push(
        `compiler ${i + 1}: ${s.reason instanceof Error ? s.reason.message : s.reason}`,
      );
      return;
    }
    const parsed = compileAnswerSchema.safeParse(s.value);
    if (!parsed.success) {
      problems.push(`compiler ${i + 1}: not a rule (${parsed.error.issues[0]?.message ?? ''})`);
    } else answers.push(parsed.data);
  });
  if (problems.length > 0) return { status: 'failed', problems };

  const rules = answers.flatMap((a) => (a.rule ? [normalize(a.rule)] : []));
  const unsupported = answers.flatMap((a) => (a.rule ? [] : [a.unsupported ?? 'no reason given']));
  if (rules.length === 0) return { status: 'unsupported', reason: unsupported[0] ?? '' };
  const byHash = new Map(rules.map((r) => [ruleHash(r), r]));
  const [only] = [...byHash.entries()];
  if (unsupported.length === 0 && byHash.size === 1 && only) {
    return { status: 'agreed', rule: only[1], hash: only[0] };
  }
  return { status: 'disagree', readings: [...byHash.values()], unsupported };
}

/**
 * One normal form for a compiled rule, so two compiles that mean the same thing compare equal:
 * object keys in order, "any"/"all" and "ensure" lists sorted, "neq" on a true/false attribute
 * turned into "eq" of the other value, `not` around a single state turned into "neq", `not`
 * around presence turned into the opposite presence, one-item "any"/"all" unwrapped, the two sides
 * of "never_together" in order, and "refuse" only when true.
 */
export function normalize(rule: CompiledRule): CompiledRule {
  const out = structuredClone(rule) as CompiledRule & { refuse?: boolean };
  if (!out.refuse) delete out.refuse;
  const p = out.params as Record<string, unknown>;
  for (const k of ['state', 'x', 'when', 'after', 'a', 'b']) {
    if (p[k] && typeof p[k] === 'object') p[k] = normalCond(p[k] as Cond);
  }
  if (Array.isArray(p.ensure)) {
    p.ensure = (p.ensure as Cond[]).map(normalCond).sort((a, b) => cmp(canonical(a), canonical(b)));
  }
  // The engine breaks "never_together" when both sides hold, so which side is "a" means nothing.
  if (out.template === 'never_together') {
    [p.a, p.b] = [p.a, p.b].sort((a, b) => cmp(canonical(a), canonical(b)));
  }
  return out;
}

function normalCond(c: Cond): Cond {
  if ('any' in c || 'all' in c) {
    const key = 'any' in c ? 'any' : 'all';
    const items = ('any' in c ? c.any : c.all)
      .map(normalCond)
      .sort((a, b) => cmp(canonical(a), canonical(b)));
    const [single] = items;
    if (items.length === 1 && single) return single;
    return (key === 'any' ? { any: items } : { all: items }) as Cond;
  }
  if ('not' in c) {
    const inner = normalCond(c.not);
    if ('device' in inner && 'eq' in inner) {
      return normalCond({ device: inner.device, attr: inner.attr, neq: inner.eq });
    }
    if ('device' in inner && 'neq' in inner) {
      return { device: inner.device, attr: inner.attr, eq: inner.neq };
    }
    // Presence is never unknown: a member is home or away, and someone is home or nobody is. So
    // "not home" is "away" on every input the engine sees, and "not nobody" is "anyone".
    if ('presence' in inner) {
      const p = inner.presence;
      if (p === 'nobody') return { presence: 'anyone' };
      if (p === 'anyone') return { presence: 'nobody' };
      return { presence: { member: p.member, is: p.is === 'home' ? 'away' : 'home' } };
    }
    return { not: inner };
  }
  if ('device' in c && 'neq' in c && typeof c.neq === 'boolean') {
    return { device: c.device, attr: c.attr, eq: !c.neq };
  }
  return c;
}

/** JSON with object keys sorted at every level. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => cmp(a, b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The hash the compilers agreed on: SHA-256 of the normal form, first 16 hex digits. */
export function ruleHash(rule: CompiledRule): string {
  return createHash('sha256')
    .update(canonical(normalize(rule)))
    .digest('hex')
    .slice(0, 16);
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
