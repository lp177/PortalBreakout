// PortalBreakout — game simulation, canvas renderer, HUD (see CONTRACT.md "js/engine.js")

import {
  FIELD_W, FIELD_H, GRID_COLS, GRID_ROWS, BRICK_W, BRICK_H, GRID_TOP,
  PADDLE_W, PADDLE_H, PADDLE_W_EXPANDED, PADDLE_TOP_Y, PADDLE_BOTTOM_Y,
  PADDLE_SPEED, BALL_R, BALL_SPEED, BALL_SPEED_MAX, SPEED_UP, PORTAL_ENGLISH,
  MIN_VY_RATIO, POWERUP_SPEED, POWERUP_R, POWERUP_DROP_CHANCE,
  LIVES_START, MAX_BALLS,
} from './constants.js';
import { BRICK_TYPES, LEVELS } from './levels.js';
import { audio } from './audio.js';
import { fx } from './particles.js';
import { input } from './input.js';
import { net } from './net.js';

const STEP = 1 / 120;
const BOTTOM_PLANE = PADDLE_BOTTOM_Y - PADDLE_H / 2; // field-facing surface of bottom paddle
const TOP_PLANE = PADDLE_TOP_Y + PADDLE_H / 2;       // field-facing surface of top paddle
const GRID_BOTTOM = GRID_TOP + GRID_ROWS * BRICK_H;
const GRID_MID_Y = GRID_TOP + (GRID_ROWS * BRICK_H) / 2;
const COUNTDOWN_LEN = 2.1;                            // 3 ticks × 0.7 s
const ORANGE = '#ff9800', BLUE = '#40c4ff';

const POWERUP_INFO = {
  multi:  { glyph: 'M',  color: '#42a5f5', label: 'Multiball' },
  expand: { glyph: 'E',  color: '#66bb6a', label: 'Expand' },
  slow:   { glyph: 'S',  color: '#26c6da', label: 'Slow' },
  sticky: { glyph: 'C',  color: '#ab47bc', label: 'Sticky' },
  laser:  { glyph: 'L',  color: '#ef5350', label: 'Lasers' },
  life:   { glyph: '+1', color: '#ec407a', label: 'Extra life' },
  fire:   { glyph: 'F',  color: '#ff7043', label: 'Fireball' },
};

// ---- module state (no DOM access until mount()) ----
let canvas = null, ctx = null, resizeObs = null;
const view = { scale: 1, ox: 0, oy: 0, dpr: 1 };
let callbacks = {};
let settings = null, reduced = false, assist = false;

let mode = 'solo';           // 'solo' | 'host' | 'guest'
let phase = 'idle';          // idle|countdown|serve|playing|paused|levelclear|gameover
let running = false, rafId = 0, lastTs = 0, acc = 0, clock = 0;
let timeScale = 1, slowmoT = 0, clearPending = false;

let score = 0, lives = LIVES_START, combo = 0, levelIdx = 0, elapsed = 0;
let levelName = '';
let balls = [], bricks = [], powerups = [], lasers = [], delayed = [];
let paddles = null;
let timers = { expand: 0, slow: 0, laser: 0, fire: 0, stickyCharges: 0 };
const laserCd = { bottom: 0, top: 0 };
let countdownT = 0, lastTick = 0, resumeT = 0, vignetteT = 0;
let pausedFrom = null, pauseReason = null;
let destructibleLeft = 0;
let stars = [];

// multiplayer
let guestInput = { x: FIELD_W / 2, fire: false };
let sendAcc = 0;
let snapPrev = null, snapCur = null;   // guest snapshot pair {msg, t}
let guestPadX = FIELD_W / 2;           // guest's locally-predicted top paddle
let remotePaused = false;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const rand = (a, b) => a + Math.random() * (b - a);

const roundRectPath = (c, x, y, w, h, r) => {
  r = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
};

const hostSend = (msg) => { if (mode === 'host' && net.connected) net.send(msg); };
const hostEv = (name, x, y, extra) => hostSend({ t: 'ev', name, x: Math.round(x ?? 0), y: Math.round(y ?? 0), extra });

// ---- sizing ----
const resize = () => {
  if (!canvas) return;
  const r = canvas.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return; // hidden screen
  view.dpr = window.devicePixelRatio || 1;
  const bw = Math.round(r.width * view.dpr), bh = Math.round(r.height * view.dpr);
  if (canvas.width !== bw) canvas.width = bw;
  if (canvas.height !== bh) canvas.height = bh;
  view.scale = Math.min(r.width / FIELD_W, r.height / FIELD_H);
  view.ox = (r.width - FIELD_W * view.scale) / 2;
  view.oy = (r.height - FIELD_H * view.scale) / 2;
};

const mount = (cv) => {
  canvas = cv;
  ctx = canvas.getContext('2d');
  resizeObs = new ResizeObserver(resize);
  resizeObs.observe(canvas.parentElement ?? canvas);
  window.addEventListener('resize', resize);
  input.attach(canvas);
  input.setMapper((cx, cy) => {
    const r = canvas.getBoundingClientRect();
    return {
      x: (cx - r.left - view.ox) / view.scale,
      y: (cy - r.top - view.oy) / view.scale,
    };
  });
  resize();
};

// ---- level / entities ----
const makePaddles = () => ({
  bottom: { x: FIELD_W / 2, w: PADDLE_W, y: PADDLE_BOTTOM_Y },
  top:    { x: FIELD_W / 2, w: PADDLE_W, y: PADDLE_TOP_Y },
});

const newBall = () => ({
  x: FIELD_W / 2, y: BOTTOM_PLANE - BALL_R - 2, vx: 0, vy: 0,
  speed: BALL_SPEED, stuck: true, stuckTo: 'bottom', stuckOffset: 0,
  portalCd: 0, prevY: 0,
});

const makeStars = () => {
  const arr = [];
  for (let i = 0; i < 42; i++) {
    arr.push({ x: rand(0, FIELD_W), y: rand(0, FIELD_H), r: rand(0.6, 1.8), p: rand(0, Math.PI * 2) });
  }
  return arr;
};

