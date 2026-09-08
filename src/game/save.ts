import { EQUIPMENT, EXP_TO_LEVEL, MAX_LEVEL, POTION_CARRY_MAX, PROMOTIONS, WEAPONS, emberFromCompleted, starterWeaponFor, startingBags } from "./data";
import { ALL_MISSIONS } from "./mapstore";
import { TIER_KEYS } from "./types";
import type { Bag, ClassId, EquipSlot, SaveBank, SaveData, TierKey } from "./types";

export const SLOT_COUNT = 5;
export const SAVE_VERSION = 10;
const BANK_KEY = "ember-save-bank";
const SAVE_KEY = "ember-save";
const SAVE_BAK_KEY = "ember-save.bak";
const LEGACY_KEY = "brasa-save";

export const DEFAULT_LEVELS: Record<string, number> = { Kael: 1, Neera: 1, Voss: 1, Salazar: 1 };
export const DEFAULT_XP: Record<string, number> = { Kael: 0, Neera: 0, Voss: 0, Salazar: 0 };

const HEROES = ["Kael", "Neera", "Voss", "Salazar"] as const;
const MISSION_IDS = new Set(ALL_MISSIONS.map((m) => m.id));

const HERO_BASE_CLASS: Record<(typeof HEROES)[number], ClassId> = {
  Kael: "swordsman",
  Neera: "archer",
  Voss: "mage",
  Salazar: "healer",
};

function clampInt(value: unknown, min: number, max: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function cloneBags(src?: Record<string, Bag>): Record<string, Bag> {
  const base = startingBags();
  if (!src) return base;
  for (const name of Object.keys(base)) {
    const b = src[name];
    if (!b) continue;
    base[name] = {
      mid: clampInt(b.mid, 0, POTION_CARRY_MAX.mid),
      weak: clampInt(b.weak ?? (b as { high?: number }).high, 0, POTION_CARRY_MAX.weak),
      potent: clampInt(b.potent, 0, POTION_CARRY_MAX.potent),
      disease: clampInt(b.disease, 0, POTION_CARRY_MAX.disease),
      manaSmall: clampInt(b.manaSmall, 0, POTION_CARRY_MAX.manaSmall),
      manaMid: clampInt(b.manaMid, 0, POTION_CARRY_MAX.manaMid),
      manaLarge: clampInt(b.manaLarge, 0, POTION_CARRY_MAX.manaLarge),
      lockpick: clampInt(b.lockpick, 0, 9),
    };
  }
  return base;
}

function renameHero<T>(map: Record<string, T> | undefined, from: string, to: string): void {
  if (!map) return;
  if (map[from] != null && map[to] == null) {
    map[to] = map[from];
    delete map[from];
  }
}

function cleanStringList(value: unknown, allowed?: Set<string>): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !item) continue;
    if (allowed && !allowed.has(item)) continue;
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

function cleanLevels(raw: unknown): Record<string, number> {
  const levels = { ...DEFAULT_LEVELS };
  if (!raw || typeof raw !== "object") return levels;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!HEROES.includes(k as (typeof HEROES)[number])) continue;
    levels[k] = clampInt(v, 1, MAX_LEVEL);
  }
  return levels;
}

function cleanXp(raw: unknown): Record<string, number> {
  const xp = { ...DEFAULT_XP };
  if (!raw || typeof raw !== "object") return xp;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!HEROES.includes(k as (typeof HEROES)[number])) continue;
    xp[k] = clampInt(v, 0, EXP_TO_LEVEL - 1);
  }
  return xp;
}

function cleanPromotions(raw: unknown): Record<string, ClassId> {
  const out: Record<string, ClassId> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!HEROES.includes(k as (typeof HEROES)[number])) continue;
    const base = HERO_BASE_CLASS[k as (typeof HEROES)[number]];
    const options = PROMOTIONS[base];
    if (options && typeof v === "string" && (options as string[]).includes(v)) out[k] = v as ClassId;
  }
  return out;
}

