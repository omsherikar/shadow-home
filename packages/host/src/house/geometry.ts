import { Vector3 } from 'three';
import type { HouseLayout } from './layout.ts';

/** One straight run of wall, from `bottom` to `top`, centred on the line from a to b. */
export interface WallPiece {
  a: { x: number; z: number };
  b: { x: number; z: number };
  bottom: number;
  top: number;
  /** A full-height back wall, rather than one cut to show the rooms. */
  tall: boolean;
  /** The piece reaches the top of its wall, so it shows the cut. */
  capped: boolean;
  /** Each end meets another wall rather than a door or window, so it runs on to close the corner. */
  joinA: boolean;
  joinB: boolean;
}

const mm = (n: number) => Math.round(n * 1000) / 1000;

/**
 * The house's walls: every room edge, with shared edges drawn once, cut where doors and windows
 * are (keeping the sill below a window and the lintel above a door). The back walls (the plan's
 * north and east edges) stand full height; the rest stop at the cut, so the rooms show.
 */
export function wallPieces(layout: HouseLayout): WallPiece[] {
  const lines = new Map<string, { axis: 'x' | 'z'; at: number; spans: [number, number][] }>();
  const add = (axis: 'x' | 'z', at: number, from: number, to: number) => {
    const key = `${axis}:${mm(at)}`;
    const line = lines.get(key) ?? { axis, at: mm(at), spans: [] };
    line.spans.push([mm(Math.min(from, to)), mm(Math.max(from, to))]);
    lines.set(key, line);
  };
  for (const r of layout.rooms) {
    // A wall along x sits at a fixed z, and the reverse.
    add('x', r.z, r.x, r.x + r.width);
    add('x', r.z + r.depth, r.x, r.x + r.width);
    add('z', r.x, r.z, r.z + r.depth);
    add('z', r.x + r.width, r.z, r.z + r.depth);
  }
  const north = Math.min(...layout.rooms.map((r) => r.z));
  const east = Math.max(...layout.rooms.map((r) => r.x + r.width));

  const pieces: WallPiece[] = [];
  for (const line of lines.values()) {
    const tall = line.axis === 'x' ? line.at === mm(north) : line.at === mm(east);
    const height = tall ? layout.wallHeight : layout.cutHeight;
    const point = (t: number) => (line.axis === 'x' ? { x: t, z: line.at } : { x: line.at, z: t });
    const holes = layout.openings
      .filter((o) =>
        line.axis === 'x'
          ? mm(o.from.z) === line.at && mm(o.to.z) === line.at
          : mm(o.from.x) === line.at && mm(o.to.x) === line.at,
      )
      .map((o) => {
        const [s, e] = line.axis === 'x' ? [o.from.x, o.to.x] : [o.from.z, o.to.z];
        return { from: mm(Math.min(s, e)), to: mm(Math.max(s, e)), bottom: o.bottom, top: o.top };
      })
      .sort((p, q) => p.from - q.from);
    const piece = (
      s: number,
      e: number,
      bottom: number,
      top: number,
      joinA: boolean,
      joinB: boolean,
    ) =>
      pieces.push({
        a: point(s),
        b: point(e),
        bottom,
        top,
        tall,
        capped: top >= height,
        joinA,
        joinB,
      });
    for (const [from, to] of merge(line.spans)) {
      let cursor = from;
      for (const h of holes) {
        if (h.to <= from || h.from >= to) continue;
        if (h.from > cursor) piece(cursor, h.from, 0, height, cursor === from, false);
        // Below a window, and above a door or window where the wall runs higher than it.
        if (h.bottom > 0) piece(h.from, h.to, 0, Math.min(h.bottom, height), false, false);
        if (h.top < height) piece(h.from, h.to, h.top, height, false, false);
        cursor = Math.max(cursor, h.to);
      }
      if (cursor < to) piece(cursor, to, 0, height, cursor === from, true);
    }
  }
  return pieces;
}

/** How high the wall an opening sits in stands: full height on the back walls, else the cut. */
export function wallHeightAt(
  layout: HouseLayout,
  opening: HouseLayout['openings'][number],
): number {
  const north = Math.min(...layout.rooms.map((r) => r.z));
  const east = Math.max(...layout.rooms.map((r) => r.x + r.width));
  const onNorth = mm(opening.from.z) === mm(north) && mm(opening.to.z) === mm(north);
  const onEast = mm(opening.from.x) === mm(east) && mm(opening.to.x) === mm(east);
  return onNorth || onEast ? layout.wallHeight : layout.cutHeight;
}

/** Overlapping or touching spans joined into one. */
function merge(spans: [number, number][]): [number, number][] {
  const sorted = [...spans].sort((p, q) => p[0] - q[0]);
  const out: [number, number][] = [];
  for (const [from, to] of sorted) {
    const last = out.at(-1);
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else out.push([from, to]);
  }
  return out;
}

/** The house's extent: its floor plan from the ground to the top of the walls. */
export function houseBounds(layout: HouseLayout): { min: Vector3; max: Vector3 } {
  const xs = layout.rooms.flatMap((r) => [r.x, r.x + r.width]);
  const zs = layout.rooms.flatMap((r) => [r.z, r.z + r.depth]);
  return {
    min: new Vector3(Math.min(...xs), 0, Math.min(...zs)),
    max: new Vector3(Math.max(...xs), layout.wallHeight, Math.max(...zs)),
  };
}
