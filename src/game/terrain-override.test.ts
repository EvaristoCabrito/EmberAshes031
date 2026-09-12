import assert from "node:assert/strict";
import { test } from "node:test";
import { TERRAIN, overrideTerrain } from "./data.ts";
import type { TerrainId } from "./types.ts";

const blocked = (id: TerrainId) => !TERRAIN[id].passable;
const high = (id: TerrainId) => !!TERRAIN[id].height;

test("both switches off leave the hex exactly as it was", () => {
  for (const id of Object.keys(TERRAIN) as TerrainId[]) {
    assert.equal(overrideTerrain(id, false, false), id, id);
  }
});

test("blocking an open hex makes it solid", () => {
  assert.equal(overrideTerrain("plains", true, false), "column");
  assert.equal(overrideTerrain("woods", true, false), "column");
  assert.equal(overrideTerrain("nave", true, false), "column");
});

test("high ground keeps the flavour of what is under it", () => {
  assert.equal(overrideTerrain("woods", false, true), "highwood");
  assert.equal(overrideTerrain("ruins", false, true), "highruin");
  assert.equal(overrideTerrain("plains", false, true), "hill");
  assert.equal(overrideTerrain("nave", false, true), "hill");
});

test("both switches make a tall obstacle", () => {
  const r = overrideTerrain("plains", true, true);
  assert.equal(r, "crag");
  assert.equal(blocked(r), true, "nobody stands on it");
  assert.equal(high(r), true, "and it is tall enough to stop a low arrow");
});

test("a switch asking for what the hex already has changes nothing", () => {
  // Already solid: blocking it again must not trade away the terrain's own rules —
  // a troll can smash a barricade, and turning it into a column would remove that.
  assert.equal(overrideTerrain("barricade", true, false), "barricade");
  assert.equal(overrideTerrain("column", true, false), "column");
  assert.equal(overrideTerrain("chest", true, false), "chest");
  // Already high.
  assert.equal(overrideTerrain("hill", false, true), "hill");
  assert.equal(overrideTerrain("highwood", false, true), "highwood");
  assert.equal(overrideTerrain("deadtree", false, true), "deadtree");
  // Already both.
  assert.equal(overrideTerrain("crag", true, true), "crag");
});

test("high ground on a solid hex adds height without opening it up", () => {
  // The subtractive trap: returning "hill" here would quietly make a barricade walkable.
  for (const id of ["barricade", "column", "door", "water", "void"] as TerrainId[]) {
    const r = overrideTerrain(id, false, true);
    assert.equal(blocked(r), true, `${id} must stay impassable`);
    assert.equal(high(r), true, `${id} must gain height`);
  }
});

test("a switch never removes a property, whatever the hex started as", () => {
  for (const id of Object.keys(TERRAIN) as TerrainId[]) {
    for (const bp of [false, true]) {
      for (const hg of [false, true]) {
        const r = overrideTerrain(id, bp, hg);
        if (blocked(id)) assert.equal(blocked(r), true, `${id} ${bp}/${hg}: lost impassability`);
        if (high(id)) assert.equal(high(r), true, `${id} ${bp}/${hg}: lost height`);
        if (bp) assert.equal(blocked(r), true, `${id} ${bp}/${hg}: asked to block, did not`);
        if (hg) assert.equal(high(r), true, `${id} ${bp}/${hg}: asked for height, did not`);
      }
    }
  }
});

test("every resolved terrain is a real one the art loader knows", () => {
  for (const id of Object.keys(TERRAIN) as TerrainId[]) {
    for (const bp of [false, true]) {
      for (const hg of [false, true]) {
        assert.ok(TERRAIN[overrideTerrain(id, bp, hg)], `${id} ${bp}/${hg} resolved to an unknown terrain`);
      }
    }
  }
});