const buildBricks = (idx) => {
  const lvl = LEVELS[idx];
  levelName = lvl?.name ?? '';
  const out = [];
  let left = 0;
  for (let row = 0; row < GRID_ROWS; row++) {
    const line = lvl?.rows?.[row] ?? '';
    for (let col = 0; col < GRID_COLS; col++) {
      const ch = line[col] ?? '.';
      const info = BRICK_TYPES[ch];
      if (!info) { out.push(null); continue; }
      out.push({ type: ch, hp: info.hp, x: col * BRICK_W, y: GRID_TOP + row * BRICK_H, alive: true });
      if (info.hp !== Infinity) left++;
    }
  }
  bricks = out;
  destructibleLeft = left;
  stars = makeStars();
};

const beginCountdown = () => {
  phase = 'countdown';
  countdownT = COUNTDOWN_LEN;
  lastTick = 0;
  hostSend({ t: 'phase', v: 'countdown' });
};

const setupLevel = (idx) => {
  levelIdx = idx;
  score = 0; lives = LIVES_START; combo = 0; elapsed = 0;
  timers = { expand: 0, slow: 0, laser: 0, fire: 0, stickyCharges: 0 };
  laserCd.bottom = 0; laserCd.top = 0;
  balls = [newBall()]; powerups = []; lasers = []; delayed = [];
  paddles = makePaddles();
  timeScale = 1; slowmoT = 0; clearPending = false;
  vignetteT = 0; resumeT = 0; pausedFrom = null; pauseReason = null;
  buildBricks(idx);
  fx.clear();
  hostSend({ t: 'level', idx });
  beginCountdown();
};

const startLoop = () => {
  if (running) return;
  running = true;
  lastTs = 0; acc = 0; sendAcc = 0;
  const loop = (ts) => {
    if (!running) return;
    rafId = requestAnimationFrame(loop);
    frame(ts);
  };
  rafId = requestAnimationFrame(loop);
};

// ---- lifecycle ----
const startSolo = (idx, opts = {}) => { void opts; mode = 'solo'; startLoop(); setupLevel(idx); };
const startHost = (idx) => { mode = 'host'; guestInput = { x: FIELD_W / 2, fire: false }; startLoop(); setupLevel(idx); };
const startGuest = () => {
  mode = 'guest';
  phase = 'idle';
  score = 0; lives = LIVES_START; combo = 0; elapsed = 0;
  balls = []; bricks = []; powerups = []; lasers = []; delayed = [];
  paddles = makePaddles();
  timers = { expand: 0, slow: 0, laser: 0, fire: 0, stickyCharges: 0 };
  snapPrev = null; snapCur = null; remotePaused = false;
  guestPadX = FIELD_W / 2;
  levelName = ''; stars = makeStars();
  fx.clear();
  startLoop();
};

const quit = () => {
  hostSend({ t: 'phase', v: 'backtomenu' });
  running = false;
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
  phase = 'idle';
  balls = []; powerups = []; lasers = []; delayed = [];
  snapPrev = null; snapCur = null; remotePaused = false;
  timeScale = 1; slowmoT = 0; clearPending = false;
  fx.clear();
  input.reset();
};

const pause = (reason) => {
  if (phase !== 'playing' && phase !== 'serve' && phase !== 'countdown') return;
  pausedFrom = phase;
  pauseReason = reason ?? 'user';
  phase = 'paused';
  callbacks.onPauseChange?.(true, pauseReason);
  hostSend({ t: 'phase', v: 'paused' });
};

const resume = () => {
  if (phase !== 'paused') return;
  phase = pausedFrom ?? 'playing';
  pausedFrom = null; pauseReason = null;
  resumeT = 0.8; // mini-countdown before physics restarts
  callbacks.onPauseChange?.(false);
  hostSend({ t: 'phase', v: 'resumed' });
};

// Host-only, beyond the contract list (documented): reclaim the top paddle for
// local input after the guest is gone. main.js calls this from "Continue solo".
const convertToSolo = () => {
  if (mode === 'guest') return;
  mode = 'solo';
};

const nextLevel = () => {
  if (mode === 'guest') return;               // host drives level flow
  if (levelIdx + 1 >= LEVELS.length) return;  // main treats last level itself
  setupLevel(levelIdx + 1);
};

const retryLevel = () => {
  if (mode === 'guest') return;
  setupLevel(levelIdx);
};

const applySettings = (s) => {
  settings = s;
  reduced = s.effects === 'reduced';
  assist = Boolean(s.assist);
  input.applySettings(s);
  fx.setEffectsLevel(s.effects);
  audio.applySettings(s.audio);
};

const setCallbacks = (cbs) => { callbacks = cbs ?? {}; };

// ---- frame loop ----
const frame = (ts) => {
  const dtMs = lastTs ? Math.min(ts - lastTs, 50) : 16;
  lastTs = ts;
  const dt = dtMs / 1000;
  clock += dt;

  const inp = input.state();

  // edge-triggered pause toggles for every mode
  if (inp.pause) {
    if (phase === 'paused') resume();
    else pause('user');
  }

  if (slowmoT > 0) {
    slowmoT -= dt;
    if (slowmoT <= 0) {
      timeScale = 1;
      if (clearPending) finishClear();
    }
  }
  if (vignetteT > 0) vignetteT -= dt;
  if (resumeT > 0 && phase !== 'paused') resumeT -= dt;

  fx.update(dt);

  if (mode === 'guest') {
    guestFrame(dt, inp);
  } else {
    hostFrame(dt, inp);
  }

  render();
};

const hostFrame = (dt, inp) => {
  if (phase === 'countdown') {
    tickCountdown(dt);
    movePaddles(dt, inp);
    followStuck();
  } else if ((phase === 'serve' || phase === 'playing') && resumeT <= 0) {
    elapsed += dt;
    acc += dt * timeScale;
    let guard = 0;
    while (acc >= STEP && guard++ < 24) {
      acc -= STEP;
      step(STEP, inp);
      if (phase !== 'serve' && phase !== 'playing') break;
    }
    if (inp.launch && (phase === 'serve' || phase === 'playing')) launchStuck();
  } else if (phase === 'levelclear' || phase === 'gameover' || phase === 'paused') {
    // idle: render only
  }

  if (mode === 'host' && net.connected) {
    sendAcc += dt;
    if (sendAcc >= 0.04) {
      sendAcc = 0;
      hostSend({
        t: 'state',
        balls: balls.map((b) => [Math.round(b.x), Math.round(b.y)]),
        pb: Math.round(paddles.bottom.x), pt: Math.round(paddles.top.x),
        lasers: lasers.map((l) => [Math.round(l.x), Math.round(l.y), l.dir]),
        pups: powerups.map((p) => [Math.round(p.x), Math.round(p.y), p.kind]),
        score, lives, combo,
      });
    }
  }
};

