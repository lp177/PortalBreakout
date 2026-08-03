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

const held = new Set();            // KeyboardEvent.code values currently down
let pauseEdge = false;             // reported true exactly once per physical press
let launchEdge = false;            // transient tap-to-serve edge (touch/pen)
let bottomTargetX = null;          // pointer-driven absolute x, field units
let topTargetX = null;
let ownerBottom = null;            // pointerId owning each paddle (touch/pen only)
let ownerTop = null;

let captureHandler = null;         // active one-shot rebind listener, or null
let detachFns = [];                // listener removers from the last attach()

const isFormTarget = (t) =>
  t instanceof Element
  && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA'
      || t.isContentEditable);

const dialogOpen = () => Boolean(document.querySelector('dialog[open]'));

const onKeyDown = (e) => {
  if (captureHandler) return;                      // rebind capture owns the keyboard
  if (isFormTarget(e.target) || dialogOpen()) return;
  if (!boundCodes.has(e.code)) return;
  e.preventDefault();                              // stop Space/arrow scrolling etc.
  if (!e.repeat) {
    if (e.code === binds.pause) pauseEdge = true;
    // A tap of the launch key shorter than one frame would vanish from the
    // held set before state() is polled — latch it as an edge like touch taps.
    if (e.code === binds.launch) launchEdge = true;
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
    const pause = pauseEdge;
    pauseEdge = false;                             // edge-triggered: consumed on read
    const launch = held.has(binds.launch) || launchEdge;
    launchEdge = false;
    return {
      bottom: {
        move: (held.has(binds.bottomRight) ? 1 : 0) - (held.has(binds.bottomLeft) ? 1 : 0),
        targetX: bottomTargetX,
        fire: held.has(binds.bottomFire),
      },
      top: {
        move: (held.has(binds.topRight) ? 1 : 0) - (held.has(binds.topLeft) ? 1 : 0),
        targetX: topTargetX,
        fire: held.has(binds.topFire),
      },
      launch,
      pause,
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

  reset() {
    held.clear();
    pauseEdge = false;
    launchEdge = false;
    ownerBottom = null;
    ownerTop = null;
    bottomTargetX = null;
    topTargetX = null;
  },
};
