// PortalBreakout — ui module: menus, dialogs, ripple, level grid, rebind flow.
// See CONTRACT.md ("js/ui.js"). No DOM access happens until init() is called.

import { LEVELS, BRICK_TYPES } from './levels.js';
import { GRID_COLS, GRID_ROWS } from './constants.js';
import { loadSettings, saveSettings, loadProgress, isUnlocked, DEFAULT_SETTINGS } from './storage.js';
import { audio } from './audio.js';
import { input } from './input.js';

// Labelled by player, because these double as the local 2-player controls:
// P1 owns the bottom (orange) portal, P2 the top (blue) one.
const BIND_LABELS = {
  bottomLeft: 'P1 · orange portal ←',
  bottomRight: 'P1 · orange portal →',
  bottomFire: 'P1 · fire',
  launch: 'P1 · launch ball',
  topLeft: 'P2 · blue portal ←',
  topRight: 'P2 · blue portal →',
  topFire: 'P2 · fire',
  launch2: 'P2 · launch ball',
  pause: 'Pause',
};

const KEY_NAMES = {
  ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓',
  Space: 'Space', Enter: 'Enter', Escape: 'Esc', Tab: 'Tab', Backspace: '⌫',
  ShiftLeft: 'Shift', ShiftRight: 'R Shift', ControlLeft: 'Ctrl', ControlRight: 'R Ctrl',
  AltLeft: 'Alt', AltRight: 'R Alt', CapsLock: 'Caps', ContextMenu: 'Menu',
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
  Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
};

const prettyKey = (code) => {
  if (code in KEY_NAMES) return KEY_NAMES[code];
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1];
  m = /^Digit(\d)$/.exec(code);
  if (m) return m[1];
  m = /^Numpad(\w+)$/.exec(code);
  if (m) return `Num ${m[1]}`;
  return code;
};

const $ = (id) => document.getElementById(id);

const openDialog = (dlg) => { if (!dlg.open) dlg.showModal(); };
const closeDialog = (dlg) => { if (dlg.open) dlg.close(); };

let emit = () => {};
let initialized = false;

// pause dialog: closing without an explicit choice means "resume"
let pauseChoiceMade = false;
// connection-lost pause on the guest: "Resume" must NOT close the dialog
let pauseNetHold = false;

// #dlg-level-end is shared by showLevelEnd and showMatchEnd (versus): the mode
// decides what #btn-le-next emits, and each show* fully restores the shared
// labels/visibility it ping-pongs over
let levelEndMode = 'level'; // 'level' | 'match'

// multiplayer dialog state
let hosting = false;
let mpConnected = false;
let currentRoomCode = null;
let bannerTimer = 0;

// lobby dialog state (v1.2) — the lobby is the canonical share/setup surface
let lobbyRole = null;      // 'host' | 'guest' | null
let lobbyConnected = false;
let lobbyGuestName = null;
let lobbyPreviewIdx = null; // map currently drawn in the preview (v1.3)

// #vs-friend-hint default content (spans), saved at wire time so the guest
// override can be undone without innerHTML
let vsFriendHintDefault = [];

// rebind capture state: { action, btn } while a key is being listened for
let listening = null;

// ---------- toast (queued, one at a time) ----------
const toastQueue = [];
let toastBusy = false;

const runToastQueue = () => {
  if (toastBusy || toastQueue.length === 0) return;
  toastBusy = true;
  const el = $('toast');
  el.textContent = toastQueue.shift();
  // top layer via the Popover API where available, so toasts stay readable
  // above open modal dialogs and their dimmed/blurred ::backdrop
  if (typeof el.showPopover === 'function') {
    try { el.showPopover(); } catch { /* already open */ }
    void el.offsetWidth; // reflow so the opacity transition still runs
  }
  el.classList.add('show');
  setTimeout(() => {
    el.classList.remove('show');
    // let the fade-out finish before showing the next queued toast
    setTimeout(() => {
      if (typeof el.hidePopover === 'function') {
        try { el.hidePopover(); } catch { /* not open */ }
      }
      toastBusy = false;
      runToastQueue();
    }, 260);
  }, 2200);
};

// ---------- ripple ----------
const spawnRipple = (btn, x, y) => {
  if (btn.disabled) return;
  const rect = btn.getBoundingClientRect();
  const size = Math.ceil(Math.hypot(rect.width, rect.height) * 2);
  const cx = x ?? rect.width / 2;
  const cy = y ?? rect.height / 2;
  const span = document.createElement('span');
  span.className = 'ripple';
  span.style.width = `${size}px`;
  span.style.height = `${size}px`;
  span.style.left = `${cx - size / 2}px`;
  span.style.top = `${cy - size / 2}px`;
  btn.append(span);
  const remove = () => span.remove();
  span.addEventListener('animationend', remove, { once: true });
  setTimeout(remove, 700); // safety net if animations never run
};

const wireRippleAndClickSfx = () => {
  document.addEventListener('pointerdown', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('.btn, .level-tile') : null;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    spawnRipple(btn, e.clientX - rect.left, e.clientY - rect.top);
  });

  document.addEventListener('keydown', (e) => {
    if (e.repeat || (e.key !== 'Enter' && e.key !== ' ')) return;
    const btn = e.target instanceof Element ? e.target.closest('.btn, .level-tile') : null;
    if (btn) spawnRipple(btn); // centered
  });

  document.addEventListener('click', (e) => {
    const btn = e.target instanceof Element
      ? e.target.closest('.btn, .level-tile, .bind-key') : null;
    if (!btn) return;
    audio.init(); // user gesture — safe spot to (lazily) create the AudioContext
    audio.sfx('click');
  });
};

