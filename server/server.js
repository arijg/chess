/* server.js — WebSocket relay for online chess. Deliberately dumb: it pairs
   two players into a room keyed by game id, assigns each a seat (seat 1 is
   the host who chooses colour and time control, seat 2 is the guest), and
   forwards every other message to the other player verbatim. All game logic
   and move validation live in the browser (online-core.js), so this server
   never needs the chess engine and stays tiny.

   Run locally:  PORT=8421 node server/server.js
   Deploy:       see server/README.md (Render / Fly.io / Railway). */
'use strict';

const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8421;
const MAX_SEATS = 2;

// gameId -> Map<seat, ws>
const rooms = new Map();

function roomOf(id) {
  let r = rooms.get(id);
  if (!r) { r = new Map(); rooms.set(id, r); }
  return r;
}

function send(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function peers(room, exceptSeat) {
  const out = [];
  for (const [seat, ws] of room) if (seat !== exceptSeat) out.push(ws);
  return out;
}

const server = http.createServer((req, res) => {
  // A plain GET is handy as a health check for the host's uptime probe.
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('chess relay ok\n');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const gameId = (url.searchParams.get('game') || '').slice(0, 64);
  if (!gameId) { send(ws, { t: 'error', m: 'missing game id' }); ws.close(); return; }

  const room = roomOf(gameId);
  // Take the lowest free seat.
  let seat = null;
  for (let s = 1; s <= MAX_SEATS; s++) if (!room.has(s)) { seat = s; break; }
  if (seat === null) { send(ws, { t: 'full' }); ws.close(); return; }

  room.set(seat, ws);
  ws._gameId = gameId;
  ws._seat = seat;
  send(ws, { t: 'welcome', seat, peers: room.size - 1 });
  for (const p of peers(room, seat)) send(p, { t: 'peer-joined' });

  ws.on('message', data => {
    let msg;
    try { msg = JSON.parse(String(data)); } catch (_) { return; }
    if (msg && msg.t === 'relay') {
      for (const p of peers(room, seat)) send(p, { t: 'peer', d: msg.d });
    }
  });

  const leave = () => {
    if (room.get(seat) === ws) room.delete(seat);
    for (const p of peers(room, seat)) send(p, { t: 'peer-left' });
    if (room.size === 0) rooms.delete(gameId);
  };
  ws.on('close', leave);
  ws.on('error', leave);
});

server.listen(PORT, () => {
  console.log('chess relay listening on :' + PORT);
});
