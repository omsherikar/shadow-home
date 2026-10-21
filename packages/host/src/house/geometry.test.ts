import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, test } from 'vitest';
import { bandBetween, frame, groundBounds, wallHeightAt, wallPieces } from './geometry.ts';
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

describe('framing', () => {
  test.each([0.7, 1, 1.6, 2.2])(
    'the whole base fits a canvas %f times as wide as tall',
    (aspect) => {
      const bounds = groundBounds(layout);
      const f = frame(bounds, new Vector3(-0.37, 0.73, 0.57), 30, aspect, 0.04, 0.08);
      const camera = new PerspectiveCamera(30, aspect, 0.1, 1000);
      camera.position.copy(f.position);
      camera.lookAt(f.target);
      camera.updateMatrixWorld();
      for (const x of [bounds.min.x, bounds.max.x]) {
        for (const y of [bounds.min.y, bounds.max.y]) {
          for (const z of [bounds.min.z, bounds.max.z]) {
            const p = new Vector3(x, y, z).project(camera);
            expect(Math.abs(p.x)).toBeLessThanOrEqual(1);
            expect(Math.abs(p.y)).toBeLessThanOrEqual(1);
          }
        }
      }
    },
  );
});

describe('a band of the picture', () => {
  test('is what a card along the top and buttons along the bottom leave clear', () => {
    expect(bandBetween(0, 0, 900)).toEqual({ center: 0, half: 1 });
    // 300 px covered at the top and 75 at the bottom of 900: the band runs from 1/3 down to 75 px up.
    const band = bandBetween(300, 75, 900);
    expect(band.center).toBeCloseTo(-0.25, 6);
    expect(band.half).toBeCloseTo(0.5833, 3);
  });
});