// ---------- keyboard navigation (v1.4) ----------
// Arrow keys move focus through whatever is on screen — the open dialog if
// there is one, otherwise the active screen — so a keyboard player never has to
// reach for the mouse. Enter/Space activate natively once something is focused.
// Direction is geometric rather than DOM order, so the level grid navigates as
// a grid and button columns navigate as columns.
const NAV_SELECTOR = 'button:not([disabled]), a[href], select, input:not([type="hidden"]), [tabindex]:not([tabindex="-1"])';

// controls that own the arrow keys themselves — never steal from these
const ownsArrows = (el, key) => {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'SELECT') return true;
  if (tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') {
    const t = el.type;
    if (t === 'range') return key === 'ArrowLeft' || key === 'ArrowRight';
    if (t === 'text' || t === 'search' || t === 'number' || t === 'email' || t === 'password') {
      return key === 'ArrowLeft' || key === 'ArrowRight';
    }
  }
  return false;
};

const navRoot = () => {
  const dlg = [...document.querySelectorAll('dialog')].find((d) => d.open);
  if (dlg) return dlg;
  return document.querySelector('.screen.active');
};

const navItems = (root) => [...root.querySelectorAll(NAV_SELECTOR)].filter((el) => {
  if (el.disabled || el.hidden) return false;
  if (el.closest('[hidden]')) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
});

// nearest item in the requested direction: primary-axis distance dominates, with
// a penalty for drifting sideways, which is what makes grids feel natural
const pickInDirection = (items, from, key) => {
  const a = from.getBoundingClientRect();
  const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
  const horizontal = key === 'ArrowLeft' || key === 'ArrowRight';
  const sign = (key === 'ArrowRight' || key === 'ArrowDown') ? 1 : -1;
  let best = null, bestScore = Infinity;
  for (const el of items) {
    if (el === from) continue;
    const r = el.getBoundingClientRect();
    const bx = r.left + r.width / 2, by = r.top + r.height / 2;
    const main = (horizontal ? bx - ax : by - ay) * sign;
    if (main <= 1) continue;                       // not in this direction
    const cross = Math.abs(horizontal ? by - ay : bx - ax);
    const score = main + cross * 2.5;
    if (score < bestScore) { bestScore = score; best = el; }
  }
  return best;
};

// ---------- gamepad menu navigation (v1.6.1) ----------
// A pad has to drive the menus too, or a couch session cannot even start a game
// without reaching for the keyboard. Reuses the same geometric focus movement as
// the arrow keys. The engine owns the pads while the field is on screen with no
// dialog over it; everywhere else, this does.
const GP_NAV = { first: 380, next: 140, thresh: 0.5 };

const wireGamepadNav = () => {
  if (typeof navigator === 'undefined' || !navigator.getGamepads) return;
  let heldDir = null, nextAt = 0, prevA = false, prevB = false;

  const activate = (el) => {
    if (!el) return;
    spawnRipple(el);              // same feedback a keyboard press gives
    el.click();
  };

  const tick = (now) => {
    requestAnimationFrame(tick);
    const canvas = $('game-canvas');
    const inGame = canvas && canvas.offsetParent !== null;
    const dlg = [...document.querySelectorAll('dialog')].find((d) => d.open);
    if ((inGame && !dlg) || listening) { heldDir = null; prevA = prevB = false; return; }

    const pads = [...(navigator.getGamepads?.() ?? [])].filter(Boolean);
    if (!pads.length) return;
    // either player may drive the menus, so merge every pad
    let dx = 0, dy = 0, aDown = false, bDown = false;
    for (const p of pads) {
      const ax = p.axes?.[0] ?? 0, ay = p.axes?.[1] ?? 0;
      if (Math.abs(ax) > GP_NAV.thresh) dx += Math.sign(ax);
      if (Math.abs(ay) > GP_NAV.thresh) dy += Math.sign(ay);
      if (p.buttons?.[14]?.pressed) dx -= 1;
      if (p.buttons?.[15]?.pressed) dx += 1;
      if (p.buttons?.[12]?.pressed) dy -= 1;
      if (p.buttons?.[13]?.pressed) dy += 1;
      if (p.buttons?.[0]?.pressed) aDown = true;
      if (p.buttons?.[1]?.pressed) bDown = true;
    }

    const root = navRoot();
    if (!root) return;
    const items = navItems(root);

    // direction, with a hold-to-repeat so one flick moves one item
    const key = Math.abs(dy) >= Math.abs(dx)
      ? (dy > 0 ? 'ArrowDown' : dy < 0 ? 'ArrowUp' : null)
      : (dx > 0 ? 'ArrowRight' : 'ArrowLeft');
    if (!key) {
      heldDir = null;
    } else if (items.length) {
      if (key !== heldDir) { heldDir = key; nextAt = now + GP_NAV.first; moveFocus(root, items, key); }
      else if (now >= nextAt) { nextAt = now + GP_NAV.next; moveFocus(root, items, key); }
    }

    if (aDown && !prevA) {
      const el = document.activeElement;
      activate(root.contains(el) && el !== root ? el : items[0]);
    }
    // B backs out of anything the player is allowed to dismiss
    if (bDown && !prevB && dlg && dlg.getAttribute('closedby') !== 'none') closeDialog(dlg);
    prevA = aDown; prevB = bDown;
  };
  requestAnimationFrame(tick);
};

// shared by keyboard and gamepad navigation
const moveFocus = (root, items, key) => {
  const active = document.activeElement;
  if (!active || !root.contains(active) || active === document.body) {
    items[0]?.focus();
    return;
  }
  const next = pickInDirection(items, active, key);
  if (next) {
    next.focus();
    next.scrollIntoView?.({ block: 'nearest' });
  }
};

