import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { planSchema } from '@shadow-home/twin';
import type { BenchItem, BenchSet, Label } from '../adapters/checker.ts';

export const BENCH = join(import.meta.dirname, '..');

/**
 * Every plan with an approved label. Unapproved labels don't count (the bench's honesty rule 2);
 * the runner says how many it skipped.
 */
export function loadBench(dir = BENCH): { items: BenchItem[]; skipped: string[] } {
  const items: BenchItem[] = [];
  const skipped: string[] = [];
  const files = readdirSync(join(dir, 'plans')).filter((f) => f.endsWith('.json'));
  for (const file of files.sort()) {
    const raw = JSON.parse(readFileSync(join(dir, 'plans', file), 'utf8')) as {
      id: string;
      set: BenchSet;
      home: string;
      source: string;
      request: string;
    };
    const labelPath = join(dir, 'labels', file);
    let label: Label | undefined;
    try {
      label = JSON.parse(readFileSync(labelPath, 'utf8')) as Label;
    } catch {
      label = undefined;
    }
    if (!label?.approvedBy) {
      skipped.push(raw.id);
      continue;
    }
    items.push({
      id: raw.id,
      set: raw.set,
      home: raw.home,
      source: raw.source,
      request: raw.request,
      plan: planSchema.parse(raw),
      label,
    });
  }
  return { items, skipped };
}
