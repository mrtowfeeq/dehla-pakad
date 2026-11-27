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

// Shared room reverb for the synthesised match-end music: a 2.4s decaying noise impulse.
let reverb = null;
function getReverb() {
  if (reverb) return reverb;
  const len = Math.floor(ctx.sampleRate * 2.4);
  const ir = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2);
  }
  reverb = ctx.createConvolver();
  reverb.buffer = ir;
  const wet = ctx.createGain();
  wet.gain.value = 0.32;
  reverb.connect(wet);
  wet.connect(gains.game);
  return reverb;
}

function noiseBuffer(seconds) {
  const b = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return b;
}

const NOTE = (n) => 440 * Math.pow(2, (n - 69) / 12); // MIDI note number → Hz

// Match-end music, built from simple instruments: brass (filtered, detuned saws), pad, timpani
// (pitch-dropping sine + thud), cymbal (filtered noise) and bell. Returns its length (s).
function matchMusic(kind, start, out) {
  const track = (node, end) => { active.add(node); node.onended = () => active.delete(node); node.stop(end); };
  const brass = (note, at, dur, peak = 0.07, bright = 2600) => {
    const t = start + at;
    const f = ctx.createBiquadFilter();
    f.type = "lowpass";
    f.Q.value = 1.2;
    f.frequency.setValueAtTime(500, t);
    f.frequency.exponentialRampToValueAtTime(bright, t + 0.07);
    f.frequency.exponentialRampToValueAtTime(bright * 0.45, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.04);
    g.gain.setValueAtTime(peak * 0.85, t + Math.max(0.05, dur - 0.12));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.25);
    f.connect(g); g.connect(out);
    [-7, 7].forEach((det) => {
      const o = ctx.createOscillator();
      o.type = "sawtooth";
      o.frequency.value = NOTE(note);
      o.detune.value = det;
      o.connect(f);
      o.start(t);
      track(o, t + dur + 0.3);
    });
  };
  // A muted, sighing brass note: soft attack, darker tone, and the pitch sags at the end ("droop" is the
  // fraction of the pitch it falls to) while the filter closes — the sound of energy draining away.
  const sigh = (note, at, dur, peak = 0.08, droop = 0.975, bright = 1500) => {
    const t = start + at;
    const end = t + dur;
    const f = ctx.createBiquadFilter();
    f.type = "lowpass";
    f.Q.value = 0.8;
    f.frequency.setValueAtTime(400, t);
    f.frequency.exponentialRampToValueAtTime(bright, t + 0.12);
    f.frequency.exponentialRampToValueAtTime(Math.max(300, bright * 0.3), end + 0.3);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.1);
    g.gain.exponentialRampToValueAtTime(peak * 0.55, end);
    g.gain.exponentialRampToValueAtTime(0.0001, end + 0.45);
    f.connect(g); g.connect(out);
    [-5, 5].forEach((det) => {
      const o = ctx.createOscillator();
      o.type = "sawtooth";
      o.detune.value = det;
      o.frequency.setValueAtTime(NOTE(note), t);
      o.frequency.setValueAtTime(NOTE(note), t + dur * 0.55);
      o.frequency.exponentialRampToValueAtTime(NOTE(note) * droop, end + 0.4);
      o.connect(f);
      o.start(t);
      track(o, end + 0.5);
    });
  };
  const pad = (notes, at, dur, peak = 0.035) => notes.forEach((n) => {
    const t = start + at;
    const o = ctx.createOscillator();
    o.type = "triangle";
    o.frequency.value = NOTE(n);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.35);
    g.gain.setValueAtTime(peak, t + dur - 0.4);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.6);
    o.connect(g); g.connect(out);
    o.start(t);
    track(o, t + dur + 0.7);
  });
  const timpani = (at, peak = 0.35, from = 105, to = 78) => {
    const t = start + at;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(from, t);
    o.frequency.exponentialRampToValueAtTime(to, t + 0.5);
    const g = ctx.createGain();
    g.gain.setValueAtTime(peak, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
    o.connect(g); g.connect(out);
    o.start(t);
    track(o, t + 1);
    const n = ctx.createBufferSource();
    n.buffer = noiseBuffer(0.12);
    const nf = ctx.createBiquadFilter();
    nf.type = "lowpass";
    nf.frequency.value = 900;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(peak * 0.5, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    n.connect(nf); nf.connect(ng); ng.connect(out);
    n.start(t);
    track(n, t + 0.15);
  };
  const cymbal = (at, dur = 2.2, peak = 0.07, swell = false) => {
    const t = start + at;
    const n = ctx.createBufferSource();
    n.buffer = noiseBuffer(dur + 0.2);
    const f = ctx.createBiquadFilter();
    f.type = "highpass";
    f.frequency.value = 6000;
    const g = ctx.createGain();
    if (swell) {
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(peak, t + dur);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.1);
    } else {
      g.gain.setValueAtTime(peak, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    }
    n.connect(f); f.connect(g); g.connect(out);
    n.start(t);
    track(n, t + dur + 0.2);
  };
  const bell = (note, at, peak = 0.035) => {
    const t = start + at;
    [1, 2.76].forEach((ratio, i) => {
      const o = ctx.createOscillator();
      o.frequency.value = NOTE(note) * ratio;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(i ? peak * 0.3 : peak, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.4);
      o.connect(g); g.connect(out);
      o.start(t);
      track(o, t + 1.5);
    });
  };

  if (kind === "victory") {
    // C major fanfare: three-note pickup, rising call, timpani roll into a held full chord with a cymbal
    // crash and a bell arpeggio sparkling above it.
    timpani(0, 0.3); cymbal(0, 1.2, 0.04);
    [0, 0.13, 0.26].forEach((at) => brass(67, at, 0.1, 0.06));          // G4 G4 G4
    brass(72, 0.39, 0.42, 0.075);                                      // C5
    brass(76, 0.86, 0.2, 0.07); brass(79, 1.08, 0.22, 0.07);            // E5 G5
    [1.0, 1.08, 1.16, 1.24, 1.32, 1.4].forEach((at, i) => timpani(at, 0.12 + i * 0.03, 98, 82));
    cymbal(0.95, 0.5, 0.05, true);
    [48, 55, 60, 64, 67, 72, 76].forEach((n, i) => brass(n, 1.5, 1.7, i < 2 ? 0.05 : 0.045, 3200)); // full C major
    pad([48, 52, 55, 60], 1.5, 1.9, 0.03);
    timpani(1.5, 0.4, 110, 65); cymbal(1.5, 2.6, 0.09);
    [84, 88, 91, 96].forEach((n, i) => bell(n, 1.62 + i * 0.09));      // C6 E6 G6 C7
    return 3.6;
  }
  // Defeat: the feeling of losing. A heavy, dull thud; two falling "sighs" on muted brass (E♭→D, C→B), each
  // note sagging at the end; then a C minor chord that slowly sags flat and darkens as it fades over a low
  // drone, with one faint, lonely bell. Sad and deflating, not heroic and not comic.
  timpani(0, 0.45, 70, 42);                                           // the blow
  pad([36, 43, 48, 51], 0, 3.6, 0.04);                                  // dark C minor drone
  [[75, 0.25, 0.42], [74, 0.7, 0.55]].forEach(([n, at, dur]) => {     // sigh 1: Eb5 → D5
    sigh(n, at, dur, 0.085); sigh(n - 12, at, dur, 0.035, 0.975, 1100);
  });
  [[72, 1.4, 0.42], [71, 1.85, 0.6]].forEach(([n, at, dur]) => {      // sigh 2: C5 → B4
    sigh(n, at, dur, 0.08); sigh(n - 12, at, dur, 0.035, 0.975, 1100);
  });
  timpani(2.55, 0.25, 62, 40);                                        // soft final thud
  [48, 55, 60, 63].forEach((n, i) => sigh(n, 2.55, 1.5, i ? 0.045 : 0.05, 0.94, 1100)); // sagging C minor
  bell(75, 2.9, 0.016);                                               // faint, lonely Eb5
  return 4.4;
}

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
  // Synthesised accents layered on the recorded sounds (no extra files). Routed through the "game" volume
  // and the master/mute settings like every other effect.
  //   ten_gain: bright rising sparkle when your team captures a ten
  //   ten_loss: soft, lower two-note bell when the opponents capture one
  //   ten_land: short ping as the ten lands on the team's tens counter (gain lower for the opponents)
  //   trick_gain / trick_loss: light accent as a won trick's cards reach the winner's seat
  //   coin_drop / pot_full: stake entries landing on the lobby table's pot, then the pot complete
  //   victory / defeat: match-end music (brass fanfare / sighing, sinking lament), with room reverb
  chime(kind, { delay = 0, gain = 1 } = {}) {
    if (!ctx || ctx.state !== "running" || prefs.muted) return;
    const log = (window.__dpSoundLog = window.__dpSoundLog || []);
    log.push({ key: `chime:${kind}`, t: Math.round(performance.now() + delay) });
    if (log.length > 300) log.shift();
    const start = ctx.currentTime + Math.max(0, delay) / 1000;
    const out = ctx.createGain();
    out.gain.value = gain;
    out.connect(gains.game);
    if (kind === "victory" || kind === "defeat") {
      out.connect(getReverb());
      const length = matchMusic(kind, start, out);
      setTimeout(() => { try { out.disconnect(); } catch {} }, Math.max(0, delay) + (length + 2.6) * 1000);
      return;
    }
    const tone = (freq, at, dur, { type = "sine", peak = 0.18, detune = 0 } = {}) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = type;
      o.frequency.value = freq;
      o.detune.value = detune;
      g.gain.setValueAtTime(0.0001, start + at);
      g.gain.exponentialRampToValueAtTime(peak, start + at + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, start + at + dur);
      o.connect(g); g.connect(out);
      o.start(start + at);
      o.stop(start + at + dur + 0.05);
      active.add(o);
      o.onended = () => active.delete(o);
    };
    if (kind === "ten_gain") {
      // A major arpeggio (A5 C#6 E6 A6) with a detuned shimmer layer and a high sparkle on top.
      [880, 1108.73, 1318.51, 1760].forEach((f, i) => {
        tone(f, i * 0.07, 0.55 - i * 0.05, { type: "triangle", peak: 0.16 });
        tone(f * 2, i * 0.07 + 0.01, 0.3, { peak: 0.05, detune: 7 });
      });
      [2637, 3136, 3520].forEach((f, i) => tone(f, 0.3 + i * 0.045, 0.22, { peak: 0.045 }));
    } else if (kind === "ten_loss") {
      tone(659.25, 0, 0.45, { type: "triangle", peak: 0.12 });
      tone(493.88, 0.14, 0.6, { type: "triangle", peak: 0.11 });
      tone(246.94, 0.14, 0.5, { peak: 0.06 });
    } else if (kind === "trick_gain") {
      // Quick, light two-note lift as the trick reaches your team (kept smaller than the ten chime).
      tone(1046.5, 0, 0.22, { type: "triangle", peak: 0.11 });
      tone(1567.98, 0.08, 0.3, { type: "triangle", peak: 0.1 });
      tone(3135.96, 0.09, 0.14, { peak: 0.03 });
    } else if (kind === "trick_loss") {
      // Soft, low tap as the trick goes to the opponents.
      tone(392, 0, 0.22, { type: "triangle", peak: 0.08 });
      tone(293.66, 0.07, 0.3, { peak: 0.06 });
    } else if (kind === "coin_drop") {
      // Metallic clink of a coin landing on the pot: two inharmonic partials plus a tiny low knock.
      tone(2793.83, 0, 0.12, { type: "triangle", peak: 0.07 });
      tone(4186.01, 0.004, 0.09, { peak: 0.035, detune: 12 });
      tone(5274.04, 0.03, 0.07, { peak: 0.02 });
      tone(330, 0, 0.05, { peak: 0.04 });
    } else if (kind === "pot_full") {
      // The pot settles: a warm rising shimmer once every entry is in.
      [783.99, 987.77, 1174.66, 1567.98].forEach((f, i) => tone(f, i * 0.05, 0.5, { type: "triangle", peak: 0.09 }));
      [3135.96, 3951.07].forEach((f, i) => tone(f, 0.22 + i * 0.05, 0.25, { peak: 0.03 }));
    } else if (kind === "ten_land") {
      tone(1567.98, 0, 0.28, { type: "triangle", peak: 0.14 });
      tone(3135.96, 0.005, 0.16, { peak: 0.05 });
      tone(196, 0, 0.16, { peak: 0.12 });
    }
    setTimeout(() => { try { out.disconnect(); } catch {} }, Math.max(0, delay) + 1500);
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
