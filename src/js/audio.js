// PortalBreakout — procedural WebAudio engine: SFX + generative music (see CONTRACT.md)
// No assets, no worklets — only scheduled nodes that stop themselves.

const MAX_VOICES = 16;      // simultaneous sfx voices; oldest dropped beyond this
const LOOKAHEAD = 0.2;      // seconds of music scheduled ahead of the context clock
const TICK_MS = 100;        // music scheduler interval
const XFADE = 0.5;          // music crossfade seconds
const PENTA = [0, 3, 5, 7, 10]; // minor pentatonic, semitones

let ctx = null;
let master = null, musicBus = null, sfxBus = null;
let noiseBuf = null;
let cfg = { master: 0.8, music: 0.5, sfx: 0.9, muted: false };
let voices = [];
let mus = null; // active music track state

const now = () => ctx.currentTime;
const clamp01 = (v) => Math.min(1, Math.max(0, Number(v) || 0));

function applyGains() {
  if (!ctx) return;
  const t = now();
  // x*x ≈ perceptual volume curve
  master.gain.setTargetAtTime(cfg.muted ? 0 : cfg.master * cfg.master, t, 0.02);
  musicBus.gain.setTargetAtTime(cfg.music * cfg.music, t, 0.02);
  sfxBus.gain.setTargetAtTime(cfg.sfx * cfg.sfx, t, 0.02);
}

function init() {
  if (!ctx) {
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.connect(ctx.destination);
    musicBus = ctx.createGain();
    musicBus.connect(master);
    sfxBus = ctx.createGain();
    sfxBus.connect(master);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    applyGains();
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
}

function applySettings(a = {}) {
  cfg = {
    master: clamp01(a.master ?? cfg.master),
    music: clamp01(a.music ?? cfg.music),
    sfx: clamp01(a.sfx ?? cfg.sfx),
    muted: Boolean(a.muted ?? cfg.muted),
  };
  applyGains();
}

// ---------------------------------------------------------------- primitives

function osc(type, freq, detune = 0) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.value = freq;
  o.detune.value = detune;
  return o;
}

function filt(type, freq, q = 0.9) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  return f;
}

function env(param, t, peak, decay, attack = 0.002) {
  param.setValueAtTime(0.0001, t);
  param.linearRampToValueAtTime(peak, t + attack);
  param.exponentialRampToValueAtTime(0.0001, t + attack + decay);
}

function sweep(param, t, from, to, dur) {
  param.setValueAtTime(Math.max(0.01, from), t);
  param.exponentialRampToValueAtTime(Math.max(0.01, to), t + dur);
}

// One synthesized partial: osc (optionally pitch-swept, lowpassed) → envelope → dest.
function tone(dest, t, o) {
  const src = osc(o.type ?? 'sine', o.freq, o.detune ?? 0);
  if (o.freqTo) sweep(src.frequency, t, o.freq, o.freqTo, o.slide ?? o.decay ?? 0.1);
  const g = ctx.createGain();
  const attack = o.attack ?? 0.002, decay = o.decay ?? 0.15;
  env(g.gain, t, o.peak ?? 0.3, decay, attack);
  let head = src;
  if (o.lp) {
    const f = filt('lowpass', o.lp, o.q ?? 0.9);
    src.connect(f);
    head = f;
  }
  head.connect(g);
  g.connect(dest);
  src.start(t);
  src.stop(t + attack + decay + 0.05);
}

// Filtered white-noise burst → envelope → dest.
function hiss(dest, t, o) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  src.loop = true;
  const f = filt(o.type ?? 'lowpass', o.freq ?? 2000, o.q ?? 1);
  if (o.freqTo) sweep(f.frequency, t, o.freq ?? 2000, o.freqTo, o.slide ?? o.decay ?? 0.2);
  const g = ctx.createGain();
  const attack = o.attack ?? 0.002, decay = o.decay ?? 0.2;
  env(g.gain, t, o.peak ?? 0.2, decay, attack);
  src.connect(f);
  f.connect(g);
  g.connect(dest);
  src.start(t);
  src.stop(t + attack + decay + 0.05);
}

// ---------------------------------------------------------------- sfx voices

// Per-voice gain registered here so we can cap polyphony (drop oldest).
function newVoice(dur) {
  const t = now();
  for (let i = voices.length - 1; i >= 0; i--) {
    if (voices[i].until <= t) {
      voices[i].g.disconnect();
      voices.splice(i, 1);
    }
  }
  if (voices.length >= MAX_VOICES) {
    const old = voices.shift();
    old.g.gain.cancelScheduledValues(t);
    old.g.gain.setTargetAtTime(0, t, 0.008);
    setTimeout(() => old.g.disconnect(), 80);
  }
  const g = ctx.createGain();
  g.connect(sfxBus);
  voices.push({ g, until: t + dur });
  return g;
}