const tickCountdown = (dt) => {
  countdownT -= dt;
  const n = Math.ceil(countdownT / 0.7);
  if (n !== lastTick && n >= 1 && n <= 3) {
    lastTick = n;
    audio.sfx('countdown');
  }
  if (countdownT <= 0) {
    phase = mode === 'guest' ? 'playing' : 'serve';
  }
};

// ---- paddles ----
const movePaddle = (p, move, targetX, dt) => {
  if (move) {
    p.x += move * PADDLE_SPEED * dt;
  } else if (targetX !== null && targetX !== undefined) {
    const maxStep = PADDLE_SPEED * 3 * dt; // snappy pointer follow, no teleport
    p.x += clamp(targetX - p.x, -maxStep, maxStep);
  }
  p.x = clamp(p.x, p.w / 2, FIELD_W - p.w / 2);
};

const movePaddles = (dt, inp) => {
  // paddle width tween (expand powerup)
  const targetW = timers.expand > 0 ? PADDLE_W_EXPANDED : PADDLE_W;
  for (const p of [paddles.bottom, paddles.top]) {
    p.w += (targetW - p.w) * Math.min(1, dt * 10);
    if (Math.abs(p.w - targetW) < 0.5) p.w = targetW;
  }

  movePaddle(paddles.bottom, inp.bottom.move, inp.bottom.targetX, dt);

  if (mode === 'host' && net.connected) {
    const p = paddles.top;
    const maxStep = PADDLE_SPEED * 3 * dt;
    p.x += clamp(clamp(guestInput.x, p.w / 2, FIELD_W - p.w / 2) - p.x, -maxStep, maxStep);
  } else if (assist && mode === 'solo') {
    paddles.top.x = clamp(paddles.bottom.x, paddles.top.w / 2, FIELD_W - paddles.top.w / 2);
  } else {
    movePaddle(paddles.top, inp.top.move, inp.top.targetX, dt);
  }
};

const followStuck = () => {
  for (const b of balls) {
    if (!b.stuck) continue;
    const p = paddles[b.stuckTo];
    b.x = clamp(p.x + b.stuckOffset * (p.w / 2), BALL_R, FIELD_W - BALL_R);
    b.y = b.stuckTo === 'bottom' ? BOTTOM_PLANE - BALL_R - 2 : TOP_PLANE + BALL_R + 2;
    b.prevY = b.y;
  }
};

const launchStuck = () => {
  let any = false;
  for (const b of balls) {
    if (!b.stuck) continue;
    any = true;
    const dev = (b.stuckOffset * 35 + rand(-10, 10)) * Math.PI / 180;
    const sp = b.speed || BALL_SPEED;
    b.vx = Math.sin(dev) * sp;
    b.vy = (b.stuckTo === 'bottom' ? -1 : 1) * Math.cos(dev) * sp;
    b.stuck = false;
    b.portalCd = 0.08;
  }
  if (any) {
    audio.sfx('launch');
    hostEv('launch');
    if (phase === 'serve') {
      phase = 'playing';
      hostSend({ t: 'phase', v: 'playing' });
    }
  }
};

// ---- physics step (host/solo only) ----
const step = (dt, inp) => {
  for (const k of ['expand', 'slow', 'laser', 'fire']) {
    if (timers[k] > 0) timers[k] = Math.max(0, timers[k] - dt);
  }
  laserCd.bottom = Math.max(0, laserCd.bottom - dt);
  laserCd.top = Math.max(0, laserCd.top - dt);

  movePaddles(dt, inp);
  followStuck();

  if (timers.laser > 0) {
    const bottomFire = mode === 'host' && net.connected
      ? inp.bottom.fire || inp.top.fire
      : inp.bottom.fire;
    const topFire = mode === 'host' && net.connected ? guestInput.fire : inp.top.fire;
    if (bottomFire) shootLaser('bottom');
    if (topFire) shootLaser('top');
  }

  moveBalls(dt);
  movePowerups(dt);
  moveLasers(dt);
  tickDelayed(dt);
};

const renorm = (b) => {
  const m = Math.hypot(b.vx, b.vy) || 1;
  b.vx *= b.speed / m;
  b.vy *= b.speed / m;
};

const enforceMinVy = (b) => {
  const min = MIN_VY_RATIO * b.speed;
  if (Math.abs(b.vy) >= min) return;
  const sign = b.vy !== 0 ? Math.sign(b.vy) : (b.y < FIELD_H / 2 ? 1 : -1);
  b.vy = sign * min;
  const vxMag = Math.sqrt(Math.max(0, b.speed * b.speed - min * min));
  b.vx = (b.vx >= 0 ? 1 : -1) * vxMag;
};

const teleport = (ball, entrySide) => {
  const exitSide = entrySide === 'bottom' ? 'top' : 'bottom';
  const entry = paddles[entrySide], exit = paddles[exitSide];
  const offset = clamp((ball.x - entry.x) / (entry.w / 2), -1, 1);
  const ex = ball.x, ey = entrySide === 'bottom' ? BOTTOM_PLANE : TOP_PLANE;

  ball.x = clamp(exit.x + offset * (exit.w / 2), BALL_R, FIELD_W - BALL_R);
  ball.y = exitSide === 'top' ? TOP_PLANE + BALL_R + 2 : BOTTOM_PLANE - BALL_R - 2;
  ball.prevY = ball.y;
  ball.vx += offset * PORTAL_ENGLISH;      // portal english: the core skill mechanic
  ball.speed = Math.min(ball.speed * SPEED_UP, BALL_SPEED_MAX);
  renorm(ball);
  enforceMinVy(ball);
  ball.portalCd = 0.08;
  combo = 0;

  fx.portalFlash(ex, ey, entrySide);
  fx.portalFlash(ball.x, ball.y, exitSide);
  audio.sfx('portal');
  fx.shake(0.12);
  hostEv('portal', ex, ey, { x2: Math.round(ball.x), y2: Math.round(ball.y), s1: entrySide, s2: exitSide });

  if (timers.stickyCharges > 0) {
    timers.stickyCharges--;
    ball.stuck = true;
    ball.stuckTo = exitSide;
    ball.stuckOffset = offset;
    ball.vx = 0; ball.vy = 0;
    audio.sfx('stick');
    hostEv('stick', ball.x, ball.y);
  }
};

