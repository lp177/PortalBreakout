// PortalBreakout — input: keybinds, rebinding, mouse/touch, per-frame paddle intent
// (see CONTRACT.md "js/input.js"). No side effects at import time; attach() installs listeners.

import { FIELD_H } from './constants.js';
import { DEFAULT_SETTINGS } from './storage.js';

let binds = { ...DEFAULT_SETTINGS.binds };
let boundCodes = new Set(Object.values(binds));
// Assist (top paddle mirrors bottom) is applied by the engine, which knows the
// game mode (solo vs multiplayer); input keeps reporting raw per-paddle intent.
let assist = DEFAULT_SETTINGS.assist;

let mapper = null;                 // fn(clientX, clientY) → {x, y} in field units
let canvasEl = null;               // set by attach(); used to tell if the field is on screen

const held = new Set();            // KeyboardEvent.code values currently down
let pauseEdge = false;             // reported true exactly once per physical press
let launchEdge = false;            // transient tap-to-serve edge (touch/pen)
// per-player serve edges: P1 uses binds.launch, P2 uses binds.launch2, so two
// people on one keyboard can each serve their own ball in a local versus match
let launchEdgeSide = { bottom: false, top: false };
let bottomTargetX = null;          // pointer-driven absolute x, field units
let topTargetX = null;
let ownerBottom = null;            // pointerId owning each paddle (touch/pen only)
let ownerTop = null;

let captureHandler = null;         // active one-shot rebind listener, or null
let detachFns = [];                // listener removers from the last attach()

// ---- gamepads (local 2-player) ----------------------------------------------
// The first connected pad drives the bottom paddle, the second the top, so two
// people can play on one machine. `move` is analog: movePaddle multiplies it by
// PADDLE_SPEED, so a half-pushed stick is genuinely half speed.
const PAD_DEADZONE = 0.22;
const PAD_BTN = {
  launch: [0, 3],          // A / Y
  fire: [1, 2, 5, 7],      // B, X, right shoulder, right trigger
  pause: [9, 8],           // Start / Select
  left: 14, right: 15,     // d-pad
};
// per-pad previous button state, keyed by gamepad index, for edge detection
const padPrev = new Map();
let padLaunchEdge = { bottom: false, top: false };
let padActive = { bottom: false, top: false };

const livePads = () => {
  if (typeof navigator === 'undefined' || !navigator.getGamepads) return [];
  // getGamepads() returns a live snapshot with holes — never cache it
  return [...navigator.getGamepads()].filter((p) => p && p.connected)
    .sort((a, b) => a.index - b.index);
};

const pressed = (pad, idx) => Boolean(pad.buttons[idx]?.pressed);
const anyPressed = (pad, list) => list.some((i) => pressed(pad, i));

// Read one pad into per-paddle intent, latching launch/pause as edges.
const readPad = (pad, side) => {
  const axis = pad.axes?.[0] ?? 0;
  const stick = Math.abs(axis) > PAD_DEADZONE
    // rescale past the deadzone so the usable range is still a full 0..1
    ? Math.sign(axis) * ((Math.abs(axis) - PAD_DEADZONE) / (1 - PAD_DEADZONE))
    : 0;
  const dpad = (pressed(pad, PAD_BTN.right) ? 1 : 0) - (pressed(pad, PAD_BTN.left) ? 1 : 0);
  const move = dpad || Math.max(-1, Math.min(1, stick));
  const fire = anyPressed(pad, PAD_BTN.fire);
  const launchNow = anyPressed(pad, PAD_BTN.launch);
  const pauseNow = anyPressed(pad, PAD_BTN.pause);

  const prev = padPrev.get(pad.index) ?? { launch: false, pause: false };
  if (launchNow && !prev.launch) padLaunchEdge[side] = true;
  if (pauseNow && !prev.pause) pauseEdge = true;
  padPrev.set(pad.index, { launch: launchNow, pause: pauseNow });

  // any activity means this player is on the pad — drop a stale pointer target
  // for their paddle, or the paddle snaps back to the mouse when they let go
  if (move !== 0 || fire || launchNow) padActive[side] = true;
  return { move, fire };
};

