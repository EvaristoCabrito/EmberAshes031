/** Maps authored in the Map Editor, saved as real files under src/game/maps/.
 *
 * The editor's "Salvar" posts a draft to the dev-only route in
 * scripts/map-save-plugin.mjs, which writes src/game/maps/<id>-<serial>.json —
 * "vau-001.json", "vau-002.json", "misty-cave-001.json". Serials are never
 * overwritten: each save appends the next number, so an edit can always be
 * rolled back to an earlier one by deleting the newer file.
 *
 * A saved map is found by its scenario id (its file name) and, when it names a
 * locationId, shows up at that spot on the world map. The highest serial for a
 * given id is the one that plays.
 *
 * Nothing here runs the procedural passes in data.ts (rockifyColumns,
 * decorateOpenTerrain): those exist to dress the hand-written RAW_MISSIONS, and
 * a map arranged by hand in the editor loads exactly as it was arranged.
 */
import { MISSIONS, TILE_CHAR, WORLD_LOCATIONS } from "./data";
import SLOT_CONFIG from "./map-slots.json";
import ORDER_CONFIG from "./map-order.json";
import type { DecorationPlacement, Mission, Spawn, TerrainId, WinCondition, WorldLocation } from "./types";

/** A spawn as edited in the Map Editor — the real Spawn shape plus a per-spawn test
 * level, which only exists for "Testar" (balance testing). It never leaves the editor:
 * draftToMission() strips it back down to a plain Spawn before export/playtest. */
export interface DraftSpawn extends Spawn {
  level: number;
}

export interface MapDraft {
  /** Which campaign scenario this map authors for — matches a real Mission.id (e.g.
   * "o-vau") to version-edit that scenario, or any free id for a standalone map with no
   * campaign slot. Versions are grouped and saved under this id — it's the "Cenário
   * alvo" the user assigns, not a per-edit-session unique key. It is also the file
   * name saved maps get, so it's how a map is found again. */
  id: string;
  /** Mission.index of the scenario being edited (enemy scaling, procedural terrain hash
   * — see enemyLevelFor). 0 for a standalone map with no real campaign slot. */
  index: number;
  title: string;
  place: string;
  briefing: string;
  objective: string;
  win: WinCondition;
  /** Track file name for this map, or absent for its usual theme. */
  music?: string;
  hub: boolean;
  /** False to load this map exactly as painted, with no procedural scatter over it — see
   * Mission.autoTactics. Carried through Exportar so a map pasted into data.ts keeps it. */
  autoTactics: boolean;
  /** Which world map location this map hangs off, by WorldLocation.id — "" for a map
   * that shouldn't appear on the map at all. A map already reachable through its
   * scenario's own location keeps showing up there whatever this says; this is what
   * puts a NEW map somewhere (Village, Cemetery, Misty Cave, ...). */
  locationId: string;
  cols: number;
  rows: number;
  tiles: TerrainId[];
  /** Art variant per tile (same indexing as tiles) — which numbered version (001, 002,
   * ...) paints there. Defaults to 0 (the "001" file, safe for existing missions). */
  tileVariants: number[];
  /** How far each tile is turned, in sixths of a circle (same indexing as tiles). Optional:
   * a map saved before hex rotation existed has no such key, read as "none turned". */
  tileRots?: number[];
  decorations: DecorationPlacement[];
  playerSpawns: DraftSpawn[];
  enemySpawns: DraftSpawn[];
  /** Wild things on no side. Optional: map files saved before neutrals existed have no such
   * key, and every reader has to treat a missing list as an empty one. */
  neutralSpawns?: DraftSpawn[];
}

/** One saved map file. `serial` matches the number in the file name. */
export interface MapFile {
  serial: number;
  savedAt: number;
  draft: MapDraft;
}

