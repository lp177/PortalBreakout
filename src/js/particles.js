// PortalBreakout — visual juice: pooled particles, screen shake, floating text,
// portal flashes, confetti (see CONTRACT.md "js/particles.js").
// All coordinates are FIELD coordinates; the engine applies the world transform
// before calling draw(). No side effects at import beyond pool pre-allocation.

import { FIELD_W, FIELD_H } from './constants.js';

const TAU = Math.PI * 2;

// Particle kinds
const K_SHARD = 0;     // brick debris rectangle
const K_SPARK = 1;     // tiny line spark
const K_PUFF = 2;      // ball trail glow puff
const K_HOT = 3;       // explosion ember (white → orange → smoke)
const K_RING = 4;      // circular shockwave ring
const K_FLASH = 5;     // brief filled flash (circle or ellipse)
const K_PRING = 6;     // portal elliptical ring
const K_SWIRL = 7;     // portal swirl dot orbiting the flash center
const K_CONFETTI = 8;  // level-clear paper piece

const CAP_FULL = 600, CAP_REDUCED = 120, TEXT_MAX = 24;
// SHAKE_AMP is in FIELD units (like every coordinate here): the engine applies
// shakeOffset() inside the world transform, so it scales with the canvas.
const TRAUMA_DECAY = 1.6, SHAKE_AMP = 14;
const PORTAL_ORANGE = '#ff9800', PORTAL_BLUE = '#40c4ff';
const SWIRL_ASPECT = 0.4;   // portal swirl/ellipse squash (paddles are wide & thin)
const CONFETTI_COLORS = ['#ef5350', '#ff9800', '#ffeb3b', '#66bb6a', '#26c6da', '#42a5f5', '#ab47bc', '#ec407a'];
const TEXT_FONT = 'bold 30px "Cascadia Mono", Consolas, Menlo, "DejaVu Sans Mono", monospace';

const rand = (a, b) => a + Math.random() * (b - a);
const easeOutCubic = (t) => 1 - (1 - t) ** 3;

// Precomputed ember color ramp (indexed by life fraction) — avoids building
// rgba strings every frame. Stops: fraction, r, g, b, alpha (1 = freshly spawned).
const HOT_STOPS = [
  [0.00, 70, 70, 70, 0],
  [0.30, 110, 100, 95, 0.45],
  [0.55, 255, 110, 40, 0.9],
  [0.80, 255, 205, 70, 1],
  [1.00, 255, 255, 255, 1],
];
const HOT_RAMP = new Array(25);
for (let i = 0; i <= 24; i++) {
  const f = i / 24;
  let a = HOT_STOPS[0], b = HOT_STOPS[HOT_STOPS.length - 1];
  for (let s = 0; s < HOT_STOPS.length - 1; s++) {
    if (f >= HOT_STOPS[s][0] && f <= HOT_STOPS[s + 1][0]) { a = HOT_STOPS[s]; b = HOT_STOPS[s + 1]; break; }
  }
  const t = (f - a[0]) / ((b[0] - a[0]) || 1);
  const mix = (j) => a[j] + (b[j] - a[j]) * t;
  HOT_RAMP[i] = `rgba(${Math.round(mix(1))},${Math.round(mix(2))},${Math.round(mix(3))},${mix(4).toFixed(3)})`;
}

// ---------- pools (pre-allocated; zero allocation during steady play) ----------

const makeParticle = () => ({
  kind: 0, seq: 0, x: 0, y: 0, vx: 0, vy: 0, g: 0,
  life: 0, ttl: 1, size: 0, w: 0, h: 0, rot: 0, vr: 0,
  x0: 0, y0: 0, p0: 0, p1: 0, color: '#fff',
});
const pool = new Array(CAP_FULL);
for (let i = 0; i < CAP_FULL; i++) pool[i] = makeParticle();

const makeText = () => ({ seq: 0, text: '', x: 0, y: 0, color: '#fff', life: 0, ttl: 1 });
const texts = new Array(TEXT_MAX);
for (let i = 0; i < TEXT_MAX; i++) texts[i] = makeText();

