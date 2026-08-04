# PortalBreakout — Architecture Contract

**This document is the single source of truth for module boundaries.** Every module MUST export exactly the API described here and MUST NOT reach into another module's internals. All code is vanilla ES modules (`type="module"`). Source lives in `/src`; Vite builds it into `/docs`, which is the committed production bundle GitHub Pages serves (`npm run dev` for local dev, `npm run build` before committing). Never edit `/docs` by hand. Target: Baseline-widely-available browser features; anything newer must be feature-detected with a graceful fallback. No external network dependencies except the optional PeerJS cloud broker for multiplayer signaling (`src/public/vendor/peerjs.min.js` is vendored and copied verbatim into the build).

## Game concept

Classic Breakout, but paddles are **portals**. Two paddles: one at the bottom, one at the top of the field. The ball never bounces off a paddle — entering one paddle teleports it out of the other, **preserving its velocity direction** (a ball falling into the bottom paddle re-enters the field falling from the top paddle; a ball rising into the top paddle re-enters rising from the bottom paddle). Bricks sit in a band in the middle. The ball is lost if it crosses the top or bottom edge *outside* a paddle. Vertical direction only changes by hitting bricks; side walls bounce horizontally.

- **Steering ("portal english")**: on teleport, the ball exits at the same relative offset from the exit paddle's center as it entered the entry paddle, and `vx += offset * PORTAL_ENGLISH` where `offset` is −1..1 relative to paddle half-width. This is the core skill mechanic.
- Each teleport multiplies ball speed by `SPEED_UP` (cap `BALL_SPEED_MAX`), and resets the combo.
- Solo: one player controls both paddles (separate rebindable keys; mouse moves bottom paddle; touch: bottom half of screen drags bottom paddle, top half the top paddle). Optional "assist" setting makes the top paddle mirror the bottom one.
- Multiplayer (2P): host = bottom paddle + authoritative physics; guest = top paddle, sends input, renders host state snapshots.

## Constants (defined in `js/constants.js`, imported everywhere)

```js
export const FIELD_W = 780, FIELD_H = 1100;      // logical units; canvas scales to fit
export const GRID_COLS = 13, GRID_ROWS = 14;      // brick grid
export const BRICK_W = 60, BRICK_H = 34;
export const GRID_TOP = 260;                      // y of first brick row
export const PADDLE_W = 120, PADDLE_H = 18, PADDLE_W_EXPANDED = 180;
export const PADDLE_TOP_Y = 70, PADDLE_BOTTOM_Y = 1030;  // paddle center-line y
export const PADDLE_SPEED = 700;                  // px/s for keyboard control
export const BALL_R = 9, BALL_SPEED = 420, BALL_SPEED_MAX = 900;
export const SPEED_UP = 1.04, PORTAL_ENGLISH = 120;  // vx += offset * PORTAL_ENGLISH on teleport
export const MIN_VY_RATIO = 0.25;                 // anti horizontal-lock: |vy| >= ratio*speed
export const POWERUP_SPEED = 170, POWERUP_R = 16, POWERUP_DROP_CHANCE = 0.11;
export const LIVES_START = 3, MAX_BALLS = 6;
export const STORAGE_SETTINGS = 'pb.settings.v1', STORAGE_PROGRESS = 'pb.progress.v1';
```

## File map (all paths under `src/`)

| File | Owner module | Purpose |
| --- | --- | --- |
| `index.html` | (fixed, already written) | All screens, dialogs, DOM ids |
| `css/style.css` | ui | Material dark theme, ripple, screens, HUD, responsive |
| `js/constants.js` | (fixed) | shared constants above |
| `js/storage.js` | (fixed) | settings + progress persistence |
| `js/levels.js` | levels | 50 level definitions + brick type table |
| `js/audio.js` | audio | procedural WebAudio SFX + music |
| `js/particles.js` | particles | particles, screen shake, floating text, portal FX |
| `js/input.js` | input | keybinds, rebinding, mouse/touch, per-frame paddle intent |
| `js/net.js` | net | PeerJS session, heartbeat, disconnect detection |
| `js/engine.js` | engine | game simulation + canvas rendering + HUD |
| `js/main.js` | engine | bootstrap, wires ui/engine/net/audio together |
| `js/ui.js` | ui | menus, ripple, level grid, rebind UI, dialogs |
| `public/vendor/peerjs.min.js` | (vendored) | PeerJS 1.5.5 (copied as-is to `docs/vendor/`) |

Load order: `index.html` loads `vendor/peerjs.min.js` (classic script, defines global `Peer`) then `js/main.js` as module (bundled by Vite in production).

## `js/levels.js`

