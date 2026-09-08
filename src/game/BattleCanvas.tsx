import { useEffect, useRef } from "react";
import type { BattleEngine } from "./engine";
import type { HudSnapshot } from "./types";

export function BattleCanvas({
  engine,
  onHud,
  paused = false,
  onTileReadout,
}: {
  engine: BattleEngine;
  onHud: (hud: HudSnapshot) => void;
  paused?: boolean;
  /** Fires when the pointer has settled on one tile long enough to be asking about it, so
   * the caller can show what that terrain does. With a mouse that is the cursor resting
   * still; on touch, where there is no hover, it is a press held in place. Called with
   * false as soon as the pointer moves off, lifts, or leaves the canvas. */
  onTileReadout?: (showing: boolean) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const hudKey = useRef("");

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let last = performance.now();
    let running = true;
    let dragging = false;
    let dragged = false;
    let mouseDown = false;
    let lastX = 0;
    let lastY = 0;
    const held = new Set<string>();
    const pointers = new Map<number, { x: number; y: number }>();
    // Press-and-hold on a tile reads out its terrain. It has to coexist with dragging the
    // camera, so the timer is armed on every press and cancelled the moment the pointer
    // travels far enough to count as a pan.
    let holdTimer: number | null = null;
    let holding = false;
    const cancelHold = () => {
      if (holdTimer !== null) {
        window.clearTimeout(holdTimer);
        holdTimer = null;
      }
      if (holding) {
        holding = false;
        onTileReadout?.(false);
      }
    };
    const armReadout = (px: number, py: number, delay: number) => {
      cancelHold();
      if (paused) return;
      holdTimer = window.setTimeout(() => {
        holdTimer = null;
        holding = true;
        engine.pointerMove(px, py); // point the hover at that tile so the HUD describes it
        onTileReadout?.(true);
      }, delay);
    };
    let pinchDist = 0;
    let pinched = false;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      canvas.width = Math.max(1, Math.floor(w * dpr));
      canvas.height = Math.max(1, Math.floor(h * dpr));
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    const loop = (now: number) => {
      if (!running) return;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (!paused) {
        const speed = 520;
        let px = 0;
        let py = 0;
        if (held.has("ArrowLeft") || held.has("KeyA")) px -= 1;
        if (held.has("ArrowRight") || held.has("KeyD")) px += 1;
        if (held.has("ArrowUp") || held.has("KeyW")) py -= 1;
        if (held.has("ArrowDown") || held.has("KeyS")) py += 1;
        if (px || py) {
          const mag = Math.hypot(px, py) || 1;
          engine.panBy((px / mag) * speed * dt, (py / mag) * speed * dt);
        }
        engine.tick(dt);
      }
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      engine.render(ctx, wrap.clientWidth, wrap.clientHeight, dpr);
      const hud = engine.getHud();
      const k = [
        hud.mode,
        hud.phase,
        hud.selected?.id,
        hud.canAttack,
        hud.banner,
        hud.result,
        hud.turn,
        hud.playerAlive,
        hud.enemyAlive,
        hud.forecast?.defender,
        hud.forecast?.dmgOut,
        hud.inspected?.id,
        hud.pendingFoe?.id,
        hud.selected?.hp,
        hud.inspected?.hp,
        hud.selected?.bag.mid,
        hud.selected?.bag.weak,
        hud.selected?.bag.potent,
        hud.selected?.bag.disease,
        hud.tip,
        hud.zoom,
        hud.speedMode,
        hud.winAvailable,
        hud.spellReady,
        hud.turnQueue.find((q) => q.active)?.id,
        hud.turnQueue.map((q) => (q.acted ? "1" : "0")).join(""),
        hud.chestLoot ? `${hud.chestLoot.unitName}:${hud.chestLoot.ember}:${hud.chestLoot.items.map((i) => i.name).join(",")}` : null,
      ].join("|");
      if (k !== hudKey.current) {
        hudKey.current = k;
        onHud(hud);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    const pos = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const onDown = (e: PointerEvent) => {
      if (paused) return;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      const p = pos(e);
      if (e.pointerType === "mouse") {
        if (engine.getHud().mode === "awaitSpell") {
          engine.pointerDown(p.x, p.y, "click");
          return;
        }
        // Deferred to pointerup, same as touch: a held-and-dragged mouse pans the
        // camera (see onMove/onUp) instead of immediately acting on the down-press.
        mouseDown = true;
        dragging = true;
        dragged = false;
        lastX = e.clientX;
        lastY = e.clientY;
        canvas.setPointerCapture(e.pointerId);
        canvas.style.cursor = "grabbing";
        return;
      }
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      canvas.setPointerCapture(e.pointerId);
      if (pointers.size >= 2) {
        const pts = [...pointers.values()];
        pinchDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        pinched = true;
        dragging = false;
        dragged = true;
        return;
      }
      dragging = true;
      dragged = false;
      lastX = e.clientX;
      lastY = e.clientY;
      armReadout(p.x, p.y, 420);
      if (engine.getHud().mode === "awaitSpell") {
        engine.pointerMove(p.x, p.y);
      }
    };
    const onMove = (e: PointerEvent) => {
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size >= 2 && pinchDist > 0) {
        const pts = [...pointers.values()];
        const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        if (d > pinchDist * 1.22) {
          engine.cycleZoom(1);
          pinchDist = d;
        } else if (d < pinchDist * 0.82) {
          engine.cycleZoom(-1);
          pinchDist = d;
        }
        return;
      }
      const p = pos(e);
      const spell = engine.getHud().mode === "awaitSpell";
      // Resting the cursor on a tile asks about it. Every movement restarts the clock, so
      // this only fires once the pointer actually stops — no button involved.
      if (e.pointerType === "mouse" && !mouseDown) armReadout(p.x, p.y, 650);
      if (e.pointerType === "mouse" && mouseDown) {
        const dx = e.clientX - lastX;
        const dy = e.clientY - lastY;
        if (Math.abs(dx) + Math.abs(dy) > 3) {
          dragged = true;
          cancelHold();
        }
        if (dragged) {
          engine.panBy(-dx, -dy);
          lastX = e.clientX;
          lastY = e.clientY;
        }
        return;
      }
      if (dragging && e.pointerType !== "mouse" && !spell) {
        const dx = e.clientX - lastX;
        const dy = e.clientY - lastY;
        if (Math.abs(dx) + Math.abs(dy) > 3) {
          dragged = true;
          cancelHold();
        }
        if (dragged) {
          engine.panBy(-dx, -dy);
          lastX = e.clientX;
          lastY = e.clientY;
        }
      } else {
        if (dragging && e.pointerType !== "mouse" && spell) {
          const dx = e.clientX - lastX;
          const dy = e.clientY - lastY;
          if (Math.abs(dx) + Math.abs(dy) > 10) dragged = true;
        }
        engine.pointerMove(p.x, p.y);
      }
    };
    const onUp = (e: PointerEvent) => {
      const wasHolding = holding;
      cancelHold();
      if (e.pointerType === "mouse") {
        canvas.style.cursor = "";
        if (!mouseDown) return;
        mouseDown = false;
        dragging = false;
        if (!dragged && !paused && !wasHolding) {
          const p = pos(e);
          engine.pointerDown(p.x, p.y, "click");
        }
        dragged = false;
        return;
      }
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinchDist = 0;
      if (pinched) {
        if (pointers.size === 0) pinched = false;
        dragging = false;
        return;
      }
      if (!dragging) return;
      dragging = false;
      if (!dragged && !paused && !wasHolding) {
        const p = pos(e);
        engine.pointerDown(p.x, p.y, "tap");
      }
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      engine.cycleZoom(e.deltaY > 0 ? -1 : 1);
    };
    const onKey = (e: KeyboardEvent) => {
      if (paused) return;
      const trap = [
        "ArrowLeft",
        "ArrowRight",
        "ArrowUp",
        "ArrowDown",
        "Space",
        "Enter",
        "Escape",
        "KeyE",
        "KeyZ",
        "KeyW",
        "KeyA",
        "KeyS",
        "KeyD",
      ];
      if (trap.includes(e.code)) e.preventDefault();
      held.add(e.code);
      if (
        e.code === "ArrowLeft" ||
        e.code === "ArrowRight" ||
        e.code === "ArrowUp" ||
        e.code === "ArrowDown" ||
        e.code === "KeyW" ||
        e.code === "KeyA" ||
        e.code === "KeyS" ||
        e.code === "KeyD"
      ) {
        return;
      }
      engine.keyDown(e.code);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      held.delete(e.code);
    };

    const onMenu = (e: MouseEvent) => {
      e.preventDefault();
      if (paused) return;
      const hud = engine.getHud();
      const showAct =
        hud.mode === "awaitAction" || hud.mode === "awaitAttack" || hud.mode === "selected" || hud.mode === "awaitSpell";
      if (!showAct || hud.busy) return;
      engine.cancel();
    };
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
    canvas.addEventListener("pointerleave", cancelHold);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("contextmenu", onMenu);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      cancelHold();
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointerleave", cancelHold);
      canvas.removeEventListener("pointercancel", onUp);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("contextmenu", onMenu);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [engine, onHud, paused]);

  return (
    <div ref={wrapRef} className="relative h-full w-full min-h-0 touch-none">
      <canvas ref={canvasRef} className="block h-full w-full touch-none" />
    </div>
  );
}
