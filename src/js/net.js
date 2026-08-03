// PortalBreakout — PeerJS multiplayer session: room codes, heartbeat, reconnect (see CONTRACT.md)
// Uses the global `Peer` constructor from vendor/peerjs.min.js (loaded before main.js).

const CODE_PREFIX = 'pb-';
const PEER_PREFIX = 'portalbreakout-';   // namespaced broker id; user-facing code stays 'pb-xxxxx'
const CODE_LEN = 5;
const CODE_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'; // Crockford base32: no i/l/o/u

const HB_SEND_MS = 1000;
const WATCH_MS = 500;
const LOST_AFTER_MS = 3000;
const GIVE_UP_AFTER_MS = 30000;
const REPAIR_EVERY_MS = 5000;
const SETUP_TIMEOUT_MS = 20000;
const HOST_ID_TRIES = 3;

let peer = null;
let conn = null;
let pendingConn = null;   // guest transport-repair attempt in flight
let pendingSince = 0;
let cb = null;
let role = null;          // 'host' | 'guest' | null
let status = 'idle';      // 'idle' | 'starting' | 'waiting' | 'connected' | 'lost'
let hostPeerId = null;
let lastReceived = 0;
let lostAt = 0;
let hbTimer = 0;
let watchTimer = 0;
let repairTimer = 0;
let setupTimer = 0;

const emit = (event) => {
  if (!cb) return;
  try { cb(event); } catch (err) { console.error('net: callback threw', err); }
};

const randomSuffix = () => {
  const bytes = new Uint8Array(CODE_LEN);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < CODE_LEN; i++) bytes[i] = (Math.random() * 256) | 0;
  let s = '';
  for (const b of bytes) s += CODE_ALPHABET[b % 32]; // 256 % 32 === 0 → unbiased
  return s;
};

const normalizeSuffix = (input) => {
  let s = String(input ?? '').trim().toLowerCase();
  if (s.startsWith(CODE_PREFIX)) s = s.slice(CODE_PREFIX.length);
  // Crockford decode aliases: hand-typed o/i/l map to the digits they resemble
  s = s.replace(/o/g, '0').replace(/[il]/g, '1');
  return /^[0-9a-hj-km-np-tv-z]{5}$/.test(s) ? s : null;
};

const messageFor = (err) => {
  switch (err?.type) {
    case 'peer-unavailable': return 'Room not found — check the code';
    case 'browser-incompatible': return 'This browser does not support WebRTC, which multiplayer needs';
    case 'network': return 'Cannot reach the multiplayer server — check your connection';
    case 'server-error': return 'The multiplayer server had a problem — try again later';
    case 'ssl-unavailable': return 'Multiplayer needs a secure (https) connection';
    case 'unavailable-id': return 'Could not reserve a room code — try again';
    case 'socket-error':
    case 'socket-closed': return 'Lost the connection to the multiplayer server';
    default: return err?.message ? `Connection error: ${err.message}` : 'Connection error';
  }
};

const clearTimers = () => {
  clearInterval(hbTimer);
  clearInterval(watchTimer);
  clearInterval(repairTimer);
  clearTimeout(setupTimer);
  hbTimer = watchTimer = repairTimer = setupTimer = 0;
};

// Full session teardown. Handlers on old peer/conn objects self-filter via
// identity checks, so nulling state before destroy() suppresses reactive events.
const teardown = (notifyClosed) => {
  clearTimers();
  const oldPeer = peer;
  const oldConn = conn;
  const oldPending = pendingConn;
  const listener = cb;
  const wasActive = status !== 'idle';
  peer = null; conn = null; pendingConn = null; pendingSince = 0;
  hostPeerId = null; role = null; cb = null;
  status = 'idle';
  try { oldPending?.close(); } catch { /* already dead */ }
  try { oldConn?.close(); } catch { /* already dead */ }
  try { oldPeer?.destroy(); } catch { /* already dead */ }
  if (notifyClosed && wasActive && listener) {
    try { listener({ type: 'closed' }); } catch (err) { console.error('net: callback threw', err); }
  }
};

const stopRepair = () => {
  clearInterval(repairTimer);
  repairTimer = 0;
  if (pendingConn) { try { pendingConn.close(); } catch { /* ignore */ } }
  pendingConn = null;
  pendingSince = 0;
};

const startHeartbeat = () => {
  clearInterval(hbTimer);
  hbTimer = setInterval(() => {
    if (!conn?.open) return;
    try { conn.send({ t: 'hb', ts: performance.now() }); } catch { /* channel died mid-send */ }
  }, HB_SEND_MS);
};