const wireKeyboardNav = () => {
  document.addEventListener('keydown', (e) => {
    const key = e.key;
    if (key !== 'ArrowUp' && key !== 'ArrowDown' && key !== 'ArrowLeft' && key !== 'ArrowRight') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (listening) return;                          // a rebind capture owns the keyboard
    const root = navRoot();
    if (!root) return;
    // no dialog open and we're in the game: arrows drive the paddles
    if (root.id === 'screen-game') return;

    const active = document.activeElement;
    if (ownsArrows(active, key)) return;

    const items = navItems(root);
    if (!items.length) return;

    // nothing focused inside this context yet → the first arrow just enters it
    if (!active || !root.contains(active) || active === document.body) {
      e.preventDefault();
      items[0].focus();
      return;
    }
    const next = pickInDirection(items, active, key);
    if (next) {
      e.preventDefault();
      next.focus();
      if (typeof next.scrollIntoView === 'function') next.scrollIntoView({ block: 'nearest' });
    }
  });

  // opening a dialog should land focus on its primary action, so Enter works
  // immediately rather than after a hunt
  const focusPrimary = (dlg) => {
    if (!dlg?.open) return;
    const inside = document.activeElement && dlg.contains(document.activeElement)
      && document.activeElement !== dlg;
    if (inside) return;
    const target = dlg.querySelector('.btn-primary:not([disabled]):not([hidden])')
      ?? navItems(dlg)[0];
    target?.focus();
  };
  for (const dlg of document.querySelectorAll('dialog')) {
    // 'toggle' fires on modern dialogs; the click fallback covers the rest
    dlg.addEventListener('toggle', () => requestAnimationFrame(() => focusPrimary(dlg)));
  }
  document.addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('button[commandfor]') : null;
    if (!btn) return;
    const dlg = document.getElementById(btn.getAttribute('commandfor'));
    if (dlg) requestAnimationFrame(() => focusPrimary(dlg));
  });
};

// ---------- invoker-commands fallback ----------
const wireInvokerFallback = () => {
  if ('commandForElement' in HTMLButtonElement.prototype) return;
  document.addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('button[commandfor]') : null;
    if (!btn) return;
    const target = document.getElementById(btn.getAttribute('commandfor'));
    if (!target) return;
    const cmd = btn.getAttribute('command');
    if (cmd === 'show-modal') openDialog(target);
    else if (cmd === 'close') closeDialog(target);
  });
};

// ---------- options: settings form ----------
const pushSettings = (patch) => {
  const merged = saveSettings(patch);
  emit('options-changed', { settings: merged });
  return merged;
};

const setRangeValue = (el, v01) => {
  const pct = Math.round(v01 * 100);
  el.value = String(pct);
  el.style.setProperty('--fill', `${pct}%`); // webkit track fill (CSS gradient)
};

const syncOptionsForm = () => {
  const s = loadSettings();
  setRangeValue($('opt-master'), s.audio.master);
  setRangeValue($('opt-music'), s.audio.music);
  setRangeValue($('opt-sfx'), s.audio.sfx);
  $('opt-muted').checked = s.audio.muted;
  $('opt-effects').value = s.effects;
  $('opt-assist').checked = s.assist;
  buildBindsList(s.binds);
};

const wireOptionsForm = () => {
  const wireSlider = (id, key) => {
    $(id).addEventListener('input', (e) => {
      e.target.style.setProperty('--fill', `${e.target.value}%`);
      pushSettings({ audio: { [key]: Number(e.target.value) / 100 } });
    });
  };
  wireSlider('opt-master', 'master');
  wireSlider('opt-music', 'music');
  wireSlider('opt-sfx', 'sfx');

  $('opt-muted').addEventListener('change', (e) => {
    pushSettings({ audio: { muted: e.target.checked } });
  });
  $('opt-effects').addEventListener('change', (e) => {
    pushSettings({ effects: e.target.value });
  });
  $('opt-assist').addEventListener('change', (e) => {
    pushSettings({ assist: e.target.checked });
  });

  // re-sync the form from storage each time the dialog is opened
  $('btn-options').addEventListener('click', syncOptionsForm);

  // reset all key binds to the shipped defaults
  $('btn-binds-reset').addEventListener('click', () => {
    input.cancelCapture();
    listening = null;
    const merged = pushSettings({ binds: { ...DEFAULT_SETTINGS.binds } });
    buildBindsList(merged.binds);
    api.toast('Controls reset to defaults');
  });

  // if the dialog closes mid-rebind, disarm the capture (or it silently
  // swallows the next keystroke anywhere in the app) and drop the result
  $('dlg-options').addEventListener('close', () => {
    if (listening) {
      input.cancelCapture();
      listening = null;
      buildBindsList();
    }
  });
};

// ---------- options: key rebinding ----------
const buildBindsList = (binds = loadSettings().binds) => {
  const list = $('binds-list');
  list.textContent = '';
  listening = null;
  const frag = document.createDocumentFragment();
  for (const [action, label] of Object.entries(BIND_LABELS)) {
    const lab = document.createElement('span');
    lab.className = 'bind-label';
    lab.textContent = label;
    lab.id = `bind-label-${action}`;

    const key = document.createElement('button');
    key.type = 'button';
    key.className = 'bind-key';
    key.id = `bind-key-${action}`;
    key.textContent = prettyKey(binds[action]);
    key.setAttribute('aria-label', `${label}: ${prettyKey(binds[action])}. Press to rebind.`);
    key.addEventListener('click', () => startRebind(action, key));

    frag.append(lab, key);
  }
  list.append(frag);
};

const startRebind = (action, btn) => {
  if (listening) {
    // restore the previously listening row
    listening.btn.classList.remove('listening');
    listening.btn.textContent = prettyKey(loadSettings().binds[listening.action]);
  }
  listening = { action, btn };
  btn.classList.add('listening');
  btn.textContent = 'Press a key…';
  input.captureNext((code) => finishRebind(action, code));
};