function cleanWeapons(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!WEAPONS[id]) continue;
    out[id] = clampInt(v, 0, 5);
  }
  return out;
}

function cleanEquipped(raw: unknown, owned: Record<string, number>): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [hero, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!HEROES.includes(hero as (typeof HEROES)[number])) continue;
    if (typeof v === "string" && WEAPONS[v] && owned[v] != null) out[hero] = v;
  }
  return out;
}

function cleanEquipment(raw: unknown): Record<string, Partial<Record<EquipSlot, string>>> {
  const out: Record<string, Partial<Record<EquipSlot, string>>> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [hero, slots] of Object.entries(raw as Record<string, unknown>)) {
    if (!HEROES.includes(hero as (typeof HEROES)[number]) || !slots || typeof slots !== "object") continue;
    const cleanSlots: Partial<Record<EquipSlot, string>> = {};
    for (const [slot, itemId] of Object.entries(slots as Record<string, unknown>)) {
      const def = typeof itemId === "string" ? EQUIPMENT[itemId] : undefined;
      if (def && def.slot === slot) cleanSlots[slot as EquipSlot] = itemId as string;
    }
    if (Object.keys(cleanSlots).length > 0) out[hero] = cleanSlots;
  }
  return out;
}

function cleanLooseEquipment(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!EQUIPMENT[id]) continue;
    const n = clampInt(v, 0, 99);
    if (n > 0) out[id] = n;
  }
  return out;
}

function cleanSpellUses(raw: unknown): Record<string, Partial<Record<TierKey, number>>> {
  const out: Record<string, Partial<Record<TierKey, number>>> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [hero, tiers] of Object.entries(raw as Record<string, unknown>)) {
    if (!HEROES.includes(hero as (typeof HEROES)[number]) || !tiers || typeof tiers !== "object") continue;
    const cleanTiers: Partial<Record<TierKey, number>> = {};
    for (const [key, v] of Object.entries(tiers as Record<string, unknown>)) {
      if (!TIER_KEYS.includes(key as TierKey)) continue;
      const n = clampInt(v, 0, 99);
      if (n > 0) cleanTiers[key as TierKey] = n;
    }
    if (Object.keys(cleanTiers).length > 0) out[hero] = cleanTiers;
  }
  return out;
}

function cleanHp(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!HEROES.includes(k as (typeof HEROES)[number])) continue;
    const n = Math.floor(Number(v));
    if (!Number.isFinite(n) || n < 0) continue;
    out[k] = n;
  }
  return out;
}

/** Every hero starts equipped with their class's cheapest weapon — free, already owned. */
function starterEquipment(): { weapons: Record<string, number>; equipped: Record<string, string> } {
  const weapons: Record<string, number> = {};
  const equipped: Record<string, string> = {};
  for (const hero of HEROES) {
    const id = starterWeaponFor(HERO_BASE_CLASS[hero]);
    if (!id) continue;
    weapons[id] = 0;
    equipped[hero] = id;
  }
  return { weapons, equipped };
}

export function emptySave(muted = false): SaveData {
  return {
    version: SAVE_VERSION,
    completed: [],
    unitHp: {},
    levels: { ...DEFAULT_LEVELS },
    xp: { ...DEFAULT_XP },
    bags: startingBags(),
    promotions: {},
    ...starterEquipment(),
    equipment: {},
    looseEquipment: {},
    spellUses: {},
    ember: 0,
    emberSeeded: true,
    muted,
    updatedAt: Date.now(),
    pendingMission: null,
  };
}

export function emptyBank(): SaveBank {
  return {
    version: SAVE_VERSION,
    lastSlot: 0,
    muted: false,
    slots: Array.from({ length: SLOT_COUNT }, () => null),
  };
}

