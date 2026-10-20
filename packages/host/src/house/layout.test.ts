import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { houseLayout as layout } from './layout.ts';

const root = join(import.meta.dirname, '../../../..');
const publicDir = join(import.meta.dirname, '../../public');
const home = JSON.parse(readFileSync(join(root, 'fixtures/demo-home.json'), 'utf8')) as {
  rooms: { id: string; name: string }[];
  devices: { id: string; room: string }[];
  household: { members: { id: string }[] };
};

const roomOf = (id: string) => layout.rooms.find((r) => r.id === id);
const inside = (roomId: string, x: number, z: number, slack = 0.2) => {
  const r = roomOf(roomId);
  return (
    r !== undefined &&
    x >= r.x - slack &&
    x <= r.x + r.width + slack &&
    z >= r.z - slack &&
    z <= r.z + r.depth + slack
  );
};

describe('the house layout', () => {
  test('every device in the demo home has one place, and every place is a real device', () => {
    const placed = layout.devices.map((d) => d.device).sort();
    expect(placed).toEqual(home.devices.map((d) => d.id).sort());
  });

  test('its rooms are the demo home’s rooms, with their names', () => {
    expect(layout.rooms.map((r) => [r.id, r.name]).sort()).toEqual(
      home.rooms.map((r) => [r.id, r.name]).sort(),
    );
  });

  test('each device sits in the room the home puts it in (the porch light on the path outside)', () => {
    for (const d of layout.devices) {
      const room = home.devices.find((f) => f.id === d.device)?.room ?? '';
      const slack = d.shape === 'porch_light' ? 0.7 : 0.2;
      expect(inside(room, d.x, d.z, slack), `${d.device} in ${room}`).toBe(true);
    }
  });

  test('furniture and built pieces sit in their rooms', () => {
    for (const p of [...layout.props, ...layout.built]) {
      expect(inside(p.room, p.x, p.z), `${'model' in p ? p.model : p.shape} in ${p.room}`).toBe(
        true,
      );
    }
  });

  test('no two rooms overlap', () => {
    for (const a of layout.rooms) {
      for (const b of layout.rooms) {
        if (a === b) continue;
        const apart =
          a.x + a.width <= b.x ||
          b.x + b.width <= a.x ||
          a.z + a.depth <= b.z ||
          b.z + b.depth <= a.z;
        expect(apart, `${a.id} and ${b.id}`).toBe(true);
      }
    }
  });

  test('doors and windows name real devices', () => {
    const ids = new Set(home.devices.map((d) => d.id));
    for (const o of layout.openings) if (o.device) expect(ids.has(o.device), o.device).toBe(true);
  });

  test('its people are the household', () => {
    expect(layout.people.map((p) => p.member).sort()).toEqual(
      home.household.members.map((m) => m.id).sort(),
    );
  });

  test('every file it loads is in public/house and credited in CREDITS.md', () => {
    const credits = readFileSync(join(publicDir, 'house/CREDITS.md'), 'utf8');
    const surfaces = Object.values(layout.floors).flatMap((s) => [s.color, s.normal, s.arm]);
    const files = new Set([...layout.props.map((p) => p.model), ...surfaces, layout.environment]);
    for (const f of files) {
      expect(existsSync(join(publicDir, f)), f).toBe(true);
      expect(credits, f).toContain(f.split('/').at(-1));
    }
  });
});
