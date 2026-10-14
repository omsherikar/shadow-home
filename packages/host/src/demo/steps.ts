import type { Beat } from '../turn/scripted.ts';

/**
 * What the person answers in the recorded demo, after each beat's own lines in
 * fixtures/demo-script.json: yes to the weekend fixes, no to running the dishwasher blind, and
 * yes to the undo.
 */
export const ANSWERS: Record<string, string[]> = {
  weekend_away: ['Yes.'],
  dishwasher_2am: ['No.'],
  what_changed_and_undo: ['Yes.'],
};

export interface DemoStep {
  beat: string;
  line: string;
}

/** Every line of the demo in order: each beat's lines, then the person's answers. */
export function demoSteps(beats: Beat[]): DemoStep[] {
  return beats.flatMap((b) =>
    [...[b.say].flat(), ...(ANSWERS[b.id] ?? [])].map((line) => ({ beat: b.id, line })),
  );
}
