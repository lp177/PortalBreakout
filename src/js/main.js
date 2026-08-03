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
  showScreen('game');
  setMusic('game');
  if (net.connected && net.role === 'host') engine.startHost(levelIdx);
  else engine.startSolo(levelIdx);
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
      break;
    case 'data':
      engine.onNetMessage(event.msg);
      break;
    case 'lost':
      netLost = true;
      engine.pause('net');
      ui.netStatus('lost');
      ui.toast(lastRole === 'host'
        ? 'Friend disconnected — Resume to continue solo, or wait.'
        : 'Connection lost — waiting for the host…');
      break;
    case 'reconnected':
      netLost = false;
      ui.netStatus('connected');
      engine.resume();
      ui.toast('Friend is back!');
      break;
    case 'closed':
      ui.netStatus('closed');
      if (lastRole === 'host') {
        if (screen === 'game') {
          engine.convertToSolo();
          engine.resume();
          ui.toast('Your friend left — continuing solo.');
        }
      } else if (lastRole === 'guest' && screen === 'game') {
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
      if (net.connected && net.role === 'guest') {
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
          net.close();
          engine.convertToSolo();
          engine.resume();
          netLost = false;
          ui.netStatus('idle');
          ui.toast('Continuing solo.');
        } else {
          ui.toast('Waiting for the host to come back…');
        }
        break;
      }
      engine.resume();
      break;
    case 'retry':
      if (net.connected && net.role === 'guest') {
        ui.toast('The host picks what happens next.');
        break;
      }
      engine.retryLevel();
      break;
    case 'next-level':
      if (net.connected && net.role === 'guest') {
        ui.toast('The host picks what happens next.');
        break;
      }
      if (currentLevelIdx === LEVELS.length - 1) {
        engine.quit();
        audio.sfx('win');
        goToMenu();
        ui.toast('You beat every level — incredible!');
      } else {
        currentLevelIdx++;
        engine.nextLevel();
      }
      break;
    case 'quit-to-menu':
      engine.quit();
      if (net.connected) net.close();
      lastRole = null;
      netLost = false;
      goToMenu();
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
      ui.showLevelEnd({ cleared, score, best, levelIdx, isLast: levelIdx === LEVELS.length - 1 });
    },
    onGameOver() {
      // level-end dialog (cleared:false) covers the UX; nothing extra needed
    },
    onPauseChange(paused) {
      if (paused) ui.showPause();
      else ui.hidePause();
    },
    onRemoteQuit() {
      // guest: host went back to the menu
      goToMenu();
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

  window.__pb = { engine, ui, net, version: '1.0.0' };
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
