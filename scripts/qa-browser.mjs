#!/usr/bin/env node
/**
 * Browser QA for the things unit tests cannot reach: the engine running in a real
 * browser, against a real canvas, with the real art loaded.
 *
 *   npm run qa:browser                      # against http://127.0.0.1:8080/
 *   npm run qa:browser -- http://host:8081/ # somewhere else
 *
 * Needs a dev server already up (`npm run dev`) — it drives the engine through the
 * dev server's module graph rather than clicking through menus, because what is
 * under test is engine behaviour, not the route from the title screen to a battle.
 * That also means it exercises the same modules the game does, not a copy.
 *
 * Three things, each of which has been wrong at some point:
 *
 *   scale   a 160x160 board (MAX_GRID) with 100+ units stays inside the frame
 *           budget, and the enemy phase completes
 *   fog     sight reveals on movement, memory never goes dark again, a wall casts
 *           a shadow, and the explored bitset survives save/resume
 *   props   a placement's two rule switches change movement, sight and the
 *           high-ground bonus while the painted terrain stays exactly as it was
 *
 * Exits non-zero on the first failed expectation, so it is usable as a gate.
 */
import { chromium } from "playwright";
import { checkedUrl } from "./browser-guard.mjs";

const url = checkedUrl(process.argv[2] || "http://127.0.0.1:8080/");

/**
 * Playwright's own chromium in the sandbox; the installed Chrome on a dev machine
 * that never ran `npx playwright install`. Trying in that order keeps this runnable
 * in both places without a 150MB download as the price of entry.
 */
async function launchBrowser() {
  const args = ["--no-sandbox", "--disable-dev-shm-usage"];
  try {
    return await chromium.launch({ headless: true, args });
  } catch (bundled) {
    try {
      return await chromium.launch({ channel: "chrome", headless: true, args });
    } catch {
      console.error(
        "[qa] no browser to drive. Either run `npx playwright install chromium`,\n" +
          "[qa] or install Chrome so the `chrome` channel can be used.\n" +
          `[qa] bundled chromium said: ${bundled.message.split("\n")[0]}`,
      );
      process.exit(2);
    }
  }
}

const failures = [];
/** Record an expectation. `detail` is printed either way, so a pass is auditable too. */
function expect(name, ok, detail) {
  const line = detail === undefined ? name : `${name} — ${detail}`;
  if (ok) console.log(`[qa]   ok   ${line}`);
  else {
    console.log(`[qa]  FAIL  ${line}`);
    failures.push(name);
  }
}

const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

try {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
} catch (err) {
  console.error(`[qa] ${url} did not answer — is the dev server up? (${err.message.split("\n")[0]})`);
  await browser.close();
  process.exit(2);
}

// Art loads once at boot and the engine needs it; waiting here also keeps the load
// out of the frame measurements below.
const boot = await page.evaluate(async () => {
  const assets = await import("/src/game/assets.ts");
  const t0 = performance.now();
  window.__art = await assets.loadGameArt();
  return { ms: Math.round(performance.now() - t0), terrains: Object.keys(window.__art.tiles).length };
});
console.log(`[qa] ${url}`);
console.log(`[qa] art: ${boot.terrains} terrains in ${boot.ms}ms`);