const startWatchdog = () => {
  clearInterval(watchTimer);
  watchTimer = setInterval(() => {
    const now = performance.now();
    if (status === 'connected' && now - lastReceived > LOST_AFTER_MS) {
      markLost();
    } else if (status === 'lost' && now - lostAt > GIVE_UP_AFTER_MS) {
      teardown(true);
    }
  }, WATCH_MS);
};

const markLost = () => {
  if (status !== 'connected') return;
  status = 'lost';
  lostAt = performance.now();
  emit({ type: 'lost' });
  if (role === 'guest') startRepair();
};

// Any incoming message (hb included) counts as liveness; only non-hb is forwarded.
const handleMessage = (raw) => {
  lastReceived = performance.now();
  if (status === 'lost') {
    status = 'connected';
    stopRepair();
    emit({ type: 'reconnected' });
  }
  if (raw && typeof raw === 'object' && raw.t === 'hb') return;
  emit({ type: 'data', msg: raw });
};

const wireConn = (c) => {
  c.on('data', (raw) => {
    if (c !== conn || status === 'idle') return;
    handleMessage(raw);
  });
  c.on('close', () => {
    if (c !== conn || status === 'idle') return;
    markLost();
  });
  c.on('error', () => {
    if (c !== conn || status === 'idle') return;
    markLost();
  });
};

// Make `c` the live channel. Returns the status it replaced so callers can
// pick the right event (peer-joined vs reconnected vs silent replacement).
const adopt = (c) => {
  clearTimeout(setupTimer);
  setupTimer = 0;
  const old = conn;
  conn = c;
  if (pendingConn === c) { pendingConn = null; pendingSince = 0; }
  if (old && old !== c) { try { old.close(); } catch { /* ignore */ } }
  lastReceived = performance.now();
  startHeartbeat();
  startWatchdog();
  const was = status;
  status = 'connected';
  stopRepair();
  return was;
};

// Guest-only: while 'lost' with a closed channel, redial the host every 5 s.
// The host replaces its dead connection with the new one.
const startRepair = () => {
  if (repairTimer) return;
  const tick = () => {
    if (status !== 'lost' || !peer || peer.destroyed) { stopRepair(); return; }
    if (conn?.open) return; // channel alive but silent — wait for data, no redial needed
    const now = performance.now();
    if (pendingConn) {
      if (now - pendingSince < REPAIR_EVERY_MS * 2) return; // attempt still plausible
      try { pendingConn.close(); } catch { /* ignore */ }
      pendingConn = null;
      pendingSince = 0;
    }
    if (peer.disconnected) {
      try { peer.reconnect(); } catch { /* destroyed under us */ }
      return; // need the broker back before we can redial
    }
    let c;
    try { c = peer.connect(hostPeerId, { reliable: true }); } catch { return; }
    pendingConn = c;
    pendingSince = now;
    wireConn(c);
    c.on('open', () => {
      if (c !== pendingConn || status === 'idle') { try { c.close(); } catch { /* ignore */ } return; }
      const was = adopt(c);
      if (was === 'lost') emit({ type: 'reconnected' });
    });
    c.on('close', () => {
      if (c === pendingConn) { pendingConn = null; pendingSince = 0; }
    });
    c.on('error', () => {
      if (c === pendingConn) { pendingConn = null; pendingSince = 0; }
    });
  };
  tick(); // immediate first attempt (covers "channel already closed" case)
  repairTimer = setInterval(tick, REPAIR_EVERY_MS);
};

// Host side: accept the first guest; reject extras while a live channel exists.
// While 'lost' (or the old channel is already closed) a new connection replaces it.
const handleIncomingConnection = (c) => {
  if (conn?.open && status !== 'lost') {
    try { c.close(); } catch { /* ignore */ }
    c.on('open', () => { try { c.close(); } catch { /* ignore */ } });
    return;
  }
  wireConn(c);
  c.on('open', () => {
    if (!peer || status === 'idle') { try { c.close(); } catch { /* ignore */ } return; }
    const was = adopt(c);
    if (was === 'waiting') emit({ type: 'peer-joined' });
    else if (was === 'lost') emit({ type: 'reconnected' });
    // was 'connected': silent replacement of a channel that died before the watchdog noticed
  });
};