```js
export const BRICK_TYPES = {
  // char → { hp, points, color, name } ; hp Infinity for gold
  '1': { hp: 1, points: 50,  color: '#ef5350', name: 'red' },
  '2': { hp: 1, points: 60,  color: '#ff9800', name: 'orange' },
  '3': { hp: 1, points: 70,  color: '#ffeb3b', name: 'yellow' },
  '4': { hp: 1, points: 80,  color: '#66bb6a', name: 'green' },
  '5': { hp: 1, points: 90,  color: '#26c6da', name: 'cyan' },
  '6': { hp: 1, points: 100, color: '#42a5f5', name: 'blue' },
  '7': { hp: 1, points: 110, color: '#ab47bc', name: 'purple' },
  '8': { hp: 1, points: 120, color: '#ec407a', name: 'pink' },
  'S': { hp: 2, points: 150, color: '#b0bec5', name: 'silver' },
  'G': { hp: Infinity, points: 0, color: '#ffd54f', name: 'gold' },   // indestructible, excluded from completion
  'E': { hp: 1, points: 150, color: '#ff7043', name: 'explosive' },   // destroys 3×3 neighborhood, chains
  'P': { hp: 1, points: 100, color: '#7e57c2', name: 'powerup' },     // guaranteed powerup drop
};
// LEVELS: array of 50. rows: exactly GRID_ROWS strings of exactly GRID_COLS chars ('.' = empty).
export const LEVELS = [ { name: 'Aperture Rows', rows: [ '.............', /* ×14 */ ] }, /* … */ ];
```

Levels are inspired by famous Breakout/Arkanoid layouts (rainbow rows, pyramid, space invader, DOH face, checkerboard, tunnels, fortress…) plus Portal-themed pixel art (companion cube, cake, turret, portal rings, "PB" letters…). Difficulty ramps: early levels sparse & soft colors, later ones dense with S/G/E. Every level MUST be completable (≥1 destructible brick; no destructible brick fully enclosed by gold).

## `js/storage.js` (already written — read it)

```js
export function loadSettings() → settings object (deep-merged over defaults)
export function saveSettings(patch)               // shallow-merge + persist
export function loadProgress() → { levels: { [idx]: { completed, bestScore, bestTimeMs } } }
export function recordLevelResult(idx, { score, timeMs, completed })
export function isUnlocked(idx, progress)          // level 0 always; else levels[idx-1].completed
export const DEFAULT_SETTINGS                       // see shape below
```

Settings shape (also the rebindable actions list):

```js
{
  binds: {
    bottomLeft: 'ArrowLeft', bottomRight: 'ArrowRight', bottomFire: 'ArrowUp',
    topLeft: 'KeyA', topRight: 'KeyD', topFire: 'KeyW',
    launch: 'Space', pause: 'Escape',
  },                                        // values are KeyboardEvent.code
  audio: { master: 0.8, music: 0.5, sfx: 0.9, muted: false },
  effects: 'full' | 'reduced',              // default 'full' unless prefers-reduced-motion
  assist: false,                            // top paddle mirrors bottom in solo
  playerName: '',
}
```

## `js/audio.js`

All sounds synthesized with WebAudio (no assets). Must lazy-init the `AudioContext` on first user gesture (`init()` is idempotent; call it from any click/keydown).

```js
export const audio = {
  init(),                          // create/resume AudioContext (safe to call repeatedly)
  applySettings(settings.audio),   // volumes + mute
  sfx(name, opts = {}),            // fire-and-forget; opts.combo (int) raises pitch for 'brick'
  music(track|null),               // 'menu' | 'game' | null → stop; light generative loop, ~-20LUFS feel
};
```

SFX names (exact): `portal` (teleport whoosh/zap), `brick`, `silver`, `gold` (clank), `explode`, `wall`, `powerup` (catch), `drop` (powerup spawns), `laser`, `lifeLost`, `levelClear`, `gameOver`, `click` (UI), `launch`, `stick`, `countdown`, `win`.

## `js/particles.js`

Owns all visual juice. Engine calls these; the system draws onto the game canvas ctx each frame. Honors `setEffectsLevel('full'|'reduced')` — 'reduced' = no shake, minimal particles, no slow-mo flash.

```js
export const fx = {
  setEffectsLevel(level),
  update(dt),                       // dt seconds
  draw(ctx),                        // draw all live effects (called after entities)
  shakeOffset() → {x, y},           // engine translates canvas by this before drawing world
  brickBurst(x, y, color, count?),  // shard explosion
  explosion(x, y),                  // big boom (E bricks)
  portalFlash(x, y, side),          // side: 'top'|'bottom' — orange (bottom) / blue (top) swirl
  trail(x, y, color),               // ball trail puff (engine calls per-frame per ball)
  floatText(x, y, text, color?),    // rising score/combo text
  sparks(x, y, color, dir?),        // small impact sparks (walls, paddle catches)
  confetti(),                       // level clear celebration (full-field)
  shake(strength),                  // 0..1
  clear(),
};
```

## `js/input.js`