let count = 0;          // live particles occupy pool[0..count)
let textCount = 0;
let cap = CAP_FULL;
let reduced = false;
let seq = 0;            // monotonically increasing spawn stamp (for oldest-recycling)
let trauma = 0;
let time = 0;           // clock for the shake noise
const shakeVec = { x: 0, y: 0 };  // reused every frame — engine consumes it immediately

const spawn = (kind) => {
  let p;
  if (count < cap) {
    p = pool[count++];
  } else {
    // over cap: recycle the oldest live particle
    let oldest = 0;
    for (let i = 1; i < count; i++) if (pool[i].seq < pool[oldest].seq) oldest = i;
    p = pool[oldest];
  }
  p.kind = kind;
  p.seq = ++seq;
  p.vx = 0; p.vy = 0; p.g = 0; p.rot = 0; p.vr = 0;
  p.x0 = 0; p.y0 = 0; p.p0 = 0; p.p1 = 0;
  p.size = 0; p.w = 0; p.h = 0;
  return p;
};

// ---------- drawing helpers ----------

// Rotated filled rectangle without save/translate/rotate — corner math is cheaper.
const fillQuad = (ctx, x, y, hw, hh, rot, color, alpha) => {
  const c = Math.cos(rot), s = Math.sin(rot);
  const ax = c * hw, ay = s * hw, bx = -s * hh, by = c * hh;
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x + ax + bx, y + ay + by);
  ctx.lineTo(x - ax + bx, y - ay + by);
  ctx.lineTo(x - ax - bx, y - ay - by);
  ctx.lineTo(x + ax - bx, y + ay - by);
  ctx.closePath();
  ctx.fill();
};

const drawTexts = (ctx) => {
  if (textCount === 0) return;
  ctx.save();
  ctx.font = TEXT_FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 5;
  ctx.strokeStyle = 'rgba(8,10,14,0.85)';
  for (let i = 0; i < textCount; i++) {
    const t = texts[i];
    const f = t.life / t.ttl;
    const prog = 1 - f;
    const y = t.y - 54 * easeOutCubic(prog);
    const pop = prog < 0.15 ? 0.55 + 0.45 * (prog / 0.15) : 1;
    ctx.globalAlpha = f < 0.35 ? f / 0.35 : 1;
    if (pop !== 1) {
      ctx.save();
      ctx.translate(t.x, y);
      ctx.scale(pop, pop);
      ctx.strokeText(t.text, 0, 0);
      ctx.fillStyle = t.color;
      ctx.fillText(t.text, 0, 0);
      ctx.restore();
    } else {
      ctx.strokeText(t.text, t.x, y);
      ctx.fillStyle = t.color;
      ctx.fillText(t.text, t.x, y);
    }
  }
  ctx.restore();
};

// ---------- public API ----------

