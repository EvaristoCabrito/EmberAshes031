let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let sfx: GainNode | null = null;
let music: GainNode | null = null;
let muted = false;
let musicTimer = 0;
let htmlPrime: HTMLAudioElement | null = null;
let retryTimer = 0;
const htmlUrls: Record<string, string> = {};

if (typeof window !== "undefined") {
  const g = window as Window & { __brasaMusic?: number };
  if (g.__brasaMusic) {
    clearInterval(g.__brasaMusic);
    g.__brasaMusic = 0;
  }
}

function wavTone(freq: number, dur: number, volume: number, kind: "sine" | "square" | "noise" = "sine"): string {
  const key = `${kind}:${freq}:${dur}:${volume}`;
  if (htmlUrls[key]) return htmlUrls[key];
  const sr = 22050;
  const n = Math.max(2, Math.floor(sr * dur));
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / (sr * 0.012)) * Math.min(1, (n - i) / (sr * 0.05));
    let s: number;
    if (kind === "noise") s = Math.random() * 2 - 1;
    else if (kind === "square") s = Math.sin((2 * Math.PI * freq * i) / sr) > 0 ? 1 : -1;
    else s = Math.sin((2 * Math.PI * freq * i) / sr);
    pcm[i] = (s * env * volume * 32767) | 0;
  }
  const bytes = new ArrayBuffer(44 + n * 2);
  const v = new DataView(bytes);
  const ascii = (o: number, t: string) => {
    for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i));
  };
  ascii(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ascii(36, "data");
  v.setUint32(40, n * 2, true);
  new Uint8Array(bytes, 44).set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
  const url = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
  htmlUrls[key] = url;
  return url;
}

function playHtml(url: string, volume = 0.7): void {
  if (muted || typeof Audio === "undefined") return;
  const a = new Audio(url);
  a.volume = Math.min(1, volume);
  void a.play().catch(() => {});
}

function ac(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const C = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!C) return null;
    ctx = new C({ latencyHint: "interactive" });
    master = ctx.createGain();
    sfx = ctx.createGain();
    music = ctx.createGain();
    sfx.gain.value = 1;
    music.gain.value = 0.35;
    sfx.connect(master);
    music.connect(master);
    master.connect(ctx.destination);
    master.gain.value = muted ? 0 : 1;
  }
  return ctx;
}

function silentTick(c: AudioContext): void {
  const buf = c.createBuffer(1, 1, c.sampleRate);
  const src = c.createBufferSource();
  src.buffer = buf;
  src.connect(c.destination);
  try {
    src.start(0);
  } catch {
    // ignore
  }
}

function htmlUnlock(): void {
  if (typeof Audio === "undefined") return;
  if (!htmlPrime) {
    htmlPrime = new Audio(wavTone(440, 0.04, 0.0008));
    htmlPrime.volume = 0.01;
  }
  htmlPrime.currentTime = 0;
  void htmlPrime.play().catch(() => {});
}

export function unlockAudio(): void {
  htmlUnlock();
  const c = ac();
  if (!c) return;
  if (c.state === "suspended") {
    void c.resume().then(() => {
      if (ctx && ctx.state === "running") silentTick(ctx);
    });
  }
  silentTick(c);
}

export function setMuted(next: boolean): void {
  muted = next;
  if (master && ctx) {
    master.gain.setTargetAtTime(next ? 0 : 1, ctx.currentTime, 0.02);
  }
  if (!next) {
    unlockAudio();
  } else {
    stopMusic();
  }
}

export function isMuted(): boolean {
  return muted;
}

function beep(freq: number, dur: number, type: OscillatorType, gain = 0.22, slide = 0): void {
  if (muted) return;
  const c = ac();
  if (!c || c.state !== "running") {
    playHtml(wavTone(freq, dur, Math.min(0.9, gain * 2.4), type === "square" ? "square" : "sine"), Math.min(1, gain * 3));
    if (c && c.state === "suspended") void c.resume();
    return;
  }
  if (!sfx) return;
  const t0 = c.currentTime;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g);
  g.connect(sfx);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

function noise(dur: number, gain = 0.22): void {
  if (muted) return;
  const c = ac();
  if (!c || c.state !== "running") {
    playHtml(wavTone(180, dur, Math.min(0.8, gain * 2), "noise"), Math.min(1, gain * 2.5));
    if (c && c.state === "suspended") void c.resume();
    return;
  }
  if (!sfx) return;
  const n = c.createBuffer(1, Math.floor(c.sampleRate * dur), c.sampleRate);
  const data = n.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const src = c.createBufferSource();
  src.buffer = n;
  const g = c.createGain();
  const t0 = c.currentTime;
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  const f = c.createBiquadFilter();
  f.type = "bandpass";
  f.frequency.value = 1800;
  src.connect(f);
  f.connect(g);
  g.connect(sfx);
  src.start(t0);
  src.stop(t0 + dur + 0.02);
}