const r = await page.evaluate(async () => {
  const { BattleEngine } = await import("/src/game/engine.ts");
  const { TERRAIN, MAX_GRID, TILE_CHAR, SIGHT_RADIUS } = await import("/src/game/data.ts");
  const pf = await import("/src/game/pathfinding.ts");
  const hp = await import("/src/game/hexprops.ts");
  const art = window.__art;
  const roster = { hp: {}, levels: {} };
  const out = {};

  const canvas = document.createElement("canvas");
  canvas.width = 1600;
  canvas.height = 900;
  const ctx = canvas.getContext("2d");

  const layout = (cols, rows, fill = "plains", wall = []) => {
    const w = new Set(wall.map(([x, y]) => `${x},${y}`));
    return Array.from({ length: rows }, (_, y) => {
      let s = "";
      for (let x = 0; x < cols; x++) s += w.has(`${x},${y}`) ? TILE_CHAR.column : TILE_CHAR[fill];
      return s;
    });
  };
  const mission = (over) => ({
    id: "thebridge", index: 3, title: "QA", place: "QA", briefing: "", objective: "QA", win: "rout",
    cols: 20, rows: 16, layout: layout(20, 16), playerSpawns: [], enemySpawns: [],
    ...over,
  });

  // ------------------------------------------------------------------- scale
  {
    const cols = MAX_GRID;
    const rows = MAX_GRID;
    const names = ["Kael", "Neera", "Voss", "Salazar", "Malrec", "Aldric"];
    const m = mission({
      cols, rows, layout: layout(cols, rows),
      playerSpawns: names.map((n, i) => ({ name: n, classId: "swordsman", x: 10 + i * 2, y: 80 })),
      enemySpawns: Array.from({ length: 100 }, (_, i) => ({
        name: `Foe${i}`, classId: i % 7 === 0 ? "archer" : "soldier",
        x: (i * 13) % cols, y: 5 + ((i * 7) % (rows - 10)),
      })),
    });
    const eng = new BattleEngine(m, art, roster, 7);
    eng.setZoom(0);

    const frames = [];
    for (let i = 0; i < 120; i++) {
      const s = performance.now();
      eng.tick(1 / 60);
      eng.render(ctx, 1600, 900, 1);
      frames.push(performance.now() - s);
      if (i % 10 === 0) eng.panBy(140, 0); // panning is the real case on a long board
    }
    // Frame 0 pays for camera init and canvas warm-up, once. Including it hides the
    // steady state, which is the thing with a budget.
    const steady = [...frames.slice(1)].sort((a, b) => a - b);

    // endTurn ends the active unit's turn, not the phase. Without this loop the
    // enemy phase never starts and the run looks like a stall — it did once.
    let guard = 0;
    while (eng.phase === "player" && guard++ < 600) {
      eng.endTurn();
      eng.tick(1 / 60);
    }
    const t0 = performance.now();
    let ticks = 0;
    while (eng.phase === "enemy" && ticks < 20000) {
      eng.tick(1 / 60);
      ticks++;
    }

    out.scale = {
      grid: `${cols}x${rows}`, hexes: cols * rows, units: eng.units.length,
      frame0Ms: +frames[0].toFixed(1),
      frameMedianMs: +steady[Math.floor(steady.length / 2)].toFixed(2),
      frameP95Ms: +steady[Math.floor(steady.length * 0.95)].toFixed(2),
      framesOverBudget: steady.filter((ms) => ms > 16.67).length,
      enemyPhaseCpuMs: Math.round(performance.now() - t0),
      enemyPhaseSimSeconds: +(ticks / 60).toFixed(1),
      enemyPhaseEnded: eng.phase !== "enemy",
      enemiesThatActed: eng.units.filter((u) => u.side === "enemy" && (u.acted || u.moved)).length,
    };
  }

  // --------------------------------------------------------------------- fog
  {
    const cols = 40;
    const rows = 20;
    const wall = Array.from({ length: rows }, (_, y) => [20, y]);
    const m = mission({
      cols, rows, layout: layout(cols, rows, "plains", wall), fog: true,
      playerSpawns: [{ name: "Kael", classId: "swordsman", x: 5, y: 10 }],
      enemySpawns: [
        { name: "Near", classId: "soldier", x: 9, y: 10 },
        { name: "Behind", classId: "soldier", x: 30, y: 10 },
      ],
    });
    const eng = new BattleEngine(m, art, roster, 7);
    const draw = () => eng.render(ctx, 1600, 900, 1);
    draw();

    const behind = eng.units.find((u) => u.name === "Behind");
    const near = eng.units.find((u) => u.name === "Near");
    const count = () => {
      let vis = 0;
      let exp = 0;
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          if (eng.visible(x, y)) vis++;
          if (eng.explored(x, y)) exp++;
        }
      }
      return { vis, exp };
    };

    // Everything about the opening position has to be read before the move below.
    // The party's own cell stops being *visible* once it walks away — it becomes
    // remembered — so sampling it later would contradict the very next assertion.
    const before = count();
    const seesOwnCell = eng.visible(5, 10);
    const seesNear = eng.visible(near.x, near.y);
    const seesBehind = eng.visible(behind.x, behind.y);
    const beyondRadius = eng.explored(5 + SIGHT_RADIUS + 3, 10);

    const hero = eng.units.find((u) => u.side === "player");
    hero.x = 15;
    hero.y = 10;
    draw();
    const after = count();

    const snap = eng.captureSnapshot();
    const resumed = new BattleEngine(m, art, roster, 7);
    resumed.applySnapshot(snap);
    resumed.render(ctx, 1600, 900, 1);
    let restoredExplored = 0;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) if (resumed.explored(x, y)) restoredExplored++;
    }

    const noFog = new BattleEngine(mission({ cols, rows, layout: layout(cols, rows) }), art, roster, 7);
    noFog.render(ctx, 1600, 900, 1);

    out.fog = {
      fogged: eng.fogged,
      seesOwnCell,
      seesNear, seesBehindWall: seesBehind, exploredBeyondRadius: beyondRadius,
      visBefore: before.vis, visAfter: after.vis,
      exploredBefore: before.exp, exploredAfter: after.exp,
      whereItStoodIsRemembered: !eng.visible(5, 10) && eng.explored(5, 10),
      behindWallStillHidden: !eng.visible(behind.x, behind.y),
      bitsetPresent: typeof snap.explored === "string",
      bitsetBase64Bytes: snap.explored ? snap.explored.length : 0,
      exploredAfterResume: restoredExplored,
      noFogSeesEverything: noFog.visible(0, 0) && noFog.visible(cols - 1, rows - 1) && !noFog.fogged,
    };
  }

  // ------------------------------------------------------------------- props
  {
    const cols = 24;
    const rows = 14;
    // The whole board is painted woods on purpose: if anything still stamped
    // terrain under a prop, that cell would stop being "woods" and this would catch
    // it. Nothing is allowed to write to `tiles` any more.
    const targets = {
      control: { x: 5, y: 3, flags: {} },
      blocks: { x: 5, y: 6, flags: { blocksPath: true } },
      high: { x: 5, y: 9, flags: { yieldsHighGround: true } },
      both: { x: 5, y: 12, flags: { blocksPath: true, yieldsHighGround: true } },
    };
    const m = mission({
      cols, rows, layout: layout(cols, rows, "woods"),
      playerSpawns: [{ name: "Kael", classId: "swordsman", x: 1, y: 1 }],
      enemySpawns: [{ name: "Foe", classId: "soldier", x: 22, y: 13 }],
      decorations: Object.values(targets).map((t) => ({ id: "wooden-cart", x: t.x, y: t.y, ...t.flags })),
    });
    const eng = new BattleEngine(m, art, roster, 7);
    eng.render(ctx, 1600, 900, 1);

    const overlay = eng.decorOverlay;
    // A test that builds its own overlay proves nothing about the engine, so check
    // the engine's: three flagged props, two hexes each (the cart is a pair) = six.
    out.overlay = {
      isByteArray: overlay instanceof Uint8Array,
      rightSize: overlay instanceof Uint8Array && overlay.length === cols * rows,
      markedCells: overlay instanceof Uint8Array ? overlay.reduce((n, b) => n + (b ? 1 : 0), 0) : 0,
      expectedCells: 6,
    };

    out.baseTerrain = {
      everyTileStillWoods: eng.tiles.every((t) => t === "woods"),
      underProps: Object.fromEntries(Object.entries(targets).map(([k, t]) => [k, eng.tiles[t.y * cols + t.x]])),
    };

    // Through `hover` + getHud, which is the path the UI itself reads.
    const viaHud = (x, y) => {
      eng.hover = { x, y };
      const t = eng.getHud().terrain;
      return { id: t.id, passable: t.passable, moveCost: t.moveCost, atk: t.atk, def: t.def, blocksShot: t.blocksShot };
    };
    out.hud = Object.fromEntries(Object.entries(targets).map(([k, t]) => [k, viaHud(t.x, t.y)]));
    out.hud.hillReference = { atk: TERRAIN.hill.atk, def: TERRAIN.hill.def };

    // Hero adjacent with movement to spare, so reachable/not isolates the blocking
    // rule instead of measuring distance — that ambiguity read as a failure once.
    out.movement = {};
    for (const [k, t] of Object.entries(targets)) {
      const hero = eng.units.find((u) => u.side === "player");
      hero.x = t.x - 1;
      hero.y = t.y;
      eng.render(ctx, 1600, 900, 1);
      const reach = pf.computeReachable({ ...hero, mov: 6 }, eng.tiles, cols, rows, eng.units, true, overlay);
      out.movement[k] = {
        hexDistance: pf.hexDist(hero, t),
        reachable: reach.has(`${t.x},${t.y}`),
        controlAtSameDistance: reach.has(`${t.x},${t.y - 1}`),
      };
    }

    const b = targets.blocks;
    out.sight = {
      throughPropWithOverlay: pf.clearShot({ x: b.x - 2, y: b.y }, { x: b.x + 3, y: b.y }, eng.tiles, cols, "bolt", overlay),
      throughPropWithout: pf.clearShot({ x: b.x - 2, y: b.y }, { x: b.x + 3, y: b.y }, eng.tiles, cols, "bolt"),
      clearLine: pf.clearShot({ x: 1, y: 5 }, { x: 6, y: 5 }, eng.tiles, cols, "bolt", overlay),
    };

    // A wall of blocking props on unpainted ground: proves the overlay reaches the
    // fog pass through the engine, not only the pathfinder.
    const fogged = new BattleEngine(
      mission({
        cols, rows, layout: layout(cols, rows, "plains"), fog: true,
        playerSpawns: [{ name: "Kael", classId: "swordsman", x: 2, y: 7 }],
        enemySpawns: [{ name: "Foe", classId: "soldier", x: 22, y: 13 }],
        decorations: Array.from({ length: rows }, (_, y) => ({ id: "wooden-cart", x: 6, y, blocksPath: true })),
      }),
      art, roster, 7,
    );
    fogged.render(ctx, 1600, 900, 1);
    out.fogBehindProp = {
      tilesStillPlains: fogged.tiles.every((t) => t === "plains"),
      seesBeforeProp: fogged.visible(5, 7),
      seesProp: fogged.visible(6, 7),
      seesPastProp: fogged.visible(9, 7),
      consolidated: hp.hexProps(fogged.tiles, cols, 6, 7, fogged.decorOverlay),
    };
  }

  return out;
});

