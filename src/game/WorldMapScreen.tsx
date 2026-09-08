import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Check, ChevronLeft, Lock, MapPin, Volume2, VolumeX, X, ZoomIn, ZoomOut } from "lucide-react";
import { missionsForLocation } from "./mapstore";
import type { Mission, WorldLocation } from "./types";

export type LocationStatus = "locked" | "available" | "done";

/** Three zoom stops, as a percent width of the scroll viewport, ascending from most
 * zoomed-out to most zoomed-in. The map opens at the LAST (biggest) stop — that's as
 * close as it should ever get — and the zoom control only zooms OUT from there to show
 * more of the surrounding map, never further in. */
// Percentages of the viewport width the map image is drawn at. 70 is there so the whole
// map fits on screen at once: the art is square now (it used to be tall and narrow), so
// what used to be the widest view no longer showed all of it.
const ZOOM_STOPS = [70, 90, 110, 130];

/** Campaign world map: one marker per WorldLocation, positioned by its x/y percent over
 * the map art. A single-mission location jumps straight to its briefing on click; a
 * multi-mission location (e.g. an approach, an encounter, and its aftermath sharing one
 * marker) opens a small chapter list instead. Background art is optional — until the real
 * map lands the screen falls back to a plain ashen backdrop so it never looks broken. */
