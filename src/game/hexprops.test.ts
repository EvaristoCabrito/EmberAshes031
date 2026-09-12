import assert from "node:assert/strict";
import { test } from "node:test";
import { TERRAIN } from "./data.ts";
import { HEX_BLOCKED, HEX_HIGH, buildDecorOverlay, hexDef, hexProps } from "./hexprops.ts";
import type { DecorationPlacement, TerrainId } from "./types.ts";

const COLS = 10;
const ROWS = 6;
const board = (fill: TerrainId = "plains"): TerrainId[] => Array.from({ length: COLS * ROWS }, () => fill);
const at = (x: number, y: number) => y * COLS + x;
/** A one-hex footprint, so the tests say what they mean without the DECORATIONS table. */
const oneHex = () => [{ dx: 0, dy: 0 }];

test("no overlay means the base terrain, object identity included", () => {
  const tiles = board("woods");
  const d = hexDef(tiles, COLS, 3, 2);
  assert.equal(d, TERRAIN.woods, "must hand back the shared entry, not a copy");
});

test("a cell no decoration touches keeps the base terrain", () => {
  const tiles = board();
  const overlay = buildDecorOverlay([{ id: "x", x: 1, y: 1, blocksPath: true }], COLS, ROWS, oneHex);
  assert.equal(hexDef(tiles, COLS, 5, 5, overlay), TERRAIN.plains);
});

test("blocksPath consolidates to impassable without touching tiles", () => {
  const tiles = board();
  const before = [...tiles];
  const overlay = buildDecorOverlay([{ id: "x", x: 4, y: 2, blocksPath: true }], COLS, ROWS, oneHex);
  const d = hexDef(tiles, COLS, 4, 2, overlay);
  assert.equal(d.passable, false);
  assert.equal(d.moveCost, 99);
  assert.equal(d.blocksShot, true, "solid also stops arrows and sight");
  assert.equal(d.height, undefined, "asking for blocked must not grant height");
  assert.deepEqual(tiles, before, "the painted board must be untouched");
  assert.equal(tiles[at(4, 2)], "plains");
});

test("yieldsHighGround consolidates to the same numbers a hill carries", () => {
  const tiles = board();
  const overlay = buildDecorOverlay([{ id: "x", x: 4, y: 2, yieldsHighGround: true }], COLS, ROWS, oneHex);
  const d = hexDef(tiles, COLS, 4, 2, overlay);
  assert.equal(d.height, 1);
  assert.equal(d.atk, TERRAIN.hill.atk, "+2 damage, same as standing on a hill");
  assert.equal(d.def, TERRAIN.hill.def);
  assert.equal(d.moveCost, TERRAIN.hill.moveCost);
  assert.equal(d.passable, true, "high ground is somewhere you can stand");
  assert.equal(tiles[at(4, 2)], "plains", "the painted board must be untouched");
});

test("both switches need no terrain of their own", () => {
  const tiles = board();
  const overlay = buildDecorOverlay([{ id: "x", x: 4, y: 2, blocksPath: true, yieldsHighGround: true }], COLS, ROWS, oneHex);
  const d = hexDef(tiles, COLS, 4, 2, overlay);
  assert.equal(d.passable, false, "nobody stands on it");
  assert.equal(d.height, 1, "and it is tall enough to stop a low arrow");
  assert.equal(tiles[at(4, 2)], "plains");
  // The combination exists as an answer, not as a TerrainId — nothing in the table has it.
  const both = (Object.keys(TERRAIN) as TerrainId[]).filter((id) => !TERRAIN[id].passable && TERRAIN[id].height);
  assert.deepEqual(both, [], "no painted terrain is both, which is why consolidating beats stamping");
});

test("switches are additive: they never take a property away", () => {
  const tiles = board();
  for (const base of Object.keys(TERRAIN) as TerrainId[]) {
    tiles[at(2, 2)] = base;
    for (const bp of [false, true]) {
      for (const hg of [false, true]) {
        const overlay = buildDecorOverlay(
          [{ id: "x", x: 2, y: 2, blocksPath: bp || undefined, yieldsHighGround: hg || undefined }],
          COLS, ROWS, oneHex,
        );
        const d = hexDef(tiles, COLS, 2, 2, overlay);
        const b = TERRAIN[base];
        if (!b.passable) assert.equal(d.passable, false, `${base} ${bp}/${hg}: lost impassability`);
        if (b.height) assert.equal(!!d.height, true, `${base} ${bp}/${hg}: lost height`);
        if (bp) assert.equal(d.passable, false, `${base} ${bp}/${hg}: asked to block, did not`);
        if (hg) assert.equal(!!d.height, true, `${base} ${bp}/${hg}: asked for height, did not`);
        if (!bp && !hg) assert.equal(d, b, `${base}: untouched cell must be the shared entry`);
      }
    }
  }
});

test("high ground on a solid hex adds height and leaves it solid", () => {
  const tiles = board("barricade");
  const overlay = buildDecorOverlay([{ id: "x", x: 1, y: 1, yieldsHighGround: true }], COLS, ROWS, oneHex);
  const d = hexDef(tiles, COLS, 1, 1, overlay);
  assert.equal(d.passable, false, "a barricade must not become walkable");
  assert.equal(d.height, 1);
  assert.equal(d.id, "barricade", "and it is still a barricade, so the troll rule survives");
});

test("a multi-hex footprint marks every cell it covers", () => {
  const tiles = board();
  const pair = () => [{ dx: 0, dy: 0 }, { dx: 1, dy: 0 }];
  const overlay = buildDecorOverlay([{ id: "x", x: 3, y: 1, blocksPath: true }], COLS, ROWS, pair);
  assert.equal(hexProps(tiles, COLS, 3, 1, overlay).blocked, true);
  assert.equal(hexProps(tiles, COLS, 4, 1, overlay).blocked, true);
  assert.equal(hexProps(tiles, COLS, 5, 1, overlay).blocked, false);
});

test("two props on one cell contribute both flags", () => {
  const tiles = board();
  const placements: DecorationPlacement[] = [
    { id: "a", x: 6, y: 3, blocksPath: true },
    { id: "b", x: 6, y: 3, yieldsHighGround: true },
  ];
  const overlay = buildDecorOverlay(placements, COLS, ROWS, oneHex);
  assert.equal(overlay[at(6, 3)], HEX_BLOCKED | HEX_HIGH);
  const p = hexProps(tiles, COLS, 6, 3, overlay);
  assert.deepEqual(p, { blocked: true, highGround: true });
});

test("a footprint hanging off the board does not write outside it", () => {
  const tiles = board();
  const wide = () => Array.from({ length: 5 }, (_, dx) => ({ dx, dy: 0 }));
  const overlay = buildDecorOverlay([{ id: "x", x: COLS - 2, y: 0, blocksPath: true }], COLS, ROWS, wide);
  assert.equal(overlay.length, COLS * ROWS, "no growth");
  assert.equal(hexProps(tiles, COLS, COLS - 2, 0, overlay).blocked, true);
  assert.equal(hexProps(tiles, COLS, COLS - 1, 0, overlay).blocked, true);
  // The three cells that fell off the right edge must not have wrapped onto row 1.
  for (let x = 0; x < 3; x++) {
    assert.equal(hexProps(tiles, COLS, x, 1, overlay).blocked, false, `wrapped onto 1,${x}`);
  }
});

test("a placement with neither switch contributes nothing", () => {
  const overlay = buildDecorOverlay([{ id: "x", x: 2, y: 2 }], COLS, ROWS, oneHex);
  assert.equal(overlay.every((b) => b === 0), true);
});