const finishRebind = (action, code) => {
  // stale capture (dialog closed / another row started listening) → ignore
  if (!listening || listening.action !== action) return;
  listening = null;
  if (code === null) {          // Escape → cancelled
    buildBindsList();
    $(`bind-key-${action}`)?.focus(); // rebuild destroyed the focused button
    return;
  }
  const binds = { ...loadSettings().binds };
  const conflict = Object.keys(binds)
    .find((a) => a !== action && binds[a] === code);
  if (conflict) binds[conflict] = binds[action]; // swap to keep every action bound
  binds[action] = code;
  const merged = pushSettings({ binds });
  buildBindsList(merged.binds);
  $(`bind-key-${action}`)?.focus();  // keep keyboard users on the row they rebound
  if (conflict) api.toast(`Swapped with ${BIND_LABELS[conflict]}`);
};

// ---------- level grid ----------
const tileSpan = (className, text) => {
  const el = document.createElement('span');
  el.className = className;
  el.textContent = text;
  return el;
};

const buildLevelGrid = () => {
  const grid = $('level-grid');
  const progress = loadProgress();
  grid.textContent = '';
  const frag = document.createDocumentFragment();

  LEVELS.forEach((level, idx) => {
    const unlocked = isUnlocked(idx, progress);
    const rec = progress.levels[idx];
    const done = Boolean(rec?.completed);

    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = `level-tile${done ? ' done' : ''}${unlocked ? '' : ' locked'}`;
    tile.disabled = !unlocked;
    tile.append(tileSpan('tile-num', String(idx + 1)), tileSpan('tile-name', level.name));

    if (!unlocked) {
      tile.append(tileSpan('tile-glyph tile-lock', '🔒'));
      tile.setAttribute('aria-label', `Level ${idx + 1} — locked`);
    } else if (done) {
      tile.append(tileSpan('tile-glyph tile-check', '✓'),
        tileSpan('tile-best', `★ ${rec.bestScore.toLocaleString()}`));
      tile.setAttribute('aria-label',
        `Level ${idx + 1}, ${level.name} — completed, best score ${rec.bestScore}`);
      tile.addEventListener('click', () => emit('replay', { levelIdx: idx }));
    } else {
      tile.append(tileSpan('tile-glyph tile-play', '▶'));
      tile.setAttribute('aria-label', `Level ${idx + 1}, ${level.name} — play`);
      tile.addEventListener('click', () => emit('play', { levelIdx: idx }));
    }
    frag.append(tile);
  });
  grid.append(frag);
};

// ---------- multiplayer dialog ----------
const resetMpDialog = () => {
  hosting = false;
  mpConnected = false;
  currentRoomCode = null;
  $('mp-room-box').hidden = true;
  $('mp-room-code').textContent = '';
  $('btn-mp-host').disabled = false;
  $('mp-status').textContent = '';
  resetLobby();          // the lobby shares the session lifecycle
  updateVersusFriendBtn();
};

const wireMultiplayer = () => {
  $('btn-mp-host').addEventListener('click', () => {
    hosting = true;
    mpConnected = false;
    $('btn-mp-host').disabled = true;
    $('mp-status').textContent = 'Creating room…';
    emit('host');
  });

  $('btn-mp-join').addEventListener('click', () => {
    const code = $('mp-join-code').value.trim();
    if (!code) {
      api.toast('Enter a room code');
      return;
    }
    $('mp-status').textContent = 'Joining…';
    emit('join', { code });
  });

  $('mp-join-code').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      $('btn-mp-join').click();
    }
  });

  $('btn-mp-copy').addEventListener('click', async () => {
    if (!currentRoomCode) return;
    const link = `${location.origin}${location.pathname}?join=${currentRoomCode}`;
    try {
      await navigator.clipboard.writeText(link);
      api.toast('Link copied');
    } catch {
      api.toast('Copy failed — select the code and copy it');
    }
  });

  $('dlg-multiplayer').addEventListener('close', () => {
    if (hosting && !mpConnected) {
      emit('cancel-mp');
      resetMpDialog();
    }
  });

  // arrived via invite link → prefill code and open the dialog
  const joinCode = new URLSearchParams(location.search).get('join');
  if (joinCode) {
    $('mp-join-code').value = joinCode;
    openDialog($('dlg-multiplayer'));
  }
};

// ---------- versus dialog ----------
// Local role derived from the same state netStatus/showRoomCode already keep:
// a room code only ever exists on the host; a connection without one = guest.
// A CONNECTED session is required either way — a host still waiting for a
// friend must keep the connect-first label (contract: "when MP-connected").
const mpRole = () => (mpConnected ? (currentRoomCode ? 'host' : 'guest') : null);

const updateVersusFriendBtn = () => {
  const btn = $('btn-vs-friend');
  const hint = $('vs-friend-hint');
  const role = mpRole();

  btn.disabled = role === 'guest';
  btn.classList.toggle('btn-primary', role === 'host');
  btn.classList.toggle('btn-tonal', role !== 'host');
  btn.textContent = role ? 'Start online match' : 'Connect with a friend first';
  if (role === 'guest') hint.textContent = 'The host starts the match';
  else hint.replaceChildren(...vsFriendHintDefault);
};

const wireVersus = () => {
  vsFriendHintDefault = [...$('vs-friend-hint').childNodes];

  buildMapSelect($('vs-map'), { random: true });
  $('vs-map').addEventListener('change', showVersusPreview);
  // the dialog opens through a native invoker (commandfor), so paint on the
  // opening click — after layout, or the canvas has no width to size from
  $('btn-versus')?.addEventListener('click', () => requestAnimationFrame(showVersusPreview));
  showVersusPreview();

  $('btn-vs-ai').addEventListener('click', () => {
    const map = $('vs-map').value;
    emit('versus-ai', {
      difficulty: $('vs-difficulty').value,
      // 'random' → undefined: the engine picks a fresh arena, as it always did
      levelIdx: map === 'random' ? undefined : Number(map),
    });
    closeDialog($('dlg-versus'));
  });

  // main.js decides: start the match (host) or redirect to the multiplayer
  // dialog — close this one first so modals never stack
  $('btn-vs-local').addEventListener('click', () => {
    const map = $('vs-map').value;
    emit('versus-local', { levelIdx: map === 'random' ? undefined : Number(map) });
    closeDialog($('dlg-versus'));
  });

  $('btn-vs-friend').addEventListener('click', () => {
    closeDialog($('dlg-versus'));
    emit('versus-mp');
  });

  updateVersusFriendBtn();
};

