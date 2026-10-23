import { Vector3 } from 'three';
import { describe, expect, test } from 'vitest';
import { glide, keepInside, panBounds, poseOf, positionOf, shortestTurn } from './orbit.ts';

const house = { min: new Vector3(0, 0, 0), max: new Vector3(15.5, 2.6, 9) };

describe('where the person may look', () => {
  test('the house and a margin round it, from the floor up', () => {
    const b = panBounds(house);
    expect(b.min.toArray()).toEqual([-2, 0, -2]);
    expect(b.max.toArray()).toEqual([17.5, 3.6, 11]);
  });

  test('a target inside stays put', () => {
    const target = new Vector3(5, 1, 5);
    const position = new Vector3(5, 20, 30);
    expect(keepInside(target, position, panBounds(house))).toBe(false);
    expect(target.toArray()).toEqual([5, 1, 5]);
    expect(position.toArray()).toEqual([5, 20, 30]);
  });

  test('a target panned out is brought back, and the camera slides with it', () => {
    const target = new Vector3(40, -3, 5);
    const position = new Vector3(40, 17, 35);
    expect(keepInside(target, position, panBounds(house))).toBe(true);
    expect(target.toArray()).toEqual([17.5, 0, 5]);
    expect(position.toArray()).toEqual([17.5, 20, 35]);
  });
});

describe('gliding the camera back', () => {
  test('turns the short way round', () => {
    expect(shortestTurn(0.1, 0.3)).toBeCloseTo(0.2);
    expect(shortestTurn(3, -3)).toBeCloseTo(2 * Math.PI - 6);
    expect(shortestTurn(-3, 3)).toBeCloseTo(6 - 2 * Math.PI);
    expect(shortestTurn(0, 4 * Math.PI + 0.5)).toBeCloseTo(0.5);
  });

  test('all the way lands exactly on the goal', () => {
    const now = poseOf(new Vector3(-20, 5, -20), new Vector3(2, 0, 2));
    const goal = poseOf(new Vector3(10, 25, 35), new Vector3(7, 1, 4));
    glide(now, goal, 1);
    const at = positionOf(now);
    expect(at.x).toBeCloseTo(10);
    expect(at.y).toBeCloseTo(25);
    expect(at.z).toBeCloseTo(35);
    expect(now.target.toArray()).toEqual([7, 1, 4]);
  });

  test('from behind the house it swings round, keeping its distance, not through the walls', () => {
    const target = new Vector3(0, 0, 0);
    const now = poseOf(new Vector3(0, 10, -30), target);
    const goal = poseOf(new Vector3(0, 10, 30), target);
    const r = now.offset.radius;
    for (let i = 0; i < 5; i++) {
      glide(now, goal, 0.3);
      expect(positionOf(now).distanceTo(target)).toBeCloseTo(r);
    }
  });

  test('the same steps give the same path', () => {
    const run = () => {
      const now = poseOf(new Vector3(-20, 5, -20), new Vector3(2, 0, 2));
      const goal = poseOf(new Vector3(10, 25, 35), new Vector3(7, 1, 4));
      for (let i = 0; i < 4; i++) glide(now, goal, 0.25);
      return positionOf(now).toArray();
    };
    expect(run()).toEqual(run());
  });
});
