# PortalBreakout

**Your paddles are portals.** A Breakout/Arkanoid-style arcade game with a twist: the ball never bounces off your paddle — it teleports out of the *other* paddle at the opposite edge of the field, keeping its momentum. A falling ball re-enters falling from the top; a rising ball re-enters rising from the bottom. Guard both edges, steer with portal english, and break every brick.

**▶ Play it: <https://lp177.github.io/PortalBreakout/>**

## Features

- 🌀 **Portal paddles** — one orange (bottom), one blue (top). Where the ball enters the paddle decides how its exit curves: edge hits add spin, and every teleport speeds the ball up.
- 🧱 **50 handcrafted levels** inspired by the most famous Breakout/Arkanoid layouts, plus Portal-flavored pixel art (the cake is real here).
- 🎮 **Solo** — control both paddles at once (fully rebindable keys, mouse, or split-screen touch), with an optional assist that mirrors the top paddle.
- 👥 **Play with a friend** — peer-to-peer via WebRTC: host a room, share a code or link, each player takes one portal. Disconnections pause the game and let you wait or continue solo.
- ⚔️ **Versus mode** — duel a friend online or the built-in AI (3 difficulties). One portal each, 3 lives each: miss a ball on your side, lose a life — last one standing wins. The ball speeds up over time, so no camping; bricks stay in play as the arena and cycle to the next map when cleared, and power-ups belong to whoever catches them.
- 💥 **Game juice everywhere** — particles, screen shake, portal flashes, combos, slow-mo finishes, and seven power-ups (multiball, lasers, fireball, sticky, expand, slow, extra life).
- 🔊 **Fully procedural audio** — every sound effect and both music loops are synthesized live with WebAudio. No assets, no downloads.
- ♿ **Accessible** — keyboard-first menus, visible focus, `prefers-reduced-motion` support, and a reduced-effects mode.

## Controls (defaults — rebind everything in Options)

| Action | Key |
| --- | --- |
| Bottom paddle ← / → | Arrow Left / Arrow Right |
| Top paddle ← / → | A / D |
| Launch ball | Space |
| Fire lasers (bottom / top) | Arrow Up / W |
| Pause | Esc |

Mouse moves the bottom paddle. On touch screens, drag on the bottom or top half of the field to move that paddle.

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
| `js/levels.js` | 50 level definitions + brick types |
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
- **Reliable fix:** provide your own TURN server (a small [coturn](https://github.com/coturn/coturn) instance, or a free [metered.ca](https://www.metered.ca/stun-turn) account) and register it in the browser console — no rebuild needed:

  ```js
  localStorage.setItem('pb.ice.v1', JSON.stringify([
    { urls: 'turn:turn.example.com:443', username: 'user', credential: 'pass' },
  ]));
  ```

  Both players should set it. Custom servers are tried before the public defaults.
