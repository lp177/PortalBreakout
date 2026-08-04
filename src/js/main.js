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
let vsConfig = null;     // { type: 'ai', difficulty } | { type: 'mp', levelIdx } — current versus game, for rematch
let roomCode = null;     // this host's room code — survives the connect→lobby handoff
let pendingLobbyMode = 'coop'; // which mode the lobby opens in once a room is created (co-op vs versus entry)

const setMusic = (track, opts) => {
  currentMusic = track;
  audio.music(track, opts);
};

const showScreen = (name) => {
  screen = name;
  ui.showScreen(name);
};

const goToMenu = () => {
  showScreen('menu');
  setMusic('menu');
};

// a live, usable room — the precondition for offering "Change map" (a dropped
// or absent session has no lobby to go back to)
const inRoom = () => Boolean(net.role) && net.connected;

const startGame = (levelIdx) => {
  currentLevelIdx = levelIdx;
  vsConfig = null;       // campaign game: no versus config in effect
  showScreen('game');
  setMusic('game', { fresh: true });   // new game, new song
  // gate on session existence (net.role), not net.connected: during a transient
  // 'lost' the session is still alive and must stay the multiplayer game
  if (net.role === 'host') engine.startHost(levelIdx);
  else engine.startSolo(levelIdx);
};

// Start (or restart, for rematch) a versus match; keeps any live net session.
const startVersus = (config) => {
  vsConfig = config;
  showScreen('game');
  // versus keeps the game track, but a rematch / new arena gets a new song
  setMusic('game', { fresh: true });
  // levelIdx undefined → the engine picks a random arena (the "Random" option)
  if (config.type === 'mp') engine.startVersusHost(config.levelIdx);
  else engine.startVersusAI(config.difficulty, config.levelIdx);
};

// End the current game AND the net session (if any). lastRole/netLost are
// cleared BEFORE net.close() because close() synchronously emits 'closed' into
// netCb — otherwise our own deliberate quit is misread as "the peer left".
const leaveGame = () => {
  engine.quit();
  lastRole = null;
  netLost = false;
  vsConfig = null;
  roomCode = null;
  goToMenu();
  if (net.role) net.close();
};

