# PortalBreakout

**Your paddles are portals.** A Breakout/Arkanoid-style arcade game with a twist: the ball never bounces off your paddle — it teleports out of the *other* paddle at the opposite edge of the field, keeping its momentum. A falling ball re-enters falling from the top; a rising ball re-enters rising from the bottom. Guard both edges, steer with portal english, and break every brick.

**▶ Play it: <https://lp177.github.io/PortalBreakout/>**

## Features

- 🌀 **Portal paddles** — one orange (bottom), one blue (top). Where the ball enters the paddle decides how its exit curves: edge hits add spin, and every teleport speeds the ball up.
- 🧱 **150 handcrafted levels** inspired by the most famous Breakout/Arkanoid layouts, plus Portal-flavored pixel art (the cake is real here).
- 🎮 **Solo** — control both paddles at once (fully rebindable keys, mouse, or split-screen touch), with an optional assist that mirrors the top paddle.
- 👥 **Play with a friend** — peer-to-peer via WebRTC: host a room, share a code or link, each player takes one portal. Pick your map from a lobby that previews every layout, and when a game ends **"Change map" keeps you both in the room** — choose another arena and start again, no re-invite. Disconnections pause the game and let you wait or continue solo.
- ⚔️ **Versus mode** — duel a friend online or the built-in AI (4 difficulties, and you pick the arena from a previewed list). One portal each, 3 lives each: miss a ball on your side, lose a life — last one standing wins. The ball speeds up over time, so no camping; power-ups belong to whoever catches them; and when an arena is cleared, the player who broke the **last brick** banks a bonus life and serves next — so the final brick is worth fighting for.
- 💥 **Game juice everywhere** — particles, screen shake, portal flashes, combos, slow-mo finishes, and seven power-ups (multiball, lasers, fireball, sticky, expand, slow, extra life).
- 🔊 **Fully procedural audio** — every sound effect and every music track is synthesized live with WebAudio. No assets, no downloads. The soundtrack picks one of six generative songs per game — each with its own scale, groove, swing and subdivision, from a sparse half-time dub to a relentless 16th-note driver — and stays tied to what's happening: it speeds up and brightens as the ball accelerates *or* as more balls crowd the field, and eases back down when things calm. Changing gear — a fireball, a multiball, a new arena, a rematch — rolls a different song, and a power-up's track hands back to the one it interrupted when it wears off.
- ♿ **Accessible** — fully keyboard-driven: arrow keys navigate every menu, dialog and the level grid (as a grid), Enter activates, and in-game arrows stay on the paddles. Visible focus, `prefers-reduced-motion` support, and a reduced-effects mode.

## Controls (defaults — rebind everything in Options)

| Action | Player 1 (orange) | Player 2 (blue) |
| --- | --- | --- |
| Move ← / → | A / D *(ZQSD on AZERTY)* | Arrow Left / Arrow Right |
| Launch ball | Space | Enter |
| Fire lasers | W | Arrow Up |
| Pause | Esc | Esc |

Binds are **physical** key positions, so the left-hand cluster is WASD on QWERTY and ZQSD on AZERTY with no configuration.

**Solo:** one player drives both portals using both key sets. **Two players, one computer:** split them — P1 left-hand keys, P2 arrows — or plug in **two gamepads** (pad 1 → orange, pad 2 → blue; analog stick or d-pad, **A** to serve, **Start** to pause). Versus → *"2 players, same computer"* starts a local duel.

Mouse moves the orange paddle. On touch screens, drag on the bottom or top half of the field to move that paddle.

**Controllers work everywhere** — d-pad or stick to move through menus, **A** to select, **B** to go back — so a couch session never needs the keyboard.

## Development