const SFX_DUR = {
  portal: 0.45, brick: 0.25, silver: 0.18, gold: 0.4, explode: 0.6, wall: 0.12,
  powerup: 0.35, drop: 0.25, laser: 0.2, lifeLost: 0.85, levelClear: 0.85,
  gameOver: 1.45, click: 0.06, launch: 0.28, stick: 0.16, countdown: 0.1, win: 1.6,
};

const SFX = {
  portal(v, t) {
    tone(v, t, { type: 'sine', freq: 170, freqTo: 1150, slide: 0.16, peak: 0.4, decay: 0.3, attack: 0.004 });
    tone(v, t, { type: 'sine', freq: 172, freqTo: 1180, slide: 0.17, detune: -9, peak: 0.2, decay: 0.3, attack: 0.004 });
    hiss(v, t, { type: 'bandpass', freq: 700, freqTo: 4200, slide: 0.2, q: 2.5, peak: 0.16, decay: 0.32, attack: 0.004 });
  },
  brick(v, t, opts) {
    const c = Math.max(0, Math.floor(opts.combo ?? 0));
    const semis = PENTA[c % 5] + 12 * Math.min(2, Math.floor(c / 5));
    const f = 523.25 * 2 ** (semis / 12);
    tone(v, t, { type: 'triangle', freq: f, peak: 0.45, decay: 0.16, lp: 3200 });
    tone(v, t, { type: 'square', freq: f, detune: 9, peak: 0.12, decay: 0.1, lp: 1900 });
  },
  silver(v, t) {
    tone(v, t, { type: 'square', freq: 215, freqTo: 160, slide: 0.08, peak: 0.3, decay: 0.09, lp: 1200 });
    hiss(v, t, { type: 'bandpass', freq: 1500, q: 4, peak: 0.12, decay: 0.06 });
  },
  gold(v, t) {
    // inharmonic partials = metallic clank
    tone(v, t, { type: 'sine', freq: 420, peak: 0.3, decay: 0.3 });
    tone(v, t, { type: 'sine', freq: 1123, peak: 0.16, decay: 0.22 });
    tone(v, t, { type: 'sine', freq: 1794, peak: 0.1, decay: 0.15 });
    tone(v, t, { type: 'sine', freq: 2517, peak: 0.06, decay: 0.1 });
    hiss(v, t, { type: 'highpass', freq: 2600, peak: 0.1, decay: 0.05, attack: 0.001 });
  },
  explode(v, t) {
    hiss(v, t, { type: 'lowpass', freq: 3200, freqTo: 180, slide: 0.4, q: 0.7, peak: 0.6, decay: 0.45, attack: 0.004 });
    tone(v, t, { type: 'sine', freq: 110, freqTo: 36, slide: 0.35, peak: 0.75, decay: 0.4, attack: 0.004 });
  },
  wall(v, t) {
    tone(v, t, { type: 'sine', freq: 360, freqTo: 300, slide: 0.05, peak: 0.25, decay: 0.06 });
    hiss(v, t, { type: 'bandpass', freq: 900, q: 2, peak: 0.08, decay: 0.04 });
  },
  powerup(v, t) {
    [523.25, 659.25, 783.99].forEach((f, i) =>
      tone(v, t + i * 0.055, { type: 'triangle', freq: f, peak: 0.28, decay: 0.13, lp: 4000 }));
  },
  drop(v, t) {
    tone(v, t, { type: 'triangle', freq: 740, freqTo: 470, slide: 0.14, peak: 0.2, decay: 0.16, lp: 2500 });
  },
  laser(v, t) {
    tone(v, t, { type: 'sawtooth', freq: 1500, freqTo: 190, slide: 0.11, peak: 0.26, decay: 0.13, lp: 3000, attack: 0.001 });
    tone(v, t, { type: 'square', freq: 750, freqTo: 120, slide: 0.11, peak: 0.1, decay: 0.1, lp: 1600, attack: 0.001 });
  },
  lifeLost(v, t) {
    tone(v, t, { type: 'sawtooth', freq: 330, peak: 0.24, decay: 0.24, lp: 1100 });
    tone(v, t + 0.2, { type: 'sawtooth', freq: 262, freqTo: 238, slide: 0.4, peak: 0.26, decay: 0.5, lp: 900 });
  },
  levelClear(v, t) {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
      tone(v, t + i * 0.09, { type: 'triangle', freq: f, peak: 0.28, decay: i === 3 ? 0.45 : 0.15, lp: 4500 });
      tone(v, t + i * 0.09, { type: 'square', freq: f, detune: 7, peak: 0.07, decay: 0.12, lp: 2200 });
    });
  },
  gameOver(v, t) {
    [440, 330, 261.63, 220].forEach((f, i) => {
      const tt = t + i * 0.24, dec = i === 3 ? 0.65 : 0.28;
      tone(v, tt, { type: 'sawtooth', freq: f, peak: 0.2, decay: dec, lp: 1000 });
      tone(v, tt, { type: 'sawtooth', freq: f, detune: -10, peak: 0.11, decay: dec, lp: 800 });
    });
  },
  click(v, t) {
    tone(v, t, { type: 'sine', freq: 1900, peak: 0.12, decay: 0.03, attack: 0.001 });
    hiss(v, t, { type: 'highpass', freq: 3500, peak: 0.05, decay: 0.02, attack: 0.001 });
  },
  launch(v, t) {
    tone(v, t, { type: 'sine', freq: 210, freqTo: 660, slide: 0.12, peak: 0.3, decay: 0.18 });
    hiss(v, t, { type: 'lowpass', freq: 900, freqTo: 2600, slide: 0.12, peak: 0.1, decay: 0.15 });
  },
  stick(v, t) {
    tone(v, t, { type: 'sine', freq: 160, freqTo: 118, slide: 0.08, peak: 0.32, decay: 0.09 });
    hiss(v, t, { type: 'bandpass', freq: 800, q: 1.5, peak: 0.08, decay: 0.05, attack: 0.001 });
  },
  countdown(v, t) {
    tone(v, t, { type: 'square', freq: 660, peak: 0.18, decay: 0.07, lp: 1600, attack: 0.001 });
  },
  win(v, t) {
    const seq = [523.25, 659.25, 783.99, 1046.5];
    seq.forEach((f, i) => tone(v, t + i * 0.11, { type: 'square', freq: f, peak: 0.15, decay: 0.16, lp: 3000 }));
    for (const f of seq) { // held final chord, detuned for width
      tone(v, t + 0.46, { type: 'sawtooth', freq: f, detune: -6, peak: 0.07, decay: 0.85, lp: 2600, attack: 0.01 });
      tone(v, t + 0.46, { type: 'sawtooth', freq: f, detune: 6, peak: 0.07, decay: 0.85, lp: 2600, attack: 0.01 });
    }
    hiss(v, t + 0.46, { type: 'highpass', freq: 5000, peak: 0.04, decay: 0.7, attack: 0.01 });
  },
};

