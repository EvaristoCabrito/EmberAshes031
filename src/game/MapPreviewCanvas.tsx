import { type PointerEvent, useEffect, useRef, useState } from "react";
import { BattleEngine } from "./engine";
import type { GameArt, Mission } from "./types";

// The technical map is a native scroll surface; keep preview scrollbar travel deliberately gentler.
const PREVIEW_SCROLL_PAN_RATE = 0.45;

/** A read-only window onto the map exactly as the real battle would render it — same tile
 * art, same decoration art, same unit sprites — instead of the paint grid's flat color
 * swatches. Builds a throwaway BattleEngine from the current draft and only ever calls its
 * render(), never tick(): no animation loop, no AI, no turns — just a live snapshot that
 * redraws whenever the mission prop changes (the caller debounces that) or the panel resizes.
 * A left click can use the current editor brush directly; gameplay state remains untouched. */
export function MapPreviewCanvas({ mission, art, onCellClick, selectedDecorationId }: { mission: Mission; art: GameArt; onCellClick?: (x: number, y: number) => void; selectedDecorationId?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<BattleEngine | null>(null);
  const redrawRef = useRef<(() => void) | null>(null);
  const dragRef = useRef<{ pointerId: number; x: number; y: number; startX: number; startY: number; armed: boolean; moved: boolean } | null>(null);
  const cameraRef = useRef<{ x: number; y: number } | null>(null);
  const verticalScrollTopRef = useRef(0);
  const horizontalScrollLeftRef = useRef(0);
  const verticalScrollInitializedRef = useRef(false);
  const armTimerRef = useRef<number | null>(null);
  const [zoom, setZoom] = useState(1);
  const [isPanning, setIsPanning] = useState(false);
  // Same board width used by the technical map. The scroll surface only becomes wider
  // when this real board is wider than its window, so the horizontal bar is not permanent.
  const previewTileRadius = zoom < 1.125 ? 34 : zoom < 1.375 ? 50 : 72;
  const previewBoardWidth = Math.ceil(previewTileRadius * Math.sqrt(3) * (mission.cols + 0.5));

  useEffect(() => {
    const canvas = canvasRef.current;
    const viewport = viewportRef.current;
    if (!canvas || !viewport) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let engine: BattleEngine;
    try {
      engine = new BattleEngine(mission, art, { hp: {}, levels: {} }, 1);
      // Keep the canvas the size of the window. The BattleEngine owns the real
      // camera, so dragging moves the board rather than an oversized empty canvas.
      engine.setZoom(Math.max(1, Math.min(3, Math.round((zoom - 0.75) * 4))));
      engineRef.current = engine;
    } catch {
      return;
    }
    let needsCameraRestore = cameraRef.current !== null;

    const draw = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.floor(viewport.clientWidth));
      const h = Math.max(1, Math.floor(viewport.clientHeight));
      if (w <= 0 || h <= 0) return;
      canvas.width = Math.max(1, Math.floor(w * dpr));
      canvas.height = Math.max(1, Math.floor(h * dpr));
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      engine.render(ctx, w, h, dpr);
      if (needsCameraRestore) {
        const savedCamera = cameraRef.current;
        if (savedCamera) {
          engine.restoreCamera(savedCamera);
          engine.render(ctx, w, h, dpr);
        }
        needsCameraRestore = false;
      }
      if (selectedDecorationId) engine.drawDecorationHighlight(ctx, selectedDecorationId);
    };

    redrawRef.current = draw;
    draw();
    if (!verticalScrollInitializedRef.current) {
      requestAnimationFrame(() => {
        const centeredTop = Math.round(Math.max(0, viewport.scrollHeight - viewport.clientHeight) / 2);
        const centeredLeft = Math.round(Math.max(0, viewport.scrollWidth - viewport.clientWidth) / 2);
        verticalScrollTopRef.current = centeredTop;
        horizontalScrollLeftRef.current = centeredLeft;
        viewport.scrollTop = centeredTop;
        viewport.scrollLeft = centeredLeft;
        verticalScrollInitializedRef.current = true;
      });
    }
    const ro = new ResizeObserver(draw);
    ro.observe(viewport);
    return () => {
      ro.disconnect();
      cameraRef.current = engine.cameraPosition();
      if (engineRef.current === engine) engineRef.current = null;
      if (redrawRef.current === draw) redrawRef.current = null;
    };
  }, [mission, art, onCellClick, selectedDecorationId, zoom]);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    dragRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      startX: event.clientX,
      startY: event.clientY,
      armed: false,
      moved: false,
    };
    viewport.setPointerCapture(event.pointerId);
    armTimerRef.current = window.setTimeout(() => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      drag.armed = true;
      // The hand is the immediate confirmation that the hold-to-pan gesture is ready.
      setIsPanning(true);
    }, 1000);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const viewport = viewportRef.current;
    const drag = dragRef.current;
    if (!viewport || !drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    // The brush owns normal clicks and drags. Pan begins only after the hold
    // timer arms it, then a real movement, so it can never auto-activate.
    if (!drag.moved) {
      const movedFarEnough = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) >= 6;
      if (drag.armed && movedFarEnough) {
        drag.moved = true;
      }
    }
    if (drag.moved) {
      engineRef.current?.panBy(-dx, -dy);
      redrawRef.current?.();
    }
    drag.x = event.clientX;
    drag.y = event.clientY;
  };

  const endDrag = (event: PointerEvent<HTMLDivElement>, cancelled = false) => {
    const viewport = viewportRef.current;
    const drag = dragRef.current;
    if (!viewport || !drag || drag.pointerId !== event.pointerId) return;
    if (armTimerRef.current !== null) {
      window.clearTimeout(armTimerRef.current);
      armTimerRef.current = null;
    }
    // Handle painting here, from the same pointer sequence that owns pan. This
    // avoids browser click synthesis getting lost when the wrapper has capture.
    if (!cancelled && !drag.moved && event.button === 0 && onCellClick) {
      const canvas = canvasRef.current;
      const engine = engineRef.current;
      if (canvas && engine) {
        const rect = canvas.getBoundingClientRect();
        const cell = engine.cellAt(event.clientX - rect.left, event.clientY - rect.top);
        if (cell) onCellClick(cell.x, cell.y);
      }
    }
    if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
    dragRef.current = null;
    setIsPanning(false);
  };

  const onViewportScroll = () => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const deltaY = viewport.scrollTop - verticalScrollTopRef.current;
    const deltaX = viewport.scrollLeft - horizontalScrollLeftRef.current;
    verticalScrollTopRef.current = viewport.scrollTop;
    horizontalScrollLeftRef.current = viewport.scrollLeft;
    if (!deltaX && !deltaY) return;
    engineRef.current?.panBy(deltaX * PREVIEW_SCROLL_PAN_RATE, deltaY * PREVIEW_SCROLL_PAN_RATE);
    redrawRef.current?.();
  };

  return (
    <div className="relative h-full w-full overflow-hidden bg-black">
      <div className="absolute right-2 top-2 z-10 flex overflow-hidden rounded border border-border bg-surface shadow-md">
        <button
          type="button"
          className="h-7 w-7 text-base text-fg hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
          aria-label="Diminuir zoom da prévia"
          title="Diminuir zoom"
          disabled={zoom <= 1}
          onClick={() => setZoom((value) => Math.max(1, Number((value - 0.25).toFixed(2))))}
        >
          −
        </button>
        <button
          type="button"
          className="min-w-12 border-x border-border px-1 text-[10px] font-semibold text-fg hover:bg-surface-2"
          aria-label="Restaurar zoom da prévia"
          title="Restaurar zoom"
          onClick={() => setZoom(1)}
        >
          {Math.round(zoom * 100)}%
        </button>
        <button
          type="button"
          className="h-7 w-7 text-base text-fg hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
          aria-label="Aumentar zoom da prévia"
          title="Aumentar zoom"
          disabled={zoom >= 2.5}
          onClick={() => setZoom((value) => Math.min(2.5, Number((value + 0.25).toFixed(2))))}
        >
          +
        </button>
      </div>
      <div className="pointer-events-none absolute bottom-2 right-2 z-10 rounded border border-border/70 bg-surface/90 px-2 py-1 text-[10px] text-muted shadow-sm">
        Clique pinta · segure e arraste para mover
      </div>
      <div
        ref={viewportRef}
        className={`h-full w-full bg-black overflow-x-auto overflow-y-scroll [&::-webkit-scrollbar]:h-3 [&::-webkit-scrollbar]:w-3 [&::-webkit-scrollbar-track]:bg-bg/60 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border ${isPanning ? "cursor-grabbing" : "cursor-default"}`}
        style={{ scrollbarWidth: "auto", scrollbarColor: "var(--color-border, #5a5a5a) transparent", scrollbarGutter: "stable both-edges" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={(event) => endDrag(event, true)}
        onLostPointerCapture={(event) => endDrag(event, true)}
        onScroll={onViewportScroll}
      >
        <div className="min-h-[300%]" style={{ width: `max(100%, ${previewBoardWidth}px)` }}>
          <canvas ref={canvasRef} className="sticky left-0 top-0 block" />
        </div>
      </div>
    </div>
  );
}
