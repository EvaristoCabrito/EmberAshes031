import { useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { BAG_MAX, CLASSES, EMPTY_BAG, EQUIPMENT, EQUIPMENT_SLOTS, POTION_CARRY_MAX, WEAPONS, equipmentFitsSlot, equipmentIcon, equipmentStatSummary, equipmentTooltip, equipmentTypeSlotName, heroRecruited, lockpickTooltip, offHandBlocked, potionLabel, potionTooltip, weaponDiceLabel, weaponIcon, weaponPower, weaponRangeLabel, weaponTooltip, weaponsForClass } from "./data";
import type { ClassId, EquipSlot, PotionId, SaveData } from "./types";

const POTIONS: PotionId[] = ["weak", "mid", "potent", "disease", "manaSmall", "manaMid", "manaLarge"];
const BAG_ICON = "/game/icons/equipment/small-leather-pouch.png";

/** Hover card that follows the cursor — `fixed` so overflow-hidden parents don't clip it. */
export function ItemTip({ text, children, className }: { text: string; children: ReactNode; className?: string }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  return (
    <div
      className={className}
      onMouseEnter={(e) => setPos({ x: e.clientX, y: e.clientY })}
      onMouseMove={(e) => setPos({ x: e.clientX, y: e.clientY })}
      onMouseLeave={() => setPos(null)}
    >
      {children}
      {pos && (
        <div
          role="tooltip"
          className="pointer-events-none fixed z-[80] max-w-[16rem] whitespace-pre-line rounded-md border border-border bg-surface px-2.5 py-2 text-left text-[11px] leading-snug text-fg shadow-lg"
          style={{ left: Math.min(pos.x + 14, window.innerWidth - 272), top: Math.min(pos.y + 18, window.innerHeight - 16) }}
        >
          {text}
        </div>
      )}
    </div>
  );
}

/** Paper-doll equipment view for one hero. Clicking a slot opens a picker of compatible
 * OWNED items — Mão Principal lists owned weapons for this class (save.weapons), other
 * slots list owned EQUIPMENT of that slot type from the party's shared, unassigned stash
 * (save.looseEquipment) — gear found in chests lands there, never auto-equipped onto
 * whoever opened the chest, so it shows up here for the player to assign wherever they
 * want. */
export function PaperDollScreen({
  heroName,
  classId,
  save,
  onClose,
  onSwitchToBackpack,
  onEquipWeapon,
  onEquipItem,
  embedded = false,
}: {
  heroName: string;
  classId: ClassId;
  save: SaveData;
  onClose: () => void;
  onSwitchToBackpack?: () => void;
  onEquipWeapon?: (hero: string, weaponId: string) => void;
  onEquipItem?: (hero: string, slot: EquipSlot, itemId: string | null) => void;
  embedded?: boolean;
}) {
  const [picker, setPicker] = useState<"mainHand" | EquipSlot | null>(null);
  const weaponId = save.equipped[heroName];
  const weapon = weaponId ? WEAPONS[weaponId] : null;
  const enh = weaponId ? (save.weapons[weaponId] ?? 0) : 0;
  const equip = save.equipment[heroName] ?? {};
  const wearerOf = (itemId: string) => Object.entries(save.equipment).find(([, slots]) => Object.values(slots).includes(itemId))?.[0];
  const ownedWeapons = [...weaponsForClass(classId)].filter((w) => save.weapons[w.id] != null).sort((a, b) => weaponPower(a) - weaponPower(b));

  return (
    <div
      className={embedded ? "relative z-0 h-full min-w-0 overflow-hidden" : "absolute inset-0 z-40 flex items-center justify-center bg-bg/85 p-4"}
      onClick={(e) => {
        if (!embedded && e.target === e.currentTarget) onClose();
      }}
    >
      <div className={embedded ? "h-full min-h-0 w-full ember-scrollbar overflow-y-auto overflow-x-hidden rounded-xl border border-border bg-surface p-4" : "w-full max-w-md max-h-[88dvh] overflow-y-auto bg-surface border border-border rounded-xl p-5"}>
        <div className="flex items-start justify-between gap-3 mb-4">
          <div>
            <p className="font-display text-xl leading-tight">{heroName}</p>
            <p className="text-xs text-muted">{CLASSES[classId].name}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {onSwitchToBackpack && (
              <button type="button" onClick={onSwitchToBackpack} className="h-12 px-3 rounded-md border border-border text-xs flex items-center gap-2">
                <img src={BAG_ICON} alt="" className="size-8 shrink-0 rounded-sm object-contain" />
                Mochila
              </button>
            )}
            <button type="button" onClick={onClose} className="size-8 grid place-items-center rounded-md border border-border" aria-label="Fechar">
              <X className="size-4" />
            </button>
          </div>
        </div>

        <p className="text-xs uppercase tracking-[0.18em] text-muted mb-2">Mão Principal</p>
        <div className="mb-4">
          <ItemTip text={weapon ? weaponTooltip(weapon, enh) : "Mão principal · vazia"} className="block">
            <button
              type="button"
              disabled={!onEquipWeapon}
              onClick={() => setPicker("mainHand")}
              className="w-full flex items-center gap-2 bg-bg border border-border rounded-md px-2 py-1.5 text-left disabled:cursor-default"
            >
              {weapon ? (
                <>
                  <img src={weaponIcon(weapon.id)} alt="" className="size-9 rounded-sm object-cover shrink-0" />
                  <span className="flex-1 text-sm min-w-0">
                    {weapon.name} {enh > 0 ? `+${enh}` : ""}
                    <span className="block text-[11px] text-muted tabular-nums">
                      {weaponDiceLabel(weapon.id)} · {weaponRangeLabel(weapon.id)}
                    </span>
                    {weapon.bonusClass && (
                      <span className={`block text-[11px] tabular-nums ${weapon.bonusClass === classId ? "text-accent" : "text-muted"}`}>
                        +10% dano · {CLASSES[weapon.bonusClass].name}
                      </span>
                    )}
                  </span>
                </>
              ) : (
                <p className="text-sm text-muted">Vazia · equipe com o Ferreiro na Estalagem</p>
              )}
            </button>
          </ItemTip>
          {weapon && onEquipWeapon && (
            <button
              type="button"
              onClick={() => onEquipWeapon(heroName, "")}
              className="mt-1 w-full rounded-md border border-border bg-bg px-2 py-1 text-[11px]"
            >
              Desequipar
            </button>
          )}
        </div>

        <p className="text-xs uppercase tracking-[0.18em] text-muted mb-2">Equipamento</p>
        <div className="grid grid-cols-2 gap-1.5">
          {EQUIPMENT_SLOTS.map((s) => {
            const itemId = equip[s.id];
            const item = itemId ? EQUIPMENT[itemId] : null;
            const tip = item ? equipmentTooltip(item) : `${s.label} · vazio`;
            return (
              <div key={s.id}>
                <ItemTip text={tip} className="block">
                  <button
                    type="button"
                    onClick={() => setPicker(s.id)}
                    className="w-full bg-bg border border-border rounded-md px-2 py-1.5 text-left flex items-center gap-2"
                  >
                    <span className="flex-1 min-w-0">
                      <span className="block text-[10px] uppercase tracking-wide text-muted">{s.label}</span>
                      <span className="block text-xs truncate text-fg/90">{item ? item.name : "Vazio"}</span>
                      {item && (
                        <span className="block text-[10px] text-muted truncate">
                          {item.kind === "shield"
                            ? `Escudo · ${Math.round((item.dmgMul ?? 0.75) * 100)}% dano`
                            : item.kind === "weapon"
                              ? `${item.dice}D${item.faces} · Mão secundária`
                              : equipmentStatSummary(item) || equipmentTypeSlotName(item)}
                        </span>
                      )}
                    </span>
                    {item ? (
                      <img src={equipmentIcon(item.id)} alt="" className="size-9 rounded-sm object-cover shrink-0" />
                    ) : (
                      <span className="size-9 rounded-sm border border-dashed border-border shrink-0" aria-hidden="true" />
                    )}
                  </button>
                </ItemTip>
                {item && onEquipItem && (
                  <button
                    type="button"
                    onClick={() => onEquipItem(heroName, s.id, null)}
                    className="mt-1 w-full rounded-md border border-border bg-bg px-2 py-0.5 text-[10px]"
                  >
                    Desequipar
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {picker != null && (
        <div
          className="absolute inset-0 z-50 bg-bg/85 flex items-center justify-center p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) setPicker(null);
          }}
        >
          <div className="w-full max-w-sm max-h-[80dvh] overflow-y-auto bg-surface border border-border rounded-xl p-5">
            <div className="flex items-center justify-between gap-3 mb-3">
              <p className="font-display text-lg leading-tight">{picker === "mainHand" ? "Mão Principal" : EQUIPMENT_SLOTS.find((s) => s.id === picker)?.label}</p>
              <button type="button" onClick={() => setPicker(null)} className="size-8 grid place-items-center rounded-md border border-border" aria-label="Fechar">
                <X className="size-4" />
              </button>
            </div>

            {picker === "mainHand" ? (
              <>
                {weapon && onEquipWeapon && (
                  <button
                    type="button"
                    onClick={() => {
                      onEquipWeapon(heroName, "");
                      setPicker(null);
                    }}
                    className="w-full mb-2 rounded-md border border-border bg-bg px-2 py-1.5 text-sm text-left"
                  >
                    Desequipar
                  </button>
                )}
                {ownedWeapons.length > 0 ? (
                <div className="flex flex-col gap-1.5">
                  {ownedWeapons.map((w) => (
                    <ItemTip key={w.id} text={weaponTooltip(w, save.weapons[w.id] ?? 0)}>
                      <button
                        type="button"
                        onClick={() => {
                          onEquipWeapon?.(heroName, w.id);
                          setPicker(null);
                        }}
                        disabled={w.id === weaponId}
                        className="w-full flex items-center gap-2 bg-bg border border-border rounded-md px-2 py-1.5 text-left disabled:opacity-50"
                      >
                        <img src={weaponIcon(w.id)} alt="" className="size-9 rounded-sm object-cover shrink-0" />
                        <span className="flex-1 text-sm min-w-0">
                          {w.name} {save.weapons[w.id] ? `+${save.weapons[w.id]}` : ""}
                          <span className="block text-[11px] text-muted tabular-nums">
                            {weaponDiceLabel(w.id)} · {weaponRangeLabel(w.id)}
                          </span>
                          {w.bonusClass && (
                            <span className={`block text-[11px] tabular-nums ${w.bonusClass === classId ? "text-accent" : "text-muted"}`}>
                              +10% dano · {CLASSES[w.bonusClass].name}
                            </span>
                          )}
                        </span>
                        {w.id === weaponId && <span className="text-[11px] text-muted shrink-0">Equipada</span>}
                      </button>
                    </ItemTip>
                  ))}
                </div>
                ) : (
                  <p className="text-sm text-muted">Nenhuma arma no saco ainda. Compre uma com o Ferreiro.</p>
                )}
              </>
            ) : picker === "offHand" && offHandBlocked(weaponId ?? null) ? (
              <p className="text-sm text-muted">Arma principal de duas mãos — sem mão livre para a secundária.</p>
            ) : (
              (() => {
                const slot = picker as EquipSlot;
                const otherRing = slot === "ring1" ? equip.ring2 : slot === "ring2" ? equip.ring1 : undefined;
                const options = Object.values(EQUIPMENT).filter(
                  (it) =>
                    equipmentFitsSlot(it, slot) &&
                    ((save.looseEquipment[it.id] ?? 0) > 0 || !!wearerOf(it.id)) &&
                    (!it.usableBy || it.usableBy.includes(classId)),
                );
                const wornHere = equip[slot];
                return (
                  <div className="flex flex-col gap-1.5">
                    {wornHere && onEquipItem && (
                      <button
                        type="button"
                        onClick={() => {
                          onEquipItem(heroName, slot, null);
                          setPicker(null);
                        }}
                        className="w-full rounded-md border border-border bg-bg px-2 py-1.5 text-sm text-left"
                      >
                        Desequipar
                      </button>
                    )}
                    {options.length > 0 ? (
                      options.map((it) => {
                        const equipped = equip[slot] === it.id;
                        const owned = save.looseEquipment[it.id] ?? 0;
                        const wearer = wearerOf(it.id);
                        const onOtherFinger = otherRing === it.id && owned <= 0;
                        return (
                          <ItemTip key={it.id} text={equipmentTooltip(it)}>
                            <button
                              type="button"
                              disabled={equipped || onOtherFinger || !onEquipItem}
                              onClick={() => {
                                onEquipItem?.(heroName, slot, it.id);
                                setPicker(null);
                              }}
                              className="w-full flex items-center gap-2 bg-bg border border-border rounded-md px-2 py-1.5 text-left disabled:opacity-50"
                            >
                              <img src={equipmentIcon(it.id)} alt="" className="size-9 rounded-sm object-cover shrink-0" />
                              <span className="flex-1 text-sm min-w-0">
                                {it.name} {owned > 1 ? `×${owned}` : ""}
                                <span className="block text-[10px] uppercase tracking-wide text-muted">{equipmentTypeSlotName(it)}</span>
                                <span className="block text-[11px] text-muted">
                                  {it.kind === "shield"
                                    ? `Investida de Escudo · ${Math.round((it.dmgMul ?? 0.75) * 100)}% dano · 70% atordoa`
                                    : it.kind === "weapon"
                                      ? `${it.dice}D${it.faces} · Mão secundária`
                                      : equipmentStatSummary(it)}
                                </span>
                              </span>
                              {equipped && <span className="text-[11px] text-muted shrink-0">Equipado</span>}
                              {onOtherFinger && <span className="text-[11px] text-muted shrink-0">já no outro anel</span>}
                              {!equipped && !onOtherFinger && wearer && <span className="text-[11px] text-muted shrink-0">em {wearer}</span>}
                            </button>
                          </ItemTip>
                        );
                      })
                    ) : (
                      <p className="text-sm text-muted">Nenhum item no baú do grupo pra esse espaço ainda.</p>
                    )}
                  </div>
                );
              })()
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Backpack overview: this hero's potions/gazuas plus the party's shared weapon and equipment stash. */
export function BackpackScreen({
  heroName,
  save,
  onClose,
  onSwitchToDoll,
  embedded = false,
}: {
  heroName: string;
  save: SaveData;
  onClose: () => void;
  onSwitchToDoll?: () => void;
  embedded?: boolean;
}) {
  const bag = save.bags[heroName] ?? EMPTY_BAG;
  // Only counts potions toward pouch capacity — lockpicks are tracked separately (see the
  // Bag.lockpick doc comment) and aren't a "found in the field" consumable in the same
  // sense. Only the small pouch exists so far (see BAG_ICON's own note), hence the flat 30.
  const bagCount = POTIONS.reduce((n, kind) => n + (bag[kind] ?? 0), 0);
  const bagCapacity = 30;
  const weaponEntries = Object.entries(save.weapons).filter(([id]) => {
    const wielder = Object.entries(save.equipped).find(([, v]) => v === id)?.[0];
    return !wielder || heroRecruited(wielder, save.completed);
  });
  const wearerOf = (id: string) =>
    Object.entries(save.equipment).find(([, slots]) => Object.values(slots).includes(id))?.[0];
  const sharedEquipmentIds = new Set([
    ...Object.keys(save.looseEquipment),
    ...Object.values(save.equipment).flatMap((slots) => Object.values(slots)),
  ]);
  const equipmentEntries = [...sharedEquipmentIds]
    .map((id) => [
      id,
      (save.looseEquipment[id] ?? 0) + Object.values(save.equipment).reduce((total, slots) => total + Object.values(slots).filter((equippedId) => equippedId === id).length, 0),
    ] as const)
    .filter(([id]) => {
      const wearer = wearerOf(id);
      return !wearer || heroRecruited(wearer, save.completed);
    });

  return (
    <div
      className={embedded ? "relative z-0 h-full min-w-0 overflow-hidden" : "absolute inset-0 z-40 flex items-center justify-center bg-bg/85 p-4"}
      onClick={(e) => {
        if (!embedded && e.target === e.currentTarget) onClose();
      }}
    >
      <div className={embedded ? "relative h-full min-h-0 w-full ember-scrollbar overflow-y-auto overflow-x-hidden rounded-xl border border-border p-4" : "relative w-full max-w-md max-h-[88dvh] overflow-y-auto border border-border rounded-xl p-5"}>
        <img src="/game/assets/backpack-bg.jpg" alt="" className="absolute inset-0 h-full w-full object-cover rounded-xl blur-[5px] scale-110 -z-10" />
        <div className="absolute inset-0 bg-bg/55 rounded-xl -z-10" />
        <div className="flex items-start justify-between gap-3 mb-4">
          <div>
            <div className="flex items-center gap-2">
              <img src={BAG_ICON} alt="" className="size-10 shrink-0 rounded-sm object-contain" />
              <p className="font-display text-xl leading-tight drop-shadow-[0_1px_3px_rgba(0,0,0,0.8)]">Mochila</p>
            </div>
            <p className="text-xs text-fg/80 drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]">{heroName}</p>
            <p
              className={`text-[11px] tabular-nums mt-0.5 ${bagCount >= bagCapacity ? "text-danger" : "text-fg/70"} drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]`}
            >
              {bagCount} / {bagCapacity} itens
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {onSwitchToDoll && (
              <button type="button" onClick={onSwitchToDoll} className="h-8 px-2.5 rounded-md border border-border bg-bg/80 text-xs">
                Equipar
              </button>
            )}
            <button type="button" onClick={onClose} className="size-8 grid place-items-center rounded-md border border-border bg-bg/80" aria-label="Fechar">
              <X className="size-4" />
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between bg-bg border border-border rounded-md px-2 py-1.5">
            <p className="text-sm">Ember</p>
            <p className="text-sm tabular-nums text-muted">×{save.ember ?? 0}</p>
          </div>
          {POTIONS.map((kind) => (
            <ItemTip key={kind} text={potionTooltip(kind)} className="block">
              <div className="flex items-center gap-1.5 bg-bg border border-border rounded-md px-2 py-1.5">
                <img src={`/game/icons/potion-${kind}.png?v=ds2`} alt="" className="size-6 rounded-sm object-cover shrink-0" />
                <p className="flex-1 text-sm truncate">
                  {potionLabel(kind)}
                  <span className="block text-[10px] uppercase tracking-wide text-muted">Consumível</span>
                </p>
                <p className="text-sm tabular-nums text-muted">
                  {bag[kind] ?? 0} / {POTION_CARRY_MAX[kind]}
                </p>
              </div>
            </ItemTip>
          ))}
          <ItemTip text={lockpickTooltip()} className="block">
            <div className="flex items-center gap-1.5 bg-bg border border-border rounded-md px-2 py-1.5">
              <img src="/game/icons/lockpick.png" alt="" className="size-6 rounded-sm object-cover shrink-0" />
              <p className="flex-1 text-sm truncate">
                Gazua
                <span className="block text-[10px] uppercase tracking-wide text-muted">Consumível</span>
              </p>
              <p className="text-sm tabular-nums text-muted">{bag.lockpick ?? 0} / {BAG_MAX}</p>
            </div>
          </ItemTip>
        </div>

        {weaponEntries.length > 0 && (
          <>
            <p className="text-xs uppercase tracking-[0.18em] text-muted mt-4 mb-2">Armas do grupo</p>
            <div className="flex flex-col gap-1.5">
              {weaponEntries.map(([id, enh]) => {
                const w = WEAPONS[id];
                if (!w) return null;
                const wielder = Object.entries(save.equipped).find(([, v]) => v === id)?.[0];
                return (
                  <ItemTip key={id} text={weaponTooltip(w, enh)} className="block">
                    <div className="flex items-center gap-1.5 bg-bg border border-border rounded-md px-2 py-1.5">
                      <img src={weaponIcon(id)} alt="" className="size-6 rounded-sm object-cover shrink-0" />
                      <p className="flex-1 text-sm min-w-0 truncate">
                        {w.name} {enh > 0 ? `+${enh}` : ""}
                        <span className="block text-[10px] uppercase tracking-wide text-muted">Mão principal</span>
                      </p>
                      <p className="text-[11px] text-muted shrink-0">{wielder ? `em ${wielder}` : "reserva"}</p>
                    </div>
                  </ItemTip>
                );
              })}
            </div>
          </>
        )}

        {equipmentEntries.length > 0 && (
          <>
            <p className="text-xs uppercase tracking-[0.18em] text-muted mt-4 mb-2">Equipamento do grupo</p>
            <div className="flex flex-col gap-1.5">
              {equipmentEntries.map(([id, count]) => {
                const it = EQUIPMENT[id];
                if (!it) return null;
                const wearer = wearerOf(id);
                return (
                  <ItemTip key={id} text={equipmentTooltip(it)} className="block">
                    <div className="flex items-center gap-1.5 bg-bg border border-border rounded-md px-2 py-1.5">
                      <img src={equipmentIcon(id)} alt="" className="size-6 rounded-sm object-cover shrink-0" />
                      <p className="flex-1 text-sm min-w-0 truncate">
                        {it.name} {count > 1 ? `×${count}` : ""}
                        <span className="block text-[10px] uppercase tracking-wide text-muted">{equipmentTypeSlotName(it)}</span>
                      </p>
                      <p className="text-[11px] text-muted shrink-0">{wearer ? `em ${wearer}` : "reserva"}</p>
                    </div>
                  </ItemTip>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** One inventory action opens the hero's personal consumables beside the party's equipment
 * sheet. The grid never exceeds its container; narrow screens stack vertically instead of
 * producing a horizontal scrollbar. */
export function PartyInventoryOverlay({
  heroName,
  classId,
  save,
  onClose,
  onEquipWeapon,
  onEquipItem,
}: {
  heroName: string;
  classId: ClassId;
  save: SaveData;
  onClose: () => void;
  onEquipWeapon?: (hero: string, weaponId: string) => void;
  onEquipItem?: (hero: string, slot: EquipSlot, itemId: string | null) => void;
}) {
  return (
    <div
      className="absolute inset-0 z-40 grid place-items-center bg-bg/85 p-3 sm:p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="grid h-[min(88dvh,48rem)] w-full max-w-6xl min-w-0 grid-cols-1 gap-3 overflow-x-hidden overflow-y-auto lg:grid-cols-2 lg:overflow-y-hidden">
        <BackpackScreen heroName={heroName} save={save} onClose={onClose} embedded />
        <PaperDollScreen
          heroName={heroName}
          classId={classId}
          save={save}
          onClose={onClose}
          onEquipWeapon={onEquipWeapon}
          onEquipItem={onEquipItem}
          embedded
        />
      </div>
    </div>
  );
}