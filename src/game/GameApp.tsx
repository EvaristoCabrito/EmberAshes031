import { type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, Dices, Grip, Pencil, RotateCcw, Shield, Shuffle, Swords, Volume2, VolumeX, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { loadGameArt, TILE_VARIANT_COUNT, tileVariantName, tileVariantSrc } from "./assets";
import { installAudioUnlock, playFile, playMenuMusic, playTheme, resumeAudio, setMuted, sfxPlay, stopMusic, unlockAudio } from "./audio";
import { BattleCanvas } from "./BattleCanvas";
import { InnScreen } from "./InnScreen";
import { PartyInventoryOverlay } from "./InventoryScreens";
import { CAUSTIC_VENOM, CHEST_LOOT, CLASSES, CLEAVE, cleaveFormula, CURE_DISEASE, CURES, DECORATIONS, DOUBLE_STRIKE, doubleStrikeFormula, EQUIPMENT, EXP_TO_LEVEL, FIREBALL, formatSpellUseGains, KILL_DROP_CHANCE, LIGHTNING, LONG_SHOT, longShotFormula, MAGIC_MISSILE, PIERCING, piercingMul, PIERCING_THRUST, MAX_LEVEL, POTIONS, POTION_LOOT_WEIGHT, PROMOTE_LEVEL, PROMOTED_BASE, PROMOTIONS, SUMMON_FAMILIAR, SWEEP, TRIP, TERRAIN, WEAPONS, WEAPON_MAX_ENH, WEB_OF_DREAMS, BAG_MAX, LOCKPICK_PRICE, POTION_CARRY_MAX, POTION_PRICE, barricadeDecor, decorationCells, placedFootprint, decorationImage, diceFormula, emberForKill, enemyLevelFor, equippedPouchId, fireballFormula, healFormula, lightningFormula, dressMap, isSummonClass, MUSIC_TRACKS, SUMMON_CLASSES, parseLayout, potionLabel, pouchIcon, rangeLabel, sheetLine, spellFormula, spellTier, spellUseGains, startingBags, statsFor, terrainNote, tierKey, tierUses, weaponEnhCost, weaponSellValue, MULTI_SHOT, multiShotFormula, SECOND_WIND, secondWindPct, auraPower, AURA_OF_PROTECTION, INTIMIDATING_PRESENCE, DIVINE_WRATH, divineWrathPower, SHOULDER_SMASH, shoulderSmashFormula, STAMPEDE, stampedeFormula, type SpellTier } from "./data";
import { BattleEngine } from "./engine";
import { MapPreviewCanvas, type PreviewUnitSelection } from "./MapPreviewCanvas";
import { WorldMapScreen } from "./WorldMapScreen";
import { DISPLAY_VERSION } from "./version";
import { ALL_LOCATIONS, ALL_MISSIONS, LOCATION_SLOTS, draftToMission, latestSerialFor, locationFill, locationForMission, locationsForOrder, mapFileName, missionById, missionsForLocation, latestSavedDraft, savedScenarios, savedVersionsFor, serialLabel, slotsFor, type MapDraft, type MapFile, type DraftSpawn } from "./mapstore";
import {
  activeSave,
  emptySave,
  formatStamp,
  hasAnySave,
  isSlotEmpty,
  loadBank,
  setMutedBank,
  SLOT_COUNT,
  slotProgress,
  writeSlot,
  selectSlot,
} from "./save";
import type { ClassId, EquipSlot, GameArt, GrowthLine, HudSnapshot, Mission, PotionId, SaveBank, SaveData, ScreenId, SpellKind, Spawn, TerrainId, UnitPublic, WinCondition, WorldLocation } from "./types";

/** A map JSON write updates Vite's module list and can reload the app. This one-shot
 * snapshot restores the editor instead of sending the author to the title screen. */
const EDITOR_RESUME_KEY = "ember:editor-resume";
function readEditorResume(): MapDraft | null {
  try {
    const raw = window.sessionStorage.getItem(EDITOR_RESUME_KEY);
    if (!raw) return null;
    const draft = JSON.parse(raw) as MapDraft;
    return typeof draft?.id === "string" && Array.isArray(draft.tiles) ? draft : null;
  } catch {
    return null;
  }
}
function armEditorResume(draft: MapDraft): void {
  try { window.sessionStorage.setItem(EDITOR_RESUME_KEY, JSON.stringify(draft)); } catch { /* saving still proceeds */ }
}
function clearEditorResume(): void {
  try { window.sessionStorage.removeItem(EDITOR_RESUME_KEY); } catch { /* storage is optional */ }
}
/** Weapons belong to the party. Equipping one moves it from the previous wielder; only
 * potions and lockpicks stay in the individual bags. */
function equipSharedWeapon(save: SaveData, hero: string, weaponId: string): SaveData | null {
  if (save.weapons[weaponId] == null) return null;
  const equipped = { ...save.equipped };
  for (const [owner, id] of Object.entries(equipped)) {
    if (owner !== hero && id === weaponId) delete equipped[owner];
  }
  equipped[hero] = weaponId;
  return { ...save, equipped };
}

/** Equipment is a physical party pool: select a reserve piece or transfer one from another
 * hero. Consumable bags are intentionally not part of this function. */
function equipSharedItem(save: SaveData, hero: string, slot: EquipSlot, itemId: string): SaveData | null {
  const source = Object.entries(save.equipment)
    .flatMap(([owner, slots]) => (Object.entries(slots) as [EquipSlot, string][]).map(([usedSlot, id]) => ({ owner, usedSlot, id })))
    .find((entry) => entry.id === itemId && !(entry.owner === hero && entry.usedSlot === slot));
  const reserve = save.looseEquipment[itemId] ?? 0;
  const current = save.equipment[hero]?.[slot];
  if (current === itemId) return save;
  if (!source && reserve <= 0) return null;

  const equipment = Object.fromEntries(Object.entries(save.equipment).map(([owner, slots]) => [owner, { ...slots }])) as SaveData["equipment"];
  const looseEquipment = { ...save.looseEquipment };
  if (source) delete equipment[source.owner]![source.usedSlot];
  else if (reserve === 1) delete looseEquipment[itemId];
  else looseEquipment[itemId] = reserve - 1;
  if (current) looseEquipment[current] = (looseEquipment[current] ?? 0) + 1;
  equipment[hero] = { ...(equipment[hero] ?? {}), [slot]: itemId };
  return { ...save, equipment, looseEquipment };
}
function hudBlank(): HudSnapshot {
  return {
    phase: "player",
    banner: null,
    selected: null,
    hoveredUnit: null,
    terrain: null,
    mode: "idle",
    canAttack: false,
    offHandKind: null,
    canLockpick: false,
    forecast: null,
    turn: 1,
    objective: "",
    missionTitle: "",
    playerAlive: 0,
    enemyAlive: 0,
    busy: false,
    result: null,
    winAvailable: false,
    canUndoMove: false,
    targetPrompt: null,
    zoom: 1,
    speedMode: "normal",
    tip: null,
    inspected: null,
    pendingFoe: null,
    spellReady: false,
    spellKind: null,
    turnQueue: [],
    log: [],
    chestLoot: null,
  };
}

/** The inn only acts as a rest stop after its own chapter has been completed. */
function innUnlocked(completed: string[]): boolean {
  return completed.includes("estalagem");
}

/** The player advances through a location chapter-by-chapter. A new location becomes
 * available only when every chapter in the prior populated location is complete. */
function previousPopulatedLocation(location: WorldLocation, locations: WorldLocation[]): WorldLocation | null {
  const at = locations.findIndex((candidate) => candidate.id === location.id);
  for (let i = at - 1; i >= 0; i -= 1) {
    const previous = locations[i]!;
    if (missionsForLocation(previous).length > 0) return previous;
  }
  return null;
}

function lockedMission(
  id: string,
  completed: string[],
  test: boolean,
  locations: WorldLocation[],
  fallbackOrder: string[],
): boolean {
  if (test) return false;
  if (completed.includes(id)) return true;

  const location = locations.find((candidate) => candidate.missionIds.includes(id));
  if (!location) {
    const at = fallbackOrder.indexOf(id);
    return at < 0 || (at > 0 && !fallbackOrder.slice(0, at).every((previousId) => completed.includes(previousId)));
  }

  const ids = missionsForLocation(location).map((mission) => mission.id);
  const at = ids.indexOf(id);
  if (at < 0) return true;
  if (at > 0) return !ids.slice(0, at).every((previousId) => completed.includes(previousId));

  const previousLocation = previousPopulatedLocation(location, locations);
  return previousLocation !== null && !missionsForLocation(previousLocation).every((mission) => completed.includes(mission.id));
}

function missionStatus(
  id: string,
  completed: string[],
  test: boolean,
  locations: WorldLocation[],
  fallbackOrder: string[],
): "locked" | "available" | "done" {
  if (completed.includes(id)) return "done";
  return lockedMission(id, completed, test, locations, fallbackOrder) ? "locked" : "available";
}

function locationStatus(
  location: WorldLocation,
  completed: string[],
  test: boolean,
  locations: WorldLocation[],
): "locked" | "available" | "done" {
  const missions = missionsForLocation(location);
  const next = missions.find((mission) => !completed.includes(mission.id));
  if (!next) return missions.length > 0 ? "done" : "locked";
  return missionStatus(next.id, completed, test, locations, missions.map((mission) => mission.id)) === "locked" ? "locked" : "available";
}

const BRIEF_ART: Record<string, string> = {
  vau: "/game/assets/brief-vau.jpg",
  bosque: "/game/assets/brief-bosque.jpg?v=2",
  aldeia: "/game/assets/brief-aldeia.jpg",
  muralha: "/game/assets/brief-muralha.jpg",
  fortaleza: "/game/assets/brief-fortaleza.jpg",
  templo: "/game/assets/brief-templo.jpg",
  cripta: "/game/assets/brief-cripta.jpg",
  estalagem: "/game/assets/brief-estalagem.jpg",
  colina: "/game/assets/brief-colina.jpg",
  passagem: "/game/assets/brief-passagem.jpg?v=2",
  vertente: "/game/assets/brief-vertente.jpg?v=2",
  portao: "/game/assets/brief-portao.jpg",
  profundezas: "/game/assets/profundezas-bg.jpg?v=2",
};

function briefArt(id: string): string | null {
  return BRIEF_ART[id] ?? null;
}

const HERO_PORTRAIT: Partial<Record<string, string>> = {
  kael: "/game/portraits/kael.png?v=2",
  nira: "/game/portraits/nira.png",
  voss: "/game/portraits/voss.png",
  salazar: "/game/portraits/salazar.png",
  malrec: "/game/portraits/malrec.png",
  aldric: "/game/portraits/aldric.png",
};

// Carried-bag icon follows the waist pouch equipped on that hero (small / large / satchel).
const BAG_ICON = pouchIcon(null);

type SlotAction = { kind: "spell"; spell: SpellKind } | { kind: "potion"; potion: PotionId };
const HOTBAR_SLOTS = 12;
/** Modo teste: Ember "infinito" pra testar compras/upgrades sem travar em custo. */
const TEST_EMBER = 900000;
const ALL_POTIONS: PotionId[] = ["weak", "mid", "potent", "disease", "manaSmall", "manaMid", "manaLarge"];
const HOTBAR_KEY = "ember-hotbar-v1";

// Prestige-only spells a promoted class adds on top of whatever its base class already
// granted (see classSpells below) — hybrid, nothing lost at PROMOTE_LEVEL. Second Wind isn't
// here: it's a passive the engine triggers itself from startOfTurnEffects (see SECOND_WIND in
// data.ts), never a hotbar cast — it still spends a tier-3 use through the same accounting,
// just automatically instead of by the player picking a slot.
const PRESTIGE_SPELLS: Partial<Record<ClassId, SpellKind[]>> = {
  paladin: ["cureLight", "auraOfProtection", "divineWrath"],
  heavyKnight: ["shoulderSmash", "intimidatingPresence", "stampede"],
};

function classSpells(classId: ClassId): SpellKind[] {
  // Promoted classes keep everything the base class already granted (hybrid, nothing
  // lost at PROMOTE_LEVEL), plus their own prestige-only spells from PRESTIGE_SPELLS.
  const base = ((): SpellKind[] => {
    switch (PROMOTED_BASE[classId] ?? classId) {
      case "swordsman":
        return ["doubleStrike", "cleave"];
      case "mage":
        return ["magicMissile", "lightning", "fireball", "causticVenom"];
      case "conjurer":
        // Phantasmal Force / Summon Swarm (tiers 3-4) join this list as they're built — see
        // SPELL_TIER for the intended tier assignment.
        return ["summonFamiliar", "webOfDreams"];
      case "archer":
        return ["longShot", "piercing", "multiShot"];
      case "healer":
        return ["cureMinor", "cureWounds", "cureDisease"];
      case "lancer":
        return ["piercingThrust", "sweep", "trip"];
      default:
        return [];
    }
  })();
  return [...base, ...(PRESTIGE_SPELLS[classId] ?? [])];
}

function defaultSlots(classId: ClassId): (SlotAction | null)[] {
  const combined: SlotAction[] = [
    ...classSpells(classId).map((spell): SlotAction => ({ kind: "spell", spell })),
    ...ALL_POTIONS.map((potion): SlotAction => ({ kind: "potion", potion })),
  ];
  const slots: (SlotAction | null)[] = combined.slice(0, HOTBAR_SLOTS);
  while (slots.length < HOTBAR_SLOTS) slots.push(null);
  return slots;
}

function loadHotbars(): Record<string, (SlotAction | null)[]> {
  try {
    const raw = window.localStorage.getItem(HOTBAR_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveHotbars(bars: Record<string, (SlotAction | null)[]>) {
  try {
    window.localStorage.setItem(HOTBAR_KEY, JSON.stringify(bars));
  } catch {
    // localStorage unavailable — hotbar just won't persist across reloads
  }
}

function slotIcon(action: SlotAction): string {
  if (action.kind === "potion") return `/game/icons/potion-${action.potion}.png?v=ds2`;
  switch (action.spell) {
    case "doubleStrike":
      return "/game/icons/cleave.png?v=ds2";
    case "cleave":
      return "/game/icons/cleave-crossed-blades.png?v=ds2";
    case "fireball":
      return "/game/icons/fireball.png?v=ds2";
    case "causticVenom":
      return "/game/icons/caustic-venom.png?v=ds2";
    case "lightning":
      return "/game/icons/lightning.png?v=ds2";
    case "magicMissile":
      return "/game/icons/magic-missile.png?v=ds2";
    case "longShot":
      return "/game/icons/long-shot.png?v=ds2";
    case "piercing":
      return "/game/icons/piercing.png?v=ds2";
    case "cureMinor":
      return "/game/icons/cure-minor.png?v=ds2";
    case "cureWounds":
      return "/game/icons/cure-wounds.png?v=ds2";
    case "cureDisease":
      return "/game/icons/cure-disease.png?v=ds2";
    case "piercingThrust":
      return "/game/icons/piercing-thrust.png?v=ds2";
    case "sweep":
      return "/game/icons/sweep.png?v=ds2";
    case "trip":
      return "/game/icons/trip.png?v=ds2";
    case "summonFamiliar":
      return "/game/icons/summon-familiar.png?v=ds2";
    case "webOfDreams":
      return "/game/icons/web-of-dreams.png?v=ds2";
    // No dedicated art exists yet for any of these — each reuses an existing icon whose
    // theme is closest (a zone effect, a big melee AOE, a holy/arcane burst). secondWind is
    // never actually shown (see PRESTIGE_SPELLS) but the switch must stay exhaustive.
    case "multiShot":
      return "/game/icons/long-shot.png?v=ds2";
    case "secondWind":
    case "cureLight":
      return "/game/icons/cure-wounds.png?v=ds2";
    case "auraOfProtection":
      return "/game/icons/web-of-dreams.png?v=ds2";
    case "intimidatingPresence":
      return "/game/icons/caustic-venom.png?v=ds2";
    case "divineWrath":
      return "/game/icons/fireball.png?v=ds2";
    case "shoulderSmash":
      return "/game/icons/cleave.png?v=ds2";
    case "stampede":
      return "/game/icons/cleave-crossed-blades.png?v=ds2";
  }
}

function slotLabel(action: SlotAction): string {
  if (action.kind === "potion") return potionLabel(action.potion);
  switch (action.spell) {
    case "doubleStrike":
      return DOUBLE_STRIKE.name;
    case "cleave":
      return CLEAVE.name;
    case "fireball":
      return FIREBALL.name;
    case "causticVenom":
      return CAUSTIC_VENOM.name;
    case "lightning":
      return LIGHTNING.name;
    case "magicMissile":
      return MAGIC_MISSILE.name;
    case "longShot":
      return LONG_SHOT.name;
    case "piercing":
      return PIERCING.name;
    case "cureMinor":
      return CURES.cureMinor.name;
    case "cureWounds":
      return CURES.cureWounds.name;
    case "cureDisease":
      return CURE_DISEASE.name;
    case "piercingThrust":
      return PIERCING_THRUST.name;
    case "sweep":
      return SWEEP.name;
    case "trip":
      return TRIP.name;
    case "summonFamiliar":
      return SUMMON_FAMILIAR.name;
    case "webOfDreams":
      return WEB_OF_DREAMS.name;
    case "multiShot":
      return MULTI_SHOT.name;
    case "secondWind":
      return SECOND_WIND.name;
    case "cureLight":
      return CURES.cureLight.name;
    case "auraOfProtection":
      return AURA_OF_PROTECTION.name;
    case "intimidatingPresence":
      return INTIMIDATING_PRESENCE.name;
    case "divineWrath":
      return DIVINE_WRATH.name;
    case "shoulderSmash":
      return SHOULDER_SMASH.name;
    case "stampede":
      return STAMPEDE.name;
  }
}

function slotTooltip(action: SlotAction): string {
  const label = slotLabel(action);
  if (action.kind === "potion") {
    const def = POTIONS[action.potion];
    if (def.effect === "mana") {
      const restore = def.manaRestore ?? 0;
      return `${label} · restaura ${restore} uso${restore === 1 ? "" : "s"} de cada magia que ainda tem carga disponível, sem passar do máximo de cada nível.`;
    }
  }
  return label;
}

function slotCount(action: SlotAction, unit: UnitPublic): number {
  if (action.kind === "potion") return unit.bag[action.potion];
  const tier = spellTier(action.spell);
  return tier ? unit.spells[tierKey(tier)] : 0;
}

export function GameApp() {
  const [resumeEditorDraft] = useState<MapDraft | null>(() => (typeof window === "undefined" ? null : readEditorResume()));
  const [screen, setScreen] = useState<ScreenId>(() => (resumeEditorDraft ? "mapEditor" : "title"));
  const [bank, setBank] = useState<SaveBank>(() => (typeof window === "undefined" ? { version: 7, lastSlot: 0, muted: false, slots: [null, null, null, null, null] } : loadBank()));
  const save = activeSave(bank);
  const [art, setArt] = useState<GameArt | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [missionId, setMissionId] = useState<string | null>(null);
  const [engine, setEngine] = useState<BattleEngine | null>(null);
  const [hud, setHud] = useState<HudSnapshot>(hudBlank);
  const [paused, setPaused] = useState(false);
  const [help, setHelp] = useState(false);
  const [muted, setMutedUi] = useState(() => (typeof window === "undefined" ? false : loadBank().muted));
  const muteReady = useRef(false);
  const [lastGrowth, setLastGrowth] = useState<GrowthLine[] | null>(null);
  const [lastLoot, setLastLoot] = useState<string[]>([]);
  const [pendingPromotions, setPendingPromotions] = useState<{ name: string; options: [ClassId, ClassId] }[]>([]);
  // Set right after a victory that leaves more chapters at the same location — the world
  // map opens with that location's chapter list already popped open instead of the bare
  // map, so a multi-mission location plays as one continuous series of combats.
  const [openLocationOnMap, setOpenLocationOnMap] = useState<string | null>(null);
  const [campaignLocations, setCampaignLocations] = useState<WorldLocation[]>(() => ALL_LOCATIONS);
  useEffect(() => {
    const applySavedLocations = (event: Event) => {
      const detail = (event as CustomEvent<{ missionOrder?: Record<string, string[]>; locationOrder?: string[] } | Record<string, string[]>>).detail;
      if (!detail || typeof detail !== "object") return;
      const missionOrder = "missionOrder" in detail ? detail.missionOrder : detail;
      const locationOrder = "locationOrder" in detail && Array.isArray(detail.locationOrder) ? detail.locationOrder : undefined;
      if (missionOrder && typeof missionOrder === "object") setCampaignLocations(locationsForOrder(missionOrder, locationOrder));
    };
    window.addEventListener("ember:locations-saved", applySavedLocations);
    return () => window.removeEventListener("ember:locations-saved", applySavedLocations);
  }, []);  const campaignMissions = useMemo(() => {
    const used = new Set<string>();
    const ordered = campaignLocations.flatMap((loc) =>
      loc.missionIds.flatMap((id) => {
        const mission = missionById(id);
        if (!mission || used.has(mission.id)) return [];
        used.add(mission.id);
        return [mission];
      }),
    );
    return [...ordered, ...ALL_MISSIONS.filter((mission) => !used.has(mission.id))];
  }, [campaignLocations]);
  const [testMode, setTestMode] = useState(false);
  const [testEmber, setTestEmber] = useState(TEST_EMBER);
  const awardedRef = useRef<string | null>(null);
  const combatStartRef = useRef<SaveData | null>(null);
  const [slotMode, setSlotMode] = useState<"new" | "continue" | "save" | "load" | null>(null);
  const [overwrite, setOverwrite] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    loadGameArt()
      .then((a) => {
        if (alive) setArt(a);
      })
      .catch((err: Error) => {
        if (alive) setLoadError(err.message);
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    setMuted(muted);
    if (!muteReady.current) {
      muteReady.current = true;
      return;
    }
    setBank((b) => setMutedBank(b, muted));
  }, [muted]);

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "visible") resumeAudio();
    };
    document.addEventListener("visibilitychange", onVis);
    const disarm = installAudioUnlock();
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      disarm();
    };
  }, []);

  const [customMission, setCustomMission] = useState<Mission | null>(null);
  /** The map open in the Map Editor, kept out here so a playtest — which unmounts that
   * screen — does not discard it. */
  const editorDraft = useRef<MapDraft | null>(resumeEditorDraft);
  const mission = customMission && customMission.id === missionId ? customMission : missionId ? resolveMission(missionId) : undefined;
  const hasProgress = hasAnySave(bank);

  useEffect(() => {
    if (resumeEditorDraft) clearEditorResume();
  }, [resumeEditorDraft]);

  const applySlot = (next: SaveBank) => {
    setBank(next);
    const rec = activeSave(next);
    combatStartRef.current = rec;
  };

  const persistCurrent = (data: SaveData, slot = bank.lastSlot) => {
    const next = writeSlot(bank, slot, { ...data, muted });
    applySlot(next);
    return next;
  };

  const enterFromSave = (rec: SaveData) => {
    setTestMode(false);
    setLastGrowth(null);
    setLastLoot([]);
    if (rec.pendingMission && resolveMission(rec.pendingMission)) {
      setMissionId(rec.pendingMission);
      setScreen("briefing");
      return;
    }
    setMissionId(null);
    setScreen("worldMap");
  };

  const startBattle = useCallback(
    (id: string, carried = save.unitHp, override?: Mission, playerLevels?: Record<string, number>, enemyLevels?: Record<string, number>) => {
      if (!art) return;
      // A real mission start (no override) always clears any leftover playtest identity —
      // otherwise a stale customMission from an earlier Map Editor session can collide
      // with a real campaign mission of the same id (missionToDraft now targets the real
      // id for versioning) and reroute a normal victory back into the editor.
      if (!override) {
        setCustomMission(null);
      }
      const m = override ?? resolveMission(id);
      if (!m) return;
      const levels: Record<string, number> = testMode
        ? override
          ? Object.fromEntries(m.playerSpawns.map((s) => [s.name, playerLevels?.[s.name] ?? m.index + 1]))
          : { Kael: m.index + 1, Neera: m.index + 1, Voss: m.index + 1, Salazar: m.index + 1 }
        : save.levels;
      const bags = testMode ? startingBags() : save.bags;
      // Partial progress toward the next level (not enough to level up yet) has to carry
      // into the battle same as levels/bags do — otherwise every mission start quietly
      // zeroes out whatever XP was left over from the previous one, most visibly when
      // replaying an already-completed mission with nothing left to kill.
      const xp = testMode ? undefined : save.xp;
      // Test mode always starts at full HP — half-HP carry-over only makes sense for real runs.
      const hp = testMode ? {} : { ...carried };
      if (!testMode) {
        const snapshot: SaveData = {
          ...save,
          unitHp: hp,
          levels,
          bags,
          pendingMission: id,
          muted,
        };
        combatStartRef.current = snapshot;
        persistCurrent(snapshot);
      }
      const promotions = testMode ? {} : save.promotions;
      const weapons = testMode
        ? undefined
        : Object.fromEntries(Object.entries(save.equipped).map(([hero, id]) => [hero, { id, enh: save.weapons[id] ?? 0 }]));
      const offHand = testMode
        ? undefined
        : Object.fromEntries(
            Object.entries(save.equipment)
              .map(([hero, e]) => [hero, e.offHand] as const)
              .filter((entry): entry is [string, string] => !!entry[1]),
          );
      // Every worn slot, not just the off-hand: gear contributes stats now (gearStatBonus),
      // so the battle needs the whole map rather than the one slot combat used to read.
      const equipment = testMode ? undefined : save.equipment;
      const ownedWeaponIds = testMode ? undefined : Object.keys(save.weapons);
      // Spell tier uses don't refill between missions within the same world-map location's
      // run (a "scenario") — only once the whole scenario is done, per direct instruction.
      // Stone Bridge (the tutorial) always resets, and so does the very first mission of any
      // scenario (nothing to carry over yet).
      const loc = campaignLocations.find((location) => location.missionIds.includes(m.id));
      const scenarioStart = !loc || loc.id === "stonebridge" || loc.missionIds.every((mid) => !save.completed.includes(mid));
      const spellSpent = testMode || scenarioStart ? undefined : save.spellUses;
      const battle = new BattleEngine(m, art, { hp, levels, bags, xp, promotions, weapons, offHand, equipment, enemyLevels, ownedWeaponIds, spellSpent }, Date.now() % 100000);
      if (typeof window !== "undefined" && window.innerWidth < 720) battle.zoom = 0;
      awardedRef.current = null;
      setEngine(battle);
      setMissionId(id);
      setHud(battle.getHud());
      setPaused(false);
      setSlotMode(null);
      setScreen("battle");
    },
    [art, save, testMode, muted, bank, campaignLocations],
  );

  const onHud = useCallback((next: HudSnapshot) => {
    setHud(next);
  }, []);

  useEffect(() => {
    if (screen !== "battle" || !hud.result) return;
    const t = window.setTimeout(() => {
      if (hud.result === "victory" && (missionId === "templo" || missionId === "portao")) {
        setScreen("epilogue");
        return;
      }
      if (hud.result) setScreen(hud.result);
    }, 1100);
    return () => window.clearTimeout(t);
  }, [hud.result, screen, missionId]);

  const persistVictory = useCallback(() => {
    if (!engine || !mission) return;
    const battleHp = engine.battlePlayerHp();
    const bags = engine.remainingBags();
    const growth: GrowthLine[] = [];
    const newPromotions: { name: string; options: [ClassId, ClassId] }[] = [];
    const levels = { ...save.levels };
    const xp = { ...(save.xp ?? {}) };
    const hp: Record<string, number> = {};
    for (const u of engine.units.filter((x) => x.side === "player")) {
      // Levels (and any level-ups from XP earned mid-battle) already happened live in the
      // engine — `from` is just whatever was on file before this mission started.
      const from = levels[u.name] ?? u.level;
      const to = u.level;
      const stFrom = statsFor(u.classId, from);
      const stTo = statsFor(u.classId, to);
      const mag = CLASSES[u.classId].mag > 0;
      const battle = battleHp[u.name] ?? u.hp;
      const healed = u.alive
        ? Math.min(stTo.hp, battle + Math.ceil((stTo.hp - battle) * 0.5))
        : Math.max(1, Math.ceil(stTo.hp * 0.5));
      const restHp = u.alive ? healed - battle : healed;
      hp[u.name] = healed;
      growth.push({
        name: u.name,
        from,
        to,
        hpBattle: battle,
        maxFrom: stFrom.hp,
        restHp,
        levelHp: stTo.hp - stFrom.hp,
        hpCamp: healed,
        maxTo: stTo.hp,
        powerFrom: mag ? stFrom.mag : stFrom.atk,
        powerTo: mag ? stTo.mag : stTo.atk,
        powerKind: mag ? "MAG" : "AT",
        atkFrom: stFrom.atk,
        atkTo: stTo.atk,
        magFrom: stFrom.mag,
        magTo: stTo.mag,
        defFrom: stFrom.def,
        defTo: stTo.def,
        resFrom: stFrom.res,
        resTo: stTo.res,
        fallen: !u.alive,
        xp: u.xp,
        xpFrom: from === to ? (save.xp?.[u.name] ?? 0) : 0,
        skillGain: from === to ? undefined : formatSpellUseGains(spellUseGains(u.classId, from, to)),
      });
      if (!testMode && u.alive) {
        levels[u.name] = to;
        xp[u.name] = u.xp;
      }
      const options = PROMOTIONS[u.classId];
      if (!testMode && u.alive && options && !save.promotions[u.name] && from < PROMOTE_LEVEL && to >= PROMOTE_LEVEL) {
        newPromotions.push({ name: u.name, options });
      }
    }
    setLastGrowth(growth);
    if (newPromotions.length > 0) setPendingPromotions(newPromotions);
    if (awardedRef.current === mission.id) return;
    awardedRef.current = mission.id;
    const completed = save.completed.includes(mission.id) ? save.completed : [...save.completed, mission.id];
    if (!testMode) {
      const loot = engine.units
        .filter((x) => x.side === "enemy" && !x.alive)
        .reduce((n, u) => n + emberForKill(u.classId), 0);
      const weapons = { ...save.weapons };
      const found: string[] = [];
      // Weapon drops are already resolved and logged live, in-battle, by the engine
      // (kill drops in markDead, chest loot in useLockpick — both ownership- and
      // mission-level-aware). This just folds engine.lootWeapons into the save; it used to
      // ALSO roll its own separate 15%-per-dead-enemy chance here, completely independent
      // of and in addition to the engine's roll, silently doubling the real drop odds.
      for (const id of engine.lootWeapons) {
        if (weapons[id] == null) {
          weapons[id] = 0;
          found.push(WEAPONS[id]!.name);
        }
      }
      // Equipment found in chests goes to the party's shared, unassigned stash — never
      // auto-equipped onto whoever happened to open the chest — so the player assigns it to
      // whichever hero they want from the Paperdoll picker afterward.
      const looseEquipment = { ...save.looseEquipment };
      for (const id of engine.lootEquipment) {
        looseEquipment[id] = (looseEquipment[id] ?? 0) + 1;
        found.push(EQUIPMENT[id]!.name);
      }
      setLastLoot(found);
      persistCurrent({
        ...save,
        completed,
        unitHp: hp,
        bags,
        levels,
        xp,
        weapons,
        looseEquipment,
        // engine.spentTiers() already reflects the full scenario-cumulative total (it was
        // seeded from save.spellUses at battle start unless this mission reset the
        // scenario) — a straight overwrite, not a merge.
        spellUses: engine.spentTiers(),
        ember: (save.ember ?? 0) + loot + engine.lootEmber,
        emberSeeded: true,
        muted,
        pendingMission: null,
      });
    }
  }, [engine, mission, save, testMode, muted, bank]);

  useEffect(() => {
    if (screen === "victory") persistVictory();
  }, [screen, persistVictory]);

  const choosePromotion = (name: string, classId: ClassId) => {
    sfxPlay.ui();
    persistCurrent({ ...save, promotions: { ...save.promotions, [name]: classId } });
    setPendingPromotions((list) => list.filter((p) => p.name !== name));
  };

  const bootAudio = () => {
    unlockAudio();
    sfxPlay.ui();
  };

  const openMission = (id: string) => {
    bootAudio();
    setCustomMission(null);
    setMissionId(id);
    setScreen("briefing");
  };

  const beginMission = () => {
    if (!missionId) return;
    bootAudio();
    if (missionId === "templo") {
      setScreen("cutscene");
      return;
    }
    // Only the actual inn opens the InnScreen. A user-authored map may retain an old hub flag.
    // It must still launch its own battle when selected from the campaign.
    if (missionId === "estalagem") {
      const completed = save.completed.includes(missionId) ? save.completed : [...save.completed, missionId];
      if (!testMode) persistCurrent({ ...save, completed, pendingMission: null });
      setScreen("inn");
      return;
    }
    startBattle(missionId);
  };

  useEffect(() => {
    if (muted) {
      stopMusic();
      return;
    }
    if (screen === "boot" || screen === "cutscene" || screen === "epilogue") {
      stopMusic();
      return;
    }
    // Victory/defeat and the mission briefing keep whatever track that mission plays
    // instead of falling through to the menu theme below — a win screen or a briefing
    // is still "in" that mission, not back at the title.
    const inMission = screen === "battle" || screen === "victory" || screen === "defeat" || screen === "briefing";
    // A mission that names its own track wins over every rule below: the chain of ids after
    // this is the default for missions that never picked one.
    // Only a track that is actually there wins: a name left behind by a renamed or removed
    // file falls through to the theme chain instead of leaving the mission silent.
    const named = inMission ? mission?.music : undefined;
    const chosen = named && MUSIC_TRACKS.includes(named) ? named : undefined;
    if (chosen) {
      playFile(chosen);
      return;
    }
    if (inMission && missionId === "templo") {
      playTheme("temple");
      return;
    }
    if (inMission && missionId === "aldeia") {
      playTheme("aldeia");
      return;
    }
    if (inMission && (missionId === "vau" || missionId === "bosque" || missionId === "cripta" || missionId === "vertente")) {
      playTheme("early");
      return;
    }
    if (screen === "inn") {
      playTheme("inn");
      return;
    }
    if (screen === "worldMap") {
      playTheme("worldMap");
      return;
    }
    if (inMission && (missionId === "muralha" || missionId === "fortaleza")) {
      playTheme("siege");
      return;
    }
    if (inMission && (missionId === "colina" || missionId === "passagem")) {
      playTheme("hill");
      return;
    }
    if (inMission && missionId === "portao") {
      playTheme("portao");
      return;
    }
    if (inMission) {
      playTheme("early");
      return;
    }
    playMenuMusic();
  }, [screen, muted, missionId]);

  const leaveBoot = useCallback(() => {
    // Entering the world map is a hard music boundary: do not leave intro.mp3 under it.
    playTheme("worldMap");
    setScreen("worldMap");
  }, []);

  const goToTitle = useCallback(() => {
    stopMusic();
    playMenuMusic();
    setScreen("title");
  }, []);

  return (
    <main className="relative h-dvh min-h-0 bg-bg text-fg overflow-hidden">
      {screen === "boot" && (
        <CutsceneScreen src="/game/title-open.mp4" muted={false} onSkip={leaveBoot} />
      )}
      {screen === "title" && (
        <TitleScreen
          ready={!!art}
          error={loadError}
          hasProgress={hasProgress}
          muted={muted}
          help={help}
          onMute={() => {
            unlockAudio();
            setMutedUi((v) => !v);
          }}
          onHelp={() => setHelp((v) => !v)}
          onNew={() => {
            bootAudio();
            setTestMode(false);
            setOverwrite(null);
            setSlotMode("new");
          }}
          onContinue={() => {
            bootAudio();
            setTestMode(false);
            setOverwrite(null);
            setSlotMode("continue");
          }}
          onTest={() => {
            bootAudio();
            setTestMode(true);
            setTestEmber(TEST_EMBER);
            setLastGrowth(null);
            setLastLoot([]);
            setMissionId(null);
            setScreen("testMenu");
          }}
        />
      )}

      {screen === "testMenu" && (
        <TestMenuScreen
          onBack={goToTitle}
          onDebug={() => setScreen("worldMap")}
          onMapEditor={() => setScreen("mapEditor")}
        />
      )}

      {screen === "mapEditor" && art && (
        <MapEditorScreen
          art={art}
          // The editor unmounts while a playtest runs, so the map being worked on is held
          // out here and handed back on return — otherwise testing a map threw it away.
          initialDraft={editorDraft.current}
          onDraftChange={(d) => {
            editorDraft.current = d;
          }}
          onBack={() => { clearEditorResume(); setScreen("testMenu"); }}
          onPlaytest={(m, playerLevels, enemyLevels) => {
            setCustomMission(m);
            startBattle(m.id, {}, m, playerLevels, enemyLevels);
          }}
        />
      )}

      {screen === "campaign" && (
        <CampaignScreen
          missions={campaignMissions}
          locations={campaignLocations}
          completed={save.completed}
          test={testMode}
          ember={testMode ? testEmber : (save.ember ?? 0)}
          onBack={() => (testMode ? setScreen("testMenu") : setScreen("worldMap"))}
          onPick={openMission}
        />
      )}

      {screen === "worldMap" && (
        <WorldMapScreen
          locations={campaignLocations}
          status={(loc) => locationStatus(loc, save.completed, testMode, campaignLocations)}
          missionStatus={(id) => missionStatus(id, save.completed, testMode, campaignLocations, campaignMissions.map((mission) => mission.id))}
          ember={testMode ? testEmber : (save.ember ?? 0)}
          test={testMode}
          muted={muted}
          onMute={() => {
            unlockAudio();
            setMutedUi((v) => !v);
          }}
          autoOpenLocationId={openLocationOnMap}
          centerLocationId={campaignLocations.find((location) => location.missionIds.some((id) => !save.completed.includes(id)))?.id ?? null}
          onBack={() => setScreen(testMode ? "testMenu" : "title")}
          onPick={openMission}
          onOpenList={() => setScreen("campaign")}
        />
      )}

      {screen === "briefing" && mission && (
        <BriefingScreen mission={mission} onBack={() => setScreen("worldMap")} onStart={beginMission} />
      )}

      {screen === "inn" && (
        <InnScreen
          bags={save.bags}
          ember={testMode ? testEmber : (save.ember ?? 0)}
          muted={muted}
          weapons={save.weapons}
          equipped={save.equipped}
          heroClass={Object.fromEntries(DEFAULT_HEROES.map((h) => [h.name, save.promotions[h.name] ?? h.classId]))}
          save={testMode ? { ...save, ember: testEmber } : save}
          onMute={() => {
            unlockAudio();
            setMutedUi((v) => !v);
          }}
          onLeave={() => setScreen("worldMap")}
          onBuyWeapon={(hero: string, weaponId: string) => {
            const rec = activeSave(bank);
            const w = WEAPONS[weaponId];
            if (!w || rec.weapons[weaponId] != null) return false;
            const held = testMode ? testEmber : (rec.ember ?? 0);
            if (held < w.price) return false;
            if (testMode) setTestEmber(held - w.price);
            persistCurrent({
              ...rec,
              ember: testMode ? rec.ember ?? 0 : held - w.price,
              emberSeeded: true,
              weapons: { ...rec.weapons, [weaponId]: 0 },
              pendingMission: null,
            });
            return true;
          }}
          onEquipWeapon={(hero: string, weaponId: string) => {
            const rec = activeSave(bank);
            const next = equipSharedWeapon(rec, hero, weaponId);
            if (next) persistCurrent({ ...next, pendingMission: null });
          }}
          onEquipItem={(hero: string, slot: EquipSlot, itemId: string) => {
            const rec = activeSave(bank);
            const next = equipSharedItem(rec, hero, slot, itemId);
            if (next) persistCurrent({ ...next, pendingMission: null });
          }}
          onUpgradeWeapon={(weaponId: string) => {
            const rec = activeSave(bank);
            const enh = rec.weapons[weaponId] ?? 0;
            if (enh >= WEAPON_MAX_ENH) return false;
            const cost = weaponEnhCost(enh + 1);
            const held = testMode ? testEmber : (rec.ember ?? 0);
            if (held < cost) return false;
            if (testMode) setTestEmber(held - cost);
            persistCurrent({
              ...rec,
              ember: testMode ? rec.ember ?? 0 : held - cost,
              emberSeeded: true,
              weapons: { ...rec.weapons, [weaponId]: enh + 1 },
              pendingMission: null,
            });
            return true;
          }}
          onSellWeapon={(weaponId: string) => {
            const rec = activeSave(bank);
            const enh = rec.weapons[weaponId];
            if (enh == null) return false;
            const value = weaponSellValue(weaponId, enh);
            const held = testMode ? testEmber : (rec.ember ?? 0);
            if (testMode) setTestEmber(held + value);
            const weapons = { ...rec.weapons };
            delete weapons[weaponId];
            const equipped = { ...rec.equipped };
            for (const hero of Object.keys(equipped)) {
              if (equipped[hero] === weaponId) delete equipped[hero];
            }
            persistCurrent({
              ...rec,
              ember: testMode ? rec.ember ?? 0 : held + value,
              emberSeeded: true,
              weapons,
              equipped,
              pendingMission: null,
            });
            return value;
          }}
          onPay={(hero: string, cart: Record<PotionId, number>, lockpicks: number) => {
            const rec = activeSave(bank);
            let cost = 0;
            const bag = { ...(rec.bags[hero] ?? startingBags()[hero]) };
            for (const kind of Object.keys(cart) as PotionId[]) {
              const qty = cart[kind] ?? 0;
              if (qty <= 0) continue;
              if ((bag[kind] ?? 0) + qty > POTION_CARRY_MAX[kind]) return false;
              cost += POTION_PRICE[kind] * qty;
              bag[kind] = (bag[kind] ?? 0) + qty;
            }
            if (lockpicks > 0) {
              if ((bag.lockpick ?? 0) + lockpicks > BAG_MAX) return false;
              cost += LOCKPICK_PRICE * lockpicks;
              bag.lockpick = (bag.lockpick ?? 0) + lockpicks;
            }
            const held = testMode ? testEmber : (rec.ember ?? 0);
            if (cost <= 0 || held < cost) return false;
            if (testMode) setTestEmber(held - cost);
            persistCurrent({
              ...rec,
              ember: testMode ? rec.ember ?? 0 : held - cost,
              emberSeeded: true,
              bags: { ...rec.bags, [hero]: bag },
              pendingMission: null,
            });
            return true;
          }}
        />
      )}

      {screen === "cutscene" && (
        <CutsceneScreen src="/game/asherah-rite.mp4" muted={muted} onSkip={() => startBattle("templo")} />
      )}

      {screen === "epilogue" && (
        <CutsceneScreen
          src={missionId === "portao" ? "/game/portao-end.mp4" : "/game/temple-aftermath.mp4"}
          muted={muted}
          onSkip={() => setScreen("victory")}
        />
      )}

      {screen === "battle" && engine && (
        <BattleScreen
          engine={engine}
          hud={hud}
          paused={paused}
          muted={muted}
          save={save}
          playtest={!!customMission}
          // Gear swapped during a fight is permanent, so it lands in the save the moment it
          // happens rather than waiting for a victory that may never come. `alsoOwn` marks a
          // piece that came out of a chest this battle: the engine has already removed it
          // from the loot list, so recording ownership here is what keeps it.
          onEquipWeapon={(hero, weaponId, alsoOwn) => {
            const rec = activeSave(bank);
            const owned = alsoOwn && rec.weapons[weaponId] == null ? { ...rec, weapons: { ...rec.weapons, [weaponId]: 0 } } : rec;
            const next = equipSharedWeapon(owned, hero, weaponId);
            if (next) persistCurrent(next);
          }}
          onEquipItem={(hero, slot, itemId, alsoOwn) => {
            const rec = activeSave(bank);
            const owned = alsoOwn ? { ...rec, looseEquipment: { ...rec.looseEquipment, [itemId]: (rec.looseEquipment[itemId] ?? 0) + 1 } } : rec;
            const next = equipSharedItem(owned, hero, slot, itemId);
            if (next) persistCurrent(next);
          }}
          onHud={onHud}
          onPause={() => setPaused(true)}
          onResume={() => {
            setSlotMode(null);
            setOverwrite(null);
            setPaused(false);
          }}
          onMute={() => {
            unlockAudio();
            setMutedUi((v) => !v);
          }}
          onSave={() => {
            setOverwrite(null);
            setSlotMode("save");
          }}
          onLoad={() => {
            setOverwrite(null);
            setSlotMode("load");
          }}
          onQuit={() => {
            setPaused(false);
            setSlotMode(null);
            setEngine(null);
            // A playtest belongs to the editor: end it and you are back where you were,
            // with the map still loaded. Quitting a real mission still exits to the map.
            if (customMission) {
              setCustomMission(null);
              setScreen("mapEditor");
              return;
            }
            setScreen("worldMap");
          }}
        />
      )}

      {screen === "victory" && mission && (
        <ResultScreen
          win
          title={mission.title}
          body="O campo ficou em silêncio."
          turn={hud.turn}
          growth={lastGrowth}
          loot={lastLoot}
          art={briefArt(mission.id)}
          innOpen={!customMission && innUnlocked(save.completed) && mission.index <= 11}
          onInn={() => {
            setMissionId("estalagem");
            setScreen("inn");
          }}
          onMap={() => {
            if (customMission) {
              setCustomMission(null);
              setScreen("mapEditor");
              return;
            }
            // Recomputed rather than read off save.completed directly — testMode never
            // persists, so save.completed wouldn't yet include this mission there.
            const completed = save.completed.includes(mission.id) ? save.completed : [...save.completed, mission.id];
            const loc = campaignLocations.find((location) => location.missionIds.includes(mission.id));
            const scenarioDone = !loc || loc.missionIds.every((id) => completed.includes(id));
            // Mid-scenario: reopen the world map straight onto this mission's location so
            // its list pops open immediately — a multi-mission location plays as one
            // continuous series of combats instead of dropping back to the bare map after
            // every fight. Once the whole scenario is done, leave no location open — the
            // map's own centerLocationId already re-centers on wherever's next.
            setOpenLocationOnMap(scenarioDone ? null : (loc?.id ?? null));
            setScreen("worldMap");
          }}
          mapLabel={customMission ? "Voltar ao editor" : "Mapa"}
          onTitle={goToTitle}
          // The raw "next mission by global index" shortcut this used to offer could skip
          // straight past an entire other location (missions aren't numbered in location
          // order) — hasNext is always false below now, so this never fires; onMap is the
          // one continue path, and it's location-aware.
          onNext={() => {}}
          hasNext={false}
        />
      )}

      {screen === "victory" && pendingPromotions.length > 0 && (
        <PromotionScreen pending={pendingPromotions} onPick={choosePromotion} />
      )}

      {screen === "defeat" && mission && (
        <ResultScreen
          win={false}
          title={mission.title}
          body="A linha quebrou."
          turn={hud.turn}
          growth={null}
          art={briefArt(mission.id)}
          onTitle={goToTitle}
          onNext={() => startBattle(mission.id, save.unitHp, customMission ?? undefined)}
          onMap={
            customMission
              ? () => {
                  setCustomMission(null);
                  setScreen("mapEditor");
                }
              : undefined
          }
          mapLabel={customMission ? "Voltar ao editor" : undefined}
          hasNext
          retry
        />
      )}

      {slotMode && (
        <SlotScreen
          mode={slotMode}
          bank={bank}
          overwrite={overwrite}
          onOverwrite={setOverwrite}
          onClose={() => {
            setSlotMode(null);
            setOverwrite(null);
          }}
          onPick={(index) => {
            bootAudio();
            if (slotMode === "new") {
              const next = writeSlot(bank, index, emptySave(muted));
              applySlot(next);
              setSlotMode(null);
              setOverwrite(null);
              setLastGrowth(null);
              setLastLoot([]);
              setMissionId(null);
              setEngine(null);
              setScreen("boot");
              return;
            }
            if (slotMode === "continue" || slotMode === "load") {
              const rec = bank.slots[index];
              if (!rec) return;
              const next = selectSlot(bank, index);
              applySlot(next);
              setSlotMode(null);
              setOverwrite(null);
              setPaused(false);
              setEngine(null);
              enterFromSave(rec);
              return;
            }
            const snapshot = combatStartRef.current ?? { ...save, pendingMission: missionId, muted };
            const next = writeSlot(bank, index, snapshot);
            applySlot(next);
            setSlotMode(null);
            setOverwrite(null);
            setPaused(false);
          }}
        />
      )}
    </main>
  );
}