```js
export const input = {
  attach(canvas),                       // install all listeners (kbd on window, pointer/touch on canvas)
  applySettings(settings),              // update binds + assist
  setMapper(fn),                        // fn(clientX, clientY) → {x, y} field coords (engine provides)
  state() → {
    bottom: { move: -1|0|1, targetX: number|null, fire: bool },   // targetX = pointer-driven absolute x
    top:    { move: -1|0|1, targetX: number|null, fire: bool },
    launch: bool, pause: bool,          // pause is edge-triggered (true once per press)
  },
  captureNext(cb),                      // rebind mode: next keydown → cb(code); Escape cancels → cb(null)
  reset(),                              // clear held state (call on blur / screen change)
};
```

Pointer rules: mouse always drives the **bottom** paddle (`targetX`); touches drive whichever paddle's half of the field they start in (multi-touch: one finger per half). Keyboard `move` beats stale `targetX` (a fresh key press clears that paddle's `targetX` until the pointer moves again).

## `js/net.js`

```js
export const net = {
  host(cb) → Promise<roomCode>,     // create PeerJS room; roomCode: 'pb-' + 5 chars base32
  join(roomCode, cb) → Promise<void>,
  send(msg),                        // JSON-serializable; silently drops if not connected
  close(),
  get connected() → bool, get role() → 'host'|'guest'|null,
}
// cb(event) receives: { type: 'open' } | { type: 'data', msg } | { type: 'peer-joined' }
//   | { type: 'lost' }       — heartbeat missed ≥3s or connection closed: show banner, pause game
//   | { type: 'reconnected' }
//   | { type: 'closed' }     — final (peer destroyed / gave up after 30 s)
//   | { type: 'error', message }
```

Heartbeat: both sides send `{t:'hb', ts}` every 1 s over the data channel; if nothing (any message counts) received for 3 s → emit `lost`; keep the Peer alive and if data resumes within 30 s → `reconnected`, else `closed`. Uses vendored PeerJS with default cloud broker; one reliable ordered DataChannel.

ICE: net.js passes an explicit `config.iceServers` (public STUN + best-effort public TURN relays) instead of PeerJS defaults. Order of precedence: `localStorage['pb.ice.v1']` (JSON array of RTCIceServer, manual override) → short-lived credentials fetched from a TURN-credentials endpoint (`constants.ICE_ENDPOINT`, testable via `localStorage['pb.iceurl.v1']`; endpoint shape `{ttl, iceServers:[…]}`; fetch failures never block a session) → the public defaults. `?relay=1` forces `iceTransportPolicy:'relay'` for TURN-path testing. The self-hosted relay stack lives in `server/turn/` (coturn REST-auth + minting endpoint, podman-first, `.env`-configured with auto-generated secret).

Wire protocol (host authoritative, guest = top paddle):

- guest→host `{t:'input', x, fire}` (x = paddle center in field coords, ~30/s), `{t:'hb', ts}`
- host→guest `{t:'state', balls:[[x,y],…], pb:x, pt:x, lasers:[[x,y,dir],…], pups:[[x,y,kind],…], score, lives, combo}` ~25/s
- host→guest `{t:'brick', idx, hp}` (hp left; 0 = destroyed), `{t:'level', idx}` (load level, resets bricks), `{t:'ev', name, x?, y?, extra?}` (play sfx/fx at position), `{t:'phase', v}` (`countdown|playing|paused|resumed|levelclear|gameover|backtomenu`)

## `js/engine.js`

```js
export const engine = {
  mount(canvas),                     // set up ctx, resize observer, input.attach + input.setMapper
  startSolo(levelIdx, opts?),        // opts: { replay?: bool }
  startHost(levelIdx),               // multiplayer host (bottom paddle local)
  startGuest(),                      // multiplayer guest (renders snapshots, sends input)
  onNetMessage(msg),                 // main.js forwards net 'data' events here
  pause(reason?), resume(), quit(),  // quit → stops loop, engine emits 'backtomenu'
  setCallbacks({ onLevelEnd, onGameOver, onPauseChange }),
    // onLevelEnd({ levelIdx, score, timeMs, cleared }) — show dialog; engine idles until told
  nextLevel(), retryLevel(),         // called by main.js from the level-end dialog
  applySettings(settings),
}
```

Rules of play: ball starts stuck to bottom paddle (top paddle for guest? no — always bottom; host launches). `launch` releases it at 60° up ±20° random. Lives shared (multiplayer too). Powerups: `multi` (split each ball into 3, cap MAX_BALLS), `expand` (both paddles ×1.5, 15 s), `slow` (ball speeds ×0.7 floor BALL_SPEED, 10 s), `sticky` (next 3 paddle entries hold the ball on the *exit* paddle until launch), `laser` (both paddles can fire for 10 s, 4 shots/s max), `life` (+1), `fire` (fireball pierces destructible bricks, 8 s). Powerups spawned in the upper half of the brick band float **up** (top paddle catches), lower half fall **down**. Combo: +1 per brick in a single volley (resets on portal pass); score `points × (1 + combo*0.1)` rounded. Slow-mo ~0.3 s on last brick. HUD (score, lives ×♥, level name, combo) drawn on canvas. Countdown 3-2-1 on level start/resume-from-life-loss. All juice via `fx.*`, all sound via `audio.sfx`.

