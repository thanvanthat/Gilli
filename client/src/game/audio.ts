/** Synthesized sound effects (Web Audio; no audio files to load or fail). */
let ctx: AudioContext | null = null;
let volume = 0.8;

export function setVolume(v: number) { volume = Math.max(0, Math.min(1, v)); }

function audio(): AudioContext | null {
  if (!ctx) {
    try { ctx = new AudioContext(); } catch { ctx = null; }
  }
  if (ctx && ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

/** Call from a user gesture so later sounds are allowed to play. */
export function unlockAudio() { audio(); }

function tone(freq: number, dur: number, type: OscillatorType = 'sine', vol = 0.2, slide = 0, at = 0) {
  const a = audio(); if (!a || volume <= 0) return;
  const t0 = a.currentTime + at;
  const o = a.createOscillator(), g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq * slide), t0 + dur);
  g.gain.setValueAtTime(vol * volume, t0);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  o.connect(g); g.connect(a.destination);
  o.start(t0); o.stop(t0 + dur + 0.02);
}

function noise(dur: number, vol = 0.3, freq = 1200) {
  const a = audio(); if (!a || volume <= 0) return;
  const len = Math.floor(a.sampleRate * dur), buf = a.createBuffer(1, len, a.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const s = a.createBufferSource(); s.buffer = buf;
  const f = a.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq;
  const g = a.createGain(); g.gain.value = vol * volume;
  s.connect(f); f.connect(g); g.connect(a.destination); s.start();
}

export const SFX = {
  flick: () => tone(950, 0.07, 'triangle', 0.25, 0.6),
  swish: () => noise(0.15, 0.25, 700),
  hit: (strength = 1) => { noise(0.12, 0.4 + 0.3 * strength, 2200); tone(520, 0.1, 'square', 0.07, 0.5); },
  thud: (strength = 1) => noise(0.08, 0.08 + 0.2 * Math.min(1, strength), 300),
  miss: () => tone(200, 0.25, 'sine', 0.22, 0.6),
  out: () => { tone(330, 0.22, 'sawtooth', 0.1, 0.8); tone(220, 0.4, 'sawtooth', 0.1, 0.7, 0.2); },
  safe: () => { [523, 659, 784].forEach((f, i) => tone(f, 0.18, 'triangle', 0.18, 0, i * 0.11)); },
  catch: () => noise(0.09, 0.5, 500),
  danda: () => { noise(0.1, 0.6, 900); tone(260, 0.15, 'triangle', 0.2, 0.7); },
  crowd: () => { noise(1.4, 0.3, 900); noise(1.1, 0.2, 1800); },
  coin: () => { for (let i = 0; i < 6; i++) tone(1500 + i * 80, 0.04, 'triangle', 0.1, 0, i * 0.13); },
  click: () => tone(660, 0.04, 'triangle', 0.08),
  win: () => { [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.25, 'triangle', 0.18, 0, i * 0.14)); },
};
