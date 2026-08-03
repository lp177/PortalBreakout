// PortalBreakout — bootstrap: wires ui / engine / net / audio together (see CONTRACT.md)

import { engine } from './engine.js';
import { ui } from './ui.js';
import { net } from './net.js';
import { audio } from './audio.js';
import { fx } from './particles.js';
import { LEVELS } from './levels.js';
import { loadSettings, loadProgress, recordLevelResult } from './storage.js';

let settings = null;
let currentLevelIdx = 0;
let currentMusic = null;
let lastRole = null;     // 'host' | 'guest' | null — survives net teardown
let netLost = false;
let screen = 'menu';
let vsConfig = null;     // { type: 'ai', difficulty } | { type: 'mp' } — current versus game, for rematch

const setMusic = (track) => {
  currentMusic = track;
  audio.music(track);
};

const showScreen = (name) => {
  screen = name;
  ui.showScreen(name);
};

const goToMenu = () => {
  showScreen('menu');
  setMusic('menu');
};

const startGame = (levelIdx) => {
  currentLevelIdx = levelIdx;
  vsConfig = null;       // campaign game: no versus config in effect
  showScreen('game');
  setMusic('game');
  // gate on session existence (net.role), not net.connected: during a transient
  // 'lost' the session is still alive and must stay the multiplayer game
  if (net.role === 'host') engine.startHost(levelIdx);
  else engine.startSolo(levelIdx);
};

// Start (or restart, for rematch) a versus match; keeps any live net session.
const startVersus = (config) => {
  vsConfig = config;
  showScreen('game');
  setMusic('game');      // versus keeps the normal game track
  if (config.type === 'mp') engine.startVersusHost();
  else engine.startVersusAI(config.difficulty);
};

// End the current game AND the net session (if any). lastRole/netLost are
// cleared BEFORE net.close() because close() synchronously emits 'closed' into
// netCb — otherwise our own deliberate quit is misread as "the peer left".
const leaveGame = () => {
  engine.quit();
  lastRole = null;
  netLost = false;
  vsConfig = null;
  goToMenu();
  if (net.role) net.close();
};

const netCb = (event) => {
  switch (event.type) {
    case 'open':
      lastRole = net.role;
      ui.netStatus('connected');
      if (net.role === 'guest') {
        document.getElementById('dlg-multiplayer')?.close?.();
        showScreen('game');
        setMusic('game');
        engine.startGuest();
        ui.toast('Connected! You control the top portal.');
      }
      break;
    case 'peer-joined':
      lastRole = 'host';
      ui.netStatus('connected');
      document.getElementById('dlg-multiplayer')?.close?.();
      ui.toast('Friend connected! Pick a level to start.');
      engine.resync(); // no-op unless a hosted game is already running
      break;
    case 'data':
      engine.onNetMessage(event.msg);
      break;
    case 'lost':
      netLost = true;
      engine.pause('net');
      ui.netStatus('lost');
      ui.toast(lastRole === 'host'
        ? (vsConfig
          ? 'Friend disconnected — Resume to play the computer, or wait.'
          : 'Friend disconnected — Resume to continue solo, or wait.')
        : 'Connection lost — waiting for the host…');
      break;
    case 'reconnected':
      netLost = false;
      ui.netStatus('connected');
      engine.resume();
      engine.resync(); // heal a guest that reloaded / missed messages while lost
      ui.toast('Friend is back!');
      break;
    case 'closed':
      ui.netStatus('closed');
      if (lastRole === 'host') {
        if (screen === 'game') {
          engine.convertToSolo(); // in versus the engine hands the top portal to the AI
          engine.resume();
          if (vsConfig) {
            vsConfig = { type: 'ai', difficulty: 'normal' }; // rematch → vs the AI
            ui.toast('Your friend left — the computer takes over.');
          } else {
            ui.toast('Your friend left — continuing solo.');
          }
        }
      } else if (lastRole === 'guest' && screen === 'game') {
        // same cleanup as onRemoteQuit: the connection-lost pause dialog and a
        // leftover level-end/matchend dialog would otherwise sit dead over the
        // menu, and the modal pause dialog (closedby="none") can't be Esc'd away
        ui.hidePause();
        document.getElementById('dlg-level-end')?.close?.();
        engine.quit();
        goToMenu();
        ui.toast('Host left the game.');
      }
      netLost = false;
      lastRole = null;
      break;
    case 'error':
      ui.netStatus('idle');
      ui.toast(event.message || 'Connection error.');
      break;
  }
};