/** One-shot effect from a file in public/game/MUSIC/SoundFX, layered over whatever music or
 * synthesised beep is already playing rather than replacing it — unlike playFile, this never
 * touches the theme/track elements, so it can't interrupt them. A fresh Audio() per call: the
 * previous play is left to finish on its own instead of being cut short by the next one. */
function playSfxFile(file: string, volume = 0.55): void {
  if (muted || typeof Audio === "undefined") return;
  const el = new Audio(`/game/MUSIC/SoundFX/${file}`);
  el.volume = volume;
  el.play().catch(() => {});
}

export const sfxPlay = {
  select: () => beep(520, 0.08, "triangle", 0.22),
  move: () => beep(180, 0.1, "sine", 0.2, -40),
  ui: () => beep(640, 0.07, "square", 0.18),
  hit: () => {
    noise(0.1, 0.28);
    beep(140, 0.14, "sawtooth", 0.22, -80);
  },
  crit: () => {
    noise(0.14, 0.32);
    beep(320, 0.18, "square", 0.22, 80);
  },
  death: () => beep(90, 0.4, "sawtooth", 0.24, -50),
  turn: () => beep(300, 0.2, "triangle", 0.2, 120),
  win: () => {
    beep(392, 0.18, "triangle", 0.22);
    setTimeout(() => beep(523, 0.22, "triangle", 0.22), 140);
    setTimeout(() => beep(659, 0.4, "triangle", 0.24), 280);
  },
  lose: () => beep(196, 0.5, "sine", 0.24, -80),
  spell: () => {
    beep(440, 0.14, "sine", 0.18, 220);
    beep(660, 0.18, "triangle", 0.14, 300);
  },
  heal: () => {
    beep(523, 0.14, "sine", 0.16, 90);
    setTimeout(() => beep(784, 0.2, "sine", 0.15, 60), 90);
  },
  stun: () => {
    noise(0.07, 0.2);
    beep(210, 0.24, "square", 0.18, -160);
  },
  chest: () => {
    beep(700, 0.05, "square", 0.14);
    setTimeout(() => beep(920, 0.09, "triangle", 0.18, 220), 60);
  },
  loot: () => {
    beep(880, 0.06, "triangle", 0.2);
    setTimeout(() => beep(1180, 0.09, "triangle", 0.18), 70);
  },
  thrust: () => {
    noise(0.05, 0.16);
    beep(260, 0.09, "sawtooth", 0.2, 260);
  },
  sweep: () => {
    beep(180, 0.16, "sawtooth", 0.2, 90);
    noise(0.12, 0.22);
  },
  trip: () => {
    noise(0.09, 0.24);
    beep(160, 0.2, "square", 0.2, -140);
    setTimeout(() => beep(90, 0.18, "sawtooth", 0.18, -60), 90);
  },
  levelUp: () => playSfxFile("LevelUp.mp3", 0.6),
};

let introEl: HTMLAudioElement | null = null;
let battleEl: HTMLAudioElement | null = null;
let earlyEl: HTMLAudioElement | null = null;
let templeEl: HTMLAudioElement | null = null;
let aldeiaEl: HTMLAudioElement | null = null;
let siegeEl: HTMLAudioElement | null = null;
let innEl: HTMLAudioElement | null = null;
let hillEl: HTMLAudioElement | null = null;
let portaoEl: HTMLAudioElement | null = null;
let worldMapEl: HTMLAudioElement | null = null;
type Theme = "intro" | "battle" | "early" | "temple" | "aldeia" | "siege" | "inn" | "hill" | "portao" | "worldMap";
let currentTheme: Theme = "intro";

if (typeof window !== "undefined") {
  const g = window as Window & { __emberIntro?: HTMLAudioElement };
  if (g.__emberIntro) introEl = g.__emberIntro;
}

function attachTrack(el: HTMLAudioElement, volume: number): HTMLAudioElement {
  el.loop = true;
  el.preload = "auto";
  el.volume = volume;
  if (typeof document !== "undefined" && document.body && !el.isConnected) {
    el.setAttribute("playsinline", "");
    document.body.appendChild(el);
  }
  return el;
}