export function draftToMission(d: MapDraft): Mission {
  const layout: string[] = [];
  for (let r = 0; r < d.rows; r++) {
    let row = "";
    for (let c = 0; c < d.cols; c++) row += TILE_CHAR[d.tiles[r * d.cols + c] ?? "plains"];
    layout.push(row);
  }
  return {
    id: d.id,
    index: d.index,
    title: d.title,
    place: d.place,
    briefing: d.briefing,
    objective: d.objective,
    win: d.win,
    cols: d.cols,
    rows: d.rows,
    layout,
    tileVariants: d.tileVariants.some((v) => v) ? d.tileVariants : undefined,
    tileRots: d.tileRots?.some((r) => r) ? d.tileRots : undefined,
    decorations: d.decorations.length > 0 ? d.decorations : undefined,
    playerSpawns: d.playerSpawns.map(({ level: _level, ...s }) => s),
    enemySpawns: d.enemySpawns.map(({ level: _level, ...s }) => s),
    neutralSpawns: d.neutralSpawns?.length ? d.neutralSpawns.map(({ level: _level, ...s }) => s) : undefined,
    music: d.music || undefined,
    hub: d.hub || undefined,
    autoTactics: d.autoTactics ? undefined : false,
  };
}

/** Pads a serial the way saved file names do — three digits, same convention as the
 * numbered art variants (plains001.png). */
export function serialLabel(serial: number): string {
  return String(serial).padStart(3, "0");
}

export function mapFileName(id: string, serial: number): string {
  return `${id}-${serialLabel(serial)}.json`;
}

const MAP_MODULES = import.meta.glob<MapFile>("./maps/*.json", { eager: true, import: "default" });

/** Every saved file, newest serial per scenario id. Two files for the same id (vau-001,
 * vau-002) are the same scenario twice — the higher serial is the one that plays, the
 * lower stays on disk as the rollback. */
function latestPerScenario(): Map<string, MapFile> {
  const best = new Map<string, MapFile>();
  for (const file of Object.values(MAP_MODULES)) {
    if (!file || typeof file !== "object" || !file.draft?.id) continue;
    const current = best.get(file.draft.id);
    if (!current || file.serial > current.serial) best.set(file.draft.id, file);
  }
  return best;
}

const LATEST = latestPerScenario();

/** Saved maps, as playable Missions. */
export const SAVED_MISSIONS: Mission[] = [...LATEST.values()].map((f) => draftToMission(f.draft));

/** Every saved version on disk for one scenario id, oldest serial first — what the
 * editor lists so an earlier save can be reopened. */
export function savedVersionsFor(id: string): MapFile[] {
  return Object.values(MAP_MODULES)
    .filter((f): f is MapFile => !!f && typeof f === "object" && f.draft?.id === id)
    .sort((a, b) => a.serial - b.serial);
}

export function latestSerialFor(id: string): number {
  return LATEST.get(id)?.serial ?? 0;
}

/** Every scenario that has at least one saved file, with how many files it has.
 *
 * The editor's picker is built from this. Without it the only way to reach a map saved
 * to disk was to already know its id and type it into "Cenário alvo" — the files were
 * there and the editor offered no way to find them. */
export function savedScenarios(): { id: string; files: number; latest: number }[] {
  const counts = new Map<string, number>();
  for (const file of Object.values(MAP_MODULES)) {
    if (!file || typeof file !== "object" || !file.draft?.id) continue;
    counts.set(file.draft.id, (counts.get(file.draft.id) ?? 0) + 1);
  }
  return [...counts].map(([id, files]) => ({ id, files, latest: latestSerialFor(id) }));
}

/** The newest saved draft on disk for a scenario, or undefined when it has no file. */
export function latestSavedDraft(id: string): MapDraft | undefined {
  return LATEST.get(id)?.draft;
}

/** The campaign, with saved maps applied: a saved map whose id matches a shipped mission
 * replaces it, and one with a new id is appended as a new mission. */
export const ALL_MISSIONS: Mission[] = (() => {
  const saved = new Map(SAVED_MISSIONS.map((m) => [m.id, m]));
  const merged = MISSIONS.map((m) => saved.get(m.id) ?? m);
  const shipped = new Set(MISSIONS.map((m) => m.id));
  for (const m of SAVED_MISSIONS) if (!shipped.has(m.id)) merged.push(m);
  return merged;
})();

export function missionById(id: string): Mission | undefined {
  return ALL_MISSIONS.find((m) => m.id === id);
}

/** The world map, with saved maps hung off the locations they name. A map whose
 * scenario already belongs to a location stays there; locationId is what places a map
 * that had nowhere to appear before. */