function CutsceneScreen({
  src,
  muted,
  onSkip,
}: {
  src: string;
  muted: boolean;
  onSkip: () => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [portrait, setPortrait] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(max-width: 720px) and (orientation: portrait)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 720px) and (orientation: portrait)");
    const sync = () => setPortrait(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    const ori = screen.orientation as ScreenOrientation & { lock?: (mode: string) => Promise<void>; unlock?: () => void };
    void ori.lock?.("landscape").catch(() => {});
    return () => {
      mq.removeEventListener("change", sync);
      try {
        ori.unlock?.();
      } catch {
        /* ignore */
      }
    };
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.muted = muted;
    const kick = () => {
      void el.play().catch(() => {
        el.muted = true;
        void el.play().catch(() => {});
      });
    };
    kick();
    el.addEventListener("canplay", kick);
    const t = window.setTimeout(onSkip, 20000);
    return () => {
      el.removeEventListener("canplay", kick);
      window.clearTimeout(t);
    };
  }, [muted, src, onSkip]);
  return (
    <section className="relative h-dvh w-dvw bg-black overflow-hidden">
      <div className="cutscene-stage">
        <video ref={ref} src={src} playsInline autoPlay preload="auto" onEnded={onSkip} onError={onSkip} />
      </div>
      {portrait && (
        <p className="pointer-events-none absolute inset-x-0 top-[max(0.75rem,env(safe-area-inset-top))] text-center text-[11px] tracking-[0.16em] uppercase text-muted">
          Deite o telefone
        </p>
      )}
      <div className="absolute inset-x-0 bottom-0 z-10 p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] flex justify-end">
        <Button size="md" variant="ghost" onClick={onSkip}>
          Pular
        </Button>
      </div>
    </section>
  );
}

function TitleScreen({
  ready,
  error,
  hasProgress,
  muted,
  help,
  onMute,
  onHelp,
  onNew,
  onContinue,
  onTest,
}: {
  ready: boolean;
  error: string | null;
  hasProgress: boolean;
  muted: boolean;
  help: boolean;
  onMute: () => void;
  onHelp: () => void;
  onNew: () => void;
  onContinue: () => void;
  onTest: () => void;
}) {
  return (
    <section className="relative min-h-dvh flex flex-col overflow-hidden">
      <div className="title-hero absolute inset-0" aria-hidden />
      <div className="title-veil absolute inset-0" />
      <header className="relative z-10 flex items-center justify-end px-4 pt-[max(1.25rem,env(safe-area-inset-top))]">
        <button
          type="button"
          onClick={onMute}
          className="size-11 grid place-items-center rounded-md border border-border text-fg"
          aria-label={muted ? "Ativar som" : "Silenciar"}
        >
          {muted ? <VolumeX className="size-5" /> : <Volume2 className="size-5" />}
        </button>
      </header>
      <div className="relative z-10 flex flex-1 flex-col justify-end px-5 pb-[max(1.5rem,env(safe-area-inset-bottom))] max-w-xl mx-auto w-full">
        <p className="text-sm tracking-[0.28em] uppercase text-muted mb-3">Táticas em cinzas</p>
        <h1 className="font-display text-5xl sm:text-7xl font-medium tracking-tight leading-none mb-4">Ember</h1>
        <p className="text-[11px] tracking-[0.18em] uppercase text-muted -mt-3 mb-4">Version {DISPLAY_VERSION}</p>
        <p className="text-muted text-base leading-relaxed mb-8 max-w-md">
          Seis sobreviventes. Um tabuleiro de guerra. Cada casa conta.
        </p>
        <div className="flex flex-col gap-3">
          <Button size="xl" disabled={!ready} onClick={onNew}>
            {ready ? "Nova campanha" : "Carregando…"}
          </Button>
          {hasProgress && (
            <Button size="lg" variant="ghost" disabled={!ready} onClick={onContinue}>
              Continuar
            </Button>
          )}
          <Button size="lg" variant="quiet" onClick={onHelp}>
            Como jogar
          </Button>
          <Button size="lg" variant="ghost" disabled={!ready} onClick={onTest}>
            Modo teste
          </Button>
        </div>
        {error && <p className="mt-4 text-sm text-danger">{error}</p>}
      </div>
      {help && <HelpModal onClose={onHelp} />}
    </section>
  );
}

/** One entry per casting-speed tier: which classes share it, one classId to read the table
 * from (every class in the group has identical numbers), and how many tiers it goes up to.
 * Class names, not hero names — keeps it about the role, not who's playing it. */
const SKILL_SPEED_GROUPS: { label: string; classes: string; classId: ClassId; maxTier: number }[] = [
  {
    label: "Conjuração Rápida",
    classes: ["mage", "conjurer", "healer", "elementalist", "sorcerer", "bishop"].map((c) => CLASSES[c as ClassId].name).join(", "),
    classId: "mage",
    maxTier: 10,
  },
  {
    label: "Conjuração Média",
    classes: ["archer", "warlock", "necromancer", "cleric", "paladin", "assassin", "templar"].map((c) => CLASSES[c as ClassId].name).join(", "),
    classId: "archer",
    maxTier: 8,
  },
  {
    label: "Conjuração Lenta",
    classes: ["swordsman", "lancer", "heavyKnight", "ranger", "sentinel"].map((c) => CLASSES[c as ClassId].name).join(", "),
    classId: "swordsman",
    maxTier: 6,
  },
];

/** One row per potion in the loot-weighted pick (weightedPotionPick) — % chance is its share
 * of the total weight across every potion, so this always matches what's actually rolled. */
const POTION_LOOT_ROWS: { name: string; weight: number }[] = (Object.entries(POTION_LOOT_WEIGHT) as [keyof typeof POTION_LOOT_WEIGHT, number][]).map(
  ([id, weight]) => ({ name: POTIONS[id].name, weight }),
);
const POTION_LOOT_TOTAL = POTION_LOOT_ROWS.reduce((n, r) => n + r.weight, 0);

/** One entry per skill/spell tier slot (SPELL_TIER's own keys) — tier, damage formula (a
 * plain string for flat skills, or a function of the caster's MAG for the ones that scale),
 * and a one-line effect note. Kept next to SPELL_TIER by hand since a skill's shape
 * (splash, line, status effect) isn't data SPELL_TIER itself carries.
 *
 * The scaling ones take MAG rather than level: a spell weights the caster's own power now
 * instead of growing on a table of its own. */
/** Which base class a skill belongs to — inverted from classSpells (promoted classes keep
 * their base class's list, so this only ever needs the six base owners). */
const SKILL_CLASS: Partial<Record<SpellKind, ClassId>> = {
  doubleStrike: "swordsman",
  cleave: "swordsman",
  magicMissile: "mage",
  lightning: "mage",
  fireball: "mage",
  causticVenom: "mage",
  summonFamiliar: "conjurer",
  webOfDreams: "conjurer",
  longShot: "archer",
  piercing: "archer",
  cureMinor: "healer",
  cureWounds: "healer",
  cureDisease: "healer",
  piercingThrust: "lancer",
  sweep: "lancer",
  trip: "lancer",
  multiShot: "archer",
  secondWind: "paladin",
  cureLight: "paladin",
  auraOfProtection: "paladin",
  divineWrath: "paladin",
  shoulderSmash: "heavyKnight",
  intimidatingPresence: "heavyKnight",
  stampede: "heavyKnight",
};