function sfx(name, opts = {}) {
  if (!ctx || cfg.muted) return;
  const fn = SFX[name];
  if (!fn) return;
  fn(newVoice(SFX_DUR[name] ?? 1), now() + 0.005, opts);
}

// ---------------------------------------------------------------- music

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const MENU_CHORDS = [
  [110, 130.81, 164.81],    // Am
  [87.31, 110, 130.81],     // F
  [98, 146.83, 196],        // G (open fifth)
  [82.41, 123.47, 164.81],  // Em
];

function setupMenu(s) {
  s.stepDur = 60 / 70 / 2; // 8th notes @ 70 BPM
  s.padLP = filt('lowpass', 750, 0.6);
  s.padLP.connect(s.gain);
  // echoing pluck: feedback delay at a dotted 8th
  s.delay = ctx.createDelay(1.5);
  s.delay.delayTime.value = s.stepDur * 1.5;
  s.fb = ctx.createGain();
  s.fb.gain.value = 0.38;
  s.echoLP = filt('lowpass', 1600, 0.5);
  s.delay.connect(s.echoLP);
  s.echoLP.connect(s.fb);
  s.fb.connect(s.delay);
  s.echoLP.connect(s.gain);
  s.nodes.push(s.padLP, s.delay, s.fb, s.echoLP);
  s.schedule = menuStep;
}

function menuStep(s, t) {
  const CHORD_LEN = 16; // 8 beats per chord
  if (s.step % CHORD_LEN === 0) {
    let idx = ((s.step / CHORD_LEN) | 0) % MENU_CHORDS.length;
    if (idx >= 2 && s.rng() < 0.25) idx = idx === 2 ? 3 : 2; // occasionally swap tail chords
    const durS = CHORD_LEN * s.stepDur;
    for (const f of MENU_CHORDS[idx]) {
      for (const det of [-7, 7]) {
        const o = osc('sawtooth', f, det);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.05, t + durS * 0.35);
        g.gain.setValueAtTime(0.05, t + durS * 0.75);
        g.gain.linearRampToValueAtTime(0.0001, t + durS + 0.2);
        o.connect(g);
        g.connect(s.padLP);
        o.start(t);
        o.stop(t + durS + 0.3);
      }
    }
  }
  if (s.rng() < 0.34) { // sparse pluck, A minor pentatonic over ~2 octaves
    const deg = (s.rng() * PENTA.length) | 0;
    const oct = s.rng() < 0.5 ? 1 : s.rng() < 0.75 ? 2 : 0;
    const f = 220 * 2 ** ((PENTA[deg] + 12 * oct) / 12);
    const o = osc('triangle', f);
    const g = ctx.createGain();
    env(g.gain, t, 0.11, 0.55, 0.004);
    o.connect(g);
    g.connect(s.gain);
    const send = ctx.createGain();
    send.gain.value = 0.5;
    g.connect(send);
    send.connect(s.delay);
    o.start(t);
    o.stop(t + 0.62);
  }
}