const moveBalls = (dt) => {
  for (let i = balls.length - 1; i >= 0; i--) {
    const b = balls[i];
    if (b.stuck) continue;
    if (b.portalCd > 0) b.portalCd -= dt;

    const eff = timers.slow > 0 ? Math.max(b.speed * 0.7, BALL_SPEED * 0.7) : b.speed;
    const mul = eff / (Math.hypot(b.vx, b.vy) || 1);
    b.prevY = b.y;
    b.x += b.vx * mul * dt;
    b.y += b.vy * mul * dt;

    // side walls
    if (b.x - BALL_R < 0) {
      b.x = BALL_R; b.vx = Math.abs(b.vx);
      audio.sfx('wall'); fx.sparks(0, b.y, '#9fb6ff', 1);
      hostEv('wall', 0, b.y);
    } else if (b.x + BALL_R > FIELD_W) {
      b.x = FIELD_W - BALL_R; b.vx = -Math.abs(b.vx);
      audio.sfx('wall'); fx.sparks(FIELD_W, b.y, '#9fb6ff', -1);
      hostEv('wall', FIELD_W, b.y);
    }

    // portal crossings (surface plane, moving into the paddle, within its width)
    if (b.portalCd <= 0) {
      const pb = paddles.bottom, pt = paddles.top;
      if (b.vy > 0 && b.prevY + BALL_R < BOTTOM_PLANE && b.y + BALL_R >= BOTTOM_PLANE
          && Math.abs(b.x - pb.x) <= pb.w / 2 + BALL_R) {
        teleport(b, 'bottom');
        continue;
      }
      if (b.vy < 0 && b.prevY - BALL_R > TOP_PLANE && b.y - BALL_R <= TOP_PLANE
          && Math.abs(b.x - pt.x) <= pt.w / 2 + BALL_R) {
        teleport(b, 'top');
        continue;
      }
    }

    // lost beyond top/bottom edge
    if (b.y - BALL_R > FIELD_H || b.y + BALL_R < 0) {
      balls.splice(i, 1);
      if (balls.length === 0) loseLife();
      continue;
    }

    collideBricks(b);
  }
};

const collideBricks = (b) => {
  if (b.y - BALL_R > GRID_BOTTOM + 60 || b.y + BALL_R < GRID_TOP - 60) return;
  const c0 = clamp(Math.floor((b.x - BALL_R) / BRICK_W), 0, GRID_COLS - 1);
  const c1 = clamp(Math.floor((b.x + BALL_R) / BRICK_W), 0, GRID_COLS - 1);
  const r0 = clamp(Math.floor((b.y - BALL_R - GRID_TOP) / BRICK_H), 0, GRID_ROWS - 1);
  const r1 = clamp(Math.floor((b.y + BALL_R - GRID_TOP) / BRICK_H), 0, GRID_ROWS - 1);
  for (let row = r0; row <= r1; row++) {
    for (let col = c0; col <= c1; col++) {
      const brick = bricks[row * GRID_COLS + col];
      if (!brick?.alive) continue;
      const cx = brick.x + BRICK_W / 2, cy = brick.y + BRICK_H / 2;
      const dx = b.x - cx, dy = b.y - cy;
      const ox = BRICK_W / 2 + BALL_R - Math.abs(dx);
      const oy = BRICK_H / 2 + BALL_R - Math.abs(dy);
      if (ox <= 0 || oy <= 0) continue;

      const destructible = brick.hp !== Infinity;
      if (b.stuck) return;
      if (timers.fire > 0 && destructible) {
        hitBrick(brick, Math.max(1, brick.hp)); // fireball pierces: destroy, no bounce
        return;
      }
      if (ox < oy) {
        b.x += Math.sign(dx) * ox;
        b.vx = Math.sign(dx) * Math.abs(b.vx);
      } else {
        b.y += Math.sign(dy) * oy;
        b.vy = Math.sign(dy) * Math.abs(b.vy);
      }
      hitBrick(brick, 1);
      return;
    }
  }
};

const brickIndex = (brick) => bricks.indexOf(brick);

const hitBrick = (brick, dmg) => {
  if (!brick.alive) return;
  const cx = brick.x + BRICK_W / 2, cy = brick.y + BRICK_H / 2;
  const info = BRICK_TYPES[brick.type];
  if (brick.hp === Infinity) {
    audio.sfx('gold');
    fx.sparks(cx, cy, info.color);
    hostEv('gold', cx, cy);
    return;
  }
  brick.hp -= dmg;
  if (brick.hp > 0) {
    audio.sfx('silver');
    fx.sparks(cx, cy, info.color);
    hostSend({ t: 'brick', idx: brickIndex(brick), hp: brick.hp });
    return;
  }
  brick.alive = false;
  destructibleLeft--;
  score += Math.round(info.points * (1 + combo * 0.1));
  combo++;
  audio.sfx('brick', { combo });
  fx.brickBurst(cx, cy, info.color);
  fx.floatText(cx, cy, `+${info.points}`, info.color);
  hostSend({ t: 'brick', idx: brickIndex(brick), hp: 0 });
  if (brick.type === 'E') explode(brick);
  maybeDrop(brick, cx, cy);
  if (destructibleLeft <= 0) triggerClear();
};

