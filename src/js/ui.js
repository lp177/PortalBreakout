// PortalBreakout — ui module: menus, dialogs, ripple, level grid, rebind flow.
// See CONTRACT.md ("js/ui.js"). No DOM access happens until init() is called.

import { LEVELS } from './levels.js';
import { loadSettings, saveSettings, loadProgress, isUnlocked, DEFAULT_SETTINGS } from './storage.js';
import { audio } from './audio.js';
import { input } from './input.js';

const BIND_LABELS = {
  bottomLeft: 'Bottom paddle ←',
  bottomRight: 'Bottom paddle →',
  bottomFire: 'Bottom paddle · fire',
  topLeft: 'Top paddle ←',
  topRight: 'Top paddle →',
  topFire: 'Top paddle · fire',
  launch: 'Launch ball',
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

// multiplayer dialog state
let hosting = false;
let mpConnected = false;
let currentRoomCode = null;
let bannerTimer = 0;

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
    emit('next-level');
  });
  $('btn-le-replay').addEventListener('click', () => {
    closeDialog(dlgLevelEnd);
    emit('retry');
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

// ---------- public API ----------
export const ui = {
  init({ onAction }) {
    emit = (name, data) => onAction(name, data);
    if (initialized) return;
    initialized = true;

    wireRippleAndClickSfx();
    wireInvokerFallback();
    wireMenu();
    wireOptionsForm();
    wireMultiplayer();
    wireGameDialogs();
    syncOptionsForm();
  },

  showScreen(name) {
    for (const scr of document.querySelectorAll('.screen')) {
      scr.classList.toggle('active', scr.id === `screen-${name}`);
    }
    if (name === 'levels') this.refreshLevelGrid();
  },

  refreshLevelGrid() {
    buildLevelGrid();
  },

  showLevelEnd({ cleared, score, best, levelIdx, isLast }) {
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

    // the finale keeps the primary button as a celebratory "Finish" → menu
    const next = $('btn-le-next');
    next.hidden = !cleared;
    next.textContent = finale ? 'Finish' : 'Next level';
    openDialog($('dlg-level-end'));
  },

  showPause(info = {}) {
    pauseChoiceMade = false;
    const lost = info.reason === 'net';
    pauseNetHold = lost && info.role !== 'host';
    $('dlg-pause-title').textContent = lost ? 'Connection lost' : 'Paused';
    $('btn-resume').textContent = lost
      ? (info.role === 'host' ? 'Continue solo' : 'Keep waiting')
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
  },

  showRoomCode(code) {
    hosting = true;
    currentRoomCode = code;
    $('mp-room-code').textContent = code;
    $('mp-room-box').hidden = false;
  },

  toast(text) {
    toastQueue.push(text);
    runToastQueue();
  },
};

const api = ui; // internal alias so wiring helpers can call public methods