const isFormTarget = (t) =>
  t instanceof Element
  && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA'
      || t.isContentEditable);

const dialogOpen = () => Boolean(document.querySelector('dialog[open]'));

// The playfield only owns the keyboard while it is on screen. Without this the
// game swallowed its own bound keys on the menus: `launch` is Space and
// `launch2` is Enter, so preventDefault() here cancelled the browser's native
// activation of a focused menu button — the ripple fired (a separate listener)
// but the button never triggered, and only a mouse click worked.
const gameVisible = () => Boolean(canvasEl && canvasEl.offsetParent !== null);

const onKeyDown = (e) => {
  if (captureHandler) return;                      // rebind capture owns the keyboard
  if (isFormTarget(e.target)) return;
  if (dialogOpen()) {
    // The pause key still toggles while the PAUSE dialog is itself open, so Esc
    // resumes consistently everywhere. preventDefault() suppresses the dialog's
    // native Esc-cancel, keeping a single resume path in every browser
    // (dlg-pause has closedby="none", honored only in newer Chrome). The
    // confirm-quit dialog stacks above pause and keeps its native Esc-close.
    if (!e.repeat && e.code === binds.pause
        && document.getElementById('dlg-pause')?.open
        && !document.getElementById('dlg-confirm-quit')?.open) {
      e.preventDefault();
      pauseEdge = true;
    }
    return;
  }
  // menus/level select: let the browser activate the focused control natively
  if (!gameVisible()) return;
  if (!boundCodes.has(e.code)) return;
  e.preventDefault();                              // stop Space/arrow scrolling etc.
  if (!e.repeat) {
    if (e.code === binds.pause) pauseEdge = true;
    // A tap of the launch key shorter than one frame would vanish from the
    // held set before state() is polled — latch it as an edge like touch taps.
    if (e.code === binds.launch) { launchEdge = true; launchEdgeSide.bottom = true; }
    if (e.code === binds.launch2) { launchEdge = true; launchEdgeSide.top = true; }
    // Keyboard beats pointer: a fresh movement press clears that paddle's
    // pointer target until its pointer moves again.
    if (e.code === binds.bottomLeft || e.code === binds.bottomRight) bottomTargetX = null;
    if (e.code === binds.topLeft || e.code === binds.topRight) topTargetX = null;
  }
  held.add(e.code);
};

// Releases are honored unconditionally: dropping a key from the held set can
// never cause spurious input, but ignoring a release (dialog open, focus in a
// form field) would leave the paddle drifting on a stuck key.
const onKeyUp = (e) => {
  held.delete(e.code);
};

const onBlur = () => input.reset();

const onPointerDown = (e) => {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  e.preventDefault();                              // block scroll/zoom/selection gestures
  try {
    e.currentTarget.setPointerCapture(e.pointerId);
  } catch {
    // pointer already inactive — capture is best-effort
  }
  if (e.pointerType === 'mouse') {
    if (mapper) bottomTargetX = mapper(e.clientX, e.clientY).x;
    return;
  }
  // Touch/pen: any tap is also a serve request.
  launchEdge = true;
  if (!mapper) return;
  const { x, y } = mapper(e.clientX, e.clientY);
  if (y > FIELD_H / 2) {
    if (ownerBottom === null) {                    // one pointer per paddle
      ownerBottom = e.pointerId;
      bottomTargetX = x;
    }
  } else if (ownerTop === null) {
    ownerTop = e.pointerId;
    topTargetX = x;
  }
};

const onPointerMove = (e) => {
  if (!mapper) return;
  if (e.pointerType === 'mouse') {                 // mouse always drives the bottom paddle
    bottomTargetX = mapper(e.clientX, e.clientY).x;
  } else if (e.pointerId === ownerBottom) {
    bottomTargetX = mapper(e.clientX, e.clientY).x;
  } else if (e.pointerId === ownerTop) {
    topTargetX = mapper(e.clientX, e.clientY).x;
  }
};

const onPointerEnd = (e) => {
  if (e.pointerId === ownerBottom) ownerBottom = null;
  if (e.pointerId === ownerTop) ownerTop = null;
  // targetX is kept so the paddle stays where the pointer left it.
};