## `index.html` DOM contract (already written — read it; do not rename ids)

Screens: `#screen-menu`, `#screen-levels`, `#screen-game` — exactly one has class `active`. Dialogs: `#dlg-options`, `#dlg-multiplayer`, `#dlg-how`, `#dlg-pause`, `#dlg-level-end`, `#dlg-confirm-quit`. Canvas: `#game-canvas`. Net banner: `#net-banner`. See file for all button/label ids.

## `js/ui.js`

```js
export const ui = {
  init({ onAction }),   // wires all menus; onAction(name, data) with names:
    // 'play' {levelIdx}, 'replay' {levelIdx}, 'host', 'join' {code}, 'options-changed' {settings},
    // 'pause', 'resume', 'retry', 'next-level', 'quit-to-menu', 'cancel-mp'
  showScreen('menu'|'levels'|'game'),
  refreshLevelGrid(),                        // re-render from storage progress + LEVELS
  showLevelEnd({ cleared, score, best, levelIdx, isLast }),
  showPause(), hidePause(),
  netStatus('idle'|'waiting'|'connected'|'lost'|'closed', data?),  // banner + mp dialog states
  showRoomCode(code), toast(text),
}
```

ui.js also implements: Material ripple on `.btn` (pointer-centered; keyboard Enter/Space → centered ripple), rebind capture flow (click bind button → "press a key…" → `input.captureNext`), options form ↔ settings sync, level grid (50 tiles: locked 🔒 / done ✓ + best score / current ▶), and dialog fallback for browsers without invoker commands (feature-detect `commandForElement`).

## Visual & UX rules (from user's global design standards)

Dark Material theme. Tokens in `:root`: `--bg: #121212`, `--surface: #1e1e1e`, `--surface-2: #2a2a2a`, `--primary: #ff9800` (portal orange), `--secondary: #40c4ff` (portal blue), `--text: rgba(255,255,255,.92)`, `--text-dim: rgba(255,255,255,.6)`, `--danger: #ef5350`. Buttons: filled (primary) & tonal variants, ripple, visible `:focus-visible` ring, hover/active elevation, disabled states. Dialogs: elevated surface, `::backdrop` blur+dim. Respect `prefers-reduced-motion` (no ripple scale anim, no menu transitions; game fx default to 'reduced'). Semantic HTML, labels on all inputs, full keyboard navigation. Portal identity: orange = bottom paddle, blue = top paddle, everywhere (menus, HUD, paddles, portal fx).

## Multiplayer flow

Host: menu → Multiplayer → "Create room" → room code + share link (`?join=CODE` URL) shown → friend joins → host picks level → play. Guest: Multiplayer → paste code (or arrive via link → dialog pre-filled) → "Join". On `lost`: engine pauses, banner "⚠ Connection lost — waiting…", dialog offers **Wait** / **Continue solo** (engine converts to solo: local player takes both paddles) / **Quit**. On `reconnected` while waiting: countdown + resume. Guest side mirrors the same UX.

## Versus mode (v1.1)

A competitive mode: **bottom side vs top side**. Two variants: **vs Computer** (local player = bottom paddle, engine-internal AI = top paddle) and **vs Friend** (host = bottom, guest = top, host authoritative — same transport as co-op). Co-op ("campaign") behavior above is unchanged; versus is a parallel mode, never records level progress, and reuses the same field/bricks/powerups/portal physics.

### Rules

- Each side has `VS_LIVES = 3` lives (cap `VS_LIFE_MAX = 5` via life powerups). A ball crossing the **bottom** edge uncaught → bottom side −1 life; **top** edge → top side −1 life. Every ball counts individually in multiball. First side at 0 → match ends immediately, the other side wins.
- After a life loss (match not over): if no balls remain in play, the side that lost the life serves next (stuck ball on their paddle). The AI auto-launches after ~1 s; the MP guest launches via its own launch input (relayed).
- **Bricks persist as the arena.** Ball ownership = the side whose portal last emitted it (server on serve); bricks broken credit the owner's score (same combo ×(1+0.1·combo) math, per-side scores). When a map is fully cleared: brief celebration, arena reloads with the next map (`(idx+1) % 50`), single ball re-served by the side that broke the last brick; lives, scores and the speed ramp persist.
- **Anti-stalemate ramp:** match time `t` (s) drives `ramp = min(1 + VS_RAMP_RATE·t, VS_RAMP_MAX)`. Effective ball speed floor = `BALL_SPEED·ramp`; per-teleport `SPEED_UP` still applies; hard cap `min(BALL_SPEED_MAX·ramp, VS_BALL_SPEED_MAX)`. `slow` still gives ×0.7 temporary relief; the floor re-applies when it expires.
- **Powerups are catcher-scoped** where sided: `expand`/`sticky`/`laser` apply to the catching paddle only; `life` = +1 to the catcher's side; `multi`/`slow`/`fire` remain global ball effects. The AI may catch powerups.
- HUD: bottom lives as orange ♥ bottom-left, top lives as blue ♥ top-right, per-side scores beside them, map name center-top, ramp indicator (e.g. `×1.4`) center-bottom, subtle and small.
- Pause: solo-vs-AI pauses like solo. MP versus: host-only pause (existing rules). No `recordLevelResult` calls ever in versus.

