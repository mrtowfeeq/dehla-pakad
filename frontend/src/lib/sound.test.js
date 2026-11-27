// Runs the real synthesised sounds against a stand-in Web Audio context, so a mistake in how they are
// built (a bad node, a value real browsers reject) fails here instead of silently at the end of a match.

class Param {
  constructor(name, value = 0) { this.name = name; this.value = value; this.events = []; }
  setValueAtTime(v, t) { this.events.push(["set", v, t]); return this; }
  setTargetAtTime(v, t) { this.events.push(["target", v, t]); return this; }
  linearRampToValueAtTime(v, t) { this.events.push(["linear", v, t]); return this; }
  exponentialRampToValueAtTime(v, t) {
    // Real browsers throw a RangeError for a non-positive target on an exponential ramp.
    if (!(v > 0)) throw new RangeError(`${this.name}: exponential ramp to ${v}`);
    this.events.push(["exp", v, t]);
    return this;
  }
}

let created;
class Node {
  constructor(kind) { this.kind = kind; this.outputs = []; created.push(this); }
  connect(n) { this.outputs.push(n); return n; }
  disconnect() { this.outputs = []; }
}
class Source extends Node {
  start(t = 0) { this.startAt = t; }
  stop(t) { this.stopAt = t; }
}

class FakeAudioContext {
  constructor() { this.currentTime = 10; this.sampleRate = 8000; this.state = "running"; this.destination = new Node("destination"); }
  resume() { this.state = "running"; }
  createGain() { const n = new Node("gain"); n.gain = new Param("gain", 1); return n; }
  createOscillator() { const n = new Source("osc"); n.type = "sine"; n.frequency = new Param("frequency", 440); n.detune = new Param("detune"); return n; }
  createBiquadFilter() { const n = new Node("filter"); n.type = "lowpass"; n.frequency = new Param("filterFrequency", 350); n.Q = new Param("Q", 1); return n; }
  createBufferSource() { const n = new Source("buffer"); n.playbackRate = new Param("rate", 1); return n; }
  createConvolver() { return new Node("convolver"); }
  createBuffer(channels, length) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { getChannelData: (c) => data[c], length };
  }
}

let sound;
beforeEach(() => {
  jest.resetModules();
  created = [];
  global.fetch = jest.fn(() => Promise.resolve({ json: () => Promise.resolve({}) }));
  window.AudioContext = FakeAudioContext;
  window.__dpSoundLog = [];
  localStorage.clear();
  ({ sound } = require("./sound"));
  sound.unlock();
  created = []; // ignore the silent buffer unlock() plays to wake the audio context
});

const sources = () => created.filter((n) => n.kind === "osc" || n.kind === "buffer");

test.each(["victory", "defeat"])("%s music builds without errors and stays a few seconds long", (kind) => {
  expect(() => sound.chime(kind)).not.toThrow();
  const s = sources();
  expect(s.length).toBeGreaterThan(kind === "victory" ? 30 : 10);
  s.forEach((n) => { expect(n.startAt).toBeGreaterThanOrEqual(10); expect(n.stopAt).toBeGreaterThan(n.startAt); });
  const end = Math.max(...s.map((n) => n.stopAt)) - 10;
  expect(end).toBeGreaterThan(2.5);
  expect(end).toBeLessThan(5);
  // Played through the room reverb as well as directly.
  expect(created.some((n) => n.kind === "convolver")).toBe(true);
  expect(window.__dpSoundLog.map((e) => e.key)).toContain(`chime:${kind}`);
});

test.each(["ten_gain", "ten_loss", "ten_land", "trick_gain", "trick_loss"])("%s accent builds without errors", (kind) => {
  expect(() => sound.chime(kind)).not.toThrow();
  expect(sources().length).toBeGreaterThan(0);
});

test("muted sound plays nothing", () => {
  sound.update({ muted: true });
  created = [];
  sound.chime("victory");
  expect(sources()).toHaveLength(0);
});