// ---------- map preview (v1.3) ----------
// Miniature of a level's brick layout, so picking a map isn't guesswork from
// the name alone. Draws the grid in the real brick colors over the playfield's
// dark background, with the two portal paddles hinted top and bottom. The
// aspect is the grid's (13×14 cells) plus a margin row for each paddle.
// A level may use a coarser (giant) or finer (mini) grid than the default, so
// read its real dimensions from the data rather than assuming 13x14. The brick
// band is the same height at every scale, so the thumbnail keeps its aspect.
const thumbDims = (level) => {
  const rows = level.rows?.length || GRID_ROWS;
  const cols = level.rows?.[0]?.length || GRID_COLS;
  return { rows, cols, aspect: (GRID_ROWS + 4) / GRID_ROWS };
};

const renderLevelThumb = (canvas, levelIdx) => {
  const level = LEVELS[levelIdx];
  if (!canvas || !level) return;
  const { rows: lRows, cols: lCols, aspect } = thumbDims(level);
  const cssW = canvas.clientWidth || 240;
  const cell = cssW / lCols;
  // keep every preview the same shape whatever the grid: the band is constant
  const cssH = Math.round((cssW / GRID_COLS) * (GRID_ROWS + 4));
  const rowH = (cell * lCols * (GRID_ROWS / GRID_COLS)) / lRows;
  void aspect;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.height = `${cssH}px`;
  const c = canvas.getContext('2d');
  if (!c) return;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, cssW, cssH);

  c.fillStyle = '#0b1017';
  c.fillRect(0, 0, cssW, cssH);

  // faint grid, matching the in-game field
  c.strokeStyle = 'rgba(120,170,220,0.07)';
  c.lineWidth = 1;
  const lines = Math.min(lCols, 26);
  for (let i = 1; i < lines; i++) {
    const gx = Math.round((i * cssW) / lines) + 0.5;
    c.beginPath(); c.moveTo(gx, 0); c.lineTo(gx, cssH); c.stroke();
  }

  const pad = Math.max(0.35, cell * 0.07);
  const r = Math.max(0.8, cell * 0.16);
  const topPad = (cssH - rowH * lRows) / 2;   // centre the band, paddles either side
  level.rows.forEach((row, ri) => {
    for (let ci = 0; ci < lCols; ci++) {
      const ch = row[ci];
      const info = ch && ch !== '.' ? BRICK_TYPES[ch] : null;
      if (!info) continue;
      const x = ci * cell + pad;
      const y = topPad + ri * rowH + pad;
      const w = cell - pad * 2;
      const h = rowH - pad * 2;
      c.beginPath();
      if (c.roundRect) c.roundRect(x, y, w, h, r); else c.rect(x, y, w, h);
      c.fillStyle = info.color;
      c.fill();
      // same top highlight the engine draws, so the mini reads as the real thing
      c.beginPath();
      const ih = h * 0.38;
      if (c.roundRect) c.roundRect(x + pad, y + pad, w - pad * 2, ih, r * 0.6);
      else c.rect(x + pad, y + pad, w - pad * 2, ih);
      c.fillStyle = 'rgba(255,255,255,0.18)';
      c.fill();
    }
  });

  // portal paddles: orange (bottom / host) and blue (top / joiner)
  const pw = cssW * 0.17, ph = Math.max(2.5, cssH * 0.011);
  const drawPad = (cy, color) => {
    c.beginPath();
    if (c.roundRect) c.roundRect((cssW - pw) / 2, cy - ph / 2, pw, ph, ph / 2);
    else c.rect((cssW - pw) / 2, cy - ph / 2, pw, ph);
    c.fillStyle = color;
    c.fill();
  };
  const padY = Math.max(4, (cssH - rowH * lRows) / 4);
  drawPad(padY, '#42a5f5');
  drawPad(cssH - padY, '#ff9800');

  c.strokeStyle = 'rgba(120,170,220,0.22)';
  c.strokeRect(0.5, 0.5, cssW - 1, cssH - 1);
};

const mapLabel = (idx) => `${String(idx + 1).padStart(2, '0')} · ${LEVELS[idx].name}`;

// Fill a map <select> from LEVELS. `random` prepends a "Random arena" option
// (value 'random') — the vs-Computer default, which is what that mode did
// implicitly before it had a picker.
const buildMapSelect = (sel, { random = false } = {}) => {
  const want = LEVELS.length + (random ? 1 : 0);
  if (!sel || sel.childElementCount === want) return;   // already populated
  sel.textContent = '';
  const frag = document.createDocumentFragment();
  if (random) {
    const opt = document.createElement('option');
    opt.value = 'random';
    opt.textContent = 'Random arena';
    frag.append(opt);
  }
  LEVELS.forEach((_, idx) => {
    const opt = document.createElement('option');
    opt.value = String(idx);
    opt.textContent = mapLabel(idx);
    frag.append(opt);
  });
  sel.append(frag);
};

// Paint a preview + caption for `value`; a non-level value (e.g. 'random')
// hides the canvas and says so. Returns the resolved index, or null.
// Unhides before drawing: a hidden canvas has no width to measure.
const paintPreview = (canvasId, nameId, value) => {
  const canvas = $(canvasId);
  const nameEl = $(nameId);
  const idx = Number(value);
  const known = Number.isInteger(idx) && idx >= 0 && idx < LEVELS.length;
  if (canvas) canvas.hidden = !known;
  if (known && canvas) renderLevelThumb(canvas, idx);
  if (nameEl) nameEl.textContent = known ? mapLabel(idx) : 'A random arena each match';
  return known ? idx : null;
};

