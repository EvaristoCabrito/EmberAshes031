import { CAUSTIC_VENOM, CHEST_LOOT, CLASSES, CLEAVE, cleaveFormula, cleavePower, CURE_DISEASE, CURES, DECORATIONS, DISEASE, DOUBLE_STRIKE, doubleStrikeFormula, doubleStrikePower, EMPTY_BAG, EQUIPMENT, EXP_TO_LEVEL, expForHit, FIREBALL, FOOTPRINT_TYPE_7, FOOTPRINT_TYPE_8, KILL_DROP_CHANCE, LIGHTNING, LONG_SHOT, longShotFormula, longShotPower, MAGIC_MISSILE, magicMissileCount, MAX_LEVEL, PIERCING, piercingMul, PIERCING_THRUST, POTION_CARRY_MAX, POTIONS, SUMMON_FAMILIAR, SWEEP, TRIP, WEAPON_MAX_ENH, WEAPONS, WEB_OF_DREAMS, healFormula, barricadeDecor, decorationCells, decorationFacing, decorationImage, diceFormula, effectiveMaxRange, enemyLevelFor, equipmentIcon, fireballFormula, fireballOrigin, fireballPower, fireballRangeTiles, fireballTiles, hexAreaTiles, isProjectile, isSummonClass, lightningDice, lightningFormula, missionGearLevel, parseLayout, placedFootprint, potionLabel, rollCure, rollDice, rollPotion, spellFormula, spellTier, starterWeaponFor, STARTING_BAG, statsFor, terrainNote, TERRAIN, tierKey, tierUses, gearStatBonus, offHandBlocked, weaponIcon, weaponRoll, weightedLootPick, weightedPotionPick, weightedWeaponPick, MULTI_SHOT, multiShotFormula, multiShotPower, multiShotTargets, SECOND_WIND, secondWindPct, auraPower, AURA_OF_PROTECTION, INTIMIDATING_PRESENCE, DIVINE_WRATH, divineWrathFormula, divineWrathPower, SHOULDER_SMASH, shoulderSmashFormula, shoulderSmashPower, STAMPEDE, stampedeFormula, stampedePower, cultistSpellUses, brigandSpellUses, birolhoSpellUses } from "./data";
import type { SpellTier } from "./data";
import { canCounter, makeForecast, mulberry32, powerOf, protOf, rollDamage, rollDamageCustom } from "./combat";
import {
  attackableEnemies,
  canHitFrom,
  clearShot,
  computeReachable,
  computeThreat,
  cleaveHexes,
  cubeAdd,
  cubeRound,
  cubeToOddr,
  footprint,
  footprintFrontRow,
  hexNeighbors,
  hexDist,
  inBounds,
  inWeaponRange,
  key,
  manhattan,
  occupancy,
  occupies,
  oddrToCube,
  piercingLine,
  shotKind,
  allAxisRays,
  reconstructPath,
  terrainDistanceField,
  tileAt,
  unitSize,
  type ReachCell,
} from "./pathfinding";
import { sfxPlay } from "./audio";
import type {
  Bag,
  ClassId,
  DecorationPlacement,
  Forecast,
  GameArt,
  HealId,
  HudSnapshot,
  InputMode,
  Mission,
  Phase,
  Point,
  PotionId,
  SpellKind,
  TerrainId,
  TierKey,
  Unit,
  UnitPublic,
  EquipSlot,
} from "./types";

interface Layout {
  ox: number;
  oy: number;
  tile: number;
  cols: number;
  rows: number;
}

interface Particle {
  live: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  color: string;
  text?: string;
  kind: "spark" | "text" | "impact";
  frame: number;
}

const PARTICLE_CAP = 32;
const ZOOM_RADII = [22, 34, 50, 72];

/** Level-up flourish: a small pixel-space burst anchored to a unit's hex (recomputed every
 * frame from its live position, so it still tracks correctly if the unit somehow moves mid-
 * burst) rather than routed through the hex-grid-snapped Particle system above — that one
 * always renders at its host hex's exact center, which is right for a hit-spark but too
 * coarse for sparks that are meant to actually scatter. */
interface LevelUpSpark {
  live: boolean;
  unitId: string;
  kind: "ring" | "star" | "label";
  /** Offset from the unit's hex center, in pixels at the burst's own tile scale — rescaled by
   * the live cell size at draw time so it still reads right after a zoom change. */
  dx: number;
  dy: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  hue: number;
  rot: number;
  vrot: number;
  refCell: number;
  text?: string;
}

const LEVEL_UP_FX_CAP = 44;

function blankLevelUpSpark(): LevelUpSpark {
  return {
    live: false,
    unitId: "",
    kind: "star",
    dx: 0,
    dy: 0,
    vx: 0,
    vy: 0,
    life: 0,
    max: 1,
    size: 1,
    hue: 46,
    rot: 0,
    vrot: 0,
    refCell: 1,
  };
}

/** How long Magic Missile's bolt takes to reach its target — stepSpell's own hit/damage tick
 * for a magicMissile cast fires at exactly this time (see MISSILE_HIT_AT below) instead of
 * the normal 0.18, so slowing this down keeps the impact flash/number landing right as the
 * bolt visually arrives instead of drifting out of sync with it. */
const MISSILE_TRAVEL = 0.34;
/** stepSpell's hit tick, per spellKind — every other spell keeps the original 0.18; only
 * Magic Missile's is tied to its own (now longer) travel time. */
const MISSILE_HIT_AT = MISSILE_TRAVEL;
/** Arrows travel deliberately slower than arcane bolts. */
const ARROW_TRAVEL = MISSILE_TRAVEL * 1.25;
/** How much longer the bolt's glowing trail lingers on screen, fading, after the bolt
 * itself has already landed. Kept short enough that MISSILE_TRAVEL + this stays under 0.55
 * — stepSpell's own finishCombat threshold for every spell — so the trail's afterglow never
 * outlives the active step it belongs to. */
const MISSILE_AFTERGLOW = 0.2;

/** A traveling spell bolt (currently just Magic Missile) — hex-to-hex in pixel space, timed to
 * land right as stepSpell's own hit/damage tick fires (a.t >= MISSILE_HIT_AT), so the streak
 * and the impact flash/number line up without the two systems knowing about each other. */
interface MissileFx {
  live: boolean;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  t: number;
  max: number;
  hue: number;
  kind: "magicMissile" | "fireball" | "causticVenom" | "longShot" | "arcaneBolt";
  seed: number;
}

const HOUSE_DECORATION_IDS = new Set(["ruined-cottage", "broken-tower", "ruined-chapel", "abandoned-mansion", "burning-house", "burnt-house-ruins", "burning-hamlet", "small-house", "stone-hut"]);

const MISSILE_FX_CAP = 12;
/** A brief, code-drawn patch of fire on one affected Fireball hex. */
interface FireballBurstFx {
  live: boolean;
  x: number;
  y: number;
  t: number;
  max: number;
  seed: number;
  kind: "fireball" | "causticVenom";
}
const FIREBALL_BURST_CAP = 19;
function blankFireballBurstFx(): FireballBurstFx {
  return { live: false, x: 0, y: 0, t: 0, max: 0.58, seed: 0, kind: "fireball" };
}

function blankMissileFx(): MissileFx {
  return { live: false, fromX: 0, fromY: 0, toX: 0, toY: 0, t: 0, max: MISSILE_TRAVEL + MISSILE_AFTERGLOW, travel: MISSILE_TRAVEL, hue: 268, kind: "magicMissile", seed: 0 };
}

/** How long the Lightning strike's flash lasts, start to fully faded — short and sudden on
 * purpose, a real strike rather than a travelling bolt. */
const LIGHTNING_STRIKE_DUR = 0.42;
/** How many hexes of "sky" the bolt is drawn falling from, above the struck hex. */
const LIGHTNING_FALL_HEIGHT = 3.2;

/** One fork off the main bolt — its own short jagged line, peeling away partway down. */
interface LightningBranch {
  /** 0-1, how far down the main bolt this fork leaves it. */
  at: number;
  /** -1 or 1: which side it forks toward. */
  side: number;
  /** Lateral jitter per segment, as a fraction of a tile — fixed at emit time so the bolt
   * holds a steady shape across its short life instead of jittering frame to frame. */
  segs: number[];
}

/** A bolt struck down from directly above a hex — thick, jagged, forked, gone in well under
 * half a second. The zigzag and branch shapes are generated once at emit time (see
 * emitLightningFx) and just fade over `t`, rather than being redrawn randomly every frame,
 * so the bolt reads as one firm, deliberate strike instead of a flickering scribble. */
interface LightningFx {
  live: boolean;
  x: number;
  y: number;
  t: number;
  max: number;
  hue: number;
  segs: number[];
  branches: LightningBranch[];
}

const LIGHTNING_FX_CAP = 6;

function blankLightningFx(): LightningFx {
  return { live: false, x: 0, y: 0, t: 0, max: LIGHTNING_STRIKE_DUR, hue: 205, segs: [], branches: [] };
}

function blankParticle(): Particle {
  return {
    live: false,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    life: 0,
    max: 1,
    size: 1,
    color: "#fff",
    kind: "spark",
    frame: 0,
  };
}

type Seq =
  | { type: "move"; id: string; path: Point[] }
  | {
      type: "combat";
      att: string;
      def: string;
      /** A single extra die (bonusDice = faces, bonusFlat = flat add) rolled on top of the
       * attacker's own strike. bonusDiceCount is how many of that die to roll — defaults to
       * 1 (Trip's single d8), Double Strike's higher tiers roll 2. */
      bonusDice?: number;
      bonusDiceCount?: number;
      bonusFlat?: number;
      noCounter?: boolean;
      spellKind?: SpellKind;
      /** Off-hand weapon attack: roll these dice instead of the attacker's main-hand
       * weapon. Only applied on the attacker's own strike, never on a counter. */
      customDice?: { dice: number; faces: number; bonus: number };
      /** Shield Bash: multiplies the attacker's own strike damage (e.g. 0.75). */
      dmgMul?: number;
      /** Shield Bash: chance (0-1) the strike, if it lands, stuns the defender for their
       * next turn. */
      stunChance?: number;
    }
  | { type: "spell"; att: string; tiles: Point[]; ids: string[]; dice?: number; faces?: number; bonus?: number; moreDice?: number; moreFaces?: number; label?: string; echo?: { dice: number; faces: number; bonus: number }; dmgMul?: number; weaponBonusDice?: number; weaponBonusFaces?: number; weaponBonusBonus?: number; spellKind?: SpellKind; projectileTo?: Point; centerId?: string; centerDice?: number; centerFaces?: number; centerBonus?: number; poison?: boolean; spellMul?: number; centerMul?: number }
  | { type: "heal"; att: string; def: string; kind: HealId }
  | { type: "cureDisease"; att: string; def: string }
  | { type: "banner"; text: string; dur: number }
  | { type: "delay"; dur: number }
  | { type: "checkEnd" };

interface MoveAnim {
  type: "move";
  id: string;
  path: Point[];
  i: number;
  t: number;
}

interface CombatAnim {
  type: "combat";
  att: string;
  def: string;
  stage: "lunge" | "hit" | "recover" | "counterLunge" | "counterHit" | "counterRecover" | "fade";
  t: number;
  swapped: boolean;
  bonusDice: number;
  bonusDiceCount: number;
  bonusFlat: number;
  noCounter: boolean;
  spellKind: SpellKind | null;
  customDice: { dice: number; faces: number; bonus: number } | null;
  dmgMul: number;
  stunChance: number;
}

interface SpellAnim {
  type: "spell";
  att: string;
  tiles: Point[];
  ids: string[];
  t: number;
  hit: boolean;
  extraDice: number;
  extraFaces: number;
  extraBonus: number;
  moreDice: number;
  moreFaces: number;
  echo: { dice: number; faces: number; bonus: number } | null;
  dmgMul: number;
  weaponBonusDice: number;
  weaponBonusFaces: number;
  weaponBonusBonus: number;
  spellKind: SpellKind | null;
  /** Exact hex a travelling spell projectile must reach before its AoE resolves. */
  projectileTo: Point | null;
  /** Caustic Venom: the one unit in `ids` that takes the bigger centerDice/Faces/Bonus roll
   * instead of the regular extraDice/Faces/Bonus splash roll — null for every other spell. */
  centerId: string | null;
  centerDice: number;
  centerFaces: number;
  centerBonus: number;
  /** Whether landing a hit also poisons the target (see startOfTurnEffects) — both sides,
   * Caustic Venom's splash spares no one. */
  poison: boolean;
  /** How hard the caster's own power lands for this spell. Above 1 for every spell, which
   * is what keeps a cast ahead of the plain hit the same unit could have made instead. */
  spellMul: number;
  /** The same, for Caustic Venom's centre hex, which is stronger than its splash. */
  centerMul: number;
}

interface HealAnim {
  type: "heal";
  att: string;
  def: string;
  kind: HealId;
  t: number;
  applied: boolean;
}

interface CureDiseaseAnim {
  type: "cureDisease";
  att: string;
  def: string;
  t: number;
  applied: boolean;
}

type Active =
  | MoveAnim
  | CombatAnim
  | SpellAnim
  | HealAnim
  | CureDiseaseAnim
  | { type: "banner"; text: string; t: number; dur: number }
  | { type: "delay"; t: number; dur: number };

function pub(u: Unit, restrained: boolean, movLeft: number): UnitPublic {
  return {
    id: u.id,
    name: u.name,
    classId: u.classId,
    className: u.className,
    role: u.role,
    side: u.side,
    sprite: u.sprite,
    hp: u.hp,
    maxHp: u.maxHp,
    atk: u.atk,
    mag: u.mag,
    def: u.def,
    res: u.res,
    mov: u.mov,
    movLeft,
    minRange: u.minRange,
    maxRange: u.maxRange,
    moved: u.moved,
    acted: u.acted,
    x: u.x,
    y: u.y,
    level: u.level,
    xp: u.xp,
    bag: { ...u.bag },
    spells: { ...u.spells },
    weaponId: u.weaponId,
    weaponEnh: u.weaponEnh,
    size: u.size,
    diseased: u.diseased,
    poisoned: u.poisoned,
    stunned: u.stunned,
    crippled: u.crippled,
    offHandId: u.offHandId,
    summoned: u.summoned,
    asleep: u.asleep,
    restrained,
  };
}

interface Roster {
  hp: Record<string, number>;
  levels: Record<string, number>;
  xp?: Record<string, number>;
  bags?: Record<string, Bag>;
  /** Hero name → promoted ClassId chosen at PROMOTE_LEVEL, overriding the mission spawn's base class. */
  promotions?: Record<string, ClassId>;
  /** Hero name → equipped weapon + enhancement, resolved from save.equipped/save.weapons. Falls
   * back to that class's free starter weapon when a hero has no entry yet. */
  weapons?: Record<string, { id: string; enh: number }>;
  /** Hero name → equipped offHand EquipmentDef id (shield or off-hand weapon), resolved
   * from save.equipment[hero].offHand. */
  offHand?: Record<string, string>;
  /** Hero name → every slot they have filled, straight from save.equipment. The off-hand
   * above is the one slot combat already read; this brings the rest in so worn gear can
   * contribute stats (see gearStatBonus). */
  equipment?: Record<string, Partial<Record<EquipSlot, string>>>;
  /** Enemy name → level override, for Map Editor balance-testing. Falls back to the
   * mission's uniform enemyLevelFor(index) when a name has no entry. */
  enemyLevels?: Record<string, number>;
  /** Every weapon id already in the player's save — chest and kill-drop loot rolls exclude
   * these so a drop never announces a weapon the player already has. */
  ownedWeaponIds?: string[];
  /** Hero name → tier key → spell uses already spent so far this scenario (a world-map
   * location's whole run of missions) — carried in from the previous mission(s) so spell
   * charges don't refill until the scenario ends, per direct instruction. Undefined/omitted
   * means "reset to full," used for a scenario's first mission and for Stone Bridge, which
   * always resets (it's the tutorial). See GameApp.tsx's startBattle for who computes this. */
  spellSpent?: Record<string, Partial<Record<TierKey, number>>>;
}

/** Remaining uses for one spell tier at spawn — the class/level cap minus whatever the
 * roster says this hero already spent so far this scenario (see Roster.spellSpent), never
 * below 0. Always 0 for enemies, matching the previous unconditional side-check inline. */
function remainingTier(classId: ClassId, tier: SpellTier, key: TierKey, level: number, side: Unit["side"], roster: Roster | undefined, name: string): number {
  if (side !== "player") return 0;
  const cap = tierUses(classId, tier, level);
  const spent = roster?.spellSpent?.[name]?.[key] ?? 0;
  return Math.max(0, cap - spent);
}

function spawnUnit(spawn: Mission["playerSpawns"][number], side: Unit["side"], i: number, roster?: Roster, enemyLevel = 1): Unit {
  const classId = (side === "player" ? roster?.promotions?.[spawn.name] : undefined) ?? spawn.classId;
  const cls = CLASSES[classId];
  const level = side === "enemy" ? (roster?.enemyLevels?.[spawn.name] ?? enemyLevel) : (roster?.levels[spawn.name] ?? 1);
  const st = statsFor(classId, level);
  const hpCap = roster?.hp[spawn.name];
  const hp = hpCap != null && hpCap > 0 ? Math.min(st.hp, hpCap) : st.hp;
  const weapon = side === "player" ? (roster?.weapons?.[spawn.name] ?? { id: starterWeaponFor(classId), enh: 0 }) : null;
  // Range is a weapon property (D&D-weapon-style), not a class stat — falls back to the
  // class baseline only when there's no equipped weapon to read it from (e.g. enemies).
  const weaponDef = weapon?.id ? WEAPONS[weapon.id] : null;
  const minRange = weaponDef?.minRange ?? st.minRange;
  const maxRange = weaponDef?.maxRange ?? st.maxRange;
  // A two-handed main-hand weapon leaves no free hand for an off-hand item, regardless of
  // what's saved in equipment — enforced here too, not just at the equip screen.
  const offHandId = side === "player" && !weaponDef?.twoHanded ? (roster?.offHand?.[spawn.name] ?? null) : null;
  const gear: Partial<Record<EquipSlot, string>> = side === "player" ? { ...(roster?.equipment?.[spawn.name] ?? {}) } : {};
  // Worn gear contributes to combat stats. Only DEF is read today; gearStatBonus computes
  // the whole set, so turning another stat on is a change here and in reapplyGear below.
  const gearBonus = gearStatBonus(Object.values(gear));
  return {
    id: `${side}-${spawn.name}-${i}`,
    name: spawn.name,
    classId: cls.id,
    className: cls.name,
    role: cls.role,
    side,
    sprite: cls.sprite,
    x: spawn.x,
    y: spawn.y,
    hp,
    maxHp: st.hp,
    atk: st.atk,
    mag: st.mag,
    def: st.def + gearBonus.def,
    res: st.res,
    mov: st.mov,
    gear,
    minRange,
    maxRange,
    moved: false,
    acted: false,
    facing: side === "player" ? 1 : -1,
    walkPose: "front",
    alive: true,
    drawX: spawn.x,
    drawY: spawn.y,
    flash: 0,
    levelGlow: 0,
    healGlow: 0,
    fade: 1,
    bob: 0,
    level,
    xp: side === "player" ? (roster?.xp?.[spawn.name] ?? 0) : 0,
    bag: side === "player" ? { ...(roster?.bags?.[spawn.name] ?? (cls.id === "healer" ? EMPTY_BAG : STARTING_BAG)) } : { ...EMPTY_BAG },
    spells: {
      // Cultist and Birolho are enemy-only, so this never competes with a player roster's own
      // tier1/tier2/tier4 uses — see cultistSpellUses/brigandSpellUses/birolhoSpellUses and
      // runAiFor's cultist/brigand/birolho branches.
      tier1:
        cls.id === "cultist"
          ? cultistSpellUses(level).magicMissile
          : cls.id === "brigand"
            ? brigandSpellUses(level).longShot
            : cls.id === "birolho"
              ? birolhoSpellUses(level).magicMissile
              : remainingTier(cls.id, 1, "tier1", level, side, roster, spawn.name),
      tier2:
        cls.id === "cultist"
          ? cultistSpellUses(level).lightning
          : cls.id === "brigand"
            ? brigandSpellUses(level).piercing
            : cls.id === "birolho"
              ? birolhoSpellUses(level).lightning
              : remainingTier(cls.id, 2, "tier2", level, side, roster, spawn.name),
      tier3: remainingTier(cls.id, 3, "tier3", level, side, roster, spawn.name),
      tier4:
        cls.id === "birolho"
          ? birolhoSpellUses(level).causticVenom
          : remainingTier(cls.id, 4, "tier4", level, side, roster, spawn.name),
      tier5: remainingTier(cls.id, 5, "tier5", level, side, roster, spawn.name),
      tier6: remainingTier(cls.id, 6, "tier6", level, side, roster, spawn.name),
      tier7: remainingTier(cls.id, 7, "tier7", level, side, roster, spawn.name),
      tier8: remainingTier(cls.id, 8, "tier8", level, side, roster, spawn.name),
      tier9: remainingTier(cls.id, 9, "tier9", level, side, roster, spawn.name),
      tier10: remainingTier(cls.id, 10, "tier10", level, side, roster, spawn.name),
    },
    weaponId: weapon?.id ?? null,
    weaponEnh: weapon?.enh ?? 0,
    size: cls.size,
    footprintW: cls.footprintW,
    footprintH: cls.footprintH,
    footprintOffsets: cls.footprintOffsets,
    shock: null,
    diseased: false,
    diseaseBase: null,
    poisoned: false,
    stunned: false,
    stunTurns: 0,
    crippled: false,
    offHandId,
    // Summon-ness is a property of the class, not of how the unit got here: one placed
    // straight onto a map in the editor is outside the party's defeat check just like one
    // the Conjurer calls up mid-battle.
    summoned: isSummonClass(cls.id),
    asleep: false,
    sleepTurns: 0,
    guaranteedDrop: side === "enemy" && !!spawn.guaranteedDrop,
    moveBudgetUsed: 0,
  };
}

/** Whether a unit gets its own turn. Neutrals hold their ground: they are placed, they can
 * be attacked, and they do nothing until something wakes them (see BattleEngine.provoke). */
function takesTurns(u: Unit): boolean {
  return u.alive && u.side !== "neutral";
}

/** Whether the player may swing at this unit. Enemies always; wild neutrals too — that is
 * how a beast gets provoked in the first place. */
function attackableByPlayer(u: Unit): boolean {
  return u.alive && (u.side === "enemy" || u.side === "neutral");
}

function easeOut(t: number): number {
  return 1 - (1 - t) * (1 - t);
}

export class BattleEngine {
  readonly mission: Mission;
  readonly tiles: TerrainId[];
  /** Art variant index per tile, same indexing as tiles. Undefined/missing = variant 0. */
  readonly tileVariants: number[];
  /** How far each tile's art is turned, in sixths of a circle. */
  readonly tileRots: number[];
  readonly decorations: DecorationPlacement[];
  readonly cols: number;
  readonly rows: number;
  units: Unit[] = [];
  art: GameArt;
  phase: Phase = "player";
  mode: InputMode = "locked";
  turn = 1;
  selectedId: string | null = null;
  inspectedId: string | null = null;
  pendingFoeId: string | null = null;
  threat: Point[] = [];
  cursor: Point = { x: 0, y: 0 };
  reach: Map<string, ReachCell> = new Map();
  attackFrom: Map<string, Point> = new Map();
  /** Active Web of Dreams patches (Conjurer tier 2) — cast, not terrain, so they live here
   * rather than on the map. Ticks down by one every startNewRound and is dropped at 0. */
  webZones: { cells: Set<string>; roundsLeft: number }[] = [];
  /** Active Aura of Protection / Intimidating Presence zones (Paladin/Heavy Knight tier 5) —
   * same fixed-cells-at-cast-time, ticks-down-every-round shape as webZones. "protection"
   * cuts damage taken by units on the caster's own side standing in the zone; "intimidation"
   * raises damage taken by units on the OTHER side — see zoneDamageMul. */
  auraZones: { cells: Set<string>; roundsLeft: number; kind: "protection" | "intimidation"; side: Unit["side"]; pct: number }[] = [];
  /** Whether the unit whose turn is currently active was standing in a web zone at the
   * START of that turn — decided once in beginUnitTurn and left alone for the rest of it
   * (see effectiveUnitForReach). */
  private turnRestrained = false;
  /** Where the active unit stood when its turn began, and whether anything irreversible has
   * happened since — see undoMove. Cleared with the turn. */
  private turnStart: Point | null = null;
  private moveSpoiled = false;
  /** All alive units for this round, sorted by CLASSES[classId].init (lower first, ties favor the player). */
  private turnOrder: string[] = [];
  /** id of the unit whose turn we've already dispatched — lets the tick loop react only on change. */
  private activeUnitId: string | null = null;
  orig: Point | null = null;
  /** Movement already spent at the last cancel-safe point (turn start or completed action). */
  private origMoveBudgetUsed: number | null = null;
  hover: Point | null = null;
  private lastClickAt = 0;
  private lastClickCell: Point | null = null;
  result: "victory" | "defeat" | null = null;
  /** True once every enemy the win condition cares about is dead — the battle CAN end, but
   * doesn't until the player confirms (see confirmFinish). Lets them keep playing to loot
   * remaining chests, and flips back to false on its own if a trap/trigger spawns a fresh
   * enemy after the field first looked clear. */
  winAvailable = false;
  banner: string | null = null;
  /** Ember found in chests opened mid-battle; folded into the save's Ember total on victory. */
  lootEmber = 0;
  /** Weapon ids found in chests or off an enemy kill mid-battle; folded into the save's
   * weapon stash on victory. */
  /** Targets picked so far for a multi-missile Magic Missile, one per missile. Cleared
   * whenever aiming ends, so an abandoned cast never leaks into the next one. */
  private missileTargets: { id: string; cell: Point }[] = [];
  lootWeapons: string[] = [];
  /** EquipmentDef ids found in chests mid-battle; folded into the save's shared gear stash
   * on victory (save.looseEquipment) — never auto-equipped onto whoever opened the chest,
   * the player assigns it to a hero afterward from the Paperdoll picker. */
  lootEquipment: string[] = [];
  /** Every weapon id the player already owns, plus anything granted mid-battle the moment
   * it's granted — checked before every loot roll so a chest or kill drop never announces
   * a weapon the player already has (it used to: the roll didn't know about ownership at
   * all, so a "found" weapon could silently vanish once persistVictory deduped it against
   * the save, with nothing to show for the mid-battle "you found X" message). */
  private ownedWeapons: Set<string>;
  /** Rolling combat log — attacks, spells, heals, kills, and loot, newest last. Capped so
   * a long battle doesn't grow it without bound; read via getHud() for the in-battle log
   * view. */
  log: string[] = [];
  /** See HudSnapshot.chestLoot — set the instant a chest opens, cleared only by
   * acknowledgeChestLoot() (the player's "Ok" on the popup), not by anything time-based. */
  private chestLoot: { unitName: string; ember: number; items: { name: string; icon: string }[] } | null = null;
  tip: string | null;
  private lastTipSeen: string | null = null;
  private tipSetAt = 0;
  time = 0;
  trauma = 0;
  hitstop = 0;
  zoom = 1;
  /** How long a unit takes to glide across one hex — "normal" is the default, readable
   * pace; "fast" is the old, snappier speed for players who prefer it. Toggled from the
   * pause menu, applies to the very next step (mid-step changes aren't jarring since a
   * step is at most a quarter second). */
  speedMode: "normal" | "fast" = "normal";
  camX = 0;
  camY = 0;
  private viewW = 1;
  private viewH = 1;
  private camReady = false;
  private queue: Seq[] = [];
  private active: Active | null = null;
  private particles: Particle[] = Array.from({ length: PARTICLE_CAP }, blankParticle);
  private particleLive = 0;
  private levelUpFx: LevelUpSpark[] = Array.from({ length: LEVEL_UP_FX_CAP }, blankLevelUpSpark);
  private levelUpFxLive = 0;
  private missileFx: MissileFx[] = Array.from({ length: MISSILE_FX_CAP }, blankMissileFx);
  private missileFxLive = 0;
  private fireballBurstFx: FireballBurstFx[] = Array.from({ length: FIREBALL_BURST_CAP }, blankFireballBurstFx);
  private fireballBurstFxLive = 0;
  private lightningFx: LightningFx[] = Array.from({ length: LIGHTNING_FX_CAP }, blankLightningFx);
  private lightningFxLive = 0;
  private onNextIdle: (() => void) | null = null;
  private rng: () => number;
  private listeners = new Set<() => void>();
  private reducedMotion = false;
  private layout: Layout = { ox: 0, oy: 0, tile: 48, cols: 8, rows: 7 };
  private spellArmed = false;
  private spellAim: Point | null = null;
  private spellKind: SpellKind | null = null;
  /** Set while mode === "awaitPotion": which potion the selected unit is about to use on
   * whichever valid target (self or an adjacent ally — see confirmPotionAt) is tapped next. */
  private potionAim: PotionId | null = null;

  constructor(mission: Mission, art: GameArt, roster: Roster, seed = 1) {
    this.mission = mission;
    this.art = art;
    this.ownedWeapons = new Set(roster.ownedWeaponIds ?? []);
    this.cols = mission.cols;
    this.rows = mission.rows;
    this.tiles = parseLayout(mission.layout);
    this.tileVariants = mission.tileVariants ?? [];
    this.tileRots = mission.tileRots ?? [];
    this.decorations = mission.decorations ?? [];
    // Art is loaded once at boot — a decoration added later (or after HMR) is in
    // DECORATIONS and in the editor <img>, but missing from art.decorations, so combat
    // used to skip it. Fill any hole so Testar paints the same props the editor lists.
    for (const p of this.decorations) {
      if (this.art.decorations[p.id]?.naturalWidth) continue;
      const img = new Image();
      img.src = decorationImage(p.id);
      this.art.decorations[p.id] = img;
    }
    // Legacy house props previously stamped highruin beneath themselves. Houses are now purely
    // transparent isometric art, so clear only that old auto-stamped terrain on their footprint.
    const houseFloor: TerrainId = this.tiles.includes("nave") ? "nave" : "plains";
    for (const p of this.decorations) {
      if (!HOUSE_DECORATION_IDS.has(p.id)) continue;
      for (const { dx, dy } of placedFootprint(p)) {
        const x = p.x + dx;
        const y = p.y + dy;
        const index = y * this.cols + x;
        if (x >= 0 && x < this.cols && y >= 0 && y < this.rows && this.tiles[index] === "highruin") this.tiles[index] = houseFloor;
      }
    }
    // A decoration that names a tile (barricade, rocks) stamps that terrain so the
    // picture and the rules cannot disagree. A prop with no tile — chest, tree, fallen log —
    // sits on whatever hex was already painted. The old fallback to "column" is what made
    // trunks show up as marble pillars in playtest.
    for (const p of this.decorations) {
      const def = DECORATIONS[p.id];
      if (!def?.tile) continue;
      for (const { dx, dy } of placedFootprint(p)) {
        const x = p.x + dx;
        const y = p.y + dy;
        if (x >= 0 && x < this.cols && y >= 0 && y < this.rows) this.tiles[y * this.cols + x] = def.tile;
      }
    }
    this.decorations.push(...barricadeDecor(this.tiles, this.cols, this.rows, this.decorations));
    this.rng = mulberry32(seed + mission.index * 97);
    this.units = [
      ...mission.playerSpawns.map((s, i) => spawnUnit(s, "player", i, roster)),
      ...mission.enemySpawns.map((s, i) => spawnUnit(s, "enemy", i, roster, enemyLevelFor(mission.index))),
      ...(mission.neutralSpawns ?? []).map((s, i) => spawnUnit(s, "neutral", i, roster, enemyLevelFor(mission.index))),
    ];
    for (const u of this.units) {
      this.nudgeOffHazard(u);
      u.bob = this.rng() * 16;
    }
    this.turnOrder = this.sortByInitiative(this.units.filter(takesTurns));
    const first = this.units.find((u) => u.side === "player");
    if (first) this.cursor = { x: first.x, y: first.y };
    this.tip =
      mission.index === 0
        ? "Toque numa aliada para mover. Toque num inimigo para ver HP e alcance."
        : mission.win === "boss"
          ? "Objetivo: o capitão. Toque nele para ver a área de perigo."
          : "Toque num inimigo para ver HP, alcance e onde ele pode atacar.";
    if (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      this.reducedMotion = true;
    }
  }