const onContextMenu = (e) => e.preventDefault();   // long-press menu would break dragging

export const input = {
  attach(canvas) {
    canvasEl = canvas;
    detachFns.forEach((fn) => fn());               // re-attach replaces old listeners
    detachFns = [];
    const add = (target, type, fn, opts) => {
      target.addEventListener(type, fn, opts);
      detachFns.push(() => target.removeEventListener(type, fn, opts));
    };
    add(window, 'keydown', onKeyDown);
    add(window, 'keyup', onKeyUp);
    add(window, 'blur', onBlur);
    add(canvas, 'pointerdown', onPointerDown, { passive: false });
    add(canvas, 'pointermove', onPointerMove);
    add(canvas, 'pointerup', onPointerEnd);
    add(canvas, 'pointercancel', onPointerEnd);
    add(canvas, 'contextmenu', onContextMenu);
  },

  applySettings(settings) {
    binds = { ...binds, ...(settings?.binds ?? {}) };
    boundCodes = new Set(Object.values(binds));
    assist = Boolean(settings?.assist ?? assist);
  },

  setMapper(fn) {
    mapper = typeof fn === 'function' ? fn : null;
  },

  state() {
    // gamepads are polled, not evented, so they must be read once per frame here
    padActive = { bottom: false, top: false };
    const pads = livePads();
    const padBottom = pads[0] ? readPad(pads[0], 'bottom') : null;
    const padTop = pads[1] ? readPad(pads[1], 'top') : null;
    if (padActive.bottom) bottomTargetX = null;
    if (padActive.top) topTargetX = null;

    const pause = pauseEdge;
    pauseEdge = false;                             // edge-triggered: consumed on read
    const padLaunch = padLaunchEdge;
    padLaunchEdge = { bottom: false, top: false };
    const keyLaunch = launchEdgeSide;
    launchEdgeSide = { bottom: false, top: false };
    const launch = held.has(binds.launch) || held.has(binds.launch2)
      || launchEdge || padLaunch.bottom || padLaunch.top;
    launchEdge = false;

    const keyBottom = (held.has(binds.bottomRight) ? 1 : 0) - (held.has(binds.bottomLeft) ? 1 : 0);
    const keyTop = (held.has(binds.topRight) ? 1 : 0) - (held.has(binds.topLeft) ? 1 : 0);
    return {
      bottom: {
        // a pad in hand wins over the keyboard for that paddle
        move: padBottom?.move || keyBottom,
        targetX: bottomTargetX,
        fire: held.has(binds.bottomFire) || Boolean(padBottom?.fire),
        launch: padLaunch.bottom || keyLaunch.bottom || held.has(binds.launch),
        pad: Boolean(padBottom),
      },
      top: {
        move: padTop?.move || keyTop,
        targetX: topTargetX,
        fire: held.has(binds.topFire) || Boolean(padTop?.fire),
        launch: padLaunch.top || keyLaunch.top || held.has(binds.launch2),
        pad: Boolean(padTop),
      },
      launch,
      pause,
      pads: pads.length,
    };
  },

  captureNext(cb) {
    if (captureHandler) window.removeEventListener('keydown', captureHandler, true);
    captureHandler = (e) => {
      e.preventDefault();
      e.stopPropagation();
      window.removeEventListener('keydown', captureHandler, true);
      captureHandler = null;
      cb(e.code === 'Escape' ? null : e.code);
    };
    window.addEventListener('keydown', captureHandler, true);
  },

  // Documented extra (ui.js): disarm a pending captureNext without waiting for
  // a keystroke — otherwise closing the options dialog mid-rebind leaves the
  // one-shot listener armed and it silently eats the next keypress.
  cancelCapture() {
    if (!captureHandler) return;
    window.removeEventListener('keydown', captureHandler, true);
    captureHandler = null;
  },

  reset() {
    held.clear();
    pauseEdge = false;
    launchEdge = false;
    padPrev.clear();
    padLaunchEdge = { bottom: false, top: false };
    launchEdgeSide = { bottom: false, top: false };
    ownerBottom = null;
    ownerTop = null;
    bottomTargetX = null;
    topTargetX = null;
  },
};