const onAction = (name, data = {}) => {
  switch (name) {
    case 'play':
    case 'replay':
      if (net.role === 'guest') {
        ui.toast('The host picks the level.');
        break;
      }
      startGame(data.levelIdx ?? currentLevelIdx);
      break;
    case 'host':
      net.host(netCb)
        .then((code) => {
          lastRole = 'host';
          ui.showRoomCode(code);
          ui.netStatus('waiting');
        })
        .catch((err) => {
          ui.netStatus('idle');
          ui.toast(`Could not create room: ${err?.message ?? err}`);
        });
      break;
    case 'join':
      net.join(data.code, netCb).catch((err) => {
        ui.netStatus('idle');
        ui.toast(`Could not join: ${err?.message ?? err}`);
      });
      break;
    case 'pause':
      engine.pause('user');
      break;
    case 'resume':
      if (netLost) {
        if (lastRole === 'host') {
          // reset flags BEFORE close(): 'closed' is emitted synchronously
          netLost = false;
          lastRole = null;
          net.close();
          engine.convertToSolo(); // in versus the engine hands the top portal to the AI
          engine.resume();
          ui.netStatus('idle');
          if (vsConfig) {
            vsConfig = { type: 'ai', difficulty: 'normal' }; // rematch → vs the AI
            ui.toast('The computer takes over.');
          } else {
            ui.toast('Continuing solo.');
          }
        } else {
          ui.toast('Waiting for the host to come back…');
          ui.showPause({ reason: 'net', role: 'guest' }); // keep the lost dialog up
        }
        break;
      }
      engine.resume();
      break;
    case 'retry':
      if (net.role === 'guest') {
        ui.toast('The host picks what happens next.');
        break;
      }
      engine.retryLevel();
      break;
    case 'next-level':
      if (net.role === 'guest') {
        ui.toast('The host picks what happens next.');
        break;
      }
      if (currentLevelIdx === LEVELS.length - 1) {
        leaveGame(); // finale: win fanfare already played on the level-end dialog
      } else {
        currentLevelIdx++;
        engine.nextLevel();
      }
      break;
    case 'versus-ai':
      // a solo-vs-AI match can't coexist with a live MP session — end it first
      // (flags reset BEFORE close(): 'closed' is emitted synchronously)
      if (net.role) {
        lastRole = null;
        netLost = false;
        net.close();
      }
      document.getElementById('dlg-versus')?.close?.();
      startVersus({ type: 'ai', difficulty: data.difficulty ?? 'normal' });
      break;
    case 'versus-mp':
      if (net.role === 'host' && net.connected) {
        document.getElementById('dlg-versus')?.close?.();
        startVersus({ type: 'mp' });
      } else if (net.role === 'guest') {
        ui.toast('Only the host can start a versus match.');
      } else {
        // covers both "no session" and "room created, friend not joined yet"
        ui.toast(net.role === 'host'
          ? 'Waiting for your friend to join…'
          : 'Connect with a friend first.');
        document.getElementById('dlg-versus')?.close?.();
        document.getElementById('dlg-multiplayer')?.showModal?.();
      }
      break;
    case 'rematch':
      if ((lastRole ?? net.role) === 'guest') {
        ui.toast('The host decides on a rematch.');
        break;
      }
      if (vsConfig) startVersus(vsConfig); // same config; host relays via the start messages
      break;
    case 'quit-to-menu':
      leaveGame();
      break;
    case 'options-changed':
      settings = data.settings;
      engine.applySettings(settings);
      audio.applySettings(settings.audio);
      fx.setEffectsLevel(settings.effects);
      break;
    case 'cancel-mp':
      net.close();
      ui.netStatus('idle');
      lastRole = null;
      break;
  }
};

const init = () => {
  settings = loadSettings();
  audio.applySettings(settings.audio);
  fx.setEffectsLevel(settings.effects);

  engine.mount(document.getElementById('game-canvas'));
  engine.applySettings(settings);
  engine.setCallbacks({
    onLevelEnd({ levelIdx, score, timeMs, cleared }) {
      currentLevelIdx = levelIdx;
      const best = loadProgress().levels[levelIdx]?.bestScore ?? 0; // best BEFORE this run
      if (lastRole !== 'guest') {
        recordLevelResult(levelIdx, { score, timeMs, completed: cleared });
        ui.refreshLevelGrid();
      }
      const isLast = levelIdx === LEVELS.length - 1;
      ui.showLevelEnd({ cleared, score, best, levelIdx, isLast });
      if (cleared && isLast) {
        // beating the final level gets its own payoff, on the dialog itself
        audio.sfx('win');
        fx.confetti();
        ui.toast('You beat every level — incredible!');
      }
    },
    onGameOver() {
      // level-end dialog (cleared:false) covers the UX; nothing extra needed
    },
    onMatchEnd({ winner, youWon, scoreBottom, scoreTop, timeMs }) {
      // versus only; never records level progress. Local perspective (guest = top):
      const mySide = youWon ? winner : (winner === 'bottom' ? 'top' : 'bottom');
      const scoreYou = mySide === 'bottom' ? scoreBottom : scoreTop;
      const scoreThem = mySide === 'bottom' ? scoreTop : scoreBottom;
      if (youWon) audio.sfx('win'); // engine already played the loser's 'gameOver'
      const canRematch = (lastRole ?? net.role) !== 'guest'; // host + solo-vs-AI only
      ui.showMatchEnd({ youWon, scoreYou, scoreThem, timeMs, canRematch });
    },
    onPauseChange(paused, reason) {
      // versus flag: the lost-connection primary action is an AI takeover
      // there, so ui labels it honestly instead of "Continue solo"
      if (paused) ui.showPause({ reason, role: lastRole ?? net.role, versus: Boolean(vsConfig) });
      else ui.hidePause();
    },
    onLevelStart() {
      // guest: the host advanced/restarted — drop any leftover level-end dialog
      document.getElementById('dlg-level-end')?.close?.();
    },
    onRemoteQuit() {
      // guest: host went back to the menu — end our session too, or its zombie
      // heartbeat/repair loop reaches into the next (solo) game for 30 s
      ui.hidePause();
      document.getElementById('dlg-level-end')?.close?.();
      goToMenu();
      lastRole = null;
      netLost = false;
      if (net.role) net.close();
      ui.toast('Host returned to the menu.');
    },
  });

  ui.init({ onAction });

  // WebAudio needs a user gesture: init on the first pointer/key, then start music
  const unlock = () => {
    audio.init();
    if (currentMusic) audio.music(currentMusic);
  };
  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('keydown', unlock, { once: true });
  setMusic('menu');

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) engine.pause('auto'); // no-op unless mid-game
  });

  window.__pb = { engine, ui, net, version: '1.1.0' };
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
