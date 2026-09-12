/**
 * Fog of war primitives, kept out of the engine so they can be tested directly.
 *
 * One byte per cell, row-major like `tiles`:
 *
 *   UNSEEN   never in sight — drawn as nothing at all
 *   EXPLORED walked past and remembered: terrain draws dim, but nothing that moves
 *            through it does, because memory is not sight
 *   VISIBLE  in sight of a living party member this instant
 *
 * Only EXPLORED survives a save (see packExplored). VISIBLE is not stored because it
 * follows from where the party stands, so a load recomputes it.
 */
import { TERRAIN } from "./data.ts";
import { hexDist, hexLine, tileAt } from "./pathfinding.ts";
import type { Point, TerrainId } from "./types.ts";

export const UNSEEN = 0;
export const EXPLORED = 1;
export const VISIBLE = 2;

/**
 * Whether `to` is in sight from `from`, stopping at the first blocker — which is
 * itself seen, since you see the wall and not past it.
 *
 * Uses `blocksShot` rather than a sight flag of its own so what hides a body from a
 * bow also hides it from the eye, and reads it off `tiles`: a decoration that blocks
 * stamps blocking terrain under itself when the board loads, so the tile grid is the
 * single source of truth for both.
 */
export function sightReaches(from: Point, to: Point, tiles: TerrainId[], cols: number): boolean {
  const line = hexLine(from, to);
  for (let i = 1; i < line.length - 1; i++) {
    const p = line[i]!;
    if (TERRAIN[tileAt(tiles, cols, p.x, p.y)].blocksShot) return false;
  }
  return true;
}

/**
 * Demote what was visible to remembered, then light up what the given eyes can see.
 * Explored never falls back to unseen: fog lifts and stays lifted.
 *
 * `vis` is mutated in place — it is one byte per cell and gets rewritten whenever the
 * party moves, so handing back a fresh array every time would churn 25 KB a step on a
 * dungeon-sized board.
 *
 * Cost is O(eyes x radius^2) and does not depend on the size of the board: a 160x160
 * dungeon costs exactly what a 20x16 skirmish does.
 */
export function relight(
  vis: Uint8Array,
  eyes: Point[],
  radius: number,
  tiles: TerrainId[],
  cols: number,
  rows: number,
): void {
  for (let i = 0; i < vis.length; i++) if (vis[i] === VISIBLE) vis[i] = EXPLORED;
  for (const eye of eyes) {
    const x0 = Math.max(0, eye.x - radius);
    const x1 = Math.min(cols - 1, eye.x + radius);
    const y0 = Math.max(0, eye.y - radius);
    const y1 = Math.min(rows - 1, eye.y + radius);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * cols + x;
        if (vis[i] === VISIBLE) continue;
        if (hexDist(eye, { x, y }) > radius) continue;
        if (sightReaches(eye, { x, y }, tiles, cols)) vis[i] = VISIBLE;
      }
    }
  }
}

/**
 * Explored cells as one bit each, base64.
 *
 * A bit per cell keeps a 160x160 dungeon at about 3.4 KB rather than the 25 KB the
 * raw byte array would cost, which matters because this rides inside a save bank that
 * also carries the whole tile grid (see lastSaveWrite in ./save).
 */
export function packExplored(vis: Uint8Array): string {
  const bytes = new Uint8Array(Math.ceil(vis.length / 8));
  for (let i = 0; i < vis.length; i++) {
    if (vis[i]! > UNSEEN) bytes[i >> 3]! |= 1 << (i & 7);
  }
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * Explored cells for a board of `cells` hexes, or `null` when the string does not
 * decode or does not match that board.
 *
 * Refusing a mismatch rather than applying part of it is deliberate: a bitset from a
 * different board would light unrelated cells, and resuming a fight with the fog
 * still down costs far less than revealing a room the party never entered.
 */
export function unpackExplored(encoded: string, cells: number): Uint8Array | null {
  let binary: string;
  try {
    binary = atob(encoded);
  } catch {
    // Not base64 — a hand-edited or truncated save.
    return null;
  }
  if (binary.length !== Math.ceil(cells / 8)) return null;
  const vis = new Uint8Array(cells);
  for (let i = 0; i < cells; i++) {
    if ((binary.charCodeAt(i >> 3) >> (i & 7)) & 1) vis[i] = EXPLORED;
  }
  return vis;
}