function getTrack(theme: Theme): HTMLAudioElement | null {
  if (typeof Audio === "undefined") return null;
  if (theme === "intro") return menuElement();
  if (theme === "temple") {
    if (!templeEl) templeEl = attachTrack(new Audio("/game/MUSIC/temple.mp3"), 0.42);
    return templeEl;
  }
  if (theme === "aldeia") {
    if (!aldeiaEl) aldeiaEl = attachTrack(new Audio("/game/MUSIC/aldeia.mp3?v=2"), 0.4);
    return aldeiaEl;
  }
  if (theme === "siege") {
    if (!siegeEl) siegeEl = attachTrack(new Audio("/game/MUSIC/siege.mp3"), 0.4);
    return siegeEl;
  }
  if (theme === "inn") {
    if (!innEl) innEl = attachTrack(new Audio("/game/MUSIC/inn.mp3"), 0.4);
    return innEl;
  }
  if (theme === "hill") {
    if (!hillEl) hillEl = attachTrack(new Audio("/game/MUSIC/hill.mp3"), 0.4);
    return hillEl;
  }
  if (theme === "portao") {
    if (!portaoEl) portaoEl = attachTrack(new Audio("/game/MUSIC/portao.mp3"), 0.4);
    return portaoEl;
  }
  if (theme === "early") {
    if (!earlyEl) earlyEl = attachTrack(new Audio("/game/MUSIC/early.mp3"), 0.4);
    return earlyEl;
  }
  if (theme === "worldMap") {
    // The world map's own piece, under the name it was delivered as. Encoded because that
    // name carries spaces.
    if (!worldMapEl)
      worldMapEl = attachTrack(new Audio(`/game/MUSIC/${encodeURIComponent("Tragic Architecture True Persona-WorldMap-Balanced-High.mp3")}`), 0.4);
    return worldMapEl;
  }
  // The battle theme's own track, recovered from an earlier build's output where it was the
  // only copy left — it had gone missing from public/game/MUSIC while the code still asked
  // for it, which is why nothing played here.
  if (!battleEl) battleEl = attachTrack(new Audio("/game/MUSIC/music.mp3"), 0.4);
  return battleEl;
}

function menuElement(): HTMLAudioElement | null {
  if (typeof Audio === "undefined") return null;
  if (typeof document !== "undefined") {
    document.querySelectorAll("audio").forEach((node) => {
      if (node === introEl) return;
      if (node.id === "ember-intro" || /\/game\/music\/intro\.(wav|mp3)/.test(node.src)) {
        node.pause();
        node.remove();
      }
    });
  }
  if (introEl) return introEl;
  const node = new Audio("/game/MUSIC/intro.mp3");
  node.id = "ember-intro";
  node.loop = true;
  node.preload = "auto";
  node.volume = 0.7;
  if (typeof document !== "undefined" && document.body) {
    node.setAttribute("playsinline", "");
    document.body.appendChild(node);
  }
  introEl = node;
  if (typeof window !== "undefined") {
    (window as Window & { __emberIntro?: HTMLAudioElement }).__emberIntro = node;
  }
  return node;
}

function kickPlay(el: HTMLAudioElement): void {
  if (muted) return;
  if (!el.paused && !el.ended) return;
  el.muted = false;
  el.defaultMuted = false;
  el.volume = el === introEl ? 0.7 : el === templeEl ? 0.42 : 0.4;
  const tryOnce = () => {
    if (muted) return;
    if (!el.paused && !el.ended) {
      if (retryTimer) {
        clearInterval(retryTimer);
        retryTimer = 0;
      }
      return;
    }
    void el.play().then(() => {
      if (retryTimer) {
        clearInterval(retryTimer);
        retryTimer = 0;
      }
    }).catch(() => {
      if (muted || retryTimer) return;
      retryTimer = window.setInterval(() => {
        if (muted) return;
        const want = currentTheme === "intro" ? menuElement() : getTrack(currentTheme);
        if (!want || (!want.paused && !want.ended)) {
          if (retryTimer) {
            clearInterval(retryTimer);
            retryTimer = 0;
          }
          return;
        }
        void want.play().then(() => {
          if (retryTimer) {
            clearInterval(retryTimer);
            retryTimer = 0;
          }
        }).catch(() => {});
      }, 400);
    });
  };
  tryOnce();
}

/** Tracks played by file name rather than by theme — what a mission's own music setting
 * asks for. One element per file, made once and kept, same as the fixed themes. */
const fileEls = new Map<string, HTMLAudioElement>();

