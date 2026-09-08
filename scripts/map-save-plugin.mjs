/**
 * Dev-only `/__map-save` endpoint: writes a Map Editor draft to a real file
 * under `src/game/maps/`, so a map authored in the browser lands in the repo
 * instead of only in that browser's localStorage.
 *
 * The file name is the map's own scenario id plus a serial — `vau-001.json`,
 * `vau-002.json` — so a map is found again by its name, and every save appends
 * the next serial rather than overwriting the last one (delete the newer file
 * to roll back). `src/game/mapstore.ts` globs the folder and plays the highest
 * serial for each id.
 *
 * `apply: "serve"` keeps the route out of deployed apps: it exists only while
 * `npm run dev` is running, which is the only time there is a repo to write to.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MAP_SAVE_ROUTE = "/__map-save";

/** Sets how many missions a location is meant to hold — see src/game/map-slots.json. */
export const SLOTS_SAVE_ROUTE = "/__map-slots";

/** Sets the play order of the missions at each location — see src/game/map-order.json. */
export const ORDER_SAVE_ROUTE = "/__map-order";

/** Where saved maps live, relative to the project root. */
export const MAPS_DIR = join("src", "game", "maps");

/** The per-location slot counts, relative to the project root. Config, not a version:
 * a new count replaces the old one rather than appending a serial. */
export const SLOTS_FILE = join("src", "game", "map-slots.json");

/** Per-location mission order, same config-not-a-version treatment as the slot counts. */
export const ORDER_FILE = join("src", "game", "map-order.json");

/** Deletes one saved map file — the editor's way to throw away a version it created.
 * Saves only ever stack up, so without this the folder is write-only. */
export const MAP_DELETE_ROUTE = "/__map-delete";

/** A scenario id is a file name, so it may only hold characters that are safe in one —
 * this is what stops a crafted id from writing outside the maps folder. */
export function isSafeMapId(id) {
  return typeof id === "string" && id.length > 0 && id.length <= 64 && /^[a-z0-9][a-z0-9-]*$/.test(id);
}

/** The next unused serial for a scenario: one past the highest `<id>-NNN.json`
 * already on disk, so saves stack up instead of clobbering each other. */
export function nextSerial(dir, id) {
  let highest = 0;
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return 1;
  }
  const pattern = new RegExp(`^${id}-(\\d{3})\\.json$`);
  for (const name of entries) {
    const match = pattern.exec(name);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return highest + 1;
}

/** A name this route is allowed to delete: exactly what a save writes — a safe id, a
 * three-digit serial, `.json`. No path separators can survive it, so the name can never
 * reach outside the maps folder, and README.md and anything hand-added is not matchable. */
export function isSavedMapFile(name) {
  if (typeof name !== "string") return false;
  const match = /^([a-z0-9][a-z0-9-]*)-\d{3}\.json$/.exec(name);
  return !!match && isSafeMapId(match[1]);
}

function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > limitBytes) {
        reject(new Error("map too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Reads a JSON file back after writing it, so a save can be confirmed rather than assumed.
 * Returns null if it cannot be read, which is itself worth reporting. */
function readBack(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function mapSavePlugin() {
  return {
    name: "ember:map-save",
    apply: "serve",
    configureServer(server) {
      const dir = join(server.config.root, MAPS_DIR);
      const slotsPath = join(server.config.root, SLOTS_FILE);
      const orderPath = join(server.config.root, ORDER_FILE);
      server.middlewares.use((req, res, next) => {
        const pathOnly = (req.url ?? "").split("?", 1)[0];
        const isMap = pathOnly === MAP_SAVE_ROUTE;
        const isSlots = pathOnly === SLOTS_SAVE_ROUTE;
        const isOrder = pathOnly === ORDER_SAVE_ROUTE;
        const isDelete = pathOnly === MAP_DELETE_ROUTE;
        if ((!isMap && !isSlots && !isOrder && !isDelete) || (req.method ?? "GET").toUpperCase() !== "POST") {
          next();
          return;
        }
        const reply = (status, payload) => {
          const body = Buffer.from(JSON.stringify(payload), "utf8");
          res.statusCode = status;
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.setHeader("cache-control", "no-cache");
          res.setHeader("content-length", String(body.byteLength));
          res.end(body);
        };
        readBody(req, 8 * 1024 * 1024)
          .then((raw) => {
            if (isOrder) {
              const wanted = JSON.parse(raw);
              const cleaned = {};
              for (const [locationId, ids] of Object.entries(wanted ?? {})) {
                if (!isSafeMapId(locationId) || !Array.isArray(ids)) continue;
                const list = ids.filter((id) => isSafeMapId(id));
                if (list.length > 0) cleaned[locationId] = list;
              }
              writeFileSync(orderPath, JSON.stringify(cleaned, null, 2) + "\n", "utf8");
              // Read it straight back off disk: the confirmation the editor shows is then
              // proof the file exists and holds this, not a promise that a write was tried.
              reply(200, { ok: true, file: ORDER_FILE, order: cleaned, onDisk: readBack(orderPath) });
              return;
            }
            if (isSlots) {
              const wanted = JSON.parse(raw);
              const cleaned = {};
              for (const [id, count] of Object.entries(wanted ?? {})) {
                if (!isSafeMapId(id)) continue;
                const n = Math.floor(Number(count));
                if (Number.isFinite(n) && n > 0) cleaned[id] = n;
              }
              writeFileSync(slotsPath, JSON.stringify(cleaned, null, 2) + "\n", "utf8");
              reply(200, { ok: true, file: SLOTS_FILE, slots: cleaned, onDisk: readBack(slotsPath) });
              return;
            }
            if (isDelete) {
              const name = JSON.parse(raw)?.file;
              if (!isSavedMapFile(name)) {
                reply(400, { ok: false, error: `nome de arquivo inválido: ${String(name)}` });
                return;
              }
              const full = join(dir, name);
              if (!existsSync(full)) {
                reply(404, { ok: false, error: `${name} não existe` });
                return;
              }
              unlinkSync(full);
              // Same evidence rule as a save: check the disk rather than assume.
              reply(200, { ok: true, file: `${MAPS_DIR}/${name}`, stillOnDisk: existsSync(full) });
              return;
            }
            const draft = JSON.parse(raw);
            if (!isSafeMapId(draft?.id)) {
              reply(400, { ok: false, error: "id inválido — use letras minúsculas, números e hífens" });
              return;
            }
            mkdirSync(dir, { recursive: true });
            const serial = nextSerial(dir, draft.id);
            const file = `${draft.id}-${String(serial).padStart(3, "0")}.json`;
            const full = join(dir, file);
            writeFileSync(full, JSON.stringify({ serial, savedAt: Date.now(), draft }, null, 2) + "\n", "utf8");
            reply(200, { ok: true, serial, file: `${MAPS_DIR}/${file}`, bytes: statSync(full).size });
          })
          .catch((err) => reply(400, { ok: false, error: String(err?.message ?? err) }));
      });
    },
  };
}