function migrateRecord(raw: Record<string, unknown>, muted: boolean): SaveData {
  renameHero(raw.levels as Record<string, number> | undefined, "Nira", "Neera");
  renameHero(raw.unitHp as Record<string, number> | undefined, "Nira", "Neera");
  renameHero(raw.bags as Record<string, Bag> | undefined, "Nira", "Neera");
  renameHero(raw.xp as Record<string, number> | undefined, "Nira", "Neera");
  renameHero(raw.levels as Record<string, number> | undefined, "Silas", "Salazar");
  renameHero(raw.unitHp as Record<string, number> | undefined, "Silas", "Salazar");
  renameHero(raw.bags as Record<string, Bag> | undefined, "Silas", "Salazar");
  renameHero(raw.xp as Record<string, number> | undefined, "Silas", "Salazar");

  const version = clampInt(raw.version, 0, SAVE_VERSION);
  const levels = cleanLevels(raw.levels);
  if (!raw.levels || typeof raw.levels !== "object") {
    const n = 1 + cleanStringList(raw.completed).length;
    for (const k of Object.keys(levels)) levels[k] = Math.min(MAX_LEVEL, n);
  }

  let pending: string | null = null;
  if (typeof raw.pendingMission === "string" && MISSION_IDS.has(raw.pendingMission)) pending = raw.pendingMission;
  else if (raw.battle && typeof raw.battle === "object") {
    const id = (raw.battle as { missionId?: string }).missionId;
    if (typeof id === "string" && MISSION_IDS.has(id)) pending = id;
  }

  const completed = cleanStringList(raw.completed, MISSION_IDS);
  const weapons = cleanWeapons(raw.weapons);
  const equipped = cleanEquipped(raw.equipped, weapons);
  // Backfill: any hero with nothing equipped yet (old save, predates weapons) gets their
  // class's free starter weapon, same as a brand new save already does.
  for (const hero of HEROES) {
    if (equipped[hero]) continue;
    const id = starterWeaponFor(HERO_BASE_CLASS[hero]);
    if (!id) continue;
    weapons[id] = weapons[id] ?? 0;
    equipped[hero] = id;
  }
  let ember = clampInt(raw.ember, 0, 9999);
  let emberSeeded = raw.emberSeeded === true;
  if (!emberSeeded) {
    ember += emberFromCompleted(completed);
    emberSeeded = true;
  }

  return {
    version: SAVE_VERSION,
    completed,
    unitHp: cleanHp(raw.unitHp),
    levels,
    xp: cleanXp(raw.xp),
    bags: version < 4 ? startingBags() : cloneBags(raw.bags as Record<string, Bag>),
    promotions: cleanPromotions(raw.promotions),
    weapons,
    equipped,
    equipment: cleanEquipment(raw.equipment),
    looseEquipment: cleanLooseEquipment(raw.looseEquipment),
    spellUses: cleanSpellUses(raw.spellUses),
    ember,
    emberSeeded,
    muted: raw.muted === true || muted,
    updatedAt: typeof raw.updatedAt === "number" && raw.updatedAt > 0 ? raw.updatedAt : Date.now(),
    pendingMission: pending,
  };
}

function parseRecord(text: string | null): SaveData | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    return migrateRecord(parsed as Record<string, unknown>, false);
  } catch {
    return null;
  }
}