// keep the lobby preview (and its caption) in sync with a chosen map
const showLobbyPreview = (levelIdx) => {
  const idx = paintPreview('lobby-preview-canvas', 'lobby-preview-name', levelIdx);
  if (idx !== null) lobbyPreviewIdx = idx;
};

const showVersusPreview = () =>
  paintPreview('vs-preview-canvas', 'vs-preview-name', $('vs-map')?.value);

// ---------- lobby dialog (v1.2) ----------
const buildLobbyMap = () => buildMapSelect($('lobby-map'));

const setPlayerChip = (el, main, sub, waiting) => {
  el.textContent = '';
  el.append(document.createTextNode(main));
  if (sub) {
    const s = document.createElement('small');
    s.textContent = sub;
    el.append(' ', s);
  }
  el.classList.toggle('waiting', Boolean(waiting));
};

const renderLobbyPlayers = () => {
  const hostChip = $('lobby-players').querySelector('.is-host');
  const guestChip = $('lobby-guest-slot');
  if (lobbyRole === 'guest') {
    // the local player is the joiner — blue / top portal
    setPlayerChip(hostChip, 'Host', 'orange portal', false);
    setPlayerChip(guestChip, 'You', 'blue portal', false);
  } else {
    setPlayerChip(hostChip, 'You', 'orange portal', false);
    if (lobbyConnected) setPlayerChip(guestChip, lobbyGuestName || 'Friend connected', 'blue portal', false);
    else setPlayerChip(guestChip, 'Waiting for a friend…', null, true);
  }
};

const refreshLobby = () => {
  const isHost = lobbyRole === 'host';
  $('lobby-host').hidden = !isHost;
  $('lobby-guest').hidden = isHost;
  $('lobby-invite').hidden = !isHost;   // host owns the invite/share surface

  const start = $('btn-lobby-start');
  start.hidden = !isHost;                // guest never starts a match
  start.disabled = !isHost || !lobbyConnected;

  $('btn-lobby-kick').hidden = !isHost || !lobbyConnected;

  renderLobbyPlayers();

  const status = $('lobby-status');
  if (isHost) {
    status.textContent = lobbyConnected
      ? 'Your friend is in — start when you’re ready.'
      : 'Waiting for a friend to join…';
  } else {
    status.textContent = '';
  }
};

const resetLobby = () => {
  lobbyRole = null;
  lobbyConnected = false;
  lobbyGuestName = null;
  const start = $('btn-lobby-start');
  start.hidden = true;
  start.disabled = true;
  $('btn-lobby-kick').hidden = true;
};

const wireLobby = () => {
  $('btn-lobby-start').addEventListener('click', () => {
    emit('lobby-start', {
      mode: $('lobby-mode').value,
      levelIdx: Number($('lobby-map').value),
    });
  });
  $('btn-lobby-kick').addEventListener('click', () => emit('lobby-kick'));
  $('btn-lobby-leave').addEventListener('click', () => emit('lobby-leave'));

  // host browsing the setup: redraw the preview and mirror the choice to the
  // guest, so both players see the same map before the match starts
  const broadcastConfig = () => {
    if (lobbyRole !== 'host') return;
    showLobbyPreview(Number($('lobby-map').value));
    emit('lobby-config', {
      mode: $('lobby-mode').value,
      levelIdx: Number($('lobby-map').value),
    });
  };
  $('lobby-map').addEventListener('change', broadcastConfig);
  $('lobby-mode').addEventListener('change', broadcastConfig);

  // same clipboard logic + fallback as btn-mp-copy (this is the canonical surface)
  $('btn-lobby-copy').addEventListener('click', async () => {
    if (!currentRoomCode) return;
    const link = `${location.origin}${location.pathname}?join=${currentRoomCode}`;
    try {
      await navigator.clipboard.writeText(link);
      api.toast('Link copied');
    } catch {
      api.toast('Copy failed — select the code and copy it');
    }
  });
};

// ---------- pause / level-end / quit ----------
const wireGameDialogs = () => {
  const dlgPause = $('dlg-pause');
  const dlgLevelEnd = $('dlg-level-end');
  const dlgConfirm = $('dlg-confirm-quit');

  $('btn-resume').addEventListener('click', () => {
    if (pauseNetHold) {
      // guest with a lost connection: stay on the dialog instead of stranding
      // the player on a frozen, dialog-less game
      api.toast('Waiting for the host to come back…');
      return;
    }
    pauseChoiceMade = true;
    closeDialog(dlgPause);
    emit('resume');
  });
  $('btn-retry').addEventListener('click', () => {
    pauseChoiceMade = true;
    closeDialog(dlgPause);
    emit('retry');
  });
  $('btn-quit').addEventListener('click', () => openDialog(dlgConfirm));
  $('btn-cq-yes').addEventListener('click', () => {
    pauseChoiceMade = true;
    closeDialog(dlgConfirm);
    closeDialog(dlgPause);
    emit('quit-to-menu');
  });

  // closed without an explicit choice (e.g. Esc where closedby is unsupported) → resume
  dlgPause.addEventListener('close', () => {
    if (!pauseChoiceMade) emit('resume');
    pauseChoiceMade = false;
  });

  $('btn-le-next').addEventListener('click', () => {
    closeDialog(dlgLevelEnd);
    emit(levelEndMode === 'match' ? 'rematch' : 'next-level');
  });
  $('btn-le-replay').addEventListener('click', () => {
    closeDialog(dlgLevelEnd);
    emit('retry');
  });
  $('btn-le-lobby').addEventListener('click', () => {
    closeDialog(dlgLevelEnd);
    if (levelEndCanLobby) emit('back-to-lobby');
    else emit('versus-setup', { focus: 'map' });
  });
  $('btn-le-setup').addEventListener('click', () => {
    closeDialog(dlgLevelEnd);
    emit('versus-setup', { focus: 'difficulty' });
  });
  $('btn-le-menu').addEventListener('click', () => {
    closeDialog(dlgLevelEnd);
    emit('quit-to-menu');
  });

  // enforce closedby="none" where the attribute is unsupported: the level-end
  // dialog must only close through its buttons
  dlgLevelEnd.addEventListener('cancel', (e) => e.preventDefault());
};

