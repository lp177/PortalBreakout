// PortalBreakout TURN credentials endpoint (coturn "REST API" auth, RFC-style
// ephemeral credentials): GET /ice returns iceServers with username = unix
// expiry timestamp and credential = base64(HMAC-SHA1(secret, username)).
// The shared secret stays server-side; browsers only ever see credentials
// that die after CREDS_TTL_S seconds. No dependencies.

import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';

const need = (name) => {
  const v = process.env[name];
  if (!v) { console.error(`Missing required env: ${name}`); process.exit(1); }
  return v;
};

const SECRET = need('TURN_SECRET');
const HOST = need('TURN_HOST');
const PORT_TURN = Number(process.env.TURN_PORT ?? 3478);
const TTL_S = Math.max(300, Number(process.env.CREDS_TTL_S ?? 7200));
const PORT = Number(process.env.PORT ?? 8788);
const ORIGINS = (process.env.CORS_ORIGIN ?? '*').split(',').map((s) => s.trim()).filter(Boolean);

// Small per-IP rate limit: minting is cheap but there's no reason to hand out
// thousands of credentials to one client.
const RATE_MAX = 30, RATE_WINDOW_MS = 60_000;
const hits = new Map();
const limited = (ip) => {
  const now = Date.now();
  const rec = hits.get(ip) ?? { n: 0, t0: now };
  if (now - rec.t0 > RATE_WINDOW_MS) { rec.n = 0; rec.t0 = now; }
  rec.n += 1;
  hits.set(ip, rec);
  if (hits.size > 10_000) hits.clear(); // crude but bounded
  return rec.n > RATE_MAX;
};

const corsFor = (origin) => {
  if (ORIGINS.includes('*')) return '*';
  return origin && ORIGINS.includes(origin) ? origin : ORIGINS[0] ?? '';
};

const mint = () => {
  const username = String(Math.floor(Date.now() / 1000) + TTL_S);
  const credential = createHmac('sha1', SECRET).update(username).digest('base64');
  return {
    ttl: TTL_S,
    iceServers: [{
      urls: [
        `turn:${HOST}:${PORT_TURN}?transport=udp`,
        `turn:${HOST}:${PORT_TURN}?transport=tcp`,
      ],
      username,
      credential,
    }],
  };
};

createServer((req, res) => {
  const origin = req.headers.origin;
  const cors = corsFor(origin);
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    ...(cors ? { 'Access-Control-Allow-Origin': cors, Vary: 'Origin' } : {}),
  };
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { ...headers, 'Access-Control-Allow-Methods': 'GET' });
    res.end();
    return;
  }
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/healthz') {
    res.writeHead(200, headers);
    res.end('{"ok":true}');
    return;
  }
  if (req.method !== 'GET' || url.pathname !== '/ice') {
    res.writeHead(404, headers);
    res.end('{"error":"not found"}');
    return;
  }
  const ip = req.socket.remoteAddress ?? 'unknown';
  if (limited(ip)) {
    res.writeHead(429, { ...headers, 'Retry-After': '60' });
    res.end('{"error":"rate limited"}');
    return;
  }
  res.writeHead(200, headers);
  res.end(JSON.stringify(mint()));
}).listen(PORT, () => {
  console.log(`turn-credentials: :${PORT}/ice → turn:${HOST}:${PORT_TURN}, ttl ${TTL_S}s, origins ${ORIGINS.join(', ') || '*'}`);
});
