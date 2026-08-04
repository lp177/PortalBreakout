// PortalBreakout — game simulation, canvas renderer, HUD (see CONTRACT.md "js/engine.js")

import {
  FIELD_W, FIELD_H, GRID_COLS, GRID_ROWS, BRICK_W, BRICK_H, GRID_TOP,
  PADDLE_W, PADDLE_H, PADDLE_W_EXPANDED, PADDLE_TOP_Y, PADDLE_BOTTOM_Y,
  PADDLE_SPEED, BALL_R, BALL_SPEED, BALL_SPEED_MAX, SPEED_UP, PORTAL_ENGLISH,
  MIN_VY_RATIO, POWERUP_SPEED, POWERUP_R, POWERUP_DROP_CHANCE,
  LIVES_START, MAX_BALLS,
  VS_LIVES, VS_LIFE_MAX, VS_RAMP_RATE, VS_RAMP_MAX, VS_BALL_SPEED_MAX, AI_PROFILES,
  NET_STATE_HZ, NET_INPUT_HZ, NET_EXTRAP_MAX_MS, NET_SMOOTH_TAU, NET_SNAP_DIST,
  NET_LAGCOMP_MAX_MS, NET_CATCH_TOL_MAX,
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

let mode = 'solo';           // 'solo' | 'host' | 'guest'  (role)
let gameMode = 'coop';       // 'coop' | 'versus' — orthogonal to role
let phase = 'idle';          // idle|countdown|serve|playing|paused|levelclear|gameover|matchend
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
let guestInput = { x: FIELD_W / 2, fire: false, launch: false };
let sendAcc = 0;
let snapPrev = null, snapCur = null;   // guest snapshot pair {msg, t}
let guestPadX = FIELD_W / 2;           // guest's locally-predicted top paddle
let remotePaused = false;
let pendingLaunch = false;             // guest: latched launch edge until next input send
let guestPadVel = 0;                   // host: guest paddle velocity (px/s) from input deltas (lag-comp)
let lastGuestInputT = 0;               // host: performance.now() of the last {t:'input'} received
let renderPos = [];                    // guest: per-ball smoothed render positions (dead-reckoning)
let prevFire = false, prevLaunch = false; // guest: edge-detect for immediate (extra) input sends

// versus mode (see CONTRACT.md "Versus mode")
const freshVsSide = () => ({
  bottom: { expand: 0, laser: 0, sticky: 0 },
  top:    { expand: 0, laser: 0, sticky: 0 },
});
let vsLives = { bottom: VS_LIVES, top: VS_LIVES };
let vsScores = { bottom: 0, top: 0 };
let vsSide = freshVsSide();            // catcher-scoped powerup timers/charges
let matchTime = 0;                     // match play time in s (pauses/countdowns excluded)
let vsRamp = 1;                        // guest: ramp mirrored from snapshots (display only)
let vsWinner = null;                   // 'bottom' | 'top' once phase === 'matchend'
let lastBreaker = 'bottom';            // side that broke the last brick → serves the next arena
let vsCombo = { bottom: 0, top: 0 };   // per-side volley combos (co-op keeps the global `combo`)
let vsNoHitPasses = 0;                 // portal passes since a brick was last damaged (anti-stalemate)
let vsServeSide = null;                // guest: side that must serve, mirrored from state.sv
let ai = null;                         // { profile, reactT, targetX, serveT } — solo versus only
const VS_NUDGE_PASSES = 4;             // passes without brick damage before the vx nudge kicks in

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
  portalCd: 0, prevY: 0, owner: 'bottom',
});

// versus: serve ball stuck to (and owned by) the serving side
const newServeBall = (side) => {
  const b = newBall();
  b.owner = side;
  if (side === 'top') {
    b.stuckTo = 'top';
    b.y = TOP_PLANE + BALL_R + 2;
  }
  return b;
};

// versus anti-stalemate ramp; 1 outside versus. Guests mirror the host's value.
const curRamp = () => {
  if (gameMode !== 'versus') return 1;
  if (mode === 'guest') return vsRamp;
  return Math.min(1 + VS_RAMP_RATE * matchTime, VS_RAMP_MAX);
};