function getFileTrack(file: string): HTMLAudioElement | null {
  if (typeof Audio === "undefined") return null;
  const have = fileEls.get(file);
  if (have) return have;
  const el = attachTrack(new Audio(`/game/MUSIC/${encodeURIComponent(file)}`), 0.4);
  fileEls.set(file, el);
  return el;
}

/** Plays one specific file from public/game/MUSIC, silencing everything else — the escape
 * hatch from the fixed Theme list, so a mission can name its own track. */
export function playFile(file: string): void {
  if (muted) return;
  const want = getFileTrack(file);
  silenceAllBut(want);
  if (!want) return;
  kickPlay(want);
}

/** Stops every track except the one asked for, themes and per-file alike. */
function silenceAllBut(want: HTMLAudioElement | null): void {
  const others = [introEl, battleEl, earlyEl, templeEl, aldeiaEl, siegeEl, innEl, hillEl, portaoEl, worldMapEl, ...fileEls.values()];
  for (const el of others) {
    if (!el || el === want) continue;
    el.pause();
    if (el !== introEl) el.currentTime = 0;
  }
}

export function playTheme(theme: Theme): void {
  currentTheme = theme;
  if (muted) return;
  const want = getTrack(theme);
  if (introEl && introEl !== want) introEl.pause();
  if (battleEl && battleEl !== want) {
    battleEl.pause();
    battleEl.currentTime = 0;
  }
  if (earlyEl && earlyEl !== want) {
    earlyEl.pause();
    earlyEl.currentTime = 0;
  }
  if (templeEl && templeEl !== want) {
    templeEl.pause();
    templeEl.currentTime = 0;
  }
  if (aldeiaEl && aldeiaEl !== want) {
    aldeiaEl.pause();
    aldeiaEl.currentTime = 0;
  }
  if (siegeEl && siegeEl !== want) {
    siegeEl.pause();
    siegeEl.currentTime = 0;
  }
  if (innEl && innEl !== want) {
    innEl.pause();
    innEl.currentTime = 0;
  }
  if (hillEl && hillEl !== want) {
    hillEl.pause();
    hillEl.currentTime = 0;
  }
  if (portaoEl && portaoEl !== want) {
    portaoEl.pause();
    portaoEl.currentTime = 0;
  }
  if (worldMapEl && worldMapEl !== want) {
    worldMapEl.pause();
    worldMapEl.currentTime = 0;
  }
  // A mission that named its own track may be playing; a fixed theme has to silence it too.
  for (const el of fileEls.values()) {
    if (el === want) continue;
    el.pause();
    el.currentTime = 0;
  }
  if (!want) return;
  kickPlay(want);
}

export function preloadMenuMusic(): void {
  playMenuMusic();
}

export function playMenuMusic(): void {
  currentTheme = "intro";
  if (muted) return;
  battleEl?.pause();
  earlyEl?.pause();
  templeEl?.pause();
  aldeiaEl?.pause();
  siegeEl?.pause();
  innEl?.pause();
  hillEl?.pause();
  portaoEl?.pause();
  worldMapEl?.pause();
  const el = menuElement();
  if (!el) return;
  kickPlay(el);
}

export function startMusic(): void {
  playTheme(currentTheme);
}

export function stopMusic(): void {
  if (musicTimer) {
    clearInterval(musicTimer);
    musicTimer = 0;
  }
  if (retryTimer) {
    clearInterval(retryTimer);
    retryTimer = 0;
  }
  if (typeof window !== "undefined") {
    const g = window as Window & { __brasaMusic?: number };
    if (g.__brasaMusic) {
      clearInterval(g.__brasaMusic);
      g.__brasaMusic = 0;
    }
  }
  introEl?.pause();
  battleEl?.pause();
  earlyEl?.pause();
  templeEl?.pause();
  aldeiaEl?.pause();
  siegeEl?.pause();
  innEl?.pause();
  hillEl?.pause();
  portaoEl?.pause();
  worldMapEl?.pause();
  for (const el of fileEls.values()) el.pause();
}

export function resumeAudio(): void {
  unlockAudio();
}

export function installAudioUnlock(): () => void {
  if (typeof window === "undefined") return () => {};
  const arm = () => {
    unlockAudio();
    if (currentTheme === "intro") playMenuMusic();
    else startMusic();
  };
  const opts: AddEventListenerOptions = { capture: true };
  window.addEventListener("pointerdown", arm, opts);
  window.addEventListener("keydown", arm, opts);
  return () => {
    window.removeEventListener("pointerdown", arm, opts);
    window.removeEventListener("keydown", arm, opts);
  };
}



