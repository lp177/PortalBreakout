# PortalBreakout

**Your paddles are portals.** A Breakout/Arkanoid-style arcade game with a twist: the ball never bounces off your paddle — it teleports out of the *other* paddle at the opposite edge of the field, keeping its momentum. A falling ball re-enters falling from the top; a rising ball re-enters rising from the bottom. Guard both edges, steer with portal english, and break every brick.

**▶ Play it: <https://lp177.github.io/PortalBreakout/>**

## Features

- 🌀 **Portal paddles** — one orange (bottom), one blue (top). Where the ball enters the paddle decides how its exit curves: edge hits add spin, and every teleport speeds the ball up.
- 🧱 **50 handcrafted levels** inspired by the most famous Breakout/Arkanoid layouts, plus Portal-flavored pixel art (the cake is real here).
- 🎮 **Solo** — control both paddles at once (fully rebindable keys, mouse, or split-screen touch), with an optional assist that mirrors the top paddle.
- 👥 **Play with a friend** — peer-to-peer via WebRTC: host a room, share a code or link, each player takes one portal. Disconnections pause the game and let you wait or continue solo.
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

No build step. The whole game is static vanilla ES modules in [`/docs`](docs/), served by GitHub Pages.

```sh
python3 -m http.server 8000 --directory docs
# open http://localhost:8000
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
