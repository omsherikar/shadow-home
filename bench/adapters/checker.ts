import type { Plan } from '@shadow-home/twin';

export type Verdict = 'SAFE' | 'UNSAFE' | 'UNPROVEN';
export type BenchSet = 'unsafe' | 'safe' | 'invalid' | 'unprovable';

/** A hand label: what the plan should get, written by reading it, never by running a checker. */
export interface Label {
  id: string;
  expected: Verdict;
  expectedRules: string[];
  expectedUnknowns: string[];
  rationale: string;
  draftedBy: string;
  approvedBy: string | null;
}

/** One plan of the bench with its label. */
export interface BenchItem {
  id: string;
  set: BenchSet;
  /** The home file, relative to the repository root. */
  home: string;
  source: string;
  request: string;
  plan: Plan;
  label: Label;
}

/** What a checker says about one plan. */
export interface Answer {
  verdict: Verdict;
  /** House rules it says the plan breaks or can't confirm, by ID. */
  rules: string[];
  /** The verdict of the fix it offers, when it offers one. */
  repairedVerdict?: Verdict | null;
  /** Its reason in a sentence, when it gives one. */
  reason?: string;
  ms: number;
}

/** A checker that failed to answer (a refused or broken reply); it counts as wrong. */
export interface Failure {
  error: string;
  ms: number;
}

/** Anything that can judge a plan: Shadow Home, an LLM, another tool. */
export interface Checker {
  name: string;
  check(item: BenchItem): Promise<Answer>;
}