const netCb = (event) => {
  switch (event.type) {
    case 'open':
      lastRole = net.role;
      ui.netStatus('connected');
      if (net.role === 'guest') {
        // enter guest mode now (idles until the first state/level), but wait in
        // the lobby — the host picks mode + map; the game opens on {t:'level'}
        engine.startGuest();
        ui.showLobby({ role: 'guest', connected: true });
        audio.sfx('join');
        ui.toast('Connected! Waiting for the host…');
      }
      break;
    case 'peer-joined':
      lastRole = 'host';
      ui.netStatus('connected');
      ui.updateLobby({ connected: true });    // enable Start, reveal Kick, flip the guest slot
      {
        // definitively put the guest in the lobby view, with the host's current
        // mode/map so their preview matches from the first frame
        const cfg = ui.lobbyConfig();
        net.send({ t: 'lobby', mode: cfg.mode, map: cfg.levelIdx });
      }
      // a toast alone is easy to miss while you look elsewhere — the room is
      // exactly where you are waiting on someone else to act
      audio.sfx('join');
      ui.toast('Friend connected!');
      engine.resync(); // no-op unless a hosted game is already running
      break;
    case 'data': {
      const msg = event.msg;
      // lobby-control messages are peeked here before the engine (which ignores
      // unknown t); everything else is forwarded to the simulation
      if (msg && msg.t === 'lobby') {
        if (screen !== 'game') {              // ignore a stray lobby msg once in-game
          // don't re-open (and reset) a lobby that is already up: the host
          // sends this on every mode/map change while browsing
          if (!document.getElementById('dlg-lobby')?.open) {
            ui.showLobby({ role: 'guest', connected: true });
          }
          ui.updateLobby({ connected: true, mode: msg.mode, levelIdx: msg.map });
        }
        break;
      }
      if (msg && msg.t === 'kick') {
        ui.hideLobby();
        engine.quit?.();
        lastRole = null;
        netLost = false;
        goToMenu();
        ui.toast('The host removed you from the room.');
        if (net.role) net.close();
        break;
      }
      engine.onNetMessage(msg);
      break;
    }
    case 'lost':
      netLost = true;
      engine.pause('net'); // no-op while waiting in the lobby (phase is idle)
      ui.netStatus('lost');
      if (screen === 'game') {
        ui.toast(lastRole === 'host'
          ? (vsConfig
            ? 'Friend disconnected — Resume to play the computer, or wait.'
            : 'Friend disconnected — Resume to continue solo, or wait.')
          : 'Connection lost — waiting for the host…');
      } else {
        // still in the lobby: no match to fall back to — hold and wait for the
        // peer (the follow-up 'closed' drops us to the menu if they gave up)
        ui.updateLobby({ connected: false });
        ui.toast(lastRole === 'host' ? 'Your friend dropped — waiting…' : 'Lost the host — waiting…');
      }
      break;
    case 'reconnected':
      netLost = false;
      ui.netStatus('connected');
      if (screen === 'game') {
        engine.resume();
        engine.resync(); // heal a guest that reloaded / missed messages while lost
      } else {
        ui.updateLobby({ connected: true }); // re-arm the lobby after a brief drop
      }
      audio.sfx('join');                     // same "they're here" signal
      ui.toast('Friend is back!');
      break;
    case 'closed': {
      ui.netStatus('closed');
      // lastRole === null means WE tore the session down (leaveGame / kick / leave):
      // both role branches are skipped and this is just a state reset
      const inLobby = screen !== 'game';
      if (lastRole === 'host') {
        if (inLobby) {
          // the guest bailed before the match started → back to a clean menu
          ui.hideLobby();
          engine.quit();
          goToMenu();
          ui.toast('Your friend left the lobby.');
        } else {
          engine.convertToSolo(); // in versus the engine hands the top portal to the AI
          engine.resume();
          if (vsConfig) {
            vsConfig = { type: 'ai', difficulty: 'normal', levelIdx: vsConfig.levelIdx }; // rematch → vs the AI, same arena
            ui.toast('Your friend left — the computer takes over.');
          } else {
            ui.toast('Your friend left — continuing solo.');
          }
        }
      } else if (lastRole === 'guest') {
        // same cleanup as onRemoteQuit: a leftover connection-lost pause dialog
        // and a level-end/matchend dialog (closedby="none") would otherwise sit
        // dead over the menu; the lobby too if the host left mid-setup
        ui.hidePause();
        ui.hideLobby();
        document.getElementById('dlg-level-end')?.close?.();
        engine.quit();
        goToMenu();
        ui.toast(inLobby ? 'The host closed the room.' : 'Host left the game.');
      }
      netLost = false;
      lastRole = null;
      roomCode = null;
      break;
    }
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
          roomCode = code;
          ui.netStatus('waiting');
          // hand off from the connect dialog to the lobby (showLobby closes
          // #dlg-multiplayer safely and seeds #lobby-mode from the entry point)
          ui.showLobby({ role: 'host', code, connected: false, mode: pendingLobbyMode });
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
            vsConfig = { type: 'ai', difficulty: 'normal', levelIdx: vsConfig.levelIdx }; // rematch → vs the AI, same arena
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
    case 'lobby-start':
      // the single place a friend match begins — host only (Start is hidden for the guest)
      ui.hideLobby();
      if (data.mode === 'versus') startVersus({ type: 'mp', levelIdx: data.levelIdx });
      else startGame(data.levelIdx);       // startGame → engine.startHost (host role)
      break;
    case 'lobby-config':
      // host is browsing mode/map in the lobby — mirror it so the guest's
      // preview and "host is setting up" line follow along
      if (net.role === 'host' && net.connected) {
        net.send({ t: 'lobby', mode: data.mode, map: data.levelIdx });
      }
      break;
    case 'versus-setup':
      // vs-Computer post-match: back to the setup dialog to change difficulty
      // (or arena) rather than replaying the same match forever
      engine.quit();
      goToMenu();
      ui.showVersusSetup({ focus: data.focus });
      break;
    case 'back-to-lobby': {
      // Post-game exit that KEEPS the room: both players land back in the lobby
      // so the host can pick another map and start again — no re-invite.
      if (!net.role) { leaveGame(); break; }     // solo / vs-AI: nothing to keep
      const role = net.role;
      const mode = vsConfig ? 'versus' : 'coop';
      if (role === 'host') engine.quitToLobby();  // broadcasts 'backtolobby'
      else engine.startGuest();                   // re-arm; the room stays up
      document.getElementById('dlg-level-end')?.close?.();
      ui.hidePause();
      goToMenu();
      ui.showLobby({ role, code: roomCode, connected: net.connected, mode, levelIdx: currentLevelIdx });
      if (role === 'host' && net.connected) {
        net.send({ t: 'lobby', mode, map: currentLevelIdx });
      }
      break;
    }
    case 'lobby-kick':
      net.send({ t: 'kick' });             // tell the guest before we drop the channel
      ui.hideLobby();
      leaveGame();                         // host-side teardown: quit + goToMenu + net.close
      ui.toast('You removed your friend.');
      break;
    case 'lobby-leave':
      ui.hideLobby();
      leaveGame();                         // the peer sees the normal closed/lost path → menu
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
      startVersus({ type: 'ai', difficulty: data.difficulty ?? 'normal', levelIdx: data.levelIdx });
      break;
    case 'versus-mp':
      if (net.role === 'host' && net.connected) {
        // friend already present → open the versus lobby; the host still starts
        // explicitly (Start), so a match never begins from this button
        document.getElementById('dlg-versus')?.close?.();
        pendingLobbyMode = 'versus';
        ui.showLobby({ role: 'host', code: roomCode, connected: true, mode: 'versus' });
        net.send({ t: 'lobby', mode: 'versus' });
      } else if (net.role === 'guest') {
        ui.toast('Only the host can start a versus match.');
      } else {
        // covers both "no session" and "room created, friend not joined yet";
        // remember the versus intent so the lobby opens in versus once connected
        pendingLobbyMode = 'versus';
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
      ui.showLevelEnd({ cleared, score, best, levelIdx, isLast, canLobby: inRoom() });
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
    onMatchEnd({ winner, youWon, scoreBottom, scoreTop, timeMs, levelIdx }) {
      // versus only; never records level progress. Local perspective (guest = top):
      const mySide = youWon ? winner : (winner === 'bottom' ? 'top' : 'bottom');
      const scoreYou = mySide === 'bottom' ? scoreBottom : scoreTop;
      const scoreThem = mySide === 'bottom' ? scoreTop : scoreBottom;
      if (youWon) audio.sfx('win'); // engine already played the loser's 'gameOver'
      const canRematch = (lastRole ?? net.role) !== 'guest'; // host + solo-vs-AI only
      if (Number.isInteger(levelIdx)) currentLevelIdx = levelIdx; // seed the lobby re-open
      ui.showMatchEnd({
        youWon, scoreYou, scoreThem, timeMs, canRematch,
        canLobby: inRoom(),
        canSetup: !net.role && vsConfig?.type === 'ai',   // solo vs the computer
      });
    },
    onPauseChange(paused, reason) {
      // versus flag: the lost-connection primary action is an AI takeover
      // there, so ui labels it honestly instead of "Continue solo"
      if (paused) ui.showPause({ reason, role: lastRole ?? net.role, versus: Boolean(vsConfig) });
      else ui.hidePause();
    },
    onLevelStart() {
      // guest-only (engine fires this from its {t:'level'} handler): the host
      // advanced/restarted, or started the very first arena from the lobby.
      // Drop any leftover level-end dialog, and leave the lobby for the game.
      document.getElementById('dlg-level-end')?.close?.();
      ui.hideLobby();
      if (screen !== 'game') {
        showScreen('game');
        setMusic('game');
      }
    },
    onRemoteLobby() {
      // guest: the host ended the game but kept the room — wait in the lobby
      // for their next pick instead of being dropped to the menu (the engine
      // has already re-armed us as a guest)
      ui.hidePause();
      document.getElementById('dlg-level-end')?.close?.();
      goToMenu();
      ui.showLobby({ role: 'guest', connected: net.connected });
      ui.toast('Back in the lobby — the host is picking the next game.');
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

  // "Play with a friend" opens the connect dialog via an HTML invoker (bypassing
  // onAction). Default the lobby to Versus so a friend game gives each player
  // their own 3 lives (the natural expectation); co-op (shared lives) stays one
  // click away in the lobby's Mode select.
  document.getElementById('btn-multiplayer')?.addEventListener('click', () => {
    pendingLobbyMode = 'versus';
  });

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

  window.__pb = { engine, ui, net, audio, version: '1.3.1' };
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
