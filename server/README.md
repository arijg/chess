# Chess relay server

A tiny WebSocket relay that pairs two players into a room (keyed by the game
id in the share link) and forwards messages between them. It holds no game
state and never runs the chess engine — all rules, validation, and clocks
live in the browser (`online-core.js`), so this stays ~80 lines.

GitHub Pages can host the static site but **not** WebSockets, so the relay
runs as a separate small service. Any host that supports a long-lived Node
WebSocket process works; below are three free options.

## Run locally

```sh
cd server
npm install
PORT=8421 npm start
```

For local development without Node, `dev-server.py` speaks the identical
protocol (`pip install websockets && python3 server/dev-server.py`). The
client auto-targets `ws://localhost:8421` when the page is served from
localhost.

## Deploy

### Render (simplest)
1. Push this repo to GitHub.
2. New → **Web Service**, point it at the repo, set **Root Directory** to
   `server`.
3. Build command `npm install`, start command `npm start`. Render sets
   `PORT` automatically.
4. Copy the service URL (e.g. `https://chess-relay.onrender.com`).
   *Note: the free tier sleeps after ~15 min idle, so the first connection
   after a nap waits ~30–60 s for cold start.*

### Fly.io / Railway
Both run the same `npm start`. Fly: `fly launch` in `server/` (it detects
Node), no extra config needed for WebSockets. Railway: new project from repo,
root `server`.

## Point the client at your relay

In `../online.js`, set `PLACEHOLDER`'s replacement — the `RELAY_URL`
constant — to your deployed origin with the `wss://` scheme:

```js
const RELAY_URL = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
  ? 'ws://' + location.hostname + ':8421'
  : 'wss://chess-relay.onrender.com';   // <-- your relay
```

Use `wss://` (TLS), not `ws://` — the GitHub Pages site is HTTPS and browsers
block insecure WebSocket connections from secure pages.

## Protocol

Client connects to `wss://host/?game=<id>`.

| Server → client | meaning |
| --- | --- |
| `{t:'welcome', seat}` | seat 1 = host (picks colour/time), seat 2 = guest |
| `{t:'peer-joined'}` | the other player connected |
| `{t:'peer-left'}` | the other player disconnected |
| `{t:'full'}` | room already has two players |
| `{t:'peer', d}` | a payload relayed from the other player |

| Client → server | meaning |
| --- | --- |
| `{t:'relay', d}` | forward payload `d` to the other player |

Everything inside `d` (setup, move, resign, draw, rematch) is defined and
interpreted by `online.js`; the server never inspects it.