const explode = (brick) => {
  const cx = brick.x + BRICK_W / 2, cy = brick.y + BRICK_H / 2;
  audio.sfx('explode');
  fx.explosion(cx, cy);
  fx.shake(0.5);
  hostEv('explode', cx, cy);
  const idx = brickIndex(brick);
  const row = Math.floor(idx / GRID_COLS), col = idx % GRID_COLS;
  let stagger = 0;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const nr = row + dr, nc = col + dc;
      if (nr < 0 || nr >= GRID_ROWS || nc < 0 || nc >= GRID_COLS) continue;
      const n = bricks[nr * GRID_COLS + nc];
      if (!n?.alive || n.hp === Infinity) continue;
      stagger += 0.02;
      const delay = 0.06 + stagger; // staggered chain: juicy dominoes
      delayed.push({ t: delay, fn: () => { if (n.alive) hitBrick(n, 1); } });
    }
  }
};

const tickDelayed = (dt) => {
  if (!delayed.length) return;
  const due = [];
  for (const a of delayed) {
    a.t -= dt;
    if (a.t <= 0) due.push(a);
  }
  delayed = delayed.filter((a) => a.t > 0);
  for (const a of due) a.fn();
};

const pickPowerupKind = () => {
  const r = Math.random();
  if (r < 0.06) return 'life';
  if (r < 0.18) return 'multi';
  if (r < 0.30) return 'laser';
  if (r < 0.42) return 'fire';
  const rest = (r - 0.42) / 0.58;
  return rest < 1 / 3 ? 'expand' : rest < 2 / 3 ? 'slow' : 'sticky';
};

const maybeDrop = (brick, cx, cy) => {
  if (brick.type !== 'P' && Math.random() >= POWERUP_DROP_CHANCE) return;
  const vy = cy >= GRID_MID_Y ? POWERUP_SPEED : -POWERUP_SPEED;
  powerups.push({ x: cx, y: cy, vy, kind: pickPowerupKind() });
  audio.sfx('drop');
  hostEv('drop', cx, cy);
};

const applyPowerup = (kind, x, y) => {
  const info = POWERUP_INFO[kind];
  audio.sfx('powerup');
  fx.floatText(x, y, info.label, info.color);
  fx.sparks(x, y, info.color);
  hostEv('powerup', x, y, kind);
  switch (kind) {
    case 'multi': {
      const src = balls.filter((b) => !b.stuck);
      for (const b of src) {
        for (const ang of [-25 * Math.PI / 180, 25 * Math.PI / 180]) {
          if (balls.length >= MAX_BALLS) break;
          const cos = Math.cos(ang), sin = Math.sin(ang);
          balls.push({
            ...b, stuck: false,
            vx: b.vx * cos - b.vy * sin,
            vy: b.vx * sin + b.vy * cos,
            portalCd: b.portalCd,
          });
        }
      }
      break;
    }
    case 'expand': timers.expand = 15; break;
    case 'slow': timers.slow = 10; break;
    case 'sticky': timers.stickyCharges = Math.min(timers.stickyCharges + 3, 9); break;
    case 'laser': timers.laser = 10; break;
    case 'life': lives = Math.min(lives + 1, 9); break;
    case 'fire': timers.fire = 8; break;
  }
};

const movePowerups = (dt) => {
  for (let i = powerups.length - 1; i >= 0; i--) {
    const p = powerups[i];
    p.y += p.vy * dt;
    let caught = false;
    for (const side of ['bottom', 'top']) {
      const pad = paddles[side];
      if (Math.abs(p.x - pad.x) <= pad.w / 2 + POWERUP_R
          && Math.abs(p.y - pad.y) <= PADDLE_H / 2 + POWERUP_R) {
        applyPowerup(p.kind, p.x, p.y);
        caught = true;
        break;
      }
    }
    if (caught || p.y - POWERUP_R > FIELD_H || p.y + POWERUP_R < 0) powerups.splice(i, 1);
  }
};

const shootLaser = (side) => {
  if (laserCd[side] > 0) return;
  laserCd[side] = 0.25; // max 4 shots/s per paddle
  const pad = paddles[side];
  const dir = side === 'bottom' ? -1 : 1;
  const y = side === 'bottom' ? BOTTOM_PLANE : TOP_PLANE;
  lasers.push({ x: pad.x, y, dir });
  audio.sfx('laser');
  hostEv('laser', pad.x, y);
};

const moveLasers = (dt) => {
  for (let i = lasers.length - 1; i >= 0; i--) {
    const l = lasers[i];
    l.y += l.dir * 900 * dt;
    if (l.y < -20 || l.y > FIELD_H + 20) { lasers.splice(i, 1); continue; }
    if (l.y < GRID_TOP - 10 || l.y > GRID_BOTTOM + 10) continue;
    const col = clamp(Math.floor(l.x / BRICK_W), 0, GRID_COLS - 1);
    const row = Math.floor((l.y - GRID_TOP) / BRICK_H);
    if (row < 0 || row >= GRID_ROWS) continue;
    const brick = bricks[row * GRID_COLS + col];
    if (!brick?.alive) continue;
    if (brick.hp === Infinity) {
      audio.sfx('gold');
      fx.sparks(l.x, l.y, BRICK_TYPES.G.color);
      hostEv('gold', l.x, l.y);
    } else {
      hitBrick(brick, 1);
    }
    lasers.splice(i, 1);
  }
};

const loseLife = () => {
  lives--;
  combo = 0;
  audio.sfx('lifeLost');
  fx.shake(0.8);
  vignetteT = 0.6;
  hostEv('lifeLost', FIELD_W / 2, FIELD_H / 2);
  if (lives > 0) {
    balls = [newBall()];
    beginCountdown();
  } else {
    phase = 'gameover';
    audio.sfx('gameOver');
    hostSend({ t: 'phase', v: 'gameover' });
    hostEv('gameOver');
    callbacks.onGameOver?.({ levelIdx, score, timeMs: Math.round(elapsed * 1000) });
    callbacks.onLevelEnd?.({ levelIdx, score, timeMs: Math.round(elapsed * 1000), cleared: false });
  }
};

