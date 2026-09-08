import { useMemo, useState } from "react";
import { ChevronLeft, Volume2, VolumeX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BAG_MAX, CLASSES, HERO_NAMES, LOCKPICK_PRICE, POTION_CARRY_MAX, POTION_PRICE, WEAPON_MAX_ENH, WEAPONS, heroRecruited, partyPouchId, pouchIcon, weaponDiceLabel, weaponEnhCost, weaponIcon, weaponPower, weaponRangeLabel, weaponSellValue, weaponsForClass, potionLabel } from "./data";
import { BackpackScreen, PaperDollScreen } from "./InventoryScreens";
import type { Bag, ClassId, EquipSlot, PotionId, SaveData } from "./types";

const BAG_ICON = pouchIcon(null);

const NPCS = [
  {
    id: "brue",
    name: "Brue",
    role: "Estalajadeiro",
    portrait: "/game/portraits/brue.png",
    talk: "O fogo ainda pega. As camas, não. Ember compra o que sobrou da adega. Salazar pode levar frasco — não precisa, mas o copo não recusa.",
    shop: true,
  },
  {
    id: "mudo",
    name: "O Mudo",
    role: "Viajante",
    portrait: "/game/portraits/mudo.png",
    talk: "Ele não fala. Nunca. Carrega uma pequena tábua de madeira e um pedaço de giz, e usa-a para responder quando não pode simplesmente apontar ou ir embora. Na tábua, uma frase aparece repetidamente: “Não fique parado por muito tempo.” Ninguém sabe de onde ele veio. Conhece estradas que não aparecem em mapa algum e parece sempre estar a caminho de algum lugar. Quando perguntam quanto custa uma bebida na velha adega, ele escreve apenas: “Ainda tem preço.”",
    shop: false,
  },
  {
    id: "porao",
    name: "A Hóspede",
    role: "Porão",
    portrait: "/game/portraits/porao.png",
    talk: "Não subo. O chão me conhece. Tragam histórias, não luz. Se Brue ainda mede Ember, o mundo não acabou.",
    shop: false,
  },
] as const;

const POTION_ORDER: PotionId[] = ["weak", "mid", "potent", "disease", "manaSmall", "manaMid", "manaLarge"];

const ICONS: Record<PotionId, string> = {
  weak: "/game/icons/potion-weak.png",
  mid: "/game/icons/potion-mid.png",
  potent: "/game/icons/potion-potent.png",
  disease: "/game/icons/potion-disease.png",
  manaSmall: "/game/icons/potion-manaSmall.png?v=ds2",
  manaMid: "/game/icons/potion-manaMid.png?v=ds2",
  manaLarge: "/game/icons/potion-manaLarge.png?v=ds2",
};

const EMPTY_CART: Record<PotionId, number> = { weak: 0, mid: 0, potent: 0, disease: 0, manaSmall: 0, manaMid: 0, manaLarge: 0 };