function readKey(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeKey(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function slotOccupied(s: SaveData | null): boolean {
  if (!s) return false;
  return s.completed.length > 0 || Object.keys(s.unitHp).length > 0 || !!s.pendingMission;
}

function migrateLegacyIntoBank(): SaveBank {
  const bank = emptyBank();
  const legacy = parseRecord(readKey(BANK_KEY) ? null : readKey(SAVE_KEY)) ?? parseRecord(readKey(SAVE_BAK_KEY)) ?? parseRecord(readKey(LEGACY_KEY));
  if (legacy && slotOccupied(legacy)) {
    bank.slots[0] = legacy;
    bank.lastSlot = 0;
    bank.muted = legacy.muted;
  }
  return bank;
}

function parseBank(text: string | null): SaveBank | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const raw = parsed as Record<string, unknown>;
    const rawSlots = Array.isArray(raw.slots) ? raw.slots : [];
    const muted = raw.muted === true;
    const slots: Array<SaveData | null> = Array.from({ length: SLOT_COUNT }, (_, i) => {
      const item = rawSlots[i];
      if (!item || typeof item !== "object") return null;
      const rec = migrateRecord(item as Record<string, unknown>, muted);
      return slotOccupied(rec) ? rec : null;
    });
    const lastSlot = clampInt(raw.lastSlot, 0, SLOT_COUNT - 1);
    return { version: SAVE_VERSION, lastSlot: slots[lastSlot] ? lastSlot : slots.findIndex(Boolean) === -1 ? 0 : Math.max(0, slots.findIndex(Boolean)), muted, slots };
  } catch {
    return null;
  }
}

export function loadBank(): SaveBank {
  const bank = parseBank(readKey(BANK_KEY));
  if (bank) return bank;
  const migrated = migrateLegacyIntoBank();
  persistBank(migrated);
  return migrated;
}

function persistBank(bank: SaveBank): void {
  writeKey(BANK_KEY, JSON.stringify({ ...bank, version: SAVE_VERSION }));
}

export function writeBank(bank: SaveBank): SaveBank {
  const next: SaveBank = {
    version: SAVE_VERSION,
    lastSlot: clampInt(bank.lastSlot, 0, SLOT_COUNT - 1),
    muted: bank.muted === true,
    slots: Array.from({ length: SLOT_COUNT }, (_, i) => bank.slots[i] ?? null),
  };
  persistBank(next);
  return next;
}

export function activeSave(bank: SaveBank): SaveData {
  return bank.slots[bank.lastSlot] ?? emptySave(bank.muted);
}

export function writeSlot(bank: SaveBank, index: number, data: SaveData): SaveBank {
  const i = clampInt(index, 0, SLOT_COUNT - 1);
  const slots = [...bank.slots];
  slots[i] = { ...data, version: SAVE_VERSION, muted: bank.muted, updatedAt: Date.now() };
  return writeBank({ ...bank, lastSlot: i, slots });
}

export function selectSlot(bank: SaveBank, index: number): SaveBank {
  const i = clampInt(index, 0, SLOT_COUNT - 1);
  return writeBank({ ...bank, lastSlot: i });
}

export function setMutedBank(bank: SaveBank, muted: boolean): SaveBank {
  return writeBank({ ...bank, muted });
}

export function formatStamp(ts: number): string {
  try {
    return new Intl.DateTimeFormat("pt-BR", {
      timeZone: "America/Sao_Paulo",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(ts));
  } catch {
    return "";
  }
}

export function slotProgress(slot: SaveData | null): { title: string; detail: string } {
  if (!slot || !slotOccupied(slot)) return { title: "Vazio", detail: "Nenhuma campanha" };
  if (slot.pendingMission) {
    const m = ALL_MISSIONS.find((x) => x.id === slot.pendingMission);
    return { title: m ? m.title : slot.pendingMission, detail: "Início do combate" };
  }
  if (slot.completed.length === 0) return { title: "Campanha nova", detail: "Mapa de cenários" };
  const lastId = slot.completed[slot.completed.length - 1]!;
  const last = ALL_MISSIONS.find((x) => x.id === lastId);
  const next = ALL_MISSIONS.find((x) => last && x.index === last.index + 1);
  if (next) return { title: next.title, detail: `Após ${last?.title ?? lastId}` };
  return { title: last?.title ?? lastId, detail: "Campanha concluída" };
}

export function hasAnySave(bank: SaveBank): boolean {
  return bank.slots.some(slotOccupied);
}

export function isSlotEmpty(slot: SaveData | null): boolean {
  return !slotOccupied(slot);
}