const makeAi = (difficulty) => ({
  profile: AI_PROFILES[difficulty] ?? AI_PROFILES.normal,
  reactT: 0, targetX: FIELD_W / 2, serveT: 0,
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
  // co-op MP: carry per-side hearts on the level message so the guest syncs at
  // load (before the first state snapshot) and on nextLevel with healed lives
  hostSend(coopMp() ? { t: 'level', idx, lb: vsLives.bottom, lt: vsLives.top } : { t: 'level', idx });
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
const startSolo = (idx, opts = {}) => { void opts; mode = 'solo'; gameMode = 'coop'; ai = null; startLoop(); setupLevel(idx); };
const startHost = (idx) => { mode = 'host'; gameMode = 'coop'; ai = null; guestInput = { x: FIELD_W / 2, fire: false, launch: false }; guestPadVel = 0; lastGuestInputT = 0; vsLives = { bottom: LIVES_START, top: LIVES_START }; startLoop(); setupLevel(idx); };

// Co-op multiplayer = shared field, per-player hearts (vsLives), heal on clear,
// game over only when BOTH sides hit 0. Solo campaign (mode 'solo') keeps the
// single shared `lives` counter; versus has its own first-to-zero rules.
const coopMp = () => gameMode === 'coop' && mode !== 'solo';
const startGuest = () => {
  mode = 'guest';
  gameMode = 'coop'; ai = null;      // versus arrives via {t:'level', mode:'versus'}
  phase = 'idle';
  score = 0; lives = LIVES_START; combo = 0; elapsed = 0;
  balls = []; bricks = []; powerups = []; lasers = []; delayed = [];
  paddles = makePaddles();
  timers = { expand: 0, slow: 0, laser: 0, fire: 0, stickyCharges: 0 };
  snapPrev = null; snapCur = null; remotePaused = false;
  guestPadX = FIELD_W / 2;
  pendingLaunch = false; prevFire = false; prevLaunch = false;
  renderPos = [];
  vsLives = { bottom: VS_LIVES, top: VS_LIVES };
  vsScores = { bottom: 0, top: 0 };
  vsSide = freshVsSide();
  vsCombo = { bottom: 0, top: 0 }; vsNoHitPasses = 0; vsServeSide = null;
  matchTime = 0; vsRamp = 1; vsWinner = null;
  levelName = ''; stars = makeStars();
  fx.clear();
  startLoop();
};

// ---- versus lifecycle ----
const randomLevel = () => Math.floor(Math.random() * LEVELS.length);

// host→guest level message; in versus it carries mode + per-side lives/scores
// so a (re)joining guest is fully restored (resync sends the same shape + diff).
// `fresh` marks a brand-new match (setupMatch): without it a mid-match host
// Retry looks identical to arena cycling and the guest keeps its old matchTime.
const sendVsLevel = (diff, fresh) => {
  const msg = {
    t: 'level', idx: levelIdx, mode: 'versus',
    lb: vsLives.bottom, lt: vsLives.top, sb: vsScores.bottom, st: vsScores.top,
  };
  if (diff) msg.diff = diff;
  if (fresh) msg.fresh = true;
  hostSend(msg);
};

// fresh match: per-side lives/scores, ramp reset, bottom side serves first
const setupMatch = (idx) => {
  levelIdx = idx;
  score = 0; lives = LIVES_START; combo = 0; elapsed = 0;
  matchTime = 0; vsRamp = 1; vsWinner = null; lastBreaker = 'bottom';
  vsLives = { bottom: VS_LIVES, top: VS_LIVES };
  vsScores = { bottom: 0, top: 0 };
  vsSide = freshVsSide();
  vsCombo = { bottom: 0, top: 0 }; vsNoHitPasses = 0;
  timers = { expand: 0, slow: 0, laser: 0, fire: 0, stickyCharges: 0 };
  laserCd.bottom = 0; laserCd.top = 0;
  guestInput.launch = false;
  balls = [newServeBall('bottom')];
  powerups = []; lasers = []; delayed = [];
  paddles = makePaddles();
  timeScale = 1; slowmoT = 0; clearPending = false;
  vignetteT = 0; resumeT = 0; pausedFrom = null; pauseReason = null;
  buildBricks(idx);
  fx.clear();
  sendVsLevel(null, true);
  beginCountdown();
};

// arena cycling: bricks are the arena — when cleared, the next map loads while
// lives, scores and the speed ramp persist; the last breaker serves one ball
const loadArena = (idx, serveSide) => {
  levelIdx = idx;
  combo = 0;
  vsCombo = { bottom: 0, top: 0 }; vsNoHitPasses = 0;
  timers = { expand: 0, slow: 0, laser: 0, fire: 0, stickyCharges: 0 };
  vsSide = freshVsSide();
  laserCd.bottom = 0; laserCd.top = 0;
  balls = [newServeBall(serveSide)];
  powerups = []; lasers = []; delayed = [];
  timeScale = 1; slowmoT = 0; clearPending = false;
  buildBricks(idx);
  // no fx.clear(): the arena-clear confetti plays on into the countdown
  sendVsLevel();
  beginCountdown();
};

const startVersusAI = (difficulty, levelIdx_) => {
  mode = 'solo';
  gameMode = 'versus';
  ai = makeAi(difficulty);
  startLoop();
  setupMatch(Number.isInteger(levelIdx_) ? levelIdx_ : randomLevel());
};

const startVersusHost = (levelIdx_) => {
  mode = 'host';
  gameMode = 'versus';
  ai = null;
  guestInput = { x: FIELD_W / 2, fire: false, launch: false };
  guestPadVel = 0; lastGuestInputT = 0;
  startLoop();
  setupMatch(Number.isInteger(levelIdx_) ? levelIdx_ : randomLevel());
};

// stop the loop and drop all per-game state; leaves the net session untouched
const teardown = () => {
  running = false;
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
  phase = 'idle';
  balls = []; powerups = []; lasers = []; delayed = [];
  snapPrev = null; snapCur = null; remotePaused = false; renderPos = [];
  timeScale = 1; slowmoT = 0; clearPending = false;
  gameMode = 'coop'; ai = null; vsWinner = null;
  fx.clear();
  input.reset();
};

const quit = () => {
  hostSend({ t: 'phase', v: 'backtomenu' });
  teardown();
};

// Post-game exit that KEEPS the room: the peers stay connected in the lobby so
// the host can pick another map and start again without re-inviting. Differs
// from quit() only in the phase it broadcasts ('backtolobby' → the guest
// re-arms and waits in the lobby instead of tearing its session down).
const quitToLobby = () => {
  hostSend({ t: 'phase', v: 'backtolobby' });
  teardown();
};

const pause = (reason) => {
  if (phase !== 'playing' && phase !== 'serve' && phase !== 'countdown') return;
  // MP versus is host-only pause (contract): a guest's Esc must not open a
  // local "Paused" dialog that blocks its paddle while the host's match keeps
  // running and drains its lives. The connection-lost pause ('net') still shows.
  if (gameMode === 'versus' && mode === 'guest' && reason !== 'net') return;
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
  // mini-grace before physics restarts; the countdown IS the grace period, so
  // resuming into it must not stack "Ready…" on top of the countdown digit
  resumeT = phase === 'countdown' ? 0 : 0.8;
  callbacks.onPauseChange?.(false);
  hostSend({ t: 'phase', v: 'resumed' });
};

// Host-only, beyond the contract list (documented): reclaim the top paddle for
// local input after the guest is gone. main.js calls this from "Continue solo".
const convertToSolo = () => {
  if (mode === 'guest') return;
  mode = 'solo';
  // versus: the departed guest's portal can't go uncontrolled — AI takes over
  if (gameMode === 'versus' && !ai) ai = makeAi('normal');
};

const nextLevel = () => {
  if (mode === 'guest') return;               // host drives level flow
  if (gameMode === 'versus') return;          // versus cycles arenas internally
  if (levelIdx + 1 >= LEVELS.length) return;  // main treats last level itself
  setupLevel(levelIdx + 1);
};

const retryLevel = () => {
  if (mode === 'guest') return;
  if (gameMode === 'versus') { setupMatch(levelIdx); return; }  // restart the match, same arena
  // co-op MP: a retry is a fresh attempt — restore both players to full hearts
  // (otherwise retrying after a both-dead game over would start at 0/0)
  if (coopMp()) vsLives = { bottom: LIVES_START, top: LIVES_START };
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
    if (phase === 'paused') {
      if (pauseReason !== 'net') resume(); // lost-connection flow is owned by main.js
    } else {
      pause('user');
    }
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

  reportIntensity();
  effectMusicWatch();
  render();
};

// A song swapped in for a fireball or multiball hands back when the effect is
// over: fire on its timer, multiball when the extra balls are gone. Both are
// watched here rather than at the mutation sites because they can also end via
// a life lost, a level change or (on a guest) a host state update.
let wasFire = false;
let wasMulti = false;

const effectMusicWatch = () => {
  const fireOn = timers.fire > 0;
  const multiOn = balls.length > 1;
  const playing = phase === 'playing' || phase === 'serve';
  if ((wasFire && !fireOn) || (wasMulti && !multiOn && playing)) audio.resumeSong();
  wasFire = fireOn;
  wasMulti = multiOn;
};

// Feed the music how hot the rally is: the fastest ball in play, normalised
// over its speed range. Balls carry vx/vy on every path (the guest's come from
// the host's snapshots), so this works the same in solo and multiplayer.
const INTENSITY_GEARS = [0.55, 0.82];   // upward crossings that change the song
let lastIntensity = 0;

const reportIntensity = () => {
  let fastest = 0;
  if (phase === 'playing' || phase === 'serve') {
    for (const b of balls) {
      if (b.stuck) continue;
      const sp = Math.hypot(b.vx ?? 0, b.vy ?? 0);
      if (sp > fastest) fastest = sp;
    }
  }
  const top = gameMode === 'versus' ? VS_BALL_SPEED_MAX : BALL_SPEED_MAX;
  const v = fastest <= 0 ? 0 : clamp((fastest - BALL_SPEED) / (top - BALL_SPEED), 0, 1);
  audio.setIntensity(v);
  // crossing a gear upward is a real "it just got serious" moment — let the
  // music turn over there (audio rate-limits, so a jittery rally can't strobe)
  for (const gear of INTENSITY_GEARS) {
    if (lastIntensity < gear && v >= gear) audio.nextSong();
  }
  lastIntensity = v;
};

const hostFrame = (dt, inp) => {
  if (phase === 'countdown') {
    tickCountdown(dt);
    movePaddles(dt, inp);
    followStuck();
  } else if ((phase === 'serve' || phase === 'playing') && resumeT <= 0) {
    elapsed += dt;
    if (gameMode === 'versus') matchTime += dt;   // ramp clock: paused time excluded
    acc += dt * timeScale;
    let guard = 0;
    while (acc >= STEP && guard++ < 24) {
      acc -= STEP;
      step(STEP, inp);
      if (phase !== 'serve' && phase !== 'playing') break;
    }
    // versus: each side launches only its own stuck balls (AI serves via aiStep)
    if (inp.launch && (phase === 'serve' || phase === 'playing')) {
      launchStuck(gameMode === 'versus' ? 'bottom' : undefined);
    }
    if (gameMode === 'versus' && mode === 'host' && guestInput.launch
        && (phase === 'serve' || phase === 'playing')) {
      guestInput.launch = false;
      launchStuck('top');
    }
  } else if (phase === 'levelclear' || phase === 'gameover' || phase === 'paused'
      || phase === 'matchend') {
    // idle: render only
  }

  if (mode === 'host' && net.connected) {
    sendAcc += dt;
    if (sendAcc >= 1 / NET_STATE_HZ) {
      sendAcc = 0;
      const msg = {
        t: 'state',
        // balls carry velocity so the guest can dead-reckon between snapshots
        balls: balls.map((b) => [Math.round(b.x), Math.round(b.y), Math.round(b.vx), Math.round(b.vy)]),
        pb: Math.round(paddles.bottom.x), pt: Math.round(paddles.top.x),
        lasers: lasers.map((l) => [Math.round(l.x), Math.round(l.y), l.dir]),
        pups: powerups.map((p) => [Math.round(p.x), Math.round(p.y), p.kind]),
        score, lives, combo,
      };
      if (gameMode === 'versus') {
        msg.lb = vsLives.bottom; msg.lt = vsLives.top;
        msg.sb = vsScores.bottom; msg.st = vsScores.top;
        msg.ramp = Math.round(curRamp() * 100) / 100;  // display only
        // which side must serve — the guest's phase is 'playing' during the
        // host's 'serve', so this is its only cue to show a launch prompt
        if (phase === 'serve') {
          msg.sv = balls.some((b) => b.stuck && b.stuckTo === 'top') ? 'top' : 'bottom';
        }
      } else if (coopMp()) {
        msg.lb = vsLives.bottom; msg.lt = vsLives.top;  // per-side hearts (shared score stays in msg.score)
      }
      hostSend(msg);
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

// Host lag-comp for the remote (top) paddle: where the guest really has it
// *now* — its last reported x advanced by the estimated one-way latency, using
// the velocity derived from successive input packets. `tol` is the extra catch
// half-width that keeps a guest mid-correction from being unfairly missed.
// Falls back to the raw reported x (no extrapolation, no tolerance) when RTT is
// unknown or implausibly large. Never used for the bottom (host-local) paddle.
const guestLagComp = () => {
  const halfW = paddles.top.w / 2;
  const oneWay = net.oneWay;
  if (oneWay > 0 && oneWay <= NET_LAGCOMP_MAX_MS) {
    const s = oneWay / 1000;
    return {
      x: clamp(guestInput.x + guestPadVel * s, halfW, FIELD_W - halfW),
      tol: Math.min(Math.abs(guestPadVel) * s, NET_CATCH_TOL_MAX),
    };
  }
  return { x: clamp(guestInput.x, halfW, FIELD_W - halfW), tol: 0 };
};

const movePaddles = (dt, inp) => {
  // paddle width tween (expand powerup; versus scopes it to the catching side)
  for (const side of ['bottom', 'top']) {
    const p = paddles[side];
    const active = gameMode === 'versus' ? vsSide[side].expand : timers.expand;
    const targetW = active > 0 ? PADDLE_W_EXPANDED : PADDLE_W;
    p.w += (targetW - p.w) * Math.min(1, dt * 10);
    if (Math.abs(p.w - targetW) < 0.5) p.w = targetW;
  }

  if (gameMode === 'versus' && mode !== 'guest') {
    // versus: the local player only owns the bottom portal — merge all local
    // input channels into it (same convention as the guest's top paddle)
    movePaddle(paddles.bottom, inp.bottom.move || inp.top.move,
      inp.bottom.targetX ?? inp.top.targetX, dt);
  } else {
    movePaddle(paddles.bottom, inp.bottom.move, inp.bottom.targetX, dt);
  }

  if (mode === 'host' && net.connected) {
    const p = paddles.top;
    const maxStep = PADDLE_SPEED * 3 * dt;
    // follow the lag-compensated guest position so the drawn paddle sits where
    // the guest actually has it now (the same effX the portal test uses)
    p.x += clamp(guestLagComp().x - p.x, -maxStep, maxStep);
  } else if (gameMode === 'versus' && ai) {
    // AI: same movement clamp as a player, max speed from its profile
    const p = paddles.top;
    const maxStep = ai.profile.speed * dt;
    p.x += clamp(ai.targetX - p.x, -maxStep, maxStep);
    p.x = clamp(p.x, p.w / 2, FIELD_W - p.w / 2);
  } else if (assist && mode === 'solo') {
    paddles.top.x = clamp(paddles.bottom.x, paddles.top.w / 2, FIELD_W - paddles.top.w / 2);
  } else if (gameMode === 'versus') {
    // versus host with the guest transiently gone: the top portal holds position
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

const launchStuck = (side) => {
  let any = false;
  for (const b of balls) {
    if (!b.stuck) continue;
    if (side && b.stuckTo !== side) continue;  // versus: serve only your own balls
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

  if (gameMode === 'versus') {
    for (const s of ['bottom', 'top']) {
      if (vsSide[s].expand > 0) vsSide[s].expand = Math.max(0, vsSide[s].expand - dt);
      if (vsSide[s].laser > 0) vsSide[s].laser = Math.max(0, vsSide[s].laser - dt);
    }
    if (ai) aiStep(dt);
  }

  movePaddles(dt, inp);
  followStuck();

  if (gameMode === 'versus') {
    // catcher-scoped lasers: each side fires only with its own charge running.
    // The player's fire keys all serve the bottom portal; AI fires via aiStep.
    const bottomFire = inp.bottom.fire || inp.top.fire;
    if (vsSide.bottom.laser > 0 && bottomFire) shootLaser('bottom');
    if (vsSide.top.laser > 0 && mode === 'host' && net.connected && guestInput.fire) {
      shootLaser('top');
    }
  } else if (timers.laser > 0) {
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
  const speedCap = gameMode === 'versus'
    ? Math.min(BALL_SPEED_MAX * curRamp(), VS_BALL_SPEED_MAX)
    : BALL_SPEED_MAX;
  ball.speed = Math.min(ball.speed * SPEED_UP, speedCap);
  renorm(ball);
  enforceMinVy(ball);
  ball.portalCd = 0.08;
  combo = 0;
  if (gameMode === 'versus') {
    // the catcher owns the ball: they chose the offset (english) that steers it,
    // so the bricks it breaks are their doing. (owner = exitSide inverted every
    // score: catching a falling ball donated the return volley to the opponent.)
    ball.owner = entrySide;
    vsCombo[entrySide] = 0;            // per-side combo: the catch starts a new volley
    // anti-stalemate nudge: a dead-center catch loop adds no english, so the
    // ramp alone can never break it. After several portal passes with no brick
    // damage, force a growing minimum sideways component; the changing angle
    // sweeps different brick columns each pass until something is hit.
    vsNoHitPasses++;
    if (vsNoHitPasses > VS_NUDGE_PASSES) {
      const ratio = Math.min(0.2 + 0.05 * (vsNoHitPasses - VS_NUDGE_PASSES), 0.6);
      const minVx = ball.speed * ratio;
      if (Math.abs(ball.vx) < minVx) {
        const dir = ball.vx !== 0 ? Math.sign(ball.vx) : (Math.random() < 0.5 ? -1 : 1);
        ball.vx = dir * minVx;
        ball.vy = Math.sign(ball.vy || 1)
          * Math.sqrt(Math.max(0, ball.speed * ball.speed - minVx * minVx));
      }
    }
  }

  fx.portalFlash(ex, ey, entrySide);
  fx.portalFlash(ball.x, ball.y, exitSide);
  audio.sfx('portal');
  fx.shake(0.12);
  hostEv('portal', ex, ey, { x2: Math.round(ball.x), y2: Math.round(ball.y), s1: entrySide, s2: exitSide });

  // sticky is catcher-scoped in versus: the exit paddle only holds the ball
  // if its own side owns charges
  const charges = gameMode === 'versus' ? vsSide[exitSide].sticky : timers.stickyCharges;
  if (charges > 0) {
    if (gameMode === 'versus') vsSide[exitSide].sticky--;
    else timers.stickyCharges--;
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

    if (gameMode === 'versus') {
      // continuously applied ramp floor + cap: a slow-powerup dip below the
      // floor (via eff) recovers the moment the effect expires
      const r = curRamp();
      b.speed = clamp(b.speed, BALL_SPEED * r, Math.min(BALL_SPEED_MAX * r, VS_BALL_SPEED_MAX));
    }
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
      // host lag-comp: test the TOP paddle at the guest's extrapolated position
      // with a little extra catch tolerance; the bottom (host-local) is exact
      let topCx = pt.x, topTol = 0;
      if (mode === 'host' && net.connected) { const lc = guestLagComp(); topCx = lc.x; topTol = lc.tol; }
      if (b.vy > 0 && b.prevY + BALL_R < BOTTOM_PLANE && b.y + BALL_R >= BOTTOM_PLANE
          && Math.abs(b.x - pb.x) <= pb.w / 2 + BALL_R) {
        teleport(b, 'bottom');
        continue;
      }
      if (b.vy < 0 && b.prevY - BALL_R > TOP_PLANE && b.y - BALL_R <= TOP_PLANE
          && Math.abs(b.x - topCx) <= pt.w / 2 + BALL_R + topTol) {
        teleport(b, 'top');
        continue;
      }
    }

    // lost beyond top/bottom edge
    if (b.y - BALL_R > FIELD_H || b.y + BALL_R < 0) {
      const exitSide = b.y + BALL_R < 0 ? 'top' : 'bottom';
      balls.splice(i, 1);
      if (gameMode === 'versus') vsLoseLife(exitSide);  // every ball counts, per side
      else if (coopMp()) coopLoseLife(exitSide);        // co-op MP: the side that missed
      else if (balls.length === 0) loseLife();          // solo: shared lives
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
        hitBrick(brick, Math.max(1, brick.hp), b.owner); // fireball pierces: destroy, no bounce
        return;
      }
      if (ox < oy) {
        b.x += Math.sign(dx) * ox;
        b.vx = Math.sign(dx) * Math.abs(b.vx);
      } else {
        b.y += Math.sign(dy) * oy;
        b.vy = Math.sign(dy) * Math.abs(b.vy);
      }
      hitBrick(brick, 1, b.owner);
      return;
    }
  }
};

const brickIndex = (brick) => bricks.indexOf(brick);

// `by`: crediting side ('bottom'|'top') — ball owner or laser side; co-op ignores it
const hitBrick = (brick, dmg, by) => {
  // matchend guard: a lower-index ball or in-flight laser finishing its physics
  // step after endMatch() must not mutate scores or resurrect the match by
  // clearing the arena behind the result dialog
  if (!brick.alive || phase === 'matchend') return;
  const cx = brick.x + BRICK_W / 2, cy = brick.y + BRICK_H / 2;
  const info = BRICK_TYPES[brick.type];
  if (brick.hp === Infinity) {
    audio.sfx('gold');
    fx.sparks(cx, cy, info.color);
    hostEv('gold', cx, cy);
    return;
  }
  brick.hp -= dmg;
  vsNoHitPasses = 0;            // brick progress — the anti-stalemate nudge stands down
  if (brick.hp > 0) {
    audio.sfx('silver');
    fx.sparks(cx, cy, info.color);
    hostSend({ t: 'brick', idx: brickIndex(brick), hp: brick.hp });
    return;
  }
  brick.alive = false;
  destructibleLeft--;
  let pts;
  if (gameMode === 'versus') {
    const side = by === 'top' ? 'top' : 'bottom';
    pts = Math.round(info.points * (1 + vsCombo[side] * 0.1)); // per-side combo math
    vsScores[side] += pts;      // per-side score, attributed via ball/laser ownership
    lastBreaker = side;         // the last breaker serves the next arena
    vsCombo[side]++;
    combo = vsCombo[side];      // mirror for sfx pitch + the guest's state snapshot
  } else {
    pts = Math.round(info.points * (1 + combo * 0.1)); // combo-multiplied award
    score += pts;
    combo++;
  }
  audio.sfx('brick', { combo });
  fx.brickBurst(cx, cy, info.color);
  fx.floatText(cx, cy, `+${pts}`, info.color);
  hostSend({ t: 'brick', idx: brickIndex(brick), hp: 0 });
  if (brick.type === 'E') explode(brick, by);
  maybeDrop(brick, cx, cy);
  if (destructibleLeft <= 0) triggerClear();
};

const explode = (brick, by) => {
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
      delayed.push({ t: delay, fn: () => { if (n.alive) hitBrick(n, 1, by); } });
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

// `catcher`: the paddle side that caught the drop; scopes sided effects in versus
const applyPowerup = (kind, x, y, catcher = 'bottom') => {
  const info = POWERUP_INFO[kind];
  audio.sfx('powerup');
  fx.floatText(x, y, info.label, info.color);
  fx.sparks(x, y, info.color);
  if (gameMode === 'versus') {
    hostSend({ t: 'ev', name: 'powerup', x: Math.round(x), y: Math.round(y), extra: kind, side: catcher });
  } else {
    hostEv('powerup', x, y, kind);
  }
  // The two pickups that visibly change the whole board get a fresh track for
  // as long as they last: ret:true means the music comes back when they expire
  // (see effectMusicWatch), so the detour belongs to the powerup.
  if (kind === 'multi' || kind === 'fire') audio.nextSong({ ret: true });
  switch (kind) {
    case 'multi': {
      const src = balls.slice();
      for (const b of src) {
        // sticky-held balls still split: clones launch straight out of their paddle
        const sp = b.speed || BALL_SPEED;
        const bvx = b.stuck ? 0 : b.vx;
        const bvy = b.stuck ? (b.stuckTo === 'top' ? sp : -sp) : b.vy;
        for (const ang of [-25 * Math.PI / 180, 25 * Math.PI / 180]) {
          if (balls.length >= MAX_BALLS) break;
          const cos = Math.cos(ang), sin = Math.sin(ang);
          balls.push({
            ...b, stuck: false,
            vx: bvx * cos - bvy * sin,
            vy: bvx * sin + bvy * cos,
            portalCd: b.stuck ? 0.08 : b.portalCd,
          });
        }
      }
      break;
    }
    case 'expand':
      if (gameMode === 'versus') vsSide[catcher].expand = 15;
      else timers.expand = 15;
      break;
    case 'slow': timers.slow = 10; break;    // global ball effect, even in versus
    case 'sticky':
      if (gameMode === 'versus') vsSide[catcher].sticky = Math.min(vsSide[catcher].sticky + 3, 9);
      else timers.stickyCharges = Math.min(timers.stickyCharges + 3, 9);
      break;
    case 'laser':
      if (gameMode === 'versus') vsSide[catcher].laser = 10;
      else timers.laser = 10;
      break;
    case 'life':
      if (gameMode === 'versus') vsLives[catcher] = Math.min(vsLives[catcher] + 1, VS_LIFE_MAX);
      else if (coopMp()) vsLives[catcher] = Math.min(vsLives[catcher] + 1, LIVES_START); // heal the catcher's side
      else lives = Math.min(lives + 1, 9);
      break;
    case 'fire': timers.fire = 8; break;     // global ball effect, even in versus
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
        applyPowerup(p.kind, p.x, p.y, side);
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
      hitBrick(brick, 1, l.dir === -1 ? 'bottom' : 'top');  // firing side gets the credit
    }
    lasers.splice(i, 1);
  }
};

const loseLife = () => {
  // level already won (slow-mo clear in progress) — don't punish the falling ball
  if (clearPending || phase === 'levelclear') return;
  delayed = []; // pending explosive chains die with the ball
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

// ---- co-op multiplayer: per-side hearts, both-must-die game over ----
const coopLoseLife = (side) => {
  if (clearPending || phase === 'levelclear') return;
  if (vsLives[side] > 0) {
    vsLives[side]--;
    combo = 0;
    audio.sfx('lifeLost');
    fx.shake(0.8);
    vignetteT = 0.6;
    hostSend({ t: 'ev', name: 'lifeLost', side }); // side → guest mirrors the right heart
  }
  // cooperative game over only when BOTH players are out
  if (vsLives.bottom <= 0 && vsLives.top <= 0) {
    delayed = [];
    phase = 'gameover';
    audio.sfx('gameOver');
    hostSend({ t: 'phase', v: 'gameover' });
    hostEv('gameOver');
    callbacks.onGameOver?.({ levelIdx, score, timeMs: Math.round(elapsed * 1000) });
    callbacks.onLevelEnd?.({ levelIdx, score, timeMs: Math.round(elapsed * 1000), cleared: false });
    return;
  }
  // one side may be down while the other plays on — keep serving until both die
  if (balls.length === 0) {
    delayed = [];
    balls = [newBall()];
    beginCountdown();
  }
};

// ---- versus: life loss, match end, AI ----
const vsLoseLife = (side) => {
  // arena already won (slow-mo clear in progress) or match decided — ignore
  if (clearPending || phase === 'matchend') return;
  vsLives[side]--;
  combo = 0;
  vsCombo = { bottom: 0, top: 0 };
  vsNoHitPasses = 0;
  audio.sfx('lifeLost');
  fx.shake(0.8);
  vignetteT = 0.6;
  hostSend({ t: 'ev', name: 'lifeLost', side });   // side is REQUIRED in versus
  if (vsLives[side] <= 0) {
    endMatch(side === 'bottom' ? 'top' : 'bottom');
    return;
  }
  if (balls.length === 0) {
    delayed = [];                      // pending explosive chains die with the volley
    balls = [newServeBall(side)];      // the side that lost the life serves next
    beginCountdown();
  }
};

const endMatch = (winner) => {
  vsWinner = winner;
  phase = 'matchend';
  timeScale = 1; slowmoT = 0; clearPending = false;
  delayed = [];
  const youWon = winner === (mode === 'guest' ? 'top' : 'bottom');
  if (youWon) fx.confetti();
  else audio.sfx('gameOver');          // 'win' sfx is main's call, per youWon
  // timeMs rides along so the guest's dialog shows the host's authoritative
  // match clock (the guest's local one also counts the host's serve-wait)
  hostSend({ t: 'phase', v: 'matchend', winner, timeMs: Math.round(matchTime * 1000) });
  callbacks.onMatchEnd?.({
    winner, youWon,
    scoreBottom: vsScores.bottom, scoreTop: vsScores.top,
    timeMs: Math.round(matchTime * 1000),
    levelIdx,   // lets the lobby re-open seeded with the arena just played
  });
};

// Top-paddle AI (solo versus only). Reads nothing but ball/powerup/brick state.
const aiHasLaserTarget = () => {
  const col = clamp(Math.floor(paddles.top.x / BRICK_W), 0, GRID_COLS - 1);
  for (let row = 0; row < GRID_ROWS; row++) {
    const b = bricks[row * GRID_COLS + col];
    if (b?.alive && b.hp !== Infinity) return true;
  }
  return false;
};

const aiThink = () => {
  // threat: the nearest ball heading top; predict its x at the paddle plane
  let threat = null, bestDy = Infinity;
  for (const b of balls) {
    if (b.stuck || b.vy >= 0) continue;
    const dy = b.y - TOP_PLANE;
    if (dy >= 0 && dy < bestDy) { bestDy = dy; threat = b; }
  }
  if (threat) {
    const raw = threat.x + threat.vx * (bestDy / -threat.vy);
    // fold the straight-line x back into the field: side-wall reflection
    const span = FIELD_W - 2 * BALL_R;
    let xr = (raw - BALL_R) % (2 * span);
    if (xr < 0) xr += 2 * span;
    if (xr > span) xr = 2 * span - xr;
    // aim error grows with ball speed (which the ramp floor drives up) and ramp
    const err = ai.profile.err * (threat.speed / BALL_SPEED) * (0.5 + curRamp() / 2);
    ai.targetX = clamp(xr + BALL_R + rand(-err, err),
      paddles.top.w / 2, FIELD_W - paddles.top.w / 2);
    return;
  }
  // idle: drift toward the nearest catchable powerup (floating up), else center
  let pup = null, best = Infinity;
  for (const p of powerups) {
    if (p.vy >= 0) continue;
    const d = Math.abs(p.y - PADDLE_TOP_Y);
    if (d < best) { best = d; pup = p; }
  }
  ai.targetX = pup ? pup.x : FIELD_W / 2;
};

const aiStep = (dt) => {
  // auto-serve stuck balls after ~1 s (standard serve spread via launchStuck)
  if (balls.some((b) => b.stuck && b.stuckTo === 'top')) {
    ai.serveT += dt;
    if (ai.serveT >= 1) { ai.serveT = 0; launchStuck('top'); }
  } else {
    ai.serveT = 0;
  }
  ai.reactT -= dt;
  if (ai.reactT <= 0) { ai.reactT = ai.profile.react; aiThink(); }
  // opportunistic laser at live bricks, on the normal cooldown
  if (vsSide.top.laser > 0 && laserCd.top <= 0 && aiHasLaserTarget()) shootLaser('top');
};

const triggerClear = () => {
  if (clearPending || phase === 'levelclear' || phase === 'matchend') return;
  clearPending = true;
  // finishClear is always deferred to frame(): in versus it calls loadArena(),
  // which swaps the balls/lasers/bricks arrays out from under the moveBalls /
  // moveLasers / tickDelayed iterations that reach hitBrick. With reduced
  // effects the deferral is one frame (no visible slow-mo).
  slowmoT = reduced ? 0.001 : 0.35; // slow-mo moment on the last brick
  timeScale = reduced ? 1 : 0.25;
};

const finishClear = () => {
  clearPending = false;
  timeScale = 1;
  if (gameMode === 'versus') {
    // arena cycle: brief celebration, then the next map; state persists
    audio.sfx('levelClear');
    fx.confetti();
    hostEv('levelClear');
    loadArena((levelIdx + 1) % LEVELS.length, lastBreaker);
    return;
  }
  // co-op MP: clearing a level heals every side below full (0→1 revives a
  // downed partner). Lives persist into the next level (setupLevel won't reset
  // them). The next state broadcast carries the healed lb/lt to the guest.
  if (coopMp()) {
    for (const s of ['bottom', 'top']) {
      if (vsLives[s] < LIVES_START) vsLives[s]++;
    }
  }
  phase = 'levelclear';
  audio.sfx('levelClear');
  fx.confetti();
  hostSend({ t: 'phase', v: 'levelclear' });
  hostEv('levelClear');
  callbacks.onLevelEnd?.({ levelIdx, score, timeMs: Math.round(elapsed * 1000), cleared: true });
};

// Host-only, beyond the contract list (documented): after a guest (re)connects
// mid-game, re-send level + brick state + phase so the guest never plays against
// a stale or empty field. main.js calls this on 'peer-joined'/'reconnected'.
const resync = () => {
  if (mode !== 'host' || !running || !net.connected) return;
  const diff = [];
  bricks.forEach((b, i) => {
    if (!b) return;
    if (!b.alive) diff.push([i, 0]);
    else if (b.hp !== Infinity && b.hp !== BRICK_TYPES[b.type].hp) diff.push([i, b.hp]);
  });
  if (gameMode === 'versus') sendVsLevel(diff);  // carries mode + per-side lives/scores
  else if (coopMp()) hostSend({ t: 'level', idx: levelIdx, diff, lb: vsLives.bottom, lt: vsLives.top });
  else hostSend({ t: 'level', idx: levelIdx, diff });
  if (phase === 'playing' || phase === 'serve') {
    hostSend({ t: 'phase', v: 'playing' });
  } else if (phase === 'paused') {
    if (pausedFrom !== 'countdown') hostSend({ t: 'phase', v: 'playing' });
    hostSend({ t: 'phase', v: 'paused' });
  } else if (phase === 'levelclear' || phase === 'gameover') {
    hostSend({ t: 'phase', v: phase });
  } else if (phase === 'matchend') {
    hostSend({ t: 'phase', v: 'matchend', winner: vsWinner });
  }
  // 'countdown': the 'level' message already restarts the guest's countdown
};

// ---- multiplayer: guest side ----
const guestFrame = (dt, inp) => {
  if (phase === 'countdown') tickCountdown(dt);
  if (phase === 'playing' && !remotePaused) {
    elapsed += dt;
    if (gameMode === 'versus') matchTime += dt;
  }

  // all local input channels drive the guest's (top) paddle
  const move = inp.top.move || inp.bottom.move;
  const targetX = inp.top.targetX ?? inp.bottom.targetX;
  const pad = paddles.top;
  if (gameMode === 'versus') {
    // per-side expand mirrors (set by the powerup ev, which carries the catcher)
    for (const side of ['bottom', 'top']) {
      const p = paddles[side];
      const tW = vsSide[side].expand > 0 ? PADDLE_W_EXPANDED : PADDLE_W;
      p.w += (tW - p.w) * Math.min(1, dt * 10);
      if (vsSide[side].expand > 0) vsSide[side].expand = Math.max(0, vsSide[side].expand - dt);
    }
  } else {
    const targetW = timers.expand > 0 ? PADDLE_W_EXPANDED : PADDLE_W;
    pad.w += (targetW - pad.w) * Math.min(1, dt * 10);
    paddles.bottom.w = pad.w;
  }
  const fake = { x: guestPadX, w: pad.w };
  movePaddle(fake, move, targetX, dt);
  guestPadX = fake.x;
  pad.x = guestPadX; // client-side prediction of own paddle only

  for (const k of ['expand', 'slow', 'laser', 'fire']) {
    if (timers[k] > 0) timers[k] = Math.max(0, timers[k] - dt);
  }

  // latch launch presses until the next input packet (versus: guest serves)
  const fireNow = Boolean(inp.top.fire || inp.bottom.fire);
  const launchNow = Boolean(inp.launch);
  pendingLaunch = pendingLaunch || launchNow;
  // a fresh fire/launch press sends one extra packet immediately so serves and
  // lasers stay responsive instead of waiting up to a full input period
  const edge = (fireNow && !prevFire) || (launchNow && !prevLaunch);
  prevFire = fireNow; prevLaunch = launchNow;

  sendAcc += dt;
  if (net.connected) {
    const periodic = sendAcc >= 1 / NET_INPUT_HZ;
    if (periodic || edge) {
      net.send({
        t: 'input', x: Math.round(guestPadX),
        fire: fireNow, launch: pendingLaunch,
      });
      pendingLaunch = false;
      if (periodic) sendAcc = 0; // edge packets are extra — keep the periodic cadence
    }
  }

  renderGuestState(dt);
};

// Guest render (dead-reckoning). Each ball is projected from the latest snapshot
// by its own velocity over (age-since-received + estimated one-way latency),
// clamped so the total lead never exceeds NET_EXTRAP_MAX_MS, then the persistent
// per-ball renderPos is eased toward that target (time-constant NET_SMOOTH_TAU);
// a jump beyond NET_SNAP_DIST (an unpredicted bounce/portal) snaps instead. The
// host (bottom) paddle is extrapolated from the last two snapshots' pb, lightly
// smoothed; the guest's own (top) paddle stays fully local (set above). Lasers
// and powerups keep a light back-in-time interpolation. New/removed balls reset
// cleanly by index. Authoritative scalars come straight from the latest snapshot.
const renderGuestState = (dt) => {
  if (!snapCur) return;
  const bm = snapCur.msg;
  const nowMs = performance.now();
  const oneWaySec = net.oneWay / 1000;
  const alpha = 1 - Math.exp(-dt / NET_SMOOTH_TAU);

  // balls: dead-reckoning. Cap the TOTAL lead (age + one-way) at NET_EXTRAP_MAX_MS
  // — capping only the age component let one-way stack on top, exceeding the
  // documented bound (up to ~700ms) on a delayed/dropped state packet.
  const ageSec = clamp((nowMs - snapCur.t) / 1000, 0, NET_EXTRAP_MAX_MS / 1000);
  const lead = Math.min(ageSec + oneWaySec, NET_EXTRAP_MAX_MS / 1000);
  const snapBalls = bm.balls;
  // The wire carries no ball id, so when the ball SET changes (multiball split,
  // or a lost ball the host spliced — which re-indexes every higher-index ball)
  // a bare index map would hand each survivor its neighbour's smoothed position
  // and hard-snap the whole set across the field. Re-key renderPos by nearest
  // previous position: survivors keep their own anchor, genuinely new/teleported
  // balls stay unmatched and fall through to the snap branch below.
  if (renderPos.length !== snapBalls.length) {
    const old = renderPos;
    const used = new Array(old.length).fill(false);
    const next = new Array(snapBalls.length);
    for (let i = 0; i < snapBalls.length; i++) {
      const bx = snapBalls[i][0], by = snapBalls[i][1];
      let best = -1, bestD = NET_SNAP_DIST;      // only carry anchors within snap range
      for (let j = 0; j < old.length; j++) {
        if (used[j] || !old[j]) continue;
        const d = Math.hypot(bx - old[j].x, by - old[j].y);
        if (d < bestD) { bestD = d; best = j; }
      }
      if (best >= 0) { next[i] = old[best]; used[best] = true; }
    }
    renderPos = next;
  }
  balls = snapBalls.map((bb, i) => {
    const bvx = bb[2] ?? 0, bvy = bb[3] ?? 0;
    const tx = clamp(bb[0] + bvx * lead, BALL_R, FIELD_W - BALL_R);
    let ty = clamp(bb[1] + bvy * lead, BALL_R, FIELD_H - BALL_R);
    // Don't dead-reckon a ball *past* the paddle plane it is approaching: at the
    // plane it either teleports (a full-field discontinuity the guest cannot
    // predict) or is lost, so extrapolating on to the field edge just overshoots
    // the catch zone and then hard-snaps. Freeze the forward lead at the plane;
    // the authoritative post-event snapshot resolves it. (No effect on straight
    // mid-field runs, where the ball never reaches a plane within one lead.)
    if (bvy > 0) ty = Math.min(ty, BOTTOM_PLANE);
    else if (bvy < 0) ty = Math.max(ty, TOP_PLANE);
    let rp = renderPos[i];
    if (!rp || Math.hypot(tx - rp.x, ty - rp.y) > NET_SNAP_DIST) {
      rp = { x: tx, y: ty };            // new ball, or a bounce/portal the guest couldn't predict → snap
    } else {
      rp.x += (tx - rp.x) * alpha;
      rp.y += (ty - rp.y) * alpha;
    }
    renderPos[i] = rp;
    // vx/vy carry the orange=falling / blue=rising color cue (+ the fire flag)
    return { x: rp.x, y: rp.y, vx: bvx, vy: bvy, stuck: false, fire: timers.fire > 0 };
  });

  // opponent (bottom / host) paddle: extrapolate from the last two snapshots' pb
  let pbTarget = bm.pb;
  if (snapPrev && snapCur.t > snapPrev.t) {
    const vel = (bm.pb - snapPrev.msg.pb) / ((snapCur.t - snapPrev.t) / 1000);
    pbTarget = bm.pb + vel * oneWaySec;
  }
  pbTarget = clamp(pbTarget, paddles.bottom.w / 2, FIELD_W - paddles.bottom.w / 2);
  paddles.bottom.x += (pbTarget - paddles.bottom.x) * alpha;

  // lasers / powerups: light back-in-time interpolation between the snapshot pair
  let a = snapPrev, bSnap = snapCur, ia = 1;
  const interpNow = nowMs - 40;
  if (a && bSnap.t > a.t) ia = clamp((interpNow - a.t) / (bSnap.t - a.t), 0, 1);
  else a = bSnap;
  const lerp = (u, v) => u + (v - u) * ia;
  const am = a.msg;
  lasers = bm.lasers.map((ll, i) => {
    const al = am.lasers[i] ?? ll;
    return { x: lerp(al[0], ll[0]), y: lerp(al[1], ll[1]), dir: ll[2] };
  });
  powerups = bm.pups.map((pp, i) => {
    const ap = am.pups[i] ?? pp;
    return { x: lerp(ap[0], pp[0]), y: lerp(ap[1], pp[1]), kind: pp[2] };
  });

  // authoritative HUD scalars
  score = bm.score; lives = bm.lives; combo = bm.combo;
  if (gameMode === 'versus') {
    if (typeof bm.lb === 'number') { vsLives.bottom = bm.lb; vsLives.top = bm.lt; }
    if (typeof bm.sb === 'number') { vsScores.bottom = bm.sb; vsScores.top = bm.st; }
    if (typeof bm.ramp === 'number') vsRamp = bm.ramp;
    // serve cue: present only while the host is in its 'serve' phase, so it
    // self-clears the moment the ball is launched
    vsServeSide = bm.sv === 'top' || bm.sv === 'bottom' ? bm.sv : null;
  } else if (gameMode === 'coop') { // guest is always MP → co-op MP: per-side hearts
    if (typeof bm.lb === 'number') { vsLives.bottom = bm.lb; vsLives.top = bm.lt; }
  }
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
  lifeLost: (m) => {
    audio.sfx('lifeLost'); fx.shake(0.8); vignetteT = 0.6;
    // versus AND co-op MP: mirror the per-side decrement instantly (state
    // snapshots confirm it). Guest is always MP, so coop here = co-op MP.
    if ((gameMode === 'versus' || gameMode === 'coop')
        && (m.side === 'bottom' || m.side === 'top') && vsLives[m.side] > 0) vsLives[m.side]--;
  },
  powerup: (m) => {
    const info = POWERUP_INFO[m.extra];
    audio.sfx('powerup');
    if (info) { fx.floatText(m.x, m.y, info.label, info.color); fx.sparks(m.x, m.y, info.color); }
    // mirror timers locally so the guest HUD shows the same E/S/L/F/C chips
    // (versus: expand is catcher-scoped — the ev carries the catching side)
    if (m.extra === 'expand') {
      if (gameMode === 'versus' && (m.side === 'bottom' || m.side === 'top')) {
        vsSide[m.side].expand = 15;
      } else {
        timers.expand = 15;
      }
    }
    if (m.extra === 'fire') timers.fire = 8;
    if (m.extra === 'slow') timers.slow = 10;
    if (m.extra === 'laser') timers.laser = 10;
    if (m.extra === 'sticky') timers.stickyCharges = Math.min(timers.stickyCharges + 3, 9);
  },
  drop: (m) => { audio.sfx('drop'); void m; },
  laser: () => audio.sfx('laser'),
  launch: () => audio.sfx('launch'),
  stick: () => {
    audio.sfx('stick');
    if (timers.stickyCharges > 0) timers.stickyCharges--; // host consumed one charge
  },
  levelClear: () => { audio.sfx('levelClear'); fx.confetti(); },
  gameOver: () => audio.sfx('gameOver'),
};

const guestPhase = (v, msg = {}) => {
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
    case 'matchend': {
      phase = 'matchend'; remotePaused = false;
      vsWinner = msg.winner === 'top' ? 'top' : 'bottom';
      const youWon = vsWinner === 'top';        // the guest is always the top side
      if (youWon) fx.confetti();
      else audio.sfx('gameOver');
      callbacks.onMatchEnd?.({
        winner: vsWinner, youWon,
        scoreBottom: vsScores.bottom, scoreTop: vsScores.top,
        // prefer the host's authoritative clock; the local one drifts by
        // whatever serve-wait the two sides counted differently
        timeMs: typeof msg.timeMs === 'number' ? msg.timeMs : Math.round(matchTime * 1000),
        levelIdx,
      });
      break;
    }
    case 'backtomenu':
      quit();
      callbacks.onRemoteQuit?.();
      break;
    // host ended the game but kept the room: re-arm as a fresh guest (loop
    // running, phase idle) so the next {t:'level'} pulls us straight into the
    // new match, and let main.js put us back in the lobby view
    case 'backtolobby':
      startGuest();
      callbacks.onRemoteLobby?.();
      break;
  }
};

// Coerce an untrusted peer-supplied level index to a valid array index, or null.
const safeLevelIdx = (v) =>
  (Number.isInteger(v) && v >= 0 && v < LEVELS.length) ? v : null;

const onNetMessage = (msg) => {
  if (!msg || typeof msg !== 'object' || msg.t === 'hb') return;
  if (mode !== 'guest') {
    if (msg.t === 'input') {
      const nx = clamp(Number(msg.x) || 0, 0, FIELD_W);
      // guest paddle velocity from successive packets → host lag-comp for the
      // top paddle. dt guarded > 0; clamp to a sane max so a stale/huge gap
      // (e.g. first packet after a reconnect) can't fling the paddle.
      const nowT = performance.now();
      if (lastGuestInputT > 0) {
        const dtS = (nowT - lastGuestInputT) / 1000;
        if (dtS > 0) guestPadVel = clamp((nx - guestInput.x) / dtS, -PADDLE_SPEED * 3, PADDLE_SPEED * 3);
      }
      lastGuestInputT = nowT;
      guestInput.x = nx;
      guestInput.fire = Boolean(msg.fire);
      // versus: latch the guest's serve request until hostFrame consumes it
      if (gameMode === 'versus' && msg.launch) guestInput.launch = true;
    }
    return;
  }
  switch (msg.t) {
    case 'state':
      snapPrev = snapCur;
      snapCur = { msg, t: performance.now() };
      if (phase === 'idle') phase = 'playing';
      break;
    case 'level': {
      const idx = safeLevelIdx(msg.idx);
      if (idx === null) break; // ignore malformed level message from the peer
      // an arena reload mid-match (cycling / resync) keeps versus match state;
      // anything else (fresh match — msg.fresh, rematch, co-op level) starts
      // clean. Without the fresh flag a host mid-match Retry (setupMatch) is
      // indistinguishable from cycling and the guest's matchTime never resets.
      const cycling = gameMode === 'versus' && msg.mode === 'versus' && !msg.fresh
        && phase !== 'idle' && phase !== 'matchend';
      gameMode = msg.mode === 'versus' ? 'versus' : 'coop';
      buildBricks(idx);
      levelIdx = idx;
      score = 0; combo = 0; lives = LIVES_START; elapsed = 0;
      powerups = []; lasers = []; balls = [];
      snapPrev = null; snapCur = null;
      timers = { expand: 0, slow: 0, laser: 0, fire: 0, stickyCharges: 0 };
      if (gameMode === 'versus') {
        vsSide = freshVsSide();
        vsServeSide = null;    // stale serve cue must not survive an arena swap
        if (!cycling) {
          matchTime = 0; vsRamp = 1; vsWinner = null;
          vsLives = { bottom: VS_LIVES, top: VS_LIVES };
          vsScores = { bottom: 0, top: 0 };
        }
        // restore per-side state sent with the level (arena cycle / resync)
        if (typeof msg.lb === 'number') { vsLives.bottom = msg.lb; vsLives.top = msg.lt; }
        if (typeof msg.sb === 'number') { vsScores.bottom = msg.sb; vsScores.top = msg.st; }
        // no fx.clear(): the arena-clear confetti keeps playing, like the host
      } else {
        // co-op MP: the level message carries the current per-side hearts
        // (fresh game, nextLevel with healing, or reconnect resync)
        if (typeof msg.lb === 'number') { vsLives.bottom = msg.lb; vsLives.top = msg.lt; }
        fx.clear();
      }
      // resync diff (host re-sent state after a reconnect): apply silently
      if (Array.isArray(msg.diff)) {
        for (const d of msg.diff) {
          if (!Array.isArray(d) || !Number.isInteger(d[0])) continue;
          const b = bricks[d[0]];
          if (!b) continue; // integer index → own element or undefined, never a proto
          if (d[1] > 0) b.hp = d[1];
          else b.alive = false;
        }
      }
      phase = 'countdown'; countdownT = COUNTDOWN_LEN; lastTick = 0;
      callbacks.onLevelStart?.(); // host advanced — close any leftover dialog
      break;
    }
    case 'brick': {
      if (!Number.isInteger(msg.idx)) break; // never index with a string like "__proto__"
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
        if (info?.points) {
          const pts = Math.round(info.points * (1 + combo * 0.1)); // mirror host award
          fx.floatText(b.x + BRICK_W / 2, b.y + BRICK_H / 2, `+${pts}`, info.color);
        }
      }
      break;
    }
    case 'ev':
      // own-property only: never resolve msg.name up the prototype chain
      if (typeof msg.name === 'string' && Object.hasOwn(GUEST_EV, msg.name)) GUEST_EV[msg.name](msg);
      break;
    case 'phase':
      guestPhase(msg.v, msg);
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

  // The guest is the top player; flip the PLAYFIELD vertically so their paddle
  // sits at the bottom of their screen — the natural, stable Breakout view.
  // HUD/countdown/overlay text is drawn AFTER the flip is undone so it stays
  // readable. Physics/authority are unchanged: this is purely cosmetic.
  const flip = mode === 'guest';
  ctx.save();
  if (flip) { ctx.translate(0, FIELD_H); ctx.scale(1, -1); }
  drawBackground();
  drawBricks();
  drawPowerups();
  drawLasers();
  drawBalls();
  if (paddles) { drawPaddle('bottom'); drawPaddle('top'); }
  fx.draw(ctx);
  ctx.restore();

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

// versus HUD: orange side bottom-left, blue side top-right, map name top-center,
// small ramp indicator bottom-center. Co-op HUD below stays untouched.
const colorOfSide = (side) => (side === 'bottom' ? ORANGE : BLUE);
// Self is drawn at the screen-bottom, opponent at the top — matching the flipped
// playfield so each player's own hearts sit near their own (bottom) paddle.
const selfSide = () => (mode === 'guest' ? 'top' : 'bottom');
const oppSide = () => (mode === 'guest' ? 'bottom' : 'top');

const drawVersusHud = () => {
  ctx.save();
  ctx.textBaseline = 'middle';
  // map name, top center
  ctx.textAlign = 'center';
  ctx.font = '15px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.fillText(`${levelIdx + 1} · ${levelName}`, FIELD_W / 2, 24);
  const me = selfSide(), them = oppSide();
  // self: hearts + score, bottom-left
  ctx.textAlign = 'left';
  ctx.font = '20px system-ui, sans-serif';
  ctx.fillStyle = colorOfSide(me);
  const hb = '♥'.repeat(Math.max(0, vsLives[me]));
  ctx.fillText(hb, 16, FIELD_H - 24);
  const hbW = ctx.measureText(hb).width;
  ctx.font = 'bold 24px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.fillText(String(vsScores[me]), 16 + hbW + 14, FIELD_H - 24);
  // opponent: hearts + score, top-right
  ctx.textAlign = 'right';
  ctx.font = '20px system-ui, sans-serif';
  ctx.fillStyle = colorOfSide(them);
  const ht = '♥'.repeat(Math.max(0, vsLives[them]));
  ctx.fillText(ht, FIELD_W - 16, 24);
  const htW = ctx.measureText(ht).width;
  ctx.font = 'bold 24px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.fillText(String(vsScores[them]), FIELD_W - 16 - htW - 14, 24);
  // ramp indicator, bottom center, subtle
  ctx.textAlign = 'center';
  ctx.font = 'bold 13px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.fillText(`×${(Math.round(curRamp() * 10) / 10).toFixed(1)}`, FIELD_W / 2, FIELD_H - 14);
  ctx.restore();
};

// Co-op MP HUD: shared score/combo/level name, but per-player hearts —
// orange (bottom player) bottom-left, blue (top player) top-right.
const drawCoopHud = () => {
  ctx.save();
  ctx.textBaseline = 'middle';
  // shared score + combo, top-left
  ctx.textAlign = 'left';
  ctx.font = 'bold 28px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.fillText(String(score), 16, 24);
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
  // level name, top-center
  ctx.textAlign = 'center';
  ctx.font = '15px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.fillText(`${levelIdx + 1} · ${levelName}`, FIELD_W / 2, 24);
  // opponent hearts top-right, self hearts bottom-left (matches the flipped view)
  const me = selfSide(), them = oppSide();
  ctx.textAlign = 'right';
  ctx.font = '20px system-ui, sans-serif';
  ctx.fillStyle = colorOfSide(them);
  ctx.fillText('♥'.repeat(Math.max(0, vsLives[them])), FIELD_W - 16, 24);
  ctx.textAlign = 'left';
  ctx.fillStyle = colorOfSide(me);
  ctx.fillText('♥'.repeat(Math.max(0, vsLives[me])), 16, FIELD_H - 22);
  // active effect timers, bottom-right (kept clear of the bottom-left hearts)
  const chips = [];
  if (timers.expand > 0) chips.push(`E ${Math.ceil(timers.expand)}`);
  if (timers.slow > 0) chips.push(`S ${Math.ceil(timers.slow)}`);
  if (timers.laser > 0) chips.push(`L ${Math.ceil(timers.laser)}`);
  if (timers.fire > 0) chips.push(`F ${Math.ceil(timers.fire)}`);
  if (timers.stickyCharges > 0) chips.push(`C ×${timers.stickyCharges}`);
  if (chips.length) {
    ctx.textAlign = 'right';
    ctx.font = 'bold 14px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillText(chips.join('   '), FIELD_W - 16, FIELD_H - 14);
  }
  ctx.restore();
};

const drawHud = () => {
  if (gameMode === 'versus') { drawVersusHud(); return; }
  if (coopMp()) { drawCoopHud(); return; }
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
    // clamp both ends: 2.1/0.7 is 3.0000000000000004 in IEEE-754, so an
    // unclamped ceil() flashes "4" on the first frame of every countdown
    const n = Math.min(3, Math.max(1, Math.ceil(countdownT / 0.7)));
    const frac = 1 - ((countdownT % 0.7) / 0.7);
    const size = 110 + 40 * (reduced ? 0 : frac);
    centerText(String(n), FIELD_H / 2, size, 'rgba(255,255,255,0.95)', BLUE);
  } else if (phase === 'serve' && mode !== 'guest') {
    if (gameMode === 'versus' && !balls.some((b) => b.stuck && b.stuckTo === 'bottom')) {
      centerText(mode === 'host' ? 'Your friend serves…' : 'The computer serves…',
        FIELD_H / 2 + 90, 22, 'rgba(255,255,255,0.5)');
    } else {
      centerText('Press launch', FIELD_H / 2 + 90, 22, 'rgba(255,255,255,0.5)');
    }
  } else if (mode === 'guest' && gameMode === 'versus' && phase === 'playing'
      && vsServeSide && !remotePaused) {
    // the guest's phase is 'playing' during the host's 'serve' — without this
    // cue a guest who must serve stares at a frozen ball with no affordance
    centerText(vsServeSide === 'top' ? 'Press launch' : 'Your friend serves…',
      FIELD_H / 2 + 90, 22, 'rgba(255,255,255,0.5)');
  } else if (phase === 'matchend') {
    const won = vsWinner === (mode === 'guest' ? 'top' : 'bottom');
    centerText(won ? 'YOU WIN!' : 'YOU LOSE', FIELD_H / 2 - 30, 56, '#ffffff',
      won ? ORANGE : '#ef5350');
  } else if (phase === 'levelclear') {
    centerText('LEVEL CLEAR!', FIELD_H / 2 - 30, 56, '#ffffff', ORANGE);
  } else if (phase === 'gameover') {
    centerText('GAME OVER', FIELD_H / 2 - 30, 56, '#ffffff', '#ef5350');
  } else if (phase === 'idle' && mode === 'guest') {
    centerText('Waiting for the host to pick a level…', FIELD_H / 2, 24, 'rgba(255,255,255,0.6)');
  }

  if (resumeT > 0 && phase !== 'paused' && phase !== 'countdown') {
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
  startVersusAI,
  startVersusHost,
  onNetMessage,
  pause,
  resume,
  quit,
  quitToLobby,   // documented extra: end the game, keep the room (v1.3)
  convertToSolo, // documented extra: host reclaims top paddle ("Continue solo")
  resync,        // documented extra: host re-sends level/brick state to a (re)joined guest
  setCallbacks,
  nextLevel,
  retryLevel,
  applySettings,
  // read-only diagnostic snapshot of internal render state (test/debug only;
  // not part of the module contract). Lets harnesses compare the guest's
  // dead-reckoned ball against the host's authoritative ball.
  __debug: () => ({
    phase, mode, gameMode, levelIdx, levelName,
    balls: balls.map((b) => ({ x: b.x, y: b.y, vx: b.vx, vy: b.vy })),
    pb: paddles?.bottom?.x ?? null, pt: paddles?.top?.x ?? null,
    lives, score, combo,
    vsLives: { ...vsLives }, vsScores: { ...vsScores }, vsRamp,
  }),
};

