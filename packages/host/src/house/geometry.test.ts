import { describe, expect, test } from 'vitest';
import { wallHeightAt, wallPieces } from './geometry.ts';
import { houseLayout as layout } from './layout.ts';

const pieces = wallPieces(layout);
const onLine = (axis: 'x' | 'z', at: number) =>
  pieces.filter((p) =>
    axis === 'x' ? p.a.z === at && p.b.z === at : p.a.x === at && p.b.x === at,
  );
const span = (p: (typeof pieces)[number]) =>
  p.a.z === p.b.z ? [p.a.x, p.b.x] : ([p.a.z, p.b.z] as [number, number]);

describe('the walls', () => {
  test('a wall two rooms share is drawn once', () => {
    // The wall between the kitchen and the living room, at z = 3.6.
    const full = onLine('x', 3.6).filter((p) => p.bottom === 0);
    for (const a of full) {
      for (const b of full) {
        if (a === b) continue;
        const [a0, a1] = span(a) as [number, number];
        const [b0, b1] = span(b) as [number, number];
        expect(a1 <= b0 || b1 <= a0, 'overlapping pieces').toBe(true);
      }
    }
  });

  test('the back walls stand full height and the rest are cut to show the rooms', () => {
    const north = onLine('x', 0);
    const front = onLine('x', 9);
    expect(north.length).toBeGreaterThan(0);
    expect(north.every((p) => p.tall && p.top <= layout.wallHeight)).toBe(true);
    expect(Math.max(...north.map((p) => p.top))).toBe(layout.wallHeight);
    expect(front.every((p) => !p.tall && p.top === layout.cutHeight)).toBe(true);
    expect(onLine('z', 15.5).every((p) => p.tall)).toBe(true);
  });

  test('a door is a gap, and a window keeps its sill and the wall above it', () => {
    // Front door at x 8.4 to 9.3 on the front wall: nothing stands in it.
    const inDoor = onLine('x', 9).filter((p) => {
      const [s, e] = span(p) as [number, number];
      return s < 9.3 && e > 8.4;
    });
    expect(inDoor).toEqual([]);
    // Bedroom window at x 13.6 to 14.8 on the back wall, from 0.9 m to 2.1 m.
    const atWindow = onLine('x', 0).filter((p) => p.a.x === 13.6 && p.b.x === 14.8);
    expect(atWindow.map((p) => [p.bottom, p.top])).toEqual([
      [0, 0.9],
      [2.1, layout.wallHeight],
    ]);
  });

  test('an opening knows how tall its wall is', () => {
    const height = (kind: string) =>
      wallHeightAt(layout, layout.openings.find((o) => o.kind === kind) as never);
    expect(height('window')).toBe(layout.wallHeight);
    expect(height('garage_door')).toBe(layout.cutHeight);
  });
});