  /** Sorts by CLASSES[classId].init ascending; equal init favors the player side. */
  private sortByInitiative(units: Unit[]): string[] {
    return [...units]
      .sort((a, b) => {
        const ia = CLASSES[a.classId].init ?? 999;
        const ib = CLASSES[b.classId].init ?? 999;
        if (ia !== ib) return ia - ib;
        if (a.side !== b.side) return a.side === "player" ? -1 : 1;
        return 0;
      })
      .map((u) => u.id);
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  /** How many targets an aimed spell still wants, for a spell that picks more than one.
   *
   * Magic Missile fires 2 missiles at level 3 and 3 at level 6, each aimed separately, and
   * the only thing that ever said so was the tip line at the bottom of the screen — small,
   * grey, and easy to walk straight past while wondering why the spell hasn't gone off. The
   * HUD puts this where it has to be read. Null for a single-target cast, which needs no
   * counting. */
  private targetPrompt(): { name: string; need: number; picked: number } | null {
    if (this.spellKind !== "magicMissile") return null;
    const u = this.units.find((x) => x.id === this.selectedId);
    if (!u) return null;
    const need = magicMissileCount(u.level);
    return need > 1 ? { name: MAGIC_MISSILE.name, need, picked: this.missileTargets.length } : null;
  }

  getHud(): HudSnapshot {
    const selected = this.units.find((u) => u.id === this.selectedId) ?? null;
    const hoverCell = this.hover ?? this.cursor;
    const hoverUnit = hoverCell
      ? this.units.find((u) => u.alive && occupies(u, hoverCell.x, hoverCell.y))
      : undefined;
    const terr = hoverCell ? TERRAIN[tileAt(this.tiles, this.cols, hoverCell.x, hoverCell.y)] : null;
    const inspected = this.units.find((u) => u.id === this.inspectedId) ?? null;
    const pendingFoe = this.units.find((u) => u.id === this.pendingFoeId) ?? null;
    const foeForForecast = pendingFoe ?? (inspected && attackableByPlayer(inspected) ? inspected : null);
    let forecast: Forecast | null = null;
    if (selected && foeForForecast && selected.side === "player") {
      const from = this.attackFrom.get(foeForForecast.id);
      const fx = from?.x ?? selected.x;
      const fy = from?.y ?? selected.y;
      const fake = { ...selected, x: fx, y: fy };
      forecast = makeForecast(
        fake,
        foeForForecast,
        tileAt(this.tiles, this.cols, fx, fy),
        tileAt(this.tiles, this.cols, foeForForecast.x, foeForForecast.y),
        this.tiles,
        this.cols,
      );
    }
    const canAttack =
      !!selected &&
      !selected.acted &&
      (this.attackFrom.size > 0 ||
        this.units.some((u) => u.alive && u.side !== selected.side && canHitFrom(selected, selected, u, this.tiles, this.cols)));
    const canLockpick = !!selected && !selected.acted && selected.bag.lockpick > 0 && !!this.adjacentLock(selected);
    const offHandKind: "weapon" | "shield" | null =
      selected && !selected.acted && selected.offHandId ? (EQUIPMENT[selected.offHandId]?.kind ?? null) : null;
    return {
      phase: this.phase,
      banner: this.banner,
      selected: selected ? pub(selected, this.isWebCell(selected.x, selected.y), this.movLeft(selected)) : null,
      hoveredUnit: hoverUnit ? pub(hoverUnit, this.isWebCell(hoverUnit.x, hoverUnit.y), this.movLeft(hoverUnit)) : null,
      terrain: terr
        ? {
            id: terr.id,
            name: terr.name,
            moveCost: terr.moveCost,
            def: terr.def,
            atk: terr.atk,
            passable: terr.passable,
            blocksShot: !!terr.blocksShot,
            hazard: terr.hazardDice ? `${terr.hazardDice}d${terr.hazardFaces ?? 8}` : undefined,
            note: terrainNote(terr.id),
          }
        : null,
      mode: this.mode,
      canAttack,
      offHandKind,
      canLockpick,
      forecast,
      turn: this.turn,
      objective: this.mission.objective,
      missionTitle: this.mission.title,
      playerAlive: this.units.filter((u) => u.side === "player" && u.alive && !u.summoned).length,
      enemyAlive: this.units.filter((u) => u.side === "enemy" && u.alive).length,
      busy: this.mode === "locked" || !!this.active || this.queue.length > 0,
      result: this.result,
      winAvailable: this.winAvailable,
      canUndoMove: this.canUndoMove(),
      targetPrompt: this.targetPrompt(),
      zoom: this.zoom,
      speedMode: this.speedMode,
      tip: this.tip,
      inspected: inspected
        ? pub(inspected, this.isWebCell(inspected.x, inspected.y), this.movLeft(inspected))
        : pendingFoe
          ? pub(pendingFoe, this.isWebCell(pendingFoe.x, pendingFoe.y), this.movLeft(pendingFoe))
          : null,
      pendingFoe: pendingFoe ? pub(pendingFoe, this.isWebCell(pendingFoe.x, pendingFoe.y), this.movLeft(pendingFoe)) : null,
      spellReady:
        this.mode === "awaitSpell" &&
        !!selected &&
        !!this.hover &&
        this.spellAimValid(selected, this.hover),
      spellKind: this.mode === "awaitSpell" ? this.spellKind : null,
      turnQueue: (() => {
        const active = this.activeTurnUnit();
        return this.turnOrder
          .map((id) => this.units.find((u) => u.id === id))
          .filter((u): u is Unit => !!u && u.alive)
          .map((u) => ({ id: u.id, name: u.name, side: u.side, acted: u.moved, active: u.id === active?.id }));
      })(),
      log: this.log,
      chestLoot: this.chestLoot,
    };
  }

  /** The player's "Ok" on the chest loot popup — see HudSnapshot.chestLoot. */
  acknowledgeChestLoot(): void {
    this.chestLoot = null;
  }

  battlePlayerHp(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const u of this.units) {
      if (u.side !== "player") continue;
      out[u.name] = u.alive ? u.hp : 0;
    }
    return out;
  }

