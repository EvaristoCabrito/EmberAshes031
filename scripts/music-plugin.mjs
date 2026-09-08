import { existsSync, mkdirSync, readdirSync, renameSync, statSync, writeFileSync, readFileSync, copyFileSync, unlinkSync } from "node:fs";
import { join, extname, basename, relative } from "node:path";

/**
 * Keeps every music file in one place, so a track can be dropped anywhere in the repo and
 * still turn up in the editor's Trilha dropdown.
 *
 * On dev start (and on any add while the server runs) this sweeps the working tree for
 * audio, moves what it finds into public/game/MUSIC, and rewrites the manifest that
 * MUSIC_TRACKS reads. Nothing is renamed and nothing is deleted: a file whose name is
 * already taken in the destination stays exactly where it is and is reported, because two
 * different tracks sharing a name is the author's call to make, not this script's.
 */

const AUDIO = new Set([".mp3", ".wav", ".ogg", ".m4a", ".flac"]);
const SKIP = new Set(["node_modules", ".git", ".vercel", "dist", ".output", ".nitro", ".cache", ".vite"]);
/** Effects live under MUSIC/SoundFX and are not tracks: never swept, never listed. */
const FX = "SoundFX";
const DEST = join("public", "game", "MUSIC");
const MANIFEST = join("src", "game", "music-manifest.json");

function walk(dir, root, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP.has(e.name)) continue;
      if (relative(root, full) === DEST) continue;
      if (e.name === FX) continue;
      walk(full, root, out);
    } else if (AUDIO.has(extname(e.name).toLowerCase())) {
      out.push(full);
    }
  }
  return out;
}

/** Moves stray audio into the music folder and rewrites the manifest. Returns what it did.
 *
 * This is a convenience and must never be load-bearing: the manifest it writes is committed,
 * so the game has its track list whether or not this ever runs. A read-only or otherwise
 * restricted filesystem — a hosted preview sandbox, say — must not be able to stop the dev
 * server from starting, so every filesystem call here is allowed to fail and be skipped. */
export function sweepMusic(root) {
  const moved = [];
  const clashed = [];
  const failed = [];
  const dest = join(root, DEST);
  try {
    mkdirSync(dest, { recursive: true });
  } catch (e) {
    return { moved, clashed, failed, total: 0, changed: false, error: String(e && e.message) };
  }
  let strays = [];
  try {
    strays = walk(root, root, []);
  } catch {
    strays = [];
  }
  for (const src of strays) {
    const name = basename(src);
    const target = join(dest, name);
    if (existsSync(target)) {
      // A stray sharing a name with a track already gathered: left where it is. Two
      // different tracks under one name is the author's call, and nothing here deletes.
      clashed.push(relative(root, src));
      continue;
    }
    let ok = false;
    try {
      renameSync(src, target);
      ok = true;
    } catch {
      try {
        // Rename fails across devices; copy, then drop the source we just copied.
        copyFileSync(src, target);
        unlinkSync(src);
        ok = true;
      } catch (e) {
        failed.push(`${relative(root, src)} (${e && e.code ? e.code : "erro"})`);
      }
    }
    if (ok) moved.push(name);
  }
  // Only what sits directly in MUSIC is a track — SoundFX is a folder, and skipped above.
  let files = [];
  try {
    files = readdirSync(dest)
      .filter((f) => AUDIO.has(extname(f).toLowerCase()))
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase(), "pt-BR", { sensitivity: "base" }));
  } catch (e) {
    return { moved, clashed, failed, total: 0, changed: false, error: String(e && e.message) };
  }
  const manifest = join(root, MANIFEST);
  const next = JSON.stringify(files, null, 2) + "\n";
  let prev = "";
  try {
    prev = existsSync(manifest) ? readFileSync(manifest, "utf8") : "";
  } catch {
    prev = next; // unreadable: leave whatever is committed alone
  }
  let changed = false;
  if (prev !== next) {
    try {
      writeFileSync(manifest, next);
      changed = true;
    } catch (e) {
      failed.push(`${MANIFEST} (${e && e.code ? e.code : "erro"})`);
    }
  }
  return { moved, clashed, failed, total: files.length, changed };
}

export function musicPlugin() {
  let root = process.cwd();
  // Nothing this plugin does may stop the server coming up: the committed manifest is the
  // real source of the track list, and this only keeps it tidy.
  const run = (why) => {
    let r;
    try {
      r = sweepMusic(root);
    } catch (e) {
      console.warn(`[music] varredura ignorada (${e && e.message}) — a lista commitada continua valendo`);
      return;
    }
    if (r.error) console.warn(`[music] varredura ignorada (${r.error}) — a lista commitada continua valendo`);
    if (r.moved.length) console.log(`[music] ${why}: ${r.moved.length} faixa(s) recolhida(s) → ${DEST}\n[music]   ${r.moved.join("\n[music]   ")}`);
    for (const c of r.clashed) console.log(`[music] ${c} tem o mesmo nome de uma faixa já recolhida — deixada onde está`);
    for (const f of r.failed ?? []) console.warn(`[music] não deu para mover ${f} — deixado onde está`);
    if (r.changed) console.log(`[music] lista atualizada: ${r.total} faixa(s)`);
  };
  return {
    name: "ember-music",
    apply: "serve",
    configResolved(cfg) {
      root = cfg.root ?? process.cwd();
      run("início");
    },
    // Deliberately no watcher hook. An "add" listener re-swept the whole tree per file, and
    // a watcher can emit an add for every file it already knows about — hundreds of full
    // walks while the server is trying to come up, which is a hang, not a crash, and shows
    // up as a gateway timing the preview out. One sweep at startup is enough: a track added
    // while the server runs is picked up on the next start.
  };
}
