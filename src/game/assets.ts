import { DECORATIONS, decorationImage } from "./data";
import type { GameArt, SpriteId, TerrainId } from "./types";

// Number of art variants available per terrain, e.g. plains001.png / plains002.png.
// Index 0 (the "001" file) is what every mission renders with unless it names a
// different variant in Mission.tileVariants — keep it as the tile that's safe
// for existing maps.
export const TILE_VARIANT_COUNT: Record<TerrainId, number> = {
  plains: 15,
  woods: 7,
  ruins: 7,
  water: 22,
  ember: 5,
  hill: 4,
  flame: 3,
  column: 2,
  nave: 2,
  barricade: 1,
  highwood: 1,
  highruin: 1,
  chest: 1,
  door: 1,
  deadtree: 1,
  void: 1,
  crag: 1,
};

/** The art file a tile variant paints with, without path or cache-buster — "woods002".
 * Two variants of the same terrain differ only in art, so this is the only way to tell
 * from a painted map which of them a cell is actually using. */
export function tileVariantName(id: TerrainId, variant: number): string {
  // New ground materials are inserted ahead of the legacy plains without renaming
  // their on-disk files, so saved maps keep their original art available.
  if (id === "plains") {
    if (variant === 0) return "plains016";
    if (variant === 1) return "plains015";
    if (variant === 2) return "plains001";
    return `plains${String(variant).padStart(3, "0")}`;
  }
  if (id === "water" && variant === 0) return "water023";
  if (id === "woods") {
    if (variant === 0) return "woods005";
    if (variant === 1) return "woods006";
    if (variant === 6) return "woods007";
    return `woods${String(variant - 1).padStart(3, "0")}`;
  }
  // Borrowed art: a crag has no drawing of its own yet, and loadGameArt rejects on any
  // missing file, so pointing it at the column rock keeps the boot intact. A tall rock
  // reads correctly for it, and the prop that stamped it draws over the top anyway.
  if (id === "crag") return "column001";
  if (id === "hill") return `hill${String(variant + 4).padStart(3, "0")}`;
  if (id === "ruins") {
    if (variant === 0) return "ruins005";
    if (variant <= 4) return `ruins${String(variant).padStart(3, "0")}`;
    return `ruins${String(variant + 1).padStart(3, "0")}`;
  }
  return `${id}${String(variant + 1).padStart(3, "0")}`;
}

export function tileVariantSrc(id: TerrainId, variant: number): string {
  return `/game/tiles/${tileVariantName(id, variant)}.png?v=55`;
}
const TILES = Object.keys(TILE_VARIANT_COUNT) as TerrainId[];
const SPRITES: SpriteId[] = ["kael", "nira", "voss", "salazar", "malrec", "aldric", "defaultLancer", "soldier", "brigand", "captain", "sorcerer", "horror", "Asherah", "pikeman", "wardog", "troll", "morvenian-wolf", "butcher", "birolho", "familiar", "swamp-blue-calf", "ancient-golem", "lancer", "sandoval", "kaelFinal", "kaelEarly", "conjurer"];

const LOAD_POOL = 8;
let loadActive = 0;
const loadWait: (() => void)[] = [];

function acquireLoad(): Promise<void> {
  if (loadActive < LOAD_POOL) {
    loadActive++;
    return Promise.resolve();
  }
  return new Promise((resolve) => loadWait.push(() => {
    loadActive++;
    resolve();
  }));
}

function releaseLoad(): void {
  loadActive--;
  const next = loadWait.shift();
  if (next) next();
}

function spriteFrameSrc(id: SpriteId, frame: string, cacheBust = ""): string {
  // Conjurer's active art is kept as a complete, source-preserved serial. Talk drives idle; the former Idle sheet drives casting.
  const directory = id === "conjurer" ? "conjurer/conjurer-complete-003" : id === "sandoval" ? "sandoval/sandoval-complete-001" : id === "kael" || id === "kaelFinal" ? "Kael_Final/kael-final-002" : id === "kaelEarly" ? "kael" : id;
  return `/game/sprites/${directory}/${frame}.png${cacheBust}`;
}
function loadImage(src: string): Promise<HTMLImageElement> {
  return acquireLoad().then(
    () =>
      new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        const fail = () => reject(new Error(`Falha ao carregar ${src}`));
        const t = window.setTimeout(() => {
          done();
          fail();
        }, 20000);
        const done = () => {
          window.clearTimeout(t);
          releaseLoad();
        };
        img.onload = () => {
          done();
          resolve(img);
        };
        img.onerror = () => {
          done();
          fail();
        };
        img.src = src;
      }),
  );
}

// Sprites cut as a 12-frame idle rather than the 4-frame default — the heroes, the two
// big horrors, and the two creatures cut from reference video (familiar, ancient golem).
// loadGameArt rejects on any missing file, so this set and what is on disk have to move
// together.
const HERO_IDLE = new Set<SpriteId>(["kael", "nira", "voss", "salazar", "malrec", "aldric", "defaultLancer", "horror", "Asherah", "familiar", "ancient-golem", "lancer", "sandoval", "kaelFinal", "kaelEarly", "conjurer"]);