  remainingPlayerHp(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const u of this.units) {
      if (u.side !== "player") continue;
      if (!u.alive) out[u.name] = Math.max(1, Math.ceil(u.maxHp * 0.5));
      else out[u.name] = Math.min(u.maxHp, u.hp + Math.ceil((u.maxHp - u.hp) * 0.5));
    }
    return out;
  }

  remainingBags(): Record<string, Bag> {
    const out: Record<string, Bag> = {};
    for (const u of this.units) {
      if (u.side !== "player") continue;
      out[u.name] = { ...u.bag };
    }
    return out;
  }

  /** Hands a found potion to `starter` (the one who opened the chest), or — if their bag for
   * that kind is already full — to the next alive party member in line with room. Returns
   * false only if the whole party is capped out on that potion, so the drop is lost. */
  private givePotion(starter: Unit, kind: PotionId): boolean {
    const cap = POTION_CARRY_MAX[kind];
    const order = [starter, ...this.units.filter((x) => x !== starter)];
    for (const target of order) {
      if (target.side !== "player" || !target.alive) continue;
      const have = target.bag[kind] ?? 0;
      if (have < cap) {
        target.bag[kind] = have + 1;
        return true;
      }
    }
    return false;
  }

  /** Hero name → tier key → spell uses spent so far this scenario, for persisting into
   * save.spellUses (see Roster.spellSpent) — recomputed as the current class/level cap
   * minus whatever's left, so a level-up mid-battle naturally reflects the bigger cap
   * instead of needing its own bookkeeping. */
  spentTiers(): Record<string, Partial<Record<TierKey, number>>> {
    const out: Record<string, Partial<Record<TierKey, number>>> = {};
    for (const u of this.units) {
      if (u.side !== "player") continue;
      const perTier: Partial<Record<TierKey, number>> = {};
      for (let t = 1; t <= 10; t++) {
        const key = tierKey(t as SpellTier);
        const cap = tierUses(u.classId, t as SpellTier, u.level);
        perTier[key] = Math.max(0, cap - u.spells[key]);
      }
      out[u.name] = perTier;
    }
    return out;
  }

  tick(dt: number): void {
    const cap = Math.min(0.05, dt);
    this.time += cap;
    if (this.tip !== this.lastTipSeen) {
      this.lastTipSeen = this.tip;
      this.tipSetAt = this.time;
    } else if (this.tip !== null && this.time - this.tipSetAt >= 5) {
      this.tip = null;
      this.lastTipSeen = null;
    }
    if (this.onNextIdle && !this.active && this.queue.length === 0) {
      const fn = this.onNextIdle;
      this.onNextIdle = null;
      fn();
    }
    if (this.trauma > 0) this.trauma = Math.max(0, this.trauma - cap * 2.2);
    for (const u of this.units) {
      if (u.flash > 0) u.flash = Math.max(0, u.flash - cap * 4);
      if (u.levelGlow > 0) u.levelGlow = Math.max(0, u.levelGlow - cap * 0.42);
      if (u.healGlow > 0) u.healGlow = Math.max(0, u.healGlow - cap * 0.7);
      if (!u.alive && u.fade > 0) u.fade = Math.max(0, u.fade - cap * 2.4);
      if (u.alive) {
        const haste =
          u.classId === "wardog" ? 1.4 : u.size >= 4 ? 0.58 : u.classId === "mage" || u.classId === "cultist" ? 0.8 : 1;
        u.bob += cap * haste;
      }
    }
    if (this.particleLive) {
      let live = 0;
      for (const p of this.particles) {
        if (!p.live) continue;
        p.life += cap;
        if (p.life >= p.max) {
          p.live = false;
          continue;
        }
        p.x += p.vx * cap;
        p.y += p.vy * cap;
        if (p.kind === "impact") p.frame += cap * 12;
        live += 1;
      }
      this.particleLive = live;
    }
    if (this.levelUpFxLive) {
      let live = 0;
      for (const s of this.levelUpFx) {
        if (!s.live) continue;
        s.life += cap;
        if (s.life >= s.max) {
          s.live = false;
          continue;
        }
        s.dx += s.vx * cap;
        s.dy += s.vy * cap;
        s.vy += s.refCell * 0.9 * cap;
        s.rot += s.vrot * cap;
        live += 1;
      }
      this.levelUpFxLive = live;
    }
    if (this.missileFxLive) {
      let live = 0;
      for (const m of this.missileFx) {
        if (!m.live) continue;
        m.t += cap;
        if (m.t >= m.max) {
          m.live = false;
          continue;
        }
        live += 1;
      }
      this.missileFxLive = live;
    }
    if (this.fireballBurstFxLive) {
      let live = 0;
      for (const burst of this.fireballBurstFx) {
        if (!burst.live) continue;
        burst.t += cap;
        if (burst.t >= burst.max) { burst.live = false; continue; }
        live += 1;
      }
      this.fireballBurstFxLive = live;
    }
    if (this.lightningFxLive) {
      let live = 0;
      for (const l of this.lightningFx) {
        if (!l.live) continue;
        l.t += cap;
        if (l.t >= l.max) {
          l.live = false;
          continue;
        }
        live += 1;
      }
      this.lightningFxLive = live;
    }
    if (this.hitstop > 0) {
      this.hitstop -= cap;
      this.emit();
      return;
    }
    if (!this.active && this.queue.length) this.startSeq(this.queue.shift()!);
    if (this.active) this.stepActive(cap);
    if (!this.result && !this.active && this.queue.length === 0) {
      const active = this.activeTurnUnit();
      const activeId = active?.id ?? null;
      if (activeId !== this.activeUnitId) {
        this.activeUnitId = activeId;
        if (active) this.beginUnitTurn(active);
        else this.startNewRound();
      }
    }
    this.emit();
  }

  private startSeq(step: Seq): void {
    if (step.type === "move") {
      this.active = { type: "move", id: step.id, path: step.path, i: 0, t: 0 };
      sfxPlay.move();
    } else if (step.type === "combat") {
      const target = this.units.find((u) => u.id === step.def);
      if (!target || !target.alive) return;
      this.active = {
        type: "combat",
        att: step.att,
        def: step.def,
        stage: "lunge",
        t: 0,
        swapped: false,
        bonusDice: step.bonusDice ?? 0,
        bonusDiceCount: step.bonusDiceCount ?? 1,
        bonusFlat: step.bonusFlat ?? 0,
        noCounter: step.noCounter ?? false,
        spellKind: step.spellKind ?? null,
        customDice: step.customDice ?? null,
        dmgMul: step.dmgMul ?? 1,
        stunChance: step.stunChance ?? 0,
      };
    } else if (step.type === "spell") {
      this.active = {
        type: "spell",
        att: step.att,
        tiles: step.tiles,
        ids: step.ids,
        t: 0,
        hit: false,
        extraDice: step.dice ?? 0,
        extraFaces: step.faces ?? 8,
        extraBonus: step.bonus ?? 0,
        moreDice: step.moreDice ?? 0,
        moreFaces: step.moreFaces ?? 6,
        echo: step.echo ?? null,
        dmgMul: step.dmgMul ?? 1,
        weaponBonusDice: step.weaponBonusDice ?? 0,
        weaponBonusFaces: step.weaponBonusFaces ?? 8,
        weaponBonusBonus: step.weaponBonusBonus ?? 0,
        spellKind: step.spellKind ?? null,
        centerId: step.centerId ?? null,
        centerDice: step.centerDice ?? 0,
        centerFaces: step.centerFaces ?? 8,
        centerBonus: step.centerBonus ?? 0,
        poison: step.poison ?? false,
        spellMul: step.spellMul ?? 1,
        centerMul: step.centerMul ?? step.spellMul ?? 1,
      };
      this.banner = step.label ?? "";
      sfxPlay.crit();
      if (step.spellKind === "magicMissile") {
        const caster = this.units.find((u) => u.id === step.att);
        if (caster) for (const t of step.tiles) this.emitMissileFx(caster.x, caster.y, t.x, t.y, "magicMissile");
      }
      if (step.spellKind === "fireball" || step.spellKind === "causticVenom") {
        const caster = this.units.find((u) => u.id === step.att);
        const target = step.projectileTo ?? null;
        if (caster && target) this.emitMissileFx(caster.x, caster.y, target.x, target.y, step.spellKind);
      }
      if (step.spellKind === "longShot") {
        const caster = this.units.find((u) => u.id === step.att);
        const target = step.tiles[0];
        if (caster && target) this.emitMissileFx(caster.x, caster.y, target.x, target.y, "longShot");
      }
      if (step.spellKind === "multiShot") {
        const caster = this.units.find((u) => u.id === step.att);
        if (caster) for (const target of step.tiles) this.emitMissileFx(caster.x, caster.y, target.x, target.y, "longShot");
      }
      if (step.spellKind === "piercing") {
        const caster = this.units.find((u) => u.id === step.att);
        const target = step.tiles[step.tiles.length - 1];
        if (caster && target) this.emitMissileFx(caster.x, caster.y, target.x, target.y, "longShot");
      }
      if (step.spellKind === "lightning") {
        for (const t of step.tiles) this.emitLightningFx(t.x, t.y);
      }
    } else if (step.type === "heal") {
      this.active = { type: "heal", att: step.att, def: step.def, kind: step.kind, t: 0, applied: false };
      this.banner = CURES[step.kind].name;
      sfxPlay.ui();
    } else if (step.type === "cureDisease") {
      this.active = { type: "cureDisease", att: step.att, def: step.def, t: 0, applied: false };
      this.banner = CURE_DISEASE.name;
      sfxPlay.ui();
    } else if (step.type === "banner") {
      this.banner = step.text;
      this.active = { type: "banner", text: step.text, t: 0, dur: step.dur };
      sfxPlay.turn();
    } else if (step.type === "delay") {
      this.active = { type: "delay", t: 0, dur: step.dur };
    } else if (step.type === "checkEnd") {
      this.evaluateEnd();
    }
  }

  private stepActive(dt: number): void {
    const a = this.active;
    if (!a) return;
    if (a.type === "delay" || a.type === "banner") {
      a.t += dt;
      if (a.type === "banner" && a.t >= a.dur) this.banner = null;
      if (a.t >= a.dur) {
        this.active = null;
        if (a.type === "banner" && a.text === "Fase do jogador") this.mode = "idle";
      }
      return;
    }
    if (a.type === "move") {
      const unit = this.units.find((u) => u.id === a.id);
      if (!unit || a.path.length < 2) {
        this.active = null;
        return;
      }
      const from = a.path[a.i]!;
      const to = a.path[a.i + 1];
      if (!to) {
        unit.x = from.x;
        unit.y = from.y;
        unit.drawX = from.x;
        unit.drawY = from.y;
        this.active = null;
        return;
      }
      if (to.x !== from.x) unit.facing = to.x > from.x ? 1 : -1;
      unit.walkPose = to.y < from.y ? "back" : to.y > from.y ? "front" : "side";
      a.t += dt;
      const dur = this.speedMode === "fast" ? 0.12 : 0.22;
      const k = easeOut(Math.min(1, a.t / dur));
      unit.drawX = from.x + (to.x - from.x) * k;
      unit.drawY = from.y + (to.y - from.y) * k;
      if (a.t >= dur) {
        a.i += 1;
        a.t = 0;
        unit.x = to.x;
        unit.y = to.y;
        unit.drawX = to.x;
        unit.drawY = to.y;
        this.ensureVisible(unit.x, unit.y);
        // Walking can change the world — a troll shoulders a barricade down, a hazard tile
        // bites. Either one makes the move unrewindable: undoMove can put a unit back, it
        // cannot un-break a wall or un-take damage. Note it and the undo bows out.
        const hpBefore = unit.hp;
        const propsBefore = this.decorations.length;
        this.smashBarricades(unit);
        this.applyTileHazard(unit, to);
        if (unit.hp !== hpBefore || this.decorations.length !== propsBefore) this.moveSpoiled = true;
        if (!unit.alive) {
          this.active = null;
          this.selectedId = null;
          this.pendingFoeId = null;
          this.evaluateEnd();
          if (!this.result && this.phase === "player") this.mode = "idle";
        }
      }
      return;
    }
    if (a.type === "combat") this.stepCombat(a, dt);
    if (a.type === "spell") this.stepSpell(a, dt);
    if (a.type === "heal") this.stepHeal(a, dt);
    if (a.type === "cureDisease") this.stepCureDisease(a, dt);
  }

  private stepCombat(a: CombatAnim, dt: number): void {
    const att = this.units.find((u) => u.id === a.att);
    const def = this.units.find((u) => u.id === a.def);
    if (!att || !def) {
      this.active = null;
      return;
    }
    a.t += dt;
    const lunge = 0.2;
    if (a.stage === "lunge" || a.stage === "counterLunge") {
      const actor = a.stage === "lunge" ? att : def;
      const target = a.stage === "lunge" ? def : att;
      const k = Math.min(1, a.t / lunge);
      const arrowShot = this.isArrowAttack(actor);
      const arcaneBolt = !arrowShot && this.isArcaneCaster(actor);
      const ranged = arrowShot || arcaneBolt;
      actor.drawX = actor.x + (target.x - actor.x) * (ranged ? 0 : 0.28) * k;
      actor.drawY = actor.y + (target.y - actor.y) * (ranged ? 0 : 0.28) * k;
      if (a.t >= lunge) {
        if (ranged) this.emitMissileFx(actor.x, actor.y, target.x, target.y, arrowShot ? "longShot" : "arcaneBolt");
        a.t = 0;
        a.stage = a.stage === "lunge" ? "hit" : "counterHit";
      }
      return;
    }
    if (a.stage === "hit" || a.stage === "counterHit") {
      const actor = a.stage === "hit" ? att : def;
      const target = a.stage === "hit" ? def : att;
      const arrowShot = this.isArrowAttack(actor);
      const arcaneBolt = !arrowShot && this.isArcaneCaster(actor);
      const impactAt = arrowShot ? ARROW_TRAVEL : arcaneBolt ? MISSILE_TRAVEL : 0.02;
      if (a.t >= impactAt && a.t - dt < impactAt) {
        const attTile = tileAt(this.tiles, this.cols, actor.x, actor.y);
        const defTile = tileAt(this.tiles, this.cols, target.x, target.y);
        // customDice/dmgMul/stunChance are the attacker's own strike (off-hand weapon or
        // Shield Bash) — never applied to the defender's counter, which always uses their
        // real equipped weapon at full strength.
        const hit =
          a.stage === "hit" && a.customDice
            ? rollDamageCustom(actor, target, attTile, defTile, a.customDice.dice, a.customDice.faces, a.customDice.bonus, this.rng)
            : rollDamage(actor, target, attTile, defTile, this.rng);
        if (a.stage === "hit" && a.bonusDice > 0) {
          hit.dmg += rollDice(a.bonusDiceCount, a.bonusDice, a.bonusFlat, this.rng);
        }
        if (a.stage === "hit" && a.dmgMul !== 1) {
          hit.dmg = Math.max(1, Math.floor(hit.dmg * a.dmgMul));
        }
        if (a.stage === "hit" && a.stunChance > 0 && this.rng() < a.stunChance) {
          target.stunned = true;
          target.stunTurns = 1;
          sfxPlay.stun();
        }
        if (target.asleep) {
          hit.dmg = Math.max(1, Math.round(hit.dmg * (1 + WEB_OF_DREAMS.sleepBonusDamage)));
          target.asleep = false;
          target.sleepTurns = 0;
        }
        hit.dmg = Math.max(1, Math.round(hit.dmg * this.zoneDamageMul(target)));
        target.hp = Math.max(0, target.hp - hit.dmg);
        target.flash = 1;
        this.provoke(target, actor);
        // Only the original attacker's own strike earns XP — a successful counter deals
        // damage but grants none, or a unit that gets ganged up on levels for free just by
        // standing there and countering every hit.
        if (target.side !== actor.side && a.stage === "hit") {
          this.gainExp(actor, target.level, hit.dmg, 1);
        }
        this.spawnHit(target, hit.dmg, hit.crit, !this.isArrowAttack(actor) && !this.isArcaneCaster(actor));
        this.pushLog(`${actor.name} atacou ${target.name}: ${hit.dmg} dano${hit.crit ? " (crítico)" : ""}`);
        if (target.hp <= 0) {
          this.markDead(target);
        } else {
          sfxPlay.hit();
          if (a.stage === "hit") this.maybeInflictDisease(actor, target);
          if (a.stage === "hit" && a.spellKind === "trip") {
            target.stunned = true;
            target.stunTurns = TRIP.stunRounds;
            if (!target.crippled) {
              target.crippled = true;
              const keep = 1 - TRIP.statPenalty;
              target.atk = Math.round(target.atk * keep);
              target.mag = Math.round(target.mag * keep);
              target.def = Math.round(target.def * keep);
              target.res = Math.round(target.res * keep);
              target.mov = Math.max(1, Math.round(target.mov * keep));
            }
            sfxPlay.trip();
          }
        }
        if (!this.reducedMotion) this.trauma = Math.min(1, this.trauma + 0.28);
        this.hitstop = 0.06;
      }
      if (a.t >= (this.isArrowAttack(actor) ? ARROW_TRAVEL + 0.18 : this.isArcaneCaster(actor) ? MISSILE_TRAVEL + 0.18 : 0.18)) {
        a.t = 0;
        a.stage = a.stage === "hit" ? "recover" : "counterRecover";
      }
      return;
    }
    if (a.stage === "recover" || a.stage === "counterRecover") {
      const actor = a.stage === "recover" ? att : def;
      const k = Math.min(1, a.t / 0.16);
      actor.drawX = actor.drawX + (actor.x - actor.drawX) * k;
      actor.drawY = actor.drawY + (actor.y - actor.drawY) * k;
      if (a.t >= 0.16) {
        actor.drawX = actor.x;
        actor.drawY = actor.y;
        a.t = 0;
        if (a.stage === "recover") {
          if (!a.noCounter && !def.stunned && def.alive && canCounter(att, def, { x: att.x, y: att.y }, this.tiles, this.cols)) a.stage = "counterLunge";
          else if (!def.alive) a.stage = "fade";
          else this.finishCombat(att);
        } else if (!att.alive) a.stage = "fade";
        else this.finishCombat(att);
      }
      return;
    }
    if (a.stage === "fade") {
      for (const u of this.units) {
        if (!u.alive && u.fade > 0) u.fade = Math.max(0, u.fade - dt * 2.4);
      }
      if (a.t >= 0.4) this.finishCombat(att);
    }
  }

  /** Damage for one spell hit on one target.
   *
   * A spell is a boosted version of the hit the caster could have made instead: same power,
   * same protection, with the caster's own stat weighted by the spell's multiplier and the
   * spell's dice standing in for the weapon. Every multiplier is above 1 and the result is
   * floored at a plain attack, so a cast can never come out worse than simply swinging —
   * which it could before, because spells ignored the caster's stat entirely and a mage's
   * MAG only ever improved their basic attack.
   *
   * The multiplier weights the power term alone. Applied to the whole total it would scale
   * the defender's RES with it, making armoured targets hardest for the spells meant to
   * break them. */
  private spellDamage(att: Unit, foe: Unit, mul: number, roll: number): number {
    const attTile = TERRAIN[tileAt(this.tiles, this.cols, att.x, att.y)];
    const defTile = TERRAIN[tileAt(this.tiles, this.cols, foe.x, foe.y)];
    const prot = protOf(att, foe);
    const spell = Math.floor(powerOf(att) * mul) + roll + attTile.atk - prot - (defTile.cover ?? 0);
    const plain = powerOf(att) + weaponRoll(att.weaponId, att.weaponEnh, this.rng) + attTile.atk - prot - defTile.def;
    return Math.max(1, Math.round(Math.max(spell, plain)));
  }

  private stepSpell(a: SpellAnim, dt: number): void {
    const att = this.units.find((u) => u.id === a.att);
    if (!att) {
      this.active = null;
      return;
    }
    a.t += dt;
    const arrowSpell = a.spellKind === "longShot" || a.spellKind === "multiShot" || a.spellKind === "piercing";
    const hitAt = arrowSpell ? ARROW_TRAVEL : a.spellKind === "magicMissile" || a.spellKind === "fireball" || a.spellKind === "causticVenom" ? MISSILE_HIT_AT : 0.18;
    if (!a.hit && a.t >= hitAt) {
      a.hit = true;
      sfxPlay.spell();
      // AoE/line spells: the first enemy actually hit grants full XP, every enemy after
      // that in the same cast grants half — hitting a whole group shouldn't out-earn
      // picking them off one at a time, but the first one still counts fully.
      let firstAoeEnemyHit = true;
      // Piercing Thrust: front-to-back falloff along the line — the first body it hits eats
      // the full hit, everyone skewered behind them takes half.
      let thrustHitIndex = 0;
      for (const id of a.ids) {
        const foe = this.units.find((u) => u.id === id && u.alive);
        if (!foe) continue;
        const defTile = TERRAIN[tileAt(this.tiles, this.cols, foe.x, foe.y)];
        if (defTile.id === "barricade") {
          this.emitParticle({
            x: foe.drawX,
            y: foe.drawY - 0.35,
            vx: 0,
            vy: -0.18,
            life: 0,
            max: 1.6,
            size: 1,
            color: "#e0b48a",
            text: "bloqueado",
            kind: "text",
            frame: 0,
          });
          continue;
        }
        let dmg: number;
        let crit = false;
        if (a.centerId && foe.id === a.centerId) {
          dmg = this.spellDamage(att, foe, a.centerMul, rollDice(a.centerDice, a.centerFaces, a.centerBonus, this.rng));
        } else if (a.extraDice > 0) {
          let roll = rollDice(a.extraDice, a.extraFaces, a.extraBonus, this.rng);
          if (a.moreDice > 0) roll += rollDice(a.moreDice, a.moreFaces, 0, this.rng);
          dmg = this.spellDamage(att, foe, a.spellMul, roll);
        } else if (a.spellKind === "piercingThrust") {
          // Armor-piercing: the defender's DEF is treated as 20% lower for this hit only.
          const softened = { ...foe, def: Math.max(0, Math.floor(foe.def * (1 - PIERCING_THRUST.armorIgnore))) };
          const hit = rollDamage(
            att,
            softened,
            tileAt(this.tiles, this.cols, att.x, att.y),
            tileAt(this.tiles, this.cols, foe.x, foe.y),
            this.rng,
          );
          dmg = thrustHitIndex === 0 ? hit.dmg : Math.max(1, Math.floor(hit.dmg * 0.5));
          crit = hit.crit;
          thrustHitIndex++;
        } else {
          const hit = rollDamage(
            att,
            foe,
            tileAt(this.tiles, this.cols, att.x, att.y),
            tileAt(this.tiles, this.cols, foe.x, foe.y),
            this.rng,
          );
          dmg = hit.dmg;
          crit = hit.crit;
          if (a.weaponBonusDice > 0) dmg += rollDice(a.weaponBonusDice, a.weaponBonusFaces, a.weaponBonusBonus, this.rng);
        }
        if (a.dmgMul > 1) dmg = Math.max(1, dmg * a.dmgMul);
        if (foe.asleep) {
          dmg = Math.max(1, Math.round(dmg * (1 + WEB_OF_DREAMS.sleepBonusDamage)));
          foe.asleep = false;
          foe.sleepTurns = 0;
        }
        dmg = Math.max(1, Math.round(dmg * this.zoneDamageMul(foe)));
        foe.hp = Math.max(0, foe.hp - dmg);
        foe.flash = 1;
        this.provoke(foe, att);
        if (a.poison) foe.poisoned = true;
        // AoE/line abilities (fireball, cleave, piercing...) run this once per unit actually
        // hit, so every landed hit grants its own XP — piercing can also clip an ally in the
        // line, which must never grant XP.
        if (foe.side !== att.side) {
          // Black Mage / Conjurer finishing an enemy off with one of their own single-target
          // spells (Magic Missile, Lightning) doubles the XP from that kill, same as Long
          // Shot (moved onto this same "spell" step so its weapon+dice bonus can scale by
          // level) — never for AoE/line spells, where only the first enemy hit grants full
          // XP and the rest grant half.
          const isAoeSpell =
            a.spellKind === "fireball" ||
            a.spellKind === "cleave" ||
            a.spellKind === "piercing" ||
            a.spellKind === "causticVenom" ||
            a.spellKind === "piercingThrust" ||
            a.spellKind === "sweep" ||
            a.spellKind === "divineWrath" ||
            a.spellKind === "shoulderSmash" ||
            a.spellKind === "stampede";
          const xpMul =
            foe.hp <= 0 && !isAoeSpell && (att.classId === "mage" || att.classId === "conjurer" || a.spellKind === "longShot")
              ? 2
              : isAoeSpell && !firstAoeEnemyHit
                ? 0.5
                : 1;
          if (isAoeSpell) firstAoeEnemyHit = false;
          this.gainExp(att, foe.level, dmg, xpMul);
        }
        const meleeSkill = a.spellKind === "doubleStrike" || a.spellKind === "cleave" || a.spellKind === "piercingThrust" || a.spellKind === "sweep" || a.spellKind === "trip" || a.spellKind === "shoulderSmash" || a.spellKind === "stampede";
        this.spawnHit(foe, dmg, crit, meleeSkill);
        this.pushLog(`${att.name} atingiu ${foe.name} com magia: ${dmg} dano${crit ? " (crítico)" : ""}`);
        if (foe.hp <= 0) {
          this.markDead(foe);
        } else {
          sfxPlay.hit();
          if (a.echo) foe.shock = { ...a.echo };
          if (a.spellKind === "sweep") this.knockBack(att, foe);
          if (a.spellKind === "shoulderSmash") {
            for (let i = 0; i < SHOULDER_SMASH.knockback; i++) this.knockBack(att, foe);
          }
        }
      }
      if (a.spellKind === "fireball" || a.spellKind === "causticVenom") this.emitFireballBurstFx(a.tiles, a.spellKind);
      if (!this.reducedMotion) this.trauma = Math.min(1, this.trauma + 0.45);

    }
    if (a.t >= 0.55) this.finishCombat(att);
  }

  private stepHeal(a: HealAnim, dt: number): void {
    const att = this.units.find((u) => u.id === a.att);
    const target = this.units.find((u) => u.id === a.def);
    if (!att || !target) {
      this.active = null;
      return;
    }
    a.t += dt;
    if (!a.applied && a.t >= 0.2) {
      a.applied = true;
      const heal = rollCure(a.kind, att.mag, this.rng);
      const gained = Math.min(heal, target.maxHp - target.hp);
      target.hp += gained;
      this.gainExp(att, target.level, gained);
      this.emitParticle({
        x: target.drawX,
        y: target.drawY - 0.35,
        vx: 0,
        vy: -0.18,
        life: 0,
        max: 2,
        size: 1,
        color: "#d8ead2",
        text: `+${gained}`,
        kind: "text",
        frame: 0,
      });
      this.tip = `${CURES[a.kind].name} · +${gained} HP`;
      this.pushLog(`${att.name} curou ${target.name}: +${gained} HP`);
      this.emitBeneficialGlow(target);
      sfxPlay.heal();
    }
    if (a.t >= 0.5) this.finishCombat(att);
  }

  private stepCureDisease(a: CureDiseaseAnim, dt: number): void {
    const att = this.units.find((u) => u.id === a.att);
    const target = this.units.find((u) => u.id === a.def);
    if (!att || !target) {
      this.active = null;
      return;
    }
    a.t += dt;
    if (!a.applied && a.t >= 0.2) {
      a.applied = true;
      this.curePlayerDisease(target);
      this.emitParticle({
        x: target.drawX,
        y: target.drawY - 0.35,
        vx: 0,
        vy: -0.18,
        life: 0,
        max: 2,
        size: 1,
        color: "#d8ead2",
        text: "curado",
        kind: "text",
        frame: 0,
      });
      this.tip = `${CURE_DISEASE.name} · ${target.name} está curado.`;
      sfxPlay.heal();
    }
    if (a.t >= 0.5) this.finishCombat(att);
  }

  /** 20% chance for a wardog's bite to inflict disease on a surviving target. */
  private maybeInflictDisease(actor: Unit, target: Unit): void {
    if (actor.classId !== "wardog" || !target.alive || target.diseased) return;
    if (this.rng() >= DISEASE.biteChance) return;
    target.diseased = true;
    target.diseaseBase = { atk: target.atk, mag: target.mag, def: target.def, res: target.res, mov: target.mov };
    const pen = (n: number) => Math.round(n * (1 - DISEASE.statPenalty));
    target.atk = pen(target.atk);
    target.mag = pen(target.mag);
    target.def = pen(target.def);
    target.res = pen(target.res);
    target.mov = Math.max(1, pen(target.mov));
    this.tip = `${target.name} não se sente muito bem.`;
  }

  /**
   * Grants XP for an action with a measurable, real effect — damage on a hit, HP restored by
   * a heal or potion — and applies any level-ups on the spot, mid-battle. Multi-target
   * abilities (fireball, cleave, piercing...) call this once per unit actually hit, so every
   * landed hit counts on its own. Side-eligibility (don't gain XP for friendly fire) is the
   * caller's job, since the same helper also grants XP for healing your own side.
   */
  private pushLog(line: string): void {
    this.log.push(line);
    if (this.log.length > 200) this.log.shift();
  }

  /** Single choke point for a unit's death: sfx, the log line, and — for an enemy — the
   * kill-drop roll, so every death path (melee, counter, spell, lightning echo, tile
   * hazard) behaves identically instead of four separate copies of the same logic. */
  private markDead(u: Unit): void {
    u.alive = false;
    sfxPlay.death();
    this.pushLog(`${u.name} foi derrotado.`);
    if (u.side === "enemy" && u.guaranteedDrop) {
      // Named unique bosses (Spawn.guaranteedDrop) skip the roll entirely and always drop
      // something — from the same weapon-or-gear pool a chest rolls from, not the plain
      // weapon-only kill-drop pool below.
      const drop = weightedLootPick(this.rng, missionGearLevel(this.mission.index), this.ownedWeapons);
      if (drop.kind === "weapon") {
        if (this.ownedWeapons.has(drop.id)) {
          this.lootEmber += 15;
        } else {
          this.ownedWeapons.add(drop.id);
          this.lootWeapons.push(drop.id);
          this.pushLog(`Loot: ${WEAPONS[drop.id]?.name ?? drop.id}`);
        }
      } else {
        this.lootEquipment.push(drop.id);
        this.pushLog(`Loot: ${EQUIPMENT[drop.id]?.name ?? drop.id}`);
      }
    } else if (u.side === "enemy" && this.rng() < KILL_DROP_CHANCE) {
      // 1% per kill, capped to what this mission's own enemies are geared for (see
      // missionGearLevel), and never a weapon already owned — an early mission never hands
      // out the campaign's best gear.
      const id = weightedWeaponPick(this.rng, Object.keys(WEAPONS), missionGearLevel(this.mission.index));
      if (this.ownedWeapons.has(id)) {
        this.lootEmber += 15;
      } else {
        this.ownedWeapons.add(id);
        this.lootWeapons.push(id);
        this.pushLog(`Loot: ${WEAPONS[id]?.name ?? id}`);
      }
    }
  }

  private gainExp(attacker: Unit, targetLevel: number, amount: number, multiplier = 1): void {
    if (amount <= 0 || attacker.side !== "player" || !attacker.alive) return;
    if (attacker.level >= MAX_LEVEL) return;
    const gained = Math.round(expForHit(attacker.level, targetLevel) * multiplier);
    if (gained <= 0) return;
    attacker.xp += gained;
    while (attacker.xp >= EXP_TO_LEVEL && attacker.level < MAX_LEVEL) {
      attacker.xp -= EXP_TO_LEVEL;
      this.levelUpUnit(attacker);
    }
    if (attacker.level >= MAX_LEVEL) attacker.xp = 0;
  }

  /** Bumps a unit by one level: stat growth, the level's HP gain added to current HP (not a full heal), and any newly-unlocked tier uses granted right away. */
  private levelUpUnit(u: Unit): void {
    const from = u.level;
    const to = from + 1;
    const before = statsFor(u.classId, from);
    const after = statsFor(u.classId, to);
    u.level = to;
    u.maxHp = after.hp;
    u.atk = after.atk;
    u.mag = after.mag;
    u.def = after.def;
    u.res = after.res;
    u.hp = Math.min(u.maxHp, u.hp + (after.hp - before.hp));
    for (let t = 1; t <= 10; t++) {
      const tier = t as SpellTier;
      const key = tierKey(tier);
      const gain = tierUses(u.classId, tier, to) - tierUses(u.classId, tier, from);
      if (gain > 0) u.spells[key] += gain;
    }
    this.tip = `${u.name} subiu para o nível ${to}!`;
    this.pushLog(`${u.name} subiu para o nível ${to}!`);
    this.emitLevelUpFx(u, to);
    sfxPlay.levelUp();
  }

  private curePlayerDisease(u: Unit): void {
    u.poisoned = false;
    if (!u.diseaseBase) {
      u.diseased = false;
      return;
    }
    u.atk = u.diseaseBase.atk;
    u.mag = u.diseaseBase.mag;
    u.def = u.diseaseBase.def;
    u.res = u.diseaseBase.res;
    u.mov = u.diseaseBase.mov;
    u.diseaseBase = null;
    u.diseased = false;
  }

  /**
   * Marks a unit as having acted this turn.
   *
   * Movement is a pool of MOV per turn, not a single move that acting cancels: spend two
   * hexes, cast, and the other three are still there to run with. So acting no longer ends
   * the turn just because the unit had already walked — it stays selected with whatever
   * budget is left. The turn ends here only when there is nothing left to do with it (the
   * pool is empty), or for a unit that is dead or on the enemy side, where leaving anything
   * "selected" would expose it to player input.
   *
   * What acting does close off is the refund: undoMove refuses once acted is set, because an
   * action was taken from a position a rewind would erase.
   */
  private finishAction(u: Unit): void {
    u.acted = true;
    this.pendingFoeId = null;
    this.inspectedId = null;
    this.threat = [];
    this.attackFrom.clear();
    const spent = !u.alive || u.side !== "player" || u.mov - u.moveBudgetUsed <= 0;
    if (spent) {
      u.moved = true;
      this.selectedId = null;
      this.reach.clear();
      this.orig = null;
      this.turnStart = null;
      this.mode = this.phase === "player" ? "idle" : "locked";
      return;
    }
    this.selectedId = u.id;
    this.orig = { x: u.x, y: u.y };
    this.origMoveBudgetUsed = u.moveBudgetUsed;
    this.reach = computeReachable(this.effectiveUnitForReach(u), this.tiles, this.cols, this.rows, this.units);
    this.mode = "selected";
  }

  private finishCombat(att: Unit): void {
    att.drawX = att.x;
    att.drawY = att.y;
    this.active = null;
    this.spellKind = null;
    this.missileTargets = [];
    // A spell/heal/cureDisease sets this.banner directly (the cast name, e.g. "Bola de
    // Fogo") when it starts, outside the dedicated "banner" active-step type — which is
    // the only other thing that ever set it, and the only thing that ever cleared it (see
    // stepActive). Every skill routes through this single completion point regardless of
    // which one it was, so clearing it here is the one place that actually covers all of
    // them instead of the banner sitting on screen until something unrelated overwrites it.
    this.banner = null;
    this.evaluateEnd();
    if (this.result) {
      this.selectedId = null;
      this.pendingFoeId = null;
      this.inspectedId = null;
      this.threat = [];
      this.reach.clear();
      this.attackFrom.clear();
      this.orig = null;
      this.mode = "idle";
      return;
    }
    this.finishAction(att);
  }

  private smashBarricades(unit: Unit): void {
    if (unit.classId !== "troll" || !unit.alive) return;
    const fill: TerrainId = this.tiles.includes("nave") ? "nave" : "plains";
    const seen = new Set<string>();
    let n = 0;
    for (const p of footprint(unit)) {
      for (const c of [p, ...hexNeighbors(p.x, p.y)]) {
        if (!inBounds(c.x, c.y, this.cols, this.rows)) continue;
        const k = key(c.x, c.y);
        if (seen.has(k)) continue;
        seen.add(k);
        const i = c.y * this.cols + c.x;
        if (this.tiles[i] !== "barricade") continue;
        this.tiles[i] = fill;
        // The prop goes with the terrain — leaving it would draw a barricade over ground
        // that is now walkable.
        for (let d = this.decorations.length - 1; d >= 0; d--) {
          const dec = this.decorations[d];
          if ((dec.id === "barricade" || dec.id === "barricade-2") && dec.x === c.x && dec.y === c.y) this.decorations.splice(d, 1);
        }
        n += 1;
        this.emitParticle({
          x: c.x,
          y: c.y,
          vx: 0,
          vy: -0.2,
          life: 0,
          max: 0.45,
          size: 1,
          color: "#c4a07a",
          kind: "impact",
          frame: 0,
        });
      }
    }
    if (n) {
      this.tip = "O troll parte a barricada.";
      this.trauma = Math.min(1, this.trauma + 0.35);
      sfxPlay.hit();
    }
  }

  private nudgeOffHazard(unit: Unit): void {
    const here = TERRAIN[tileAt(this.tiles, this.cols, unit.x, unit.y)];
    if (here.passable) return;
    const occ = occupancy(this.units);
    const seen = new Set<string>([key(unit.x, unit.y)]);
    const q: Point[] = [{ x: unit.x, y: unit.y }];
    while (q.length) {
      const cur = q.shift()!;
      for (const n of hexNeighbors(cur.x, cur.y)) {
        if (n.x < 0 || n.y < 0 || n.x >= this.cols || n.y >= this.rows) continue;
        const k = key(n.x, n.y);
        if (seen.has(k)) continue;
        seen.add(k);
        const terr = TERRAIN[tileAt(this.tiles, this.cols, n.x, n.y)];
        const who = occ.get(k);
        if (terr.passable && (!who || who.id === unit.id)) {
          unit.x = n.x;
          unit.y = n.y;
          unit.drawX = n.x;
          unit.drawY = n.y;
          return;
        }
        q.push(n);
      }
    }
  }

  /** Lightning echo + standing-hazard damage, applied once when this unit's own turn begins. */
  private startOfTurnEffects(u: Unit): void {
    if (!u.alive) return;
    if (u.shock) {
      const echo = u.shock;
      u.shock = null;
      const dmg = Math.max(1, rollDice(echo.dice, echo.faces, echo.bonus, this.rng) - u.res);
      u.hp = Math.max(0, u.hp - dmg);
      u.flash = 1;
      this.spawnHit(u, dmg, false);
      this.tip = `Relâmpago · ${diceFormula(echo.dice, echo.faces, echo.bonus)} − RES`;
      this.pushLog(`Eco de relâmpago em ${u.name}: ${dmg} dano`);
      sfxPlay.hit();
      if (u.hp <= 0) {
        this.markDead(u);
      }
    }
    if (u.alive && u.poisoned) {
      const dmg = rollDice(1, 4, 0, this.rng);
      u.hp = Math.max(0, u.hp - dmg);
      u.flash = 1;
      this.spawnHit(u, dmg, false);
      this.tip = `Veneno · 1D4 dano`;
      this.pushLog(`Veneno consome ${u.name}: ${dmg} dano`);
      sfxPlay.hit();
      if (u.hp <= 0) {
        this.markDead(u);
      }
    }
    // Second Wind (Paladin tier 3): passive, never a hotbar cast — the first time this
    // paladin's own turn opens at or below the "badly wounded" line with a tier-3 use still
    // banked, it heals itself and spends the use. classId-gated explicitly, since tierUses
    // hands out tier-3 slots to every class, not just paladin.
    if (u.alive && u.classId === "paladin" && u.hp / u.maxHp <= SECOND_WIND.badlyWoundedPct && this.tierRemaining(u, "secondWind") > 0) {
      this.spendTier(u, "secondWind");
      const heal = Math.min(u.maxHp - u.hp, Math.round(secondWindPct(u.level) * u.res));
      if (heal > 0) {
        u.hp += heal;
        u.flash = 1;
        this.emitParticle({
          x: u.drawX,
          y: u.drawY - 0.35,
          vx: 0,
          vy: -0.18,
          life: 0,
          max: 2,
          size: 1,
          color: "#d8ead2",
          text: `+${heal}`,
          kind: "text",
          frame: 0,
        });
        this.tip = `${SECOND_WIND.name} · +${heal} HP`;
        this.pushLog(`${u.name} usa ${SECOND_WIND.name}: +${heal} HP`);
        sfxPlay.heal();
      }
    }
    if (u.alive) this.applyTileHazard(u, { x: u.x, y: u.y });
    this.evaluateEnd();
  }

  private applyTileHazard(unit: Unit, cell: Point): void {
    const terr = TERRAIN[tileAt(this.tiles, this.cols, cell.x, cell.y)];
    if (!terr.hazardDice || !unit.alive) return;
    const faces = terr.hazardFaces ?? 8;
    let dmg = 0;
    for (let i = 0; i < terr.hazardDice; i++) dmg += 1 + Math.floor(this.rng() * faces);
    unit.hp = Math.max(0, unit.hp - dmg);
    unit.flash = 1;
    this.spawnHit(unit, dmg, false);
    this.pushLog(`${terr.name} feriu ${unit.name}: ${dmg} dano`);
    sfxPlay.hit();
    if (unit.hp <= 0) {
      this.markDead(unit);
      this.onNextIdle = null;
    }
  }

  private emitParticle(init: Omit<Particle, "live">): void {
    if (this.reducedMotion && init.kind === "spark") return;
    let slot: Particle | undefined;
    for (const p of this.particles) {
      if (!p.live) {
        slot = p;
        break;
      }
    }
    if (!slot) {
      slot = this.particles.find((p) => p.kind !== "text") ?? this.particles[0]!;
      let oldest = 0;
      for (const p of this.particles) {
        if (p.kind === "text") continue;
        if (p.life / p.max > oldest) {
          oldest = p.life / p.max;
          slot = p;
        }
      }
    } else this.particleLive += 1;
    slot.live = true;
    slot.x = init.x;
    slot.y = init.y;
    slot.vx = init.vx;
    slot.vy = init.vy;
    slot.life = init.life;
    slot.max = init.max;
    slot.size = init.size;
    slot.color = init.color;
    slot.text = init.text;
    slot.kind = init.kind;
    slot.frame = init.frame;
  }

  /** Golden burst played once when a unit levels up: an expanding ring, a scatter of small
   * stars, and a big glowing "Nível X!" label over the head, all anchored to the unit's hex
   * and drifting in real pixel space (see LevelUpSpark) rather than the grid-snapped Particle
   * system above. Also arms the unit's own sustained levelGlow (see tick/render) so the
   * character itself, not just the burst around it, reads as glowing for a couple seconds. */
  private emitLevelUpFx(u: Unit, level: number): void {
    u.levelGlow = 1;
    if (this.reducedMotion) return;
    const cell = this.layout.tile;
    const claim = (): LevelUpSpark | undefined => {
      let slot = this.levelUpFx.find((s) => !s.live);
      if (slot) {
        this.levelUpFxLive += 1;
        return slot;
      }
      slot = this.levelUpFx[0];
      let oldest = 0;
      for (const s of this.levelUpFx) {
        if (s.life / s.max > oldest) {
          oldest = s.life / s.max;
          slot = s;
        }
      }
      return slot;
    };
    const spawn = (init: Omit<LevelUpSpark, "live">) => {
      const slot = claim();
      if (!slot) return;
      Object.assign(slot, init, { live: true });
    };
    spawn({
      unitId: u.id,
      kind: "ring",
      dx: 0,
      dy: -cell * 0.55,
      vx: 0,
      vy: 0,
      life: 0,
      max: 0.55,
      size: 0,
      hue: 46,
      rot: 0,
      vrot: 0,
      refCell: cell,
    });
    const n = 18;
    for (let i = 0; i < n; i++) {
      const angle = (Math.PI * 2 * i) / n + (this.rng() - 0.5) * 0.4;
      const speed = cell * (0.9 + this.rng() * 1.1);
      spawn({
        unitId: u.id,
        kind: "star",
        dx: 0,
        dy: -cell * 0.55,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed * 0.7 - cell * 0.6,
        life: 0,
        max: 0.85 + this.rng() * 0.5,
        size: cell * (0.05 + this.rng() * 0.05),
        hue: 42 + this.rng() * 20,
        rot: this.rng() * Math.PI,
        vrot: (this.rng() - 0.5) * 6,
        refCell: cell,
      });
    }
    spawn({
      unitId: u.id,
      kind: "label",
      text: `NÍVEL ${level}!`,
      dx: 0,
      dy: -cell * 1.35,
      vx: 0,
      vy: -cell * 0.18,
      life: 0,
      max: 2.2,
      size: cell * 0.4,
      hue: 46,
      rot: 0,
      vrot: 0,
      refCell: cell,
    });
  }

  /** A gentle light for a beneficial effect landing on a unit — a heal spell resolving or a
   * potion being drunk — arming healGlow (see render()) plus a few soft pale motes drifting
   * up off them. Deliberately smaller and quieter than emitLevelUpFx: this fires often
   * (every heal, every potion), so it has to read as a light touch, not a fanfare. */
  private emitBeneficialGlow(u: Unit): void {
    u.healGlow = 1;
    if (this.reducedMotion) return;
    const n = 6;
    for (let i = 0; i < n; i++) {
      const ang = -Math.PI / 2 + (this.rng() - 0.5) * 1.6;
      const speed = 0.5 + this.rng() * 0.6;
      this.emitParticle({
        x: u.drawX + (this.rng() - 0.5) * 0.5,
        y: u.drawY - 0.1,
        vx: Math.cos(ang) * speed * 0.3,
        vy: Math.sin(ang) * speed - 0.3,
        life: 0,
        max: 0.7 + this.rng() * 0.3,
        size: 2 + this.rng() * 2,
        color: "#fff6df",
        kind: "spark",
        frame: 0,
      });
    }
  }

  /** One burning patch per Fireball area cell, all procedural so it conforms to every map. */
  private emitFireballBurstFx(tiles: Point[], kind: "fireball" | "causticVenom"): void {
    if (this.reducedMotion) return;
    for (const cell of tiles) {
      let burst = this.fireballBurstFx.find((x) => !x.live);
      if (!burst) burst = this.fireballBurstFx[0]!;
      else this.fireballBurstFxLive += 1;
      burst.live = true;
      burst.x = cell.x;
      burst.y = cell.y;
      burst.t = 0;
      burst.max = 0.58;
      burst.seed = this.rng() * Math.PI * 2;
    }
  }
  /** True only for bow/crossbow users. Reach weapons strike physically instead of firing arrows. */
  private isArrowAttack(unit: Unit): boolean {
    // Reach weapons are always physical, even if an imported loadout is incorrectly flagged ranged.
    if (unit.classId === "pikeman" || unit.classId === "lancer" || unit.classId === "sentinel" || unit.classId === "templar") return false;
    if (unit.weaponId) return !!WEAPONS[unit.weaponId]?.ranged;
    // Default campaign loadouts: Neera and brigands start as bow/crossbow users before gear is assigned.
    return unit.classId === "archer" || unit.classId === "ranger" || unit.classId === "assassin" || unit.classId === "brigand";
  }

  /** Only spellcasting classes use the distinct basic-attack arcane bolt. */
  private isArcaneCaster(unit: Unit): boolean {
    return unit.classId === "mage" || unit.classId === "elementalist" || unit.classId === "warlock" || unit.classId === "cultist" || unit.classId === "birolho";
  }

  /** One glowing bolt per target, hex-to-hex — see MissileFx. */
  private emitMissileFx(fromX: number, fromY: number, toX: number, toY: number, kind: "magicMissile" | "fireball" | "causticVenom" | "longShot" | "arcaneBolt"): void {
    if (this.reducedMotion) return;
    let slot = this.missileFx.find((m) => !m.live);
    if (!slot) {
      slot = this.missileFx[0]!;
      let oldest = 0;
      for (const m of this.missileFx) {
        if (m.t / m.max > oldest) {
          oldest = m.t / m.max;
          slot = m;
        }
      }
    } else this.missileFxLive += 1;
    slot.live = true;
    slot.fromX = fromX;
    slot.fromY = fromY;
    slot.toX = toX;
    slot.toY = toY;
    slot.t = 0;
    slot.travel = kind === "longShot" ? ARROW_TRAVEL : MISSILE_TRAVEL;
    slot.max = slot.travel + MISSILE_AFTERGLOW;
    slot.hue = kind === "fireball" ? 22 : kind === "causticVenom" ? 104 : kind === "longShot" ? 205 : kind === "arcaneBolt" ? 2 : 268;
    slot.kind = kind;
    slot.seed = this.rng() * Math.PI * 2;
  }

  /** A bolt struck down onto one hex — see LightningFx. The jagged shape (main bolt plus
   * 2-3 forks) is rolled once here so it stays put for the strike's whole short life. */
  private emitLightningFx(x: number, y: number): void {
    if (this.reducedMotion) return;
    let slot = this.lightningFx.find((l) => !l.live);
    if (!slot) {
      slot = this.lightningFx[0]!;
      let oldest = 0;
      for (const l of this.lightningFx) {
        if (l.t / l.max > oldest) {
          oldest = l.t / l.max;
          slot = l;
        }
      }
    } else this.lightningFxLive += 1;
    const rollSegs = (n: number, spread: number) => Array.from({ length: n }, () => (this.rng() - 0.5) * spread);
    slot.live = true;
    slot.x = x;
    slot.y = y;
    slot.t = 0;
    slot.max = LIGHTNING_STRIKE_DUR;
    slot.hue = 200 + this.rng() * 20;
    slot.segs = rollSegs(9, 0.34);
    const branchCount = 2 + Math.floor(this.rng() * 2);
    slot.branches = Array.from({ length: branchCount }, () => ({
      at: 0.3 + this.rng() * 0.45,
      side: this.rng() < 0.5 ? -1 : 1,
      segs: rollSegs(4, 0.4),
    }));
  }

  private spawnHit(target: Unit, dmg: number, crit: boolean, physicalImpact = false): void {
    const cx = target.drawX;
    const cy = target.drawY;
    this.emitParticle({
      x: cx,
      y: cy - 0.35,
      vx: 0,
      vy: -0.18,
      life: 0,
      max: 2,
      size: 1,
      color: crit ? "#f0ebe3" : "#f2d2c6",
      text: crit ? `CRÍTICO  −${dmg}` : `−${dmg}`,
      kind: "text",
      frame: 0,
    });
    this.emitParticle({
      x: cx,
      y: cy - 0.15,
      vx: 0,
      vy: 0,
      life: 0,
      max: 0.32,
      size: 1,
      color: "#fff",
      kind: "impact",
      frame: 0,
    });
    if (this.reducedMotion) return;
    const n = 3;
    for (let i = 0; i < n; i++) {
      const ang = (Math.PI * 2 * i) / n + this.rng();
      this.emitParticle({
        x: cx,
        y: cy,
        vx: Math.cos(ang) * (1.4 + this.rng()),
        vy: Math.sin(ang) * (1.4 + this.rng()) - 0.4,
        life: 0,
        max: 0.28 + this.rng() * 0.12,
        size: 2 + this.rng() * 2,
        color: i % 2 ? "#b54a32" : "#f0ebe3",
        kind: "spark",
        frame: 0,
      });
    }
  }

  /** A player strike on a wild neutral wakes the whole species: every living neutral of the
   * same class turns "enemy" at once. They are not in this round's turn order, so they rouse
   * and start acting from the next round. Nothing turns a woken beast back. */
  private provoke(target: Unit, attacker: Unit): void {
    if (target.side !== "neutral" || attacker.side !== "player") return;
    const pack = this.units.filter((u) => u.alive && u.side === "neutral" && u.classId === target.classId);
    for (const u of pack) u.side = "enemy";
    this.pushLog(
      pack.length > 1
        ? `${target.name} reage — e todo o bando de ${CLASSES[target.classId].name.toLowerCase()} vem junto (${pack.length}).`
        : `${target.name} se volta contra vocês.`,
    );
    this.evaluateEnd();
  }

  private evaluateEnd(): void {
    if (this.result) return;
    const p = this.units.some((u) => u.side === "player" && u.alive && !u.summoned);
    const bossAlive = this.units.some((u) => u.side === "enemy" && u.alive && u.classId === "captain");
    const anyEnemy = this.units.some((u) => u.side === "enemy" && u.alive);
    const won = this.mission.win === "boss" ? !bossAlive : !anyEnemy;
    // Victory doesn't end the battle by itself anymore — it just makes ending it an option
    // (see winAvailable/confirmFinish) so the player can keep taking normal turns to loot
    // remaining chests, with a click-whenever-ready control staying available the whole
    // time rather than a one-shot prompt they could dismiss and then have no way back to.
    // If a trap/trigger spawns a fresh enemy after the field first looked clear, this goes
    // back to false on its own until they're dealt with too. Defeat has no such choice:
    // with no player units left there's nothing left to do.
    this.winAvailable = won;
    if (!p) this.result = "defeat";
  }

  /** Player-confirmed "yes, end the mission now" — only takes effect while winAvailable
   * (the field is actually clear); a beat too late (a fresh spawn just made it false again)
   * is simply ignored rather than ending the battle out from under a live fight. */
  confirmFinish(): void {
    if (this.winAvailable && !this.result) this.result = "victory";
  }

  /** First not-yet-acted unit in this round's initiative order, or null if everyone has gone. */
  activeTurnUnit(): Unit | null {
    for (const id of this.turnOrder) {
      const u = this.units.find((x) => x.id === id);
      if (u && u.alive && !u.moved) return u;
    }
    return null;
  }

  private select(unit: Unit): void {
    if (unit.side !== "player" || !unit.alive || unit.moved || this.phase !== "player") {
      this.inspect(unit);
      return;
    }
    const active = this.activeTurnUnit();
    if (active && active.id !== unit.id) {
      this.inspect(unit);
      this.tip = `Ainda não é a vez de ${unit.name} — espere ${active.name} agir.`;
      return;
    }
    if (this.selectedId === unit.id && this.mode === "awaitAction") return;
    this.selectedId = unit.id;
    this.pendingFoeId = null;
    this.inspectedId = null;
    this.orig = { x: unit.x, y: unit.y };
    this.origMoveBudgetUsed = unit.moveBudgetUsed;
    this.reach = computeReachable(this.effectiveUnitForReach(unit), this.tiles, this.cols, this.rows, this.units);
    this.attackFrom = unit.acted ? new Map() : attackableEnemies(unit, this.reach, this.units, this.tiles, this.cols);
    this.threat = [];
    this.mode = "selected";
    this.tip = null;
    this.ensureVisible(unit.x, unit.y);
    sfxPlay.select();
  }

  private inspect(unit: Unit): void {
    this.inspectedId = unit.id;
    this.threat = computeThreat(unit, this.tiles, this.cols, this.rows, this.units);
    const max = effectiveMaxRange(unit, tileAt(this.tiles, this.cols, unit.x, unit.y));
    const tile = TERRAIN[tileAt(this.tiles, this.cols, unit.x, unit.y)];
    this.tip = `${unit.name} · HP ${unit.hp}/${unit.maxHp} · Alc ${unit.minRange === max ? max : `${unit.minRange}–${max}`}${
      tile.height ? " · alto +2" : ""
    }${tile.id === "barricade" ? " · barricada bloqueia projéteis" : ""}${
      unit.classId === "troll" ? " · parte barricadas" : ""
    }${
      unit.shock ? ` · Relâmpago ${diceFormula(unit.shock.dice, unit.shock.faces, unit.shock.bonus)} − RES no turno` : ""
    }${unit.diseased ? " · Doente (−10% em todos os stats)" : ""}${unit.poisoned ? " · Envenenado (1D4 dano por turno)" : ""}`;
    this.ensureVisible(unit.x, unit.y);
    sfxPlay.ui();
  }

  /** Whether the movement taken this turn can still be taken back.
   *
   * Only for the player's own active unit, only while it is standing somewhere other than
   * where its turn began, and only while nothing has been spent that a rewind could not
   * honestly return: acting fixes the position the action was taken from, and a move that
   * broke a barricade or crossed a hazard has already changed the board (see moveSpoiled). */
  canUndoMove(): boolean {
    const u = this.activeTurnUnit();
    return (
      !!u &&
      u.side === "player" &&
      u.alive &&
      !u.acted &&
      !u.moved &&
      !this.moveSpoiled &&
      !!this.turnStart &&
      !this.active &&
      this.queue.length === 0 &&
      (u.x !== this.turnStart.x || u.y !== this.turnStart.y) &&
      (this.mode === "selected" || this.mode === "awaitAction" || this.mode === "awaitAttack")
    );
  }

  /** Puts the active unit back where its turn began and refunds every hex it walked — the
   * whole budget, not the last hop, so a wrong click costs nothing. Undoing is not itself a
   * move: the unit is left selected with its full reach, exactly as the turn opened. */
  undoMove(): void {
    if (!this.canUndoMove()) return;
    const u = this.activeTurnUnit()!;
    const back = this.turnStart!;
    u.x = back.x;
    u.y = back.y;
    u.drawX = back.x;
    u.drawY = back.y;
    u.moveBudgetUsed = 0;
    this.orig = { x: back.x, y: back.y };
    this.origMoveBudgetUsed = 0;
    this.pendingFoeId = null;
    this.inspectedId = null;
    this.threat = [];
    this.selectedId = u.id;
    this.mode = "selected";
    this.reach = computeReachable(this.effectiveUnitForReach(u), this.tiles, this.cols, this.rows, this.units);
    this.attackFrom = attackableEnemies(u, this.reach, this.units, this.tiles, this.cols);
    this.ensureVisible(u.x, u.y);
    this.centerOn(u.x, u.y);
    this.tip = `${u.name} voltou ao ponto de partida — ${u.mov} de movimento de volta.`;
    sfxPlay.ui();
  }

  deselect(commit = false): void {
    const u = this.units.find((x) => x.id === this.selectedId);
    const canRestore = !commit && u && this.orig && (this.mode === "awaitAction" || this.mode === "selected");
    if (canRestore) {
      // A cancel returns to the last safe point as one complete snapshot: position AND
      // movement. Before an action that is turn start (full movement); after an action it
      // is the action's position and the movement already spent to reach it.
      u.x = this.orig.x;
      u.y = this.orig.y;
      u.drawX = u.x;
      u.drawY = u.y;
      u.moveBudgetUsed = this.origMoveBudgetUsed ?? (u.acted ? u.moveBudgetUsed : 0);
    }
    this.selectedId = null;
    this.pendingFoeId = null;
    this.inspectedId = null;
    this.threat = [];
    this.reach.clear();
    this.attackFrom.clear();
    this.orig = null;
    this.origMoveBudgetUsed = null;
    this.mode = "idle";
  }

  cancel(): void {
    if (this.mode === "awaitSpell") {
      this.mode = "awaitAction";
      this.spellArmed = false;
      this.spellAim = null;
      this.spellKind = null;
    this.missileTargets = [];
      this.tip = null;
      return;
    }
    if (this.mode === "awaitPotion") {
      this.mode = "awaitAction";
      this.potionAim = null;
      this.tip = null;
      return;
    }
    this.deselect();
    sfxPlay.ui();
  }

  wait(): void {
    const u = this.units.find((x) => x.id === this.selectedId);
    if (!u || this.phase !== "player") return;
    u.moved = true;
    u.x = Math.round(u.drawX);
    u.y = Math.round(u.drawY);
    u.drawX = u.x;
    u.drawY = u.y;
    this.deselect(true);
    sfxPlay.ui();
  }

  startAttack(): void {
    const u = this.units.find((x) => x.id === this.selectedId);
    if (!u || u.acted) return;
    this.mode = "awaitAttack";
    this.tip = "Toque no alvo.";
    sfxPlay.ui();
  }

  startOffHand(): void {
    const u = this.units.find((x) => x.id === this.selectedId);
    if (!u || u.acted || !u.offHandId) return;
    this.mode = "awaitOffHand";
    this.tip = "Toque no alvo.";
    sfxPlay.ui();
  }

  startFireball(): void {
    const u = this.units.find((x) => x.id === this.selectedId);
    if (!u || u.acted || this.tierRemaining(u, "fireball") <= 0) return;
    this.mode = "awaitSpell";
    this.spellKind = "fireball";
    this.spellArmed = false;
    this.spellAim = null;
    this.hover = null;
    this.tip = `${FIREBALL.name}: alcance ${FIREBALL.range}, ${fireballFormula(u.mag)} − RES em área. Toque para mirar, toque de novo para lançar.`;
    sfxPlay.ui();
  }

  startCausticVenom(): void {
    const u = this.units.find((x) => x.id === this.selectedId);
    if (!u || u.acted || this.tierRemaining(u, "causticVenom") <= 0) return;
    this.mode = "awaitSpell";
    this.spellKind = "causticVenom";
    this.spellArmed = false;
    this.spellAim = null;
    this.hover = null;
    this.tip = `${CAUSTIC_VENOM.name}: alcance ${CAUSTIC_VENOM.range}, alvo ${diceFormula(CAUSTIC_VENOM.centerDice, CAUSTIC_VENOM.centerFaces, CAUSTIC_VENOM.centerBonus)} − RES, respingo ${diceFormula(CAUSTIC_VENOM.splashDice, CAUSTIC_VENOM.splashFaces, CAUSTIC_VENOM.splashBonus)} − RES em área — envenena todos atingidos, até aliados. Toque para mirar, toque de novo para lançar.`;
    sfxPlay.ui();
  }

  startLongShot(): void {
    const u = this.units.find((x) => x.id === this.selectedId);
    if (!u || u.acted || this.tierRemaining(u, "longShot") <= 0) return;
    this.mode = "awaitSpell";
    this.spellKind = "longShot";
    this.spellArmed = false;
    this.spellAim = null;
    this.hover = null;
    this.tip = `${LONG_SHOT.name}: alcance ${u.minRange}–${this.longMax(u)}, ${longShotFormula(u.level)} − DF. Toque no inimigo.`;
    sfxPlay.ui();
  }

  startPiercing(): void {
    const u = this.units.find((x) => x.id === this.selectedId);
    if (!u || u.acted || this.tierRemaining(u, "piercing") <= 0) return;
    this.mode = "awaitSpell";
    this.spellKind = "piercing";
    this.spellArmed = false;
    this.spellAim = null;
    this.hover = null;
    this.tip = `${PIERCING.name}: reta da colmeia. ${piercingMul(u.level)}× do AT − DF em cada um na linha, aliado ou inimigo.`;
    sfxPlay.ui();
  }

  startLightning(): void {
    const u = this.units.find((x) => x.id === this.selectedId);
    if (!u || u.acted || this.tierRemaining(u, "lightning") <= 0) return;
    this.mode = "awaitSpell";
    this.spellKind = "lightning";
    this.spellArmed = false;
    this.spellAim = null;
    this.hover = null;
    this.tip = `Relâmpago: alcance ${LIGHTNING.range}, ${lightningFormula(u.mag)} − RES. No turno seguinte ${diceFormula(LIGHTNING.echoDice, LIGHTNING.echoFaces, LIGHTNING.echoBonus)} − RES. Toque no inimigo.`;
    sfxPlay.ui();
  }

  startMagicMissile(): void {
    const u = this.units.find((x) => x.id === this.selectedId);
    if (!u || u.acted || this.tierRemaining(u, "magicMissile") <= 0) return;
    this.mode = "awaitSpell";
    this.spellKind = "magicMissile";
    this.spellArmed = false;
    this.spellAim = null;
    this.hover = null;
    const shots = magicMissileCount(u.level);
    this.tip = `${MAGIC_MISSILE.name}: alcance ${MAGIC_MISSILE.range}, ${spellFormula(u.mag, MAGIC_MISSILE.mul, MAGIC_MISSILE.dice, MAGIC_MISSILE.faces, MAGIC_MISSILE.bonus)} − RES por míssil. ${shots} míssil${shots > 1 ? "eis, um alvo cada (pode repetir)" : ""}. Acerto garantido. Toque no inimigo.`;
    sfxPlay.ui();
  }

  startDoubleStrike(): void {
    const u = this.units.find((x) => x.id === this.selectedId);
    if (!u || u.acted || this.tierRemaining(u, "doubleStrike") <= 0) return;
    this.mode = "awaitSpell";
    this.spellKind = "doubleStrike";
    this.spellArmed = false;
    this.spellAim = null;
    this.hover = null;
    this.tip = `${DOUBLE_STRIKE.name}: ataca duas vezes, ${doubleStrikeFormula(u.level)}. Toque no inimigo.`;
    sfxPlay.ui();
  }

  startCleave(): void {
    const u = this.units.find((x) => x.id === this.selectedId);
    if (!u || u.acted || this.tierRemaining(u, "cleave") <= 0) return;
    this.mode = "awaitSpell";
    this.spellKind = "cleave";
    this.spellArmed = false;
    this.spellAim = null;
    this.hover = null;
    this.tip = `${CLEAVE.name}: ${CLEAVE.hexes} hexes adjacentes, ${cleaveFormula(u.level)}. Toque num hex vizinho.`;
    sfxPlay.ui();
  }

  startPiercingThrust(): void {
    const u = this.units.find((x) => x.id === this.selectedId);
    if (!u || u.acted || this.tierRemaining(u, "piercingThrust") <= 0) return;
    this.mode = "awaitSpell";
    this.spellKind = "piercingThrust";
    this.spellArmed = false;
    this.spellAim = null;
    this.hover = null;
    this.tip = `${PIERCING_THRUST.name}: reta curta, ignora ${Math.round(PIERCING_THRUST.armorIgnore * 100)}% da defesa. 1º alvo dano cheio, os demais metade.`;
    sfxPlay.ui();
  }

  /** Sweep (Lancer tier 2) needs no target — it always hits every enemy on an adjacent hex
   * and resolves immediately, same as Esperar/Arrombar rather than the aim-then-Lançar flow
   * every other spell uses. */
  startSweep(): void {
    const u = this.units.find((x) => x.id === this.selectedId);
    if (!u || u.acted || this.tierRemaining(u, "sweep") <= 0) return;
    const tiles = hexNeighbors(u.x, u.y);
    const ids: string[] = [];
    for (const t of tiles) {
      const who = this.units.find((x) => x.alive && occupies(x, t.x, t.y));
      if (who && who.id !== u.id && who.side !== u.side && !ids.includes(who.id)) ids.push(who.id);
    }
    this.spendTier(u, "sweep");
    this.spellKind = null;
    this.missileTargets = [];
    this.spellArmed = false;
    this.spellAim = null;
    this.tip = null;
    this.mode = "locked";
    this.queue.push({ type: "spell", att: u.id, tiles, ids, label: SWEEP.name, spellKind: "sweep" });
    sfxPlay.sweep();
  }

  startTrip(): void {
    const u = this.units.find((x) => x.id === this.selectedId);
    if (!u || u.acted || this.tierRemaining(u, "trip") <= 0) return;
    this.mode = "awaitSpell";
    this.spellKind = "trip";
    this.spellArmed = false;
    this.spellAim = null;
    this.hover = null;
    this.tip = `${TRIP.name}: dano da arma + ${diceFormula(1, TRIP.bonusFaces, TRIP.bonusBonus)}, atordoa por ${TRIP.stunRounds} turnos e reduz stats em ${Math.round(TRIP.statPenalty * 100)}% até o fim do combate. Toque no inimigo.`;
    sfxPlay.ui();
  }

  startSummonFamiliar(): void {
    const u = this.units.find((x) => x.id === this.selectedId);
    if (!u || u.acted || this.tierRemaining(u, "summonFamiliar") <= 0) return;
    this.mode = "awaitSpell";
    this.spellKind = "summonFamiliar";
    this.spellArmed = false;
    this.spellAim = null;
    this.hover = null;
    this.tip = `${SUMMON_FAMILIAR.name}: convoca um aliado com metade dos seus atributos atuais, até ${SUMMON_FAMILIAR.range} hexes. Toque num espaço livre.`;
    sfxPlay.ui();
  }

  startWebOfDreams(): void {
    const u = this.units.find((x) => x.id === this.selectedId);
    if (!u || u.acted || this.tierRemaining(u, "webOfDreams") <= 0) return;
    this.mode = "awaitSpell";
    this.spellKind = "webOfDreams";
    this.spellArmed = false;
    this.spellAim = null;
    this.hover = null;
    this.tip = `${WEB_OF_DREAMS.name}: cria uma teia grudenta por ${WEB_OF_DREAMS.durationRounds} rodadas — quem estiver dentro fica com movimento reduzido a 1 hex, e testa ${Math.round(WEB_OF_DREAMS.sleepChance * 100)}% de chance de adormecer por ${diceFormula(WEB_OF_DREAMS.sleepDice, WEB_OF_DREAMS.sleepFaces, 0)} turnos a cada turno que permanecer lá dentro (cumulativo). Alcance ${WEB_OF_DREAMS.range}. Toque para mirar.`;
    sfxPlay.ui();
  }

  startMultiShot(): void {
    const u = this.units.find((x) => x.id === this.selectedId);
    if (!u || u.acted || this.tierRemaining(u, "multiShot") <= 0) return;
    this.mode = "awaitSpell";
    this.spellKind = "multiShot";
    this.spellArmed = false;
    this.spellAim = null;
    this.hover = null;
    const want = multiShotTargets(u.level);
    this.tip = `${MULTI_SHOT.name}: ${multiShotFormula(u.level)}, alcance arma+${MULTI_SHOT.rangeBonus}. Escolha ${want} alvos (pode repetir).`;
    sfxPlay.ui();
  }

  /** Aura of Protection (Paladin tier 5) / Intimidating Presence (Heavy Knight tier 5): both
   * instant and self-centered, same as Sweep — no aim, no confirmSpell branch needed. */
  startAuraOfProtection(): void {
    const u = this.units.find((x) => x.id === this.selectedId);
    if (!u || u.acted || this.tierRemaining(u, "auraOfProtection") <= 0) return;
    const p = auraPower(u.level);
    const cells = new Set(hexAreaTiles({ x: u.x, y: u.y }, p.radius, this.cols, this.rows).map((c) => key(c.x, c.y)));
    this.auraZones.push({ cells, roundsLeft: p.duration, kind: "protection", side: u.side, pct: p.pct });
    this.spendTier(u, "auraOfProtection");
    this.spellKind = null;
    this.spellArmed = false;
    this.spellAim = null;
    this.tip = `${AURA_OF_PROTECTION.name}: aliados a até ${p.radius} hexes tomam ${Math.round(p.pct * 100)}% menos dano por ${p.duration} rodadas.`;
    this.mode = "locked";
    this.queue.push({ type: "banner", text: AURA_OF_PROTECTION.name, dur: 1.1 });
    sfxPlay.ui();
  }

  startIntimidatingPresence(): void {
    const u = this.units.find((x) => x.id === this.selectedId);
    if (!u || u.acted || this.tierRemaining(u, "intimidatingPresence") <= 0) return;
    const p = auraPower(u.level);
    const cells = new Set(hexAreaTiles({ x: u.x, y: u.y }, p.radius, this.cols, this.rows).map((c) => key(c.x, c.y)));
    this.auraZones.push({ cells, roundsLeft: p.duration, kind: "intimidation", side: u.side, pct: p.pct });
    this.spendTier(u, "intimidatingPresence");
    this.spellKind = null;
    this.spellArmed = false;
    this.spellAim = null;
    this.tip = `${INTIMIDATING_PRESENCE.name}: inimigos a até ${p.radius} hexes tomam ${Math.round(p.pct * 100)}% mais dano por ${p.duration} rodadas.`;
    this.mode = "locked";
    this.queue.push({ type: "banner", text: INTIMIDATING_PRESENCE.name, dur: 1.1 });
    sfxPlay.ui();
  }

  startDivineWrath(): void {
    const u = this.units.find((x) => x.id === this.selectedId);
    if (!u || u.acted || this.tierRemaining(u, "divineWrath") <= 0) return;
    this.mode = "awaitSpell";
    this.spellKind = "divineWrath";
    this.spellArmed = false;
    this.spellAim = null;
    this.hover = null;
    this.tip = `${DIVINE_WRATH.name}: linha reta, ${divineWrathFormula(u.level, u.mag)}, nunca atinge aliados. Alcance ${DIVINE_WRATH.range}. Toque para mirar.`;
    sfxPlay.ui();
  }

  /** Shoulder Smash (Heavy Knight tier 4): refuses to arm while a shield is equipped in the
   * off hand — it's the bare-handed/two-handed version of a knightly charge. */
  startShoulderSmash(): void {
    const u = this.units.find((x) => x.id === this.selectedId);
    if (!u || u.acted || this.tierRemaining(u, "shoulderSmash") <= 0) return;
    if (u.offHandId && EQUIPMENT[u.offHandId]?.kind === "shield") {
      this.tip = "Requer as duas mãos livres — sem escudo equipado.";
      sfxPlay.ui();
      return;
    }
    this.mode = "awaitSpell";
    this.spellKind = "shoulderSmash";
    this.spellArmed = false;
    this.spellAim = null;
    this.hover = null;
    const p = shoulderSmashPower(u.level);
    this.tip = `${SHOULDER_SMASH.name}: ${p.hexes} hexes adjacentes, ${shoulderSmashFormula(u.level)}, empurra ${SHOULDER_SMASH.knockback} hexes. Toque num hex vizinho.`;
    sfxPlay.ui();
  }

  startStampede(): void {
    const u = this.units.find((x) => x.id === this.selectedId);
    if (!u || u.acted || this.tierRemaining(u, "stampede") <= 0) return;
    this.mode = "awaitSpell";
    this.spellKind = "stampede";
    this.spellArmed = false;
    this.spellAim = null;
    this.hover = null;
    this.tip = `${STAMPEDE.name}: linha reta, ${stampedeFormula(u.level)}, atinge todos na linha (aliados inclusos). Alcance ${STAMPEDE.range}. Toque para mirar.`;
    sfxPlay.ui();
  }

  confirmSpell(): void {
    const u = this.units.find((x) => x.id === this.selectedId);
    const cell = this.hover;
    if (!u || this.mode !== "awaitSpell" || !cell || !this.spellKind) return;
    if (this.spellKind === "fireball") {
      this.confirmFireball();
      return;
    }
    if (this.spellKind === "causticVenom") {
      this.confirmCausticVenom();
      return;
    }
    if (this.spellKind === "longShot") {
      this.castLongShot(u, cell);
      return;
    }
    if (this.spellKind === "piercing") {
      this.castPiercing(u, cell);
      return;
    }
    if (this.spellKind === "piercingThrust") {
      this.castPiercingThrust(u, cell);
      return;
    }
    if (this.spellKind === "trip") {
      this.castTrip(u, cell);
      return;
    }
    if (this.spellKind === "summonFamiliar") {
      this.castSummonFamiliar(u, cell);
      return;
    }
    if (this.spellKind === "webOfDreams") {
      this.castWebOfDreams(u, cell);
      return;
    }
    if (this.spellKind === "lightning") {
      this.castLightning(u, cell);
      return;
    }
    if (this.spellKind === "magicMissile") {
      this.castMagicMissile(u, cell);
      return;
    }
    if (this.spellKind === "doubleStrike") {
      this.castDoubleStrike(u, cell);
      return;
    }
    if (this.spellKind === "cleave") {
      this.castCleave(u, cell);
      return;
    }
    if (this.spellKind === "cureDisease") {
      this.castCureDisease(u, cell);
      return;
    }
    if (this.spellKind === "multiShot") {
      this.castMultiShot(u, cell);
      return;
    }
    if (this.spellKind === "divineWrath") {
      this.castDivineWrath(u, cell);
      return;
    }
    if (this.spellKind === "shoulderSmash") {
      this.castShoulderSmash(u, cell);
      return;
    }
    if (this.spellKind === "stampede") {
      this.castStampede(u, cell);
      return;
    }
    // instant, resolved directly by their own startX() — never reaches here
    if (this.spellKind === "sweep" || this.spellKind === "auraOfProtection" || this.spellKind === "intimidatingPresence") return;
    // secondWind is a passive triggered from startOfTurnEffects, never armed via a startX()
    if (this.spellKind === "secondWind") return;
    this.castHeal(u, cell, this.spellKind);
  }

  startCure(kind: HealId): void {
    const u = this.units.find((x) => x.id === this.selectedId);
    if (!u || u.acted || this.tierRemaining(u, kind) <= 0) return;
    this.mode = "awaitSpell";
    this.spellKind = kind;
    this.spellArmed = false;
    this.spellAim = null;
    this.hover = null;
    this.tip = `${CURES[kind].name}: ${healFormula(u.mag, kind)} HP, alcance ${CURES[kind].range}. Toque num aliado ferido.`;
    sfxPlay.ui();
  }

  startCureDisease(): void {
    const u = this.units.find((x) => x.id === this.selectedId);
    if (!u || u.acted || this.tierRemaining(u, "cureDisease") <= 0) return;
    this.mode = "awaitSpell";
    this.spellKind = "cureDisease";
    this.spellArmed = false;
    this.spellAim = null;
    this.hover = null;
    this.tip = `${CURE_DISEASE.name}: cura doença, alcance ${CURE_DISEASE.range}. Toque num aliado doente.`;
    sfxPlay.ui();
  }

  confirmHeal(): void {
    const u = this.units.find((x) => x.id === this.selectedId);
    const cell = this.hover;
    if (!u || this.mode !== "awaitSpell" || !cell || !this.isHeal(this.spellKind)) return;
    this.castHeal(u, cell, this.spellKind);
  }

  private isHeal(kind: SpellKind | null): kind is HealId {
    return kind === "cureMinor" || kind === "cureWounds" || kind === "cureLight";
  }

  private tierRemaining(u: Unit, kind: SpellKind): number {
    const tier = spellTier(kind);
    return tier ? u.spells[tierKey(tier)] : 0;
  }

  private spendTier(u: Unit, kind: SpellKind): void {
    const tier = spellTier(kind);
    if (!tier) return;
    u.spells[tierKey(tier)] -= 1;
  }

  private longMax(u: Unit): number {
    const ranged = u.weaponId ? !!WEAPONS[u.weaponId]?.ranged : false;
    const extra = ranged && TERRAIN[tileAt(this.tiles, this.cols, u.x, u.y)].height ? 1 : 0;
    return u.maxRange * LONG_SHOT.rangeMul + LONG_SHOT.rangeBonus + extra;
  }

  /** True while (x,y) sits inside any still-active Web of Dreams patch. */
  private isWebCell(x: number, y: number): boolean {
    return this.webZones.some((z) => z.cells.has(key(x, y)));
  }

  /** Combined multiplier from every active Aura of Protection / Intimidating Presence zone
   * covering `defender`'s current cell — applied to the final damage of a hit right before it
   * comes off their HP, same insertion point as the sleepBonusDamage multiplier. Protection
   * only discounts a zone's own side; Intimidating Presence only surcharges the other side, so
   * a unit standing in both a friendly and a hostile zone at once takes both at the same time. */
  private zoneDamageMul(defender: Unit): number {
    let mul = 1;
    for (const z of this.auraZones) {
      if (!z.cells.has(key(defender.x, defender.y))) continue;
      if (z.kind === "protection" && z.side === defender.side) mul *= 1 - z.pct;
      if (z.kind === "intimidation" && z.side !== defender.side) mul *= 1 + z.pct;
    }
    return mul;
  }

  /** Every reach computation for a player unit's own turn — including every re-derive free
   * repositioning does after each move — funnels through here.
   *
   * Reach is measured from wherever the unit is actually standing right now, capped by
   * mov - moveBudgetUsed: movement is spent as you walk, cumulatively, exactly like the
   * panel counts it down. A prior version anchored reach at this.turnStart with the full mov
   * instead, meaning moveBudgetUsed measured distance-from-turnStart rather than distance
   * walked — walk 3 hexes out and 3 back and it read 0 again, full budget restored, every
   * cell within mov of the start tile re-selectable indefinitely. That's not a movement cap,
   * it's a teleport with a leash. The real fix for "an exploratory move can strand you" was
   * already sitting right here: canUndoMove/undoMove, a full manual rewind to turnStart for
   * exactly a wrong click — never trade the cap itself away for that.
   *
   * Enemy AI turns never set this.turnStart and don't reposition, so they were never affected
   * by the turnStart-anchoring either way — they've always read straight off their own live
   * x/y, same as here.
   *
   * Web of Dreams' "restrained / difficult terrain" clause — a unit whose current cell was
   * webbed at the START of its turn (this.turnRestrained, decided once in beginUnitTurn, not
   * re-checked live) clamps mov to 1 — applies on top, for both sides. */
  /** Movement this unit has left this turn, off the same cumulative moveBudgetUsed
   * commitMove accumulates — how far it's actually walked. Reach (effectiveUnitForReach)
   * shrinks with it too now, so this and what's selectable always agree. It's also what
   * decides when an already-acted unit's turn auto-ends (see commitMove), and what the panel
   * counts down as the unit walks.
   *
   * The restrained clamp applies to whoever's turn it actually is and nobody else:
   * turnRestrained is decided once, in beginUnitTurn, for the active unit, and says nothing
   * about an enemy the player happens to be inspecting. */
  private movLeft(u: Unit): number {
    const remaining = Math.max(0, u.mov - u.moveBudgetUsed);
    return this.turnRestrained && this.activeTurnUnit()?.id === u.id ? Math.min(remaining, 1) : remaining;
  }

  private effectiveUnitForReach(u: Unit): Unit {
    const remaining = Math.max(0, u.mov - u.moveBudgetUsed);
    const cap = this.turnRestrained ? Math.min(1, remaining) : remaining;
    return cap === u.mov ? u : { ...u, mov: cap };
  }

  private spellAimValid(caster: Unit, cell: Point): boolean {
    if (!this.spellKind) return false;
    if (this.spellKind === "fireball") {
      if (manhattan(caster, cell) > FIREBALL.range) return false;
      return clearShot(caster, fireballOrigin(cell, this.cols, this.rows), this.tiles, this.cols, "bolt");
    }
    if (this.spellKind === "causticVenom") {
      if (manhattan(caster, cell) > CAUSTIC_VENOM.range) return false;
      return clearShot(caster, fireballOrigin(cell, this.cols, this.rows), this.tiles, this.cols, "bolt");
    }
    if (this.spellKind === "longShot") {
      const d = manhattan(caster, cell);
      const here = occupancy(this.units).get(key(cell.x, cell.y));
      if (!here || !attackableByPlayer(here) || d < caster.minRange || d > this.longMax(caster)) return false;
      return clearShot(caster, cell, this.tiles, this.cols, "arrow");
    }
    if (this.spellKind === "piercing") return this.piercingRay(caster, cell) !== null;
    if (this.spellKind === "piercingThrust") return this.piercingThrustRay(caster, cell) !== null;
    if (this.spellKind === "lightning") {
      const here = occupancy(this.units).get(key(cell.x, cell.y));
      if (!here || !attackableByPlayer(here) || manhattan(caster, cell) > LIGHTNING.range) return false;
      return clearShot(caster, cell, this.tiles, this.cols, "bolt");
    }
    if (this.spellKind === "magicMissile") {
      const here = occupancy(this.units).get(key(cell.x, cell.y));
      if (!here || !attackableByPlayer(here) || manhattan(caster, cell) > MAGIC_MISSILE.range) return false;
      return clearShot(caster, cell, this.tiles, this.cols, "bolt");
    }
    if (this.spellKind === "summonFamiliar") {
      if (manhattan(caster, cell) > SUMMON_FAMILIAR.range) return false;
      if (!inBounds(cell.x, cell.y, this.cols, this.rows)) return false;
      if (!TERRAIN[tileAt(this.tiles, this.cols, cell.x, cell.y)].passable) return false;
      return !occupancy(this.units).get(key(cell.x, cell.y));
    }
    if (this.spellKind === "webOfDreams") {
      if (manhattan(caster, cell) > WEB_OF_DREAMS.range) return false;
      return clearShot(caster, fireballOrigin(cell, this.cols, this.rows), this.tiles, this.cols, "bolt");
    }
    if (this.spellKind === "doubleStrike" || this.spellKind === "trip") {
      const here = occupancy(this.units).get(key(cell.x, cell.y));
      return !!here && here.alive && here.side !== caster.side && canHitFrom(caster, caster, here, this.tiles, this.cols);
    }
    if (this.spellKind === "cleave" || this.spellKind === "shoulderSmash") {
      return hexNeighbors(caster.x, caster.y).some((p) => p.x === cell.x && p.y === cell.y);
    }
    if (this.spellKind === "multiShot") {
      const d = manhattan(caster, cell);
      const here = occupancy(this.units).get(key(cell.x, cell.y));
      if (!here || !attackableByPlayer(here) || d < caster.minRange || d > caster.maxRange + MULTI_SHOT.rangeBonus) return false;
      return clearShot(caster, cell, this.tiles, this.cols, "arrow");
    }
    if (this.spellKind === "divineWrath") return this.wrathRay(caster, cell, DIVINE_WRATH.range) !== null;
    if (this.spellKind === "stampede") return this.wrathRay(caster, cell, STAMPEDE.range) !== null;
    if (this.spellKind === "cureDisease") return this.validCureDiseaseTarget(caster, cell);
    return this.validHealTarget(caster, cell);
  }

  /** Divine Wrath / Stampede: the same directional-line traversal as Piercing (aimed by
   * clicking through a cell to set the direction), just capped to their own range instead of
   * running the length of the board. */
  private wrathRay(caster: Unit, through: Point, range: number): Point[] | null {
    const raw = this.piercingRay(caster, through);
    if (!raw) return null;
    const capped = raw.slice(0, range);
    return capped.length ? capped : null;
  }

  private piercingRay(from: Point, through: Point): Point[] | null {
    const raw = piercingLine(from, through, this.cols, this.rows);
    if (!raw) return null;
    const fromHigh = !!TERRAIN[tileAt(this.tiles, this.cols, from.x, from.y)].height;
    const out: Point[] = [];
    for (const p of raw) {
      const t = TERRAIN[tileAt(this.tiles, this.cols, p.x, p.y)];
      if (t.id === "barricade" || t.blocksShot) break;
      if (t.height && !fromHigh) break;
      out.push(p);
    }
    return out.length ? out : null;
  }

  /** Piercing Thrust (Lancer tier 1): the same straight-line traversal as Piercing, capped
   * to the caster's own weapon reach + 1 hex — a short lunge, not an arrow flying the length
   * of the board. */
  private piercingThrustRay(caster: Unit, through: Point): Point[] | null {
    const raw = this.piercingRay(caster, through);
    if (!raw) return null;
    const capped = raw.slice(0, caster.maxRange + 1);
    return capped.length ? capped : null;
  }

  /** Sweep (Lancer tier 2): shoves `foe` one hex further along the line from `att` through
   * `foe`, silently doing nothing if that hex is off the board, impassable, or already
   * occupied — a blocked shove just fails, it never displaces someone else instead. */
  private knockBack(att: Unit, foe: Unit): void {
    const from = oddrToCube(att.x, att.y);
    const at = oddrToCube(foe.x, foe.y);
    const dir = { q: at.q - from.q, r: at.r - from.r, s: at.s - from.s };
    const pushed = cubeAdd(at, dir);
    const dest = cubeToOddr(pushed.q, pushed.r);
    if (!inBounds(dest.x, dest.y, this.cols, this.rows)) return;
    if (!TERRAIN[tileAt(this.tiles, this.cols, dest.x, dest.y)].passable) return;
    if (this.units.some((u) => u.alive && occupies(u, dest.x, dest.y))) return;
    foe.x = dest.x;
    foe.y = dest.y;
    foe.drawX = dest.x;
    foe.drawY = dest.y;
    this.emitParticle({
      x: foe.drawX,
      y: foe.drawY + 0.3,
      vx: 0,
      vy: 0,
      life: 0,
      max: 0.35,
      size: 1,
      color: "#c9b28a",
      kind: "impact",
      frame: 0,
    });
  }

  private validHealTarget(caster: Unit, cell: Point): boolean {
    if (!this.isHeal(this.spellKind)) return false;
    const range = CURES[this.spellKind].range;
    if (manhattan(caster, cell) > range) return false;
    const occ = occupancy(this.units);
    const who = occ.get(key(cell.x, cell.y));
    return !!who && who.side === "player" && who.alive && who.hp < who.maxHp;
  }

  private validCureDiseaseTarget(caster: Unit, cell: Point): boolean {
    if (manhattan(caster, cell) > CURE_DISEASE.range) return false;
    const occ = occupancy(this.units);
    const who = occ.get(key(cell.x, cell.y));
    return !!who && who.side === "player" && who.alive && (who.diseased || who.poisoned);
  }

  private healRangeTiles(from: Point, range: number): Point[] {
    const out: Point[] = [];
    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) {
        if (manhattan(from, { x, y }) <= range) out.push({ x, y });
      }
    }
    return out;
  }

  private castHeal(unit: Unit, cell: Point, kind: HealId): void {
    if (!this.validHealTarget(unit, cell)) {
      this.tip = "Alvo inválido.";
      sfxPlay.ui();
      return;
    }
    const occ = occupancy(this.units);
    const target = occ.get(key(cell.x, cell.y));
    if (!target) return;
    this.spendTier(unit, kind);
    this.spellKind = null;
    this.missileTargets = [];
    this.tip = null;
    this.mode = "locked";
    this.queue.push({ type: "heal", att: unit.id, def: target.id, kind });
  }

  private castCureDisease(unit: Unit, cell: Point): void {
    if (!this.validCureDiseaseTarget(unit, cell)) {
      this.tip = "Alvo inválido.";
      sfxPlay.ui();
      return;
    }
    const occ = occupancy(this.units);
    const target = occ.get(key(cell.x, cell.y));
    if (!target) return;
    this.spendTier(unit, "cureDisease");
    this.spellKind = null;
    this.missileTargets = [];
    this.tip = null;
    this.mode = "locked";
    this.queue.push({ type: "cureDisease", att: unit.id, def: target.id });
  }

  confirmFireball(): void {
    const u = this.units.find((x) => x.id === this.selectedId);
    const cell = this.hover;
    if (!u || this.mode !== "awaitSpell" || !cell) return;
    if (manhattan(u, cell) > FIREBALL.range) {
      this.tip = "Fora de alcance.";
      sfxPlay.ui();
      return;
    }
    this.castFireball(u, cell);
  }

  confirmCausticVenom(): void {
    const u = this.units.find((x) => x.id === this.selectedId);
    const cell = this.hover;
    if (!u || this.mode !== "awaitSpell" || !cell) return;
    if (manhattan(u, cell) > CAUSTIC_VENOM.range) {
      this.tip = "Fora de alcance.";
      sfxPlay.ui();
      return;
    }
    this.castCausticVenom(u, cell);
  }

  private castLongShot(unit: Unit, cell: Point): void {
    if (!this.spellAimValid(unit, cell)) {
      this.tip = "Alvo fora de alcance.";
      sfxPlay.ui();
      return;
    }
    const occ = occupancy(this.units);
    const foe = occ.get(key(cell.x, cell.y));
    if (!foe) return;
    this.spendTier(unit, "longShot");
    this.spellKind = null;
    this.missileTargets = [];
    this.tip = null;
    this.mode = "locked";
    const power = longShotPower(unit.level);
    this.queue.push({
      type: "spell",
      att: unit.id,
      tiles: [cell],
      ids: [foe.id],
      label: LONG_SHOT.name,
      weaponBonusDice: power.dice,
      weaponBonusFaces: power.faces,
      weaponBonusBonus: 0,
      spellKind: "longShot",
    });
  }

  private castPiercing(unit: Unit, cell: Point): void {
    const line = this.piercingRay(unit, cell);
    if (!line) {
      this.tip = "Escolha uma reta da colmeia.";
      sfxPlay.ui();
      return;
    }
    const ids: string[] = [];
    for (const t of line) {
      const who = this.units.find((x) => x.alive && occupies(x, t.x, t.y));
      if (who && who.id !== unit.id && !ids.includes(who.id)) ids.push(who.id);
    }
    this.spendTier(unit, "piercing");
    this.spellKind = null;
    this.missileTargets = [];
    this.tip = null;
    this.mode = "locked";
    this.queue.push({ type: "spell", att: unit.id, tiles: line, ids, label: PIERCING.name, dmgMul: piercingMul(unit.level), spellKind: "piercing" });
  }

  private castPiercingThrust(unit: Unit, cell: Point): void {
    const line = this.piercingThrustRay(unit, cell);
    if (!line) {
      this.tip = "Escolha uma reta na frente.";
      sfxPlay.ui();
      return;
    }
    const ids: string[] = [];
    for (const t of line) {
      const who = this.units.find((x) => x.alive && occupies(x, t.x, t.y));
      if (who && who.id !== unit.id && !ids.includes(who.id)) ids.push(who.id);
    }
    this.spendTier(unit, "piercingThrust");
    this.spellKind = null;
    this.missileTargets = [];
    this.tip = null;
    this.mode = "locked";
    sfxPlay.thrust();
    this.queue.push({ type: "spell", att: unit.id, tiles: line, ids, label: PIERCING_THRUST.name, spellKind: "piercingThrust" });
  }

  private castLightning(unit: Unit, cell: Point): void {
    if (!this.spellAimValid(unit, cell)) {
      this.tip = "Alvo fora de alcance.";
      sfxPlay.ui();
      return;
    }
    const occ = occupancy(this.units);
    const foe = occ.get(key(cell.x, cell.y));
    if (!foe) return;
    this.spendTier(unit, "lightning");
    this.spellKind = null;
    this.missileTargets = [];
    this.tip = null;
    this.mode = "locked";
    this.queue.push({
      type: "spell",
      att: unit.id,
      tiles: [cell],
      ids: [foe.id],
      dice: lightningDice(),
      faces: LIGHTNING.faces,
      bonus: LIGHTNING.bonus,
      label: LIGHTNING.name,
      echo: { dice: LIGHTNING.echoDice, faces: LIGHTNING.echoFaces, bonus: LIGHTNING.echoBonus },
      spellMul: LIGHTNING.mul,
      spellKind: "lightning",
    });
  }

  /** Each missile is aimed separately, so the cast collects one target per tap and only
   * fires once they are all chosen. They may be stacked on one enemy or spread around. */
  private castMagicMissile(unit: Unit, cell: Point): void {
    if (!this.spellAimValid(unit, cell)) {
      this.tip = "Alvo fora de alcance.";
      sfxPlay.ui();
      return;
    }
    const occ = occupancy(this.units);
    const foe = occ.get(key(cell.x, cell.y));
    if (!foe) return;

    const want = magicMissileCount(unit.level);
    this.missileTargets.push({ id: foe.id, cell: { x: cell.x, y: cell.y } });
    if (this.missileTargets.length < want) {
      const left = want - this.missileTargets.length;
      this.tip = `${MAGIC_MISSILE.name} · escolha mais ${left} alvo${left > 1 ? "s" : ""} (pode repetir).`;
      sfxPlay.ui();
      return;
    }

    const shots = this.missileTargets;
    this.missileTargets = [];
    this.spendTier(unit, "magicMissile");
    this.spellKind = null;
    this.missileTargets = [];
    this.tip = null;
    this.mode = "locked";
    // One queued cast per missile: each rolls its own 3d4 and takes the target's RES off
    // separately, which is what makes splitting them different from one big hit.
    for (const shot of shots) {
      this.queue.push({
        type: "spell",
        att: unit.id,
        tiles: [shot.cell],
        ids: [shot.id],
        dice: MAGIC_MISSILE.dice,
        faces: MAGIC_MISSILE.faces,
        bonus: MAGIC_MISSILE.bonus,
        label: MAGIC_MISSILE.name,
        spellMul: MAGIC_MISSILE.mul,
      spellKind: "magicMissile",
      });
    }
  }

  /** Archer tier 3: the same click-N-targets flow as Magic Missile (this.missileTargets),
   * but each shot is a plain weapon hit plus a bonus die (weaponBonusDice) instead of a
   * MAG-scaled spellDamage roll — Multi Shot is a volley of arrows, not a spell. */
  private castMultiShot(unit: Unit, cell: Point): void {
    if (!this.spellAimValid(unit, cell)) {
      this.tip = "Alvo fora de alcance.";
      sfxPlay.ui();
      return;
    }
    const occ = occupancy(this.units);
    const foe = occ.get(key(cell.x, cell.y));
    if (!foe) return;

    const want = multiShotTargets(unit.level);
    this.missileTargets.push({ id: foe.id, cell: { x: cell.x, y: cell.y } });
    if (this.missileTargets.length < want) {
      const left = want - this.missileTargets.length;
      this.tip = `${MULTI_SHOT.name} · escolha mais ${left} alvo${left > 1 ? "s" : ""} (pode repetir).`;
      sfxPlay.ui();
      return;
    }

    const shots = this.missileTargets;
    this.missileTargets = [];
    this.spendTier(unit, "multiShot");
    this.spellKind = null;
    this.tip = null;
    this.mode = "locked";
    const power = multiShotPower(unit.level);
    for (const shot of shots) {
      this.queue.push({
        type: "spell",
        att: unit.id,
        tiles: [shot.cell],
        ids: [shot.id],
        label: MULTI_SHOT.name,
        weaponBonusDice: power.dice,
        weaponBonusFaces: power.faces,
        weaponBonusBonus: 0,
        spellKind: "multiShot",
      });
    }
  }

  private castDoubleStrike(unit: Unit, cell: Point): void {
    if (!this.spellAimValid(unit, cell)) {
      this.tip = "Toque no inimigo.";
      sfxPlay.ui();
      return;
    }
    const occ = occupancy(this.units);
    const foe = occ.get(key(cell.x, cell.y));
    if (!foe) return;
    this.spendTier(unit, "doubleStrike");
    this.spellKind = null;
    this.missileTargets = [];
    this.tip = null;
    this.mode = "locked";
    // Rolled fresh for each hit (see doubleStrikePower) — it does not stack across the two
    // strikes, each just gets its own independent roll of the current tier.
    const power = doubleStrikePower(unit.level);
    const bonus = power.dice > 0 ? { bonusDice: power.faces, bonusDiceCount: power.dice, bonusFlat: 0 } : {};
    this.queue.push({ type: "combat", att: unit.id, def: foe.id, noCounter: true, ...bonus });
    this.queue.push({ type: "combat", att: unit.id, def: foe.id, ...bonus });
  }

  private castTrip(unit: Unit, cell: Point): void {
    if (!this.spellAimValid(unit, cell)) {
      this.tip = "Toque no inimigo.";
      sfxPlay.ui();
      return;
    }
    const occ = occupancy(this.units);
    const foe = occ.get(key(cell.x, cell.y));
    if (!foe) return;
    this.spendTier(unit, "trip");
    this.spellKind = null;
    this.missileTargets = [];
    this.tip = null;
    this.mode = "locked";
    this.queue.push({
      type: "combat",
      att: unit.id,
      def: foe.id,
      noCounter: true,
      bonusDice: TRIP.bonusFaces,
      bonusFlat: TRIP.bonusBonus,
      spellKind: "trip",
    });
  }

  /** Summon Familiar (Conjurer tier 1): spawns a new player-side unit directly into
   * `this.units` — no queued animation step, it just appears. It has no slot in this round's
   * `turnOrder` (that's rebuilt from `this.units` fresh every round in startNewRound), so it
   * waits for the round after this one to act, same as any other reinforcement would. */
  private castSummonFamiliar(unit: Unit, cell: Point): void {
    if (!this.spellAimValid(unit, cell)) {
      this.tip = "Escolha um espaço livre ao alcance.";
      sfxPlay.ui();
      return;
    }
    const cls = CLASSES.familiar;
    const scale = SUMMON_FAMILIAR.statScale;
    const maxHp = Math.max(1, Math.round(unit.maxHp * scale));
    const familiar: Unit = {
      id: `player-familiar-${this.units.length}`,
      name: `Familiar de ${unit.name}`,
      classId: "familiar",
      className: cls.name,
      role: cls.role,
      side: "player",
      sprite: cls.sprite,
      x: cell.x,
      y: cell.y,
      hp: maxHp,
      maxHp,
      atk: Math.round(unit.atk * scale),
      mag: Math.round(unit.mag * scale),
      def: Math.round(unit.def * scale),
      res: Math.round(unit.res * scale),
      mov: cls.mov,
      minRange: cls.minRange,
      maxRange: cls.maxRange,
      moved: false,
      acted: false,
      facing: 1,
      walkPose: "front",
      alive: true,
      drawX: cell.x,
      drawY: cell.y,
      flash: 0,
      levelGlow: 0,
      healGlow: 0,
      fade: 1,
      bob: 0,
      level: unit.level,
      xp: 0,
      bag: { ...EMPTY_BAG },
      spells: { tier1: 0, tier2: 0, tier3: 0, tier4: 0, tier5: 0, tier6: 0, tier7: 0, tier8: 0, tier9: 0, tier10: 0 },
      weaponId: null,
      weaponEnh: 0,
      size: cls.size,
      footprintW: cls.footprintW,
      footprintH: cls.footprintH,
      footprintOffsets: cls.footprintOffsets,
      shock: null,
      diseased: false,
      diseaseBase: null,
      poisoned: false,
      stunned: false,
      stunTurns: 0,
      crippled: false,
      offHandId: null,
      gear: {},
      summoned: true,
      asleep: false,
      sleepTurns: 0,
      guaranteedDrop: false,
      moveBudgetUsed: 0,
    };
    this.units.push(familiar);
    this.spendTier(unit, "summonFamiliar");
    this.spellKind = null;
    this.missileTargets = [];
    this.emitParticle({
      x: cell.x,
      y: cell.y - 0.2,
      vx: 0,
      vy: -0.3,
      life: 0,
      max: 0.5,
      size: 1.4,
      color: "#8c6cd8",
      kind: "impact",
      frame: 0,
    });
    this.tip = `${unit.name} invocou ${familiar.name}.`;
    sfxPlay.spell();
    this.finishAction(unit);
  }

  private castWebOfDreams(unit: Unit, click: Point): void {
    if (!this.spellAimValid(unit, click)) {
      this.tip = "Escolha um espaço ao alcance.";
      sfxPlay.ui();
      return;
    }
    const cells = hexAreaTiles(click, WEB_OF_DREAMS.size, this.cols, this.rows);
    const cellKeys = new Set(cells.map((p) => key(p.x, p.y)));
    this.webZones.push({ cells: cellKeys, roundsLeft: WEB_OF_DREAMS.durationRounds });
    let asleepCount = 0;
    for (const u of this.units) {
      if (!u.alive || !cellKeys.has(key(u.x, u.y))) continue;
      if (this.rng() < WEB_OF_DREAMS.sleepChance) {
        u.asleep = true;
        u.sleepTurns = rollDice(WEB_OF_DREAMS.sleepDice, WEB_OF_DREAMS.sleepFaces, 0, this.rng);
        asleepCount++;
      }
    }
    this.spendTier(unit, "webOfDreams");
    this.spellKind = null;
    this.missileTargets = [];
    this.emitParticle({
      x: click.x,
      y: click.y - 0.2,
      vx: 0,
      vy: -0.3,
      life: 0,
      max: 0.5,
      size: 1.4,
      color: "#8c6cd8",
      kind: "impact",
      frame: 0,
    });
    this.tip = `${unit.name} conjurou ${WEB_OF_DREAMS.name}${asleepCount > 0 ? ` — ${asleepCount} adormeceu(ram)` : ""}.`;
    this.pushLog(`${unit.name} conjura ${WEB_OF_DREAMS.name}.`);
    sfxPlay.spell();
    this.finishAction(unit);
  }

  private castCleave(unit: Unit, cell: Point): void {
    if (!this.spellAimValid(unit, cell)) {
      this.tip = "Toque num hex vizinho.";
      sfxPlay.ui();
      return;
    }
    const tiles = cleaveHexes(unit, cell, CLEAVE.hexes, this.cols, this.rows);
    if (tiles.length === 0) {
      this.tip = "Toque num hex vizinho.";
      sfxPlay.ui();
      return;
    }
    const ids: string[] = [];
    for (const t of tiles) {
      const who = this.units.find((x) => x.alive && occupies(x, t.x, t.y));
      if (who && who.id !== unit.id && who.side !== unit.side && !ids.includes(who.id)) ids.push(who.id);
    }
    this.spendTier(unit, "cleave");
    this.spellKind = null;
    this.missileTargets = [];
    this.tip = null;
    this.mode = "locked";
    const power = cleavePower(unit.level);
    this.queue.push({
      type: "spell",
      att: unit.id,
      tiles,
      ids,
      label: CLEAVE.name,
      weaponBonusDice: power.dice,
      weaponBonusFaces: power.faces,
      weaponBonusBonus: 0,
      spellKind: "cleave",
    });
  }

  /** Paladin tier 6: a holy line down the aimed direction — the one AoE that filters allies
   * OUT of `ids` rather than in, so it can never clip one. Bonus is a flat half-MAG term
   * (weaponBonusBonus) plus a level-gated die, on top of a plain weapon hit. */
  private castDivineWrath(unit: Unit, cell: Point): void {
    if (!this.spellAimValid(unit, cell)) {
      this.tip = "Alcance ou linha inválidos.";
      sfxPlay.ui();
      return;
    }
    const tiles = this.wrathRay(unit, cell, DIVINE_WRATH.range);
    if (!tiles || tiles.length === 0) {
      this.tip = "Alcance ou linha inválidos.";
      sfxPlay.ui();
      return;
    }
    const ids: string[] = [];
    for (const t of tiles) {
      const who = this.units.find((x) => x.alive && occupies(x, t.x, t.y));
      if (who && who.id !== unit.id && who.side !== unit.side && !ids.includes(who.id)) ids.push(who.id);
    }
    this.spendTier(unit, "divineWrath");
    this.spellKind = null;
    this.missileTargets = [];
    this.tip = null;
    this.mode = "locked";
    const power = divineWrathPower(unit.level);
    this.queue.push({
      type: "spell",
      att: unit.id,
      tiles,
      ids,
      label: DIVINE_WRATH.name,
      weaponBonusDice: power.dice,
      weaponBonusFaces: power.faces,
      weaponBonusBonus: Math.floor(unit.mag / 2),
      spellKind: "divineWrath",
    });
  }

  /** Heavy Knight tier 4: an arc of `hexes` neighbors (same cleaveHexes traversal as Cleave),
   * enemies only, each knocked back a fixed 2 hexes on top of the hit — see the
   * a.spellKind === "shoulderSmash" knockback loop in stepSpell. Refuses to arm at all while
   * a shield is equipped (see startShoulderSmash), so no equipment check needed here. */
  private castShoulderSmash(unit: Unit, cell: Point): void {
    if (!this.spellAimValid(unit, cell)) {
      this.tip = "Toque num hex vizinho.";
      sfxPlay.ui();
      return;
    }
    const power = shoulderSmashPower(unit.level);
    const tiles = cleaveHexes(unit, cell, power.hexes, this.cols, this.rows);
    if (tiles.length === 0) {
      this.tip = "Toque num hex vizinho.";
      sfxPlay.ui();
      return;
    }
    const ids: string[] = [];
    for (const t of tiles) {
      const who = this.units.find((x) => x.alive && occupies(x, t.x, t.y));
      if (who && who.id !== unit.id && who.side !== unit.side && !ids.includes(who.id)) ids.push(who.id);
    }
    this.spendTier(unit, "shoulderSmash");
    this.spellKind = null;
    this.missileTargets = [];
    this.tip = null;
    this.mode = "locked";
    this.queue.push({
      type: "spell",
      att: unit.id,
      tiles,
      ids,
      label: SHOULDER_SMASH.name,
      weaponBonusDice: power.dice,
      weaponBonusFaces: power.faces,
      weaponBonusBonus: 0,
      spellKind: "shoulderSmash",
    });
  }

  /** Heavy Knight tier 6: the same aimed line as Divine Wrath, but `ids` keeps EVERY unit in
   * the line except the caster themselves — allies included — which is the one thing that
   * tells it apart from Divine Wrath's ally-proof line. */
  private castStampede(unit: Unit, cell: Point): void {
    if (!this.spellAimValid(unit, cell)) {
      this.tip = "Alcance ou linha inválidos.";
      sfxPlay.ui();
      return;
    }
    const tiles = this.wrathRay(unit, cell, STAMPEDE.range);
    if (!tiles || tiles.length === 0) {
      this.tip = "Alcance ou linha inválidos.";
      sfxPlay.ui();
      return;
    }
    const ids: string[] = [];
    for (const t of tiles) {
      const who = this.units.find((x) => x.alive && occupies(x, t.x, t.y));
      if (who && who.id !== unit.id && !ids.includes(who.id)) ids.push(who.id);
    }
    this.spendTier(unit, "stampede");
    this.spellKind = null;
    this.missileTargets = [];
    this.tip = null;
    this.mode = "locked";
    const power = stampedePower(unit.level);
    this.queue.push({
      type: "spell",
      att: unit.id,
      tiles,
      ids,
      label: STAMPEDE.name,
      weaponBonusDice: power.dice,
      weaponBonusFaces: power.faces,
      weaponBonusBonus: 0,
      spellKind: "stampede",
    });
  }

  /** Arms a potion: the next tap on self or an adjacent ally (see confirmPotionAt) applies
   * it and spends the actor's turn. Self is always in range (distance 0), so this covers
   * the old instant self-drink too — it just now takes the one confirming tap every other
   * targeted action already asks for. */
  usePotion(kind: PotionId): void {
    const u = this.units.find((x) => x.id === this.selectedId);
    if (!u || u.side !== "player" || !u.alive) return;
    if (this.mode !== "awaitAction" && this.mode !== "selected" && this.mode !== "awaitAttack" && this.mode !== "awaitSpell")
      return;
    if (this.phase !== "player" || this.result) return;
    if (u.bag[kind] <= 0) return;
    this.mode = "awaitPotion";
    this.potionAim = kind;
    this.tip = `${potionLabel(kind)}: toque em você ou num aliado adjacente. Não gasta ação.`;
    sfxPlay.ui();
  }

  /** Whether `cell` is a legal potion target for `actor`: an alive ally on their own hex or
   * one hex away — the "1 de radius" a potion reaches, per direct instruction. */
  private validPotionTarget(actor: Unit, cell: Point): Unit | null {
    const target = this.units.find((x) => x.alive && x.side === "player" && x.x === cell.x && x.y === cell.y);
    if (!target) return null;
    if (target.id === actor.id) return target;
    return hexNeighbors(actor.x, actor.y).some((n) => n.x === cell.x && n.y === cell.y) ? target : null;
  }

  /** The tap that resolves an armed potion (see usePotion/handleCell's awaitPotion branch). */
  private confirmPotionAt(actor: Unit, cell: Point): void {
    const kind = this.potionAim;
    if (!kind) return;
    const target = this.validPotionTarget(actor, cell);
    if (!target) {
      this.tip = "Alvo inválido — só você ou um aliado adjacente.";
      sfxPlay.ui();
      return;
    }
    this.mode = "awaitAction";
    this.potionAim = null;
    this.applyPotion(actor, target, kind);
  }

  /** The potion's actual effect on `target`, spent from `actor`'s bag and ending their turn
   * — actor and target are the same unit for a self-drink, or actor hands it to an adjacent
   * ally (see confirmPotionAt/validPotionTarget). */
  private applyPotion(actor: Unit, target: Unit, kind: PotionId): void {
    const def = POTIONS[kind];
    if (def.effect === "disease") {
      if (!target.diseased && !target.poisoned) {
        this.tip = `${def.name} · ${target.name} não está doente.`;
        sfxPlay.ui();
        return;
      }
      actor.bag[kind] -= 1;
      this.curePlayerDisease(target);
      actor.x = Math.round(actor.drawX);
      actor.y = Math.round(actor.drawY);
      this.tip = `${def.name} · ${target.name} curado(a) da doença.`;
      this.emitBeneficialGlow(target);
      this.mode = "awaitAction";
      sfxPlay.ui();
      return;
    }
    if (def.effect === "mana") {
      const restore = def.manaRestore ?? 0;
      let restored = 0;
      for (let t = 1; t <= 10; t++) {
        const tk = tierKey(t as SpellTier);
        const cap = tierUses(target.classId, t as SpellTier, target.level);
        if (cap <= 0) continue;
        const next = Math.min(cap, target.spells[tk] + restore);
        restored += next - target.spells[tk];
        target.spells[tk] = next;
      }
      if (restored <= 0) {
        this.tip = `${def.name} · magias de ${target.name} já estão no máximo.`;
        sfxPlay.ui();
        return;
      }
      actor.bag[kind] -= 1;
      actor.x = Math.round(actor.drawX);
      actor.y = Math.round(actor.drawY);
      this.emitParticle({
        x: target.drawX,
        y: target.drawY - 0.35,
        vx: 0,
        vy: -0.18,
        life: 0,
        max: 2,
        size: 1,
        color: "#a08cd8",
        text: `+${restored}`,
        kind: "text",
        frame: 0,
      });
      this.tip = `${def.name} · +${restored} usos de magia (${target.name})`;
      this.emitBeneficialGlow(target);
      this.mode = "awaitAction";
      sfxPlay.ui();
      return;
    }
    if (target.hp >= target.maxHp) {
      this.tip = `${target.name} já está com HP cheio.`;
      sfxPlay.ui();
      return;
    }
    const heal = rollPotion(kind, this.rng);
    const gained = Math.min(heal, target.maxHp - target.hp);
    target.hp += gained;
    this.gainExp(actor, target.level, gained);
    actor.bag[kind] -= 1;
    actor.x = Math.round(actor.drawX);
    actor.y = Math.round(actor.drawY);
    this.emitParticle({
      x: target.drawX,
      y: target.drawY - 0.35,
      vx: 0,
      vy: -0.18,
      life: 0,
      max: 2,
      size: 1,
      color: "#d8ead2",
      text: `+${gained}`,
      kind: "text",
      frame: 0,
    });
    this.tip = `${potionLabel(kind)} · +${gained} HP (${target.name})`;
    this.emitBeneficialGlow(target);
    this.mode = "awaitAction";
    sfxPlay.ui();
  }

  /** Ground a chest sits on — the neighboring floor, never the grass hex in chest001. */
  private visualFloorAt(x: number, y: number): TerrainId {
    const floor: TerrainId[] = ["nave", "plains", "ruins", "woods", "hill"];
    const counts = new Map<TerrainId, number>();
    for (const n of hexNeighbors(x, y)) {
      if (!inBounds(n.x, n.y, this.cols, this.rows)) continue;
      const t = tileAt(this.tiles, this.cols, n.x, n.y);
      if (floor.includes(t)) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    if (counts.has("nave")) return "nave";
    if (counts.size) {
      return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    }
    return this.tiles.includes("nave") ? "nave" : "plains";
  }

  /** First adjacent locked chest/door around a unit's own tile, or null if none. */
  private adjacentLock(u: Unit): Point | null {
    for (const p of hexNeighbors(u.x, u.y)) {
      if (!inBounds(p.x, p.y, this.cols, this.rows)) continue;
      const t = tileAt(this.tiles, this.cols, p.x, p.y);
      if (t === "chest" || t === "door") return p;
    }
    return null;
  }

  /** Removes one found-but-unclaimed weapon/item from this battle's loot list, because it
   * has just been equipped and written into the save directly. Without this the victory
   * fold would credit the same drop a second time. */
  claimLoot(kind: "weapon" | "equipment", id: string): void {
    const list = kind === "weapon" ? this.lootWeapons : this.lootEquipment;
    const i = list.indexOf(id);
    if (i >= 0) list.splice(i, 1);
  }

  /** Recomputes whatever worn gear contributes, after a slot changed mid-battle.
   *
   * Only DEF is applied; gearStatBonus already returns hp/atk/mag/res/mov too, so adding
   * one is a line here and the matching line in spawnUnit. Kept as its own step rather
   * than folded into the equip methods so both entry points stay in sync. */
  private reapplyGear(u: Unit): void {
    const base = statsFor(u.classId, u.level);
    const bonus = gearStatBonus(Object.values(u.gear));
    u.def = base.def + bonus.def;
  }

  /** Swaps a unit's main-hand weapon mid-battle.
   *
   * Changing gear is free and unlimited: it costs neither the turn's action nor its
   * movement, happens in any order around them, and can repeat until the turn is passed.
   * So this deliberately does not check `acted` and never calls finishAction — unlike
   * opening a chest, which does spend the action.
   *
   * Range is a weapon property, so it moves with the weapon; damage is rolled from
   * `weaponId` at attack time and follows on its own. */
  equipWeaponOn(unitId: string, weaponId: string, enh: number): boolean {
    const u = this.units.find((x) => x.id === unitId);
    if (!u || u.side !== "player" || !u.alive) return false;
    if (this.phase !== "player" || this.result) return false;
    const def = WEAPONS[weaponId];
    if (!def) return false;

    u.weaponId = weaponId;
    u.weaponEnh = Math.max(0, Math.min(WEAPON_MAX_ENH, Math.floor(enh)));
    u.minRange = def.minRange;
    u.maxRange = def.maxRange;
    // Two hands on the weapon leaves none for an off-hand item — the same rule spawnUnit
    // applies at the start of a battle, enforced again when the weapon changes mid-fight.
    if (def.twoHanded && u.offHandId) {
      u.gear.offHand = undefined;
      u.offHandId = null;
    }
    this.reapplyGear(u);
    this.tip = `${u.name} equipou ${def.name}${u.weaponEnh > 0 ? ` +${u.weaponEnh}` : ""}.`;
    this.pushLog(this.tip);
    sfxPlay.ui();
    return true;
  }

  /** Swaps one worn equipment slot mid-battle — free, like the main hand above. Passing
   * null empties the slot. */
  equipItemOn(unitId: string, slot: EquipSlot, itemId: string | null): boolean {
    const u = this.units.find((x) => x.id === unitId);
    if (!u || u.side !== "player" || !u.alive) return false;
    if (this.phase !== "player" || this.result) return false;
    const item = itemId ? EQUIPMENT[itemId] : null;
    if (itemId && (!item || item.slot !== slot)) return false;
    if (slot === "offHand" && itemId && offHandBlocked(u.weaponId)) return false;

    if (itemId) u.gear[slot] = itemId;
    else delete u.gear[slot];
    if (slot === "offHand") u.offHandId = itemId;
    this.reapplyGear(u);

    this.tip = item ? `${u.name} equipou ${item.name}.` : `${u.name} tirou o item de ${slot}.`;
    this.pushLog(this.tip);
    sfxPlay.ui();
    return true;
  }

  /** "Arrombar": spends a Gazua to open an adjacent locked chest/door. */
  useLockpick(): void {
    const u = this.units.find((x) => x.id === this.selectedId);
    if (!u || u.side !== "player" || !u.alive) return;
    if (this.mode !== "awaitAction" && this.mode !== "selected" && this.mode !== "awaitAttack" && this.mode !== "awaitSpell")
      return;
    if (this.phase !== "player" || this.result) return;
    if (u.bag.lockpick <= 0) return;
    const target = this.adjacentLock(u);
    if (!target) return;
    const i = target.y * this.cols + target.x;
    const wasChest = this.tiles[i] === "chest";
    this.tiles[i] = this.visualFloorAt(target.x, target.y);
    // decorations is readonly (the renderer holds the same array), so drop the chest's
    // decoration in place rather than rebinding the field.
    for (let d = this.decorations.length - 1; d >= 0; d--) {
      const dec = this.decorations[d];
      if (dec.id === "locked-chest" && dec.x === target.x && dec.y === target.y) this.decorations.splice(d, 1);
    }
    u.bag.lockpick -= 1;
    u.x = Math.round(u.drawX);
    u.y = Math.round(u.drawY);
    this.emitParticle({
      x: target.x,
      y: target.y,
      vx: 0,
      vy: -0.2,
      life: 0,
      max: 0.45,
      size: 1,
      color: "#d8b862",
      kind: "impact",
      frame: 0,
    });
    const found: { name: string; icon: string }[] = [];
    if (wasChest) {
      // Every chest gives Ember, a guaranteed potion (weighted so the weak tier is the
      // common case, rarer as potency climbs), and — a separate, independent roll — a
      // chance at a piece of gear, weighted so the strongest is the rarest and capped to
      // what this mission's own enemies are geared for (see missionGearLevel). A chest
      // listed in Mission.betterChests (gated behind a locked area, say) tips both those
      // numbers up — same pool and range, not a different one.
      const better = this.mission.betterChests?.some((c) => c.x === target.x && c.y === target.y) ?? false;
      const gain = (better ? CHEST_LOOT.betterEmberBase : CHEST_LOOT.emberBase) + Math.floor(this.rng() * (better ? CHEST_LOOT.betterEmberDice : CHEST_LOOT.emberDice));
      this.lootEmber += gain;
      const potionKind = weightedPotionPick(this.rng);
      if (this.givePotion(u, potionKind)) {
        found.push({ name: POTIONS[potionKind].name, icon: `/game/icons/potion-${potionKind}.png?v=ds2` });
      }
      if (this.rng() < (better ? CHEST_LOOT.betterGearChance : CHEST_LOOT.gearChance)) {
        const drop = weightedLootPick(this.rng, missionGearLevel(this.mission.index), this.ownedWeapons);
        if (drop.kind === "weapon") {
          this.ownedWeapons.add(drop.id);
          this.lootWeapons.push(drop.id);
          found.push({ name: WEAPONS[drop.id]!.name, icon: weaponIcon(drop.id) });
        } else {
          this.lootEquipment.push(drop.id);
          found.push({ name: EQUIPMENT[drop.id]!.name, icon: equipmentIcon(drop.id) });
        }
      }
      const foundNames = found.map((f) => f.name).join(", ");
      this.tip = `${u.name} arrombou o baú · +${gain} Ember · achou ${foundNames}.`;
      this.pushLog(this.tip);
      this.chestLoot = { unitName: u.name, ember: gain, items: found };
    } else {
      this.tip = `${u.name} arrombou a porta.`;
      this.pushLog(this.tip);
    }
    this.finishAction(u);
    if (wasChest) {
      sfxPlay.chest();
      if (found.length > 0) setTimeout(() => sfxPlay.loot(), 130);
    } else {
      sfxPlay.ui();
    }
  }

  /** "Fim do turno": passes whoever's turn it currently is (same as Esperar). */
  endTurn(): void {
    const active = this.activeTurnUnit();
    if (!active || active.side !== "player" || this.result) return;
    active.moved = true;
    active.x = Math.round(active.drawX);
    active.y = Math.round(active.drawY);
    active.drawX = active.x;
    active.drawY = active.y;
    this.deselect(true);
    sfxPlay.ui();
  }

  /** Dispatches control for whoever is next in this round's initiative order. */
  private beginUnitTurn(u: Unit): void {
    // takesTurns keeps neutrals out of the turn order, so whoever reaches here is on one of
    // the two sides that actually take turns.
    this.phase = u.side === "player" ? "player" : "enemy";
    u.moveBudgetUsed = 0;
    this.startOfTurnEffects(u);
    if (!u.alive) {
      this.activeUnitId = null; // force re-detection next tick, skipping the unit that just died
      return;
    }
    if (u.stunned) {
      u.stunTurns = Math.max(0, u.stunTurns - 1);
      u.stunned = u.stunTurns > 0;
      u.moved = true;
      u.acted = true;
      this.tip = `${u.name} está atordoado(a) — perde o turno.`;
      this.activeUnitId = null; // force re-detection next tick, moving on to whoever's next
      return;
    }
    // Still standing in an active web patch at the start of your own turn means another
    // sleepChance roll every turn you stay put, not just the one at cast — and a success
    // stacks another 1D4 onto whatever sleepTurns you're already carrying (even mid-nap)
    // rather than replacing it, so lingering in the web keeps digging the hole deeper.
    if (this.isWebCell(u.x, u.y) && this.rng() < WEB_OF_DREAMS.sleepChance) {
      const wasAsleep = u.asleep;
      const extra = rollDice(WEB_OF_DREAMS.sleepDice, WEB_OF_DREAMS.sleepFaces, 0, this.rng);
      u.asleep = true;
      u.sleepTurns += extra;
      this.pushLog(wasAsleep ? `${u.name} afunda mais fundo na teia (+${extra} turnos).` : `${u.name} adormece na teia.`);
    }
    if (u.asleep) {
      u.sleepTurns = Math.max(0, u.sleepTurns - 1);
      u.asleep = u.sleepTurns > 0;
      u.moved = true;
      u.acted = true;
      this.tip = `${u.name} está adormecido(a) — perde o turno.`;
      this.activeUnitId = null; // force re-detection next tick, moving on to whoever's next
      return;
    }
    // Decided once, off the unit's position right now (the start of its turn) — every
    // reach computation for the rest of this turn (repositioning included) uses this same
    // verdict instead of re-checking, see effectiveUnitForReach.
    this.turnRestrained = this.isWebCell(u.x, u.y);
    if (u.side === "player") {
      u.acted = false;
      this.selectedId = u.id;
      this.pendingFoeId = null;
      this.inspectedId = null;
      this.orig = { x: u.x, y: u.y };
    this.origMoveBudgetUsed = u.moveBudgetUsed;
      this.turnStart = { x: u.x, y: u.y };
      this.moveSpoiled = false;
      this.reach = computeReachable(this.effectiveUnitForReach(u), this.tiles, this.cols, this.rows, this.units);
      this.attackFrom = attackableEnemies(u, this.reach, this.units, this.tiles, this.cols);
      this.threat = [];
      this.mode = "selected";
      this.tip = null;
      this.centerOn(u.x, u.y);
    } else {
      this.mode = "locked";
      this.runAiFor(u);
    }
  }

  /** Everyone has had their turn this round — reset and re-roll the initiative order. */
  private startNewRound(): void {
    this.mode = "locked";
    this.selectedId = null;
    this.pendingFoeId = null;
    this.inspectedId = null;
    this.reach.clear();
    this.attackFrom.clear();
    this.threat = [];
    for (const u of this.units) {
      u.moved = false;
      u.acted = false;
    }
    for (const z of this.webZones) z.roundsLeft -= 1;
    this.webZones = this.webZones.filter((z) => z.roundsLeft > 0);
    for (const z of this.auraZones) z.roundsLeft -= 1;
    this.auraZones = this.auraZones.filter((z) => z.roundsLeft > 0);
    // Neutrals are left out, so they never get a turn and the AI never runs for them. One
    // provoked mid-round isn't in this round's order either: it wakes up and acts from the
    // next round, which reads as the beast rousing rather than instantly retaliating.
    this.turnOrder = this.sortByInitiative(this.units.filter(takesTurns));
    this.turn += 1;
    this.activeUnitId = null;
  }

  private runAiFor(next: Unit): void {
    this.smashBarricades(next);
    const reach = computeReachable(this.effectiveUnitForReach(next), this.tiles, this.cols, this.rows, this.units);
    // Every move this function queues has to be reconstructed off this unpruned pass, not
    // `reach` above — same reasoning as commitMove's walkReach: `reach` deletes any cell along
    // the way that isn't itself a legal place to stop (an ally standing there, or — the one
    // that actually bites here — a big multi-hex footprint that can't fit stopped on that cell
    // even though it can walk through it), leaving a dangling parent reference that silently
    // truncates reconstructPath to a single point short of the real destination. A size-1
    // walker rarely has any such cell on its route so this went unnoticed; a size-4 footprint
    // (Golem, Birolho, Horror, Asherah, Troll) has one on almost every route, which is why
    // only they ever looked "stuck" — the AI had already picked a real, reachable destination,
    // it just never got a real path to it.
    const walkReach = computeReachable(this.effectiveUnitForReach(next), this.tiles, this.cols, this.rows, this.units, false);
    const players = this.units.filter((u) => u.side === "player" && u.alive);

    // Cultist ("Feiticeiro") is the one enemy mage — see cultistSpellUses. Lightning outranks
    // Magic Missile whenever both are still banked, and it prefers spending a charge over its
    // plain ranged attack whenever a target is actually in range and line of sight; if not,
    // it falls through to the same move-and-attack (or chase) logic as any other enemy.
    if (next.classId === "cultist" && (next.spells.tier1 > 0 || next.spells.tier2 > 0)) {
      const spellKind: "lightning" | "magicMissile" = next.spells.tier2 > 0 ? "lightning" : "magicMissile";
      const range = spellKind === "lightning" ? LIGHTNING.range : MAGIC_MISSILE.range;
      let bestSpell: { foe: Unit; from: Point; score: number } | null = null;
      for (const cell of reach.values()) {
        for (const foe of players) {
          if (manhattan(cell, foe) > range) continue;
          if (!clearShot(cell, { x: foe.x, y: foe.y }, this.tiles, this.cols, "bolt")) continue;
          const score = (foe.maxHp - foe.hp) * 3 + (foe.hp <= 8 ? 20 : 0);
          if (!bestSpell || score > bestSpell.score) bestSpell = { foe, from: { x: cell.x, y: cell.y }, score };
        }
      }
      if (bestSpell) {
        if (bestSpell.from.x !== next.x || bestSpell.from.y !== next.y) {
          this.queue.push({ type: "move", id: next.id, path: reconstructPath(walkReach, bestSpell.from) });
        }
        this.spendTier(next, spellKind);
        const tiles = [{ x: bestSpell.foe.x, y: bestSpell.foe.y }];
        const ids = [bestSpell.foe.id];
        if (spellKind === "lightning") {
          this.queue.push({
            type: "spell",
            att: next.id,
            tiles,
            ids,
            dice: lightningDice(),
            faces: LIGHTNING.faces,
            bonus: LIGHTNING.bonus,
            label: LIGHTNING.name,
            echo: { dice: LIGHTNING.echoDice, faces: LIGHTNING.echoFaces, bonus: LIGHTNING.echoBonus },
            spellMul: LIGHTNING.mul,
            spellKind: "lightning",
          });
        } else {
          this.queue.push({
            type: "spell",
            att: next.id,
            tiles,
            ids,
            dice: MAGIC_MISSILE.dice,
            faces: MAGIC_MISSILE.faces,
            bonus: MAGIC_MISSILE.bonus,
            label: MAGIC_MISSILE.name,
            spellMul: MAGIC_MISSILE.mul,
            spellKind: "magicMissile",
          });
        }
        this.queue.push({ type: "delay", dur: 0.12 });
        return;
      }
    }

    // Birolho — see birolhoSpellUses. Lightning (once unlocked at level 10) outranks Caustic
    // Venom, which outranks its base Magic Missile: same "spend the rarest charge first"
    // priority as the cultist branch above, just three deep. Lightning and Magic Missile reuse
    // that exact single-bolt targeting; Caustic Venom is its own AoE, so instead of scoring one
    // foe it scores by how many players its splash (the same size/range as the player-facing
    // spell) would land on, aimed at whichever foe's cell catches the most / lowest-hp targets.
    if (next.classId === "birolho" && (next.spells.tier1 > 0 || next.spells.tier2 > 0 || next.spells.tier4 > 0)) {
      if (next.spells.tier2 > 0) {
        let bestBolt: { foe: Unit; from: Point; score: number } | null = null;
        for (const cell of reach.values()) {
          for (const foe of players) {
            if (manhattan(cell, foe) > LIGHTNING.range) continue;
            if (!clearShot(cell, { x: foe.x, y: foe.y }, this.tiles, this.cols, "bolt")) continue;
            const score = (foe.maxHp - foe.hp) * 3 + (foe.hp <= 8 ? 20 : 0);
            if (!bestBolt || score > bestBolt.score) bestBolt = { foe, from: { x: cell.x, y: cell.y }, score };
          }
        }
        if (bestBolt) {
          if (bestBolt.from.x !== next.x || bestBolt.from.y !== next.y) {
            this.queue.push({ type: "move", id: next.id, path: reconstructPath(walkReach, bestBolt.from) });
          }
          this.spendTier(next, "lightning");
          this.queue.push({
            type: "spell",
            att: next.id,
            tiles: [{ x: bestBolt.foe.x, y: bestBolt.foe.y }],
            ids: [bestBolt.foe.id],
            dice: lightningDice(),
            faces: LIGHTNING.faces,
            bonus: LIGHTNING.bonus,
            label: LIGHTNING.name,
            echo: { dice: LIGHTNING.echoDice, faces: LIGHTNING.echoFaces, bonus: LIGHTNING.echoBonus },
            spellMul: LIGHTNING.mul,
            spellKind: "lightning",
          });
          this.queue.push({ type: "delay", dur: 0.12 });
          return;
        }
      }
      if (next.spells.tier4 > 0) {
        let bestVenom: { at: Point; from: Point; score: number } | null = null;
        for (const cell of reach.values()) {
          for (const foe of players) {
            if (manhattan(cell, foe) > CAUSTIC_VENOM.range) continue;
            if (!clearShot(cell, { x: foe.x, y: foe.y }, this.tiles, this.cols, "bolt")) continue;
            const splash = hexAreaTiles({ x: foe.x, y: foe.y }, CAUSTIC_VENOM.size, this.cols, this.rows);
            let hits = 0;
            let score = 0;
            for (const t of splash) {
              const hit = players.find((p) => p.x === t.x && p.y === t.y);
              if (!hit) continue;
              hits += 1;
              score += (hit.maxHp - hit.hp) + (hit.hp <= 8 ? 15 : 0);
            }
            if (hits === 0) continue;
            score += hits * 10;
            if (!bestVenom || score > bestVenom.score) bestVenom = { at: { x: foe.x, y: foe.y }, from: { x: cell.x, y: cell.y }, score };
          }
        }
        if (bestVenom) {
          if (bestVenom.from.x !== next.x || bestVenom.from.y !== next.y) {
            this.queue.push({ type: "move", id: next.id, path: reconstructPath(walkReach, bestVenom.from) });
          }
          this.spendTier(next, "causticVenom");
          const tiles = hexAreaTiles(bestVenom.at, CAUSTIC_VENOM.size, this.cols, this.rows);
          const ids: string[] = [];
          for (const t of tiles) {
            const u = this.units.find((x) => x.alive && occupies(x, t.x, t.y));
            if (u && !ids.includes(u.id)) ids.push(u.id);
          }
          const center = this.units.find((x) => x.alive && occupies(x, bestVenom.at.x, bestVenom.at.y));
          this.queue.push({
            type: "spell",
            att: next.id,
            tiles,
            ids,
            dice: CAUSTIC_VENOM.splashDice,
            faces: CAUSTIC_VENOM.splashFaces,
            bonus: CAUSTIC_VENOM.splashBonus,
            centerId: center?.id,
            centerDice: CAUSTIC_VENOM.centerDice,
            centerFaces: CAUSTIC_VENOM.centerFaces,
            centerBonus: CAUSTIC_VENOM.centerBonus,
            poison: true,
            label: CAUSTIC_VENOM.name,
            spellMul: CAUSTIC_VENOM.splashMul,
            centerMul: CAUSTIC_VENOM.centerMul,
            spellKind: "causticVenom",
          });
          this.queue.push({ type: "delay", dur: 0.12 });
          return;
        }
      }
      if (next.spells.tier1 > 0) {
        let bestBolt: { foe: Unit; from: Point; score: number } | null = null;
        for (const cell of reach.values()) {
          for (const foe of players) {
            if (manhattan(cell, foe) > MAGIC_MISSILE.range) continue;
            if (!clearShot(cell, { x: foe.x, y: foe.y }, this.tiles, this.cols, "bolt")) continue;
            const score = (foe.maxHp - foe.hp) * 3 + (foe.hp <= 8 ? 20 : 0);
            if (!bestBolt || score > bestBolt.score) bestBolt = { foe, from: { x: cell.x, y: cell.y }, score };
          }
        }
        if (bestBolt) {
          if (bestBolt.from.x !== next.x || bestBolt.from.y !== next.y) {
            this.queue.push({ type: "move", id: next.id, path: reconstructPath(walkReach, bestBolt.from) });
          }
          this.spendTier(next, "magicMissile");
          this.queue.push({
            type: "spell",
            att: next.id,
            tiles: [{ x: bestBolt.foe.x, y: bestBolt.foe.y }],
            ids: [bestBolt.foe.id],
            dice: MAGIC_MISSILE.dice,
            faces: MAGIC_MISSILE.faces,
            bonus: MAGIC_MISSILE.bonus,
            label: MAGIC_MISSILE.name,
            spellMul: MAGIC_MISSILE.mul,
            spellKind: "magicMissile",
          });
          this.queue.push({ type: "delay", dur: 0.12 });
          return;
        }
      }
    }

    // Brigand ("Besteiro") is the one enemy archer — see brigandSpellUses. Piercing outranks
    // Long Shot whenever both are still banked, same priority shape as the cultist branch
    // above. Long Shot picks one target the same way; Piercing aims THROUGH a target the same
    // way castPiercing does, so it can also clip whoever else stands on that line (allies
    // included) — no side filter, matching the player-facing spell.
    if (next.classId === "brigand" && (next.spells.tier1 > 0 || next.spells.tier2 > 0)) {
      const spellKind: "piercing" | "longShot" = next.spells.tier2 > 0 ? "piercing" : "longShot";
      const longMax = next.maxRange * LONG_SHOT.rangeMul + LONG_SHOT.rangeBonus;
      let bestSpell: { foe: Unit; from: Point; score: number } | null = null;
      for (const cell of reach.values()) {
        for (const foe of players) {
          if (spellKind === "longShot") {
            const d = manhattan(cell, foe);
            if (d < next.minRange || d > longMax) continue;
            if (!clearShot(cell, { x: foe.x, y: foe.y }, this.tiles, this.cols, "arrow")) continue;
          } else {
            const line = this.piercingRay({ x: cell.x, y: cell.y }, { x: foe.x, y: foe.y });
            if (!line || !line.some((p) => p.x === foe.x && p.y === foe.y)) continue;
          }
          const score = (foe.maxHp - foe.hp) * 3 + (foe.hp <= 8 ? 20 : 0);
          if (!bestSpell || score > bestSpell.score) bestSpell = { foe, from: { x: cell.x, y: cell.y }, score };
        }
      }
      if (bestSpell) {
        if (bestSpell.from.x !== next.x || bestSpell.from.y !== next.y) {
          this.queue.push({ type: "move", id: next.id, path: reconstructPath(walkReach, bestSpell.from) });
        }
        this.spendTier(next, spellKind);
        if (spellKind === "longShot") {
          const power = longShotPower(next.level);
          this.queue.push({
            type: "spell",
            att: next.id,
            tiles: [{ x: bestSpell.foe.x, y: bestSpell.foe.y }],
            ids: [bestSpell.foe.id],
            label: LONG_SHOT.name,
            weaponBonusDice: power.dice,
            weaponBonusFaces: power.faces,
            weaponBonusBonus: 0,
            spellKind: "longShot",
          });
        } else {
          const line = this.piercingRay(bestSpell.from, { x: bestSpell.foe.x, y: bestSpell.foe.y })!;
          const ids: string[] = [];
          for (const t of line) {
            const who = this.units.find((u) => u.alive && occupies(u, t.x, t.y));
            if (who && who.id !== next.id && !ids.includes(who.id)) ids.push(who.id);
          }
          this.queue.push({ type: "spell", att: next.id, tiles: line, ids, label: PIERCING.name, dmgMul: piercingMul(next.level), spellKind: "piercing" });
        }
        this.queue.push({ type: "delay", dur: 0.12 });
        return;
      }
    }

    let best: { foe: Unit; from: Point; score: number } | null = null;
    for (const cell of reach.values()) {
      for (const foe of players) {
        if (!canHitFrom(next, cell, foe, this.tiles, this.cols)) continue;
        const terr = TERRAIN[tileAt(this.tiles, this.cols, cell.x, cell.y)];
        const score = (foe.maxHp - foe.hp) * 3 + terr.def * 2 + (foe.hp <= 8 ? 20 : 0);
        if (!best || score > best.score) best = { foe, from: { x: cell.x, y: cell.y }, score };
      }
    }
    if (best) {
      if (best.from.x !== next.x || best.from.y !== next.y) {
        this.queue.push({ type: "move", id: next.id, path: reconstructPath(walkReach, best.from) });
      }
      this.queue.push({ type: "combat", att: next.id, def: best.foe.id });
      this.queue.push({ type: "delay", dur: 0.12 });
      return;
    }
    if (players.length === 0) {
      next.moved = true;
      return;
    }
    // Real path distance (walls/pillars-aware), not raw hex distance — a straight-line
    // "closest" pick can freeze an enemy in place forever once it's on the far side of an
    // obstacle, because every actual step first reads as moving away (see
    // terrainDistanceField). Computed once per player and reused for both picking who to
    // chase and which reachable cell actually closes the gap.
    const fields = players.map((p) => ({ p, field: terrainDistanceField(p, this.tiles, this.cols, this.rows) }));
    let nearest = fields[0]!;
    for (const f of fields) {
      const dCur = f.field.get(key(next.x, next.y)) ?? Infinity;
      const dBest = nearest.field.get(key(next.x, next.y)) ?? Infinity;
      if (dCur < dBest) nearest = f;
    }
    let closest: Point | null = null;
    let dist = Infinity;
    for (const cell of reach.values()) {
      const d = nearest.field.get(key(cell.x, cell.y)) ?? Infinity;
      if (d < dist) {
        dist = d;
        closest = { x: cell.x, y: cell.y };
      }
    }
    if (closest && (closest.x !== next.x || closest.y !== next.y)) {
      this.queue.push({ type: "move", id: next.id, path: reconstructPath(walkReach, closest) });
    }
    next.moved = true;
    this.queue.push({ type: "delay", dur: 0.08 });
  }

  pointerMove(cssX: number, cssY: number): void {
    const cell = this.cellAt(cssX, cssY);
    this.hover = cell;
  }

  pointerDown(cssX: number, cssY: number, via: "click" | "tap" = "click"): void {
    if (this.result || this.mode === "locked") return;
    const cell = this.cellAt(cssX, cssY);
    if (!cell) {
      if (this.mode === "selected" || this.mode === "awaitAction") this.deselect();
      return;
    }
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    const selected = this.units.find((u) => u.id === this.selectedId);
    const same =
      this.lastClickCell && this.lastClickCell.x === cell.x && this.lastClickCell.y === cell.y && now - this.lastClickAt < 340;
    this.lastClickAt = now;
    this.lastClickCell = cell;
    if (same && (this.mode === "awaitAction" || this.mode === "selected") && selected && occupies(selected, cell.x, cell.y)) {
      this.wait();
      const next = this.units.find((u) => u.side === "player" && u.alive && !u.moved);
      if (next) this.select(next);
      return;
    }
    this.cursor = cell;
    this.ensureVisible(cell.x, cell.y);
    this.handleCell(cell, via);
  }

  keyDown(code: string): void {
    if (this.result || this.mode === "locked") {
      if (code === "KeyE") this.endTurn();
      return;
    }
    if (code === "Enter" || code === "Space") this.handleCell(this.cursor, "click");
    if (code === "Escape") this.cancel();
    if (code === "KeyE") this.endTurn();
    if (code === "KeyZ") this.wait();
  }

  private handleCell(cell: Point, via: "click" | "tap" = "click"): void {
    const occ = occupancy(this.units);
    const here = occ.get(key(cell.x, cell.y));
    const selected = this.units.find((u) => u.id === this.selectedId);

    if (this.mode === "awaitPotion" && selected) {
      this.hover = cell;
      this.confirmPotionAt(selected, cell);
      return;
    }

    if (this.mode === "awaitSpell" && selected) {
      this.hover = cell;
      if (!this.spellAimValid(selected, cell)) {
        this.tip =
          this.spellKind === "piercing"
            ? "Escolha uma reta da colmeia."
            : this.spellKind === "cleave"
              ? "Toque num hex vizinho."
              : this.spellKind === "longShot"
                ? "Alvo fora de alcance."
                : "Alvo inválido.";
        this.spellArmed = false;
        sfxPlay.ui();
        return;
      }
      if (
        via === "tap" &&
        (!this.spellArmed || !this.spellAim || this.spellAim.x !== cell.x || this.spellAim.y !== cell.y)
      ) {
        this.spellArmed = true;
        this.spellAim = cell;
        this.tip = "Toque de novo ou Lançar.";
        sfxPlay.ui();
        return;
      }
      this.confirmSpell();
      return;
    }

    if (here && here.side === "player" && here.alive && !here.moved && this.phase === "player") {
      if (selected && this.mode === "awaitAction") {
        if (here.id === selected.id) return;
        this.deselect();
      }
      this.select(here);
      return;
    }
    if (here && attackableByPlayer(here)) {
      if (selected && !selected.acted && this.mode === "awaitOffHand") {
        if (canHitFrom(selected, selected, here, this.tiles, this.cols)) {
          this.commitOffHandAction(selected, here, { x: selected.x, y: selected.y });
          return;
        }
        this.tip = "Fora de alcance.";
        sfxPlay.ui();
        this.inspect(here);
        return;
      }
      if (selected && !selected.acted && (this.mode === "awaitAttack" || this.mode === "awaitAction" || this.mode === "selected")) {
        if (this.mode === "selected") {
          const from = this.attackFrom.get(here.id);
          if (from && (from.x !== selected.x || from.y !== selected.y)) {
            this.commitMove(selected, from, () => {
              const u = this.units.find((x) => x.id === selected.id);
              const f = this.units.find((x) => x.id === here.id);
              if (u && f && u.alive && f.alive && canHitFrom(u, u, f, this.tiles, this.cols)) {
                this.commitAttack(u, f, { x: u.x, y: u.y });
              }
            });
            return;
          }
        }
        if (canHitFrom(selected, selected, here, this.tiles, this.cols)) {
          this.commitAttack(selected, here, { x: selected.x, y: selected.y });
          return;
        }
        if (shotKind(selected) && inWeaponRange(selected.x, selected.y, here.x, here.y, selected.minRange, effectiveMaxRange(selected, tileAt(this.tiles, this.cols, selected.x, selected.y)))) {
          this.tip = TERRAIN[tileAt(this.tiles, this.cols, here.x, here.y)].id === "barricade"
            ? "Barricada bloqueia o projétil."
            : "O terreno alto corta a flecha.";
          sfxPlay.ui();
          this.inspect(here);
          return;
        }
      }
      // Clicking the enemy already under inspection again closes it, same as clicking empty
      // ground deselects a selected hero, instead of just re-inspecting a no-op.
      if (this.inspectedId === here.id && !selected) {
        this.inspectedId = null;
        this.threat = [];
        this.tip = null;
        return;
      }
      this.inspect(here);
      return;
    }
    if (selected && this.mode === "selected") {
      if (this.reach.has(key(cell.x, cell.y)) && !here) {
        this.commitMove(selected, cell);
        return;
      }
    }
    if (selected && this.mode === "awaitAction" && !here) {
      this.deselect();
    }
    if (!here && this.inspectedId && !selected) {
      this.inspectedId = null;
      this.threat = [];
      this.tip = null;
    }
  }

  private commitMove(unit: Unit, to: Point, after?: () => void): void {
    // this.reach is anchored at the unit's live position (see effectiveUnitForReach) — right
    // for validating `to` and reading its cost, but it's still the default pruneStopPoints
    // pass, which deletes any cell along the way that isn't itself a legal place to stop
    // (e.g. one an ally occupies), leaving a dangling parent reference that would silently
    // truncate reconstructPath before it reaches `to`. The walk only needs SOME valid route
    // through, so it gets its own unpruned pass off the same anchor.
    const walkReach = computeReachable(this.effectiveUnitForReach(unit), this.tiles, this.cols, this.rows, this.units, false);
    const path = reconstructPath(walkReach, to);
    if (path.length === 0) path.push({ x: unit.x, y: unit.y }, to);
    // Cost of THIS hop, from wherever the unit currently stands — this.reach is anchored
    // there too, so this is already a per-hop delta, not a cumulative total.
    const stepCost = this.reach.get(key(to.x, to.y))?.cost ?? 0;
    this.mode = "locked";
    this.queue.push({ type: "move", id: unit.id, path });
    this.queue.push({ type: "delay", dur: 0.02 });
    this.onNextIdle = () => {
      unit.x = Math.round(to.x);
      unit.y = Math.round(to.y);
      unit.drawX = unit.x;
      unit.drawY = unit.y;
      // Accumulates: movement is spent as the unit walks, hop by hop, never refunded by a
      // later move — only undoMove (a full rewind to turnStart) reverts spent movement.
      unit.moveBudgetUsed += stepCost;
      // Having acted doesn't make this move the last one — it comes out of the same pool as
      // any other. The turn ends when the pool runs dry (with the action already spent),
      // never merely because the unit acted first.
      if (unit.acted && unit.mov - unit.moveBudgetUsed <= 0) {
        unit.moved = true;
        this.selectedId = null;
        this.pendingFoeId = null;
        this.inspectedId = null;
        this.threat = [];
        this.reach.clear();
        this.attackFrom.clear();
        this.orig = null;
        this.turnStart = null;
        this.mode = "idle";
        return;
      }
      // Not acted yet — movement isn't a one-shot: the unit stays "selected" with a fresh
      // reach from its new spot, so the player can keep repositioning freely until they
      // either use a skill (see the u.acted branch above, unchanged) or end the turn.
      this.selectedId = unit.id;
      this.mode = "selected";
      this.reach = computeReachable(this.effectiveUnitForReach(unit), this.tiles, this.cols, this.rows, this.units);
      this.attackFrom = attackableEnemies(unit, this.reach, this.units, this.tiles, this.cols);
      after?.();
    };
  }

  private commitAttack(unit: Unit, foe: Unit, from: Point): void {
    const at = { x: Math.round(from.x), y: Math.round(from.y) };
    if (!canHitFrom(unit, at, foe, this.tiles, this.cols)) {
      this.mode = "awaitAction";
      this.tip = "Fora de alcance.";
      return;
    }
    this.mode = "locked";
    if (at.x !== unit.x || at.y !== unit.y) {
      const path = reconstructPath(this.reach, at);
      if (path.length > 1) this.queue.push({ type: "move", id: unit.id, path });
    }
    this.queue.push({ type: "combat", att: unit.id, def: foe.id });
  }

  /** Off-hand attack (a light weapon in the offHand slot) or Shield Bash (a shield
   * there) — whichever EQUIPMENT[unit.offHandId].kind resolves to. Reuses the same
   * "already in range from here" check as a normal Atacar; no move-then-act chaining. */
  private commitOffHandAction(unit: Unit, foe: Unit, from: Point): void {
    const item = unit.offHandId ? EQUIPMENT[unit.offHandId] : null;
    if (!item || !canHitFrom(unit, from, foe, this.tiles, this.cols)) {
      this.mode = "awaitAction";
      this.tip = "Fora de alcance.";
      return;
    }
    this.mode = "locked";
    if (item.kind === "shield") {
      this.queue.push({ type: "combat", att: unit.id, def: foe.id, dmgMul: item.dmgMul ?? 0.75, stunChance: 0.7 });
    } else {
      this.queue.push({
        type: "combat",
        att: unit.id,
        def: foe.id,
        customDice: { dice: item.dice ?? 1, faces: item.faces ?? 4, bonus: item.bonus ?? 0 },
      });
    }
  }

  private castFireball(unit: Unit, click: Point): void {
    const origin = fireballOrigin(click, this.cols, this.rows);
    const tiles = fireballTiles(origin, this.cols, this.rows);
    const ids: string[] = [];
    for (const t of tiles) {
      const u = this.units.find((x) => x.alive && occupies(x, t.x, t.y));
      if (u && !ids.includes(u.id)) ids.push(u.id);
    }
    this.spendTier(unit, "fireball");
    this.spellKind = null;
    this.missileTargets = [];
    this.tip = null;
    this.mode = "locked";
    const power = fireballPower();
    this.queue.push({
      type: "spell",
      att: unit.id,
      tiles,
      ids,
      dice: power.dice,
      faces: power.faces,
      bonus: power.bonus,
      label: FIREBALL.name,
      spellMul: FIREBALL.mul,
      spellKind: "fireball",
      projectileTo: origin,
    });
  }

  private castCausticVenom(unit: Unit, click: Point): void {
    const origin = fireballOrigin(click, this.cols, this.rows);
    // Its own radius rather than Fireball's: fireballTiles hardcodes FIREBALL.size, which
    // is why venom could not be widened without widening Fireball with it.
    const tiles = hexAreaTiles(origin, CAUSTIC_VENOM.size, this.cols, this.rows);
    const ids: string[] = [];
    for (const t of tiles) {
      const u = this.units.find((x) => x.alive && occupies(x, t.x, t.y));
      if (u && !ids.includes(u.id)) ids.push(u.id);
    }
    const center = this.units.find((x) => x.alive && occupies(x, origin.x, origin.y));
    this.spendTier(unit, "causticVenom");
    this.spellKind = null;
    this.missileTargets = [];
    this.tip = null;
    this.mode = "locked";
    this.queue.push({
      type: "spell",
      att: unit.id,
      tiles,
      ids,
      dice: CAUSTIC_VENOM.splashDice,
      faces: CAUSTIC_VENOM.splashFaces,
      bonus: CAUSTIC_VENOM.splashBonus,
      centerId: center?.id,
      centerDice: CAUSTIC_VENOM.centerDice,
      centerFaces: CAUSTIC_VENOM.centerFaces,
      centerBonus: CAUSTIC_VENOM.centerBonus,
      poison: true,
      label: CAUSTIC_VENOM.name,
      spellMul: CAUSTIC_VENOM.splashMul,
      centerMul: CAUSTIC_VENOM.centerMul,
      spellKind: "causticVenom",
      projectileTo: origin,
    });
  }

  panBy(dx: number, dy: number): void {
    this.camX += dx;
    this.camY += dy;
    this.clampCam();
  }

  /** Preserve an editor preview camera while its draft mission is rebuilt. */
  cameraPosition(): { x: number; y: number } {
    return { x: this.camX, y: this.camY };
  }

  restoreCamera(position: { x: number; y: number }): void {
    this.camX = position.x;
    this.camY = position.y;
    this.clampCam();
  }

  /** Editor-only overlay: show the footprint of the decoration brush in the live preview. */
  drawDecorationHighlight(ctx: CanvasRenderingContext2D, decorationId: string): void {
    const tile = this.layout.tile;
    ctx.save();
    ctx.lineWidth = Math.max(2, tile * 0.075);
    ctx.strokeStyle = "rgba(255, 207, 82, 0.98)";
    ctx.fillStyle = "rgba(255, 190, 46, 0.14)";
    ctx.shadowColor = "rgba(255, 174, 35, 0.95)";
    ctx.shadowBlur = Math.max(7, tile * 0.32);
    for (const placement of this.decorations) {
      if (placement.id !== decorationId) continue;
      for (const cell of placedFootprint(placement)) {
        const { cx, cy } = this.hexCenter(placement.x + cell.dx, placement.y + cell.dy);
        this.hexPath(ctx, cx, cy, tile * 0.91);
        ctx.fill();
        ctx.stroke();
      }
    }
    ctx.restore();
  }
  setZoom(level: number): void {
    const next = Math.max(0, Math.min(ZOOM_RADII.length - 1, Math.round(level)));
    if (next === this.zoom) return;
    const old = ZOOM_RADII[this.zoom]!;
    const neu = ZOOM_RADII[next]!;
    const k = neu / old;
    this.camX = (this.camX + this.viewW / 2) * k - this.viewW / 2;
    this.camY = (this.camY + this.viewH / 2) * k - this.viewH / 2;
    this.zoom = next;
    this.clampCam();
    this.emit();
  }

  setSpeed(mode: "normal" | "fast"): void {
    this.speedMode = mode;
    this.emit();
  }

  cycleZoom(dir: number): void {
    this.setZoom(this.zoom + (dir < 0 ? -1 : 1));
  }

  private boardPad(tile: number): number {
    return tile * 2.4;
  }

  private boardSize(tile: number): { w: number; h: number } {
    const sqrt3 = Math.sqrt(3);
    return {
      w: tile * sqrt3 * (this.cols + 0.5),
      h: tile * (1.5 * (this.rows - 1) + 2) + this.boardPad(tile),
    };
  }

  private clampCam(): void {
    const tile = ZOOM_RADII[this.zoom]!;
    const { w, h } = this.boardSize(tile);
    const maxX = Math.max(0, w - this.viewW);
    const maxY = Math.max(0, h - this.viewH);
    this.camX = Math.min(maxX, Math.max(0, this.camX));
    this.camY = Math.min(maxY, Math.max(0, this.camY));
  }

  ensureVisible(col: number, row: number): void {
    const { cx, cy } = this.hexCenter(col, row);
    const tile = ZOOM_RADII[this.zoom]!;
    const m = 64;
    const top = this.boardPad(tile);
    if (cx < m) this.camX += cx - m;
    if (cy < top) this.camY += cy - top;
    if (cx > this.viewW - m) this.camX += cx - (this.viewW - m);
    if (cy > this.viewH - m) this.camY += cy - (this.viewH - m);
    this.clampCam();
  }

  private focusPlayers(): void {
    const u = this.units.find((x) => x.side === "player" && x.alive) ?? this.units[0];
    if (!u) return;
    this.centerOn(u.x, u.y);
  }

  private centerOn(col: number, row: number): void {
    const { cx, cy } = this.hexCenter(col, row);
    this.camX += cx - this.viewW / 2;
    this.camY += cy - this.viewH / 2;
    this.clampCam();
  }

  /** Resolve a canvas coordinate to a board cell without changing game state. */
  cellAt(cssX: number, cssY: number): Point | null {
    const { ox, oy, tile } = this.layout;
    const sqrt3 = Math.sqrt(3);
    const x = cssX - ox - tile * sqrt3 * 0.5;
    const y = cssY - oy - this.boardPad(tile) - tile;
    const q = ((sqrt3 / 3) * x - (1 / 3) * y) / tile;
    const r = ((2 / 3) * y) / tile;
    const c = cubeRound(q, r, -q - r);
    const col = c.q + (c.r - (c.r & 1)) / 2;
    const row = c.r;
    if (col < 0 || row < 0 || col >= this.cols || row >= this.rows) return null;
    return { x: col, y: row };
  }

  private hexCenter(col: number, row: number): { cx: number; cy: number } {
    const { ox, oy, tile } = this.layout;
    const sqrt3 = Math.sqrt(3);
    return {
      cx: ox + tile * sqrt3 * (col + 0.5 * (row & 1) + 0.5),
      cy: oy + this.boardPad(tile) + tile * (1.5 * row + 1),
    };
  }

  private hexPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number): void {
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 180) * (60 * i - 30);
      const x = cx + size * Math.cos(a);
      const y = cy + size * Math.sin(a);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  /** Whether a facing's own drawing exists, kicking off its load the first time it is
   * asked for. A file that 404s settles as "no" and the prop keeps the base drawing —
   * every prop starts with only its east art, so this is the normal answer, not a fault. */
  private decorArtReady(file: string): boolean {
    const known = this.art.decorations[file];
    if (known) return known.naturalWidth > 0;
    const img = new Image();
    img.src = decorationImage(file);
    this.art.decorations[file] = img;
    return false;
  }

  /** Multi-hex terrain props draw as one image over their whole footprint's bounding box,
   * not hex-clipped like regular tiles — they don't need to fill the exact hex shape. */
  private drawDecorations(ctx: CanvasRenderingContext2D, tile: number, cssW: number, cssH: number): void {
    const SQRT3 = Math.sqrt(3);
    for (const p of this.decorations) {
      const def = DECORATIONS[p.id];
      let img = this.art.decorations[p.id];
      if ((!img || !img.naturalWidth) && def) {
        img = this.art.decorations[p.id] ?? new Image();
        if (!img.src) img.src = decorationImage(p.id);
        this.art.decorations[p.id] = img;
      }
      if (!def || !img) continue;
      let minDx = 0;
      let maxDx = 0;
      let minDy = 0;
      let maxDy = 0;
      let sumCx = 0;
      let sumCy = 0;
      // The shape sets how big the image is drawn; the turn is applied to the canvas
      // below, so the box is measured unturned and carried around with it. The centre,
      // though, has to be where the prop actually sits once turned.
      for (const { dx, dy } of def.footprint) {
        minDx = Math.min(minDx, dx);
        maxDx = Math.max(maxDx, dx);
        minDy = Math.min(minDy, dy);
        maxDy = Math.max(maxDy, dy);
      }
      for (const { dx, dy } of placedFootprint(p)) {
        const c = this.hexCenter(p.x + dx, p.y + dy);
        sumCx += c.cx;
        sumCy += c.cy;
      }
      const n = def.footprint.length;
      const cx = sumCx / n;
      const cy = sumCy / n;
      if (cx < -tile * 4 || cy < -tile * 4 || cx > cssW + tile * 4 || cy > cssH + tile * 4) continue;
      const one = def.footprint.length === 1;
      const item = p.id === "locked-chest";
      const tree = p.id === "dead-tree";
      const log = p.id === "fallen-log";
      const wall = p.id === "barricade" || p.id === "barricade-2";
      const house = p.id === "small-house" || p.id === "stone-hut";
      const w = tree
        ? tile * 1.28
        : log
          ? tile * SQRT3 * 2.05
          : wall
            ? tile * 1.42
            : house
              ? tile * 1.45
              : item
                ? tile * 0.92
                : one
                  ? tile * 1.55
                  : tile * SQRT3 * (maxDx - minDx + 1.7);
      const h = tree
        ? tile * 2.55
        : log
          ? tile * 0.82
          : wall
            ? tile * 1.18
            : house
              ? tile * 1.58
              : item
                ? tile * 0.72
                : one
                  ? tile * 1.65
                  : tile * (1.5 * (maxDy - minDy) + 2.3);
      const dy = tree ? -tile * 0.55 : wall ? -tile * 0.12 : house ? -tile * 0.28 : item ? tile * 0.08 : 0;
      // Facing art if the prop has it, the way isometric games do it: a drawing per facing,
      // mirrored to cover the opposite one. Only when a facing has no drawing do we fall
      // back to turning the bitmap, which tilts rather than faces and is a placeholder.
      const facing = decorationFacing(p.id, p.rot ?? 0, (file) => this.decorArtReady(file));
      const art = facing.own ? (this.art.decorations[facing.file] ?? img) : img;
      if (facing.step === 0) {
        ctx.drawImage(art, cx - w / 2, cy - h / 2 + dy, w, h);
      } else if (facing.own) {
        ctx.save();
        ctx.translate(cx, cy + dy);
        if (facing.mirror) ctx.scale(-1, 1);
        ctx.drawImage(art, -w / 2, -h / 2, w, h);
        ctx.restore();
      } else {
        ctx.save();
        ctx.translate(cx, cy + dy);
        ctx.rotate((facing.step * Math.PI) / 3);
        ctx.drawImage(art, -w / 2, -h / 2, w, h);
        ctx.restore();
      }
    }
  }

  private footprintCentroid(
    x: number,
    y: number,
    size: number,
    footprintW?: number,
    footprintOffsets?: { dx: number; dy: number }[],
  ): { cx: number; cy: number } {
    // Units with an extended footprint anchor on their front tile(s) only — averaging in the
    // cells behind them would drag the sprite's feet upward, off the tile the player actually
    // sees them standing on.
    const cells =
      size >= 4 || footprintOffsets ? footprintFrontRow({ x, y, footprintOffsets }, footprintW ?? 2) : footprint({ x, y, size });
    let cx = 0;
    let cy = 0;
    for (const p of cells) {
      const c = this.hexCenter(p.x, p.y);
      cx += c.cx;
      cy += c.cy;
    }
    const n = Math.max(1, cells.length);
    return { cx: cx / n, cy: cy / n };
  }

  private unitPixel(u: Unit): { cx: number; cy: number } {
    if (this.active && this.active.type === "move" && this.active.id === u.id) {
      const a = this.active;
      const from = a.path[a.i];
      const to = a.path[a.i + 1];
      if (from && to) {
        const dur = 0.12;
        const k = easeOut(Math.min(1, a.t / dur));
        const A = this.footprintCentroid(from.x, from.y, u.size, u.footprintW, u.footprintOffsets);
        const B = this.footprintCentroid(to.x, to.y, u.size, u.footprintW, u.footprintOffsets);
        return { cx: A.cx + (B.cx - A.cx) * k, cy: A.cy + (B.cy - A.cy) * k };
      }
    }
    return this.footprintCentroid(u.x, u.y, u.size, u.footprintW, u.footprintOffsets);
  }

  /** Walk-cycle frame for a unit mid-move, driven by how far along its path it actually is.
   *
   * Not by the global bob clock, which is what a walk cut got before and why none of them
   * played: a hex step lasts 0.22s (0.12 in fast mode) and bob runs at 0.58x for anything
   * size 4 or over, so a golem advanced barely half a frame per hex — measured, three of its
   * eight frames across three hexes, starting on whichever one bob's random spawn value
   * landed on. Tied to the path instead, every walk starts at frame 0 and runs a full loop
   * every two hexes, at the same pace for a golem as for a familiar. */
  private walkFrame(u: Unit, n: number): number {
    const a = this.active;
    if (n <= 1 || !a || a.type !== "move" || a.id !== u.id) return 0;
    const dur = this.speedMode === "fast" ? 0.12 : 0.22;
    const steps = a.i + Math.min(1, a.t / dur);
    return Math.floor(steps * (n / 2)) % n;
  }

  private idleFrame(u: Unit, n: number): number {
    if (n <= 1) return 0;
    const moving = this.active?.type === "move" && this.active.id === u.id;
    if (u.classId === "familiar") {
      const rate = moving ? 8.0 : 5.5;
      return Math.floor(u.bob * rate) % n;
    }
    if (u.classId === "wardog" || u.classId === "swampBlueCalf") {
      const rate = moving ? 4.2 : 2.6;
      return Math.floor(u.bob * rate) % n;
    }
    const base =
      u.classId === "horror" || u.classId === "asherah" || u.classId === "troll" || u.classId === "ancientGolem"
        ? 2.0
        : u.sprite === "kael" || u.classId === "mage" || u.classId === "cultist" || u.classId === "healer"
          ? 1.7
          : u.classId === "captain"
            ? 1.75
            : 1.85;
    const rate = base * (moving ? 2.2 : 1);
    if (moving || this.reducedMotion) return Math.floor(u.bob * rate) % n;
    const cycle = Math.max(2, n * 2 - 2);
    const pace = cycle / 2.6;
    const x = Math.floor(u.bob * pace) % cycle;
    return x < n ? x : cycle - x;
  }

  private attackPose(u: Unit): number | null {
    const a = this.active;
    if (!a) return null;
    // A dedicated cast pose (currently just Birolho's cast-*.png), for a spell or heal only —
    // falls back to the melee attacks cut for every sprite without one, same as before this
    // existed. Checked first so a caster with both never mixes an index meant for one pool's
    // frame count into the other.
    if ((a.type === "spell" || a.type === "heal") && a.att === u.id) {
      const castFrames = this.art.casts[u.sprite] ?? this.art.attacks[u.sprite];
      if (!castFrames || castFrames.length < 3) return null;
      const n = castFrames.length;
      if (n === 4) {
        if (a.t < 0.12) return 0;
        if (a.t < 0.22) return 1;
        if (a.t < 0.4) return 2;
        return 3;
      }
      return Math.min(n - 1, Math.floor(Math.min(0.99, a.t / 0.4) * n));
    }
    const frames = this.art.attacks[u.sprite];
    if (!frames || frames.length < 4) return null;
    const n = frames.length;
    const long = n >= 12;
    if (a.type === "combat") {
      const counter = a.stage.startsWith("counter");
      const actor = counter ? a.def : a.att;
      if (u.id !== actor) return null;
      if (long) {
        if (a.stage === "lunge" || a.stage === "counterLunge") return Math.min(5, Math.floor((a.t / 0.2) * 6));
        if (a.stage === "hit" || a.stage === "counterHit") return Math.min(8, 6 + Math.floor((a.t / 0.18) * 3));
        if (a.stage === "recover" || a.stage === "counterRecover") return Math.min(11, 9 + Math.floor((a.t / 0.16) * 3));
        return 11;
      }
      // Short sets: the classic cut is one frame per stage (0-1 lunge, 2 hit, 3 recover).
      // Anything between 5 and 11 frames — the familiar's 8 — walks the same three stages
      // across every frame it has instead of stopping at index 3 and wasting the rest.
      const lungeEnd = Math.max(1, Math.round((n - 1) * 0.35));
      const hitEnd = Math.max(lungeEnd + 1, Math.round((n - 1) * 0.6));
      const span = (from: number, to: number, prog: number) =>
        Math.min(to, from + Math.floor(Math.max(0, Math.min(0.999, prog)) * (to - from + 1)));
      if (a.stage === "lunge" || a.stage === "counterLunge") return span(0, lungeEnd, a.t / 0.2);
      if (a.stage === "hit" || a.stage === "counterHit") return span(lungeEnd + 1, hitEnd, a.t / 0.18);
      if (a.stage === "recover" || a.stage === "counterRecover") return span(hitEnd + 1, n - 1, a.t / 0.16);
      return n - 1;
    }
    return null;
  }

  private liveMotion(u: Unit, cell: number): { bob: number; sway: number; breath: number } {
    if (!u.alive || this.reducedMotion) return { bob: 0, sway: 0, breath: 0 };
    const t = u.bob;
    if (u.classId === "familiar") {
      return {
        bob: Math.sin(t * 1.6) * 2.4,
        sway: Math.sin(t * 0.9) * 0.7,
        breath: 0.02 + Math.sin(t * 1.6) * 0.02,
      };
    }
    if (u.classId === "wardog" || u.classId === "swampBlueCalf") {
      return {
        bob: Math.sin(t * 2.2) * 1.15,
        sway: 0,
        breath: 0.014 + Math.sin(t * 2.2) * 0.018,
      };
    }
    const heavy = u.size >= 4 ? 1.4 : u.size === 2 ? 1.12 : 1;
    if (u.sprite === "kael" || u.size >= 4) {
      return { bob: 0, sway: 0, breath: 0 };
    }
    const bob = Math.sin(t * 1.55) * (1.15 * heavy);
    const sway = Math.sin(t * 0.85 + 0.3) * (cell * 0.008 * heavy);
    const breath = 0.012 + Math.sin(t * 1.55) * 0.014;
    return { bob, sway, breath };
  }

  /** Persistent visual-code status FX: it tracks a unit, loops with engine time,
   * and needs no image, texture, or background. */
  private drawStatusFx(ctx: CanvasRenderingContext2D, u: Unit, w: number, h: number): void {
    if (!u.poisoned && !u.diseased) return;

    const layer = (poison: boolean) => {
      const core = poison ? "105,238,116" : "176,92,246";
      const dark = poison ? "24,112,63" : "78,34,126";
      const speed = poison ? 0.72 : 0.48;
      const seed = (u.x * 1.73 + u.y * 2.41 + u.id.length * 0.37) % (Math.PI * 2);
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      const pulse = 0.58 + Math.sin(this.time * (poison ? 3.8 : 2.5) + seed) * 0.16;
      const haze = ctx.createRadialGradient(0, -h * 0.18, 0, 0, -h * 0.18, w * 0.48);
      haze.addColorStop(0, `rgba(${core},${0.12 * pulse})`);
      haze.addColorStop(0.55, `rgba(${dark},${0.055 * pulse})`);
      haze.addColorStop(1, `rgba(${dark},0)`);
      ctx.fillStyle = haze;
      ctx.beginPath();
      ctx.ellipse(0, -h * 0.18, w * 0.48, h * 0.18, 0, 0, Math.PI * 2);
      ctx.fill();

      // Motes loop from feet to head, so the status looks alive rather than like a cast.
      for (let i = 0; i < 8; i += 1) {
        const rise = (this.time * speed + i * 0.137 + seed * 0.11) % 1;
        const wave = this.time * (1.8 + (i % 3) * 0.21) + i * 2.37 + seed;
        const x = Math.sin(wave) * w * (0.13 + (i % 4) * 0.042);
        const y = -h * (0.1 + rise * 0.72);
        const r = Math.max(1.2, w * (i % 3 === 0 ? 0.035 : 0.022));
        const alpha = (0.18 + (1 - rise) * 0.38) * (poison ? 1 : 0.82);
        ctx.shadowColor = `rgba(${core},${alpha})`;
        ctx.shadowBlur = r * 3.2;
        ctx.fillStyle = `rgba(${core},${alpha})`;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }

      // Thin rising vapour: green is sharper/acidic, purple is slower/sickly.
      ctx.lineCap = "round";
      for (let side = -1; side <= 1; side += 2) {
        ctx.strokeStyle = `rgba(${core},${poison ? 0.3 : 0.22})`;
        ctx.shadowColor = `rgba(${core},0.42)`;
        ctx.shadowBlur = w * 0.08;
        ctx.lineWidth = Math.max(1, w * 0.017);
        ctx.beginPath();
        for (let step = 0; step <= 5; step += 1) {
          const p = step / 5;
          const y = -h * (0.08 + p * 0.64);
          const x = side * w * (0.1 + Math.sin(this.time * (poison ? 2.2 : 1.45) + p * 7 + seed) * 0.1);
          if (step === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      ctx.restore();
    };

    if (u.poisoned) layer(true);
    if (u.diseased) layer(false);
  }
  render(ctx: CanvasRenderingContext2D, cssW: number, cssH: number, dpr: number): void {
    const sqrt3 = Math.sqrt(3);
    const tile = ZOOM_RADII[this.zoom]!;
    const { w: boardW, h: boardH } = this.boardSize(tile);
    this.viewW = cssW;
    this.viewH = cssH;
    if (!this.camReady) {
      this.layout = { ox: 0, oy: 0, tile, cols: this.cols, rows: this.rows };
      this.camReady = true;
      this.focusPlayers();
    }
    this.clampCam();
    const ox = boardW < cssW ? (cssW - boardW) / 2 : -this.camX;
    const oy = boardH < cssH ? (cssH - boardH) / 2 : -this.camY;
    this.layout = { ox, oy, tile, cols: this.cols, rows: this.rows };

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    const backdrop = this.art.backdrops[this.mission.id];
    if (backdrop) {
      const ir = backdrop.width / Math.max(1, backdrop.height);
      const cr = cssW / Math.max(1, cssH);
      let dw: number;
      let dh: number;
      if (ir > cr) {
        dh = cssH;
        dw = cssH * ir;
      } else {
        dw = cssW;
        dh = cssW / ir;
      }
      ctx.drawImage(backdrop, (cssW - dw) / 2, (cssH - dh) / 2, dw, dh);
      ctx.fillStyle = "rgba(0, 0, 0, 0.42)";
      ctx.fillRect(0, 0, cssW, cssH);
    } else {
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, cssW, cssH);
    }

    const shake = this.reducedMotion ? 0 : this.trauma * this.trauma;
    if (shake) {
      ctx.save();
      ctx.translate((Math.random() - 0.5) * 10 * shake, (Math.random() - 0.5) * 10 * shake);
    }

    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) {
        const { cx, cy } = this.hexCenter(x, y);
        if (cx < -tile * 2 || cy < -tile * 2 || cx > cssW + tile * 2 || cy > cssH + tile * 2) continue;
        const id = tileAt(this.tiles, this.cols, x, y);
        const drawId = id === "chest" ? this.visualFloorAt(x, y) : id;
        const variants = this.art.tiles[drawId];
        const variant = this.tileVariants[y * this.cols + x] ?? 0;
        const img = variants[variant] ?? variants[0];
        ctx.save();
        this.hexPath(ctx, cx, cy, tile * 1.0);
        ctx.clip();
        // A turned hex spins about its own centre, inside the clip. Sixty degrees maps a
        // hexagon onto itself, so only the picture moves — the shape stays put and the
        // neighbours still line up.
        const rot = this.tileRots[y * this.cols + x] ?? 0;
        if (rot) {
          ctx.translate(cx, cy);
          ctx.rotate((rot * Math.PI) / 3);
          ctx.translate(-cx, -cy);
        }
        if (img) ctx.drawImage(img, cx - tile, cy - tile, tile * 2, tile * 2);
        else {
          ctx.fillStyle = "#1e1b18";
          ctx.fill();
        }
        ctx.restore();
      }
    }

    this.drawDecorations(ctx, tile, cssW, cssH);


    // Every selectable area (walkable ground, spell range, an aimed AoE) gets the same
    // treatment: a soft colored glow plus a bright rim, on top of the flat fill — the flat
    // fill alone reads as a dim tint on some terrain art and is easy to miss. The glow
    // breathes (same sine pulse as the active-turn-unit ring above) rather than sitting
    // static, the classic tactics-RPG "selectable tile" look.
    const glowPulse = this.reducedMotion ? 1 : 0.72 + Math.sin(this.time * 3.2) * 0.28;
    const overlay = (cells: Iterable<Point>, fill: string) => {
      const rgb = /rgba?\(([^),]+),([^),]+),([^),]+)/.exec(fill);
      const [r, g, b] = rgb ? [rgb[1]!.trim(), rgb[2]!.trim(), rgb[3]!.trim()] : ["255", "255", "255"];
      ctx.save();
      ctx.shadowColor = `rgba(${r},${g},${b},${(0.95 * glowPulse).toFixed(3)})`;
      ctx.shadowBlur = tile * (0.4 + 0.42 * glowPulse);
      ctx.fillStyle = fill;
      ctx.strokeStyle = `rgba(${r},${g},${b},${Math.min(1, 0.8 + 0.2 * glowPulse).toFixed(3)})`;
      ctx.lineWidth = Math.max(1.8, tile * (0.06 + 0.035 * glowPulse));
      for (const c of cells) {
        const { cx, cy } = this.hexCenter(c.x, c.y);
        this.hexPath(ctx, cx, cy, tile * 0.92);
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
    };

    for (const zone of this.webZones) {
      const cells = [...zone.cells].map((k) => {
        const [x, y] = k.split(",").map(Number);
        return { x: x!, y: y! };
      });
      overlay(cells, "rgba(170,140,230,0.45)");
    }

    for (const zone of this.auraZones) {
      const cells = [...zone.cells].map((k) => {
        const [x, y] = k.split(",").map(Number);
        return { x: x!, y: y! };
      });
      overlay(cells, zone.kind === "protection" ? "rgba(150,210,255,0.3)" : "rgba(220,90,70,0.3)");
    }

    if (this.mode === "idle" && this.threat.length) overlay(this.threat, "rgba(220,120,90,0.5)");

    if (this.mode === "awaitPotion") {
      const selected = this.units.find((u) => u.id === this.selectedId);
      if (selected) {
        const range = [{ x: selected.x, y: selected.y }, ...hexNeighbors(selected.x, selected.y)].filter((c) =>
          this.validPotionTarget(selected, c),
        );
        overlay(range, "rgba(150,210,170,0.45)");
        const cell = this.hover;
        if (cell && this.validPotionTarget(selected, cell)) overlay([cell], "rgba(170,230,180,0.55)");
      }
    }

    if (this.mode === "awaitSpell") {
      const selected = this.units.find((u) => u.id === this.selectedId);
      if (selected && this.spellKind === "fireball") {
        overlay(fireballRangeTiles(selected, this.cols, this.rows), "rgba(235,140,70,0.45)");
        const cell = this.hover ?? this.spellAim;
        if (cell && manhattan(selected, cell) <= FIREBALL.range) {
          overlay(fireballTiles(fireballOrigin(cell, this.cols, this.rows), this.cols, this.rows), "rgba(235,140,70,0.55)");
        }
      } else if (selected && this.spellKind === "causticVenom") {
        overlay(fireballRangeTiles(selected, this.cols, this.rows), "rgba(200,210,90,0.45)");
        const cell = this.hover ?? this.spellAim;
        if (cell && manhattan(selected, cell) <= CAUSTIC_VENOM.range) {
          overlay(hexAreaTiles(fireballOrigin(cell, this.cols, this.rows), CAUSTIC_VENOM.size, this.cols, this.rows), "rgba(200,210,90,0.55)");
        }
      } else if (selected && this.spellKind === "longShot") {
        const reach: Point[] = [];
        const max = this.longMax(selected);
        for (let y = 0; y < this.rows; y++) {
          for (let x = 0; x < this.cols; x++) {
            const d = manhattan(selected, { x, y });
            if (d >= selected.minRange && d <= max) reach.push({ x, y });
          }
        }
        overlay(reach, "rgba(210,190,90,0.45)");
        const cell = this.hover ?? this.spellAim;
        if (cell && this.spellAimValid(selected, cell)) overlay([cell], "rgba(230,200,100,0.55)");
      } else if (selected && this.spellKind === "piercing") {
        overlay(allAxisRays(selected, this.cols, this.rows), "rgba(220,160,70,0.45)");
        const cell = this.hover ?? this.spellAim;
        const line = cell ? this.piercingRay(selected, cell) : null;
        if (line) overlay(line, "rgba(235,170,80,0.55)");
      } else if (selected && this.spellKind === "piercingThrust") {
        overlay(this.healRangeTiles(selected, selected.maxRange + 1), "rgba(220,160,80,0.45)");
        const cell = this.hover ?? this.spellAim;
        const line = cell ? this.piercingThrustRay(selected, cell) : null;
        if (line) overlay(line, "rgba(235,175,90,0.55)");
      } else if (selected && (this.spellKind === "doubleStrike" || this.spellKind === "trip")) {
        overlay(this.healRangeTiles(selected, selected.maxRange), "rgba(220,120,80,0.45)");
        const cell = this.hover ?? this.spellAim;
        if (cell && this.spellAimValid(selected, cell)) overlay([cell], "rgba(235,120,80,0.55)");
      } else if (selected && this.spellKind === "cleave") {
        overlay(hexNeighbors(selected.x, selected.y), "rgba(220,120,80,0.45)");
        const cell = this.hover ?? this.spellAim;
        const arc = cell ? cleaveHexes(selected, cell, CLEAVE.hexes, this.cols, this.rows) : [];
        if (arc.length) overlay(arc, "rgba(235,120,80,0.55)");
      } else if (selected && this.spellKind === "summonFamiliar") {
        overlay(this.healRangeTiles(selected, SUMMON_FAMILIAR.range), "rgba(180,150,235,0.45)");
        const cell = this.hover ?? this.spellAim;
        if (cell && this.spellAimValid(selected, cell)) overlay([cell], "rgba(200,170,245,0.55)");
      } else if (selected && this.spellKind === "webOfDreams") {
        overlay(this.healRangeTiles(selected, WEB_OF_DREAMS.range), "rgba(170,140,230,0.45)");
        const cell = this.hover ?? this.spellAim;
        if (cell && manhattan(selected, cell) <= WEB_OF_DREAMS.range) {
          overlay(hexAreaTiles(cell, WEB_OF_DREAMS.size, this.cols, this.rows), "rgba(185,155,240,0.55)");
        }
      } else if (selected && this.spellKind === "lightning") {
        overlay(this.healRangeTiles(selected, LIGHTNING.range), "rgba(140,200,245,0.45)");
        const cell = this.hover ?? this.spellAim;
        if (cell && this.spellAimValid(selected, cell)) overlay([cell], "rgba(160,215,255,0.55)");
      } else if (selected && this.spellKind === "magicMissile") {
        overlay(this.healRangeTiles(selected, MAGIC_MISSILE.range), "rgba(180,150,235,0.45)");
        const cell = this.hover ?? this.spellAim;
        if (cell && this.spellAimValid(selected, cell)) overlay([cell], "rgba(200,170,245,0.55)");
      } else if (selected && this.isHeal(this.spellKind)) {
        overlay(this.healRangeTiles(selected, CURES[this.spellKind].range), "rgba(150,210,170,0.45)");
        const cell = this.hover ?? this.spellAim;
        if (cell && this.validHealTarget(selected, cell)) overlay([cell], "rgba(170,230,180,0.55)");
      } else if (selected && this.spellKind === "cureDisease") {
        overlay(this.healRangeTiles(selected, CURE_DISEASE.range), "rgba(150,210,170,0.45)");
        const cell = this.hover ?? this.spellAim;
        if (cell && this.validCureDiseaseTarget(selected, cell)) overlay([cell], "rgba(170,230,180,0.55)");
      } else if (selected && this.spellKind === "multiShot") {
        overlay(this.healRangeTiles(selected, selected.maxRange + MULTI_SHOT.rangeBonus), "rgba(210,190,90,0.45)");
        const cell = this.hover ?? this.spellAim;
        if (cell && this.spellAimValid(selected, cell)) overlay([cell], "rgba(230,200,100,0.55)");
      } else if (selected && this.spellKind === "divineWrath") {
        overlay(this.healRangeTiles(selected, DIVINE_WRATH.range), "rgba(255,225,140,0.4)");
        const cell = this.hover ?? this.spellAim;
        const line = cell ? this.wrathRay(selected, cell, DIVINE_WRATH.range) : null;
        if (line) overlay(line, "rgba(255,225,140,0.6)");
      } else if (selected && this.spellKind === "shoulderSmash") {
        overlay(hexNeighbors(selected.x, selected.y), "rgba(220,120,80,0.45)");
        const cell = this.hover ?? this.spellAim;
        const arc = cell ? cleaveHexes(selected, cell, shoulderSmashPower(selected.level).hexes, this.cols, this.rows) : [];
        if (arc.length) overlay(arc, "rgba(235,120,80,0.55)");
      } else if (selected && this.spellKind === "stampede") {
        overlay(this.healRangeTiles(selected, STAMPEDE.range), "rgba(200,90,60,0.4)");
        const cell = this.hover ?? this.spellAim;
        const line = cell ? this.wrathRay(selected, cell, STAMPEDE.range) : null;
        if (line) overlay(line, "rgba(200,90,60,0.6)");
      }
    }

    if (this.mode === "selected" || this.mode === "awaitAttack" || this.mode === "awaitAction") {
      if (this.mode === "selected") overlay(this.reach.values(), "rgba(140,200,245,0.5)");
      const selected = this.units.find((u) => u.id === this.selectedId);
      const atkTiles: Point[] = [];
      for (const foe of this.units) {
        if (!foe.alive || foe.side === "player") continue;
        if (this.mode === "selected" && this.attackFrom.has(foe.id)) atkTiles.push(...footprint(foe));
        if ((this.mode === "awaitAttack" || this.mode === "awaitAction") && selected && canHitFrom(selected, selected, foe, this.tiles, this.cols)) {
          atkTiles.push(...footprint(foe));
        }
      }
      overlay(atkTiles, "rgba(230,120,85,0.55)");
      if (this.pendingFoeId) {
        const foe = this.units.find((u) => u.id === this.pendingFoeId);
        if (foe) overlay(footprint(foe), "rgba(245,95,65,0.6)");
      }
    }

    // Whose turn it is, drawn last (after the walkable/attack overlays above) so it's never
    // washed out underneath them — the active unit always stands on its own reach overlay,
    // and a thin ring alone got lost under that blue fill. A full golden hex fill, not just
    // a rim, per direct feedback ("the whole hex must get golden").
    const active = this.activeTurnUnit();
    if (active) {
      const { cx, cy } = this.hexCenter(active.x, active.y);
      const pulse = 0.75 + Math.sin(this.time * 4) * 0.25;
      const glowColor = active.side === "enemy" ? "230,120,90" : "255,215,140";
      ctx.save();
      ctx.shadowColor = `rgba(${glowColor},${0.9 * pulse})`;
      ctx.shadowBlur = tile * 0.7 * pulse;
      ctx.fillStyle = `rgba(${glowColor},${(0.34 + 0.18 * pulse).toFixed(3)})`;
      ctx.strokeStyle = `rgba(${glowColor},${0.95 * pulse})`;
      ctx.lineWidth = Math.max(2, tile * 0.09);
      this.hexPath(ctx, cx, cy, tile * 0.94);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }

    const cur = this.hover ?? this.cursor;
    {
      const { cx, cy } = this.hexCenter(cur.x, cur.y);
      const hid = tileAt(this.tiles, this.cols, cur.x, cur.y);
      const ht = TERRAIN[hid];
      const blocked = !ht.passable;
      if (blocked) {
        ctx.save();
        ctx.shadowColor = "rgba(219,58,44,0.95)";
        ctx.shadowBlur = tile * 0.55;
        ctx.strokeStyle = "rgba(255,90,72,0.95)";
        ctx.lineWidth = 3;
        this.hexPath(ctx, cx, cy, tile * 0.9);
        ctx.stroke();
        ctx.restore();
      } else {
        ctx.strokeStyle = "rgba(240,235,227,0.9)";
        ctx.lineWidth = 2;
        this.hexPath(ctx, cx, cy, tile * 0.9);
        ctx.stroke();
      }
      if (blocked || ht.height) {
        const label = blocked ? ht.name.toUpperCase() : "ALTO +2";
        const fontPx = Math.max(11, Math.round(tile * 0.32));
        ctx.font = `700 ${fontPx}px Figtree, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.lineJoin = "round";
        ctx.lineWidth = Math.max(3, fontPx * 0.22);
        ctx.strokeStyle = "rgba(12,11,10,0.88)";
        ctx.fillStyle = blocked ? "#ff7a68" : "#efe4c4";
        ctx.strokeText(label, cx, cy + tile * 0.38);
        ctx.fillText(label, cx, cy + tile * 0.38);
      }
    }

    const cell = tile * sqrt3;
    const sorted = [...this.units].sort((a, b) => a.drawY - b.drawY || a.drawX - b.drawX);
    for (const u of sorted) {
      if (u.fade <= 0) continue;
      const s = unitSize(u);
      const boss = u.classId === "captain";
      const { cx: px, cy: py } = this.unitPixel(u);
      const foot = s >= 4 ? 2.15 : s === 2 ? 1.5 : boss ? 1.12 : 1;
      const { bob, sway, breath } = this.liveMotion(u, cell);
      ctx.save();
      ctx.globalAlpha = u.fade * (u.moved && u.side === "player" && this.phase === "player" ? 0.55 : 1);
      ctx.fillStyle = "rgba(0,0,0,0.4)";
      ctx.beginPath();
      ctx.ellipse(
        px + sway,
        py + cell * 0.22,
        cell * 0.22 * foot * (1 + breath * 0.4),
        cell * 0.1 * Math.min(2.2, foot) * (1 - breath * 0.3),
        0,
        0,
        Math.PI * 2,
      );
      ctx.fill();
      const atk = this.attackPose(u);
      const moving = this.active?.type === "move" && this.active.id === u.id;
      const idle = !atk && !moving ? this.art.idles[u.sprite] : undefined;
      // While moving, a sprite that has a walk cut plays it; one that doesn't falls back to
      // its idle loop, which idleFrame already runs faster for a moving unit.
      const walk = atk == null && moving ? this.art.walks[u.sprite] : undefined;
      // attackPose computes its index against whichever pool it picked (casts for a spell/heal
      // cast, when the caster has one — attacks otherwise), so this has to mirror that same
      // choice or the index lands in the wrong array.
      const casting = this.active && (this.active.type === "spell" || this.active.type === "heal") && this.active.att === u.id;
      const frames = atk != null ? (casting ? (this.art.casts[u.sprite] ?? this.art.attacks[u.sprite]) : this.art.attacks[u.sprite]) : walk ?? idle ?? this.art.sprites[u.sprite];
      const n = frames?.length ?? 0;
      const fi = atk != null ? atk : walk ? this.walkFrame(u, n) : this.idleFrame(u, n || 4);
      const walkDirs = moving ? this.art.walkDirs[u.sprite] : undefined;
      const img = (walkDirs ? walkDirs[u.walkPose] : undefined) ?? frames?.[fi] ?? frames?.[0];
      // The draw-size correction keys off the footprint SHAPE (reference equality against
      // FOOTPRINT_TYPE_8 or FOOTPRINT_TYPE_7), not a hardcoded classId — every big creature
      // (Troll, Asherah, Horror, and any future one on either shape) gets the same default
      // correction automatically, rather than needing its own one-off case added here.
      // Depends on that creature's own sprite frames being cropped to roughly the same
      // canvas-fill ratio as the others — this correction assumes that, it doesn't measure it.
      const isBigCreatureFootprint = u.footprintOffsets === FOOTPRINT_TYPE_8 || u.footprintOffsets === FOOTPRINT_TYPE_7;
      const h = cell * (s >= 4 ? 3.35 : s === 2 ? 1.72 : boss ? 1.44 : 1.42) * 1.2 * (isBigCreatureFootprint ? 0.75 : 1);
      const w = cell * (s >= 4 ? 2.85 : s === 2 ? 1.85 : boss ? 1.12 : 1.11) * 1.2 * (isBigCreatureFootprint ? 0.75 : 1);
      // Big creatures plant their feet at the bottom corner of their front hex (tile * 0.9,
      // matching the hex outline radius used elsewhere) instead of the smaller offset tuned
      // for normal-size sprites, so the feet don't float above the tile they stand on.
      const footY = s >= 4 ? tile * 0.9 : cell * 0.42;
      ctx.translate(px + sway, py + footY + bob);
      if (u.sprite === "kael") ctx.scale(u.facing, 1);
      else ctx.scale(u.facing * (1 - breath * 0.22), 1 + breath);
      if (u.levelGlow > 0) {
        const pulse = 0.75 + Math.sin(this.time * 7) * 0.25;
        const bg = ctx.createRadialGradient(0, -h * 0.5, 0, 0, -h * 0.5, w * 1.15);
        bg.addColorStop(0, `rgba(255,214,120,${0.5 * u.levelGlow * pulse})`);
        bg.addColorStop(1, "rgba(255,214,120,0)");
        ctx.fillStyle = bg;
        ctx.beginPath();
        ctx.arc(0, -h * 0.5, w * 1.15, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowColor = `rgba(255,208,110,${0.95 * u.levelGlow})`;
        ctx.shadowBlur = w * 0.4 * u.levelGlow * pulse;
      }
      // A gentler, cooler-white "divine light" halo for a heal spell landing or a potion
      // being drunk — same technique as levelGlow, its own softer palette and pace so the
      // two read as different events even if they happen to overlap.
      if (u.healGlow > 0) {
        const pulse = 0.8 + Math.sin(this.time * 5) * 0.2;
        const bg = ctx.createRadialGradient(0, -h * 0.5, 0, 0, -h * 0.5, w * 1.05);
        bg.addColorStop(0, `rgba(255,248,224,${0.42 * u.healGlow * pulse})`);
        bg.addColorStop(1, "rgba(255,248,224,0)");
        ctx.fillStyle = bg;
        ctx.beginPath();
        ctx.arc(0, -h * 0.5, w * 1.05, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowColor = `rgba(255,250,235,${0.85 * u.healGlow})`;
        ctx.shadowBlur = w * 0.32 * u.healGlow * pulse;
      }
      if (u.flash > 0) ctx.filter = `brightness(${1.8 + u.flash})`;
      if (img) ctx.drawImage(img, -w / 2, -h, w, h);
      else {
        ctx.fillStyle = u.side === "player" ? "#8a97a1" : u.side === "neutral" ? "#5f8a58" : "#a35a4a";
        ctx.fillRect(-w / 2, -h, w, h);
      }
      // A second glow pass on top of the sprite (shadowBlur alone, no offset, mimics an outer
      // rim glow following the art's own alpha edges) so the effect reads as coming off the
      // character rather than just floating behind it.
      if (u.levelGlow > 0 && img) {
        const pulse = 0.75 + Math.sin(this.time * 7) * 0.25;
        ctx.shadowBlur = w * 0.55 * u.levelGlow * pulse;
        ctx.drawImage(img, -w / 2, -h, w, h);
      }
      if (u.healGlow > 0 && img) {
        const pulse = 0.8 + Math.sin(this.time * 5) * 0.2;
        ctx.shadowColor = `rgba(255,250,235,${0.85 * u.healGlow})`;
        ctx.shadowBlur = w * 0.42 * u.healGlow * pulse;
        ctx.drawImage(img, -w / 2, -h, w, h);
      }
      this.drawStatusFx(ctx, u, w, h);
      ctx.filter = "none";
      ctx.shadowBlur = 0;
      ctx.restore();

      if (u.alive) {
        const bw = cell * (s >= 4 ? 1.35 : s === 2 ? 0.9 : boss ? 0.68 : 0.62);
        const bh = Math.max(4, cell * 0.07);
        const bx = px - bw / 2;
        const by = py - h + cell * 0.42 + bob - Math.max(8, cell * 0.12);
        ctx.fillStyle = "rgba(12,11,10,0.82)";
        ctx.fillRect(bx - 1, by - 1, bw + 2, bh + 2);
        ctx.fillStyle = "#2c2824";
        ctx.fillRect(bx, by, bw, bh);
        // Green for wild neutrals, so a beast that isn't hunting you doesn't read as an
        // enemy — it turns red on its own the moment it is provoked and joins that side.
        ctx.fillStyle = u.side === "player" ? "#c8c4bc" : u.side === "neutral" ? "#5f9e52" : "#b54a32";
        ctx.fillRect(bx, by, bw * Math.max(0, u.hp / u.maxHp), bh);
        if (cell >= 32) {
          ctx.font = `600 ${Math.round(cell * 0.22)}px Figtree, sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "bottom";
          ctx.lineJoin = "round";
          ctx.lineWidth = 3;
          ctx.strokeStyle = "rgba(12,11,10,0.9)";
          ctx.fillStyle = "#f0ebe3";
          ctx.strokeText(`${u.hp}`, px, by - 1);
          ctx.fillText(`${u.hp}`, px, by - 1);
        }
        if (u.stunned) {
          const gx = px;
          const gy = by - bh - cell * 0.16;
          const r = cell * 0.13;
          const glow = ctx.createRadialGradient(gx, gy, 0, gx, gy, r);
          glow.addColorStop(0, "rgba(255,90,70,0.95)");
          glow.addColorStop(0.6, "rgba(255,60,50,0.55)");
          glow.addColorStop(1, "rgba(255,60,50,0)");
          ctx.fillStyle = glow;
          ctx.beginPath();
          ctx.arc(gx, gy, r, 0, Math.PI * 2);
          ctx.fill();
        }
      }

    }

    if (this.particleLive) {
      const dmgCell = tile * Math.sqrt(3);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (const p of this.particles) {
        if (!p.live || p.kind === "text") continue;
        const { cx, cy } = this.hexCenter(Math.round(p.x), Math.round(p.y));
        const px = cx;
        const py = cy - tile * 0.2;
        ctx.globalAlpha = 1 - p.life / p.max;
        if (p.kind === "impact") {
          const img = this.art.impact[Math.min(3, Math.floor(p.frame))];
          if (img) ctx.drawImage(img, px - tile * 0.45, py - tile * 0.45, tile * 0.9, tile * 0.9);
        } else {
          ctx.fillStyle = p.color;
          ctx.fillRect(px, py, p.size, p.size);
        }
      }
      for (const p of this.particles) {
        if (!p.live || p.kind !== "text" || !p.text) continue;
        const { cx, cy } = this.hexCenter(Math.round(p.x), Math.round(p.y));
        const fade = 0.4;
        const a = p.life < p.max - fade ? 1 : Math.max(0, 1 - (p.life - (p.max - fade)) / fade);
        ctx.globalAlpha = a;
        const fontPx = Math.max(16, Math.round(dmgCell * 0.42));
        ctx.font = `800 ${fontPx}px Figtree, sans-serif`;
        ctx.lineJoin = "round";
        ctx.lineWidth = Math.max(4, fontPx * 0.22);
        ctx.strokeStyle = "rgba(12,11,10,0.92)";
        ctx.fillStyle = p.color;
        ctx.strokeText(p.text, cx, cy - dmgCell * 0.85 - p.life * 16);
        ctx.fillText(p.text, cx, cy - dmgCell * 0.85 - p.life * 16);
      }
      ctx.globalAlpha = 1;
    }

    if (this.levelUpFxLive) {
      for (const s of this.levelUpFx) {
        if (!s.live) continue;
        const unit = this.units.find((u) => u.id === s.unitId);
        if (!unit) continue;
        const { cx, cy } = this.hexCenter(Math.round(unit.x), Math.round(unit.y));
        const x = cx + s.dx;
        const y = cy + s.dy;
        const k = s.life / s.max;
        if (s.kind === "ring") {
          const r = s.refCell * (0.15 + k * 1.25);
          ctx.globalAlpha = Math.max(0, 1 - k) * 0.85;
          ctx.strokeStyle = `hsl(${s.hue}, 95%, 68%)`;
          ctx.lineWidth = Math.max(1.5, s.refCell * 0.05 * (1 - k));
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.stroke();
          if (k < 0.3) {
            const flash = ctx.createRadialGradient(x, y, 0, x, y, s.refCell * 0.5);
            flash.addColorStop(0, `rgba(255,250,220,${0.6 * (1 - k / 0.3)})`);
            flash.addColorStop(1, "rgba(255,250,220,0)");
            ctx.fillStyle = flash;
            ctx.globalAlpha = 1;
            ctx.beginPath();
            ctx.arc(x, y, s.refCell * 0.5, 0, Math.PI * 2);
            ctx.fill();
          }
          continue;
        }
        if (s.kind === "label") {
          const labelFade = k < 0.12 ? k / 0.12 : k > 0.75 ? Math.max(0, 1 - (k - 0.75) / 0.25) : 1;
          const pop = k < 0.12 ? 1.35 - 0.35 * (k / 0.12) : 1;
          ctx.save();
          ctx.globalAlpha = labelFade;
          ctx.translate(x, y);
          ctx.scale(pop, pop);
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.font = `900 ${Math.round(s.size)}px Figtree, sans-serif`;
          ctx.shadowColor = `hsla(${s.hue}, 100%, 65%, 0.95)`;
          ctx.shadowBlur = s.size * 0.9;
          ctx.lineJoin = "round";
          ctx.lineWidth = Math.max(4, s.size * 0.16);
          ctx.strokeStyle = "rgba(24,16,4,0.9)";
          ctx.strokeText(s.text ?? "", 0, 0);
          ctx.fillStyle = `hsl(${s.hue}, 100%, 74%)`;
          ctx.fillText(s.text ?? "", 0, 0);
          ctx.shadowBlur = s.size * 1.6;
          ctx.fillText(s.text ?? "", 0, 0);
          ctx.restore();
          continue;
        }
        const fade = k < 0.15 ? k / 0.15 : k > 0.7 ? Math.max(0, 1 - (k - 0.7) / 0.3) : 1;
        ctx.globalAlpha = fade;
        const size = s.size * (1 - k * 0.35);
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(s.rot);
        const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, size * 2.2);
        glow.addColorStop(0, `hsla(${s.hue}, 100%, 82%, 0.9)`);
        glow.addColorStop(1, `hsla(${s.hue}, 100%, 60%, 0)`);
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(0, 0, size * 2.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = `hsl(${s.hue}, 95%, 78%)`;
        ctx.beginPath();
        for (let i = 0; i < 8; i++) {
          const ang = (Math.PI / 4) * i;
          const r = i % 2 === 0 ? size : size * 0.35;
          const px = Math.cos(ang) * r;
          const py = Math.sin(ang) * r;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
      ctx.globalAlpha = 1;
    }

    if (this.fireballBurstFxLive) {
      for (const burst of this.fireballBurstFx) {
        if (!burst.live) continue;
        const { cx, cy } = this.hexCenter(burst.x, burst.y);
        const k = burst.t / burst.max;
        const fade = Math.max(0, 1 - k);
        const radius = tile * (0.34 + k * 0.72);
        const venom = burst.kind === "causticVenom";
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        const glow = ctx.createRadialGradient(cx, cy - tile * 0.1, 0, cx, cy - tile * 0.1, radius);
        glow.addColorStop(0, venom ? `rgba(232,255,175,${0.84 * fade})` : `rgba(255,248,194,${0.9 * fade})`);
        glow.addColorStop(0.22, venom ? `rgba(159,242,45,${0.76 * fade})` : `rgba(255,174,35,${0.78 * fade})`);
        glow.addColorStop(0.62, venom ? `rgba(25,150,54,${0.45 * fade})` : `rgba(236,62,12,${0.42 * fade})`);
        glow.addColorStop(1, venom ? "rgba(4,72,30,0)" : "rgba(128,18,0,0)");
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(cx, cy - tile * 0.1, radius, 0, Math.PI * 2);
        ctx.fill();
        // Rising tongues and embers make every AoE hex visibly burn instead of only flashing.
        for (let i = 0; i < 7; i += 1) {
          const angle = burst.seed + i * 2.41 + k * 5.2;
          const spread = tile * (0.18 + (i % 3) * 0.1) * (0.75 + k * 0.35);
          const px = cx + Math.cos(angle) * spread;
          const py = cy - tile * (0.08 + k * 0.28) + Math.sin(angle) * spread * 0.45;
          const r = tile * (0.055 + (i % 2) * 0.025) * fade;
          ctx.shadowColor = venom ? "rgba(126,255,48,0.95)" : "rgba(255,106,12,0.95)";
          ctx.shadowBlur = tile * 0.22;
          ctx.fillStyle = venom ? (i % 3 === 0 ? `rgba(222,255,142,${fade})` : `rgba(65,209,54,${0.85 * fade})`) : (i % 3 === 0 ? `rgba(255,239,150,${fade})` : `rgba(255,93,8,${0.85 * fade})`);
          ctx.beginPath();
          ctx.arc(px, py, Math.max(1, r), 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
    }
    if (this.missileFxLive) {
      for (const m of this.missileFx) {
        if (!m.live) continue;
        const from = this.hexCenter(m.fromX, m.fromY);
        const to = this.hexCenter(m.toX, m.toY);
        const dxT = to.cx - from.cx;
        const dyT = to.cy - from.cy;
        const dist = Math.hypot(dxT, dyT) || 1;
        const nx = -dyT / dist;
        const ny = dxT / dist;
        const along = (k: number) => {
          const wave = Math.sin(k * Math.PI * 2.4 + m.seed) * tile * 0.16 * (1 - k * 0.6);
          return { x: from.cx + dxT * k + nx * wave, y: from.cy - tile * 0.3 + dyT * k + ny * wave };
        };
        // kHead: the bolt's own position, 0-1, frozen at 1 once it lands. afterglow: 0 while
        // still flying, ramping to 1 as the lingering trail fades out after arrival.
        const kHead = Math.min(1, m.t / m.travel);
        const afterglow = Math.max(0, (m.t - m.travel) / MISSILE_AFTERGLOW);
        const physicalArrow = m.kind === "longShot";
        if (physicalArrow) {
          // arrow-002: original supplied arrow art, straight travel, with a restrained air-pressure wake.
          const head = { x: from.cx + dxT * kHead, y: from.cy - tile * 0.3 + dyT * kHead };
          const flightAngle = Math.atan2(dyT, dxT);
          ctx.save();
          ctx.globalCompositeOperation = "lighter";
          ctx.globalAlpha = (1 - afterglow) * 0.24;
          ctx.strokeStyle = "rgba(215,222,226,0.74)";
          ctx.lineWidth = Math.max(1, tile * 0.012);
          for (let ring = 1; ring <= 2; ring += 1) {
            const bk = Math.max(0, kHead - ring * 0.1);
            const back = { x: from.cx + dxT * bk, y: from.cy - tile * 0.3 + dyT * bk };
            ctx.beginPath();
            ctx.ellipse(back.x, back.y, tile * (0.09 + ring * 0.035), tile * (0.024 + ring * 0.01), flightAngle, 0, Math.PI * 2);
            ctx.stroke();
          }
          ctx.restore();
          ctx.save();
          ctx.translate(head.x, head.y);
          // The supplied source points northeast (-45°); rotate from that intrinsic direction to the flight angle.
          ctx.rotate(flightAngle + Math.PI / 4);
          ctx.globalCompositeOperation = "screen";
          ctx.globalAlpha = 1 - afterglow;
          ctx.drawImage(this.art.arrowCore, -tile * 0.54, -tile * 0.54, tile * 1.08, tile * 1.08);
          ctx.restore();
          continue;
        }

        const minorArcaneBolt = m.kind === "arcaneBolt";

        if (minorArcaneBolt) {
          // Mage basic attack: two thin arcane pressure waves, then a runic impact at the target.
          const head = along(kHead);
          const angle = Math.atan2(dyT, dxT);
          ctx.save();
          ctx.globalCompositeOperation = "lighter";
          ctx.globalAlpha = 1 - afterglow;
          ctx.strokeStyle = "rgba(202,92,255,0.72)";
          ctx.lineWidth = Math.max(1, tile * 0.017);
          for (let ring = 1; ring <= 2; ring += 1) {
            const back = along(Math.max(0, kHead - ring * 0.1));
            ctx.beginPath();
            ctx.ellipse(back.x, back.y, tile * (0.09 + ring * 0.035), tile * (0.025 + ring * 0.012), angle + Math.PI / 4, 0, Math.PI * 2);
            ctx.stroke();
          }
          ctx.fillStyle = "rgba(244,150,255,0.92)";
          ctx.beginPath(); ctx.arc(head.x, head.y, tile * 0.035, 0, Math.PI * 2); ctx.fill();
          if (kHead >= 1) {
            ctx.strokeStyle = "rgba(255,110,220,0.88)";
            ctx.lineWidth = Math.max(1, tile * 0.014);
            for (let ray = 0; ray < 8; ray += 1) {
              const a = m.seed + ray * Math.PI / 4;
              const inner = tile * 0.05;
              const outer = tile * (0.12 + 0.09 * afterglow);
              ctx.beginPath();
              ctx.moveTo(head.x + Math.cos(a) * inner, head.y + Math.sin(a) * inner * 0.55);
              ctx.lineTo(head.x + Math.cos(a) * outer, head.y + Math.sin(a) * outer * 0.55);
              ctx.stroke();
            }
          }
          ctx.restore();
          continue;
        }

        // The light trace it leaves behind: a single stroke along the whole path already
        // flown, distinct from the comet below (which only ever hugs the head) — this is
        // what stays visible on the ground after the bolt has passed through.
        if (kHead > 0.02) {
          const steps = 16;
          ctx.beginPath();
          for (let i = 0; i <= steps; i++) {
            const p = along((i / steps) * kHead);
            if (i === 0) ctx.moveTo(p.x, p.y);
            else ctx.lineTo(p.x, p.y);
          }
          const traceFade = (1 - afterglow) * (physicalArrow ? 0.13 : minorArcaneBolt ? 0.44 : 0.55);
          ctx.lineCap = "round";
          ctx.lineJoin = "round";
          ctx.lineWidth = tile * (physicalArrow ? 0.018 : minorArcaneBolt ? 0.028 : 0.05);
          ctx.strokeStyle = physicalArrow ? `rgba(218,224,226,${traceFade})` : `hsla(${m.hue}, 90%, 74%, ${traceFade})`;
          ctx.shadowColor = physicalArrow ? `rgba(218,224,226,${traceFade})` : `hsla(${m.hue}, 95%, 70%, ${traceFade})`;
          ctx.shadowBlur = tile * (physicalArrow ? 0.1 : 0.4);
          ctx.stroke();
          ctx.shadowBlur = 0;
        }

        if (afterglow < 1) {
          // A bigger, punchier comet trail right behind the head.
          const cometCount = minorArcaneBolt ? 11 : 7;
          for (let i = cometCount; i >= 0; i--) {
            const tk = Math.max(0, kHead - i * 0.05);
            const p = along(tk);
            const fade = (1 - i / 8) * (1 - afterglow);
            const r = tile * (physicalArrow ? (0.045 - i * 0.004) : (minorArcaneBolt ? 0.64 : 1) * (0.16 - i * 0.016));
            if (r <= 0) continue;
            const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 3);
            g.addColorStop(0, physicalArrow ? `rgba(228,232,234,${fade * 0.18})` : `hsla(${m.hue}, 95%, 86%, ${fade})`);
            g.addColorStop(0.35, physicalArrow ? `rgba(150,158,162,${fade * 0.08})` : `hsla(${m.hue}, 92%, 68%, ${fade * 0.75})`);
            g.addColorStop(1, physicalArrow ? `rgba(120,130,136,0)` : `hsla(${m.hue}, 90%, 55%, 0)`);
            ctx.fillStyle = g;
            ctx.beginPath();
            ctx.arc(p.x, p.y, r * 3, 0, Math.PI * 2);
            ctx.fill();
          }
          const head = along(kHead);
          // A big soft aura around the head, well beyond the core, for real glow.
          const auraFade = 1 - afterglow;
          const aura = ctx.createRadialGradient(head.x, head.y, 0, head.x, head.y, tile * (physicalArrow ? 0.16 : minorArcaneBolt ? 0.34 : 0.55));
          aura.addColorStop(0, physicalArrow ? `rgba(230,234,236,${0.1 * auraFade})` : `hsla(${m.hue}, 100%, 85%, ${(minorArcaneBolt ? 0.34 : 0.55) * auraFade})`);
          aura.addColorStop(1, physicalArrow ? `rgba(180,188,192,0)` : `hsla(${m.hue}, 100%, 60%, 0)`);
          ctx.fillStyle = aura;
          ctx.beginPath();
          ctx.arc(head.x, head.y, tile * (physicalArrow ? 0.16 : minorArcaneBolt ? 0.34 : 0.55), 0, Math.PI * 2);
          ctx.fill();
          if (minorArcaneBolt) {
            // Basic mage attack: a compact scarlet lance, deliberately unlike Magic Missile.
            ctx.save();
            ctx.globalCompositeOperation = "lighter";
            ctx.globalAlpha = auraFade;
            const core = ctx.createRadialGradient(head.x, head.y, 0, head.x, head.y, tile * 0.18);
            core.addColorStop(0, "rgba(255,242,200,0.98)");
            core.addColorStop(0.22, "rgba(255,104,58,0.9)");
            core.addColorStop(0.62, "rgba(182,20,27,0.35)");
            core.addColorStop(1, "rgba(110,0,8,0)");
            ctx.fillStyle = core;
            ctx.beginPath(); ctx.arc(head.x, head.y, tile * 0.18, 0, Math.PI * 2); ctx.fill();
            ctx.strokeStyle = "rgba(255,96,55,0.72)";
            ctx.lineWidth = Math.max(1, tile * 0.018);
            for (let spark = 0; spark < 12; spark += 1) {
              const a = m.seed + spark * 2.399 + this.time * (2.2 + spark * 0.09);
              const radius = tile * (0.12 + ((spark * 7) % 6) * 0.018);
              const x = head.x + Math.cos(a) * radius;
              const y = head.y + Math.sin(a) * radius * 0.55;
              ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - Math.cos(a) * tile * 0.065, y - Math.sin(a) * tile * 0.04); ctx.stroke();
            }
            ctx.restore();
          }
                    const projectileCore = m.kind === "fireball" ? this.art.fireballCore : m.kind === "causticVenom" ? this.art.causticVenomCore : null;
          if (m.kind === "longShot" && this.art.arrowCore) {
            // One shared approved arrow asset for normal shots, Multi Shot, Long Shot and Piercing Shot.
            const angle = Math.atan2(dyT, dxT);
            ctx.save();
            ctx.translate(head.x, head.y);
            ctx.rotate(angle);
            ctx.globalCompositeOperation = "screen";
            ctx.globalAlpha = auraFade;
            ctx.drawImage(this.art.arrowCore, -tile * 0.56, -tile * 0.22, tile * 1.12, tile * 0.44);
            ctx.restore();
          }
          if (projectileCore) {
            // Dense physical flame core; black source pixels disappear under additive blend.
            const img = projectileCore;
            // Crop away the intentionally huge black 4K margin. Only the real flame core is
            // scaled to the map, where it remains visibly layered with the code trail.
            const crop = Math.min(img.naturalWidth, img.naturalHeight) * 0.58;
            const sx = (img.naturalWidth - crop) / 2;
            const sy = (img.naturalHeight - crop) / 2;
            const size = tile * (1.02 + Math.sin(this.time * 13 + m.seed) * 0.06);
            ctx.save();
            ctx.globalCompositeOperation = "lighter";
            ctx.globalAlpha = auraFade;
            ctx.drawImage(img, sx, sy, crop, crop, head.x - size / 2, head.y - size / 2, size, size);
            ctx.restore();
          }
          ctx.fillStyle = `rgba(255,255,255,${(physicalArrow ? 0 : 0.95) * auraFade})`;
          ctx.beginPath();
          ctx.arc(head.x, head.y, tile * (minorArcaneBolt ? 0.05 : 0.085), 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    }

    if (this.lightningFxLive) {
      for (const l of this.lightningFx) {
        if (!l.live) continue;
        const { cx, cy } = this.hexCenter(l.x, l.y);
        const topY = cy - tile * LIGHTNING_FALL_HEIGHT;
        const k = l.t / l.max;
        // The strike itself is near-instant (a real bolt doesn't travel visibly slowly), then
        // holds bright for a beat before fading — distinct from a projectile's smooth flight.
        const reveal = Math.min(1, l.t / 0.06);
        const fade = k < 0.35 ? 1 : Math.max(0, 1 - (k - 0.35) / 0.65);
        if (fade <= 0) continue;

        const n = l.segs.length;
        const mainPts: { x: number; y: number }[] = [{ x: cx, y: topY }];
        for (let i = 1; i <= n; i++) {
          const f = i / (n + 1);
          if (f > reveal) break;
          mainPts.push({ x: cx + l.segs[i - 1]! * tile, y: topY + (cy - topY) * f });
        }
        if (reveal >= (n + 1 - 0.001) / (n + 1)) mainPts.push({ x: cx, y: cy });
        if (mainPts.length < 2) continue;

        const strokeBolt = (pts: { x: number; y: number }[], glowWidth: number, coreWidth: number) => {
          ctx.beginPath();
          pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
          ctx.lineJoin = "round";
          ctx.lineCap = "round";
          ctx.strokeStyle = `hsla(${l.hue}, 100%, 70%, ${0.55 * fade})`;
          ctx.lineWidth = glowWidth;
          ctx.shadowColor = `hsla(${l.hue}, 100%, 75%, ${0.9 * fade})`;
          ctx.shadowBlur = tile * 0.5;
          ctx.stroke();
          ctx.shadowBlur = 0;
          // A bright white core on top of the colored glow, so the bolt reads as firm and
          // solid rather than a soft haze.
          ctx.strokeStyle = `rgba(255,255,255,${0.95 * fade})`;
          ctx.lineWidth = coreWidth;
          ctx.stroke();
        };

        strokeBolt(mainPts, tile * 0.24, tile * 0.08);

        for (const b of l.branches) {
          const startIdx = Math.min(mainPts.length - 1, Math.round(b.at * (n + 1)));
          if (startIdx < 1) continue;
          const start = mainPts[startIdx]!;
          const forkReveal = Math.max(0, Math.min(1, (reveal - b.at) / (1 - b.at + 0.001)));
          const segCount = b.segs.length;
          const shown = Math.round(forkReveal * segCount);
          if (shown < 1) continue;
          const branchPts = [start];
          for (let i = 0; i < shown; i++) {
            const f = (i + 1) / segCount;
            branchPts.push({
              x: start.x + b.side * tile * 0.5 * f + b.segs[i]! * tile,
              y: start.y + (cy - topY) * (1 - b.at) * f * 0.7,
            });
          }
          if (branchPts.length >= 2) strokeBolt(branchPts, tile * 0.13, tile * 0.045);
        }

        // A bright flash at the strike point, biggest right on impact.
        if (k < 0.5) {
          const flashFade = Math.max(0, 1 - k / 0.5);
          const flash = ctx.createRadialGradient(cx, cy, 0, cx, cy, tile * 0.9);
          flash.addColorStop(0, `hsla(${l.hue}, 100%, 88%, ${0.7 * flashFade})`);
          flash.addColorStop(1, `hsla(${l.hue}, 100%, 70%, 0)`);
          ctx.fillStyle = flash;
          ctx.beginPath();
          ctx.arc(cx, cy, tile * 0.9, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    }

    if (shake) ctx.restore();
  }
}