### Constants (added to `js/constants.js`)

```js
export const VS_LIVES = 3, VS_LIFE_MAX = 5;
export const VS_RAMP_RATE = 0.008, VS_RAMP_MAX = 1.9, VS_BALL_SPEED_MAX = 1150;
export const AI_PROFILES = {   // top-paddle AI tuning
  easy:   { speed: 420, err: 60, react: 0.35 },   // px/s, aim error px, re-aim interval s
  normal: { speed: 560, err: 35, react: 0.22 },
  hard:   { speed: 700, err: 18, react: 0.12 },
};
```

### AI (engine-internal, top paddle, solo versus only)

Each `react` interval, pick the nearest ball with `vy < 0` (heading top), predict its x at `PADDLE_TOP_Y` with wall-bounce reflection, add uniform aim error `±err` scaled up with ball speed; move toward the target at ≤ `speed` px/s. No threat → drift toward the nearest catchable powerup (one floating up), else toward field center. Auto-launch stuck balls after ~1 s aimed with the standard serve spread; with laser active, fire opportunistically at live bricks on cooldown. The AI must feel beatable, not psychic: it reads only ball/powerup positions (no future spawn knowledge) and its error grows with the ramp.

### Wire protocol additions (host→guest unless noted)

- `{t:'level', idx, mode?}` — `mode:'versus'` when starting/reloading an arena in versus (absent = co-op). `engine.resync()` includes it.
- `{t:'state', …}` gains in versus: `lb`, `lt` (lives bottom/top), `sb`, `st` (scores), `ramp` (display only).
- `{t:'ev', name:'lifeLost', side:'top'|'bottom'}` — side is REQUIRED in versus.
- `{t:'phase', v:'matchend', winner:'bottom'|'top'}` — terminal for the match.
- guest→host `{t:'input', x, fire, launch}` — `launch` added (guest serves its own ball in versus).

### API additions

```js
engine.startVersusAI(difficulty /* 'easy'|'normal'|'hard' */, levelIdx?)   // levelIdx default: random
engine.startVersusHost(levelIdx?)                                          // MP versus, host side
// guest side: startGuest() unchanged — mode arrives via {t:'level', mode:'versus'}
engine.setCallbacks({ …, onMatchEnd })   // onMatchEnd({ winner, youWon, scoreBottom, scoreTop, timeMs })
                                         // youWon: from the local side's perspective (guest = top)
ui.showMatchEnd({ youWon, scoreYou, scoreThem, timeMs, canRematch })
  // reuses #dlg-level-end: title 'You win! 🏆' / 'You lose', per-side stats,
  // #btn-le-next relabeled 'Rematch' (hidden when !canRematch — MP guest sees
  // "the host picks" convention), #btn-le-replay hidden, #btn-le-menu = Menu.
// new ui actions: 'versus-ai' {difficulty}, 'versus-mp', 'rematch'
```

`main.js`: `'versus-ai'` → `engine.startVersusAI(difficulty)`; `'versus-mp'` → if `net.role === 'host'` start `engine.startVersusHost()` else toast + open the multiplayer dialog; `'rematch'` → restart the same versus config (host relays to guest via the normal start messages). Match end goes through `leaveGame()`-style cleanup only when leaving to menu; rematch keeps the net session.

### DOM additions (`index.html` — already updated; do not rename ids)

Menu button `#btn-versus` opens `#dlg-versus`: a "vs Computer" section (difficulty `<select id="vs-difficulty">` easy/normal/hard + `#btn-vs-ai` start) and a "vs Friend" section (`#btn-vs-friend`: when MP-connected as host it starts the online match, otherwise it opens `#dlg-multiplayer` to connect first; ui.js relabels it accordingly, id stays).

## Multiplayer v1.2 — latency reduction + lobby

Targets a high-latency intercontinental link (~250–300 ms RTT, often TURN-TCP relayed). Every change below is transport-agnostic (helps over a reliable ordered TCP relay too — do NOT rely on unreliable DataChannels). Host stays authoritative; co-op and versus both benefit.

### RTT measurement (`js/net.js`)

- Heartbeat becomes a ping/echo: sender emits `{t:'hb', ts}` (ts = `performance.now()`), receiver immediately replies `{t:'hback', ts}` (echoing the received ts). On `hback`, sender computes `rtt = performance.now() - ts` and folds it into an EWMA. `hb` interval 0.5 s (liveness thresholds unchanged: `lost` at 3 s, give-up 30 s). Both `hb` and `hback` are handled inside net.js and NEVER forwarded as `data`; both refresh `lastReceived`.
- New API: `net.rtt` (getter → smoothed RTT ms, 0 if unknown), `net.oneWay` (getter → `clamp(rtt/2, 0, NET_LAGCOMP_MAX_MS)` ms). Reset on every new session.