export const fx = {
  setEffectsLevel(level) {
    reduced = level === 'reduced';
    cap = reduced ? CAP_REDUCED : CAP_FULL;
    if (count > cap) count = cap;
    if (reduced) trauma = 0;
  },

  update(dt) {
    if (!(dt > 0)) return;
    if (dt > 0.1) dt = 0.1;         // tab-switch guard
    time += dt;
    trauma = Math.max(0, trauma - TRAUMA_DECAY * dt);

    const drag = Math.max(0, 1 - 1.6 * dt);
    const sparkDrag = Math.max(0, 1 - 6 * dt);
    const hotDrag = Math.max(0, 1 - 2.8 * dt);
    const confDrag = Math.max(0, 1 - 0.4 * dt);

    for (let i = count - 1; i >= 0; i--) {
      const p = pool[i];
      p.life -= dt;
      if (p.life <= 0) {
        count--;
        pool[i] = pool[count];
        pool[count] = p;
        continue;
      }
      if (p.life > p.ttl) continue;  // delayed start (staggered portal rings)
      switch (p.kind) {
        case K_SHARD:
          p.vy += p.g * dt;
          p.vx *= drag;
          p.x += p.vx * dt; p.y += p.vy * dt;
          p.rot += p.vr * dt;
          break;
        case K_SPARK:
          p.vx *= sparkDrag; p.vy *= sparkDrag;
          p.x += p.vx * dt; p.y += p.vy * dt;
          break;
        case K_PUFF:
          p.x += p.vx * dt; p.y += p.vy * dt;
          break;
        case K_HOT:
          p.vx *= hotDrag;
          p.vy = p.vy * hotDrag - 40 * dt;  // embers rise slightly
          p.x += p.vx * dt; p.y += p.vy * dt;
          break;
        case K_SWIRL:
          p.rot += p.vr * dt;
          p.size += p.p1 * dt;
          p.x = p.x0 + Math.cos(p.rot) * p.size;
          p.y = p.y0 + Math.sin(p.rot) * p.size * SWIRL_ASPECT;
          break;
        case K_CONFETTI:
          p.vy *= confDrag;
          p.x += p.vx * dt; p.y += p.vy * dt;
          p.rot += p.vr * dt;
          break;
        // K_RING / K_FLASH / K_PRING are static; radius derives from life in draw
      }
    }

    for (let i = textCount - 1; i >= 0; i--) {
      const t = texts[i];
      t.life -= dt;
      if (t.life <= 0) {
        textCount--;
        texts[i] = texts[textCount];
        texts[textCount] = t;
      }
    }
  },

  draw(ctx) {
    if (count === 0 && textCount === 0) return;
    ctx.save();

    // Pass 1 — solid debris (normal compositing)
    for (let i = 0; i < count; i++) {
      const p = pool[i];
      if (p.life > p.ttl) continue;
      const f = p.life / p.ttl;
      if (p.kind === K_SHARD) {
        fillQuad(ctx, p.x, p.y, p.w / 2, p.h / 2, p.rot, p.color, Math.min(1, f / 0.35));
      } else if (p.kind === K_CONFETTI) {
        const age = p.ttl - p.life;
        const tumble = p.p1 !== 0 ? Math.sin(p.p0 + age * p.p1) : 1;
        const sway = p.p1 !== 0 ? Math.sin(p.p0 * 1.7 + age * p.p1 * 0.6) * 10 : 0;
        fillQuad(ctx, p.x + sway, p.y, p.w / 2, (p.h / 2) * tumble, p.rot, p.color, Math.min(1, f / 0.3));
      }
    }

    // Pass 2 — additive glow (sparks, trails, embers, rings, portal FX)
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < count; i++) {
      const p = pool[i];
      if (p.life > p.ttl) continue;
      const f = p.life / p.ttl;
      switch (p.kind) {
        case K_SPARK:
          ctx.globalAlpha = f;
          ctx.strokeStyle = p.color;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(p.x - p.vx * 0.035, p.y - p.vy * 0.035);
          ctx.stroke();
          break;
        case K_PUFF:
          ctx.globalAlpha = f * 0.5;
          ctx.fillStyle = p.color;
          ctx.beginPath();
          ctx.arc(p.x, p.y, Math.max(0.5, p.size * f), 0, TAU);
          ctx.fill();
          break;
        case K_HOT: {
          const idx = Math.min(24, (f * 24) | 0);
          ctx.globalAlpha = 1;   // ramp encodes its own alpha
          ctx.fillStyle = HOT_RAMP[idx];
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size * (1.6 - 0.8 * f), 0, TAU);
          ctx.fill();
          break;
        }
        case K_RING: {
          const r = p.size * easeOutCubic(1 - f);
          ctx.globalAlpha = f;
          ctx.strokeStyle = p.color;
          ctx.lineWidth = Math.max(1, p.w * f);
          ctx.beginPath();
          ctx.arc(p.x, p.y, r, 0, TAU);
          ctx.stroke();
          break;
        }
        case K_FLASH:
          ctx.globalAlpha = f * f;
          ctx.fillStyle = p.color;
          ctx.beginPath();
          ctx.ellipse(p.x, p.y, p.size * (1.5 - 0.5 * f), p.size * (1.5 - 0.5 * f) * p.p0, 0, 0, TAU);
          ctx.fill();
          break;
        case K_PRING: {
          const r = p.size * easeOutCubic(1 - f);
          const ry = r * p.p0;
          ctx.strokeStyle = p.color;
          ctx.globalAlpha = f * 0.35;              // soft outer glow
          ctx.lineWidth = p.w * 2.6 * f + 2;
          ctx.beginPath();
          ctx.ellipse(p.x, p.y, r, ry, 0, 0, TAU);
          ctx.stroke();
          ctx.globalAlpha = f;                     // crisp core
          ctx.lineWidth = Math.max(1, p.w * f);
          ctx.beginPath();
          ctx.ellipse(p.x, p.y, r, ry, 0, 0, TAU);
          ctx.stroke();
          break;
        }
        case K_SWIRL:
          ctx.globalAlpha = f;
          ctx.fillStyle = p.color;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.h * (0.4 + 0.6 * f), 0, TAU);
          ctx.fill();
          break;
      }
    }
    ctx.restore();

    drawTexts(ctx);
  },

  // Returns the current screen-shake displacement in FIELD units; the engine
  // adds it to the world transform before drawing.
  shakeOffset() {
    if (reduced || trauma <= 0) {
      shakeVec.x = 0; shakeVec.y = 0;
      return shakeVec;
    }
    // Smooth "perlin-ish" noise: incommensurate sine pairs per axis
    const a = trauma * trauma * SHAKE_AMP;
    shakeVec.x = a * (Math.sin(time * 91.7) * 0.55 + Math.sin(time * 47.3 + 1.7) * 0.45);
    shakeVec.y = a * (Math.sin(time * 83.1 + 2.6) * 0.55 + Math.sin(time * 59.9 + 4.1) * 0.45);
    return shakeVec;
  },

  brickBurst(x, y, color, n) {
    let cnt = n ?? (10 + Math.floor(Math.random() * 9));   // 10–18
    if (reduced) cnt = Math.min(cnt, 6);
    // Portal-theme gravity: shards fall toward the nearest field edge
    const gDir = y < FIELD_H / 2 ? -1 : 1;
    for (let i = 0; i < cnt; i++) {
      const p = spawn(K_SHARD);
      const ang = Math.random() * TAU, sp = rand(50, 270);
      p.x = x + rand(-14, 14); p.y = y + rand(-8, 8);
      p.vx = Math.cos(ang) * sp;
      p.vy = Math.sin(ang) * sp - gDir * rand(20, 90);     // small kick against gravity → arcs
      p.g = gDir * rand(550, 900);
      p.w = rand(4, 11); p.h = rand(3, 7);
      p.rot = Math.random() * TAU; p.vr = rand(-11, 11);
      p.ttl = p.life = rand(0.5, 0.95);
      p.color = color;
    }
  },

  explosion(x, y) {
    let p = spawn(K_RING);
    p.x = x; p.y = y; p.size = 135; p.w = 7; p.color = '#ffffff';
    p.ttl = p.life = 0.45;
    if (!reduced) {
      p = spawn(K_FLASH);
      p.x = x; p.y = y; p.size = 78; p.p0 = 1; p.color = '#ffffff';
      p.ttl = p.life = 0.13;
    }
    const cnt = reduced ? 10 : 30;
    for (let i = 0; i < cnt; i++) {
      p = spawn(K_HOT);
      const ang = Math.random() * TAU, sp = rand(50, 430);
      p.x = x; p.y = y;
      p.vx = Math.cos(ang) * sp; p.vy = Math.sin(ang) * sp;
      p.size = rand(3, 7.5);
      p.ttl = p.life = rand(0.45, 0.9);
    }
  },

  portalFlash(x, y, side) {
    const color = side === 'bottom' ? PORTAL_ORANGE : PORTAL_BLUE;
    const rings = reduced ? 1 : 2;
    for (let i = 0; i < rings; i++) {
      const p = spawn(K_PRING);
      p.x = x; p.y = y; p.color = color;
      p.size = i === 0 ? 95 : 68;
      p.p0 = 0.34; p.w = 6;
      p.ttl = 0.3;
      p.life = 0.3 + i * 0.07;   // second ring fires 70 ms later; whole effect < 400 ms
    }
    if (!reduced) {
      const p = spawn(K_FLASH);
      p.x = x; p.y = y; p.size = 55; p.p0 = SWIRL_ASPECT; p.color = color;
      p.ttl = p.life = 0.12;
    }
    const swirls = reduced ? 4 : 12;
    for (let i = 0; i < swirls; i++) {
      const p = spawn(K_SWIRL);
      p.x0 = x; p.y0 = y; p.color = color;
      p.rot = (i / swirls) * TAU + rand(-0.3, 0.3);
      p.vr = (i % 2 ? 1 : -1) * rand(5, 9);
      p.size = rand(8, 26);        // orbit radius, grows outward
      p.p1 = rand(90, 190);        // radial growth px/s
      p.h = rand(2, 3.6);          // dot size
      p.ttl = p.life = rand(0.24, 0.38);
      p.x = x + Math.cos(p.rot) * p.size;
      p.y = y + Math.sin(p.rot) * p.size * SWIRL_ASPECT;
    }
  },

  trail(x, y, color) {
    if (reduced) return;
    const p = spawn(K_PUFF);
    p.x = x + rand(-2, 2); p.y = y + rand(-2, 2);
    p.vx = rand(-14, 14); p.vy = rand(-14, 14);
    p.size = rand(5, 8);
    p.ttl = p.life = 0.22;
    p.color = color;
  },

  floatText(x, y, text, color = '#ffffff') {
    let t;
    if (textCount < TEXT_MAX) {
      t = texts[textCount++];
    } else {
      let oldest = 0;
      for (let i = 1; i < textCount; i++) if (texts[i].seq < texts[oldest].seq) oldest = i;
      t = texts[oldest];
    }
    t.seq = ++seq;
    t.text = String(text);
    t.x = Math.max(64, Math.min(FIELD_W - 64, x));
    t.y = Math.max(50, Math.min(FIELD_H - 50, y));
    t.color = color;
    t.ttl = t.life = 0.95;
  },

  sparks(x, y, color, dir) {
    const cnt = reduced ? 3 : 4 + Math.floor(Math.random() * 5);   // 4–8
    for (let i = 0; i < cnt; i++) {
      const p = spawn(K_SPARK);
      const ang = dir == null ? Math.random() * TAU : dir + rand(-0.55, 0.55);
      const sp = rand(180, 480);
      p.x = x; p.y = y;
      p.vx = Math.cos(ang) * sp; p.vy = Math.sin(ang) * sp;
      p.ttl = p.life = rand(0.14, 0.3);
      p.color = color;
    }
  },

  confetti() {
    const cnt = reduced ? 30 : 120;
    for (let i = 0; i < cnt; i++) {
      const p = spawn(K_CONFETTI);
      const fromTop = i % 2 === 0;
      p.x = Math.random() * FIELD_W;
      p.y = fromTop ? -12 : FIELD_H + 12;
      p.vx = rand(-70, 70);
      p.vy = (fromTop ? 1 : -1) * rand(130, 330);
      p.w = rand(7, 14); p.h = rand(4, 9);
      p.rot = Math.random() * TAU; p.vr = rand(-8, 8);
      p.p0 = Math.random() * TAU;
      p.p1 = reduced ? 0 : rand(5, 10);   // flutter frequency; 0 = no flutter
      p.ttl = p.life = rand(1.3, 2.2);
      p.color = CONFETTI_COLORS[(Math.random() * CONFETTI_COLORS.length) | 0];
    }
  },

  shake(strength) {
    if (reduced) return;
    trauma = Math.min(1, trauma + Math.max(0, Math.min(1, strength)));
  },

  clear() {
    count = 0;
    textCount = 0;
    trauma = 0;
  },
};