export async function loadGameArt(): Promise<GameArt> {
  const tiles = {} as Record<TerrainId, HTMLImageElement[]>;
  await Promise.all(
    TILES.map(async (id) => {
      const n = TILE_VARIANT_COUNT[id];
      tiles[id] = await Promise.all(Array.from({ length: n }, (_, i) => loadImage(tileVariantSrc(id, i))));
    }),
  );
  const decorations = {} as Record<string, HTMLImageElement>;
  await Promise.all(
    Object.keys(DECORATIONS).map(async (id) => {
      decorations[id] = await loadImage(decorationImage(id));
    }),
  );
  const sprites = {} as Record<SpriteId, HTMLImageElement[]>;
  const attacks: Partial<Record<SpriteId, HTMLImageElement[]>> = {};
  await Promise.all(
    SPRITES.map(async (id) => {
      const n = id === "conjurer" || id === "kael" || id === "kaelFinal" ? 36 : id === "sandoval" ? 8 : HERO_IDLE.has(id) ? 12 : 4;
      const cacheBust = id === "troll" ? "?v=11" : id === "Asherah" ? "?v=3" : id === "familiar" ? "?v=6" : id === "malrec" || id === "aldric" || id === "defaultLancer" ? "?v=sheet2" : id === "lancer" ? "?v=3" : id === "sandoval" ? "?v=sandoval-complete-001" : id === "kael" || id === "kaelFinal" ? "?v=kael-final-002" : id === "kaelEarly" ? "?v=kael-early" : id === "conjurer" ? "?v=conjurer-complete-003" : "";
      sprites[id] = await Promise.all(
        Array.from({ length: n }, (_, i) =>
          loadImage(spriteFrameSrc(id, id === "conjurer" ? `talk-${i + 1}` : `${i + 1}`, cacheBust)),
        ),
      );
    }),
  );
  // Attack cuts, per sprite: how many atk-*.png frames are on disk, and the cache-bust the
  // set was last republished under. attackPose spreads whatever count it finds across the
  // lunge/hit/recover stages, so a set only has to be listed here to animate.
  const ATTACK_FRAMES: Partial<Record<SpriteId, { n: number; bust: string }>> = {
    // Kael is now the Final set; Kael Early preserves the former main-character cut.
    kael: { n: 36, bust: "?v=kael-final-002" },
    kaelEarly: { n: 12, bust: "?v=kael-early" },
    nira: { n: 4, bust: "" },
    voss: { n: 4, bust: "" },
    salazar: { n: 4, bust: "" },
    malrec: { n: 5, bust: "?v=sheet2" },
    aldric: { n: 5, bust: "?v=sheet2" },
    defaultLancer: { n: 5, bust: "?v=sheet2" },
    familiar: { n: 8, bust: "?v=6" },
    "ancient-golem": { n: 8, bust: "" },
    "morvenian-wolf": { n: 6, bust: "" },
    birolho: { n: 4, bust: "" },
    butcher: { n: 4, bust: "" },
    lancer: { n: 6, bust: "?v=3" },
    sandoval: { n: 6, bust: "?v=sandoval-complete-001" },
    kaelFinal: { n: 36, bust: "?v=kael-final-002" },
    conjurer: { n: 36, bust: "?v=conjurer-complete-003" },
  };
  await Promise.all(
    (Object.keys(ATTACK_FRAMES) as SpriteId[]).map(async (id) => {
      const { n, bust } = ATTACK_FRAMES[id]!;
      attacks[id] = await Promise.all(Array.from({ length: n }, (_, i) => loadImage(spriteFrameSrc(id, `atk-${i + 1}`, bust))));
    }),
  );
  // Cast pose: cast-*.png, same shape as the attack table — a sprite absent from here falls
  // back to its attacks cut (the melee swing) for a spell just like it always did before this
  // existed.
  const CAST_FRAMES: Partial<Record<SpriteId, { n: number; bust: string }>> = {
    birolho: { n: 3, bust: "" },
    // The spell cast intentionally uses the former Idle sheet; ATT remains the physical attack.
    conjurer: { n: 36, bust: "?v=conjurer-complete-003" },
  };
  const casts: Partial<Record<SpriteId, HTMLImageElement[]>> = {};
  await Promise.all(
    (Object.keys(CAST_FRAMES) as SpriteId[]).map(async (id) => {
      const { n, bust } = CAST_FRAMES[id]!;
      casts[id] = await Promise.all(Array.from({ length: n }, (_, i) => loadImage(spriteFrameSrc(id, id === "conjurer" ? `${i + 1}` : `cast-${i + 1}`, bust))));
    }),
  );
  // Walk cycles: move-*.png, same shape as the attack table. A sprite absent from here has
  // no walk cut and falls back to its idle loop played faster, as every sprite used to.
  const WALK_FRAMES: Partial<Record<SpriteId, { n: number; bust: string }>> = {
    familiar: { n: 8, bust: "?v=6" },
    "ancient-golem": { n: 8, bust: "" },
    malrec: { n: 6, bust: "?v=sheet2" },
    aldric: { n: 6, bust: "?v=sheet2" },
    defaultLancer: { n: 6, bust: "?v=sheet2" },
    lancer: { n: 6, bust: "?v=3" },
    sandoval: { n: 6, bust: "?v=sandoval-complete-001" },
    // Kael Final is the default set; its sole right-facing walk mirrors left automatically.
    kael: { n: 36, bust: "?v=kael-final-002" },
    // One authored right-facing walk. The renderer mirrors it for left-facing movement.
    kaelFinal: { n: 36, bust: "?v=kael-final-002" },
    conjurer: { n: 36, bust: "?v=conjurer-complete-003" },
  };
  const walks: Partial<Record<SpriteId, HTMLImageElement[]>> = {};
  await Promise.all(
    (Object.keys(WALK_FRAMES) as SpriteId[]).map(async (id) => {
      const { n, bust } = WALK_FRAMES[id]!;
      walks[id] = await Promise.all(Array.from({ length: n }, (_, i) => loadImage(spriteFrameSrc(id, `move-${i + 1}`, bust))));
    }),
  );
  const walksLeft: Partial<Record<SpriteId, HTMLImageElement[]>> = {};
  const attacksLeft: Partial<Record<SpriteId, HTMLImageElement[]>> = {};
  const DIR_LEFT: SpriteId[] = ["malrec", "aldric", "defaultLancer", "lancer", "sandoval"];
  await Promise.all(
    DIR_LEFT.map(async (id) => {
      const walkN = WALK_FRAMES[id]?.n ?? 6;
      const atkN = ATTACK_FRAMES[id]?.n ?? 5;
      const bust = id === "lancer" ? "?v=3" : id === "sandoval" ? "?v=sandoval-complete-001" : "?v=sheet2";
      walksLeft[id] = await Promise.all(Array.from({ length: walkN }, (_, i) => loadImage(spriteFrameSrc(id, `move-left-${i + 1}`, bust))));
      attacksLeft[id] = await Promise.all(Array.from({ length: atkN }, (_, i) => loadImage(spriteFrameSrc(id, `atk-left-${i + 1}`, bust))));
    }),
  );
  const impact = await Promise.all([1, 2, 3, 4].map((n) => loadImage(`/game/fx/impact-${n}.png`)));
  const fireballCore = await loadImage("/game/fx/fireball-core-v1.png?v=1");
  const causticVenomCore = await loadImage("/game/fx/caustic-venom-core-v1.png?v=1");
  const arrowCore = await loadImage("/game/fx/arrow-002.png?v=1");
  const lightningCores = await Promise.all([
    loadImage("/game/fx/lightning-core-v1.png?v=1"),
    loadImage("/game/fx/lightning-core-v2.png?v=1"),
    loadImage("/game/fx/lightning-core-v3.png?v=1"),
  ]);
  const backdrops: Record<string, HTMLImageElement> = {
    profundezas: await loadImage("/game/assets/profundezas-bg.jpg?v=2"),
    thebridge: await loadImage("/game/assets/thebridge-bg.jpg?v=1"),
  };
  const idles: Partial<Record<SpriteId, HTMLImageElement[]>> = {
    kaelEarly: await Promise.all(Array.from({ length: 36 }, (_, i) => loadImage(`/game/sprites/kael/stand-${i + 1}.png?v=kael-early`))),
  };
  const walkDirs: GameArt["walkDirs"] = {
    kaelEarly: {
      front: await loadImage("/game/sprites/kael/walk-front.png?v=kael-early"),
      back: await loadImage("/game/sprites/kael/walk-back.png?v=kael-early"),
      side: await loadImage("/game/sprites/kael/walk-side.png?v=kael-early"),
    },
    // No side-on art for either — the idle/front frame stands in, same as it already does for
    // any sprite with no walkDirs entry at all, so a purely sideways step doesn't visibly swap.
    birolho: {
      front: await loadImage("/game/sprites/birolho/1.png"),
      back: await loadImage("/game/sprites/birolho/back.png"),
      side: await loadImage("/game/sprites/birolho/1.png"),
    },
    butcher: {
      front: await loadImage("/game/sprites/butcher/front.png"),
      back: await loadImage("/game/sprites/butcher/back.png"),
      side: await loadImage("/game/sprites/butcher/front.png"),
    },
  };
  return { tiles, decorations, sprites, attacks, attacksLeft, casts, walks, walksLeft, idles, walkDirs, impact, fireballCore, causticVenomCore, arrowCore, lightningCores, backdrops };
}