// ---------- menu screen ----------
const wireMenu = () => {
  $('btn-play').addEventListener('click', () => {
    const progress = loadProgress();
    let levelIdx = LEVELS.findIndex((_, i) => !progress.levels[i]?.completed);
    if (levelIdx === -1) levelIdx = LEVELS.length - 1; // everything done → last level
    emit('play', { levelIdx });
  });
  $('btn-levels').addEventListener('click', () => api.showScreen('levels'));
  $('btn-levels-back').addEventListener('click', () => api.showScreen('menu'));
  $('btn-pause-touch').addEventListener('click', () => emit('pause'));
};

// ---------- level-end stats ----------
const statRow = (parent, label, value, badge = null) => {
  const l = document.createElement('span');
  l.className = 'le-label';
  l.textContent = label;
  const v = document.createElement('span');
  v.className = 'le-value';
  v.textContent = value;
  if (badge) {
    const b = document.createElement('span');
    b.className = 'new-best';
    b.textContent = badge;
    v.append(' ', b);
  }
  parent.append(l, v);
};

// Level-end exit buttons. With a live room, "Change map" returns both players
// to the lobby (room intact) and Menu is relabelled so ending the session reads
// as the deliberate act it is.
// "Change map" means the same thing to a player in both contexts, so it is one
// button: with a live room it re-opens the lobby, and in a solo vs-Computer
// match the versus setup (focused on the arena). Changing the map must not be
// buried behind "Change difficulty" — most players only want the map.
let levelEndCanLobby = false;

const setLevelEndExit = (canLobby, canSetup = false) => {
  levelEndCanLobby = canLobby;
  $('btn-le-lobby').hidden = !(canLobby || canSetup);
  $('btn-le-setup').hidden = !canSetup;
  $('btn-le-menu').textContent = canLobby ? 'Leave game' : 'Menu';
};