const triggerClear = () => {
  if (clearPending || phase === 'levelclear') return;
  clearPending = true;
  if (reduced) {
    finishClear();
  } else {
    slowmoT = 0.35; // slow-mo moment on the last brick
    timeScale = 0.25;
  }
};

const finishClear = () => {
  clearPending = false;
  timeScale = 1;
  phase = 'levelclear';
  audio.sfx('levelClear');
  fx.confetti();
  hostSend({ t: 'phase', v: 'levelclear' });
  hostEv('levelClear');
  callbacks.onLevelEnd?.({ levelIdx, score, timeMs: Math.round(elapsed * 1000), cleared: true });
};

// ---- multiplayer: guest side ----
const guestFrame = (dt, inp) => {
  if (phase === 'countdown') tickCountdown(dt);
  if (phase === 'playing' && !remotePaused) elapsed += dt;

  // all local input channels drive the guest's (top) paddle
  const move = inp.top.move || inp.bottom.move;
  const targetX = inp.top.targetX ?? inp.bottom.targetX;
  const pad = paddles.top;
  const targetW = timers.expand > 0 ? PADDLE_W_EXPANDED : PADDLE_W;
  pad.w += (targetW - pad.w) * Math.min(1, dt * 10);
  paddles.bottom.w = pad.w;
  const fake = { x: guestPadX, w: pad.w };
  movePaddle(fake, move, targetX, dt);
  guestPadX = fake.x;
  pad.x = guestPadX; // client-side prediction of own paddle only

  for (const k of ['expand', 'fire']) {
    if (timers[k] > 0) timers[k] = Math.max(0, timers[k] - dt);
  }

  sendAcc += dt;
  if (sendAcc >= 1 / 30 && net.connected) {
    sendAcc = 0;
    net.send({ t: 'input', x: Math.round(guestPadX), fire: Boolean(inp.top.fire || inp.bottom.fire) });
  }

  interpolateSnapshots();
};

const interpolateSnapshots = () => {
  if (!snapCur) return;
  const now = performance.now() - 40; // interp delay
  let a = snapPrev, bSnap = snapCur, alpha = 1;
  if (a && bSnap.t > a.t) alpha = clamp((now - a.t) / (bSnap.t - a.t), 0, 1);
  else a = bSnap;
  const lerp = (u, v) => u + (v - u) * alpha;

  const am = a.msg, bm = bSnap.msg;
  balls = bm.balls.map((bb, i) => {
    const ab = am.balls[i] ?? bb;
    return { x: lerp(ab[0], bb[0]), y: lerp(ab[1], bb[1]), stuck: false, fire: timers.fire > 0 };
  });
  paddles.bottom.x = lerp(am.pb, bm.pb);
  lasers = bm.lasers.map((ll, i) => {
    const al = am.lasers[i] ?? ll;
    return { x: lerp(al[0], ll[0]), y: lerp(al[1], ll[1]), dir: ll[2] };
  });
  powerups = bm.pups.map((pp, i) => {
    const ap = am.pups[i] ?? pp;
    return { x: lerp(ap[0], pp[0]), y: lerp(ap[1], pp[1]), kind: pp[2] };
  });
  score = bm.score; lives = bm.lives; combo = bm.combo;
};

const GUEST_EV = {
  portal: (m) => {
    fx.portalFlash(m.x, m.y, m.extra?.s1 ?? 'bottom');
    if (m.extra) fx.portalFlash(m.extra.x2, m.extra.y2, m.extra.s2);
    audio.sfx('portal');
    fx.shake(0.12);
  },
  wall: (m) => { audio.sfx('wall'); fx.sparks(m.x, m.y, '#9fb6ff'); },
  gold: (m) => { audio.sfx('gold'); fx.sparks(m.x, m.y, BRICK_TYPES.G.color); },
  explode: (m) => { audio.sfx('explode'); fx.explosion(m.x, m.y); fx.shake(0.5); },
  lifeLost: () => { audio.sfx('lifeLost'); fx.shake(0.8); vignetteT = 0.6; },
  powerup: (m) => {
    const info = POWERUP_INFO[m.extra];
    audio.sfx('powerup');
    if (info) { fx.floatText(m.x, m.y, info.label, info.color); fx.sparks(m.x, m.y, info.color); }
    if (m.extra === 'expand') timers.expand = 15;
    if (m.extra === 'fire') timers.fire = 8;
  },
  drop: (m) => { audio.sfx('drop'); void m; },
  laser: () => audio.sfx('laser'),
  launch: () => audio.sfx('launch'),
  stick: () => audio.sfx('stick'),
  levelClear: () => { audio.sfx('levelClear'); fx.confetti(); },
  gameOver: () => audio.sfx('gameOver'),
};

const guestPhase = (v) => {
  switch (v) {
    case 'countdown':
      phase = 'countdown'; countdownT = COUNTDOWN_LEN; lastTick = 0; remotePaused = false;
      break;
    case 'playing':
    case 'resumed':
      phase = 'playing'; remotePaused = false;
      if (v === 'resumed') resumeT = 0.8;
      break;
    case 'paused':
      remotePaused = true;
      break;
    case 'levelclear':
      phase = 'levelclear'; remotePaused = false;
      callbacks.onLevelEnd?.({ levelIdx, score, timeMs: Math.round(elapsed * 1000), cleared: true });
      break;
    case 'gameover':
      phase = 'gameover'; remotePaused = false;
      callbacks.onLevelEnd?.({ levelIdx, score, timeMs: Math.round(elapsed * 1000), cleared: false });
      break;
    case 'backtomenu':
      quit();
      callbacks.onRemoteQuit?.();
      break;
  }
};