const GAME_PATS = [
  [0, 2, 4, 2, 1, 3, 4, 3],
  [0, 4, 2, 4, 1, 4, 3, 4],
  [4, 2, 0, 2, 3, 1, 0, 1],
  [0, 1, 2, 3, 4, 3, 2, 1],
];

function setupGame(s) {
  s.stepDur = 60 / 110 / 4; // 16th notes @ 110 BPM
  s.lp = filt('lowpass', 2000, 0.7);
  s.lp.connect(s.gain);
  s.nodes.push(s.lp);
  s.roots = [0, 0, 8, 10]; // semitones from A: A A F G
  s.arpPat = GAME_PATS[0];
  s.oct = 1;
  s.schedule = gameStep;
}

function gameStep(s, t) {
  const BAR = 16;
  if (s.step % (BAR * 4) === 0) { // evolve every 4 bars so the loop doesn't grate
    s.arpPat = GAME_PATS[(s.rng() * GAME_PATS.length) | 0];
    s.oct = s.rng() < 0.35 ? 2 : 1;
    s.roots = s.rng() < 0.3 ? [0, 3, 8, 10] : [0, 0, 8, 10];
  }
  const root = s.roots[((s.step / BAR) | 0) % 4];
  const i = s.step % BAR;
  if (i % 4 === 0) { // soft bass pulse on quarters, accent on the downbeat
    tone(s.lp, t, {
      type: 'triangle', freq: 110 * 2 ** (root / 12),
      peak: i === 0 ? 0.17 : 0.13, decay: 0.16, attack: 0.004,
    });
  }
  if (s.rng() > 0.12) { // driving 16th arpeggio with occasional rests
    const deg = s.arpPat[s.step % 8];
    const f = 220 * 2 ** ((root + PENTA[deg] + 12 * (s.oct - 1)) / 12);
    tone(s.lp, t, {
      type: 'square', freq: f, detune: s.step % 2 ? 6 : -6,
      peak: 0.055, decay: 0.1, attack: 0.002,
    });
  }
  if (i % 4 === 2) { // faint off-beat hat tick
    hiss(s.gain, t, { type: 'highpass', freq: 7000, peak: 0.018, decay: 0.03, attack: 0.001 });
  }
}

function runScheduler(s) {
  const tNow = ctx.currentTime;
  if (s.nextTime < tNow - 0.05) s.nextTime = tNow + 0.02; // resync after tab throttling
  const horizon = tNow + LOOKAHEAD;
  while (s.nextTime < horizon) {
    s.schedule(s, s.nextTime);
    s.step++;
    s.nextTime += s.stepDur;
  }
}

function startTrack(name) {
  const t = now();
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.linearRampToValueAtTime(1, t + XFADE);
  gain.connect(musicBus);
  const s = {
    name, gain, nodes: [], step: 0, nextTime: t + 0.06,
    rng: mulberry((Date.now() & 0xffff) ^ (name === 'menu' ? 0x9e37 : 0x51ab)),
  };
  if (name === 'menu') setupMenu(s);
  else setupGame(s);
  s.timer = setInterval(() => runScheduler(s), TICK_MS);
  runScheduler(s);
  return s;
}

function stopTrack(s) {
  clearInterval(s.timer);
  const t = now();
  s.gain.gain.cancelScheduledValues(t);
  s.gain.gain.setValueAtTime(Math.max(0.0001, s.gain.gain.value), t);
  s.gain.gain.linearRampToValueAtTime(0.0001, t + XFADE);
  setTimeout(() => {
    for (const n of s.nodes) {
      try { n.stop?.(); } catch { /* already stopped */ }
      try { n.disconnect(); } catch { /* already gone */ }
    }
    s.gain.disconnect();
  }, (XFADE + 0.1) * 1000);
}

function music(track = null) {
  if (!ctx) return;
  const name = track === 'menu' || track === 'game' ? track : null;
  if ((mus?.name ?? null) === name) return;
  if (mus) {
    stopTrack(mus);
    mus = null;
  }
  if (name) mus = startTrack(name);
}

export const audio = { init, applySettings, sfx, music };