// ---------- public API ----------
export const ui = {
  init({ onAction }) {
    // onAction(name, data) names: 'play' {levelIdx}, 'replay' {levelIdx},
    // 'host', 'join' {code}, 'options-changed' {settings}, 'pause', 'resume',
    // 'retry', 'next-level', 'quit-to-menu', 'cancel-mp',
    // 'versus-ai' {difficulty}, 'versus-local' {levelIdx}, 'versus-mp',
    // 'rematch', 'back-to-lobby',
    // 'lobby-start' {mode, levelIdx}, 'lobby-kick', 'lobby-leave',
    // 'lobby-config' {mode, levelIdx}
    emit = (name, data) => onAction(name, data);
    if (initialized) return;
    initialized = true;

    wireRippleAndClickSfx();
    wireInvokerFallback();
    wireKeyboardNav();
    wireGamepadNav();
    wireMenu();
    wireOptionsForm();
    wireMultiplayer();
    wireVersus();
    wireLobby();
    wireGameDialogs();
    syncOptionsForm();
  },

  showScreen(name) {
    for (const scr of document.querySelectorAll('.screen')) {
      scr.classList.toggle('active', scr.id === `screen-${name}`);
    }
    // Entering the game: drop focus off whatever button was clicked, or the
    // launch/serve key would activate that button instead of reaching the game.
    if (name === 'game') document.activeElement?.blur?.();
    if (name === 'levels') this.refreshLevelGrid();
  },

  refreshLevelGrid() {
    buildLevelGrid();
  },

  // canLobby: a live MP room — offer "Change map" (keeps the room) and make
  // Menu read as the deliberate way to end the session
  showLevelEnd({ cleared, score, best, levelIdx, isLast, canLobby = false }) {
    setLevelEndExit(canLobby);
    levelEndMode = 'level';
    const finale = cleared && isLast;
    $('le-title').textContent = !cleared
      ? 'Game over'
      : finale ? `You beat all ${LEVELS.length} levels!` : 'Level clear!';

    const stats = $('le-stats');
    stats.textContent = '';
    const levelName = LEVELS[levelIdx]?.name ?? `Level ${levelIdx + 1}`;
    const isNewBest = score > 0 && score > best; // strictly better — a tie is not a new best
    statRow(stats, 'Level', `${levelIdx + 1} — ${levelName}`);
    statRow(stats, 'Score', score.toLocaleString());
    statRow(stats, 'Best', Math.max(best, score).toLocaleString(),
      isNewBest ? 'NEW BEST!' : null);

    // the finale keeps the primary button as a celebratory "Finish" → menu.
    // showMatchEnd shares this dialog: restore everything it may have changed
    const next = $('btn-le-next');
    next.hidden = !cleared;
    next.textContent = finale ? 'Finish' : 'Next level';
    $('btn-le-replay').hidden = false;
    openDialog($('dlg-level-end'));
  },

  showMatchEnd({ youWon, scoreYou, scoreThem, timeMs, canRematch, canLobby = false, canSetup = false }) {
    levelEndMode = 'match';
    setLevelEndExit(canLobby, canSetup);
    $('le-title').textContent = youWon ? 'You win! 🏆' : 'You lose';

    const stats = $('le-stats');
    stats.textContent = '';
    const secs = Math.max(0, Math.round(timeMs / 1000));
    statRow(stats, 'You', scoreYou.toLocaleString());
    statRow(stats, 'Opponent', scoreThem.toLocaleString());
    statRow(stats, 'Match time',
      `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`);

    // MP guest can't rematch — "the host picks" convention
    const next = $('btn-le-next');
    next.hidden = !canRematch;
    next.textContent = 'Rematch';
    $('btn-le-replay').hidden = true;
    openDialog($('dlg-level-end'));
  },

  showPause(info = {}) {
    pauseChoiceMade = false;
    const lost = info.reason === 'net';
    pauseNetHold = lost && info.role !== 'host';
    $('dlg-pause-title').textContent = lost ? 'Connection lost' : 'Paused';
    $('btn-resume').textContent = lost
      // versus: the host's "continue" hands the top portal to the AI, so the
      // button must not promise a solo continuation that doesn't exist there
      ? (info.role === 'host'
        ? (info.versus ? 'Continue vs computer' : 'Continue solo')
        : 'Keep waiting')
      : 'Resume';
    openDialog($('dlg-pause'));
  },

  hidePause() {
    pauseChoiceMade = true; // programmatic close must not re-emit 'resume'
    pauseNetHold = false;
    closeDialog($('dlg-pause'));
  },

  netStatus(state, data = {}) {
    const banner = $('net-banner');
    const status = $('mp-status');
    clearTimeout(bannerTimer);

    switch (state) {
      case 'idle':
        banner.hidden = true;
        resetMpDialog();
        break;

      case 'waiting':
        banner.hidden = true;
        status.textContent = data.message ?? 'Waiting for a friend to join…';
        break;

      case 'connected':
        hosting = false;
        mpConnected = true;
        $('btn-mp-host').disabled = false;
        status.textContent = 'Connected!';
        banner.className = 'net-banner ok';
        banner.textContent = 'Connected';
        banner.hidden = false;
        bannerTimer = setTimeout(() => { banner.hidden = true; }, 1600);
        break;

      case 'lost':
        banner.className = 'net-banner lost';
        banner.textContent = '⚠ Connection lost — waiting for your friend…';
        banner.hidden = false;
        status.textContent = 'Connection lost';
        break;

      case 'closed':
        banner.hidden = true;
        resetMpDialog();
        status.textContent = data.message ?? 'Connection closed';
        break;
    }
    updateVersusFriendBtn();
  },

  showRoomCode(code) {
    hosting = true;
    currentRoomCode = code;
    $('mp-room-code').textContent = code;
    $('mp-room-box').hidden = false;
    updateVersusFriendBtn();
  },

  // ---- lobby (v1.2) ----
  // mode (optional) seeds #lobby-mode for the host per the start context.
  // levelIdx (optional) seeds the map select + preview — used when the lobby
  // re-opens after a match so it starts on the arena just played.
  showLobby({ role, code, connected = false, mode = 'coop', levelIdx = null }) {
    // moving out of the connect dialog into the lobby: clear the mp-dialog's
    // "host is waiting to connect" flag FIRST, or closing it fires its
    // cancel-mp handler and tears down the room we just created
    hosting = false;
    closeDialog($('dlg-multiplayer'));

    lobbyRole = role;
    lobbyConnected = Boolean(connected);
    lobbyGuestName = null;

    if (role === 'host') {
      currentRoomCode = code ?? currentRoomCode;    // keep copy-link + mpRole() in sync
      $('lobby-room-code').textContent = currentRoomCode ?? '';
      buildLobbyMap();
      $('lobby-mode').value = mode === 'versus' ? 'versus' : 'coop';
      if (LEVELS[levelIdx]) $('lobby-map').value = String(levelIdx);
    } else {
      // guest carries no room code — mpRole() relies on that to tell host/guest apart
      $('lobby-guest-msg').textContent = 'Waiting for the host to choose the map…';
    }

    refreshLobby();
    openDialog($('dlg-lobby'));
    // after the dialog is laid out, so clientWidth is real
    showLobbyPreview(role === 'host' ? Number($('lobby-map').value) : (levelIdx ?? lobbyPreviewIdx ?? 0));
  },

  // mode/levelIdx arrive from the host's live lobby choices (guest side).
  // levelIdx is peer-supplied: coerce to a real array index or ignore it.
  updateLobby({ connected, guestName, mode, levelIdx } = {}) {
    if (typeof connected === 'boolean') lobbyConnected = connected;
    if (guestName != null) lobbyGuestName = guestName;
    const idx = Number(levelIdx);
    if (Number.isInteger(idx) && idx >= 0 && idx < LEVELS.length) {
      showLobbyPreview(idx);
      if (lobbyRole === 'guest') {
        const modeName = mode === 'versus' ? 'Versus' : 'Co-op';
        $('lobby-guest-msg').textContent = `Host is setting up: ${modeName} · ${LEVELS[idx].name}`;
      }
    }
    refreshLobby();
  },

  // the host's current lobby selection, for mirroring to a peer
  lobbyConfig() {
    return { mode: $('lobby-mode').value, levelIdx: Number($('lobby-map').value) };
  },

  // re-open the versus setup (difficulty + arena) — the selects keep the last
  // used values, so it reads as "adjust", not "start over"
  showVersusSetup({ focus = null } = {}) {
    updateVersusFriendBtn();
    openDialog($('dlg-versus'));
    requestAnimationFrame(() => {
      showVersusPreview();
      // land on the control the player came here to change
      const el = focus === 'map' ? $('vs-map') : focus === 'difficulty' ? $('vs-difficulty') : null;
      el?.focus();
      el?.scrollIntoView({ block: 'nearest' });
    });
  },

  hideLobby() {
    closeDialog($('dlg-lobby'));
  },

  toast(text) {
    toastQueue.push(text);
    runToastQueue();
  },
};

const api = ui; // internal alias so wiring helpers can call public methods