const onNetMessage = (msg) => {
  if (!msg || typeof msg !== 'object' || msg.t === 'hb') return;
  if (mode !== 'guest') {
    if (msg.t === 'input') {
      guestInput.x = clamp(Number(msg.x) || 0, 0, FIELD_W);
      guestInput.fire = Boolean(msg.fire);
    }
    return;
  }
  switch (msg.t) {
    case 'state':
      snapPrev = snapCur;
      snapCur = { msg, t: performance.now() };
      if (phase === 'idle') phase = 'playing';
      break;
    case 'level':
      buildBricks(msg.idx);
      levelIdx = msg.idx;
      score = 0; combo = 0; lives = LIVES_START; elapsed = 0;
      powerups = []; lasers = []; balls = [];
      snapPrev = null; snapCur = null;
      timers = { expand: 0, slow: 0, laser: 0, fire: 0, stickyCharges: 0 };
      fx.clear();
      phase = 'countdown'; countdownT = COUNTDOWN_LEN; lastTick = 0;
      break;
    case 'brick': {
      const b = bricks[msg.idx];
      if (!b) break;
      if (msg.hp > 0) {
        b.hp = msg.hp;
        audio.sfx('silver');
        fx.sparks(b.x + BRICK_W / 2, b.y + BRICK_H / 2, BRICK_TYPES[b.type]?.color ?? '#fff');
      } else if (b.alive) {
        b.alive = false;
        const info = BRICK_TYPES[b.type];
        audio.sfx('brick', { combo });
        fx.brickBurst(b.x + BRICK_W / 2, b.y + BRICK_H / 2, info?.color ?? '#fff');
        if (info?.points) fx.floatText(b.x + BRICK_W / 2, b.y + BRICK_H / 2, `+${info.points}`, info.color);
      }
      break;
    }
    case 'ev':
      GUEST_EV[msg.name]?.(msg);
      break;
    case 'phase':
      guestPhase(msg.v);
      break;
  }
};

// ---- rendering ----
const render = () => {
  if (!ctx) return;
  const { dpr, scale, ox, oy } = view;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#05060a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const s = scale * dpr;
  const shake = phase === 'paused' ? { x: 0, y: 0 } : fx.shakeOffset();
  ctx.setTransform(s, 0, 0, s, ox * dpr + shake.x * s, oy * dpr + shake.y * s);

  // field border glow (drawn unclipped so it blooms outward)
  ctx.save();
  ctx.strokeStyle = 'rgba(64,196,255,0.35)';
  ctx.lineWidth = 3;
  ctx.shadowColor = BLUE;
  ctx.shadowBlur = 18;
  ctx.strokeRect(-1.5, -1.5, FIELD_W + 3, FIELD_H + 3);
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, FIELD_W, FIELD_H);
  ctx.clip();

  drawBackground();
  drawBricks();
  drawPowerups();
  drawLasers();
  drawBalls();
  if (paddles) { drawPaddle('bottom'); drawPaddle('top'); }
  fx.draw(ctx);
  drawHud();
  drawOverlays();

  ctx.restore();
};

const drawBackground = () => {
  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, FIELD_W, FIELD_H);
  ctx.strokeStyle = 'rgba(255,255,255,0.03)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 60; x < FIELD_W; x += 60) { ctx.moveTo(x, 0); ctx.lineTo(x, FIELD_H); }
  for (let y = 60; y < FIELD_H; y += 60) { ctx.moveTo(0, y); ctx.lineTo(FIELD_W, y); }
  ctx.stroke();
  for (const st of stars) {
    const tw = 0.25 + 0.2 * Math.sin(clock * 1.7 + st.p);
    ctx.fillStyle = `rgba(200,220,255,${tw.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(st.x, st.y, st.r, 0, Math.PI * 2);
    ctx.fill();
  }
};

const drawBricks = () => {
  for (const b of bricks) {
    if (!b?.alive) continue;
    const info = BRICK_TYPES[b.type];
    const x = b.x + 2, y = b.y + 2, w = BRICK_W - 4, h = BRICK_H - 4;
    roundRectPath(ctx, x, y, w, h, 6);
    ctx.fillStyle = info.color;
    ctx.fill();
    // top highlight
    roundRectPath(ctx, x + 2, y + 2, w - 4, h * 0.38, 4);
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.fill();
    if (b.type === 'S' && b.hp === 1) {
      // crack on damaged silver
      ctx.strokeStyle = 'rgba(20,20,30,0.7)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x + w * 0.25, y + 3);
      ctx.lineTo(x + w * 0.45, y + h * 0.5);
      ctx.lineTo(x + w * 0.3, y + h - 3);
      ctx.moveTo(x + w * 0.45, y + h * 0.5);
      ctx.lineTo(x + w * 0.7, y + h * 0.62);
      ctx.stroke();
    } else if (b.type === 'G') {
      // metallic sheen sweep
      const t = (clock * 0.35 + (b.x + b.y) / 900) % 1;
      const gx = x + t * w * 1.6 - w * 0.3;
      const g = ctx.createLinearGradient(gx - 14, y, gx + 14, y + h);
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(0.5, 'rgba(255,255,255,0.35)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      roundRectPath(ctx, x, y, w, h, 6);
      ctx.fillStyle = g;
      ctx.fill();
    } else if (b.type === 'E') {
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.beginPath();
      ctx.arc(x + w / 2, y + h / 2, 5 + Math.sin(clock * 6) * 1.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
};

const drawPaddle = (side) => {
  const p = paddles[side];
  const color = side === 'bottom' ? ORANGE : BLUE;
  const x = p.x - p.w / 2, y = p.y - PADDLE_H / 2;
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = 22;
  const g = ctx.createLinearGradient(x, y, x, y + PADDLE_H);
  g.addColorStop(0, side === 'bottom' ? '#ffc266' : '#8fdcff');
  g.addColorStop(1, color);
  roundRectPath(ctx, x, y, p.w, PADDLE_H, PADDLE_H / 2);
  ctx.fillStyle = g;
  ctx.fill();
  // swirling portal surface on the field-facing side
  const sy = side === 'bottom' ? y : y + PADDLE_H;
  ctx.shadowBlur = 14;
  for (let i = 0; i < 2; i++) {
    const ph = clock * (i ? -2.4 : 3.1) + i * 1.7;
    ctx.strokeStyle = i ? 'rgba(255,255,255,0.5)' : color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(p.x, sy, p.w / 2 * (0.75 + 0.2 * Math.sin(ph)), 4 + 1.5 * Math.cos(ph * 1.3), 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
};

const drawBalls = () => {
  for (const b of balls) {
    const fire = timers.fire > 0;
    fx.trail(b.x, b.y, fire ? '#ff7043' : (b.vy > 0 ? ORANGE : BLUE));
    ctx.save();
    if (fire) {
      ctx.shadowColor = '#ff5722';
      ctx.shadowBlur = 20 + Math.sin(clock * 24) * 5;
      ctx.fillStyle = '#ffab40';
    } else {
      ctx.shadowColor = b.vy > 0 ? ORANGE : BLUE;
      ctx.shadowBlur = 16;
      ctx.fillStyle = '#ffffff';
    }
    ctx.beginPath();
    ctx.arc(b.x, b.y, BALL_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.beginPath();
    ctx.arc(b.x - 2, b.y - 2, BALL_R * 0.45, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
};

const drawPowerups = () => {
  for (const p of powerups) {
    const info = POWERUP_INFO[p.kind];
    if (!info) continue;
    const pulse = 1 + 0.12 * Math.sin(clock * 6 + p.x);
    ctx.save();
    ctx.shadowColor = info.color;
    ctx.shadowBlur = 14 * pulse;
    ctx.fillStyle = info.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, POWERUP_R * pulse, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#0d1117';
    ctx.font = `bold ${p.kind === 'life' ? 13 : 17}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(info.glyph, p.x, p.y + 1);
    ctx.restore();
  }
};