### Ball dead-reckoning (`js/engine.js`, guest render)

- State snapshot balls now carry velocity: `balls: [[x, y, vx, vy], …]` (vx/vy rounded px/s). Everything else in the `state` message is unchanged (`pb`, `pt`, `lasers`, `pups`, `score`, `lives`, `combo`, versus `lb/lt/sb/st/ramp/sv`).
- Guest stops pure interpolation. For each ball it keeps a smoothed `renderPos`. Each frame: `target = snapPos + vel * (ageSec + oneWaySec)` (ageSec = time since the snapshot was received; oneWaySec = `net.oneWay/1000`), clamped to the field; `ageSec` capped so total lead ≤ `NET_EXTRAP_MAX_MS`. Move `renderPos` toward `target` with exponential smoothing (time constant `NET_SMOOTH_TAU`); if `|target − renderPos| > NET_SNAP_DIST` (a bounce/teleport the guest couldn't predict) snap directly. vx/vy give the correct orange=falling / blue=rising colour cue. New/removed balls (multiball, loss) reset cleanly by index.
- Opponent paddle (bottom / host) on the guest: extrapolate from the last two snapshots' `pb` delta by `oneWay`, lightly smoothed (same τ). The guest's own (top) paddle stays fully local/predicted (zero latency) — unchanged.

### Host-side lag compensation for the guest paddle (`js/engine.js`, host)

- Host tracks the guest paddle velocity from successive `input` messages (Δx / Δt using `performance.now()` on receipt). When resolving the **top** paddle's portal/miss AND when rendering it, the host uses `guestPadX + guestPadVel * oneWay` (clamped to walls) so the host's notion of the guest paddle matches where the guest actually has it *now*. Applied only when `0 < oneWay ≤ NET_LAGCOMP_MAX_MS`.
- Extra top-paddle catch tolerance: widen the top paddle's effective catch half-width by `min(|guestPadVel| * oneWaySec, NET_CATCH_TOL_MAX)` px, so a guest mid-correction isn't unfairly missed. Never applied to the bottom (host-local) paddle. Purely reduces false misses; never lets the guest catch a ball its paddle can't plausibly reach.

### Send rates (`js/engine.js`)

- State broadcast: `NET_STATE_HZ` (30/s). Guest input: `NET_INPUT_HZ` (40/s), plus an immediate send on any `fire`/`launch` edge so serves/laser feel responsive.

### Versus ball acceleration

- `VS_RAMP_RATE` raised (0.008 → 0.011) so the anti-stalemate speed-up ramps a bit sooner. Caps (`VS_RAMP_MAX`, `VS_BALL_SPEED_MAX`) unchanged.

### Constants (added/changed in `js/constants.js` — already edited)

```js
export const NET_STATE_HZ = 30, NET_INPUT_HZ = 40;
export const NET_EXTRAP_MAX_MS = 300;    // cap dead-reckoning lead
export const NET_SMOOTH_TAU = 0.06;      // guest position smoothing time constant (s)
export const NET_SNAP_DIST = 120;        // px error above which to snap instead of smooth
export const NET_LAGCOMP_MAX_MS = 400;   // ignore extrapolation beyond this (bad RTT)
export const NET_CATCH_TOL_MAX = 24;     // px extra top-paddle catch tolerance for the remote paddle
// VS_RAMP_RATE changed 0.008 → 0.011
```

## Multiplayer lobby (v1.2) — intuitive party flow

Replaces the "friend joins → dialog closes → host uses the normal Play/Levels buttons" flow (which felt like a cancelled action) with an explicit lobby. New dialog `#dlg-lobby` (already in `index.html`, `closedby="none"`), driving both co-op and versus setup.

Flow:
1. Menu → "Play with a friend" opens `#dlg-multiplayer` (unchanged: Create room / Join with code). Menu → "Versus" → "vs Friend" routes into the same connect step, defaulting the lobby mode to versus.
2. **Host** clicks Create room → `#dlg-multiplayer` closes, `#dlg-lobby` opens in host view: invite code + **always-visible** "Copy invite link" (`#lobby-room-code`, `#btn-lobby-copy`), a **Mode** select (`#lobby-mode`: co-op / versus), a **Map** select (`#lobby-map`, filled from `LEVELS`), a **Start** button (`#btn-lobby-start`, disabled until a friend joins), a **Remove friend** button (`#btn-lobby-kick`, hidden until joined), and **Leave** (`#btn-lobby-leave`). Guest slot (`#lobby-guest-slot`) shows "Waiting for a friend…".
3. **Guest** joins (code or `?join=` link) → on `open`, `#dlg-multiplayer` closes and `#dlg-lobby` opens in guest view (`#lobby-guest` shown, host controls `#lobby-host` hidden): "Waiting for the host to choose the map…".
4. Host `peer-joined` → guest slot shows "Friend connected", Start enabled, Kick shown; host sends `{t:'lobby'}` so the guest is definitively in the lobby view. (Optionally `{t:'lobby', mode, map}` to preview the host's current pick — guest may show "Host is setting up: Versus · <map name>".)
5. Host picks Mode + Map, clicks **Start** → co-op: `startGame(mapIdx)` → `engine.startHost(mapIdx)`; versus: `startVersus({type:'mp', levelIdx: mapIdx})` → `engine.startVersusHost(mapIdx)`. Either sends `{t:'level', mode, …}`; both sides close the lobby (guest on `onLevelStart`/first `level` message, host on Start) and enter the game.
6. **Kick**: host → `net.send({t:'kick'})` then `leaveGame()`-style teardown of the session; guest on `{t:'kick'}` → close lobby, return to menu, toast "The host removed you from the room." **Leave**: host or guest → close lobby + `net.close()` (the peer sees the normal `closed`/`lost` path → menu).

Wire additions: host→guest `{t:'lobby', mode?, map?}` (enter/refresh lobby) and `{t:'kick'}`. Both are lobby-control messages handled in `main.js`'s net `data` branch (peeked before `engine.onNetMessage`, which ignores unknown `t`).

New/changed `ui.js` API: `ui.showLobby({role, code, connected})`, `ui.updateLobby({connected, guestName?})`, `ui.hideLobby()`; new `onAction` names: `'lobby-start' {mode, levelIdx}`, `'lobby-kick'`, `'lobby-leave'`. `#dlg-multiplayer`'s old inline room-box/copy may remain but the lobby is the canonical share surface. Rematch still reuses the existing path (host relays via the start messages); the lobby is only for initial setup.

## Co-op lives model (v1.2.1)

Three distinct lives models, keyed by mode:

- **Solo campaign** (`mode === 'solo'`, gameMode `coop`): unchanged — one shared `lives` counter (`LIVES_START = 3`), reset per level, single ♥ row in the HUD, game over at 0.
- **Co-op multiplayer** (`gameMode === 'coop'` AND `mode` is `host`/`guest`): **each player has their own hearts** (`vsLives.bottom` / `vsLives.top`, start 3). A ball lost past your edge costs *your* side one heart (never below 0). On **level clear, every side below 3 regains one heart** (0→1 revives a downed partner). **Game over only when BOTH sides reach 0.** Score stays shared. HUD shows two heart rows (orange bottom-left, blue top-right) + shared score/combo/level name. Lives persist across levels (healed), not reset per level.
- **Versus** (`gameMode === 'versus'`, AI or MP): per-side lives, **first side to 0 loses** (match ends immediately). Unchanged from v1.1.

Wire: co-op MP `state` now carries `lb`/`lt` (per-side lives); the co-op `level` message carries `lb`/`lt` for initial/ resync sync. `{t:'ev', name:'lifeLost', side}` carries `side` in co-op too so the guest mirrors the correct heart. Guest is always MP, so `gameMode === 'coop'` on the guest means co-op MP (two heart rows). Default friend games are **versus** (each player their own lives); co-op is the other lobby Mode option.

## Play again without re-inviting (v1.3)

Before v1.3 every post-game exit except same-map **Rematch** ran `leaveGame()` → `net.close()`, so choosing a different map forced a fresh invite. The room now survives the end of a game.

- **`#dlg-level-end` gains `#btn-le-lobby` ("Change map")**, shown only while a room is live and usable (`net.role && net.connected`), for host *and* guest, in versus match-end and co-op level-end/game-over. When it is shown, `#btn-le-menu` is relabelled **"Leave game"** so ending the session is a deliberate act. `ui.showLevelEnd`/`ui.showMatchEnd` take `canLobby`.
- **Host** clicks it → `'back-to-lobby'` → `engine.quitToLobby()`: identical to `quit()` (shared `teardown()`) except it broadcasts `{t:'phase', v:'backtolobby'}` and never touches the net session. `main.js` then returns to the menu screen and re-opens the lobby seeded with the mode + map just played, and sends `{t:'lobby', mode, map}`.
- **Guest** receiving `backtolobby` → engine `startGuest()` (re-arm: loop running, `phase='idle'`, so the next `{t:'level'}` pulls it straight into the new match) + `callbacks.onRemoteLobby()` → close the end/pause dialogs, back to the lobby view. A guest may also click "Change map" itself: it re-arms locally and waits in its lobby; the host's later Start/Rematch still reaches it.
- **Start** from the re-entered lobby begins a fresh game on both sides (lives/scores/ramp reset) with no re-invite. Kick, Leave, `closed`, `lost` and every other `quit()` caller keep their v1.2 behavior (still `backtomenu`).
- `engine.onMatchEnd` payload gains `levelIdx` so the lobby can re-open on the arena just played.

## Map previews in the lobby (v1.3)

Picking a map by name alone was guesswork, so `#dlg-lobby` shows the layout. `#lobby-preview` (a `<figure>` with `#lobby-preview-canvas`, `aria-hidden`, and `#lobby-preview-name`) sits below the selects and is visible to **both** roles; the `<select>` remains the accessible control.

- `renderLevelThumb(canvas, levelIdx)` (`ui.js`) draws `LEVELS[idx].rows` as a `GRID_COLS × GRID_ROWS` mini-playfield in the real `BRICK_TYPES` colors over the field's dark background, with the two portal paddles hinted top/bottom, DPR-aware.
- Host changing `#lobby-map` or `#lobby-mode` emits `'lobby-config' {mode, levelIdx}` → `main.js` sends `{t:'lobby', mode, map}` (host + connected only), so the **guest's preview and "Host is setting up: Mode · Map" line track the host's browsing live**. The `peer-joined` `{t:'lobby'}` carries the current selection too. `ui.updateLobby` accepts `{mode, levelIdx}` and validates the peer-supplied index.
- `ui.showLobby` takes an optional `levelIdx` to seed select + preview; `ui.lobbyConfig()` returns the host's current `{mode, levelIdx}`.
- The lobby Mode option text for co-op now matches the v1.2.1 model ("3 lives each, revive on level clear"), and `.field-row select` gets `min-width: 0` — a flex item's `min-width: auto` let the long option text push the select past the dialog edge on ≤420px screens.

## Arena picker, join cue, difficulty re-entry (v1.3.1)

- **vs Computer picks its arena.** `#dlg-versus` gains `#vs-map` (a `Random arena` option plus all 50 levels) and `#vs-preview`, using the same `renderLevelThumb`. `'versus-ai'` now carries `levelIdx` (`undefined` for Random) → `engine.startVersusAI(difficulty, levelIdx)`, whose second parameter already existed and was simply never supplied. Random stays the default, so the previous behavior is what you get if you don't choose. `buildMapSelect(sel, {random})` and `paintPreview(canvasId, nameId, value)` are shared by both dialogs.
- **A friend joining is audible.** New `join` SFX (a rising D–A–D call over a portal shimmer, `SFX_DUR.join`), played on `peer-joined` (host), `open` (guest) and `reconnected`. A toast alone is easy to miss when you are waiting on someone else to act.
- **`#btn-le-setup` ("Change difficulty")** on the match-end dialog for solo vs-Computer games (`canSetup`, i.e. `!net.role && vsConfig.type === 'ai'`) → `'versus-setup'` → quit to the menu and re-open `#dlg-versus` via `ui.showVersusSetup()`; the selects keep their last values, so it reads as "adjust" rather than "start over". `setLevelEndExit(canLobby, canSetup)` owns both optional exits.
- When a friend leaves mid-versus and the AI takes over, `vsConfig` keeps its `levelIdx` so a rematch stays on the same arena.

## Music: variation, intensity, event switching (v1.3.1)

The music stays fully procedural (no assets). What changed is that it is no longer one fixed loop.

- **Four songs** (`GAME_STYLES`): `aperture` (the original track, parameter for parameter), `coolant` (92 BPM, dubbier), `cascade` (128 BPM, sawtooth drive), `skybox` (118 BPM, brighter). Each defines tempo, root movement, arp pattern set, oscillator types, filter base/range and rest probability. `setupGame(s, avoid, force)` picks one at random whenever the game track starts, so consecutive games differ.
- **Ball speed drives intensity.** `engine.reportIntensity()` (per frame) sends the fastest in-play ball normalised over `BALL_SPEED`→`BALL_SPEED_MAX` (or `VS_BALL_SPEED_MAX` in versus) to `audio.setIntensity(0..1)`. Audio smooths it (~1 s) and maps it to filter cutoff, arpeggio density (fewer rests), note/bass level, hat brightness, plus extra percussion above 0.45 and an octave ping above 0.7. Tempo deliberately does **not** change — shifting it mid-loop wobbles.
- **Events change the song.** `audio.nextSong({force, ret})` cross-fades to a *different* style, rate-limited to one switch per `SONG_MIN_GAP` (15 s). The engine calls it when intensity crosses a gear (`INTENSITY_GEARS = [0.55, 0.82]`, upward only) and on `multi` / `fire` pickups.
- **Effect-scoped switches hand back.** A pickup switch passes `ret: true`, recording the interrupted style; `engine.effectMusicWatch()` (per frame) detects the effect ending — `timers.fire` reaching 0, or the ball count returning to 1 — and calls `audio.resumeSong()`, which cross-fades back to the remembered track and clears the marker. Watched per frame rather than at the mutation sites because these effects can also end via a lost life, a level change, or a host state update on a guest. Changing tracks (`music()`) clears any pending return.
- `audio.__debug()` reports `{track, style, intensity, intensityTarget, songs, returnTo}` for tests; `window.__pb` now exposes `audio`.
