import { describe, expect, test } from 'vitest';
import { houseLayout as layout } from './layout.ts';
import { along, type Point, routeOut } from './walk.ts';

const inside = (p: Point, r: (typeof layout.rooms)[number]) =>
  p.x >= r.x - 1e-6 &&
  p.x <= r.x + r.width + 1e-6 &&
  p.z >= r.z - 1e-6 &&
  p.z <= r.z + r.depth + 1e-6;

describe('the way out', () => {
  const door = layout.openings.find((o) => o.device === 'front_door_lock');

  test('everyone leaves through the front door, out onto the path', () => {
    for (const person of layout.people) {
      const route = routeOut(layout, person.member);
      expect(route[0], person.member).toEqual({ x: person.x, z: person.z });
      const end = route.at(-1) as Point;
      // Past the front wall, in line with the door.
      expect(end.z, person.member).toBeGreaterThan(door?.from.z ?? Number.POSITIVE_INFINITY);
      expect(end.x).toBeGreaterThanOrEqual(Math.min(door?.from.x ?? 0, door?.to.x ?? 0));
      expect(end.x).toBeLessThanOrEqual(Math.max(door?.from.x ?? 0, door?.to.x ?? 0));
    }
  });

  test('each stretch indoors stays in one room, so nobody walks through a wall', () => {
    for (const person of layout.people) {
      const route = routeOut(layout, person.member);
      // The last stretch goes through the front door to the path.
      for (let i = 0; i + 2 < route.length; i++) {
        const a = route[i] as Point;
        const b = route[i + 1] as Point;
        const shared = layout.rooms.some((r) => inside(a, r) && inside(b, r));
        expect(shared, `${person.member} ${i}`).toBe(true);
      }
    }
  });

  test('someone the layout doesn’t place has no way out to show', () => {
    expect(routeOut(layout, 'nobody')).toEqual([]);
  });
});

describe('along the way', () => {
  const route: Point[] = [
    { x: 0, z: 0 },
    { x: 3, z: 0 },
    { x: 3, z: 4 },
  ];

  test('goes by distance, start to end, facing the way it walks', () => {
    expect(along(route, 0).at).toEqual({ x: 0, z: 0 });
    expect(along(route, 3 / 7).at).toEqual({ x: 3, z: 0 });
    expect(along(route, 1).at).toEqual({ x: 3, z: 4 });
    expect(along(route, 0.2).heading).toBeCloseTo(Math.PI / 2, 9);
    expect(along(route, 0.9).heading).toBeCloseTo(0, 9);
  });
});