Vanilla ES modules, no framework. Source lives in [`/src`](src/); [Vite](https://vite.dev) bundles it into [`/docs`](docs/), the committed production build that GitHub Pages serves. Never edit `/docs` by hand.

```sh
npm install
npm run dev      # dev server with hot reload
npm run build    # rebuild /docs before committing
```

Architecture and module contracts are documented in [CONTRACT.md](CONTRACT.md).

| Module | Role |
| --- | --- |
| `js/engine.js` | Simulation, portal physics, canvas rendering, HUD |
| `js/levels.js` | 150 level definitions + brick types |
| `js/particles.js` | Particles, screen shake, portal FX |
| `js/audio.js` | Procedural WebAudio SFX + generative music |
| `js/input.js` | Keyboard/mouse/touch + rebinding |
| `js/net.js` | PeerJS multiplayer session + heartbeat |
| `js/ui.js` + `css/style.css` | Material-dark menus, level select, options |
| `js/main.js` | Bootstrap and wiring |

Multiplayer uses [PeerJS](https://peerjs.com) (vendored) with its free public broker for signaling; gameplay traffic is peer-to-peer.

### Multiplayer troubleshooting

"Could not connect / connection timed out" when joining almost always means WebRTC couldn't traverse one player's NAT (mobile networks, CGNAT, VPNs, strict firewalls). Direct and STUN-assisted connections work for most pairs, but the hard cases need a **TURN relay**, and the free public relays bundled as a fallback are best-effort at most.

- **Self-test:** open the game with `?relay=1` on both sides and try to join — if it fails, no working TURN relay is reachable and hard-NAT pairs won't connect either.
- **Reliable fix — self-hosted relay:** [`server/turn/`](server/turn/) ships a ready-to-run [coturn](https://github.com/coturn/coturn) + credentials-endpoint stack (podman-first, docker-compatible, plain `.env` configuration):

  ```sh
  cd server/turn
  ./start.sh        # creates .env, generates the secret, starts the stack
  ```

  The TURN shared secret never reaches players' browsers: the game fetches short-lived HMAC credentials (coturn REST-auth mode) from the `/ice` endpoint. Point the game at your deployment by setting `ICE_ENDPOINT` in [`src/js/constants.js`](src/js/constants.js) to your https `/ice` URL and rebuilding (`npm run build`) — or test first without a rebuild via `localStorage.setItem('pb.iceurl.v1', 'https://turn.example.com/ice')`.

  Verify the relay actually authenticates (a common failure is coturn silently ignoring an unreadable config and rejecting every allocation) — mint a credential and use it:

  ```sh
  curl -s https://turn.example.com/ice   # returns {username, credential, urls}
  # then, on the TURN host:
  turnutils_uclient -y -u <username> -w <credential> -p 3478 <public-ip>
  # a clean run reports "tot_send_msgs" climbing with 0 lost packets
  ```

  Quadlet-based deploys additionally ship in [`server/turn/quadlet/`](server/turn/quadlet/) (rootless `podman` user). Two gotchas that cause "connection timed out" for hard-NAT peers even when STUN works: coturn's config must be **world-readable** (`chmod 644` — the image drops privileges and can't read a `600` file), and set `relay-ip`/`listening-ip` to the **public IP** so it doesn't advertise private/VPN relay candidates.

  `.env` keys (all optional — `start.sh` fills the blanks):

  | Key | Default | Purpose |
  | --- | --- | --- |
  | `TURN_SECRET` | **auto-generated** | Shared secret between coturn and the credentials endpoint |
  | `TURN_HOST` | auto-detected public IP | Public IP or DNS name players reach the relay on |
  | `TURN_PORT` | `3478` | TURN listening port (open udp+tcp in the firewall) |
  | `TURN_MIN_PORT` / `TURN_MAX_PORT` | `49160` / `49200` | UDP relay range (open udp in the firewall) |
  | `TURN_REALM` | `portalbreakout` | TURN auth realm label |
  | `CREDS_BIND` / `CREDS_PORT` | `127.0.0.1` / `8788` | Credentials endpoint bind (reverse-proxy it over https) |
  | `CREDS_TTL_S` | `7200` | Lifetime of minted credentials, seconds |
  | `CORS_ORIGIN` | `https://lp177.github.io` | Allowed browser origins for `/ice` (comma list or `*`) |
  | `TURN_EXTERNAL_IP` / `TURN_INTERNAL_IP` | unset | Only for 1:1-NAT hosts (see compose file) |

- **Alternative without a server:** a free [metered.ca](https://www.metered.ca/stun-turn) account gives personal TURN credentials; both players register them in the browser console — no rebuild needed:

  ```js
  localStorage.setItem('pb.ice.v1', JSON.stringify([
    { urls: 'turn:turn.example.com:443', username: 'user', credential: 'pass' },
  ]));
  ```

  Custom servers are tried before the public defaults.