export function InnScreen({
  bags,
  ember,
  muted,
  weapons,
  equipped,
  heroClass,
  save,
  onMute,
  onLeave,
  onPay,
  onBuyWeapon,
  onEquipWeapon,
  onEquipItem,
  onUpgradeWeapon,
  onSellWeapon,
}: {
  bags: Record<string, Bag>;
  ember: number;
  muted: boolean;
  weapons: Record<string, number>;
  equipped: Record<string, string>;
  heroClass: Record<string, ClassId>;
  save: SaveData;
  onMute: () => void;
  onLeave: () => void;
  onPay: (hero: string, cart: Record<PotionId, number>, lockpicks: number) => boolean;
  onBuyWeapon: (hero: string, weaponId: string) => boolean;
  onEquipWeapon: (hero: string, weaponId: string) => void;
  onEquipItem?: (hero: string, slot: EquipSlot, itemId: string) => void;
  onUpgradeWeapon: (weaponId: string) => boolean;
  onSellWeapon: (weaponId: string) => number | false;
}) {
  const [view, setView] = useState<"npc" | "smith">("npc");
  const [npc, setNpc] = useState<(typeof NPCS)[number]>(NPCS[0]);
  const [hero, setHero] = useState<string>("Kael");
  const [cart, setCart] = useState<Record<PotionId, number>>({ ...EMPTY_CART });
  const [lockpickQty, setLockpickQty] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const [invView, setInvView] = useState<"doll" | "pack" | null>(null);
  const bag = bags[hero] ?? { mid: 0, weak: 0, potent: 0, disease: 0, manaSmall: 0, manaMid: 0, manaLarge: 0, lockpick: 0 };

  const total = useMemo(
    () => POTION_ORDER.reduce((n, kind) => n + cart[kind] * POTION_PRICE[kind], 0) + lockpickQty * LOCKPICK_PRICE,
    [cart, lockpickQty],
  );
  const items = POTION_ORDER.reduce((n, kind) => n + cart[kind], 0) + lockpickQty;
  const remain = ember - total;

  const add = (kind: PotionId, delta: number) => {
    setNote(null);
    setCart((prev) => {
      const next = Math.max(0, (prev[kind] ?? 0) + delta);
      const have = bag[kind] ?? 0;
      const cap = Math.max(0, POTION_CARRY_MAX[kind] - have);
      return { ...prev, [kind]: Math.min(next, cap) };
    });
  };

  const addLockpick = (delta: number) => {
    setNote(null);
    setLockpickQty((prev) => {
      const next = Math.max(0, prev + delta);
      const cap = Math.max(0, BAG_MAX - (bag.lockpick ?? 0));
      return Math.min(next, cap);
    });
  };

  const pay = () => {
    if (items <= 0) {
      setNote("Nada no copo.");
      return;
    }
    if (remain < 0) {
      setNote(`Faltam ${-remain} Ember.`);
      return;
    }
    const ok = onPay(hero, cart, lockpickQty);
    if (!ok) {
      setNote("Brue recusou. Ember ou espaço.");
      return;
    }
    setCart({ ...EMPTY_CART });
    setLockpickQty(0);
    setNote("Pago. Os frascos foram para o saco.");
  };

  if (view === "smith") {
    return (
      <SmithPanel
        ember={ember}
        muted={muted}
        weapons={weapons}
        equipped={equipped}
        heroClass={heroClass}
        save={save}
        onMute={onMute}
        onBack={() => setView("npc")}
        onBuyWeapon={onBuyWeapon}
        onEquipWeapon={onEquipWeapon}
        onEquipItem={onEquipItem}
        onUpgradeWeapon={onUpgradeWeapon}
        onSellWeapon={onSellWeapon}
      />
    );
  }

  return (
    <section className="relative h-dvh min-h-0 flex flex-col overflow-hidden bg-bg">
      <img src="/game/assets/brief-estalagem.jpg" alt="" className="absolute inset-0 h-full w-full object-cover" />
      <div className="absolute inset-0 bg-gradient-to-t from-bg via-bg/80 to-bg/40" />
      <header className="relative z-10 flex items-center gap-3 px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-3">
        <button type="button" onClick={onLeave} className="h-10 px-3 rounded-md border border-border bg-bg/70 text-xs uppercase tracking-[0.14em]">
          Sair
        </button>
        <div className="min-w-0 flex-1">
          <p className="text-xs uppercase tracking-[0.18em] text-muted">Pousada à margem da cinza</p>
          <h1 className="font-display text-2xl leading-none">A Estalagem do Osso Seco</h1>
        </div>
        <button
          type="button"
          onClick={() => setInvView("pack")}
          className="h-12 px-3 rounded-md border border-border bg-bg/70 text-xs uppercase tracking-[0.14em] flex items-center gap-2"
        >
          <img src={BAG_ICON} alt="" className="size-8 shrink-0 rounded-sm object-contain" />
          Mochila
        </button>
        <button
          type="button"
          onClick={() => setView("smith")}
          className="h-10 px-3 rounded-md border border-border bg-bg/70 text-xs uppercase tracking-[0.14em]"
        >
          Ferreiro
        </button>
        <p className="text-sm tabular-nums border border-border bg-bg/70 rounded-md px-2 py-1">Ember {ember}</p>
        <button type="button" onClick={onMute} className="size-10 grid place-items-center rounded-md border border-border bg-bg/70" aria-label="Som">
          {muted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
        </button>
      </header>
      <div className="relative z-10 flex-1 min-h-0 overflow-y-auto p-4 flex flex-col gap-3 max-w-lg mx-auto w-full">
        <div className="grid grid-cols-3 gap-2">
          {NPCS.map((n) => (
            <button
              key={n.id}
              type="button"
              onClick={() => setNpc(n)}
              className={`rounded-xl border overflow-hidden text-left ${npc.id === n.id ? "border-accent" : "border-border"}`}
            >
              <img src={n.portrait} alt="" className="w-full aspect-[2/3] object-cover" />
              <p className="px-2 py-1 text-xs font-medium truncate bg-surface/90">{n.name}</p>
            </button>
          ))}
        </div>
        <div className="rounded-xl border border-border bg-surface/90 p-3 flex gap-3">
          <img src={npc.portrait} alt="" className="h-24 w-16 object-cover rounded-md shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-medium">
              {npc.name} · {npc.role}
            </p>
            <p className="mt-1 text-sm leading-relaxed text-fg/90">{npc.talk}</p>
          </div>
        </div>
        {npc.shop && (
          <div className="rounded-xl border border-border bg-surface/90 p-3 flex flex-col gap-2">
            <p className="text-xs uppercase tracking-[0.16em] text-muted">Adega · quem leva</p>
            <div className="flex flex-wrap gap-1">
              {HERO_NAMES.filter((name) => heroRecruited(name, save.completed)).map((name) => (
                <Button
                  key={name}
                  size="sm"
                  variant={hero === name ? undefined : "quiet"}
                  onClick={() => {
                    setHero(name);
                    setCart({ ...EMPTY_CART });
                    setLockpickQty(0);
                    setNote(null);
                  }}
                >
                  {name}
                </Button>
              ))}
            </div>
            <div className="flex flex-col gap-1">
              {POTION_ORDER.map((kind) => {
                const price = POTION_PRICE[kind];
                const have = bag[kind] ?? 0;
                const qty = cart[kind] ?? 0;
                return (
                  <div key={kind} className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5">
                    <img src={ICONS[kind]} alt="" className="size-6 rounded-sm object-cover" />
                    <span className="flex-1 text-sm min-w-0">
                      {potionLabel(kind)}
                      <span className="block text-[11px] text-muted tabular-nums">
                        saco ×{have} · {price} Ember
                      </span>
                    </span>
                    <button type="button" className="size-8 grid place-items-center rounded-md border border-border" onClick={() => add(kind, -1)} disabled={qty <= 0}>
                      −
                    </button>
                    <span className="w-6 text-center text-sm tabular-nums">{qty}</span>
                    <button
                      type="button"
                      className="size-8 grid place-items-center rounded-md border border-border"
                      onClick={() => add(kind, 1)}
                      disabled={have + qty >= POTION_CARRY_MAX[kind]}
                    >
                      +
                    </button>
                  </div>
                );
              })}
              <div className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5">
                <img src="/game/icons/lockpick.png" alt="" className="size-6 rounded-sm object-cover" />
                <span className="flex-1 text-sm min-w-0">
                  Gazua
                  <span className="block text-[11px] text-muted tabular-nums">
                    saco ×{bag.lockpick ?? 0} · {LOCKPICK_PRICE} Ember
                  </span>
                </span>
                <button type="button" className="size-8 grid place-items-center rounded-md border border-border" onClick={() => addLockpick(-1)} disabled={lockpickQty <= 0}>
                  −
                </button>
                <span className="w-6 text-center text-sm tabular-nums">{lockpickQty}</span>
                <button
                  type="button"
                  className="size-8 grid place-items-center rounded-md border border-border"
                  onClick={() => addLockpick(1)}
                  disabled={(bag.lockpick ?? 0) + lockpickQty >= BAG_MAX}
                >
                  +
                </button>
              </div>
            </div>
            <p className={`text-sm tabular-nums ${remain < 0 ? "text-danger" : "text-muted"}`}>
              Conta {total} Ember · restam {remain}
            </p>
            {note && <p className="text-sm text-accent">{note}</p>}
            <div className="flex gap-2">
              <Button className="flex-1" disabled={items <= 0} onClick={pay}>
                Pagar
              </Button>
              <Button variant="quiet" onClick={() => { setCart({ ...EMPTY_CART }); setNote(null); }}>
                Limpar
              </Button>
            </div>
          </div>
        )}
      </div>
      <div className="relative z-10 p-4 pt-0 pb-[max(1rem,env(safe-area-inset-bottom))] max-w-lg mx-auto w-full">
        <Button variant="ghost" className="w-full" onClick={onLeave}>
          <ChevronLeft className="size-4" /> Sair da estalagem
        </Button>
      </div>
      {invView === "pack" && (
        <BackpackScreen heroName={hero} save={save} onClose={() => setInvView(null)} onSwitchToDoll={() => setInvView("doll")} />
      )}
      {invView === "doll" && (
        <PaperDollScreen
          heroName={hero}
          classId={heroClass[hero] ?? "swordsman"}
          save={save}
          onClose={() => setInvView(null)}
          onSwitchToBackpack={() => setInvView("pack")}
          onEquipWeapon={onEquipWeapon}
          onEquipItem={onEquipItem}
        />
      )}
    </section>
  );
}

function SmithPanel({
  ember,
  muted,
  weapons,
  equipped,
  heroClass,
  save,
  onMute,
  onBack,
  onBuyWeapon,
  onEquipWeapon,
  onEquipItem,
  onUpgradeWeapon,
  onSellWeapon,
}: {
  ember: number;
  muted: boolean;
  weapons: Record<string, number>;
  equipped: Record<string, string>;
  heroClass: Record<string, ClassId>;
  save: SaveData;
  onMute: () => void;
  onBack: () => void;
  onBuyWeapon: (hero: string, weaponId: string) => boolean;
  onEquipWeapon: (hero: string, weaponId: string) => void;
  onEquipItem?: (hero: string, slot: EquipSlot, itemId: string) => void;
  onUpgradeWeapon: (weaponId: string) => boolean;
  onSellWeapon: (weaponId: string) => number | false;
}) {
  const [hero, setHero] = useState<string>("Kael");
  const [note, setNote] = useState<string | null>(null);
  const [invView, setInvView] = useState<"doll" | "pack" | null>(null);

  const classId = heroClass[hero];
  const pool = useMemo(() => [...weaponsForClass(classId)].sort((a, b) => weaponPower(a) - weaponPower(b)), [classId]);
  const equippedId = equipped[hero];
  const equippedWeapon = equippedId ? WEAPONS[equippedId] : null;
  const equippedEnh = equippedId ? (weapons[equippedId] ?? 0) : 0;
  const owned = pool.filter((w) => weapons[w.id] != null && w.id !== equippedId);
  const notOwned = pool.filter((w) => weapons[w.id] == null);

  const buy = (weaponId: string) => {
    setNote(null);
    if (!onBuyWeapon(hero, weaponId)) {
      setNote("Vargan recusou. Falta Ember.");
      return;
    }
    setNote(`${WEAPONS[weaponId]!.name} comprada. Equipe no saco quando quiser.`);
  };

  const equip = (weaponId: string) => {
    setNote(null);
    onEquipWeapon(hero, weaponId);
  };

  const upgrade = () => {
    if (!equippedId) return;
    setNote(null);
    if (!onUpgradeWeapon(equippedId)) {
      setNote("Vargan recusou. Falta Ember ou já está no máximo.");
      return;
    }
    setNote(`${equippedWeapon?.name} aprimorada.`);
  };

  const sell = (weaponId: string) => {
    setNote(null);
    const value = onSellWeapon(weaponId);
    if (value === false) return;
    setNote(`${WEAPONS[weaponId]!.name} vendida por ${value} Ember.`);
  };

  const nextEnhCost = equippedEnh < WEAPON_MAX_ENH ? weaponEnhCost(equippedEnh + 1) : null;

  return (
    <section className="relative h-dvh min-h-0 flex flex-col overflow-hidden bg-bg">
      <img src="/game/portraits/vargan.png" alt="" className="absolute inset-0 h-full w-full object-cover" style={{ objectPosition: "34% 42%" }} />
      <div className="absolute inset-0 bg-gradient-to-t from-bg via-bg/85 to-bg/50" />
      <div className="absolute inset-0 bg-gradient-to-r from-transparent via-transparent to-bg/90" />
      <header className="relative z-10 flex items-center gap-3 px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-3">
        <button type="button" onClick={onBack} className="h-10 px-3 rounded-md border border-border bg-bg/70 text-xs uppercase tracking-[0.14em]">
          <ChevronLeft className="size-4 inline -mt-0.5" /> Voltar
        </button>
        <div className="min-w-0 flex-1">
          <p className="text-xs uppercase tracking-[0.18em] text-muted">A forja no porão</p>
          <h1 className="font-display text-2xl leading-none">Vargan, o Ferreiro</h1>
        </div>
        <button
          type="button"
          onClick={() => setInvView("pack")}
          className="h-12 px-3 rounded-md border border-border bg-bg/70 text-xs uppercase tracking-[0.14em] flex items-center gap-2"
        >
          <img src={BAG_ICON} alt="" className="size-8 shrink-0 rounded-sm object-contain" />
          Mochila
        </button>
        <p className="text-sm tabular-nums border border-border bg-bg/70 rounded-md px-2 py-1">Ember {ember}</p>
        <button type="button" onClick={onMute} className="size-10 grid place-items-center rounded-md border border-border bg-bg/70" aria-label="Som">
          {muted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
        </button>
      </header>
      <div className="relative z-10 flex-1 min-h-0 overflow-y-auto p-4 flex flex-col gap-3 max-w-lg ml-auto w-full">
        <div className="rounded-xl border border-border bg-surface/90 p-3">
          <p className="text-sm leading-relaxed text-fg/90">
            “Aço, sangue, alma — tudo é forjado.” Ele não fala mais que isso. Aponta pra bigorna e espera você escolher.
          </p>
        </div>
        <div className="rounded-xl border border-border bg-surface/90 p-3 flex flex-col gap-2">
          <p className="text-xs uppercase tracking-[0.16em] text-muted">Quem empunha</p>
          <div className="flex flex-wrap gap-1">
            {HERO_NAMES.filter((name) => heroRecruited(name, save.completed)).map((name) => (
              <Button
                key={name}
                size="sm"
                variant={hero === name ? undefined : "quiet"}
                onClick={() => {
                  setHero(name);
                  setNote(null);
                }}
              >
                {name}
              </Button>
            ))}
          </div>

          <p className="text-xs uppercase tracking-[0.16em] text-muted mt-2">Equipada</p>
          {equippedWeapon ? (
            <div className="flex items-center gap-2 rounded-md border border-accent px-2 py-1.5">
              <img src={weaponIcon(equippedWeapon.id)} alt="" className="size-10 rounded-sm object-cover" />
              <span className="flex-1 text-sm min-w-0">
                {equippedWeapon.name} {equippedEnh > 0 ? `+${equippedEnh}` : ""}
                <span className="block text-[11px] text-muted tabular-nums">
                  {weaponDiceLabel(equippedWeapon.id)} {equippedEnh > 0 ? `+ ${equippedEnh} aprimoro` : ""} · {weaponRangeLabel(equippedWeapon.id)}
                </span>
              </span>
              <div className="flex flex-col gap-1">
                <Button size="sm" disabled={nextEnhCost == null || ember < nextEnhCost} onClick={upgrade}>
                  {nextEnhCost == null ? "Máx." : `+1 · ${nextEnhCost} Ember`}
                </Button>
                <Button size="sm" variant="quiet" onClick={() => sell(equippedWeapon.id)}>
                  Vender · {weaponSellValue(equippedWeapon.id, equippedEnh)} Ember
                </Button>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted">Nenhuma arma equipada ainda.</p>
          )}

          {owned.length > 0 && (
            <>
              <p className="text-xs uppercase tracking-[0.16em] text-muted mt-2">No saco</p>
              <div className="flex flex-col gap-1">
                {owned.map((w) => (
                  <div key={w.id} className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5">
                    <img src={weaponIcon(w.id)} alt="" className="size-8 rounded-sm object-cover" />
                    <span className="flex-1 text-sm min-w-0">
                      {w.name}
                      <span className="block text-[11px] text-muted tabular-nums">
                        {weaponDiceLabel(w.id)} · {weaponRangeLabel(w.id)}
                      </span>
                      {w.bonusClass && (
                        <span
                          className={`block text-[11px] tabular-nums ${w.bonusClass === classId ? "text-accent" : "text-muted"}`}
                          title={`+10% de dano para a classe ${CLASSES[w.bonusClass].name}`}
                        >
                          +10% dano · {CLASSES[w.bonusClass].name}
                        </span>
                      )}
                    </span>
                    <Button size="sm" variant="quiet" onClick={() => equip(w.id)}>
                      Equipar
                    </Button>
                    <Button size="sm" variant="quiet" onClick={() => sell(w.id)}>
                      Vender · {weaponSellValue(w.id, weapons[w.id] ?? 0)} Ember
                    </Button>
                  </div>
                ))}
              </div>
            </>
          )}

          {notOwned.length > 0 && (
            <>
              <p className="text-xs uppercase tracking-[0.16em] text-muted mt-2">Na bancada</p>
              <div className="flex flex-col gap-1">
                {notOwned.map((w) => (
                  <div key={w.id} className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5">
                    <img src={weaponIcon(w.id)} alt="" className="size-8 rounded-sm object-cover" />
                    <span className="flex-1 text-sm min-w-0">
                      {w.name}
                      <span className="block text-[11px] text-muted tabular-nums">
                        {weaponDiceLabel(w.id)} · {weaponRangeLabel(w.id)} · {w.price} Ember
                      </span>
                      {w.bonusClass && (
                        <span
                          className={`block text-[11px] tabular-nums ${w.bonusClass === classId ? "text-accent" : "text-muted"}`}
                          title={`+10% de dano para a classe ${CLASSES[w.bonusClass].name}`}
                        >
                          +10% dano · {CLASSES[w.bonusClass].name}
                        </span>
                      )}
                    </span>
                    <Button size="sm" disabled={ember < w.price} onClick={() => buy(w.id)}>
                      Comprar
                    </Button>
                  </div>
                ))}
              </div>
            </>
          )}
          {note && <p className="text-sm text-accent">{note}</p>}
        </div>
      </div>
      <div className="relative z-10 p-4 pt-0 pb-[max(1rem,env(safe-area-inset-bottom))] max-w-lg mx-auto w-full">
        <Button variant="ghost" className="w-full" onClick={onBack}>
          <ChevronLeft className="size-4" /> Voltar à estalagem
        </Button>
      </div>
      {invView === "pack" && (
        <BackpackScreen heroName={hero} save={save} onClose={() => setInvView(null)} onSwitchToDoll={() => setInvView("doll")} />
      )}
      {invView === "doll" && (
        <PaperDollScreen
          heroName={hero}
          classId={heroClass[hero] ?? "swordsman"}
          save={save}
          onClose={() => setInvView(null)}
          onSwitchToBackpack={() => setInvView("pack")}
          onEquipWeapon={onEquipWeapon}
          onEquipItem={onEquipItem}
        />
      )}
    </section>
  );
}