const drawLasers = () => {
  ctx.save();
  ctx.shadowColor = '#ff5252';
  ctx.shadowBlur = 10;
  ctx.fillStyle = '#ff8a80';
  for (const l of lasers) ctx.fillRect(l.x - 2, l.y - 9, 4, 18);
  ctx.restore();
};

const drawHud = () => {
  ctx.save();
  ctx.textBaseline = 'middle';
  // score
  ctx.textAlign = 'left';
  ctx.font = 'bold 28px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.fillText(String(score), 16, 24);
  // combo
  if (combo > 1) {
    const pulse = combo > 2 ? 1 + 0.15 * Math.sin(clock * 10) : 1;
    ctx.save();
    ctx.translate(30 + ctx.measureText(String(score)).width + 26, 24);
    ctx.scale(pulse, pulse);
    ctx.font = 'bold 20px system-ui, sans-serif';
    ctx.fillStyle = ORANGE;
    ctx.textAlign = 'left';
    ctx.fillText(`x${combo}`, 0, 0);
    ctx.restore();
  }
  // level name
  ctx.textAlign = 'center';
  ctx.font = '15px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.fillText(`${levelIdx + 1} · ${levelName}`, FIELD_W / 2, 24);
  // lives
  ctx.textAlign = 'right';
  ctx.font = '20px system-ui, sans-serif';
  ctx.fillStyle = '#ef5350';
  ctx.fillText('♥'.repeat(Math.max(0, lives)), FIELD_W - 16, 24);
  // active effect timers, bottom-left strip
  const chips = [];
  if (timers.expand > 0) chips.push(`E ${Math.ceil(timers.expand)}`);
  if (timers.slow > 0) chips.push(`S ${Math.ceil(timers.slow)}`);
  if (timers.laser > 0) chips.push(`L ${Math.ceil(timers.laser)}`);
  if (timers.fire > 0) chips.push(`F ${Math.ceil(timers.fire)}`);
  if (timers.stickyCharges > 0) chips.push(`C ×${timers.stickyCharges}`);
  if (chips.length) {
    ctx.textAlign = 'left';
    ctx.font = 'bold 14px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillText(chips.join('   '), 16, FIELD_H - 14);
  }
  ctx.restore();
};

const centerText = (text, y, px, color, glow) => {
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `bold ${px}px system-ui, sans-serif`;
  if (glow) { ctx.shadowColor = glow; ctx.shadowBlur = 24; }
  ctx.fillStyle = color;
  ctx.fillText(text, FIELD_W / 2, y);
  ctx.restore();
};

const drawOverlays = () => {
  if (vignetteT > 0) {
    const a = Math.min(0.55, vignetteT);
    const g = ctx.createRadialGradient(FIELD_W / 2, FIELD_H / 2, FIELD_H * 0.3, FIELD_W / 2, FIELD_H / 2, FIELD_H * 0.72);
    g.addColorStop(0, 'rgba(239,83,80,0)');
    g.addColorStop(1, `rgba(239,83,80,${a.toFixed(3)})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, FIELD_W, FIELD_H);
  }

  if (phase === 'countdown') {
    const n = Math.max(1, Math.ceil(countdownT / 0.7));
    const frac = 1 - ((countdownT % 0.7) / 0.7);
    const size = 110 + 40 * (reduced ? 0 : frac);
    centerText(String(n), FIELD_H / 2, size, 'rgba(255,255,255,0.95)', BLUE);
  } else if (phase === 'serve' && mode !== 'guest') {
    centerText('Press launch', FIELD_H / 2 + 90, 22, 'rgba(255,255,255,0.5)');
  } else if (phase === 'levelclear') {
    centerText('LEVEL CLEAR!', FIELD_H / 2 - 30, 56, '#ffffff', ORANGE);
  } else if (phase === 'gameover') {
    centerText('GAME OVER', FIELD_H / 2 - 30, 56, '#ffffff', '#ef5350');
  } else if (phase === 'idle' && mode === 'guest') {
    centerText('Waiting for the host to pick a level…', FIELD_H / 2, 24, 'rgba(255,255,255,0.6)');
  }

  if (resumeT > 0 && phase !== 'paused') {
    centerText('Ready…', FIELD_H / 2, 48, 'rgba(255,255,255,0.85)', BLUE);
  }

  if (phase === 'paused' || remotePaused) {
    ctx.fillStyle = 'rgba(5,6,10,0.55)';
    ctx.fillRect(0, 0, FIELD_W, FIELD_H);
    if (remotePaused && phase !== 'paused') {
      centerText('Host paused the game', FIELD_H / 2, 30, 'rgba(255,255,255,0.8)');
    }
  }
};

export const engine = {
  mount,
  startSolo,
  startHost,
  startGuest,
  onNetMessage,
  pause,
  resume,
  quit,
  convertToSolo, // documented extra: host reclaims top paddle ("Continue solo")
  setCallbacks,
  nextLevel,
  retryLevel,
  applySettings,
};