const host = (listener) => {
  teardown(false); // silently drop any previous session
  cb = listener;
  if (typeof Peer === 'undefined') {
    return Promise.reject(new Error('Multiplayer requires the PeerJS library (are you offline?)'));
  }
  role = 'host';
  status = 'starting';
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (message) => {
      if (settled) return;
      settled = true;
      // no 'error' emit here: the rejection is the single failure channel
      // (emitting too made every failure toast twice in main.js)
      teardown(false);
      reject(new Error(message));
    };
    let tries = 0;
    const attempt = () => {
      tries += 1;
      const suffix = randomSuffix();
      const roomCode = CODE_PREFIX + suffix;
      let p;
      try { p = new Peer(PEER_PREFIX + suffix); } catch { fail('Could not start multiplayer — try again'); return; }
      peer = p;
      clearTimeout(setupTimer);
      setupTimer = setTimeout(() => {
        if (p === peer && !settled) fail('Could not reach the multiplayer server — try again');
      }, SETUP_TIMEOUT_MS);
      p.on('open', () => {
        if (p !== peer) return;
        clearTimeout(setupTimer);
        setupTimer = 0;
        status = 'waiting';
        if (!settled) { settled = true; resolve(roomCode); }
      });
      p.on('disconnected', () => {
        // dropped from the signaling broker; rejoin so the guest can still (re)dial us
        if (p === peer && !p.destroyed) { try { p.reconnect(); } catch { /* ignore */ } }
      });
      p.on('connection', (c) => {
        if (p !== peer) return;
        handleIncomingConnection(c);
      });
      p.on('error', (err) => {
        if (p !== peer) return;
        const type = err?.type;
        if (type === 'unavailable-id' && !settled) {
          try { p.destroy(); } catch { /* ignore */ }
          if (tries < HOST_ID_TRIES) attempt();
          else fail('Could not reserve a room code — try again');
          return;
        }
        if (type === 'network' || type === 'peer-unavailable') return; // transient broker blip / redial noise
        if (!settled) { fail(messageFor(err)); return; }
        emit({ type: 'error', message: messageFor(err) });
        // fatal error with no live channel → the room is dead, end the session
        if (p.destroyed && !conn?.open) teardown(true);
      });
    };
    attempt();
  });
};

const join = (roomCode, listener) => {
  teardown(false);
  cb = listener;
  if (typeof Peer === 'undefined') {
    return Promise.reject(new Error('Multiplayer requires the PeerJS library (are you offline?)'));
  }
  const suffix = normalizeSuffix(roomCode);
  if (!suffix) {
    return Promise.reject(new Error('Invalid room code — expected pb- plus 5 letters/numbers'));
  }
  role = 'guest';
  status = 'starting';
  hostPeerId = PEER_PREFIX + suffix;
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (message) => {
      if (settled) return;
      settled = true;
      // no 'error' emit here: the rejection is the single failure channel
      teardown(false);
      reject(new Error(message));
    };
    let p;
    try { p = new Peer(); } catch { fail('Could not start multiplayer — try again'); return; }
    peer = p;
    setupTimer = setTimeout(() => {
      if (p === peer && !settled) fail('Could not connect — try again');
    }, SETUP_TIMEOUT_MS);
    p.on('disconnected', () => {
      if (p === peer && !p.destroyed) { try { p.reconnect(); } catch { /* ignore */ } }
    });
    p.on('error', (err) => {
      if (p !== peer) return;
      if (!settled) { fail(messageFor(err)); return; }
      const type = err?.type;
      if (type === 'network' || type === 'peer-unavailable') return; // repair redials handle these
      emit({ type: 'error', message: messageFor(err) });
    });
    p.on('open', () => {
      if (p !== peer) return;
      let c;
      try { c = p.connect(hostPeerId, { reliable: true }); } catch { fail('Could not connect — try again'); return; }
      wireConn(c);
      c.on('open', () => {
        if (p !== peer || status === 'idle') { try { c.close(); } catch { /* ignore */ } return; }
        adopt(c);
        if (!settled) { settled = true; resolve(); }
        emit({ type: 'open' });
      });
      c.on('close', () => { if (!settled) fail('Connection failed — try again'); });
      c.on('error', () => { if (!settled) fail('Could not connect — try again'); });
    });
  });
};

const send = (msg) => {
  if (!conn?.open) return;
  try { conn.send(msg); } catch { /* channel torn down mid-send — watchdog will notice */ }
};

const close = () => teardown(true);

export const net = {
  host,
  join,
  send,
  close,
  get connected() { return status === 'connected' && conn?.open === true; },
  get role() { return role; },
};