// ---------------------------------------------------------------- assertions
const s = r.scale;
console.log(`[qa] scale — ${s.grid}, ${s.hexes} hexes, ${s.units} units`);
expect("frame budget held", s.framesOverBudget === 0, `median ${s.frameMedianMs}ms, p95 ${s.frameP95Ms}ms, ${s.framesOverBudget} over 16.67ms (frame 0 was ${s.frame0Ms}ms, one-off init)`);
expect("enemy phase completes", s.enemyPhaseEnded, `${s.enemiesThatActed}/100 acted, ${s.enemyPhaseCpuMs}ms cpu, ${s.enemyPhaseSimSeconds}s simulated`);
expect("enemy phase cpu is not the bottleneck", s.enemyPhaseCpuMs < 2000, `${s.enemyPhaseCpuMs}ms`);

const f = r.fog;
console.log("[qa] fog");
expect("fog is on when the mission asks", f.fogged);
expect("sees its own cell", f.seesOwnCell);
expect("sees a foe in the open", f.seesNear);
expect("cannot see past a wall", !f.seesBehindWall);
expect("nothing explored beyond the radius", !f.exploredBeyondRadius);
expect("memory never goes dark again", f.exploredAfter >= f.exploredBefore, `${f.exploredBefore} -> ${f.exploredAfter} cells`);
expect("where it stood is remembered, not visible", f.whereItStoodIsRemembered);
expect("behind the wall stays hidden after moving", f.behindWallStillHidden);
expect("explored survives save/resume", f.bitsetPresent && f.exploredAfterResume === f.exploredAfter, `${f.bitsetBase64Bytes} base64 bytes, ${f.exploredAfter} -> ${f.exploredAfterResume}`);
expect("a mission without fog sees everything", f.noFogSeesEverything);

