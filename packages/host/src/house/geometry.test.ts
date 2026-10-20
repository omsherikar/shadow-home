import { describe, expect, test } from 'vitest';
import { wallPieces } from './geometry.ts';
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
});