const SKILL_DAMAGE_ROWS: { name: string; cls: ClassId; tier: SpellTier; formula: string | ((x: number) => string); param?: "level"; note: string }[] = [
  { name: MAGIC_MISSILE.name, cls: SKILL_CLASS.magicMissile!, tier: spellTier("magicMissile")!, formula: (mag: number) => spellFormula(mag, MAGIC_MISSILE.mul, MAGIC_MISSILE.dice, MAGIC_MISSILE.faces, MAGIC_MISSILE.bonus), note: "Nunca erra. 1 míssil, 2 no nível 3, 3 no nível 6 — um alvo cada." },
  {
    name: LONG_SHOT.name,
    cls: SKILL_CLASS.longShot!,
    tier: spellTier("longShot")!,
    formula: (level: number) => longShotFormula(level),
    param: "level" as const,
    note: `Alcance ×${LONG_SHOT.rangeMul}+${LONG_SHOT.rangeBonus}. Dado sobe em níveis 2,3,5,7,9,12,14.`,
  },
  { name: CURES.cureMinor.name, cls: SKILL_CLASS.cureMinor!, tier: spellTier("cureMinor")!, formula: (mag: number) => `${healFormula(mag, "cureMinor")} (cura)`, note: "—" },
  {
    name: DOUBLE_STRIKE.name,
    cls: SKILL_CLASS.doubleStrike!,
    tier: spellTier("doubleStrike")!,
    formula: (level: number) => doubleStrikeFormula(level),
    param: "level" as const,
    note: "Ataca duas vezes; cada acerto rola seu próprio bônus (não acumula).",
  },
  { name: PIERCING_THRUST.name, cls: SKILL_CLASS.piercingThrust!, tier: spellTier("piercingThrust")!, formula: `dano de arma, −${Math.round(PIERCING_THRUST.armorIgnore * 100)}% armadura`, note: "Acerta em linha; o segundo alvo recebe metade." },
  { name: SUMMON_FAMILIAR.name, cls: SKILL_CLASS.summonFamiliar!, tier: spellTier("summonFamiliar")!, formula: "—", note: `Invoca aliado com ${Math.round(SUMMON_FAMILIAR.statScale * 100)}% dos atributos atuais.` },
  {
    name: LIGHTNING.name,
    cls: SKILL_CLASS.lightning!,
    tier: spellTier("lightning")!,
    formula: (mag: number) => lightningFormula(mag),
    note: `Eco em outro alvo adjacente: ${diceFormula(LIGHTNING.echoDice, LIGHTNING.echoFaces, LIGHTNING.echoBonus)}.`,
  },
  {
    name: PIERCING.name,
    cls: SKILL_CLASS.piercing!,
    tier: spellTier("piercing")!,
    formula: (level: number) => `${piercingMul(level)}× dano de arma`,
    param: "level" as const,
    note: "Multiplicador sobe nos níveis 6, 10 e 13.",
  },
  { name: CURES.cureWounds.name, cls: SKILL_CLASS.cureWounds!, tier: spellTier("cureWounds")!, formula: (mag: number) => `${healFormula(mag, "cureWounds")} (cura)`, note: "—" },
  {
    name: CLEAVE.name,
    cls: SKILL_CLASS.cleave!,
    tier: spellTier("cleave")!,
    formula: (level: number) => cleaveFormula(level),
    param: "level" as const,
    note: `Atinge até ${CLEAVE.hexes} hexes. x${CLEAVE.largeMul} em criaturas grandes (${CLEAVE.largeHexes}+ hexes). Dado sobe nos níveis 9, 11 e 14.`,
  },
  { name: SWEEP.name, cls: SKILL_CLASS.sweep!, tier: spellTier("sweep")!, formula: "dano de arma", note: `Todos os inimigos adjacentes; empurra ${SWEEP.knockback} hex.` },
  {
    name: WEB_OF_DREAMS.name,
    cls: SKILL_CLASS.webOfDreams!,
    tier: spellTier("webOfDreams")!,
    formula: "—",
    note: `${Math.round(WEB_OF_DREAMS.sleepChance * 100)}% de dormir por ${diceFormula(WEB_OF_DREAMS.sleepDice, WEB_OF_DREAMS.sleepFaces, 0)} turnos (+${Math.round(WEB_OF_DREAMS.sleepBonusDamage * 100)}% dano ao acordar); prende o movimento a 1 hex na área por ${WEB_OF_DREAMS.durationRounds} turnos.`,
  },
  { name: TRIP.name, cls: SKILL_CLASS.trip!, tier: spellTier("trip")!, formula: `arma +${diceFormula(1, TRIP.bonusFaces, TRIP.bonusBonus)}`, note: `Atordoa ${TRIP.stunRounds} turnos; −${Math.round(TRIP.statPenalty * 100)}% de status pro resto da batalha.` },
  {
    name: FIREBALL.name,
    cls: SKILL_CLASS.fireball!,
    tier: spellTier("fireball")!,
    formula: (mag: number) => fireballFormula(mag),
    note: `Área de raio ${FIREBALL.size}.`,
  },
  { name: CURE_DISEASE.name, cls: SKILL_CLASS.cureDisease!, tier: spellTier("cureDisease")!, formula: "—", note: "Cura doença." },
  {
    name: CAUSTIC_VENOM.name,
    cls: SKILL_CLASS.causticVenom!,
    tier: spellTier("causticVenom")!,
    formula: (mag: number) =>
      `centro ${spellFormula(mag, CAUSTIC_VENOM.centerMul, CAUSTIC_VENOM.centerDice, CAUSTIC_VENOM.centerFaces, CAUSTIC_VENOM.centerBonus)} · respingo ${spellFormula(mag, CAUSTIC_VENOM.splashMul, CAUSTIC_VENOM.splashDice, CAUSTIC_VENOM.splashFaces, CAUSTIC_VENOM.splashBonus)}`,
    note: `Envenena: 1D4 no início de cada turno do alvo, até curado. Área de raio ${CAUSTIC_VENOM.size}, pega os dois lados.`,
  },
  {
    name: MULTI_SHOT.name,
    cls: SKILL_CLASS.multiShot!,
    tier: spellTier("multiShot")!,
    formula: (level: number) => multiShotFormula(level),
    param: "level" as const,
    note: `2 alvos (3 no nível 11), alcance arma+${MULTI_SHOT.rangeBonus}. Dado sobe no nível 8 e 13.`,
  },
  {
    name: SECOND_WIND.name,
    cls: SKILL_CLASS.secondWind!,
    tier: spellTier("secondWind")!,
    formula: (level: number) => `${Math.round(secondWindPct(level) * 100)}% de RES`,
    param: "level" as const,
    note: `Passiva: cura sozinho ao cair a ${Math.round(SECOND_WIND.badlyWoundedPct * 100)}% de HP ou menos. Não é um golpe do atalho.`,
  },
  { name: CURES.cureLight.name, cls: SKILL_CLASS.cureLight!, tier: spellTier("cureLight")!, formula: (mag: number) => `${healFormula(mag, "cureLight")} (cura)`, note: "Igual à Cura Média da Clériga, usos próprios do Paladino." },
  {
    name: AURA_OF_PROTECTION.name,
    cls: SKILL_CLASS.auraOfProtection!,
    tier: spellTier("auraOfProtection")!,
    formula: (level: number) => {
      const p = auraPower(level);
      return `raio ${p.radius}, −${Math.round(p.pct * 100)}% dano, ${p.duration} rodadas`;
    },
    param: "level" as const,
    note: "Instantânea, centrada em si mesmo — sem mira. Escala nos níveis 20, 22, 24, 26, 28 e 30.",
  },
  {
    name: DIVINE_WRATH.name,
    cls: SKILL_CLASS.divineWrath!,
    tier: spellTier("divineWrath")!,
    formula: (level: number) => {
      const p = divineWrathPower(level);
      return `arma + MAG/2 + ${diceFormula(p.dice, p.faces, 0)}`;
    },
    param: "level" as const,
    note: `Linha reta mirada, alcance ${DIVINE_WRATH.range} — nunca atinge aliados. Dado sobe nos níveis 19, 22, 26 e 30.`,
  },
  {
    name: SHOULDER_SMASH.name,
    cls: SKILL_CLASS.shoulderSmash!,
    tier: spellTier("shoulderSmash")!,
    formula: (level: number) => shoulderSmashFormula(level),
    param: "level" as const,
    note: `Requer sem escudo. Arco de hexes cresce até 4; empurra ${SHOULDER_SMASH.knockback} hexes.`,
  },
  {
    name: INTIMIDATING_PRESENCE.name,
    cls: SKILL_CLASS.intimidatingPresence!,
    tier: spellTier("intimidatingPresence")!,
    formula: (level: number) => {
      const p = auraPower(level);
      return `raio ${p.radius}, +${Math.round(p.pct * 100)}% dano, ${p.duration} rodadas`;
    },
    param: "level" as const,
    note: "Instantânea, centrada em si mesmo — o oposto da Aura de Proteção, mesma escala.",
  },
  {
    name: STAMPEDE.name,
    cls: SKILL_CLASS.stampede!,
    tier: spellTier("stampede")!,
    formula: (level: number) => stampedeFormula(level),
    param: "level" as const,
    note: `Linha reta mirada, alcance ${STAMPEDE.range} — atinge aliados também. Dado sobe nos níveis 21, 24, 27 e 30.`,
  },
].sort((a, b) => a.tier - b.tier);

