/**
 * The way each member of the household walks out of the front door: from their place, through the
 * doorways between rooms, out onto the path. The house shows them leaving (and coming back the
 * same way) when the presence the check used says they go; it has no room-by-room data, so they
 * take the shortest way out through the doorways.
 */
import type { HouseLayout, Opening, Room } from './layout.ts';

export interface Point {
  x: number;
  z: number;
}

const EDGE = 0.001;

/** The room a point is in, edges included. */
function roomAt(layout: HouseLayout, p: Point): Room | undefined {
  return layout.rooms.find(
    (r) =>
      p.x >= r.x - EDGE &&
      p.x <= r.x + r.width + EDGE &&
      p.z >= r.z - EDGE &&
      p.z <= r.z + r.depth + EDGE,
  );
}

/** The rooms an opening in a wall joins: one on either side of it (one alone for an outside wall). */
function roomsBeside(layout: HouseLayout, o: Opening): Room[] {
  const alongX = o.from.z === o.to.z;
  const lo = alongX ? Math.min(o.from.x, o.to.x) : Math.min(o.from.z, o.to.z);
  const hi = alongX ? Math.max(o.from.x, o.to.x) : Math.max(o.from.z, o.to.z);
  const at = alongX ? o.from.z : o.from.x;
  return layout.rooms.filter((r) => {
    const [start, size, a, b] = alongX
      ? [r.z, r.depth, r.x, r.x + r.width]
      : [r.x, r.width, r.z, r.z + r.depth];
    const onEdge = Math.abs(start - at) < EDGE || Math.abs(start + size - at) < EDGE;
    return onEdge && a < hi - EDGE && b > lo + EDGE;
  });
}

const middle = (o: Opening): Point => ({ x: (o.from.x + o.to.x) / 2, z: (o.from.z + o.to.z) / 2 });

/**
 * A member's way out: their place, the middle of each doorway on the way, a step inside the front
 * door, the door, and a little way down the path outside. Empty if they or the door have no place.
 */
export function routeOut(layout: HouseLayout, member: string): Point[] {
  const person = layout.people.find((p) => p.member === member);
  const door = layout.openings.find((o) => o.kind === 'door' && o.device === 'front_door_lock');
  if (!person || !door) return [];
  const hall = roomsBeside(layout, door)[0];
  const start = roomAt(layout, person);
  if (!hall || !start) return [];
  // Breadth first through the doorways, from their room to the one with the front door.
  const doorways = layout.openings.filter((o) => o.kind === 'doorway');
  const via = new Map<string, { from: string; through: Opening } | null>([[start.id, null]]);
  const queue = [start.id];
  while (queue.length > 0 && !via.has(hall.id)) {
    const here = queue.shift() as string;
    for (const o of doorways) {
      const [a, b] = roomsBeside(layout, o);
      if (!a || !b) continue;
      const next = a.id === here ? b.id : b.id === here ? a.id : undefined;
      if (next && !via.has(next)) {
        via.set(next, { from: here, through: o });
        queue.push(next);
      }
    }
  }
  if (!via.has(hall.id)) return [];
  const through: Point[] = [];
  for (let at = via.get(hall.id); at; at = via.get(at.from)) through.unshift(middle(at.through));
  // Inside and outside of the front door: across the wall it sits in, away from the hall.
  const d = middle(door);
  const alongX = door.from.z === door.to.z;
  const inward = alongX
    ? Math.sign(hall.z + hall.depth / 2 - d.z)
    : Math.sign(hall.x + hall.width / 2 - d.x);
  const step = (n: number): Point =>
    alongX ? { x: d.x, z: d.z + inward * n } : { x: d.x + inward * n, z: d.z };
  return [{ x: person.x, z: person.z }, ...through, step(0.7), d, step(-1.3)];
}
