// Web Audio sound engine. Real card recordings + jingles (Kenney, CC0) live in /public/sounds.
const DEFAULTS = { master: 0.8, card: 0.9, game: 0.7, ambience: 0.35, muted: false, ambienceOn: false };
const CARD_KEYS = new Set(["shuffle", "cut", "deal", "deal_rapid", "pickup", "slide", "place", "flip", "collect", "deck_place"]);
const PRELOAD = ["shuffle", "cut", "deal", "deal_rapid", "pickup", "slide", "place", "flip", "collect", "deck_place",
  "turn", "trump", "trick_won", "trick_lost", "ten", "click", "invalid", "tick", "chat", "notify"];
const MAX_VOICES = 14;

let manifest = null;
let ctx = null;
let gains = {};
let prefs = read("anon");
let uid = "anon";
const buffers = {};
const loading = {};
const lastPlay = {};
const lastVariant = {};
const active = new Set();
const listeners = new Set();
let ambience = null;

function read(id) {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(`dp_sound_prefs_${id}`) || "{}") }; } catch { return { ...DEFAULTS }; }
}

const manifestReady = fetch("/sounds/manifest.json").then((r) => r.json()).then((m) => { manifest = m; }).catch(() => { manifest = {}; });

function applyGains() {
  if (!ctx) return;
  const t = ctx.currentTime;
  gains.master.gain.setTargetAtTime(prefs.muted ? 0 : prefs.master, t, 0.03);
  gains.card.gain.setTargetAtTime(prefs.card, t, 0.03);
  gains.game.gain.setTargetAtTime(prefs.game, t, 0.03);
  gains.ambience.gain.setTargetAtTime(prefs.ambience, t, 0.05);
}

async function buffer(name) {
  if (buffers[name]) return buffers[name];
  if (!loading[name]) {
    loading[name] = fetch(`/sounds/${name}.mp3`).then((r) => r.arrayBuffer())
      .then((ab) => new Promise((res, rej) => ctx.decodeAudioData(ab, res, rej)))
      .then((b) => { buffers[name] = b; return b; })
      .catch(() => null);
  }
  return loading[name];
}

async function preload() {
  await manifestReady;
  for (const key of PRELOAD) for (let i = 0; i < (manifest[key] || 0); i++) buffer(`${key}_${i}`);
}

function pickVariant(key) {
  const n = manifest?.[key] || 0;
  if (n <= 1) return 0;
  let v = Math.floor(Math.random() * n);
  if (v === lastVariant[key]) v = (v + 1) % n;
  lastVariant[key] = v;
  return v;
}

function brownNoise() {
  const len = ctx.sampleRate * 4;
  const b = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = b.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; d[i] = last * 3.2; }
  return b;
}

function notify() { listeners.forEach((fn) => fn(prefs)); }

export const sound = {
  get prefs() { return prefs; },
  get unlocked() { return !!ctx && ctx.state === "running"; },
  setUser(id) {
    if (!id || id === uid) return;
    uid = id;
    prefs = read(id);
    applyGains();
    notify();
    if (ambience && !prefs.ambienceOn) sound.ambience(false);
  },
  update(patch) {
    prefs = { ...prefs, ...patch };
    localStorage.setItem(`dp_sound_prefs_${uid}`, JSON.stringify(prefs));
    applyGains();
    notify();
    if ("ambienceOn" in patch) sound.ambience(sound._wantAmbience);
  },
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  // Must be called from a user gesture (autoplay policies on iOS/Android/desktop).
  unlock() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!ctx) {
      ctx = new Ctx();
      gains.master = ctx.createGain();
      gains.master.connect(ctx.destination);
      for (const c of ["card", "game", "ambience"]) { gains[c] = ctx.createGain(); gains[c].connect(gains.master); }
      applyGains();
      const silent = ctx.createBufferSource();
      silent.buffer = ctx.createBuffer(1, 1, 22050);
      silent.connect(ctx.destination);
      silent.start(0);
      preload();
    }
    if (ctx.state === "suspended") ctx.resume();
    if (sound._wantAmbience && prefs.ambienceOn && !ambience) sound.ambience(true);
  },
  async play(key, { rate = 1, gain = 1, delay = 0, minGap = 35, category } = {}) {
    if (!ctx || ctx.state !== "running" || prefs.muted) return;
    const log = (window.__dpSoundLog = window.__dpSoundLog || []);
    log.push({ key, t: Math.round(performance.now() + delay) });
    if (log.length > 300) log.shift();
    await manifestReady;
    if (!manifest[key]) return;
    const now = performance.now() + delay;
    if (lastPlay[key] && now - lastPlay[key] < minGap) return;
    lastPlay[key] = now;
    if (active.size >= MAX_VOICES) return;
    const b = await buffer(`${key}_${pickVariant(key)}`);
    if (!b || !ctx) return;
    const isCard = CARD_KEYS.has(key);
    const src = ctx.createBufferSource();
    src.buffer = b;
    src.playbackRate.value = rate * (isCard ? 0.96 + Math.random() * 0.08 : 1);
    const g = ctx.createGain();
    g.gain.value = gain * (isCard ? 0.88 + Math.random() * 0.17 : 1);
    src.connect(g);
    g.connect(gains[category || (isCard ? "card" : "game")]);
    src.start(ctx.currentTime + Math.max(0, delay) / 1000);
    active.add(src);
    src.onended = () => active.delete(src);
  },
  stopAll() {
    active.forEach((s) => { try { s.stop(); } catch {} });
    active.clear();
  },
  _wantAmbience: false,
  ambience(on) {
    sound._wantAmbience = !!on;
    if (!on || !prefs.ambienceOn) {
      if (ambience) { clearTimeout(ambience.timer); try { ambience.src.stop(); } catch {} ambience = null; }
      return;
    }
    if (!ctx || ambience) return;
    const src = ctx.createBufferSource();
    src.buffer = brownNoise();
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 420;
    const g = ctx.createGain();
    g.gain.value = 0.22;
    src.connect(lp); lp.connect(g); g.connect(gains.ambience);
    src.start();
    const accent = () => {
      const key = Math.random() < 0.6 ? "amb_chips" : Math.random() < 0.5 ? "slide" : "shuffle";
      sound.play(key, { gain: 0.28, category: "ambience", minGap: 0 });
      ambience.timer = setTimeout(accent, 9000 + Math.random() * 14000);
    };
    ambience = { src, timer: setTimeout(accent, 6000) };
  },
};