export function WorldMapScreen({
  locations,
  status,
  missionStatus,
  ember,
  test,
  muted,
  onMute,
  autoOpenLocationId,
  centerLocationId,
  onBack,
  onPick,
  onOpenList,
}: {
  locations: WorldLocation[];
  status: (loc: WorldLocation) => LocationStatus;
  missionStatus: (missionId: string) => LocationStatus;
  ember: number;
  test: boolean;
  muted: boolean;
  onMute: () => void;
  /** Set right after finishing a mission that's part of a multi-mission location — pops
   * that location's chapter list straight back open (world map still visible behind it)
   * instead of dropping the player back on the bare map, so a "series of combats" reads
   * as one continuous flow with a chapter picker between each fight. */
  autoOpenLocationId?: string | null;
  /** Which location's marker the map should open scrolled to — the player's current
   * location, not always the geometric center of the art. */
  centerLocationId?: string | null;
  onBack: () => void;
  onPick: (missionId: string) => void;
  onOpenList: () => void;
}) {
  const [open, setOpen] = useState<WorldLocation | null>(null);
  const [artOk, setArtOk] = useState(true);
  const [flashId, setFlashId] = useState<string | null>(null);
  const [zoomIdx, setZoomIdx] = useState(ZOOM_STOPS.length - 1);
  const [dragging, setDragging] = useState(false);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  // Mouse click-and-hold panning (touch already pans natively via the browser's own
  // scroll gesture). Tracked in a ref, not state, so dragging doesn't re-render every
  // pointermove — only the small "moved past the click threshold" flag matters for
  // deciding whether to swallow the click that follows (so dragging over a location
  // marker doesn't also fire its onClick).
  const dragRef = useRef<{ x: number; y: number; scrollLeft: number; scrollTop: number; moved: boolean } | null>(null);
  // Whatever point is currently centered in the viewport, as a 0-1 fraction of the whole
  // image — kept up to date so a zoom change can re-center on the SAME spot instead of
  // jumping back to the image's absolute middle (which is what used to happen: zooming in
  // or out teleported the view away from wherever the player actually was, e.g. off of
  // Stone Bridge and over near the Inn, several screens away).
  const centerFracRef = useRef({ x: 0.5, y: 0.5 });

  const recenterOn = (fx: number, fy: number) => {
    const el = viewportRef.current;
    if (!el) return;
    el.scrollLeft = Math.max(0, Math.min(el.scrollWidth - el.clientWidth, fx * el.scrollWidth - el.clientWidth / 2));
    el.scrollTop = Math.max(0, Math.min(el.scrollHeight - el.clientHeight, fy * el.scrollHeight - el.clientHeight / 2));
  };
  // Reads whatever the viewport is actually showing right now (however it got there —
  // drag, native touch scroll, a previous zoom) so the next zoom change can anchor back on
  // it instead of the ref only ever reflecting the last programmatic recenter.
  const captureCenterFrac = () => {
    const el = viewportRef.current;
    if (!el || el.scrollWidth === 0 || el.scrollHeight === 0) return;
    centerFracRef.current = {
      x: (el.scrollLeft + el.clientWidth / 2) / el.scrollWidth,
      y: (el.scrollTop + el.clientHeight / 2) / el.scrollHeight,
    };
  };

  // Re-center on every zoom change so it lands back on the same spot at the new size,
  // instead of the image's fixed midpoint. Skipped on the very first render (zoomIdx
  // hasn't actually changed yet) — the mount effect below handles the opening position.
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) return;
    recenterOn(centerFracRef.current.x, centerFracRef.current.y);
    // recenterOn reads refs only, not reactive state — safe to omit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomIdx]);

  // Runs once, after mount, so it wins as the screen's actual opening scroll position:
  // centers on the player's current location instead of the art's literal center, so the
  // map opens already looking at wherever they are in the campaign. Also seeds the "current
  // center" ref so later zoom changes anchor on this location too, not 50/50.
  useEffect(() => {
    const loc = centerLocationId ? locations.find((l) => l.id === centerLocationId) : null;
    if (loc) {
      centerFracRef.current = { x: loc.x / 100, y: loc.y / 100 };
      recenterOn(centerFracRef.current.x, centerFracRef.current.y);
    }
    mounted.current = true;
    // Deliberately mount-only — re-centering on every render (or every zoom change) would
    // fight the player's own panning.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-reopens a location's chapter list right after finishing one of its missions, so a
  // multi-mission location plays as a continuous "series of combats" with the list as the
  // between-fights beat, not a detour back through the bare map.
  useEffect(() => {
    if (!autoOpenLocationId) return;
    const loc = locations.find((l) => l.id === autoOpenLocationId);
    if (loc) setOpen(loc);
  }, [autoOpenLocationId, locations]);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "touch") return; // native touch scroll already handles this
    const el = viewportRef.current;
    if (!el) return;
    dragRef.current = { x: e.clientX, y: e.clientY, scrollLeft: el.scrollLeft, scrollTop: el.scrollTop, moved: false };
    setDragging(true);
    // Pointer capture is deliberately NOT taken here — capturing on every mousedown
    // redirects the matching pointerup (and the mouseup derived from it) to this div
    // instead of whatever was actually under the cursor, so a plain click on a location
    // marker never reaches its own onClick and silently does nothing. Capture is instead
    // grabbed lazily in onPointerMove, only once an actual drag is confirmed.
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    const el = viewportRef.current;
    if (!d || !el) return;
    // The button can go up without any pointerup/click ever reaching this element — e.g.
    // releasing outside the browser window — which used to leave dragRef.current alive
    // forever, so plain mouse hover (no button held) kept panning the map afterward. If the
    // primary button isn't actually down anymore, drop the drag right here instead of
    // relying solely on onPointerUp/onClickCapture to clean up.
    if (e.pointerType === "mouse" && e.buttons === 0) {
      dragRef.current = null;
      setDragging(false);
      return;
    }
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
      d.moved = true;
      el.setPointerCapture(e.pointerId);
    }
    if (!d.moved) return;
    el.scrollLeft = d.scrollLeft - dx;
    el.scrollTop = d.scrollTop - dy;
  };
  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = viewportRef.current;
    if (el?.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    // Keep the ref (with its .moved flag) alive past pointerup — the click event that
    // follows a drag fires just after, and onClickCapture below needs to see it. The next
    // pointerdown always overwrites it with a fresh object either way.
    setDragging(false);
  };
  // Swallow the click a drag ends on (capture phase, before it reaches a location marker's
  // own onClick) so panning across a marker never also "clicks" it.
  const onClickCapture = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (dragRef.current?.moved) {
      e.preventDefault();
      e.stopPropagation();
      dragRef.current = null;
    }
  };

  return (
    <section className="relative h-dvh min-h-0 flex flex-col overflow-hidden bg-bg">
      <div
        className="absolute inset-0"
        style={{ background: "radial-gradient(ellipse at 30% 20%, #241f19 0%, #0c0b0a 70%)" }}
      />

      <header className="relative z-10 flex items-center gap-3 px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-4">
        <button type="button" onClick={onBack} className="size-10 grid place-items-center rounded-md border border-border bg-bg/70" aria-label="Voltar">
          <ChevronLeft className="size-5" />
        </button>
        <div className="flex-1 min-w-0">
          <p className="text-sm uppercase tracking-[0.18em] text-muted">{test ? "Modo teste" : "Campanha"}</p>
          <h1 className="font-display text-3xl leading-none">Mapa</h1>
        </div>
        <button type="button" onClick={onOpenList} className="h-9 px-3 rounded-md border border-border bg-bg/70 text-xs uppercase tracking-[0.14em]">
          Lista
        </button>
        <button type="button" onClick={onMute} className="size-9 grid place-items-center rounded-md border border-border bg-bg/70" aria-label="Som">
          {muted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
        </button>
        <p className="text-sm tabular-nums text-muted border border-border rounded-md px-2 py-1 bg-bg/70">Ember {ember}</p>
      </header>

      {/* A real scroll viewport (not shrink-to-fit) — the map renders at ZOOM_STOPS[zoomIdx]%
       * of this container's width and pans/scrolls natively (touch included) whenever it
       * overflows, which at every zoom stop it does on a phone. The inner wrapper still
       * sizes itself exactly to the image's own on-screen box (width set, height auto), so
       * percent-based marker coordinates land correctly at any zoom level. */}
      <div
        ref={viewportRef}
        className={`relative z-10 flex-1 min-h-0 overflow-auto overscroll-contain touch-pan-x touch-pan-y select-none ${dragging ? "cursor-grabbing" : "cursor-grab"}`}
        style={{ WebkitOverflowScrolling: "touch" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={endDrag}
        onClickCapture={onClickCapture}
      >
        <div className="relative inline-block m-2" style={{ width: artOk ? `${ZOOM_STOPS[zoomIdx]}%` : undefined }}>
          {artOk ? (
            <img
              src="/game/assets/world-map.jpg"
              alt=""
              className="block w-full h-auto rounded-lg select-none"
              draggable={false}
              onError={() => setArtOk(false)}
              // The mount-time centering effect below fires before this image has actually
              // finished loading — with no intrinsic size yet, the viewport's scrollHeight
              // is still near zero at that moment, so recenterOn's own clamp forces the
              // scroll position back to (0, 0) regardless of which location it targeted.
              // Once the image loads and the container snaps to its real size, nothing
              // re-centers it — the map just sits wherever that early clamp left it, which
              // reads as "opens somewhere random" rather than "opens on your location."
              // Re-centering here, once real dimensions exist, fixes that; it's a no-op if
              // the mount effect already landed correctly (same target fraction either way).
              onLoad={() => recenterOn(centerFracRef.current.x, centerFracRef.current.y)}
            />
          ) : (
            <div className="w-[70dvw] h-[70dvh] max-w-md" />
          )}
          <div className="absolute inset-0">
            {locations.map((loc) => {
              const st = status(loc);
              const missions = missionsForLocation(loc);
              const multi = missions.length > 1;
              return (
                <button
                  key={loc.id}
                  type="button"
                  onClick={() => {
                    if (st === "locked") {
                      setFlashId(loc.id);
                      window.setTimeout(() => setFlashId((f) => (f === loc.id ? null : f)), 500);
                      return;
                    }
                    if (multi) {
                      setOpen(loc);
                      return;
                    }
                    if (missions[0]) onPick(missions[0].id);
                  }}
                  className="group absolute -translate-x-1/2 -translate-y-1/2"
                  style={{ left: `${loc.x}%`, top: `${loc.y}%` }}
                  aria-label={st === "locked" ? `${loc.name} (bloqueado)` : loc.name}
                >
                  <span
                    className={`relative size-10 rounded-full border-2 grid place-items-center bg-bg/80 transition-transform group-hover:scale-110 group-active:scale-95 ${
                      st === "locked"
                        ? `border-border opacity-50 ${loc.id === flashId ? "locked-flash" : ""}`
                        : st === "done"
                          ? "border-accent"
                          : missions.some((m) => m.hub)
                            ? "inn-open"
                            : "border-accent"
                    }`}
                  >
                    {st === "locked" ? (
                      <Lock className="size-4 text-muted" />
                    ) : st === "done" ? (
                      <Check className="size-4 text-accent" />
                    ) : (
                      <MapPin className="size-4 text-accent" />
                    )}
                    {multi && (
                      <span className="absolute -top-1.5 -right-1.5 size-4 rounded-full bg-bg border border-border text-[10px] leading-none grid place-items-center text-fg/90">
                        {missions.length}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {artOk && (
        <div className="absolute z-20 bottom-[max(1rem,env(safe-area-inset-bottom))] right-4 flex flex-col gap-1 bg-bg/85 border border-border rounded-lg p-1">
          <button
            type="button"
            onClick={() => {
              captureCenterFrac();
              setZoomIdx((i) => Math.min(ZOOM_STOPS.length - 1, i + 1));
            }}
            disabled={zoomIdx >= ZOOM_STOPS.length - 1}
            className="size-11 grid place-items-center rounded-md disabled:opacity-30 active:bg-surface-2"
            aria-label="Aproximar"
          >
            <ZoomIn className="size-5" />
          </button>
          {/* Counted from the wide end: 4 is the whole map on screen, 1 is closest in.
              ZOOM_STOPS itself stays in ascending width order, which is what the buttons
              step through — this is only how the step is labelled. */}
          <div className="text-center text-[10px] tabular-nums text-muted py-0.5">
            {ZOOM_STOPS.length - zoomIdx}/{ZOOM_STOPS.length}
          </div>
          <button
            type="button"
            onClick={() => {
              captureCenterFrac();
              setZoomIdx((i) => Math.max(0, i - 1));
            }}
            disabled={zoomIdx <= 0}
            className="size-11 grid place-items-center rounded-md disabled:opacity-30 active:bg-surface-2"
            aria-label="Afastar"
          >
            <ZoomOut className="size-5" />
          </button>
        </div>
      )}

      {open && (
        <LocationPanel
          location={open}
          missions={missionsForLocation(open)}
          missionStatus={missionStatus}
          test={test}
          onPick={(id) => {
            setOpen(null);
            onPick(id);
          }}
          onClose={() => setOpen(null)}
        />
      )}
    </section>
  );
}

function LocationPanel({
  location,
  missions,
  missionStatus,
  test,
  onPick,
  onClose,
}: {
  location: WorldLocation;
  missions: Mission[];
  missionStatus: (missionId: string) => LocationStatus;
  test: boolean;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const [flashId, setFlashId] = useState<string | null>(null);
  return (
    <div
      className="absolute inset-0 z-40 bg-bg/45 backdrop-blur-[3px] flex items-center justify-center p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md max-h-[80dvh] overflow-y-auto bg-surface/95 border border-border rounded-xl p-5">
        <div className="flex items-start justify-between gap-3 mb-4">
          <p className="font-display text-xl leading-tight">{location.name}</p>
          <button type="button" onClick={onClose} className="size-8 grid place-items-center rounded-md border border-border" aria-label="Fechar">
            <X className="size-4" />
          </button>
        </div>
        <ol className="flex flex-col gap-2">
          {missions.map((m, i) => {
            const st = missionStatus(m.id);
            return (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => {
                    if (st === "locked") {
                      setFlashId(m.id);
                      window.setTimeout(() => setFlashId((f) => (f === m.id ? null : f)), 500);
                      return;
                    }
                    onPick(m.id);
                  }}
                  aria-label={st === "locked" ? `${m.title} (bloqueado)` : undefined}
                  className={`w-full text-left rounded-xl border bg-surface px-4 py-3 ${
                    st === "locked" ? `opacity-40 border-border ${m.id === flashId ? "locked-flash" : ""}` : "border-border"
                  }`}
                >
                  <p className="text-sm uppercase tracking-[0.16em] text-muted flex items-center gap-1.5">
                    {st === "locked" && <Lock className="size-3" />}
                    {st === "done" && <Check className="size-3 text-accent" />}
                    {String(m.index + 1).padStart(2, "0")} · {m.place}
                    {st === "done" ? " · feito" : ""}
                  </p>
                  <p className="font-display text-2xl">{m.title}</p>
                  <p className="text-base text-muted">{m.objective}</p>
                </button>
              </li>
            );
          })}
        </ol>
        {test && <p className="mt-3 text-xs text-muted">Modo teste: todos os capítulos estão abertos.</p>}
      </div>
    </div>
  );
}
