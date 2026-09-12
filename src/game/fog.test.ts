import assert from "node:assert/strict";
import { test } from "node:test";
import { EXPLORED, UNSEEN, VISIBLE, packExplored, relight, sightReaches, unpackExplored } from "./fog.ts";
import type { TerrainId } from "./types.ts";

/** A board of open ground, with `walls` painted as sight-blocking columns. */
function board(cols: number, rows: number, walls: [number, number][] = []): TerrainId[] {
  const tiles: TerrainId[] = Array.from({ length: cols * rows }, () => "plains" as TerrainId);
  for (const [x, y] of walls) tiles[y * cols + x] = "column";
  return tiles;
}

test("sight is clear across open ground", () => {
  const tiles = board(10, 5);
  assert.equal(sightReaches({ x: 0, y: 2 }, { x: 9, y: 2 }, tiles, 10), true);
  assert.equal(sightReaches({ x: 4, y: 2 }, { x: 4, y: 2 }, tiles, 10), true, "a cell sees itself");
});

test("a blocker stops sight past it but is itself seen", () => {
  const tiles = board(10, 5, [[4, 2]]);
  // Straight along a row: the column at x=4 sits between 2 and 7.
  assert.equal(sightReaches({ x: 2, y: 2 }, { x: 7, y: 2 }, tiles, 10), false);
  // The blocker is the endpoint, so nothing stands between — you see the wall.
  assert.equal(sightReaches({ x: 2, y: 2 }, { x: 4, y: 2 }, tiles, 10), true);
  // An adjacent cell has no interior cell on its line at all.
  assert.equal(sightReaches({ x: 3, y: 2 }, { x: 4, y: 2 }, tiles, 10), true);
});

test("relight lights a radius and leaves the rest unseen", () => {
  const cols = 21;
  const rows = 11;
  const tiles = board(cols, rows);
  const vis = new Uint8Array(cols * rows);
  relight(vis, [{ x: 10, y: 5 }], 3, tiles, cols, rows);

  assert.equal(vis[5 * cols + 10], VISIBLE, "the eye's own cell");
  assert.equal(vis[5 * cols + 13], VISIBLE, "3 away, on the edge of the radius");
  assert.equal(vis[5 * cols + 14], UNSEEN, "4 away, out of reach");
  assert.equal(vis[0], UNSEEN, "far corner");
});

test("what leaves sight stays remembered, and memory never goes dark again", () => {
  const cols = 21;
  const rows = 11;
  const tiles = board(cols, rows);
  const vis = new Uint8Array(cols * rows);

  relight(vis, [{ x: 4, y: 5 }], 2, tiles, cols, rows);
  const seenEarly = 5 * cols + 4;
  assert.equal(vis[seenEarly], VISIBLE);

  // The party walks away: the old cell demotes to remembered, not to unseen.
  relight(vis, [{ x: 16, y: 5 }], 2, tiles, cols, rows);
  assert.equal(vis[seenEarly], EXPLORED);
  assert.equal(vis[5 * cols + 16], VISIBLE);

  // And walking further does not erase it.
  relight(vis, [{ x: 18, y: 9 }], 1, tiles, cols, rows);
  assert.equal(vis[seenEarly], EXPLORED);
});

test("relight respects blockers, so a wall casts a shadow", () => {
  const cols = 15;
  const rows = 7;
  // A vertical run of columns down x=7 walls the board in half.
  const walls: [number, number][] = Array.from({ length: rows }, (_, y) => [7, y] as [number, number]);
  const tiles = board(cols, rows, walls);
  const vis = new Uint8Array(cols * rows);
  relight(vis, [{ x: 4, y: 3 }], 6, tiles, cols, rows);

  assert.equal(vis[3 * cols + 5], VISIBLE, "near side of the wall");
  assert.equal(vis[3 * cols + 7], VISIBLE, "the wall itself is seen");
  assert.equal(vis[3 * cols + 9], UNSEEN, "behind the wall, in its shadow");
  assert.equal(vis[3 * cols + 10], UNSEEN);
});

test("two party members pool their sight", () => {
  const cols = 25;
  const rows = 5;
  const tiles = board(cols, rows);
  const vis = new Uint8Array(cols * rows);
  relight(vis, [{ x: 3, y: 2 }, { x: 20, y: 2 }], 2, tiles, cols, rows);

  assert.equal(vis[2 * cols + 3], VISIBLE);
  assert.equal(vis[2 * cols + 20], VISIBLE);
  assert.equal(vis[2 * cols + 12], UNSEEN, "the gap between them stays dark");
});

test("explored survives a pack/unpack round trip", () => {
  const cells = 40 * 15;
  const vis = new Uint8Array(cells);
  // A scattered pattern, including both ends and a byte boundary.
  for (const i of [0, 1, 7, 8, 9, 63, 64, 100, 233, cells - 1]) vis[i] = EXPLORED;
  vis[150] = VISIBLE; // visible counts as explored once stored

  const restored = unpackExplored(packExplored(vis), cells);
  assert.ok(restored, "round trip decodes");
  assert.equal(restored.length, cells);
  for (let i = 0; i < cells; i++) {
    assert.equal(restored[i] > UNSEEN, vis[i]! > UNSEEN, `cell ${i}`);
  }
  assert.equal(restored[150], EXPLORED, "visible is stored as merely explored");
});

test("a bitset from another board is refused, not half-applied", () => {
  const vis = new Uint8Array(40 * 15);
  vis[10] = EXPLORED;
  const packed = packExplored(vis);
  assert.equal(unpackExplored(packed, 26 * 24), null, "wrong cell count");
  assert.ok(unpackExplored(packed, 40 * 15), "right cell count still works");
});

test("a corrupt bitset is refused rather than throwing", () => {
  assert.equal(unpackExplored("not base64 at all!!", 600), null);
  assert.equal(unpackExplored("", 600), null);
});

test("packing a fully explored board costs about a bit per cell", () => {
  // 160x160 is the ceiling from MAX_GRID; the save carries this string, so its size
  // is the reason the bitset is packed rather than stored a byte per cell.
  const cells = 160 * 160;
  const vis = new Uint8Array(cells).fill(EXPLORED);
  const packed = packExplored(vis);
  assert.ok(packed.length < 4500, `expected under ~4.4 KB, got ${packed.length}`);
  assert.ok(unpackExplored(packed, cells));
});
