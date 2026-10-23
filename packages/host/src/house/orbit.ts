import { Spherical, Vector3 } from 'three';

/**
 * The person's own view of the house: how close and how far they may bring the camera, how high
 * and low it may go, and where it may look. Kept apart from the scene so it can be tested.
 */

/** Closest the camera comes to what it looks at, in metres: about one room across. */
export const NEAREST = 5;
/** How far past the whole-house view the camera may pull back, and the house still fill some of it. */
export const FARTHEST = 1.8;
/** Highest the camera goes: nearly straight down, short of the pole where turning flips. */
export const MIN_POLAR = (4 * Math.PI) / 180;
/** Lowest it goes: just above the horizon, so never under the floor. */
export const MAX_POLAR = (84 * Math.PI) / 180;

export interface Box {
  min: Vector3;
  max: Vector3;
}

/** Where the camera may look: the house and a margin round it, from the floor to above the walls. */
export function panBounds(house: Box, margin = 2): Box {
  return {
    min: new Vector3(house.min.x - margin, 0, house.min.z - margin),
    max: new Vector3(house.max.x + margin, house.max.y + 1, house.max.z + margin),
  };
}

/**
 * Brings what the camera looks at back inside the bounds, moving the camera by the same amount so
 * the view slides rather than turns. Says whether it had to.
 */
export function keepInside(target: Vector3, position: Vector3, bounds: Box): boolean {
  const shift = target.clone().clamp(bounds.min, bounds.max).sub(target);
  if (shift.lengthSq() === 0) return false;
  target.add(shift);
  position.add(shift);
  return true;
}

/** Where the camera is, as a point it looks at and the way round, up and out from it. */
export interface Pose {
  target: Vector3;
  offset: Spherical;
}

export function poseOf(position: Vector3, target: Vector3): Pose {
  return {
    target: target.clone(),
    offset: new Spherical().setFromVector3(position.clone().sub(target)),
  };
}

export function positionOf(pose: Pose, out = new Vector3()): Vector3 {
  return out.setFromSpherical(pose.offset).add(pose.target);
}

/** The turn from one angle to another the short way round, in radians, between -π and π. */
export function shortestTurn(from: number, to: number): number {
  const d = (to - from) % (2 * Math.PI);
  if (d > Math.PI) return d - 2 * Math.PI;
  if (d < -Math.PI) return d + 2 * Math.PI;
  return d;
}

/**
 * Moves a pose a fraction `k` of the way to another: round the house rather than through it,
 * the short way, so a camera taken back from behind the house swings back to the front.
 */
export function glide(now: Pose, goal: Pose, k: number): void {
  now.target.lerp(goal.target, k);
  now.offset.radius += (goal.offset.radius - now.offset.radius) * k;
  now.offset.phi += (goal.offset.phi - now.offset.phi) * k;
  now.offset.theta += shortestTurn(now.offset.theta, goal.offset.theta) * k;
}