/** What the Map Editor has assigned to each location, in play order — see
 * src/game/map-order.json.
 *
 * This carries membership as well as order. A mission named under a location belongs to
 * that location whatever the shipped data or its own map file says, which is what lets a
 * campaign mission be moved: those have no map file of their own to hold a locationId.
 * Anything not named anywhere keeps its shipped home, and follows the named ones. */
const ORDER: Record<string, string[]> = ORDER_CONFIG;

/** Location a mission has been reassigned to, or undefined if it was never moved. */
function assignedLocation(missionId: string): string | undefined {
  for (const [locationId, ids] of Object.entries(ORDER)) {
    if (ids.includes(missionId)) return locationId;
  }
  return undefined;
}

function inChosenOrder(locationId: string, missionIds: string[]): string[] {
  const wanted = ORDER[locationId] ?? [];
  const first = wanted.filter((id) => missionIds.includes(id));
  return [...first, ...missionIds.filter((id) => !first.includes(id))];
}

/** The world map, with saved maps placed where they say they belong.
 *
 * A saved map's locationId is authoritative: the mission leaves whichever location used to
 * list it and joins the one it names. That is what makes moving a mission between
 * locations in the editor actually take effect — before, a mission already listed
 * somewhere kept its original home and the choice was silently dropped. */
export const ALL_LOCATIONS: WorldLocation[] = (() => {
  const moved = new Map<string, string>();
  for (const file of LATEST.values()) {
    if (file.draft.locationId) moved.set(file.draft.id, file.draft.locationId);
  }
  // map-order.json wins over a map file's own locationId: it is what the editor's Locais
  // panel writes, and it is the only way to move a mission that has no map file.
  for (const [locationId, ids] of Object.entries(ORDER)) {
    for (const id of ids) moved.set(id, locationId);
  }
  const out = WORLD_LOCATIONS.map((l) => ({
    ...l,
    missionIds: l.missionIds.filter((id) => (moved.has(id) ? moved.get(id) === l.id : true)),
  }));
  for (const [missionId, locationId] of moved) {
    const target = out.find((l) => l.id === locationId);
    if (target && !target.missionIds.includes(missionId)) target.missionIds.push(missionId);
  }
  return out.map((l) => ({ ...l, missionIds: inChosenOrder(l.id, l.missionIds) }));
})();

/** Where a mission has been reassigned to, if anywhere — the editor shows this so a moved
 * mission reads as moved rather than as missing from its shipped home. */
export { assignedLocation };

export function locationForMission(missionId: string): WorldLocation | undefined {
  return ALL_LOCATIONS.find((l) => l.missionIds.includes(missionId));
}

export function missionsForLocation(loc: WorldLocation): Mission[] {
  const live = ALL_LOCATIONS.find((l) => l.id === loc.id) ?? loc;
  return live.missionIds.map((id) => missionById(id)).filter((m): m is Mission => !!m);
}

/** How many missions a location is meant to end up holding — the plan for it, set in the
 * Map Editor and stored in src/game/map-slots.json. Declaring Misty Cave as 3 says three
 * battles belong there, so the editor can show 1 of 3 filled and 2 still to author.
 *
 * This is authoring bookkeeping only: it does not gate the world map or the campaign. A
 * location plays whatever missions actually exist for it, whether that is under or over
 * the declared count. Unlike a map, the file is config rather than a version — a new
 * count replaces the old one instead of appending a serial. */
const SLOTS: Record<string, number> = SLOT_CONFIG;

export function slotsFor(locationId: string): number {
  const n = SLOTS[locationId];
  return typeof n === "number" && n > 0 ? Math.floor(n) : 0;
}

/** What a location currently holds against what it is meant to hold. `declared` is 0 when
 * no count has been set, which reads as "no plan yet" rather than "zero slots". */
export function locationFill(locationId: string): { filled: number; declared: number; empty: number } {
  const loc = ALL_LOCATIONS.find((l) => l.id === locationId);
  const filled = loc ? loc.missionIds.length : 0;
  const declared = slotsFor(locationId);
  return { filled, declared, empty: Math.max(0, declared - filled) };
}

/** Every location's plan, for the editor's picker. */
export const LOCATION_SLOTS: Record<string, number> = { ...SLOTS };