function HelpModal({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<"basicos" | "tabelas" | "loot" | "dano">("basicos");
  return (
    <div className="absolute inset-0 z-20 bg-bg/80 flex items-end sm:items-center justify-center p-4">
      <div className="w-full max-w-lg max-h-[85dvh] overflow-y-auto bg-surface border border-border rounded-xl p-6">
        <div className="flex items-start justify-between gap-4 mb-4">
          <h2 className="font-display text-2xl">Como jogar</h2>
          <button type="button" onClick={onClose} className="size-11 grid place-items-center" aria-label="Fechar">
            <X className="size-5" />
          </button>
        </div>
        <div className="flex gap-1 mb-4 border-b border-border">
          <button
            type="button"
            onClick={() => setTab("basicos")}
            className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px ${tab === "basicos" ? "border-accent text-fg" : "border-transparent text-muted"}`}
          >
            Básicos
          </button>
          <button
            type="button"
            onClick={() => setTab("tabelas")}
            className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px ${tab === "tabelas" ? "border-accent text-fg" : "border-transparent text-muted"}`}
          >
            Usos
          </button>
          <button
            type="button"
            onClick={() => setTab("dano")}
            className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px ${tab === "dano" ? "border-accent text-fg" : "border-transparent text-muted"}`}
          >
            Dano
          </button>
          <button
            type="button"
            onClick={() => setTab("loot")}
            className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px ${tab === "loot" ? "border-accent text-fg" : "border-transparent text-muted"}`}
          >
            Loot
          </button>
        </div>
        {tab === "basicos" ? (
          <ul className="space-y-3 text-sm text-muted leading-relaxed">
            <li>Toque numa aliada para ver movimento (azul) e ataque (vermelho).</li>
            <li>Toque num inimigo para ver HP, alcance e a área vermelha de perigo.</li>
            <li>Golpe de arma: AT − DF, dentro do alcance da ficha.</li>
            <li>Magia ofensiva: o dado − RES, no alcance da magia.</li>
            <li>Todo mundo tem AT, MAG, DF, RES, Mov e Alc. Nada fica de fora da ficha.</li>
            <li>Terreno alto (barranco, tronco morto, casa abandonada): +2 de dano. A arqueira também ganha +1 de alcance. No alto, outro hex alto na frente não corta a flecha.</li>
            <li>Barricada (estacas, 3 hexes): ninguém passa. De trás você atira. Projéteis não acertam quem está atrás.</li>
            <li>Depois de mover, dois cliques no personagem = Esperar e passa ao próximo.</li>
          </ul>
        ) : tab === "tabelas" ? (
          <div className="space-y-5">
            <p className="text-sm text-muted leading-relaxed">
              Cada classe tem uma velocidade de conjuração — ela decide quantos usos de cada tier (1 a 5) a
              classe tem em cada nível. As tabelas abaixo mostram os números exatos, nível a nível.
            </p>
            {SKILL_SPEED_GROUPS.map((g) => (
              <div key={g.label}>
                <p className="text-sm font-medium">
                  {g.label} <span className="text-muted font-normal">· {g.classes}</span>
                </p>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs tabular-nums border-collapse">
                    <thead>
                      <tr className="text-muted">
                        <th className="text-left font-normal pr-2 py-1">Nv</th>
                        {Array.from({ length: g.maxTier }, (_, i) => i + 1).map((t) => (
                          <th key={t} className="text-right font-normal px-1.5 py-1">
                            T{t}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {Array.from({ length: MAX_LEVEL }, (_, i) => i + 1).map((level) => (
                        <tr key={level} className="border-t border-border/60">
                          <td className="text-left py-0.5 pr-2 text-muted">{level}</td>
                          {Array.from({ length: g.maxTier }, (_, i) => i + 1).map((t) => (
                            <td key={t} className="text-right px-1.5 py-0.5">
                              {tierUses(g.classId, t as SpellTier, level)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        ) : tab === "dano" ? (
          <div className="space-y-5">
            <div className="space-y-2">
              <p className="text-sm leading-relaxed">
                <span className="text-accent">Ataque normal</span> = metade do seu ATK (ou MAG, se for
                conjurador) + dados da arma + terreno − metade da DEF do alvo (RES, contra magia).
                Metades não contam: arredonda pra baixo. Mínimo 1 de dano.
              </p>
              <p className="text-sm leading-relaxed">
                <span className="text-accent">Magia</span> = a mesma conta, com a sua metade de MAG
                multiplicada pelo peso da magia e os dados dela no lugar da arma. Todo peso é maior que 1,
                e o resultado nunca fica abaixo de um ataque normal — conjurar sempre vale mais que bater.
              </p>
              <p className="text-xs text-muted leading-relaxed">
                Por isso a tabela abaixo mostra a fórmula por MAG, não por nível: uma magia cresce junto
                com quem conjura, não numa tabela própria.
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="text-muted">
                    <th className="text-left font-normal pr-2 py-1">Habilidade</th>
                    <th className="text-left font-normal px-1.5 py-1">Classe</th>
                    <th className="text-center font-normal px-1.5 py-1">Tier</th>
                    <th className="text-left font-normal px-1.5 py-1">Fórmula</th>
                    <th className="text-left font-normal pl-1.5 py-1">Efeito</th>
                  </tr>
                </thead>
                <tbody>
                  {SKILL_DAMAGE_ROWS.map((row) => (
                    <tr key={row.name} className="border-t border-border/60 align-top">
                      <td className="text-left py-1 pr-2 font-medium whitespace-nowrap">{row.name}</td>
                      <td className="text-left px-1.5 py-1 text-muted whitespace-nowrap">{CLASSES[row.cls].name}</td>
                      <td className="text-center px-1.5 py-1 text-muted">T{row.tier}</td>
                      <td className="text-left px-1.5 py-1 tabular-nums">
                        {typeof row.formula === "string" ? (
                          row.formula
                        ) : row.param === "level" ? (
                          <span className="space-x-1.5">
                            <span>Nv1: {row.formula(1)}</span>
                            <span className="text-muted">· Nv7: {row.formula(7)}</span>
                            <span className="text-muted">· Nv14: {row.formula(14)}</span>
                          </span>
                        ) : (
                          <span className="space-x-1.5">
                            <span>MAG 10: {row.formula(10)}</span>
                            <span className="text-muted">· MAG 20: {row.formula(20)}</span>
                            <span className="text-muted">· MAG 40: {row.formula(40)}</span>
                          </span>
                        )}
                      </td>
                      <td className="text-left pl-1.5 py-1 text-muted">{row.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div className="space-y-5">
            <p className="text-sm text-muted leading-relaxed">
              Chances de drop, do jeito que estão programadas agora.
            </p>
            <div>
              <p className="text-sm font-medium">Poções em baú (por baú)</p>
              <p className="text-xs text-muted leading-relaxed mb-2">
                Todo baú dá Ember + uma poção garantida (sorteada abaixo) + uma chance separada de item.
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-xs tabular-nums border-collapse">
                  <thead>
                    <tr className="text-muted">
                      <th className="text-left font-normal pr-2 py-1">Poção</th>
                      <th className="text-right font-normal pl-1.5 py-1">Chance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {POTION_LOOT_ROWS.map((r) => (
                      <tr key={r.name} className="border-t border-border/60">
                        <td className="text-left py-0.5 pr-2">{r.name}</td>
                        <td className="text-right pl-1.5 py-0.5">{((r.weight / POTION_LOOT_TOTAL) * 100).toFixed(0)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="text-sm text-muted leading-relaxed space-y-1">
              <p className="text-fg font-medium text-sm">Ember e item de baú</p>
              <p>
                Ember: {CHEST_LOOT.emberBase}–{CHEST_LOOT.emberBase + CHEST_LOOT.emberDice - 1} por baú.
              </p>
              <p>Chance extra de arma ou equipamento: {Math.round(CHEST_LOOT.gearChance * 100)}%.</p>
            </div>
            <div className="text-sm text-muted leading-relaxed space-y-1">
              <p className="text-fg font-medium text-sm">Drop ao matar inimigo</p>
              <p>Inimigo comum: {(KILL_DROP_CHANCE * 100).toFixed(0)}% de chance de largar uma arma.</p>
              <p>Chefes nomeados (drop garantido): sempre largam arma ou equipamento ao morrer.</p>
            </div>
            <p className="text-xs text-muted leading-relaxed">
              Toda arma/equipamento largado é sorteado por preço — quanto mais caro, mais raro — e limitado ao
              nível de itens da missão atual, então cada trecho da campanha só solta o que faz sentido pra ele.
            </p>
          </div>
        )}
        <Button className="mt-5 w-full" onClick={onClose}>
          Entendi
        </Button>
      </div>
    </div>
  );
}

function TestMenuScreen({
  onBack,
  onDebug,
  onMapEditor,
}: {
  onBack: () => void;
  onDebug: () => void;
  onMapEditor: () => void;
}) {
  return (
    <section className="h-dvh min-h-0 flex flex-col bg-bg">
      <header className="flex items-center gap-3 px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-4 border-b border-border">
        <button type="button" onClick={onBack} className="size-10 grid place-items-center rounded-md border border-border" aria-label="Voltar">
          <ChevronLeft className="size-5" />
        </button>
        <div className="flex-1 min-w-0">
          <p className="text-sm uppercase tracking-[0.18em] text-muted">Modo teste</p>
          <h1 className="font-display text-3xl leading-none">O que abrir?</h1>
        </div>
      </header>
      <div className="flex-1 min-h-0 flex flex-col justify-center gap-3 p-5 max-w-md mx-auto w-full">
        <button
          type="button"
          onClick={onDebug}
          className="text-left rounded-xl border border-border bg-bg/40 px-5 py-4 hover:border-accent"
        >
          <p className="font-display text-2xl leading-tight">Debug</p>
          <p className="text-sm text-muted mt-1">Joga qualquer missão da campanha, sem travar progresso — o de sempre.</p>
        </button>
        <button
          type="button"
          onClick={onMapEditor}
          className="text-left rounded-xl border border-border bg-bg/40 px-5 py-4 hover:border-accent"
        >
          <p className="font-display text-2xl leading-tight">Map Editor</p>
          <p className="text-sm text-muted mt-1">Pinta terreno, posiciona spawns, testa na hora e exporta pra colar no jogo.</p>
        </button>
      </div>
    </section>
  );
}

/** Index of a cell in the flat tile array, or -1 when it is off the board.
 *
 * A prop may hang off the edge, so its footprint routinely names cells that do not exist.
 * `y * cols + x` cannot express that: x = -1 lands on the previous row's last cell, so
 * stamping a footprint blind would silently repaint a hex on the far side of the map. */
function cellIndex(x: number, y: number, cols: number, rows: number): number {
  if (x < 0 || y < 0 || x >= cols || y >= rows) return -1;
  return y * cols + x;
}

const MAP_VERSIONS_KEY = "ember-map-versions";
const MAP_ACTIVE_KEY = "ember-map-active";
const MAP_ACTIVE_DRAFTS_KEY = "ember-map-active-drafts";
const DECO_SHUFFLE_EXCLUDE_KEY = "ember-deco-shuffle-exclude";
const EDITOR_COLS_DEFAULT = 10;
const EDITOR_ROWS_DEFAULT = 8;

/** Default level for a newly added spawn: enough spell slots unlocked to actually test
 * with, without being maxed out. */
const DEFAULT_TEST_LEVEL = 10;

/** One canonical scenario prefix everywhere: the editor's ID becomes the exact file prefix.
 * `Vau 01` therefore saves as `vau-01001.json` only if the author actually made the ID
 * `vau-01`; the trailing three digits are always the generated save serial. */
function normalizeScenarioId(value: string): string {
  const id = value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return id || "scenario";
}

function blankDraft(): MapDraft {
  return {
    id: `custom-${Date.now().toString(36)}`,
    index: 0,
    title: "Mapa sem nome",
    place: "",
    briefing: "",
    objective: "Derrote todos os inimigos",
    win: "rout",
    hub: false,
    autoTactics: true,
    locationId: "",
    cols: EDITOR_COLS_DEFAULT,
    rows: EDITOR_ROWS_DEFAULT,
    tiles: Array.from({ length: EDITOR_COLS_DEFAULT * EDITOR_ROWS_DEFAULT }, () => "plains" as TerrainId),
    tileVariants: Array.from({ length: EDITOR_COLS_DEFAULT * EDITOR_ROWS_DEFAULT }, () => 0),
    tileRots: Array.from({ length: EDITOR_COLS_DEFAULT * EDITOR_ROWS_DEFAULT }, () => 0),
    music: "",
    decorations: [],
    playerSpawns: [],
    enemySpawns: [],
    neutralSpawns: [],
  };
}

/** Loads an existing campaign mission into the editor, targeting that same mission's id —
 * so saved versions stack up under it and "Ativar" can make one of them live for that
 * real campaign slot. The immutable static Mission data itself is never touched; this
 * only ever writes to the versioned localStorage store. */
/** The three spawn lists a draft carries, and the Side each one spawns into. */
type SpawnKey = "playerSpawns" | "enemySpawns" | "neutralSpawns";
const SPAWN_SIDE: Record<SpawnKey, "player" | "enemy" | "neutral"> = {
  playerSpawns: "player",
  enemySpawns: "enemy",
  neutralSpawns: "neutral",
};

function missionToDraft(m: Mission): MapDraft {
  const n = m.cols * m.rows;
  const variants = m.tileVariants ?? [];
  return {
    id: m.id,
    index: m.index,
    title: m.title,
    place: m.place,
    briefing: m.briefing,
    objective: m.objective,
    win: m.win,
    hub: !!m.hub,
    autoTactics: m.autoTactics !== false,
    locationId: locationForMission(m.id)?.id ?? "",
    cols: m.cols,
    rows: m.rows,
    tiles: parseLayout(m.layout),
    tileVariants: Array.from({ length: n }, (_, i) => variants[i] ?? 0),
    tileRots: Array.from({ length: n }, (_, i) => m.tileRots?.[i] ?? 0),
    music: m.music ?? "",
    decorations: m.decorations ?? [],
    playerSpawns: m.playerSpawns.map((s) => ({ ...s, level: DEFAULT_TEST_LEVEL })),
    enemySpawns: m.enemySpawns.map((s) => ({ ...s, level: enemyLevelFor(m.index) })),
    neutralSpawns: (m.neutralSpawns ?? []).map((s) => ({ ...s, level: enemyLevelFor(m.index) })),
  };
}

const DEFAULT_HEROES: { name: string; classId: ClassId }[] = [
  { name: "Kael", classId: "swordsman" },
  { name: "Neera", classId: "archer" },
  { name: "Voss", classId: "mage" },
  { name: "Salazar", classId: "healer" },
];

/** The editor's spawn lists, in display order. A spawn's class decides whether it is listed
 * as a summon, so a summon is grouped as one wherever it was placed from. */
/** Every spawn list, in the order a cell is searched for whoever stands on it. */
const SPAWN_KEYS: SpawnKey[] = ["playerSpawns", "enemySpawns", "neutralSpawns"];

/** Sorts display names the way a Portuguese reader scans a list: case and accents ignored,
 * so "Água" lands with the A's and not after Z. */
const byName = (a: string, b: string) => a.localeCompare(b, "pt-BR", { sensitivity: "base" });

/** The grid letter's colour, by side: blue ally, green neutral, red enemy. */
const SIDE_INK: Record<"player" | "enemy" | "neutral", string> = {
  player: "text-sky-300",
  neutral: "text-emerald-400",
  enemy: "text-red-400",
};

/** P hero, E enemy, S summon (either side), N wild neutral — the colour says the side, the
 * letter says what it is. */
function spawnGlyph(sp: DraftSpawn, side: "player" | "enemy" | "neutral"): string {
  if (isSummonClass(sp.classId)) return "S";
  return side === "player" ? "P" : side === "neutral" ? "N" : "E";
}

const SPAWN_GROUPS: { side: SpawnKey; summon: boolean; label: string }[] = [
  { side: "playerSpawns", summon: false, label: "Heróis" },
  { side: "playerSpawns", summon: true, label: "Invocações aliadas" },
  { side: "enemySpawns", summon: false, label: "Inimigos" },
  { side: "enemySpawns", summon: true, label: "Invocações inimigas" },
  { side: "neutralSpawns", summon: false, label: "Feras neutras" },
  { side: "neutralSpawns", summon: true, label: "Invocações neutras" },
];

/** Everyone the Map Editor can drop on a board. Two more than DEFAULT_HEROES, which is the
 * starting four the campaign and the inn are built around — the Lancer and the Conjurer are
 * party members too, and a map being authored should be able to place them. Kept separate
 * so widening the editor's reach does not quietly recruit them into a campaign. */
const EDITOR_HEROES: { name: string; classId: ClassId }[] = [
  ...DEFAULT_HEROES,
  { name: "Aldric", classId: "lancer" },
  { name: "Malrec", classId: "conjurer" },
];

/** One saved edit of a scenario. Versions never get overwritten — every "Salvar" appends
 * a new serial under the draft's id (the target scenario). "Ativar" a serial to make it
 * the one real campaign play uses instead of the immutable static Mission data; the
 * static data itself is never modified by any of this. */
interface MapVersion {
  serial: number;
  draft: MapDraft;
  savedAt: number;
}

function loadVersionStore(): Record<string, MapVersion[]> {
  try {
    const raw = window.localStorage.getItem(MAP_VERSIONS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    return parsed && typeof parsed === "object" ? (parsed as Record<string, MapVersion[]>) : {};
  } catch {
    return {};
  }
}

/** Returns false when the browser refused the write (private mode, blocked storage,
 * quota) so the caller can say so instead of reporting a save that didn't happen. */
function saveVersionStore(store: Record<string, MapVersion[]>): boolean {
  try {
    window.localStorage.setItem(MAP_VERSIONS_KEY, JSON.stringify(store));
    return true;
  } catch {
    return false;
  }
}

/** Writes the draft to src/game/maps/<id><serial>.json through the dev server's
 * /__map-save route (scripts/map-save-plugin.mjs). Only reachable while `npm run dev`
 * is running — a built/deployed app has no repo to write to, and falls back to the
 * browser-local store below. */
async function saveMapToRepo(draft: MapDraft): Promise<{ ok: true; serial: number; file: string } | { ok: false; error: string }> {
  try {
    const res = await fetch("/__map-save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...draft, id: normalizeScenarioId(draft.id) }),
    });
    const body = (await res.json()) as { ok?: boolean; serial?: number; file?: string; error?: string };
    if (!res.ok || !body.ok) return { ok: false, error: body.error ?? `HTTP ${res.status}` };
    return { ok: true, serial: body.serial ?? 0, file: body.file ?? "" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Deletes one saved map file through the dev server's /__map-delete route. Same
 * constraint as saving: only reachable while `npm run dev` is running. */
async function deleteMapFile(file: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch("/__map-delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file }),
    });
    const body = (await res.json()) as { ok?: boolean; error?: string; stillOnDisk?: boolean };
    if (!res.ok || !body.ok) return { ok: false, error: body.error ?? `HTTP ${res.status}` };
    if (body.stillOnDisk) return { ok: false, error: "o arquivo continua no disco" };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function loadActiveVersions(): Record<string, number> {
  try {
    const raw = window.localStorage.getItem(MAP_ACTIVE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    return parsed && typeof parsed === "object" ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function saveActiveVersions(map: Record<string, number>) {
  try {
    window.localStorage.setItem(MAP_ACTIVE_KEY, JSON.stringify(map));
  } catch {
    // ignore
  }
}

function loadActiveDrafts(): Record<string, MapDraft> {
  try {
    const raw = window.localStorage.getItem(MAP_ACTIVE_DRAFTS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    return parsed && typeof parsed === "object" ? (parsed as Record<string, MapDraft>) : {};
  } catch {
    return {};
  }
}

function saveActiveDrafts(drafts: Record<string, MapDraft>): boolean {
  try {
    window.localStorage.setItem(MAP_ACTIVE_DRAFTS_KEY, JSON.stringify(drafts));
    return true;
  } catch {
    return false;
  }
}
/** Decoration ids "Gerar terreno" leaves out of its random scatter — per direct
 * instruction, a prop can be too distinctive to want scattered at random without pulling
 * it out of DECORATIONS entirely and losing manual placement too. Browser-local, same as
 * the version store: this is an editor preference, not campaign data. */
function loadDecoShuffleExclude(): string[] {
  try {
    const raw = window.localStorage.getItem(DECO_SHUFFLE_EXCLUDE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function saveDecoShuffleExclude(ids: string[]) {
  try {
    window.localStorage.setItem(DECO_SHUFFLE_EXCLUDE_KEY, JSON.stringify(ids));
  } catch {
    // ignore
  }
}

/** Resolves a mission id for REAL play (not the editor's own playtest): an activated
 * custom version takes precedence over the immutable static MISSIONS data, so authoring
 * a scenario in the Map Editor can actually replace what the campaign plays without ever
 * touching the shipped data. */
function resolveMission(id: string): Mission | undefined {
  // The active draft is the campaign's immutable selection snapshot. A serial alone can
  // point at a stale/local list after reloads, so never make the campaign guess from it.
  const exact = loadActiveDrafts()[id];
  if (exact) return draftToMission(exact);

  // Migrate activations created before snapshots existed, then every later launch reads
  // the exact draft selected by the editor rather than a different disk version.
  const active = loadActiveVersions()[id];
  if (active) {
    const version = loadVersionStore()[id]?.find((v) => v.serial === active && v.draft.id === id);
    if (version) {
      saveActiveDrafts({ ...loadActiveDrafts(), [id]: version.draft });
      return draftToMission(version.draft);
    }
  }
  return missionById(id);
}

const TERRAIN_SWATCH: Record<TerrainId, string> = {
  plains: "#9c8f6f",
  woods: "#3f5c3a",
  ruins: "#6b6560",
  water: "#2c5f7a",
  ember: "#7a2c2c",
  hill: "#8a7a4f",
  flame: "#b5501f",
  column: "#4a4a52",
  nave: "#26262c",
  barricade: "#5a4630",
  highwood: "#4a3f2a",
  highruin: "#5f584c",
  chest: "#7a5c2e",
  door: "#4a3524",
  deadtree: "#4a3f2a",
  void: "#050505",
};

const BUILDER_TERRAIN: TerrainId[] = [
  "plains",
  "woods",
  "water",
  "ruins",
  "ember",
  "hill",
  "flame",
  "nave",
  "column",
  // "barricade" is deliberately not here: it is a decoration now, placed with the Decoração
  // brush, which lays its terrain with it. Painting the bare tile still works — a map that
  // already had one keeps it, and the prop is derived on load — but authoring goes one way.
  "highwood",
  "deadtree",
  "highruin",
  "chest",
  "door",
  "void",
];

const VARIANT_LABEL: Partial<Record<TerrainId, string[]>> = {
  plains: [
    "Planície sombria", "Planície florida", "Planície original", "Antiga", "Terra", "Pedra", "Cinza", "Pedras",
    "Clareira", "Rochas", "Lajedo", "Pedregulho", "Prado", "Flores silvestres", "Relva",
  ],
  woods: ["Solo de bosque", "Bosque sombrio", "Bosque", "Sebes", "Pinhal", "Bosque 04", "Terra"],
  ruins: ["Ruínas sombrias", "Ruínas originais", "Pedra 02", "Pedra 03", "Pedra 04", "Pátio mosaico", "Lajes partidas"],
  water: ["Água costeira", "Antiga", "Praia", "Pântano", "Costa baixo", "Costa esq.", "Costa dir.", "Mar fundo", "Mar fundo 2", "Costa 01", "Costa 02", "Ponta baixo 01", "Ponta baixo 02", "Água rasa", "Água rasa 2", "Água costa", "Água costa 2", "Pântano escuro", "Praia", "Rio", "Mar", "Mar profundo"],
  ember: ["Brasa", "Brasa 2", "Antiga", "Cinzas", "Brasa viva"],
  hill: ["Platô rochoso", "Trilha elevada", "Ruínas elevadas", "Platô musgoso"],
  flame: ["Chama", "Antiga", "Fogo"],
  nave: ["Laje", "Laje Negra"],
  column: ["Coluna", "Antiga"],
};

/** Hover text for a terrain type: its combat stats plus terrainNote()'s callout, so the
 * editor documents what each tile actually does instead of just naming it. */
function terrainHint(t: TerrainId, variant?: number): string {
  const d = TERRAIN[t];
  // Which art file this cell actually paints with. Two variants of one terrain are
  // identical in every rule below, so the name is the only thing that tells them apart.
  const label = variant == null ? null : (VARIANT_LABEL[t]?.[variant] ?? tileVariantName(t, variant));
  const head = d.name;
  const parts = [head, d.passable ? `Mov ${d.moveCost}` : "Intransponível", `Def +${d.def}`, `Atk +${d.atk}`];
  if (d.blocksShot) parts.push("bloqueia tiro/visão");
  if (d.hazardDice) parts.push(`dano ${d.hazardDice}D${d.hazardFaces} ao entrar e a cada turno`);
  const note = terrainNote(t);
  return note ? `${parts.join(" · ")} — ${note}` : parts.join(" · ");
}

function ResizableEditorPanel({
  children,
  className,
  style,
  title,
  minHeight,
}: {
  children: ReactNode;
  className: string;
  style?: CSSProperties;
  title: string;
  minHeight: number;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const resizeStart = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);

  const startResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const panel = panelRef.current;
    if (!panel) return;
    event.preventDefault();
    const rect = panel.getBoundingClientRect();
    resizeStart.current = { x: event.clientX, y: event.clientY, width: rect.width, height: rect.height };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const resize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const start = resizeStart.current;
    if (!start) return;
    setSize({
      width: Math.max(280, start.width + event.clientX - start.x),
      height: Math.max(minHeight, start.height + event.clientY - start.y),
    });
  };

  const stopResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    resizeStart.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return (
    <div ref={panelRef} className={`relative shrink-0 ${className}`} style={{ ...style, ...(size ?? {}) }} title={title}>
      {children}
      <button
        type="button"
        className="absolute bottom-0 right-0 z-10 grid size-8 touch-none place-items-center rounded-tl-md border-l border-t border-border bg-bg/90 text-muted cursor-se-resize"
        aria-label={title}
        onPointerDown={startResize}
        onPointerMove={resize}
        onPointerUp={stopResize}
        onPointerCancel={stopResize}
      >
        <Grip className="size-4 rotate-45" />
      </button>
    </div>
  );
}

function MapEditorScreen({
  art,
  onBack,
  onPlaytest,
  initialDraft,
  onDraftChange,
}: {
  art: GameArt;
  onBack: () => void;
  onPlaytest: (m: Mission, playerLevels: Record<string, number>, enemyLevels: Record<string, number>) => void;
  /** The map to reopen with — what was being edited before a playtest took the screen away. */
  initialDraft?: MapDraft | null;
  onDraftChange?: (draft: MapDraft) => void;
}) {
  const [showPreview, setShowPreview] = useState(false);
  // Rebuilding the preview's BattleEngine on every keystroke (typing a title, nudging a
  // spawn's level) would be wasted work it can't even show — debounce to the pause after a
  // real edit instead.
  const [previewMission, setPreviewMission] = useState<Mission | null>(null);
  const [selectedPreviewUnit, setSelectedPreviewUnit] = useState<PreviewUnitSelection | null>(null);
  const [shuffleExclude, setShuffleExclude] = useState<Set<string>>(() => new Set(loadDecoShuffleExclude()));
  const toggleShuffleExclude = (id: string) => {
    setShuffleExclude((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      saveDecoShuffleExclude([...next]);
      return next;
    });
  };
  const [versionStore, setVersionStore] = useState<Record<string, MapVersion[]>>(() => loadVersionStore());
  const [activeVersions, setActiveVersions] = useState<Record<string, number>>(() => loadActiveVersions());
  const [draft, setDraft] = useState<MapDraft>(() => initialDraft ?? blankDraft());
  const [brush, setBrush] = useState<TerrainId>("plains");
  const [variant, setVariant] = useState(0);
  // While armed, clicking a hex in Terreno mode turns it instead of painting it.
  const [turning, setTurning] = useState(false);
  const [turningDeco, setTurningDeco] = useState(false);
  const [decoBrush, setDecoBrush] = useState<string>(Object.keys(DECORATIONS)[0]!);
  const [decoSection, setDecoSection] = useState("Todas");
  const [mode, setMode] = useState<"paint" | "player" | "enemy" | "summon" | "decoration">("paint");
  // Which summon class the "Invocação" brush drops. Summons live in playerSpawns alongside
  // the heroes — the class itself says which of the two a spawn is (isSummonClass), so
  // there is no third list to keep in sync and no saved map to migrate.
  const [summonBrush, setSummonBrush] = useState<ClassId>(SUMMON_CLASSES[0] ?? "familiar");
  // Summons exist on every side — the Conjurer's familiar, whatever an enemy caster brings
  // up, and wild things that belong to nobody. The brush drops into whichever this points at.
  const [summonSide, setSummonSide] = useState<"player" | "enemy" | "neutral">("player");
  const [gridStyle, setGridStyle] = useState<"hex" | "square">("hex");
  const [exportText, setExportText] = useState<string | null>(null);
  const [copyOk, setCopyOk] = useState(false);
  // Every message carries a serial so repeating an action visibly re-fires: saving twice in
  // a row used to leave the same sentence sitting there, indistinguishable from nothing
  // having happened.
  const [note, setNoteRaw] = useState<{ text: string; n: number } | null>(null);
  /** The loud one: a full-width panel that stays until dismissed, for the answer to "did it
   * actually save". The small note above it is for running commentary. */
  const [bigNote, setBigNote] = useState<{ ok: boolean; title: string; lines: string[]; dump?: string } | null>(null);
  const noteSerial = useRef(0);
  const setNote = useCallback((text: string) => {
    noteSerial.current += 1;
    setNoteRaw({ text, n: noteSerial.current });
  }, []);
  useEffect(() => {
    onDraftChange?.(draft);
  }, [draft, onDraftChange]);

  useEffect(() => {
    if (!showPreview) return;
    const t = window.setTimeout(() => setPreviewMission(draftToMission(draft)), 400);
    return () => window.clearTimeout(t);
  }, [draft, showPreview]);

  const [showLocations, setShowLocations] = useState(false);
  // Play order per location, keyed by location id. Seeded from what ALL_LOCATIONS resolved
  // to, so a location with no stored order still lists its missions in the order they play.
  const [order, setOrder] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(ALL_LOCATIONS.map((l) => [l.id, [...l.missionIds]])),
  );
  // This is the chapter order between world-map markers. It is independent from the
  // missions listed inside each location and does not move the markers visually.
  const [locationOrder, setLocationOrder] = useState<string[]>(() => ALL_LOCATIONS.map((location) => location.id));

  /** Writes src/game/map-order.json through the dev server. Config, not a version — a new
   * order replaces the old one rather than adding a serial. */
  const saveOrder = async (next: Record<string, string[]>) => {
    setOrder(next);
    try {
      const res = await fetch("/__map-order", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(next),
      });
      const body = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !body.ok) {
        setNote(`Não deu pra gravar a ordem: ${body.error ?? `HTTP ${res.status}`}`);
        return;
      }
      setNote("Ordem das missões atualizada em src/game/map-order.json.");
    } catch (err) {
      setNote(`Sem servidor de dev — ordem não gravada (${err instanceof Error ? err.message : String(err)}).`);
    }
  };

  /** Sends a mission to another location. It leaves every other list and joins the end of
   * the destination's, which is then reordered with the arrows. */
  const transferMission = (missionId: string, toLocationId: string) => {
    const next: Record<string, string[]> = {};
    for (const [locId, ids] of Object.entries(order)) {
      const kept = ids.filter((id) => id !== missionId);
      if (kept.length > 0) next[locId] = kept;
    }
    next[toLocationId] = [...(next[toLocationId] ?? []), missionId];
    void saveOrder(next);
  };

  const moveInOrder = (locationId: string, missionId: string, dir: -1 | 1) => {
    const list = [...(order[locationId] ?? [])];
    const i = list.indexOf(missionId);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j]!, list[i]!];
    void saveOrder({ ...order, [locationId]: list });
  };

  const moveLocationInOrder = (locationId: string, dir: -1 | 1) => {
    setLocationOrder((current) => {
      const next = [...current];
      const i = next.indexOf(locationId);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= next.length) return current;
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  };

  const versions = versionStore[draft.id] ?? [];
  const [armedDelete, setArmedDelete] = useState("");
  const removeFromLocation = (locationId: string, missionId: string) => {
    const key = `location:${locationId}:${missionId}`;
    if (armedDelete !== key) {
      setArmedDelete(key);
      setNote(`Remover? Clique de novo para tirar este mapa de Locais. O arquivo do mapa não será apagado.`);
      return;
    }
    setArmedDelete("");
    setOrder((current) => ({ ...current, [locationId]: (current[locationId] ?? []).filter((id) => id !== missionId) }));
    setNote(`Mapa removido deste Local. Clique Salvar em Locais para gravar a campanha.`);
  };
  const [repoFiles, setRepoFiles] = useState<MapFile[]>(() => savedVersionsFor(draft.id));
  const refreshRepoFiles = useCallback(async (id: string) => {
    try {
      const response = await fetch(`/__map-list?id=${encodeURIComponent(id)}`);
      const body = (await response.json()) as { ok?: boolean; files?: MapFile[] };
      if (!response.ok || !body.ok || !Array.isArray(body.files)) throw new Error("lista indisponível");
      setRepoFiles(body.files);
    } catch {
      // Built releases have no dev-only endpoint. Their static list is still useful.
      setRepoFiles(savedVersionsFor(id));
    }
  }, []);
  useEffect(() => { void refreshRepoFiles(draft.id); }, [draft.id, refreshRepoFiles]);
  const repoLatest = repoFiles.reduce((latest, file) => Math.max(latest, file.serial), 0);
  /** Every scenario the picker can open, from either store. Files on disk are the real
   * saves — a map authored offline exists only there — so they lead; a scenario that
   * lives only in this browser (no dev server when it was saved) still gets a row. */
  const pickable = (() => {
    const rows = savedScenarios().map((s) => ({ id: s.id, files: s.files, local: (versionStore[s.id] ?? []).length }));
    const seen = new Set(rows.map((r) => r.id));
    for (const [id, list] of Object.entries(versionStore)) {
      if (!seen.has(id) && list.length > 0) rows.push({ id, files: 0, local: list.length });
    }
    return rows.sort((a, b) => byName(a.id, b.id));
  })();
  const [savedLocationMaps, setSavedLocationMaps] = useState<{ id: string; title: string; index: number }[]>(() =>
    savedScenarios().map((scenario) => ({ id: scenario.id, title: latestSavedDraft(scenario.id)?.title ?? scenario.id, index: latestSavedDraft(scenario.id)?.index ?? 0 })),
  );
  const refreshSavedLocationMaps = useCallback(async () => {
    try {
      const response = await fetch("/__map-list");
      const body = (await response.json()) as { ok?: boolean; scenarios?: { id: string; title: string; index: number }[] };
      if (!response.ok || !body.ok || !Array.isArray(body.scenarios)) return;
      setSavedLocationMaps(body.scenarios);
    } catch {
      // The static list stays usable outside the local dev server.
    }
  }, []);
  useEffect(() => { void refreshSavedLocationMaps(); }, [refreshSavedLocationMaps]);

  const [slots, setSlots] = useState<Record<string, number>>(LOCATION_SLOTS);

  /** Declares how many missions a location is meant to hold, so the editor can show what
   * is still to author. Writes src/game/map-slots.json through the dev server — config,
   * not a version, so it replaces the previous count instead of adding a serial. */
  const doSaveSlots = async (next: Record<string, number>) => {
    setSlots(next);
    try {
      const res = await fetch("/__map-slots", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(next),
      });
      const body = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !body.ok) {
        setNote(`Não deu pra gravar as vagas: ${body.error ?? `HTTP ${res.status}`}`);
        return;
      }
      setNote("Vagas do local atualizadas em src/game/map-slots.json.");
    } catch (err) {
      setNote(`Sem servidor de dev — vagas não gravadas (${err instanceof Error ? err.message : String(err)}).`);
    }
  };
  /** Writes the Locais configuration — which missions each location holds, in what order,
   * and how many it is meant to hold — and confirms it by what came back off disk.
   *
   * The order and slot writes already happen as you click, but silently: without a dev
   * server they fail and the change lives only on screen until the tab closes. This is the
   * deliberate one, and it says out loud whether the files exist afterwards. */
  const saveScenarios = async () => {
    setBigNote(null);
    const post = async (route: string, payload: unknown) => {
      const res = await fetch(route, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await res.json()) as { ok?: boolean; error?: string; file?: string; onDisk?: unknown };
      if (!res.ok || !body.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      return body;
    };
    try {
      const o = await post("/__map-order", order);
      const sl = await post("/__map-slots", slots);
      const lo = await post("/__location-order", locationOrder);
      const locais = Object.keys((o.onDisk as Record<string, unknown>) ?? {}).length;
      const vagas = Object.keys((sl.onDisk as Record<string, unknown>) ?? {}).length;
      window.dispatchEvent(new CustomEvent("ember:locations-saved", { detail: { missionOrder: order, locationOrder } }));
      setBigNote({
        ok: true,
        title: "ESTÁ SALVO",
        lines: [
          `${o.file} — ${locais} ${locais === 1 ? "local" : "locais"} com ordem definida`,
          `${sl.file} — ${vagas} ${vagas === 1 ? "local" : "locais"} com vagas definidas`,
          `${lo.file} — sequência de locais da campanha confirmada`,
          "Confirmado relendo os arquivos do disco, não é só promessa.",
        ],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setBigNote({
        ok: false,
        title: "NÃO SALVOU",
        lines: [
          `Motivo: ${msg}`,
          "Sem servidor de dev não há onde gravar — rodando pelo start.bat no PC, ou pelo Codespaces, funciona.",
          "O texto abaixo é a sua configuração. Copie e guarde: cola numa conversa e eu gravo por você.",
        ],
        dump: JSON.stringify({ order, locationOrder, slots }, null, 2),
      });
    }
  };

  const activeSerial = activeVersions[draft.id];

  const decoLookup = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of draft.decorations) {
      const def = DECORATIONS[p.id];
      if (!def) continue;
      for (const f of placedFootprint(p)) m.set(`${p.x + f.dx},${p.y + f.dy}`, def.name);
    }
    return m;
  }, [draft.decorations]);

  const setTile = (i: number, t: TerrainId) => {
    // Painting under a prop is allowed, but it is worth saying out loud: the prop is only
    // the picture, so repainting here is what decides whether that house can be climbed.
    const x = i % draft.cols;
    const y = Math.floor(i / draft.cols);
    const under = draft.decorations.find((p) => {
      const def = DECORATIONS[p.id];
      return def?.tile && placedFootprint(p).some((f) => p.x + f.dx === x && p.y + f.dy === y);
    });
    if (under) {
      const def = DECORATIONS[under.id]!;
      if (t !== def.tile) {
        setNote(
          `${def.name} agora está sobre ${TERRAIN[t].name.toLowerCase()} — ${TERRAIN[t].passable ? "dá pra andar por cima" : "não se atravessa"}. O terreno manda, não o desenho.`,
        );
      }
    }
    setDraft((d) => {
      const tiles = d.tiles.slice();
      const tileVariants = d.tileVariants.slice();
      tiles[i] = t;
      tileVariants[i] = Math.min(variant, TILE_VARIANT_COUNT[t] - 1);
      return { ...d, tiles, tileVariants };
    });
  };

  /** Paints the selected terrain across the board while leaving units and decorations in
   * place, so a map can start from one coherent ground layer before detail work begins. */
  const replaceBaseTile = () => {
    const selectedVariant = Math.min(variant, (TILE_VARIANT_COUNT[brush] ?? 1) - 1);
    setDraft((d) => ({
      ...d,
      tiles: Array.from({ length: d.cols * d.rows }, () => brush),
      tileVariants: Array.from({ length: d.cols * d.rows }, () => selectedVariant),
      tileRots: Array.from({ length: d.cols * d.rows }, () => 0),
    }));
    setNote(`Base inteira substituída por ${TERRAIN[brush].name.toLowerCase()} · ${VARIANT_LABEL[brush]?.[selectedVariant] ?? `arte ${selectedVariant + 1}`}.`);
  };

  /** Turns one hex's art a sixth of a circle. The tile, its variant and everything standing
   * on it are left alone — only which way the picture points, which is what makes a coast, a
   * road or a wall meet its neighbour instead of running the wrong way. Six presses come
   * back to where it started. */
  /** Where the red dot sits for a given turn: the hex's bottom side, carried around with the
   * art. Sixty degrees per step, measured from straight down, as a fraction of the cell's
   * half-height so both grids can place it the same way. */
  const bottomDot = (rot: number, radius: number) => {
    const a = Math.PI / 2 + ((rot % 6) * Math.PI) / 3;
    return { dx: Math.cos(a) * radius, dy: Math.sin(a) * radius };
  };

  const turnTile = (i: number) => {
    setDraft((d) => {
      const tileRots = (d.tileRots ?? Array.from({ length: d.tiles.length }, () => 0)).slice();
      tileRots[i] = ((tileRots[i] ?? 0) + 1) % 6;
      return { ...d, tileRots };
    });
  };

  const toggleSpawn = (x: number, y: number) => {
    setDraft((d) => {
      // Summons share the spawn list of the side they belong to — the class itself says a
      // spawn is a summon (isSummonClass), so there is no third list to keep in sync and no
      // saved map to migrate. Either brush on a side lifts whatever unit is on the cell, so
      // clicking a familiar with the Herói brush removes the familiar rather than no-opping.
      const key: SpawnKey =
        mode === "enemy"
          ? "enemySpawns"
          : mode === "summon"
            ? summonSide === "enemy"
              ? "enemySpawns"
              : summonSide === "neutral"
                ? "neutralSpawns"
                : "playerSpawns"
            : "playerSpawns";
      const list = d[key] ?? [];
      const existing = list.findIndex((s) => s.x === x && s.y === y);
      if (existing >= 0) {
        return { ...d, [key]: list.filter((_, i) => i !== existing) };
      }
      const summons = list.filter((s) => isSummonClass(s.classId)).length;
      const plain = list.length - summons;
      const spawn: DraftSpawn =
        mode === "summon"
          ? {
              name: `${CLASSES[summonBrush].name} ${summons + 1}`,
              classId: summonBrush,
              x,
              y,
              level: key === "playerSpawns" ? DEFAULT_TEST_LEVEL : enemyLevelFor(0),
            }
          : mode === "player"
            ? { name: `Herói ${plain + 1}`, classId: "swordsman", x, y, level: DEFAULT_TEST_LEVEL }
            : { name: `Inimigo ${plain + 1}`, classId: "soldier", x, y, level: enemyLevelFor(0) };
      return { ...d, [key]: [...list, spawn] };
    });
  };

  /** Turns the prop under (x, y) one sixth of a circle, footprint and all.
   *
   * Refuses the turn when the new footprint would leave the board or land on another
   * prop — the same rule placing one obeys — so a turn can never silently overlap. The
   * terrain the prop stamps moves with it: lifted off the hexes it leaves, laid on the
   * ones it takes, or a turned house would leave climbable ground behind it. */
  const turnDecoration = (x: number, y: number) => {
    setDraft((d) => {
      const hit = d.decorations.find((p) => placedFootprint(p).some((f) => p.x + f.dx === x && p.y + f.dy === y));
      if (!hit) {
        setNote("Nao ha decoracao nessa casa pra girar.");
        return d;
      }
      const def = DECORATIONS[hit.id];
      if (!def) return d;
      const turned = { ...hit, rot: (((hit.rot ?? 0) + 1) % 6) };
      const before = placedFootprint(hit);
      const after = placedFootprint(turned);
      const others = decorationCells(d.decorations.filter((p) => p !== hit));
      for (const f of after) {
        if (others.has(`${hit.x + f.dx},${hit.y + f.dy}`)) {
          setNote(`${def.name} nao cabe girada aqui — bateria em outra decoracao.`);
          return d;
        }
      }
      const tiles = [...d.tiles];
      if (def.tile) {
        const floor: TerrainId = d.tiles.includes("nave") ? "nave" : "plains";
        for (const f of before) {
          const i = cellIndex(hit.x + f.dx, hit.y + f.dy, d.cols, d.rows);
          if (i >= 0 && tiles[i] === def.tile) tiles[i] = floor;
        }
        for (const f of after) {
          const i = cellIndex(hit.x + f.dx, hit.y + f.dy, d.cols, d.rows);
          if (i >= 0) tiles[i] = def.tile;
        }
      }
      setNote(`${def.name} em ${hit.x},${hit.y}: girada para ${turned.rot * 60}°${turned.rot === 0 ? " (de volta ao original)" : ""}.`);
      return { ...d, tiles, decorations: d.decorations.map((p) => (p === hit ? turned : p)) };
    });
  };

  const toggleDecoration = (x: number, y: number) => {
    setDraft((d) => {
      const covered = decorationCells(d.decorations);
      // clicking any hex a decoration already covers removes that whole placement,
      // regardless of which cell of its footprint was clicked
      const hit = d.decorations.find((p) => placedFootprint(p).some((f) => p.x + f.dx === x && p.y + f.dy === y));
      // A decoration is art; the tile under it carries every rule. So the tile is laid with
      // the prop and lifted with it, and the two cannot drift apart: a house prop over
      // plains would look climbable and be flat ground.
      const floor: TerrainId = d.tiles.includes("nave") ? "nave" : "plains";
      if (hit) {
        const hitDef = DECORATIONS[hit.id];
        const tiles = [...d.tiles];
        if (hitDef?.tile) {
          for (const f of placedFootprint(hit)) {
            const i = cellIndex(hit.x + f.dx, hit.y + f.dy, d.cols, d.rows);
            if (i >= 0 && tiles[i] === hitDef.tile) tiles[i] = floor;
          }
        }
        return { ...d, tiles, decorations: d.decorations.filter((p) => p !== hit) };
      }
      const def = DECORATIONS[decoBrush];
      if (!def) return d;
      // A prop may hang off the edge — half a ridge or a cave mouth running past the last
      // hex is the point. Only another prop blocks it; the cells beyond the board simply
      // have no tile to stamp.
      for (const f of def.footprint) {
        if (covered.has(`${x + f.dx},${y + f.dy}`)) return d;
      }
      const tiles = [...d.tiles];
      if (def.tile) {
        for (const f of def.footprint) {
          const i = cellIndex(x + f.dx, y + f.dy, d.cols, d.rows);
          if (i >= 0) tiles[i] = def.tile;
        }
      }
      return { ...d, tiles, decorations: [...d.decorations, { id: decoBrush, x, y }] };
      
    });
  };

  const onCellClick = (x: number, y: number) => {
    const i = y * draft.cols + x;
    if (mode === "paint") {
      if (turning) {
        turnTile(i);
        const now = (((draft.tileRots?.[i] ?? 0) + 1) % 6) * 60;
        setNote(`${TERRAIN[draft.tiles[i]!].name} em ${x},${y}: girado para ${now}°${now === 0 ? " (de volta ao original)" : ""}.`);
      } else setTile(i, brush);
    }
    else if (mode === "decoration") {
      if (turningDeco) {
        turnDecoration(x, y);
        return;
      }
      const def = DECORATIONS[decoBrush];
      const existing = draft.decorations.some((p) => placedFootprint(p).some((f) => p.x + f.dx === x && p.y + f.dy === y));
      if (!existing && def?.tile) {
        setNote(`${def.name} sobre ${TERRAIN[def.tile].name.toLowerCase()} — ${TERRAIN[def.tile].passable ? "dá pra subir em cima" : "não se atravessa"}.`);
      }
      toggleDecoration(x, y);
    }
    else toggleSpawn(x, y);
  };

  /** The technical grid is reserved for the fast rotation gesture; normal painting lives in the preview. */
  const onTechnicalClick = (x: number, y: number) => {
    if (mode === "paint") {
      const i = y * draft.cols + x;
      turnTile(i);
      const now = (((draft.tileRots?.[i] ?? 0) + 1) % 6) * 60;
      setNote(`${TERRAIN[draft.tiles[i]!].name} em ${x},${y}: girado para ${now}°${now === 0 ? " (de volta ao original)" : ""}.`);
    } else if (mode === "decoration") {
      turnDecoration(x, y);
    } else onCellClick(x, y);
  };

  const resize = (cols: number, rows: number) => {
    cols = Math.max(3, Math.min(40, cols));
    rows = Math.max(3, Math.min(40, rows));
    setDraft((d) => {
      const tiles: TerrainId[] = [];
      const tileVariants: number[] = [];
      const tileRots: number[] = [];
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const inOld = r < d.rows && c < d.cols;
          tiles.push(inOld ? (d.tiles[r * d.cols + c] ?? "plains") : "plains");
          tileVariants.push(inOld ? (d.tileVariants[r * d.cols + c] ?? 0) : 0);
          tileRots.push(inOld ? (d.tileRots?.[r * d.cols + c] ?? 0) : 0);
        }
      }
      const inBounds = (s: Spawn) => s.x < cols && s.y < rows;
      const decorations = d.decorations.filter((p) => {
        const def = DECORATIONS[p.id];
        if (!def) return false;
        return def.footprint.every((f) => p.x + f.dx >= 0 && p.y + f.dy >= 0 && p.x + f.dx < cols && p.y + f.dy < rows);
      });
      return {
        ...d,
        cols,
        rows,
        tiles,
        tileVariants,
        tileRots,
        decorations,
        playerSpawns: d.playerSpawns.filter(inBounds),
        enemySpawns: d.enemySpawns.filter(inBounds),
        neutralSpawns: (d.neutralSpawns ?? []).filter(inBounds),
      };
    });
  };

  const updateSpawn = (side: SpawnKey, i: number, patch: Partial<DraftSpawn>) => {
    setDraft((d) => {
      const list = (d[side] ?? []).slice();
      list[i] = { ...list[i]!, ...patch };
      return { ...d, [side]: list };
    });
  };

  const removeSpawn = (side: SpawnKey, i: number) => {
    setDraft((d) => ({ ...d, [side]: (d[side] ?? []).filter((_, idx) => idx !== i) }));
  };

  const selectPreviewUnit = (unit: PreviewUnitSelection) => {
    setSelectedPreviewUnit(unit);
    setNote(`${unit.name} selecionado. Clique direito em um hex vazio da prévia para definir sua posição inicial.`);
  };

  const placePreviewUnit = (selected: PreviewUnitSelection, x: number, y: number) => {
    setSelectedPreviewUnit(selected);
    const occupied = SPAWN_KEYS.some((side) => (draft[side] ?? []).some((spawn, index) =>
      !(side === selected.side && index === selected.index) && spawn.x === x && spawn.y === y,
    ));
    if (occupied) {
      setNote("Esse hex já tem uma unidade. Escolha um hex vazio.");
      return;
    }
    const current = (draft[selected.side] ?? [])[selected.index];
    if (!current) {
      setSelectedPreviewUnit(null);
      setNote("Essa unidade não existe mais. Arraste outra na prévia.");
      return;
    }
    updateSpawn(selected.side, selected.index, { x, y });
    setNote(`${current.name} movido para ${x},${y}.`);
  };
  /** Drops one hero or the whole party on the bottom row. Worked out from the current draft
   * rather than inside the state updater: React runs that when it pleases, so counting
   * there reported on placements that had not happened yet. */
  const addHeroes = (who: { name: string; classId: ClassId }[]) => {
    const occupied = new Set(SPAWN_KEYS.flatMap((k) => draft[k] ?? []).map((s) => `${s.x},${s.y}`));
    const already = new Set(draft.playerSpawns.map((s) => s.name));
    const added: DraftSpawn[] = [];
    const skipped: string[] = [];
    let x = 0;
    const y = draft.rows - 1;
    for (const h of who) {
      if (already.has(h.name)) {
        skipped.push(h.name);
        continue;
      }
      while (x < draft.cols && occupied.has(`${x},${y}`)) x++;
      if (x >= draft.cols) break;
      added.push({ name: h.name, classId: h.classId, x, y, level: DEFAULT_TEST_LEVEL });
      occupied.add(`${x},${y}`);
      x++;
    }
    if (added.length > 0) setDraft((d) => ({ ...d, playerSpawns: [...d.playerSpawns, ...added] }));
    const put = added.map((a) => a.name).join(", ");
    if (added.length > 0) {
      setNote(skipped.length > 0 ? `${put} na linha de baixo (${skipped.join(", ")} já estava lá).` : `${put} na linha de baixo.`);
    } else {
      setNote(`${who.map((h) => h.name).join(", ")} já ${who.length > 1 ? "estavam" : "estava"} no mapa.`);
    }
  };

  /** Saves the map as a file in the repo — src/game/maps/<id><serial>.json — and keeps
   * a browser-local copy as the fallback for when the dev server isn't there to write
   * one (a built app, a deployed preview). Whichever path ran is what the note says: a
   * save that didn't happen never reports success. */
  const doSave = async () => {
    const canonicalId = normalizeScenarioId(draft.id);
    const savedDraft = canonicalId === draft.id ? draft : { ...draft, id: canonicalId };
    if (savedDraft !== draft) setDraft(savedDraft);
    const list = versionStore[savedDraft.id] ?? [];
    const localSerial = (list[list.length - 1]?.serial ?? 0) + 1;
    const next = { ...versionStore, [savedDraft.id]: [...list, { serial: localSerial, draft: savedDraft, savedAt: Date.now() }] };
    setVersionStore(next);
    const localOk = saveVersionStore(next);

    armEditorResume(savedDraft);
    const repo = await saveMapToRepo(savedDraft);
    if (repo.ok) {
      await refreshRepoFiles(savedDraft.id);
      await refreshSavedLocationMaps();
      setNote(`Salvo em ${repo.file}.`);
      return;
    }
    if (localOk) {
      setNote(`Sem servidor de dev: salvo só neste navegador como ${serialLabel(localSerial)} de "${savedDraft.id}" (${repo.error}). Use Ativar pra valer pra campanha.`);
      return;
    }
    setNote(`NÃO SALVOU: nem arquivo (${repo.error}) nem navegador. O mapa só existe nesta tela — exporte antes de sair.`);
  };

  const doExport = () => {
    void doSave();
    setExportText(JSON.stringify(draftToMission(draft), null, 2));
    setCopyOk(false);
  };

  /** Copies one browser-local version into src/game/maps/ without overwriting it.
   * The dev route assigns the next ID### serial on disk. */
  const doSendVersionToRepo = async (version: MapVersion) => {
    armEditorResume(version.draft);
    const repo = await saveMapToRepo(version.draft);
    if (repo.ok) {
      await refreshRepoFiles(version.draft.id);
      await refreshSavedLocationMaps();
    }
    setNote(
      repo.ok
        ? `v${serialLabel(version.serial)} enviada ao repositório como ${repo.file}.`
        : `NÃO ENVIOU v${serialLabel(version.serial)} ao repositório: ${repo.error}`,
    );
  };
  const doActivate = (serial: number) => {
    const selected = (versionStore[draft.id] ?? []).find((version) => version.serial === serial);
    if (!selected) {
      setNote(`NÃO ATIVOU v${serialLabel(serial)}: a cópia local dessa versão não foi encontrada.`);
      return;
    }
    const next = { ...activeVersions, [draft.id]: serial };
    if (!saveActiveDrafts({ ...loadActiveDrafts(), [draft.id]: selected.draft })) {
      setNote(`NÃO ATIVOU v${serialLabel(serial)}: o navegador recusou salvar a cópia da campanha.`);
      return;
    }
    setActiveVersions(next);
    saveActiveVersions(next);
    setNote(`v${serialLabel(serial)} agora é a cópia exata valendo pra "${draft.id}" na campanha.`);
  };

  const doDeactivate = () => {
    const next = { ...activeVersions };
    delete next[draft.id];
    const activeDrafts = { ...loadActiveDrafts() };
    delete activeDrafts[draft.id];
    setActiveVersions(next);
    saveActiveVersions(next);
    saveActiveDrafts(activeDrafts);
    setNote(`"${draft.id}" voltou a usar o cenário original.`);
  };

  /** Select an existing repository file directly for campaign play. It does not write a
   * replacement file: activation is a local campaign pointer to this exact draft. */
  const doActivateFile = (f: { serial: number; draft: MapDraft; file?: string }) => {
    const next = { ...activeVersions, [draft.id]: f.serial };
    if (!saveActiveDrafts({ ...loadActiveDrafts(), [draft.id]: f.draft })) {
      setNote(`NÃO ATIVOU ${f.file ?? mapFileName(draft.id, f.serial)}: o navegador recusou salvar a cópia da campanha.`);
      return;
    }
    setActiveVersions(next);
    saveActiveVersions(next);
    setDraft(f.draft);
    setNote(`${f.file ?? mapFileName(draft.id, f.serial)} agora é a cópia exata ativa na campanha.`);
  };

  /** Deletes a saved file. Two clicks: the first arms the button, so a misclick on a
   * row does not throw away a version that has no undo. */
  const doDeleteFile = async (name: string) => {
    if (armedDelete !== name) {
      setArmedDelete(name);
      setNote(`Clique de novo no X pra apagar ${name} — isso não tem volta.`);
      return;
    }
    setArmedDelete("");
    const res = await deleteMapFile(name);
    if (res.ok) await refreshRepoFiles(draft.id);
    setNote(res.ok ? `${name} apagado.` : `NÃO APAGOU ${name}: ${res.error}`);
  };

  /** Browser-local versions need the same two-click confirmation as repository files. */
  const doDeleteVersion = (serial: number) => {
    const key = `local:${draft.id}:${serial}`;
    if (armedDelete !== key) {
      setArmedDelete(key);
      setNote(`Erase? Clique de novo para apagar a versão local v${serialLabel(serial)} — isso não tem volta.`);
      return;
    }
    setArmedDelete("");
    const list = (versionStore[draft.id] ?? []).filter((v) => v.serial !== serial);
    const next = { ...versionStore, [draft.id]: list };
    if (list.length === 0) delete next[draft.id];
    setVersionStore(next);
    saveVersionStore(next);
    if (activeVersions[draft.id] === serial) doDeactivate();
    setNote(`v${serialLabel(serial)} excluída.`);
  };

  // Every list the editor offers is sorted by what it shows, not by the order things were
  // declared in — a class table grouped by role is fine to read in code and useless to
  // search in a dropdown. pt-BR collation so accents and case sort where a reader expects.
  const classOptions = (Object.keys(CLASSES) as ClassId[]).sort((a, b) => byName(CLASSES[a].name, CLASSES[b].name));
  const summonOptions = [...SUMMON_CLASSES].sort((a, b) => byName(CLASSES[a].name, CLASSES[b].name));
  const decorOptions = Object.values(DECORATIONS).sort((a, b) => byName(a.name, b.name));
  const decorationSectionFor = (id: string) => {
    if (id.includes("bridge") || id.includes("ember-channels")) return "Pontes";
    if (id.includes("mountain") || id.includes("ridge") || id.includes("rock") || id.includes("boulder") || id.includes("spike") || id.includes("cliff")) return "Pedras e relevo";
    if (id.includes("tree") || id.includes("forest") || id.includes("wood") || id.includes("log") || id.includes("mossy")) return "Natureza";
    if (id.includes("ruined") || id.includes("tower") || id.includes("mansion") || id.includes("wall") || id.includes("gate") || id.includes("shrine") || id.includes("house") || id.includes("hut") || id.includes("hamlet")) return "Ruínas e construções";
    return "Objetos";
  };
  const decorationSections = ["Todas", "Pontes", "Pedras e relevo", "Ruínas e construções", "Natureza", "Objetos"];
  const visibleDecorOptions = decoSection === "Todas" ? decorOptions : decorOptions.filter((dec) => decorationSectionFor(dec.id) === decoSection);

  /** Whatever unit stands on a cell, across all three spawn lists. */
  const spawnAt = (x: number, y: number) => {
    for (const key of SPAWN_KEYS) {
      const sp = (draft[key] ?? []).find((s) => s.x === x && s.y === y);
      if (sp) return { sp, side: SPAWN_SIDE[key], key };
    }
    return null;
  };

  /** Cell tooltip: the name, the class, and what the letter on the cell means. */
  const spawnHint = (sp: DraftSpawn, side: "player" | "enemy" | "neutral") => {
    const what = isSummonClass(sp.classId) ? "invocação" : side === "neutral" ? "fera neutra" : side === "enemy" ? "inimigo" : "herói";
    const where = side === "player" ? "aliada" : side === "enemy" ? "inimiga" : "neutra";
    return `${sp.name} · ${CLASSES[sp.classId].name} · ${isSummonClass(sp.classId) ? `${what} ${where}` : what}`;
  };

  return (
    <section className="map-editor h-dvh min-h-0 flex flex-col bg-bg">
      <header className="flex items-center gap-3 px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-4 border-b border-border">
        <button type="button" onClick={onBack} className="size-10 grid place-items-center rounded-md border border-border" aria-label="Voltar">
          <ChevronLeft className="size-5" />
        </button>
        <div className="flex-1 min-w-0">
          <p className="text-sm uppercase tracking-[0.18em] text-muted">Modo teste</p>
          <h1 className="font-display text-2xl leading-none">Map Editor</h1>
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto p-4 flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              const d = blankDraft();
              setDraft(d);
              setNote(`Mapa novo em branco — cenário "${d.id}", ${d.cols}x${d.rows}.`);
            }}
          >
            Novo
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setShowLocations(true)}>
            Locais
          </Button>
          <Button
            variant="ghost"
            size="sm"
            title="Espalha barricadas, barrancos e terreno alto pelo mapa do tamanho atual — depois é só limpar o que não serve"
            onClick={() => {
              // Everything the campaign lays over a map on load — scatter, rocks, chests
              // and decoration — aimed at the map in hand: fill the board with something to
              // react to, then clear what does not belong.
              // Generate replaces, it does not pile on: the decoration pass appends to what
              // it is handed, so without clearing first a second press stacked scenery on
              // top of the last lot.
              const filled = dressMap(draftToMission({ ...draft, autoTactics: true, decorations: [] }), shuffleExclude);
              const tiles = parseLayout(filled.layout);
              // The scatter paints barricades as terrain; they are a decoration now, so the
              // props come back with them — same derivation the engine does on load.
              const scattered = filled.decorations ?? [];
              const decorations = [...scattered, ...barricadeDecor(tiles, draft.cols, draft.rows, scattered)];
              setDraft((d) => ({
                ...d,
                tiles,
                tileVariants: tiles.map((t, i) => Math.min(d.tileVariants[i] ?? 0, (TILE_VARIANT_COUNT[t] ?? 1) - 1)),
                tileRots: tiles.map((_t, i) => d.tileRots?.[i] ?? 0),
                decorations,
              }));
              const counts = new Map<TerrainId, number>();
              for (const t of tiles) if (t !== "plains") counts.set(t, (counts.get(t) ?? 0) + 1);
              const summary = [...counts.entries()].map(([t, n]) => `${n} ${TERRAIN[t].name.toLowerCase()}`).join(", ");
              setNote(
                `Gerado em ${draft.cols}x${draft.rows}: ${summary || "nada"}${decorations.length > 0 ? `, ${decorations.length} decoração(ões)` : ""} — apague o que não servir.`,
              );
            }}
          >
            Gerar terreno
          </Button>
          <select
            className="bg-bg border border-border rounded-md px-2 py-1.5"
            value=""
            onChange={(e) => {
              const m = missionById(e.target.value);
              if (!m) return;
              setDraft(missionToDraft(m));
              setNote(`Carregado "${m.title}" (${m.id}) da campanha — ${m.cols}x${m.rows}.`);
            }}
          >
            <option value="">Carregar da campanha…</option>
            {ALL_MISSIONS.filter((m) => !m.hub).map((m) => (
              <option key={m.id} value={m.id}>
                {m.title}
              </option>
            ))}
          </select>
          {pickable.length > 0 && (
            <select
              id="mapPick"
              className="flex-1 min-w-0 bg-bg border border-border rounded-md px-2 py-1.5"
              value=""
              title="Abre o save mais recente desse cenário — a lista de arquivos abaixo deixa escolher outro serial"
              onChange={(e) => {
                const id = e.target.value;
                if (!id) return;
                const fromDisk = latestSavedDraft(id);
                if (fromDisk) {
                  setDraft(fromDisk);
                  setNote(`Aberto ${mapFileName(id, latestSerialFor(id))} — o save mais novo de "${id}".`);
                  return;
                }
                const list = versionStore[id];
                const latest = list?.[list.length - 1];
                if (latest) {
                  setDraft(latest.draft);
                  setNote(`Aberta v${serialLabel(latest.serial)} de "${id}" — só neste navegador, sem arquivo.`);
                }
              }}
            >
              <option value="">Abrir mapa salvo…</option>
              {pickable.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.id} ({row.files > 0 ? `${row.files} arquivo${row.files === 1 ? "" : "s"}` : `${row.local} só no navegador`}
                  {activeVersions[row.id] ? `, v${serialLabel(activeVersions[row.id])} ativa` : ""})
                </option>
              ))}
            </select>
          )}
        </div>


        <div className="grid grid-cols-2 gap-2 text-sm">
          <label className="flex flex-col gap-1" title="O cenário da campanha que essa edição mira. Bate com o id de uma missão real (ex.: o-vau) pra poder ativar essa versão nela, ou qualquer id livre pra um mapa avulso.">
            <span className="text-muted text-xs uppercase tracking-wide">Cenário alvo (Id)</span>
            <input
              className="bg-bg border border-border rounded-md px-2 py-1.5"
              value={draft.id}
              onChange={(e) => setDraft((d) => ({ ...d, id: normalizeScenarioId(e.target.value) }))}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted text-xs uppercase tracking-wide">Título</span>
            <input
              className="bg-bg border border-border rounded-md px-2 py-1.5"
              value={draft.title}
              onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted text-xs uppercase tracking-wide">Local</span>
            <input
              className="bg-bg border border-border rounded-md px-2 py-1.5"
              value={draft.place}
              onChange={(e) => setDraft((d) => ({ ...d, place: e.target.value }))}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted text-xs uppercase tracking-wide">Trilha</span>
            <select
              className="bg-bg border border-border rounded-md px-2 py-1.5"
              value={draft.music ?? ""}
              onChange={(e) => {
                const v = e.target.value;
                setDraft((d) => ({ ...d, music: v }));
                setNote(v ? `Trilha desta missão: ${v}.` : "Trilha desta missão: a do tema padrão.");
              }}
            >
              <option value="">Tema padrão (pelo id da missão)</option>
              {[...MUSIC_TRACKS].sort(byName).map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
            <span className="text-muted text-[11px]">
              Os arquivos de public/game/MUSIC, pelo nome. Toca durante o briefing, a batalha e as telas de fim.
            </span>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted text-xs uppercase tracking-wide">Objetivo</span>
            <input
              className="bg-bg border border-border rounded-md px-2 py-1.5"
              value={draft.objective}
              onChange={(e) => setDraft((d) => ({ ...d, objective: e.target.value }))}
            />
          </label>
          <label className="flex flex-col gap-1 col-span-2">
            <span className="text-muted text-xs uppercase tracking-wide">Briefing</span>
            <textarea
              className="bg-bg border border-border rounded-md px-2 py-1.5 min-h-16"
              value={draft.briefing}
              onChange={(e) => setDraft((d) => ({ ...d, briefing: e.target.value }))}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted text-xs uppercase tracking-wide">Vitória</span>
            <select
              className="bg-bg border border-border rounded-md px-2 py-1.5"
              value={draft.win}
              onChange={(e) => setDraft((d) => ({ ...d, win: e.target.value as WinCondition }))}
            >
              <option value="rout">Derrote todos (rout)</option>
              <option value="boss">Derrube o chefe (boss)</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted text-xs uppercase tracking-wide">Local no mapa-múndi</span>
            <select
              className="bg-bg border border-border rounded-md px-2 py-1.5"
              value={draft.locationId}
              onChange={(e) => setDraft((d) => ({ ...d, locationId: e.target.value }))}
            >
              <option value="">Nenhum — não aparece no mapa</option>
              {ALL_LOCATIONS.map((l) => {
                const planned = slotsFor(l.id);
                return (
                  <option key={l.id} value={l.id}>
                    {l.name}
                    {planned > 0 ? ` (${l.missionIds.length}/${planned})` : l.missionIds.length === 0 ? " (vazio)" : ` (${l.missionIds.length})`}
                  </option>
                );
              })}
            </select>
          </label>
          {draft.locationId !== "" &&
            (() => {
              const loc = ALL_LOCATIONS.find((l) => l.id === draft.locationId);
              const fill = locationFill(draft.locationId);
              const declared = slots[draft.locationId] ?? 0;
              return (
                <label className="flex flex-col gap-1">
                  <span className="text-muted text-xs uppercase tracking-wide">Telas em {loc?.name ?? draft.locationId}</span>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={0}
                      max={99}
                      className="w-16 bg-bg border border-border rounded-md px-2 py-1.5"
                      value={declared}
                      onChange={(e) => {
                        const n = Math.max(0, Math.min(99, Number(e.target.value) || 0));
                        const next = { ...slots };
                        if (n > 0) next[draft.locationId] = n;
                        else delete next[draft.locationId];
                        void doSaveSlots(next);
                      }}
                    />
                    <span className="text-xs text-muted">
                      {fill.declared === 0
                        ? `${fill.filled} feita(s) — sem plano definido`
                        : `${fill.filled} de ${fill.declared} feita(s), faltam ${fill.empty}`}
                    </span>
                  </div>
                  {loc && loc.missionIds.length > 0 && (
                    <span className="text-xs text-muted truncate">
                      Já lá: {loc.missionIds.join(", ")}
                    </span>
                  )}
                </label>
              );
            })()}
          <label className="flex items-center gap-2 mt-5">
            <input type="checkbox" checked={draft.hub} onChange={(e) => setDraft((d) => ({ ...d, hub: e.target.checked }))} />
            <span className="text-muted">É um hub (sem combate)</span>
          </label>
          <label className="flex items-center gap-2" title="Barricadas, barrancos e variantes de terreno alto espalhados por cima do mapa depois que ele carrega">
            <input
              type="checkbox"
              checked={draft.autoTactics}
              onChange={(e) => {
                setDraft((d) => ({ ...d, autoTactics: e.target.checked }));
                setNote(
                  e.target.checked
                    ? "Terreno automático ligado — barricadas e barrancos entram por cima do que você pintou."
                    : "Terreno automático desligado — o mapa carrega exatamente como está pintado.",
                );
              }}
            />
            <span className="text-muted">Terreno automático</span>
          </label>
        </div>

        <div className="flex items-center gap-2 text-sm">
          <label className="flex items-center gap-1">
            <span className="text-muted text-xs uppercase tracking-wide">Col</span>
            <input
              type="number"
              className="w-16 bg-bg border border-border rounded-md px-2 py-1"
              value={draft.cols}
              onChange={(e) => resize(Number(e.target.value) || draft.cols, draft.rows)}
            />
          </label>
          <label className="flex items-center gap-1">
            <span className="text-muted text-xs uppercase tracking-wide">Lin</span>
            <input
              type="number"
              className="w-16 bg-bg border border-border rounded-md px-2 py-1"
              value={draft.rows}
              onChange={(e) => resize(draft.cols, Number(e.target.value) || draft.rows)}
            />
          </label>
          <div className="flex-1" />
          <div className="flex rounded-md border border-border overflow-hidden text-xs">
            {(["hex", "square"] as const).map((g) => (
              <button
                key={g}
                type="button"
                onClick={() => setGridStyle(g)}
                title={g === "hex" ? "Grade em hexágono, igual ao jogo" : "Grade quadrada (mais rápida de editar)"}
                className={`px-2.5 py-1.5 ${gridStyle === g ? "bg-accent text-bg" : "bg-bg text-muted"}`}
              >
                {g === "hex" ? "Hexágono" : "Quadrado"}
              </button>
            ))}
          </div>
          <div className="flex rounded-md border border-border overflow-hidden text-xs">
            {(["paint", "decoration", "player", "enemy", "summon"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`px-2.5 py-1.5 ${mode === m ? "bg-accent text-bg" : "bg-bg text-muted"}`}
              >
                {m === "paint" ? "Terreno" : m === "decoration" ? "Decoração" : m === "player" ? "Herói" : m === "enemy" ? "Inimigo" : "Invocação"}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => addHeroes(EDITOR_HEROES)}>
            Party completa
          </Button>
          {EDITOR_HEROES.map((h) => (
            <Button
              key={h.name}
              variant="ghost"
              size="sm"
              title={CLASSES[h.classId].name}
              onClick={() => addHeroes([h])}
            >
              {h.name}
            </Button>
          ))}
          <p className="text-xs text-muted ml-auto">Nível de cada um é editável na lista abaixo.</p>
        </div>

        {mode === "paint" && (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-xs text-muted flex-1 min-w-[12rem]">Básicos na campanha: planície, bosque, água. Aqui pinta qualquer um.</p>
              <Button
                size="sm"
                variant={turning ? "primary" : "ghost"}
                onClick={() => {
                  setTurning((v) => !v);
                  setNote(turning ? "Pincel de volta: clicar pinta o terreno." : "Girar armado: cada clique num hex vira o desenho 60°, sem trocar o terreno. O ponto vermelho mostra onde é o lado de baixo.");
                }}
                title="Gira o desenho do hex 60° por clique, para casar costa, estrada e muro com o vizinho. O terreno e a variante não mudam; seis cliques voltam ao original."
              >
                {turning ? "Girando — clique num hex" : "Girar hex"}
              </Button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {BUILDER_TERRAIN.map((t) => (
                <button
                  key={t}
                  type="button"
                  title={terrainHint(t, brush === t ? variant : 0)}
                  onClick={() => {
                    setBrush(t);
                    setVariant((v) => Math.min(v, (TILE_VARIANT_COUNT[t] ?? 1) - 1));
                  }}
                  className={`text-xs px-1.5 py-1 rounded-md border flex items-center gap-1.5 ${brush === t ? "border-accent" : "border-border"}`}
                >
                  <img src={tileVariantSrc(t, 0)} alt="" className="size-7 rounded-sm object-cover bg-bg" />
                  {TERRAIN[t].name}
                </button>
              ))}
            </div>
            {(TILE_VARIANT_COUNT[brush] ?? 1) >= 1 && (
              <div className="flex items-start gap-1.5 text-xs">
                <span className="mt-1 text-muted uppercase tracking-wide">Versões</span>
                <div className="h-28 min-h-[104px] min-w-0 flex-1 ember-scrollbar overflow-x-auto overflow-y-hidden rounded-md border border-border bg-bg/40 p-1.5">
                  <div className="grid grid-flow-col grid-rows-2 auto-cols-max gap-1.5">
                    {Array.from({ length: TILE_VARIANT_COUNT[brush] ?? 1 }, (_, i) => (
                  <button
                    key={i}
                    type="button"
                    title={VARIANT_LABEL[brush]?.[i] ?? `Arte ${String(i + 1).padStart(3, "0")}`}
                    onClick={() => setVariant(i)}
                    className={`flex items-center gap-1 rounded-md border overflow-hidden pr-1.5 ${variant === i ? "border-accent" : "border-border"}`}
                  >
                    <img src={tileVariantSrc(brush, i)} alt="" className="size-8 object-cover" />
                    <span>{VARIANT_LABEL[brush]?.[i] ?? String(i + 1).padStart(3, "0")}</span>
                  </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
        {mode === "decoration" && (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-xs text-muted flex-1 min-w-[12rem]">
                Clique na casa âncora pra colocar; clique em qualquer casa que a decoração cubra pra remover. Toda casa
                coberta fica intransponível e bloqueia visão/tiro, não importa o terreno por baixo.
              </p>
              <Button
                size="sm"
                variant={turningDeco ? "primary" : "ghost"}
                onClick={() => {
                  setTurningDeco((v) => !v);
                  setNote(
                    turningDeco
                      ? "Pincel de volta: clicar coloca e remove decoração."
                      : "Girar objeto armado: cada clique numa decoração vira ela 60°, com toda a área junto. Seis cliques voltam ao original.",
                  );
                }}
                title="Gira a decoração 60° por clique. Uma que ocupa vários hexes gira a área inteira de uma vez — um hexágono cai sobre si mesmo a cada 60°, então essas são as únicas voltas que ainda caem em casas reais."
              >
                {turningDeco ? "Girando — clique numa decoração" : "Girar objeto"}
              </Button>
            </div>
            <p className="text-xs text-muted">
              O dado em cada uma liga/desliga se ela pode sair no sorteio de "Gerar terreno" — aceso participa, apagado só
              entra no mapa se você colocar à mão.
            </p>

            <div className="ember-scrollbar overflow-x-auto overflow-y-hidden border border-border rounded-md p-1.5 bg-bg/40 h-28 min-h-[104px] min-w-[280px]">
              <div className="grid grid-rows-2 grid-flow-col auto-cols-max gap-1.5">
                {visibleDecorOptions.map((dec) => {
                  const excluded = shuffleExclude.has(dec.id);
                  return (
                    <div
                      key={dec.id}
                      className={`flex items-center gap-1 text-xs pl-2 pr-1 py-1 rounded-md border transition-shadow ${decoBrush === dec.id ? "border-amber-300 bg-amber-300/15 ring-2 ring-amber-300/70 shadow-[0_0_13px_rgba(251,191,36,0.55)]" : "border-border"}`}
                    >
                      <button
                        type="button"
                        title={`${dec.name} · ${dec.footprint.length} hexes`}
                        onClick={() => setDecoBrush(dec.id)}
                        className="flex items-center gap-1.5"
                      >
                        <img src={decorationImage(dec.id)} alt="" className="size-6 rounded-sm object-cover bg-bg" />
                        {dec.name}
                      </button>
                      <button
                        type="button"
                        onClick={() => toggleShuffleExclude(dec.id)}
                        className={`px-1 ${excluded ? "text-muted" : "text-accent"}`}
                        aria-label={excluded ? `${dec.name}: fora do sorteio` : `${dec.name}: no sorteio`}
                        title={
                          excluded
                            ? 'Fora do sorteio de "Gerar terreno" — clique pra incluir'
                            : 'No sorteio de "Gerar terreno" — clique pra excluir'
                        }
                      >
                        <Dices className="size-3.5" />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
        {(mode === "player" || mode === "enemy") && (
          <p className="text-xs text-muted">
            Clique numa casa vazia pra adicionar {mode === "player" ? "um herói" : "um inimigo"}; clique numa casa ocupada
            (do mesmo lado) pra remover. Edite nome/classe na lista abaixo.
          </p>
        )}

        {mode === "summon" && (
          <div className="flex flex-col gap-2 border border-border rounded-md p-2 bg-bg/40">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs uppercase tracking-wide text-muted">Lado</span>
              <div className="flex rounded-md overflow-hidden border border-border text-xs">
                {(["player", "neutral", "enemy"] as const).map((sd) => (
                  <button
                    key={sd}
                    type="button"
                    onClick={() => setSummonSide(sd)}
                    className={`px-2.5 py-1.5 ${
                      summonSide === sd
                        ? sd === "enemy"
                          ? "bg-danger text-bg"
                          : sd === "neutral"
                            ? "bg-emerald-500 text-bg"
                            : "bg-accent text-bg"
                        : "bg-bg text-muted"
                    }`}
                  >
                    {sd === "player" ? "Aliada" : sd === "neutral" ? "Neutra" : "Inimiga"}
                  </button>
                ))}
              </div>
              <span className="text-xs uppercase tracking-wide text-muted ml-2">Tipo</span>
              <select
                className="bg-bg border border-border rounded-md px-1.5 py-1 text-xs"
                value={summonBrush}
                onChange={(e) => setSummonBrush(e.target.value as ClassId)}
              >
                {summonOptions.map((c) => (
                  <option key={c} value={c}>
                    {CLASSES[c].name} · {CLASSES[c].role}
                  </option>
                ))}
              </select>
            </div>
            <p className="text-xs text-muted">
              Clique numa casa vazia pra pôr {CLASSES[summonBrush].name.toLowerCase()}{" "}
              {summonSide === "enemy" ? "do lado inimigo" : summonSide === "neutral" ? "como fera neutra" : "do lado aliado"};
              clique numa casa ocupada desse lado pra remover.
            </p>
            <p className="text-xs text-muted">
              {summonSide === "player"
                ? "Aliadas não contam na derrota — perder todas não perde a missão."
                : summonSide === "enemy"
                  ? "Inimigas contam pra limpar o mapa, como qualquer inimigo."
                  : "Neutras ficam paradas: não entram na ordem de turno e não contam pra limpar o mapa. Atacar uma acorda o bando inteiro da mesma classe, que vira inimigo e passa a agir na rodada seguinte. Não tem volta."}
            </p>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs uppercase tracking-wide text-muted">Prévia com os gráficos do jogo</p>
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              variant="quiet"
              title="Preenche todos os hexes com o terreno e a versão selecionados acima"
              onClick={replaceBaseTile}
            >
              <img src={tileVariantSrc(brush, variant)} alt="" className="size-5 rounded-sm object-cover" />
              Substituir base
            </Button>
            <label className="flex items-center gap-1 rounded-md border border-border bg-bg px-2 py-1 text-xs" title="Categoria atualmente exibida na paleta de decorações">
              <span className="text-muted">Decorações</span>
              <select className="max-w-36 bg-transparent text-fg outline-none" value={decoSection} onChange={(e) => setDecoSection(e.target.value)}>
                {decorationSections.map((section) => (
                  <option key={section} value={section}>{section}</option>
                ))}
              </select>
            </label>            <Button
              size="sm"
              variant={showPreview ? "quiet" : "ghost"}
              onClick={() => {
                const next = !showPreview;
                setShowPreview(next);
                if (next) setPreviewMission(draftToMission(draft));
              }}
            >
              {showPreview ? "Ocultar prévia" : "Mostrar prévia"}
            </Button>
          </div>
        </div>
        {showPreview && (
          <ResizableEditorPanel
            className="overflow-hidden border border-border rounded-md bg-black h-[40vh] min-h-[220px] min-w-[280px]"
            title="Arraste esta alça para redimensionar a prévia"
            minHeight={220}
          >
            {previewMission ? (
              <MapPreviewCanvas
                mission={previewMission}
                art={art}
                onCellClick={onCellClick}
                selectedDecorationId={mode === "decoration" ? decoBrush : undefined}
                selectedUnit={selectedPreviewUnit}
                onUnitSelect={selectPreviewUnit}
                onUnitPlace={placePreviewUnit}
              />
            ) : (
              <div className="h-full w-full grid place-items-center text-xs text-muted">Carregando prévia…</div>
            )}
          </ResizableEditorPanel>
        )}

        <ResizableEditorPanel
          className="ember-scrollbar overflow-auto border border-border rounded-md p-2 bg-black h-[60vh] min-h-[320px] min-w-[280px]"
          title="Arraste esta alça para redimensionar o mapa"
          minHeight={320}
        >
          <div className="grid min-h-full min-w-full w-max place-items-center">
            {gridStyle === "square" ? (
              <div
                className="grid gap-px w-max"
                style={{ gridTemplateColumns: `repeat(${draft.cols}, 56px)` }}
              >
              {draft.tiles.map((t, i) => {
                const x = i % draft.cols;
                const y = Math.floor(i / draft.cols);
                const occ = spawnAt(x, y);
                const deco = decoLookup.get(`${x},${y}`);
                return (
                  <button
                    key={i}
                    type="button"
                    title={occ ? spawnHint(occ.sp, occ.side) : (deco ?? terrainHint(t, draft.tileVariants[i] ?? 0))}
                    onClick={() => onTechnicalClick(x, y)}
                    className={`relative size-[56px] grid place-items-center text-sm font-bold ${deco ? "outline outline-2 outline-offset-[-2px] outline-amber-400/80" : ""}`}
                    style={{ background: TERRAIN_SWATCH[t] }}
                  >
                    {/* The type's own colour fills the cell; the serial names which art
                        variant is painted there; the red dot marks the hex's bottom side, so
                        a turned tile can be read without clicking it. */}
                    <span className="absolute inset-0 grid place-items-center text-[11px] font-semibold text-white [text-shadow:0_1px_2px_rgba(0,0,0,0.95)]">
                      {String((draft.tileVariants[i] ?? 0) + 1).padStart(3, "0")}
                    </span>
                    {(() => {
                      const { dx, dy } = bottomDot(draft.tileRots?.[i] ?? 0, 21);
                      return (
                        <span
                          className="absolute size-[7px] rounded-full bg-red-500 ring-1 ring-black/60"
                          style={{ left: 28 + dx - 3.5, top: 28 + dy - 3.5 }}
                          title={`lado de baixo · girado ${((draft.tileRots?.[i] ?? 0) * 60)}°`}
                        />
                      );
                    })()}
                    {occ ? (
                      <span className={SIDE_INK[occ.side]}>{spawnGlyph(occ.sp, occ.side)}</span>
                    ) : deco ? (
                      <span className="text-amber-300">D</span>
                    ) : null}
                  </button>
                );
              })}
              </div>
            ) : (
            (() => {
              // The editor grid is where the map actually gets read: the old 13 left the
              // per-hex serial nowhere to sit, and the serial now sits in the middle with a
              // facing dot around it, so it wants the room.
              const HR = 32;
              const SQRT3 = Math.sqrt(3);
              const hexW = SQRT3 * HR;
              const hexH = 2 * HR;
              const boardW = HR * SQRT3 * (draft.cols + 0.5);
              const boardH = HR * (1.5 * (draft.rows - 1) + 2);
              return (
                <div className="relative" style={{ width: boardW, height: boardH }}>
                  {draft.tiles.map((t, i) => {
                    const x = i % draft.cols;
                    const y = Math.floor(i / draft.cols);
                    const occ = spawnAt(x, y);
                    const deco = decoLookup.get(`${x},${y}`);
                    const cx = HR * SQRT3 * (x + 0.5 * (y & 1) + 0.5);
                    const cy = HR * (1.5 * y + 1);
                    return (
                      <button
                        key={i}
                        type="button"
                        title={occ ? spawnHint(occ.sp, occ.side) : (deco ?? terrainHint(t, draft.tileVariants[i] ?? 0))}
                        onClick={() => onTechnicalClick(x, y)}
                        className={`absolute grid place-items-center text-sm font-bold border ${deco ? "border-amber-400" : "border-black/20"}`}
                        style={{
                          left: cx - hexW / 2,
                          top: cy - HR,
                          width: hexW,
                          height: hexH,
                          background: TERRAIN_SWATCH[t],
                          clipPath: "polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)",
                        }}
                      >
                        {/* The type's own colour fills the hex; the serial names which art
                            variant is painted there; the red dot marks the hex's bottom
                            side, so a turned tile reads without clicking it. */}
                        <span className="absolute inset-0 grid place-items-center text-[11px] font-semibold text-white [text-shadow:0_1px_2px_rgba(0,0,0,0.95)]">
                          {String((draft.tileVariants[i] ?? 0) + 1).padStart(3, "0")}
                        </span>
                        {(() => {
                          const { dx, dy } = bottomDot(draft.tileRots?.[i] ?? 0, HR * 0.66);
                          return (
                            <span
                              className="absolute size-[7px] rounded-full bg-red-500 ring-1 ring-black/60"
                              style={{ left: hexW / 2 + dx - 3.5, top: HR + dy - 3.5 }}
                              title={`lado de baixo · girado ${((draft.tileRots?.[i] ?? 0) * 60)}°`}
                            />
                          );
                        })()}
                        {occ ? (
                          <span className={SIDE_INK[occ.side]}>{spawnGlyph(occ.sp, occ.side)}</span>
                        ) : deco ? (
                          <span className="text-amber-300">D</span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              );
            })()
            )}
          </div>
        </ResizableEditorPanel>

        {draft.decorations.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <p className="text-xs uppercase tracking-wide text-muted">Decorações ({draft.decorations.length})</p>
            {draft.decorations.map((p, i) => (
              <div key={i} className="flex items-center gap-1.5 text-xs bg-bg border border-border rounded-md px-2 py-1">
                <img src={decorationImage(p.id)} alt="" className="size-6 rounded-sm object-cover" />
                <span className="flex-1 min-w-0 truncate">{DECORATIONS[p.id]?.name ?? p.id}</span>
                <span className="text-muted tabular-nums">{p.x},{p.y}</span>
                <button
                  type="button"
                  onClick={() => setDraft((d) => ({ ...d, decorations: d.decorations.filter((_, idx) => idx !== i) }))}
                  className="text-danger px-1"
                  aria-label="Remover"
                >
                  <X className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Four groups over two lists: a spawn's class decides whether it is listed as a
            unit of the cast or as a summon, so changing the class in the dropdown moves the
            row between groups on its own. Indices stay the real ones into draft[side] —
            updateSpawn/removeSpawn address the underlying list, not the filtered view. */}
        {SPAWN_GROUPS.map((group) => {
          const side = group.side;
          const rows = (draft[side] ?? []).map((sp, i) => ({ sp, i })).filter(({ sp }) => isSummonClass(sp.classId) === group.summon);
          if (rows.length === 0) return null;
          return (
          <div key={`${side}-${group.summon}`} className="flex flex-col gap-1.5">
            <p className="text-xs uppercase tracking-wide text-muted">
              {group.label} ({rows.length})
            </p>
            {rows.map(({ sp: s, i }) => (
              <div key={i} className="flex items-center gap-1.5 text-xs">
                <span className="text-muted tabular-nums w-10">{s.x},{s.y}</span>
                <input
                  className="flex-1 min-w-0 bg-bg border border-border rounded-md px-1.5 py-1"
                  value={s.name}
                  onChange={(e) => updateSpawn(side, i, { name: e.target.value })}
                />
                <select
                  className="bg-bg border border-border rounded-md px-1.5 py-1"
                  value={s.classId}
                  onChange={(e) => updateSpawn(side, i, { classId: e.target.value as ClassId })}
                >
                  {classOptions.map((c) => (
                    <option key={c} value={c}>
                      {CLASSES[c].name} · {CLASSES[c].role}
                    </option>
                  ))}
                </select>
                <label className="flex items-center gap-1 shrink-0" title="Nível (só afeta o Testar)">
                  <span className="text-muted">Nv</span>
                  <input
                    type="number"
                    min={1}
                    max={MAX_LEVEL}
                    className="w-12 bg-bg border border-border rounded-md px-1 py-1"
                    value={s.level}
                    onChange={(e) =>
                      updateSpawn(side, i, { level: Math.max(1, Math.min(MAX_LEVEL, Number(e.target.value) || DEFAULT_TEST_LEVEL)) })
                    }
                  />
                </label>
                {side === "enemySpawns" && (
                  <button
                    type="button"
                    onClick={() => {
                      const pool = classOptions.filter((c) => !isSummonClass(c));
                      const pick = pool[Math.floor(Math.random() * pool.length)] ?? s.classId;
                      updateSpawn(side, i, { classId: pick });
                    }}
                    className="text-muted hover:text-fg px-1.5"
                    aria-label="Sortear classe"
                    title="Sortear uma classe inimiga aleatória"
                  >
                    <Shuffle className="size-3.5" />
                  </button>
                )}
                <button type="button" onClick={() => removeSpawn(side, i)} className="text-danger px-1.5" aria-label="Remover">
                  <X className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
          );
        })}


        <div className="flex flex-col gap-1.5">
          <p className="text-xs uppercase tracking-wide text-muted">
            Arquivos de "{draft.id}" no repositório ({repoFiles.length})
          </p>
          {repoFiles.length === 0 ? (
            <p className="text-xs text-muted">Nenhum — Salvar grava src/game/maps/{mapFileName(draft.id, 1)}.</p>
          ) : (
            <div className="flex flex-col gap-1">
              {repoFiles
                .slice()
                .reverse()
                .map((f) => (
                  <div key={f.serial} className="flex items-center gap-1.5 text-xs bg-bg border border-border rounded-md px-2 py-1.5">
                    <span className={`font-bold tabular-nums ${f.serial === repoLatest ? "text-accent" : ""}`}>{serialLabel(f.serial)}</span>
                    <span className="text-muted flex-1 min-w-0 truncate">
                      {f.file ?? mapFileName(draft.id, f.serial)}
                      {f.serial === activeSerial ? " · ativa na campanha" : f.serial === repoLatest ? " · arquivo mais novo" : ""}
                    </span>
                    <Button size="sm" variant="quiet" onClick={() => setDraft(f.draft)}>
                      Carregar
                    </Button>
                    <Button size="sm" variant="quiet" disabled={f.serial === activeSerial} onClick={() => doActivateFile(f)}>
                      Ativar
                    </Button>
                    <button
                      type="button"
                      onClick={() => void doDeleteFile(f.file ?? mapFileName(draft.id, f.serial))}
                      className={`px-1 ${armedDelete === (f.file ?? mapFileName(draft.id, f.serial)) ? "text-danger font-bold" : "text-danger"}`}
                      aria-label={`Apagar ${f.file ?? mapFileName(draft.id, f.serial)}`}
                    >
                      {armedDelete === (f.file ?? mapFileName(draft.id, f.serial)) ? "Erase?" : "✕"}
                    </button>
                  </div>
                ))}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <p className="text-xs uppercase tracking-wide text-muted">
            Versões salvas de "{draft.id}" ({versions.length})
          </p>
          {versions.length === 0 ? (
            <p className="text-xs text-muted">Nenhuma ainda — Salvar cria a v{serialLabel(1)}.</p>
          ) : (
            <div className="flex flex-col gap-1">
              {versions
                .slice()
                .reverse()
                .map((v) => (
                  <div key={v.serial} className="flex items-center gap-1.5 text-xs bg-bg border border-border rounded-md px-2 py-1.5">
                    <span className={`font-bold tabular-nums ${activeSerial === v.serial ? "text-accent" : ""}`}>v{serialLabel(v.serial)}</span>
                    <span className="text-muted flex-1 min-w-0 truncate">
                      {new Date(v.savedAt).toLocaleString()}
                      {activeSerial === v.serial ? " · ativa na campanha" : ""}
                    </span>
                    <Button size="sm" variant="quiet" onClick={() => setDraft(v.draft)}>
                      Carregar
                    </Button>
                    <Button size="sm" variant="quiet" onClick={() => void doSendVersionToRepo(v)} title="Grava esta versão local no repositório com o próximo serial ID###">
                      Enviar ao repositório
                    </Button>
                    <Button size="sm" variant="quiet" disabled={activeSerial === v.serial} onClick={() => doActivate(v.serial)}>
                      Ativar
                    </Button>
                    <button
                      type="button"
                      onClick={() => doDeleteVersion(v.serial)}
                      className={`text-danger px-1 ${armedDelete === `local:${draft.id}:${v.serial}` ? "font-bold" : ""}`}
                      aria-label={`Excluir versão v${serialLabel(v.serial)}`}
                    >
                      {armedDelete === `local:${draft.id}:${v.serial}` ? "Erase?" : <X className="size-3.5" />}
                    </button>
                  </div>
                ))}
            </div>
          )}
          {activeSerial != null && (
            <Button size="sm" variant="ghost" onClick={doDeactivate} title="Volta esse cenário a usar os dados originais imutáveis em vez de uma versão editada">
              Usar cenário original (desativar v{activeSerial})
            </Button>
          )}
        </div>

        {exportText && (
          <label className="flex flex-col gap-1">
            <span className="text-muted text-xs uppercase tracking-wide">
              Exportado — copia e manda pro Claude colar em data.ts
            </span>
            <textarea readOnly className="bg-bg border border-border rounded-md px-2 py-1.5 text-xs font-mono h-40" value={exportText} />
          </label>
        )}
      </div>

      <div className="p-4 pb-[max(1rem,env(safe-area-inset-bottom))] flex flex-col gap-2 border-t border-border">
        {/* Pinned to the action bar rather than sitting up in the form: Salvar lives down
            here, and a confirmation printed a screen and a half above it reads as silence.
            Keyed on the serial so the same message re-renders when an action repeats. */}
        {bigNote && (
          <div
            className={`rounded-lg border-2 px-3 py-2 max-h-[30vh] overflow-y-auto ${bigNote.ok ? "border-emerald-400 bg-emerald-500/20" : "border-red-500 bg-red-500/20"}`}
          >
            <div className="flex items-start justify-between gap-3">
              <p className={`font-display text-base font-bold tracking-tight leading-tight ${bigNote.ok ? "text-emerald-300" : "text-red-300"}`}>
                {bigNote.title}
              </p>
              <button type="button" onClick={() => setBigNote(null)} className="text-lg leading-none px-1 opacity-70" aria-label="Fechar">
                ×
              </button>
            </div>
            <ul className="mt-1 space-y-0.5">
              {bigNote.lines.map((l, i) => (
                <li key={i} className="text-xs leading-snug">
                  {l}
                </li>
              ))}
            </ul>
            {bigNote.dump && (
              <textarea
                readOnly
                value={bigNote.dump}
                onFocus={(e) => e.currentTarget.select()}
                className="mt-2 w-full h-20 bg-bg border border-border rounded-md p-2 text-xs font-mono"
              />
            )}
          </div>
        )}
        {note && (
          <p key={note.n} className="text-sm leading-snug font-medium text-accent bg-accent/15 border border-accent/60 rounded-md px-2 py-1.5">
            {note.text}
          </p>
        )}
        <div className="flex gap-2">
          <Button
            variant="quiet"
            className="flex-1"
            onClick={() => {
              const playerLevels = Object.fromEntries(draft.playerSpawns.map((s) => [s.name, s.level]));
              // Neutrals level off the same table as enemies — one of them may well end up
              // fighting as one before the mission is over.
              const enemyLevels = Object.fromEntries(
                [...draft.enemySpawns, ...(draft.neutralSpawns ?? [])].map((s) => [s.name, s.level]),
              );
              setNote("Testando — Encerrar teste nas Opções traz o mapa de volta como está.");
              onPlaytest(draftToMission(draft), playerLevels, enemyLevels);
            }}
          >
            Testar
          </Button>

          <Button variant="quiet" className="flex-1" onClick={() => void doSave()}>
            Salvar mapa
          </Button>
          <Button variant="quiet" className="flex-1" onClick={doExport}>
            Exportar
          </Button>
          {exportText && (
            <Button
              variant="quiet"
              className="flex-1"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(exportText);
                  setCopyOk(true);
                } catch {
                  setCopyOk(false);
                }
              }}
            >
              {copyOk ? "Copiado!" : "Copiar"}
            </Button>
          )}
        </div>
      </div>

      {showLocations && (
        <div
          className="absolute inset-0 z-50 bg-bg/85 flex items-center justify-center p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowLocations(false);
          }}
        >
          <div className="w-full max-w-lg max-h-[85dvh] overflow-y-auto bg-surface border border-border rounded-xl p-5">
            <div className="flex items-center justify-between gap-3 mb-3">
              <div>
                <p className="font-display text-xl leading-tight">Locais</p>
                <p className="text-xs text-muted">Setas do título mudam a progressão entre Locais; setas das missões mudam a sequência interna.</p>
              </div>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="quiet" onClick={() => void saveScenarios()}>
                  Salvar
                </Button>
                <button type="button" onClick={() => setShowLocations(false)} className="size-8 grid place-items-center rounded-md border border-border" aria-label="Fechar">
                  <X className="size-4" />
                </button>
              </div>
            </div>

            <div className="flex flex-col gap-3">
              {locationOrder.map((locationId, locationIndex) => {
                const loc = ALL_LOCATIONS.find((location) => location.id === locationId);
                if (!loc) return null;
                const ids = order[loc.id] ?? loc.missionIds;
                const planned = slotsFor(loc.id);
                return (
                  <div key={loc.id} className="border border-border rounded-md p-2.5">
                    <div className="flex items-center gap-2 mb-1.5">
                      <p className="flex-1 text-xs uppercase tracking-wide text-muted">
                        {locationIndex + 1}. {loc.name}
                        {planned > 0 ? ` · ${ids.length}/${planned}` : ids.length > 0 ? ` · ${ids.length}` : " · vazio"}
                      </p>
                      <button type="button" disabled={locationIndex === 0} onClick={() => moveLocationInOrder(loc.id, -1)} className="px-1.5 rounded border border-border disabled:opacity-30" aria-label={`Subir ${loc.name} na campanha`} title="Subir Local na campanha">
                        ↑
                      </button>
                      <button type="button" disabled={locationIndex === locationOrder.length - 1} onClick={() => moveLocationInOrder(loc.id, 1)} className="px-1.5 rounded border border-border disabled:opacity-30" aria-label={`Descer ${loc.name} na campanha`} title="Descer Local na campanha">
                        ↓
                      </button>
                    </div>
                    <div className="mb-2 flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="quiet"
                        onClick={() => {
                          const fresh = blankDraft();
                          const mapId = normalizeScenarioId(`${loc.id}-${Date.now().toString(36)}`);
                          const nextIndex =
                            Math.max(
                              -1,
                              ...ids.map((id) =>
                                id === draft.id
                                  ? draft.index
                                  : missionById(id)?.index ?? savedLocationMaps.find((map) => map.id === id)?.index ?? -1,
                              ),
                            ) + 1;
                          setDraft({
                            ...fresh,
                            id: mapId,
                            index: nextIndex,
                            title: `Novo mapa — ${loc.name}`,
                            place: loc.name,
                            locationId: loc.id,
                          });
                          // The campaign structure is saved separately by "Salvar cenários".
                          // Put this brand-new ID in that pending structure immediately, so
                          // the button really does save the Local assignment the author chose.
                          setOrder((current) => ({ ...current, [loc.id]: [...(current[loc.id] ?? []), mapId] }));
                          setShowLocations(false);
                          setNote(`Mapa novo criado para ${loc.name}. Salvar cenários grava a posição; Salvar mapa grava o conteúdo.`);
                        }}
                      >
                        Novo mapa aqui
                      </Button>
                      <select
                        className="min-w-0 flex-1 bg-bg border border-border rounded px-1.5 py-1 text-xs"
                        value=""
                        title="Coloca neste Local um mapa seu já salvo"
                        onChange={(e) => {
                          const mapId = e.target.value;
                          e.target.value = "";
                          if (mapId) transferMission(mapId, loc.id);
                        }}
                      >
                        <option value="">Adicionar mapa salvo…</option>
                        {savedLocationMaps.filter((map) => !ids.includes(map.id)).map((map) => (
                          <option key={map.id} value={map.id}>
                            {map.title} · {map.id}
                          </option>
                        ))}
                      </select>
                    </div>
                    {ids.length === 0 ? (
                      <p className="text-xs text-muted">Nenhuma missão aqui ainda.</p>
                    ) : (
                      <div className="flex flex-col gap-1">
                        {ids.map((id, i) => {
                          const m = missionById(id);
                          return (
                            <div key={id} className="flex items-center gap-1.5 text-xs bg-bg border border-border rounded-md px-2 py-1.5">
                              <span className="tabular-nums text-muted w-5 shrink-0">{i + 1}.</span>
                              <span className="flex-1 min-w-0 truncate">{m ? m.title : id}</span>
                              <button type="button" disabled={i === 0} onClick={() => moveInOrder(loc.id, id, -1)} className="px-1.5 rounded border border-border disabled:opacity-30" aria-label="Subir">
                                ↑
                              </button>
                              <button type="button" disabled={i === ids.length - 1} onClick={() => moveInOrder(loc.id, id, 1)} className="px-1.5 rounded border border-border disabled:opacity-30" aria-label="Descer">
                                ↓
                              </button>
                              <button
                                type="button"
                                onClick={() => removeFromLocation(loc.id, id)}
                                className={`px-1 rounded border ${armedDelete === `location:${loc.id}:${id}` ? "border-danger text-danger font-bold" : "border-border text-danger"}`}
                                aria-label={`Remover ${m ? m.title : id} deste Local`}
                              >
                                {armedDelete === `location:${loc.id}:${id}` ? "Remover?" : "✕"}
                              </button>
                              <select
                                className="bg-bg border border-border rounded px-1 py-0.5 max-w-[8.5rem]"
                                value=""
                                title="Mover esta missão para outro local"
                                onChange={(e) => {
                                  const to = e.target.value;
                                  e.target.value = "";
                                  if (!to) return;
                                  const dest = ALL_LOCATIONS.find((l) => l.id === to);
                                  // Moving a mission changes where the campaign sends the
                                  // player, so it asks before it happens.
                                  if (!window.confirm(`Mover "${m ? m.title : id}" de ${loc.name} para ${dest?.name ?? to}?`)) return;
                                  transferMission(id, to);
                                }}
                              >
                                <option value="">Mover para…</option>
                                {ALL_LOCATIONS.filter((l) => l.id !== loc.id).map((l) => (
                                  <option key={l.id} value={l.id}>
                                    {l.name}
                                  </option>
                                ))}
                              </select>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

    </section>
  );
}

function CampaignScreen({
  missions = ALL_MISSIONS,
  locations = ALL_LOCATIONS,
  completed,
  test,
  ember,
  onBack,
  onPick,
}: {
  missions?: Mission[];
  locations?: WorldLocation[];
  completed: string[];
  test: boolean;
  ember: number;
  onBack: () => void;
  onPick: (id: string) => void;
}) {
  return (
    <section className="h-dvh min-h-0 flex flex-col bg-bg">
      <header className="flex items-center gap-3 px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-4 border-b border-border">
        <button type="button" onClick={onBack} className="size-10 grid place-items-center rounded-md border border-border" aria-label="Voltar">
          <ChevronLeft className="size-5" />
        </button>
        <div className="flex-1 min-w-0">
          <p className="text-sm uppercase tracking-[0.18em] text-muted">{test ? "Modo teste" : "Campanha"}</p>
          <h1 className="font-display text-3xl leading-none">Cenários</h1>
        </div>
        <p className="text-sm tabular-nums text-muted border border-border rounded-md px-2 py-1">Ember {ember}</p>
      </header>
      <ol className="flex-1 min-h-0 overflow-auto p-4 pb-[max(1rem,env(safe-area-inset-bottom))] flex flex-col gap-2">
        {missions.map((m, campaignNumber) => {
          const lock = lockedMission(m.id, completed, test, locations, missions.map((mission) => mission.id));
          const done = completed.includes(m.id);
          const openInn = !!m.hub && !lock;
          return (
            <li key={m.id}>
              <button
                type="button"
                disabled={lock}
                onClick={() => onPick(m.id)}
                className={`w-full text-left rounded-xl border bg-surface px-4 py-3 disabled:opacity-40 ${
                  openInn ? "inn-open" : "border-border"
                }`}
              >
                <p className="text-sm uppercase tracking-[0.16em] text-muted">
                  {String(campaignNumber + 1).padStart(2, "0")} · {m.place}
                  {m.hub && !lock ? " · aberta" : done ? " · feito" : ""}
                </p>
                <p className="font-display text-2xl">{m.title}</p>
                <p className="text-base text-muted">{m.objective}</p>
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function BriefingScreen({
  mission,
  onBack,
  onStart,
}: {
  mission: (typeof ALL_MISSIONS)[number];
  onBack: () => void;
  onStart: () => void;
}) {
  const art = briefArt(mission.id);
  return (
    <section className="relative h-dvh min-h-0 flex flex-col overflow-hidden bg-surface">
      {art && (
        <>
          <img src={art} alt="" className="absolute inset-0 h-full w-full object-cover" />
          <div className="absolute inset-0 bg-gradient-to-t from-bg/90 via-bg/45 to-transparent" />
        </>
      )}
      <header className="relative z-10 flex items-center gap-3 px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-4 sm:px-6">
        <button type="button" onClick={onBack} className="size-10 grid place-items-center rounded-md border border-border bg-surface/90" aria-label="Voltar">
          <ChevronLeft className="size-5" />
        </button>
        <div>
          <p className="text-sm uppercase tracking-[0.18em] text-muted">{mission.place}</p>
          <h1 className="font-display text-3xl leading-none">{mission.title}</h1>
        </div>
      </header>
      <div className="relative z-10 flex-1 min-h-0 overflow-y-auto px-4 pb-4 sm:px-6">
        <div className="max-w-xl rounded-xl border border-border bg-surface/90 p-5 shadow-lg shadow-bg/30">
          <p className="text-lg leading-relaxed text-fg">{mission.briefing}</p>
          <div className="mt-5 border-t border-border pt-4">
            <p className="text-xs uppercase tracking-[0.16em] text-muted">Objetivo</p>
            <p className="mt-1 text-base font-medium text-accent">{mission.objective}</p>
          </div>
        </div>
      </div>
      <div className="relative z-10 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-6">
        <Button size="xl" className="w-full max-w-xl" onClick={onStart}>
          <Swords className="size-5" /> {mission.id === "estalagem" ? "Entrar" : "Entrar em combate"}
        </Button>
      </div>
    </section>
  );
}

function BattleScreen({
  engine,
  hud,
  paused,
  muted,
  save,
  onHud,
  onPause,
  onResume,
  onMute,
  onSave,
  onLoad,
  onQuit,
  onEquipWeapon,
  onEquipItem,
  playtest = false,
}: {
  engine: BattleEngine;
  hud: HudSnapshot;
  paused: boolean;
  muted: boolean;
  save: SaveData;
  onHud: (h: HudSnapshot) => void;
  onPause: () => void;
  onResume: () => void;
  onMute: () => void;
  onSave: () => void;
  onLoad: () => void;
  onQuit: () => void;
  /** Persist a mid-battle gear change. `alsoOwn` is true when the item came out of a chest
   * this battle and therefore is not in the save's owned lists yet. */
  onEquipWeapon?: (hero: string, weaponId: string, alsoOwn: boolean) => void;
  onEquipItem?: (hero: string, slot: EquipSlot, itemId: string, alsoOwn: boolean) => void;
  /** True while running a map from the editor, which exits back to it rather than quitting. */
  playtest?: boolean;
}) {
  const [showStatus, setShowStatus] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const logRef = useRef<HTMLDivElement | null>(null);
  const [invView, setInvView] = useState<"doll" | "pack" | null>(null);
  // Rest the pointer on a tile (or, on touch, hold a press) to read what its terrain does
  // — the same numbers the map editor shows on hover, which the player had no way to see
  // during a fight.
  const [heldTile, setHeldTile] = useState(false);
  const [hotbars, setHotbars] = useState<Record<string, (SlotAction | null)[]>>({});
  const [editingSlots, setEditingSlots] = useState(false);
  const [pickerSlot, setPickerSlot] = useState<number | null>(null);
  // Dismissing the "encerrar missão?" popup only hides THAT popup — the "Encerrar missão"
  // button in the footer stays available the whole time the field is clear (see hud.winAvailable),
  // so dismissing never strands the player without a way to finish when they're ready.
  // Resets whenever the field freshly clears again (a trap/trigger spawn dealt with),
  // rather than staying dismissed for the rest of the battle.
  const [winPopupDismissed, setWinPopupDismissed] = useState(false);
  const wasWinAvailable = useRef(false);
  useEffect(() => {
    if (hud.winAvailable && !wasWinAvailable.current) setWinPopupDismissed(false);
    wasWinAvailable.current = hud.winAvailable;
  }, [hud.winAvailable]);
  useEffect(() => {
    setHotbars(loadHotbars());
  }, []);
  useEffect(() => {
    if (showLog && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [showLog, hud.log.length]);
  // Loot found (a chest opened, a kill dropped gear) jumps the footer straight to the log so
  // it isn't missed; it reverts to the stat sheet on its own once a different unit takes its
  // turn, same as if the player had never touched the toggle.
  const prevLogLenRef = useRef(hud.log.length);
  useEffect(() => {
    if (hud.log.length > prevLogLenRef.current) {
      const added = hud.log.slice(prevLogLenRef.current);
      if (added.some((line) => line.startsWith("Loot:") || line.includes("achou"))) setShowLog(true);
    }
    prevLogLenRef.current = hud.log.length;
  }, [hud.log.length]);
  const activeUnitId = hud.turnQueue.find((t) => t.active)?.id ?? null;
  const prevActiveIdRef = useRef(activeUnitId);
  useEffect(() => {
    if (activeUnitId !== prevActiveIdRef.current) {
      prevActiveIdRef.current = activeUnitId;
      setShowLog(false);
    }
  }, [activeUnitId]);
  const unit: UnitPublic | null = hud.selected ?? hud.pendingFoe ?? hud.inspected;
  // The Mochila/Equipamento screens read straight off `save`, which is only the roster
  // snapshot from before this mission started — a chest opened mid-battle mutates the live
  // BattleEngine unit (and engine.lootEmber/lootWeapons/lootEquipment), not `save`, so those
  // finds never showed up until the mission ended. Patch a live view in for the duration of
  // the battle instead of touching the screens themselves, which are also used from the Inn
  // (no `engine` there, where `save` genuinely is the whole truth).
  const liveWeapons = { ...save.weapons };
  for (const id of engine.lootWeapons) if (!(id in liveWeapons)) liveWeapons[id] = 0;
  const liveLooseEquipment = { ...save.looseEquipment };
  for (const id of engine.lootEquipment) liveLooseEquipment[id] = (liveLooseEquipment[id] ?? 0) + 1;
  const liveSave: SaveData = {
    ...save,
    ember: save.ember + engine.lootEmber,
    bags: { ...save.bags, ...Object.fromEntries(engine.units.filter((u) => u.side === "player").map((u) => [u.name, u.bag])) },
    weapons: liveWeapons,
    looseEquipment: liveLooseEquipment,
  };
  const foe = hud.pendingFoe ?? (hud.inspected && hud.inspected.side === "enemy" && hud.selected ? hud.inspected : null);
  const showAct = hud.mode === "awaitAction" || hud.mode === "awaitAttack" || hud.mode === "selected" || hud.mode === "awaitSpell";
  const actor = hud.selected?.side === "player" ? hud.selected : null;
  const slots = actor ? (hotbars[actor.name] ?? defaultSlots(actor.classId)) : [];

  function setSlot(index: number, action: SlotAction | null) {
    if (!actor) return;
    const next = { ...hotbars, [actor.name]: slots.map((s, i) => (i === index ? action : s)) };
    setHotbars(next);
    saveHotbars(next);
  }

  function runSlot(action: SlotAction) {
    if (action.kind === "potion") {
      engine.usePotion(action.potion);
      return;
    }
    switch (action.spell) {
      case "doubleStrike":
        engine.startDoubleStrike();
        break;
      case "cleave":
        engine.startCleave();
        break;
      case "fireball":
        engine.startFireball();
        break;
      case "causticVenom":
        engine.startCausticVenom();
        break;
      case "lightning":
        engine.startLightning();
        break;
      case "magicMissile":
        engine.startMagicMissile();
        break;
      case "longShot":
        engine.startLongShot();
        break;
      case "piercing":
        engine.startPiercing();
        break;
      case "cureMinor":
        engine.startCure("cureMinor");
        break;
      case "cureWounds":
        engine.startCure("cureWounds");
        break;
      case "cureDisease":
        engine.startCureDisease();
        break;
      case "piercingThrust":
        engine.startPiercingThrust();
        break;
      case "sweep":
        engine.startSweep();
        break;
      case "trip":
        engine.startTrip();
        break;
      case "summonFamiliar":
        engine.startSummonFamiliar();
        break;
      case "webOfDreams":
        engine.startWebOfDreams();
        break;
      case "multiShot":
        engine.startMultiShot();
        break;
      case "cureLight":
        engine.startCure("cureLight");
        break;
      case "auraOfProtection":
        engine.startAuraOfProtection();
        break;
      case "divineWrath":
        engine.startDivineWrath();
        break;
      case "shoulderSmash":
        engine.startShoulderSmash();
        break;
      case "intimidatingPresence":
        engine.startIntimidatingPresence();
        break;
      case "stampede":
        engine.startStampede();
        break;
      case "secondWind":
        // Passive — never reaches the hotbar (see PRESTIGE_SPELLS); nothing to run.
        break;
    }
  }

  function slotDisabled(action: SlotAction): boolean {
    if (!actor || hud.busy) return true;
    const count = slotCount(action, actor);
    if (count <= 0) return true;
    // Potions are free item uses: available before or after the unit's action.
    if (action.kind === "potion") return false;
    if (!showAct || actor.acted) return true;
    return false;
  }

  function slotActive(action: SlotAction): boolean {
    if (action.kind === "potion") return hud.mode === "awaitPotion";
    return hud.mode === "awaitSpell" && hud.spellKind === action.spell;
  }

  function activateSlot(i: number) {
    if (!actor || i < 0 || i >= slots.length) return;
    const action = slots[i];
    if (editingSlots) {
      setPickerSlot(i);
      return;
    }
    if (!action || slotDisabled(action)) return;
    runSlot(action);
  }
  const activateSlotRef = useRef(activateSlot);
  activateSlotRef.current = activateSlot;
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const m = /^F([1-9]|1[0-2])$/.exec(e.key);
      if (!m) return;
      e.preventDefault();
      activateSlotRef.current(Number(m[1]) - 1);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <section className="relative h-dvh min-h-0 flex flex-col bg-bg">
      <div className="relative flex-1 min-h-0">
        <BattleCanvas engine={engine} onHud={onHud} paused={paused} onTileReadout={setHeldTile} />
        {hud.turnQueue.length > 1 && (
          <div className="pointer-events-none absolute inset-x-2 top-[max(0.5rem,env(safe-area-inset-top))] flex items-center gap-1 flex-wrap">
            <p className="bg-surface/90 border border-border rounded-md px-2 py-0.5 text-[15px] leading-tight flex items-center gap-1.5 flex-wrap">
              {hud.turnQueue.map((q, i) => (
                <span key={q.id} className="flex items-center gap-2">
                  {i > 0 && <span className="text-muted">→</span>}
                  <span
                    className={
                      q.active
                        ? "text-accent font-medium"
                        : q.acted
                          ? "text-muted line-through"
                          : q.side === "enemy"
                            ? "text-danger"
                            : "text-fg"
                    }
                  >
                    {q.name}
                  </span>
                </span>
              ))}
            </p>
          </div>
        )}
        {heldTile && hud.terrain && (
          <div className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center px-3">
            <div className="bg-surface/95 border border-border rounded-lg px-3 py-2 max-w-sm shadow-lg">
              <p className="font-display text-base leading-tight">{hud.terrain.name}</p>
              <p className="text-xs text-muted tabular-nums mt-0.5">
                {hud.terrain.passable ? `Mov ${hud.terrain.moveCost}` : "Intransponível"} · Def +{hud.terrain.def} · Atk +{hud.terrain.atk}
                {hud.terrain.blocksShot ? " · bloqueia tiro/visão" : ""}
                {hud.terrain.hazard ? ` · dano ${hud.terrain.hazard} ao entrar e a cada turno` : ""}
              </p>
              {hud.terrain.note && <p className="text-xs text-accent mt-1">{hud.terrain.note}</p>}
            </div>
          </div>
        )}
        <div className="pointer-events-none absolute inset-x-2 top-[max(0.5rem,env(safe-area-inset-top))] flex items-start justify-end gap-1">
          <p className="bg-surface/90 border border-border rounded-md px-1.5 py-0.5 text-[10px] tabular-nums text-muted pointer-events-none">
            T{hud.turn} · {hud.playerAlive}/{hud.enemyAlive}
          </p>
          {hud.terrain && (hud.terrain.note || hud.terrain.id === "barricade" || hud.terrain.id === "hill" || hud.terrain.id === "highwood" || hud.terrain.id === "highruin") && (
            <p className="bg-surface/90 border border-border rounded-md px-1.5 py-0.5 text-[10px] text-accent pointer-events-none max-w-[14rem] truncate">
              {hud.terrain.name}
            </p>
          )}
          <div className="flex items-center gap-1 pointer-events-auto shrink-0">
            <button
              type="button"
              onClick={onMute}
              className="size-7 grid place-items-center rounded-md border border-border bg-surface/90"
              aria-label="Som"
            >
              {muted ? <VolumeX className="size-3.5" /> : <Volume2 className="size-3.5" />}
            </button>
            <button
              type="button"
              onClick={onPause}
              className="h-7 px-2 rounded-md border border-border bg-surface/90 text-[10px] tracking-[0.14em] uppercase"
            >
              Opções
            </button>
          </div>
        </div>
        {hud.banner && (
          <div className="pointer-events-none absolute inset-x-0 top-14 flex justify-center">
            <div className="bg-surface/95 border border-border rounded-md px-4 py-1.5 font-display text-lg tracking-wide">
              {hud.banner}
            </div>
          </div>
        )}
        {hud.targetPrompt && !hud.result && (
          <div className="pointer-events-none absolute inset-x-0 top-14 flex justify-center px-3">
            <div className="bg-surface border-2 border-accent rounded-lg px-4 py-2.5 text-center shadow-lg">
              <p className="font-display text-lg tracking-wide leading-tight">
                Escolha {hud.targetPrompt.need} alvo{hud.targetPrompt.need > 1 ? "s" : ""}
              </p>
              <p className="text-sm text-muted mt-0.5">
                {hud.targetPrompt.picked} de {hud.targetPrompt.need} escolhido{hud.targetPrompt.picked === 1 ? "" : "s"}
                {" · "}
                {hud.targetPrompt.need - hud.targetPrompt.picked === 1
                  ? "falta 1"
                  : `faltam ${hud.targetPrompt.need - hud.targetPrompt.picked}`}
                {" · pode repetir o mesmo alvo"}
              </p>
            </div>
          </div>
        )}
        {hud.tip && !(hud.winAvailable && !winPopupDismissed) && (
          <div className="pointer-events-none absolute inset-x-2 bottom-2">
            <p className="bg-surface/90 border border-border rounded-md px-2 py-1 text-xs text-muted text-center">{hud.tip}</p>
          </div>
        )}
        {hud.winAvailable && !hud.result && !winPopupDismissed && (
          <div className="pointer-events-none absolute inset-x-2 bottom-2 flex justify-center">
            <div className="pointer-events-auto bg-surface/95 border border-accent rounded-md px-3 py-2 flex items-center gap-3 flex-wrap justify-center">
              <p className="text-sm">Todos os inimigos caíram. Encerrar a missão?</p>
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={() => engine.confirmFinish()}>
                  Encerrar missão
                </Button>
                <Button size="sm" variant="quiet" onClick={() => setWinPopupDismissed(true)}>
                  Continuar explorando
                </Button>
              </div>
            </div>
          </div>
        )}
        {hud.chestLoot && (
          <div className="absolute inset-0 z-50 bg-bg/85 flex items-center justify-center p-4">
            <div className="w-full max-w-sm bg-surface border border-accent rounded-xl p-5">
              <p className="text-xs uppercase tracking-[0.18em] text-muted">Baú aberto</p>
              <h2 className="font-display text-2xl leading-none mt-1 mb-3">{hud.chestLoot.unitName} encontrou</h2>
              <ul className="flex flex-col gap-1.5 mb-4">
                <li className="text-sm flex items-center gap-1.5">
                  <span className="text-accent font-bold tabular-nums">+{hud.chestLoot.ember}</span>
                  <span>Ember</span>
                </li>
                {hud.chestLoot.items.map((item, i) => (
                  <li key={i} className="text-sm flex items-center gap-2">
                    <img src={item.icon} alt="" className="size-8 rounded-sm object-cover bg-bg shrink-0" />
                    <span>{item.name}</span>
                  </li>
                ))}
                {hud.chestLoot.items.length === 0 && <li className="text-sm text-muted">Nada além do Ember.</li>}
              </ul>
              <Button className="w-full" onClick={() => engine.acknowledgeChestLoot()}>
                Ok
              </Button>
            </div>
          </div>
        )}
      </div>

      <footer className="shrink-0 border-t border-border bg-surface px-2 pt-1.5 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <div className="min-h-16 sm:min-h-[4.5rem] flex items-center gap-2">
          {unit ? (
            <>
              <button
                type="button"
                onClick={() => setShowStatus(true)}
                className="shrink-0 rounded-md ring-offset-2 ring-offset-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent active:opacity-80"
                title="Ver status"
              >
                <img
                  src={HERO_PORTRAIT[unit.sprite] ?? `/game/sprites/${unit.sprite}/1.png`}
                  alt=""
                  className={
                    HERO_PORTRAIT[unit.sprite]
                      ? "h-16 w-12 sm:h-20 sm:w-14 object-cover rounded-md"
                      : "h-14 w-14 object-contain"
                  }
                />
              </button>
              <button
                type="button"
                onClick={() => setShowLog((v) => !v)}
                className="min-w-0 flex-1 text-left rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                title={showLog ? "Ver status" : "Ver log de combate"}
              >
                {showLog ? (
                  <div ref={logRef} className="h-16 sm:h-20 overflow-y-auto pr-1">
                    {hud.log.length === 0 ? (
                      <p className="text-[12.5px] text-muted">Nada aconteceu ainda.</p>
                    ) : (
                      hud.log.map((line, i) => (
                        <p key={i} className="text-[12.5px] text-muted leading-snug">
                          {line}
                        </p>
                      ))
                    )}
                  </div>
                ) : (
                  <>
                    <div className="flex items-baseline justify-between gap-2">
                      <p className="text-sm font-medium truncate">
                        {unit.name} · Nv {unit.level}
                        {unit.side === "player" && (
                          <span className="text-xs text-muted font-normal ml-1 align-middle tabular-nums">
                            {unit.level >= MAX_LEVEL ? "· NÍVEL MÁX." : `· ${unit.xp}/${EXP_TO_LEVEL} XP`}
                          </span>
                        )}
                      </p>
                      <p className={`text-xs ${unit.side === "enemy" ? "text-danger" : "text-muted"}`}>
                        {unit.className}
                        {unit.diseased && <span className="text-danger"> · Doente</span>}
                        {unit.poisoned && <span className="text-danger"> · Envenenado</span>}
                      </p>
                    </div>
                    <div className="mt-0.5 flex items-center gap-2">
                      <div className="h-1.5 flex-1 rounded-full bg-border overflow-hidden">
                        <div
                          className={`hp-fill h-full ${unit.side === "enemy" ? "bg-danger" : "bg-accent"}`}
                          style={{ width: `${Math.max(0, (unit.hp / unit.maxHp) * 100)}%` }}
                        />
                      </div>
                      <p className="text-xs tabular-nums text-fg shrink-0">
                        {unit.hp}/{unit.maxHp}
                      </p>
                    </div>
                    <p className="text-[11px] tabular-nums text-muted leading-snug">
                      {hud.forecast && foe
                        ? `${hud.forecast.dmgOut} em ${foe.name}${hud.forecast.canCounter ? ` · contra ${hud.forecast.dmgBack}` : " · sem contra"}${hud.forecast.kill ? " · abate" : ""}`
                        : sheetLine(unit)}
                    </p>
                  </>
                )}
              </button>
            </>
          ) : (
            <p className="text-xs text-muted">{hud.phase === "enemy" ? "O inimigo age…" : "Toque numa aliada ou num inimigo."}</p>
          )}
        </div>
        <div className="flex flex-wrap gap-1 min-h-10 items-center mt-1">
          {hud.offHandKind && (
            <Button
              size="sm"
              variant="quiet"
              disabled={!showAct || hud.busy || hud.mode === "awaitSpell"}
              onClick={() => engine.startOffHand()}
              title={
                hud.offHandKind === "shield"
                  ? `${Math.round((EQUIPMENT[unit?.offHandId ?? ""]?.dmgMul ?? 0.75) * 100)}% do dano normal · 70% de chance de atordoar por 1 turno`
                  : "Ataca com a arma da mão secundária"
              }
            >
              {hud.offHandKind === "shield" ? "Investida de Escudo" : "Mão Secundária"}
            </Button>
          )}
          <Button size="sm" disabled={!showAct || !hud.canAttack || hud.busy || hud.mode === "awaitSpell"} onClick={() => engine.startAttack()}>
            Atacar
          </Button>
          {hud.mode === "awaitSpell" && (
            <Button size="sm" disabled={!hud.spellReady || hud.busy} onClick={() => engine.confirmSpell()}>
              Lançar
            </Button>
          )}
          {hud.canLockpick && (
            <button
              type="button"
              disabled={!showAct || hud.busy}
              onClick={() => engine.useLockpick()}
              title="Custa 1 Gazua para abrir."
              className="relative h-9 px-2 rounded-md border border-border bg-bg flex items-center gap-1 disabled:opacity-40"
            >
              <img src="/game/icons/lockpick.png" alt="" className="size-5 rounded-sm object-contain" />
              <span className="text-sm tabular-nums">×{actor?.bag.lockpick ?? 0}</span>
            </button>
          )}
          <Button size="sm" variant="quiet" disabled={!showAct || hud.busy} onClick={() => engine.wait()}>
            Esperar
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={(!showAct && hud.mode !== "awaitPotion") || hud.busy}
            onClick={() => engine.cancel()}
          >
            Cancelar
          </Button>
          {actor && (
            <div className="flex items-center gap-1">
              {slots.map((action, i) => {
                const empty = !action;
                const disabled = action ? slotDisabled(action) : !editingSlots;
                return (
                  <button
                    key={i}
                    type="button"
                    disabled={!editingSlots && disabled}
                    onClick={() => activateSlot(i)}
                    title={`F${i + 1} · ${action ? slotTooltip(action) : "Slot vazio"}`}
                    className={`relative size-9 grid place-items-center rounded-md border ${
                      action && slotActive(action) ? "border-accent bg-accent/20" : "border-border bg-bg"
                    } ${editingSlots ? "outline outline-1 outline-dashed outline-muted" : ""} disabled:opacity-40`}
                  >
                    <span className="absolute -top-1 -left-1 bg-surface border border-border rounded px-0.5 text-[8px] tabular-nums leading-tight text-muted">
                      F{i + 1}
                    </span>
                    {empty ? (
                      <span className="text-muted text-xs">+</span>
                    ) : (
                      <>
                        <img src={slotIcon(action)} alt="" className="size-6 rounded-sm object-cover" />
                        <span className="absolute -bottom-1 -right-1 bg-surface border border-border rounded px-0.5 text-[9px] tabular-nums leading-tight">
                          {slotCount(action, actor)}
                        </span>
                      </>
                    )}
                  </button>
                );
              })}
              <button
                type="button"
                onClick={() => setEditingSlots((v) => !v)}
                title="Configurar slots"
                className={`size-9 grid place-items-center rounded-md border ${editingSlots ? "border-accent bg-accent/20" : "border-border bg-bg"}`}
              >
                <Pencil className="size-4" />
              </button>
            </div>
          )}
          {hud.winAvailable && !hud.result && (
            <Button size="sm" className="ml-auto" onClick={() => engine.confirmFinish()}>
              Encerrar missão
            </Button>
          )}
          {hud.canUndoMove && !hud.result && (
            <Button size="sm" variant="ghost" title="Volta ao ponto onde o turno começou e devolve todo o movimento gasto. Some assim que você age." onClick={() => engine.undoMove()}>
              Desfazer movimento
            </Button>
          )}
          <Button size="sm" variant="ghost" className={hud.winAvailable && !hud.result ? "" : "ml-auto"} disabled={hud.phase !== "player" || !!hud.result} onClick={() => engine.endTurn()}>
            Fim do turno
          </Button>
        </div>
      </footer>

      {paused && (
        <div className="absolute inset-0 z-30 bg-bg/80 flex items-center justify-center p-4">
          <div className="w-full max-w-sm bg-surface border border-border rounded-xl p-6">
            <h2 className="font-display text-2xl mb-4">Opções</h2>
            <p className="text-xs uppercase tracking-[0.18em] text-muted mb-2">Zoom</p>
            <div className="grid grid-cols-4 gap-1 mb-4">
              {(["Distante", "Longe", "Médio", "Perto"] as const).map((label, i) => (
                <Button key={label} size="sm" variant={hud.zoom === i ? undefined : "quiet"} onClick={() => engine.setZoom(i)}>
                  {label}
                </Button>
              ))}
            </div>
            <p className="text-xs uppercase tracking-[0.18em] text-muted mb-2">Velocidade</p>
            <div className="grid grid-cols-2 gap-1 mb-4">
              {(["normal", "fast"] as const).map((mode) => (
                <Button
                  key={mode}
                  size="sm"
                  variant={hud.speedMode === mode ? undefined : "quiet"}
                  onClick={() => engine.setSpeed(mode)}
                >
                  {mode === "normal" ? "Normal" : "Rápida"}
                </Button>
              ))}
            </div>
            <div className="flex flex-col gap-2">
              <Button onClick={onResume}>Continuar</Button>
              <Button variant="quiet" onClick={onSave}>
                Save
              </Button>
              <Button variant="quiet" onClick={onLoad}>
                Load
              </Button>
              <Button variant="ghost" onClick={onQuit}>
                {playtest ? "Encerrar teste" : "Desistir"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {showStatus && unit && (
        <StatusPanel
          unit={unit}
          bagIcon={pouchIcon(equippedPouchId(liveSave.equipment, unit.name))}
          onClose={() => setShowStatus(false)}
          onOpenInventory={
            unit.side === "player"
              ? () => {
                  setShowStatus(false);
                  setInvView("pack");
                }
              : undefined
          }
          onOpenEquipment={
            unit.side === "player"
              ? () => {
                  setShowStatus(false);
                  setInvView("doll");
                }
              : undefined
          }
        />
      )}

      {invView && unit && unit.side === "player" && (
        <PartyInventoryOverlay
          heroName={unit.name}
          classId={unit.classId}
          save={liveSave}
          onClose={() => setInvView(null)}
          // Gear changes mid-battle cost nothing — not the action, not the movement, and
          // they can repeat until the turn is passed. Each one writes through to the save
          // as well as the live unit, so a swap made in a fight is permanent whether the
          // battle is won, lost or retried.
          onEquipWeapon={(hero, weaponId) => {
            const owned = save.weapons[weaponId] != null;
            const found = engine.lootWeapons.includes(weaponId);
            if (!owned && !found) return;
            if (!engine.equipWeaponOn(unit.id, weaponId, save.weapons[weaponId] ?? 0)) return;
            if (!owned) engine.claimLoot("weapon", weaponId);
            onEquipWeapon?.(hero, weaponId, !owned);
          }}
          onEquipItem={(hero, slot, itemId) => {
            const owned = (save.looseEquipment[itemId] ?? 0) > 0 || Object.values(save.equipment).some((slots) => Object.values(slots).includes(itemId));
            const found = engine.lootEquipment.includes(itemId);
            if (!owned && !found) return;
            if (!engine.equipItemOn(unit.id, slot, itemId)) return;
            if (!owned) engine.claimLoot("equipment", itemId);
            onEquipItem?.(hero, slot, itemId, !owned);
          }}
        />
      )}

      {pickerSlot != null && actor && (
        <SlotPicker
          classId={actor.classId}
          onPick={(action) => {
            setSlot(pickerSlot, action);
            setPickerSlot(null);
          }}
          onClose={() => setPickerSlot(null)}
        />
      )}
    </section>
  );
}

function SlotPicker({
  classId,
  onPick,
  onClose,
}: {
  classId: ClassId;
  onPick: (action: SlotAction | null) => void;
  onClose: () => void;
}) {
  const options: SlotAction[] = [
    ...classSpells(classId).map((spell): SlotAction => ({ kind: "spell", spell })),
    ...ALL_POTIONS.map((potion): SlotAction => ({ kind: "potion", potion })),
  ];
  return (
    <div
      className="absolute inset-0 z-50 bg-bg/85 flex items-end sm:items-center justify-center p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-sm bg-surface border border-border rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <p className="font-display text-lg">Escolher pra esse slot</p>
          <button type="button" onClick={onClose} className="size-8 grid place-items-center rounded-md border border-border" aria-label="Fechar">
            <X className="size-4" />
          </button>
        </div>
        <div className="grid grid-cols-1 gap-1.5 max-h-[60dvh] overflow-y-auto">
          {options.map((action) => (
            <button
              key={action.kind === "potion" ? `p-${action.potion}` : `s-${action.spell}`}
              type="button"
              onClick={() => onPick(action)}
              className="flex items-center gap-2 bg-bg border border-border rounded-md px-2 py-2 text-left"
            >
              <img src={slotIcon(action)} alt="" className="size-6 rounded-sm object-cover shrink-0" />
              <span className="text-sm">{slotLabel(action)}</span>
            </button>
          ))}
          <button
            type="button"
            onClick={() => onPick(null)}
            className="flex items-center gap-2 bg-bg border border-border rounded-md px-2 py-2 text-left text-muted"
          >
            <span className="size-6 grid place-items-center shrink-0">—</span>
            <span className="text-sm">Deixar vazio</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function StatusPanel({ unit, bagIcon, onClose, onOpenInventory, onOpenEquipment }: { unit: UnitPublic; bagIcon?: string; onClose: () => void; onOpenInventory?: () => void; onOpenEquipment?: () => void }) {
  const stats: Array<[string, string | number]> = [
    ["ATK", unit.atk],
    ["MAG", unit.mag],
    ["DEF", unit.def],
    ["RES", unit.res],
    ["MOV", unit.movLeft < unit.mov ? `${unit.movLeft}/${unit.mov}` : unit.mov],
    ["Alcance", rangeLabel(unit.minRange, unit.maxRange)],
  ];
  const base = PROMOTED_BASE[unit.classId] ?? unit.classId;
  const mage = base === "mage";
  const conjurer = base === "conjurer";
  const healer = base === "healer";
  const archer = base === "archer";
  const swordsman = base === "swordsman";
  const lancer = base === "lancer";

  return (
    <div
      className="absolute inset-0 z-40 bg-bg/85 flex items-center justify-center p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md max-h-[88dvh] overflow-y-auto bg-surface border border-border rounded-xl p-5">
        <div className="flex items-start justify-between gap-3 mb-4">
          <div className="flex items-center gap-3 min-w-0">
            <img
              src={HERO_PORTRAIT[unit.sprite] ?? `/game/sprites/${unit.sprite}/1.png`}
              alt=""
              className={
                HERO_PORTRAIT[unit.sprite]
                  ? "h-24 w-20 object-cover rounded-lg border border-border shrink-0"
                  : "h-20 w-20 object-contain shrink-0"
              }
            />
            <div className="min-w-0">
              <p className="font-display text-xl leading-tight truncate">{unit.name}</p>
              <p className={`text-xs ${unit.side === "enemy" ? "text-danger" : "text-muted"}`}>
                {unit.className} · Nv {unit.level}
              </p>
              {unit.diseased && <p className="text-xs text-danger mt-0.5">Doente · −10% em todos os stats</p>}
              {unit.poisoned && <p className="text-xs text-danger mt-0.5">Envenenado · 1D4 dano por turno</p>}
              {unit.side === "player" && (
                <div className="mt-1.5 max-w-[9rem]">
                  {unit.level >= MAX_LEVEL ? (
                    <p className="text-[11px] text-muted tabular-nums">Nível máximo</p>
                  ) : (
                    <>
                      <div className="h-1.5 rounded-full bg-border overflow-hidden">
                        <div className="h-full bg-accent" style={{ width: `${(unit.xp / EXP_TO_LEVEL) * 100}%` }} />
                      </div>
                      <p className="text-[11px] text-muted tabular-nums mt-0.5">
                        {unit.xp}/{EXP_TO_LEVEL} XP
                      </p>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
          <div className="flex items-start gap-2 shrink-0">
            <div className="flex flex-col gap-2">
              {onOpenInventory && (
                <button type="button" onClick={onOpenInventory} className="h-12 px-3 rounded-md border border-border text-sm flex items-center gap-2">
                  <img src={bagIcon ?? BAG_ICON} alt="" className="size-8 shrink-0 rounded-sm object-contain" />
                  Mochila
                </button>
              )}
              {onOpenEquipment && (
                <button type="button" onClick={onOpenEquipment} className="h-12 px-3 rounded-md border border-border text-sm flex items-center gap-2">
                  <Shield className="size-5 shrink-0" />
                  Equipar
                </button>
              )}
            </div>
            <button type="button" onClick={onClose} className="size-8 grid place-items-center rounded-md border border-border" aria-label="Fechar">
              <X className="size-4" />
            </button>
          </div>
        </div>

        <div className="mb-4">
          <div className="flex items-center gap-2">
            <div className="h-2 flex-1 rounded-full bg-border overflow-hidden">
              <div
                className={`h-full ${unit.side === "enemy" ? "bg-danger" : "bg-accent"}`}
                style={{ width: `${Math.max(0, (unit.hp / unit.maxHp) * 100)}%` }}
              />
            </div>
            <p className="text-xs tabular-nums text-fg shrink-0">
              {unit.hp}/{unit.maxHp}
            </p>
          </div>
        </div>

        <p className="text-xs uppercase tracking-[0.18em] text-muted mb-2">Ficha</p>
        <div className="grid grid-cols-3 gap-2 mb-5">
          {stats.map(([label, value]) => (
            <div key={label} className="bg-bg border border-border rounded-md px-2 py-1.5 text-center">
              <p className="text-[10px] uppercase tracking-wide text-muted">{label}</p>
              <p className="text-sm font-medium tabular-nums">{value}</p>
            </div>
          ))}
        </div>

        {unit.side === "player" && (swordsman || mage || conjurer || archer || healer || lancer) && (
          <>
            <p className="text-xs uppercase tracking-[0.18em] text-muted mb-2">Magias e habilidades</p>
            <div className="grid grid-cols-1 gap-1.5">
                  {swordsman && (
                    <>
                      <div className="flex items-center gap-1.5 bg-bg border border-border rounded-md px-2 py-1.5">
                        <img src="/game/icons/cleave.png?v=ds2" alt="" className="size-5 rounded-sm object-cover shrink-0" />
                        <p className="text-xs truncate">
                          {DOUBLE_STRIKE.name} {doubleStrikeFormula(unit.level)}{" "}
                          <span className="tabular-nums text-muted">×{unit.spells[tierKey(spellTier("doubleStrike")!)]}</span>
                        </p>
                      </div>
                      <div className="flex items-center gap-1.5 bg-bg border border-border rounded-md px-2 py-1.5">
                        <img src="/game/icons/cleave-crossed-blades.png?v=ds2" alt="" className="size-5 rounded-sm object-cover shrink-0" />
                        <p className="text-xs truncate">
                          {CLEAVE.name} {CLEAVE.hexes} hex, {cleaveFormula(unit.level)} · x{CLEAVE.largeMul} vs 3+ hex{" "}
                          <span className="tabular-nums text-muted">×{unit.spells[tierKey(spellTier("cleave")!)]}</span>
                        </p>
                      </div>
                    </>
                  )}
                  {mage && (
                    <>
                      <div className="flex items-center gap-1.5 bg-bg border border-border rounded-md px-2 py-1.5">
                        <img src="/game/icons/magic-missile.png?v=ds2" alt="" className="size-5 rounded-sm object-cover shrink-0" />
                        <p className="text-xs truncate">
                          {MAGIC_MISSILE.name} {diceFormula(MAGIC_MISSILE.dice, MAGIC_MISSILE.faces, MAGIC_MISSILE.bonus)}{" "}
                          <span className="tabular-nums text-muted">×{unit.spells[tierKey(spellTier("magicMissile")!)]}</span>
                        </p>
                      </div>
                      {unit.spells[tierKey(spellTier("lightning")!)] > 0 && (
                        <div className="flex items-center gap-1.5 bg-bg border border-border rounded-md px-2 py-1.5">
                          <img src="/game/icons/lightning.png?v=ds2" alt="" className="size-5 rounded-sm object-cover shrink-0" />
                          <p className="text-xs truncate">
                            Raio {lightningFormula(unit.mag)} <span className="tabular-nums text-muted">×{unit.spells[tierKey(spellTier("lightning")!)]}</span>
                          </p>
                        </div>
                      )}
                      {unit.spells[tierKey(spellTier("fireball")!)] > 0 && (
                        <div className="flex items-center gap-1.5 bg-bg border border-border rounded-md px-2 py-1.5">
                          <img src="/game/icons/fireball.png?v=ds2" alt="" className="size-5 rounded-sm object-cover shrink-0" />
                          <p className="text-xs truncate">
                            Fogo {fireballFormula(unit.mag)} <span className="tabular-nums text-muted">×{unit.spells[tierKey(spellTier("fireball")!)]}</span>
                          </p>
                        </div>
                      )}
                      {unit.spells[tierKey(spellTier("causticVenom")!)] > 0 && (
                        <div className="flex items-center gap-1.5 bg-bg border border-border rounded-md px-2 py-1.5">
                          <img src="/game/icons/caustic-venom.png?v=ds2" alt="" className="size-5 rounded-sm object-cover shrink-0" />
                          <p className="text-xs truncate">
                            {CAUSTIC_VENOM.name} {diceFormula(CAUSTIC_VENOM.centerDice, CAUSTIC_VENOM.centerFaces, CAUSTIC_VENOM.centerBonus)}{" "}
                            <span className="tabular-nums text-muted">×{unit.spells[tierKey(spellTier("causticVenom")!)]}</span>
                          </p>
                        </div>
                      )}
                    </>
                  )}
                  {conjurer && (
                    <>
                      <div className="flex items-center gap-1.5 bg-bg border border-border rounded-md px-2 py-1.5">
                        <img src="/game/icons/summon-familiar.png?v=ds2" alt="" className="size-5 rounded-sm object-cover shrink-0" />
                        <p className="text-xs truncate">
                          {SUMMON_FAMILIAR.name} <span className="tabular-nums text-muted">×{unit.spells[tierKey(spellTier("summonFamiliar")!)]}</span>
                        </p>
                      </div>
                      <div className="flex items-center gap-1.5 bg-bg border border-border rounded-md px-2 py-1.5">
                        <img src="/game/icons/web-of-dreams.png?v=ds2" alt="" className="size-5 rounded-sm object-cover shrink-0" />
                        <p className="text-xs truncate">
                          {WEB_OF_DREAMS.name} <span className="tabular-nums text-muted">×{unit.spells[tierKey(spellTier("webOfDreams")!)]}</span>
                        </p>
                      </div>
                    </>
                  )}
                  {archer && (
                    <>
                      <div className="flex items-center gap-1.5 bg-bg border border-border rounded-md px-2 py-1.5">
                        <img src="/game/icons/long-shot.png?v=ds2" alt="" className="size-5 rounded-sm object-cover shrink-0" />
                        <p className="text-xs truncate">
                          Longo <span className="tabular-nums text-muted">×{unit.spells[tierKey(spellTier("longShot")!)]}</span>
                        </p>
                      </div>
                      <div className="flex items-center gap-1.5 bg-bg border border-border rounded-md px-2 py-1.5">
                        <img src="/game/icons/piercing.png?v=ds2" alt="" className="size-5 rounded-sm object-cover shrink-0" />
                        <p className="text-xs truncate">
                          Perfura <span className="tabular-nums text-muted">×{unit.spells[tierKey(spellTier("piercing")!)]}</span>
                        </p>
                      </div>
                    </>
                  )}
                  {healer && (
                    <>
                      <div className="flex items-center gap-1.5 bg-bg border border-border rounded-md px-2 py-1.5">
                        <img src="/game/icons/cure-minor.png?v=ds2" alt="" className="size-5 rounded-sm object-cover shrink-0" />
                        <p className="text-xs truncate">
                          Menor <span className="tabular-nums text-muted">×{unit.spells[tierKey(spellTier("cureMinor")!)]}</span>
                        </p>
                      </div>
                      <div className="flex items-center gap-1.5 bg-bg border border-border rounded-md px-2 py-1.5">
                        <img src="/game/icons/cure-wounds.png?v=ds2" alt="" className="size-5 rounded-sm object-cover shrink-0" />
                        <p className="text-xs truncate">
                          Simples <span className="tabular-nums text-muted">×{unit.spells[tierKey(spellTier("cureWounds")!)]}</span>
                        </p>
                      </div>
                      {unit.spells[tierKey(spellTier("cureDisease")!)] > 0 && (
                        <div className="flex items-center gap-1.5 bg-bg border border-border rounded-md px-2 py-1.5">
                          <img src="/game/icons/cure-disease.png?v=ds2" alt="" className="size-5 rounded-sm object-cover shrink-0" />
                          <p className="text-xs truncate">
                            {CURE_DISEASE.name} <span className="tabular-nums text-muted">×{unit.spells[tierKey(spellTier("cureDisease")!)]}</span>
                          </p>
                        </div>
                      )}
                    </>
                  )}
                  {lancer && (
                    <>
                      <div className="flex items-center gap-1.5 bg-bg border border-border rounded-md px-2 py-1.5">
                        <img src="/game/icons/piercing-thrust.png?v=ds2" alt="" className="size-5 rounded-sm object-cover shrink-0" />
                        <p className="text-xs truncate">
                          {PIERCING_THRUST.name} <span className="tabular-nums text-muted">×{unit.spells[tierKey(spellTier("piercingThrust")!)]}</span>
                        </p>
                      </div>
                      {unit.spells[tierKey(spellTier("sweep")!)] > 0 && (
                        <div className="flex items-center gap-1.5 bg-bg border border-border rounded-md px-2 py-1.5">
                          <img src="/game/icons/sweep.png?v=ds2" alt="" className="size-5 rounded-sm object-cover shrink-0" />
                          <p className="text-xs truncate">
                            {SWEEP.name} <span className="tabular-nums text-muted">×{unit.spells[tierKey(spellTier("sweep")!)]}</span>
                          </p>
                        </div>
                      )}
                      {unit.spells[tierKey(spellTier("trip")!)] > 0 && (
                        <div className="flex items-center gap-1.5 bg-bg border border-border rounded-md px-2 py-1.5">
                          <img src="/game/icons/trip.png?v=ds2" alt="" className="size-5 rounded-sm object-cover shrink-0" />
                          <p className="text-xs truncate">
                            {TRIP.name} <span className="tabular-nums text-muted">×{unit.spells[tierKey(spellTier("trip")!)]}</span>
                          </p>
                        </div>
                      )}
                    </>
                  )}
                </div>
          </>
        )}
      </div>
    </div>
  );
}

/** XP bar on the post-mission screen: mounts at the hero's pre-battle progress, then eases
 * up to the post-battle value on the next paint, so the gain reads as a fill instead of
 * snapping straight to the end state. */
function GrowthXpBar({ from, to }: { from: number; to: number }) {
  const [pct, setPct] = useState(from);
  useEffect(() => {
    const id = requestAnimationFrame(() => setPct(to));
    return () => cancelAnimationFrame(id);
  }, [to]);
  return (
    <span className="h-1.5 w-24 rounded-full bg-border overflow-hidden shrink-0">
      <span className="block h-full bg-accent transition-[width] duration-[1400ms] ease-out" style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
    </span>
  );
}

function ResultScreen({
  win,
  title,
  body,
  turn,
  growth,
  art,
  onTitle,
  onNext,
  onInn,
  onMap,
  mapLabel,
  hasNext,
  innOpen,
  retry,
  loot,
}: {
  win: boolean;
  title: string;
  body: string;
  turn: number;
  growth: GrowthLine[] | null;
  art: string | null;
  onTitle: () => void;
  onNext: () => void;
  onInn?: () => void;
  onMap?: () => void;
  mapLabel?: string;
  hasNext: boolean;
  innOpen?: boolean;
  retry?: boolean;
  loot?: string[];
}) {
  return (
    <section className="relative h-dvh min-h-0 flex flex-col overflow-hidden bg-bg">
      {art && (
        <>
          <img src={art} alt="" className="absolute inset-0 h-full w-full object-cover" />
          <div className="absolute inset-0 bg-gradient-to-t from-bg/90 via-bg/40 to-bg/20" />
        </>
      )}
      <div className="relative z-10 flex-1 min-h-0 overflow-y-auto px-5 pt-[max(2rem,env(safe-area-inset-top))] pb-4">
        <p className="text-sm uppercase tracking-[0.2em] text-muted">
          {win ? "Vitória" : "Derrota"} · T{turn}
        </p>
        <h1 className="font-display text-4xl sm:text-5xl mt-2 mb-2">{title}</h1>
        <p className="text-lg text-muted mb-6">{body}</p>
        {loot && loot.length > 0 && <p className="text-sm text-accent mb-4">Achado no campo: {loot.join(", ")}</p>}
        {growth && growth.length > 0 && (
          <ul className="mb-6 space-y-2 max-w-lg">
            {growth.map((g) => (
              <li key={g.name} className="rounded-md border border-border bg-bg/55 px-3 py-2.5">
                <p className="font-medium text-lg">
                  {g.name}
                  {g.to !== g.from ? ` · Nv ${g.from} → ${g.to}` : ` · Nv ${g.from}`}
                  {g.fallen ? " · caiu" : ""}
                </p>
                {g.to < MAX_LEVEL ? (
                  <p className="flex items-center gap-2 mt-1 text-sm">
                    <GrowthXpBar from={(g.xpFrom / EXP_TO_LEVEL) * 100} to={(g.xp / EXP_TO_LEVEL) * 100} />
                    <span className="text-muted tabular-nums">
                      {g.xp}/{EXP_TO_LEVEL} XP{g.to !== g.from ? " · subiu" : ""}
                    </span>
                  </p>
                ) : (
                  g.to !== g.from && <p className="mt-1 text-sm text-accent">Nível máximo · subiu</p>
                )}
                <p className="text-sm text-muted tabular-nums mt-1">Combate: {g.hpBattle}/{g.maxFrom}</p>
                {g.fallen ? (
                  <p className="text-sm text-muted tabular-nums">Descanso: revive com {g.hpCamp} HP (metade de {g.maxTo})</p>
                ) : (
                  <p className="text-sm tabular-nums text-fg/90">
                    Descanso: {g.restHp > 0 ? `+${g.restHp} HP` : "sem feridas"}
                    <span className="text-muted"> · metade do que faltava</span>
                  </p>
                )}
                {g.to !== g.from && (
                  <p className="text-sm tabular-nums text-accent">
                    Nível: +{g.levelHp} HP máximo ({g.maxFrom} → {g.maxTo})
                    {g.atkTo !== g.atkFrom ? ` · AT ${g.atkFrom} → ${g.atkTo}` : ""}
                    {g.magTo !== g.magFrom ? ` · MAG ${g.magFrom} → ${g.magTo}` : ""}
                    {g.defTo !== g.defFrom ? ` · DF ${g.defFrom} → ${g.defTo}` : ""}
                    {g.resTo !== g.resFrom ? ` · RES ${g.resFrom} → ${g.resTo}` : ""}
                  </p>
                )}
                {g.skillGain ? (
                  <p className="text-sm tabular-nums text-accent">Magias: {g.skillGain} (usos novos deste nível)</p>
                ) : g.to !== g.from ? (
                  <p className="text-sm text-muted">Magias: este nível não adicionou usos — cargas gastas não voltam</p>
                ) : null}
                <p className="text-base tabular-nums mt-1">Acampamento: {g.hpCamp}/{g.maxTo}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="relative z-10 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] flex flex-col gap-2">
        {hasNext && (
          <Button size="xl" className="w-full" onClick={onNext}>
            {retry ? (
              <>
                <RotateCcw className="size-5" /> Tentar de novo
              </>
            ) : (
              "Próxima missão"
            )}
          </Button>
        )}
        {win && innOpen && onInn && (
          <Button variant="quiet" className="w-full inn-open" onClick={onInn}>
            Estalagem do Osso Seco
          </Button>
        )}
        {(win || mapLabel) && onMap && (
          <Button variant="ghost" className="w-full" onClick={onMap}>
            {mapLabel ?? "Cenários"}
          </Button>
        )}
        <Button variant="ghost" className="w-full" onClick={onTitle}>
          Tela inicial
        </Button>
      </div>
    </section>
  );
}

function PromotionScreen({
  pending,
  onPick,
}: {
  pending: { name: string; options: [ClassId, ClassId] }[];
  onPick: (name: string, classId: ClassId) => void;
}) {
  const current = pending[0];
  if (!current) return null;
  return (
    <div className="absolute inset-0 z-50 bg-bg/90 flex items-end sm:items-center justify-center p-4">
      <div className="w-full max-w-md bg-surface border border-border rounded-xl p-5 max-h-[90dvh] overflow-y-auto">
        <p className="text-xs uppercase tracking-[0.18em] text-muted">Nível {PROMOTE_LEVEL}</p>
        <h2 className="font-display text-2xl leading-none mt-1 mb-2">{current.name} pode se promover</h2>
        <p className="text-sm text-muted mb-4">
          Escolha um caminho. {current.name} não perde as magias que já tem — as novas se somam a partir de agora.
        </p>
        <div className="flex flex-col gap-2">
          {current.options.map((classId) => {
            const cls = CLASSES[classId];
            return (
              <button
                key={classId}
                type="button"
                onClick={() => onPick(current.name, classId)}
                className="w-full text-left rounded-xl border border-border bg-bg/40 px-4 py-3 hover:border-accent"
              >
                <p className="font-display text-xl leading-tight">{cls.name}</p>
                <p className="text-sm text-muted">{sheetLine(statsFor(classId, PROMOTE_LEVEL))}</p>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function SlotScreen({
  mode,
  bank,
  overwrite,
  onOverwrite,
  onClose,
  onPick,
}: {
  mode: "new" | "continue" | "save" | "load";
  bank: SaveBank;
  overwrite: number | null;
  onOverwrite: (i: number | null) => void;
  onClose: () => void;
  onPick: (index: number) => void;
}) {
  const title = mode === "new" ? "Nova campanha" : mode === "continue" ? "Continuar" : mode === "load" ? "Load" : "Save";
  const hint =
    mode === "new"
      ? "Escolha o slot. Um slot ocupado será substituído."
      : mode === "continue" || mode === "load"
        ? "O último usado vem marcado. Toque para carregar."
        : "Grava o começo deste combate. O slot anterior permanece se você escolher outro.";

  return (
    <div className="absolute inset-0 z-40 bg-bg/85 flex items-end sm:items-center justify-center p-4">
      <div className="w-full max-w-md bg-surface border border-border rounded-xl p-5 max-h-[90dvh] overflow-y-auto">
        <div className="flex items-start justify-between gap-3 mb-2">
          <div>
            <p className="text-xs uppercase tracking-[0.18em] text-muted">Arquivos</p>
            <h2 className="font-display text-2xl leading-none mt-1">{title}</h2>
          </div>
          <button type="button" onClick={onClose} className="size-11 grid place-items-center" aria-label="Fechar">
            <X className="size-5" />
          </button>
        </div>
        <p className="text-sm text-muted mb-4">{hint}</p>
        <ol className="flex flex-col gap-2">
          {Array.from({ length: SLOT_COUNT }, (_, i) => {
            const slot = bank.slots[i] ?? null;
            const empty = isSlotEmpty(slot);
            const last = i === bank.lastSlot && hasAnySave(bank) && !empty;
            const info = slotProgress(slot);
            const disabled = (mode === "continue" || mode === "load") && empty;
            const confirm = overwrite === i;
            return (
              <li key={i}>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    if ((mode === "new" || mode === "save") && !empty && !confirm) {
                      onOverwrite(i);
                      return;
                    }
                    onPick(i);
                  }}
                  className={`w-full text-left rounded-xl border px-4 py-3 disabled:opacity-40 ${
                    last ? "border-accent bg-bg/70" : "border-border bg-bg/40"
                  }`}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="text-xs uppercase tracking-[0.16em] text-muted">Slot {i + 1}</p>
                    {last && <p className="text-[10px] uppercase tracking-[0.14em] text-accent">Último usado</p>}
                  </div>
                  <p className="font-display text-xl leading-tight">{info.title}</p>
                  <p className="text-sm text-muted">{info.detail}</p>
                  {slot && !empty && (
                    <p className="text-xs tabular-nums text-muted mt-1">{formatStamp(slot.updatedAt)}</p>
                  )}
                  {confirm && <p className="text-xs text-accent mt-2">Toque de novo para substituir este slot.</p>}
                </button>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