const o = r.overlay;
console.log("[qa] props");
expect("the engine builds its own overlay", o.isByteArray && o.rightSize && o.markedCells === o.expectedCells, `${o.markedCells} marked cells, expected ${o.expectedCells}`);
expect("the painted board is never written to", r.baseTerrain.everyTileStillWoods, JSON.stringify(r.baseTerrain.underProps));
expect("no switch leaves the hex alone", r.hud.control.passable && !r.hud.control.blocksShot && r.hud.control.atk === 0);
expect("blocksPath consolidates to impassable and opaque", !r.hud.blocks.passable && r.hud.blocks.moveCost === 99 && r.hud.blocks.blocksShot === true);
expect("blocksPath grants no height", r.hud.blocks.atk === r.hud.control.atk);
expect("yieldsHighGround grants exactly a hill's bonus", r.hud.high.atk === r.hud.hillReference.atk && r.hud.high.def === r.hud.hillReference.def, `atk ${r.hud.high.atk}, def ${r.hud.high.def}`);
expect("high ground stays somewhere you can stand", r.hud.high.passable);
expect("both switches need no terrain of their own", !r.hud.both.passable && r.hud.both.atk === r.hud.hillReference.atk);
expect("the hex keeps its painted identity", Object.values(r.hud).every((t) => t.id === undefined || t.id === "woods"));
for (const [k, mv] of Object.entries(r.movement)) {
  const shouldReach = k === "control" || k === "high";
  expect(`movement: ${k} is ${shouldReach ? "reachable" : "blocked"}`, mv.reachable === shouldReach && mv.controlAtSameDistance, `distance ${mv.hexDistance}, reachable ${mv.reachable}, control ${mv.controlAtSameDistance}`);
}
expect("a blocking prop casts a line-of-sight shadow", r.sight.throughPropWithOverlay === false && r.sight.throughPropWithout === true, "blocked with the overlay, clear without it — so the prop is what blocks, not the terrain");
expect("an unobstructed line still passes", r.sight.clearLine);

const fb = r.fogBehindProp;
expect("the overlay reaches the fog pass", fb.tilesStillPlains && fb.seesBeforeProp && fb.seesProp && !fb.seesPastProp, `before ${fb.seesBeforeProp}, prop ${fb.seesProp}, past ${fb.seesPastProp}`);

if (pageErrors.length) {
  console.log("[qa] page errors:");
  for (const e of pageErrors.slice(0, 10)) console.log(`[qa]   ${e}`);
}

await browser.close();
if (failures.length) {
  console.error(`[qa] ${failures.length} failed: ${failures.join("; ")}`);
  process.exitCode = 1;
} else {
  console.log("[qa] all checks passed");
}
