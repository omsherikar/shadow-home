import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { houseLayout as layout } from './layout.ts';

const root = join(import.meta.dirname, '../../../..');
const home = JSON.parse(readFileSync(join(root, 'fixtures/demo-home.json'), 'utf8')) as {
  rooms: { id: string; name: string }[];
  devices: { id: string; room: string }[];
  household: { members: { id: string }[] };
};

describe('the house layout', () => {
  test('every device in the demo home has one place, and every place is a real device', () => {
    const placed = layout.devices.map((d) => d.device).sort();
    expect(placed).toEqual(home.devices.map((d) => d.id).sort());
  });
});
