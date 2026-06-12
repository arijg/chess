/* worker.js — Cloudflare Worker version of the chess relay.
   Same wire protocol as ../server.js, but built on a Durable Object so the
   two WebSockets of a game land in one place. Uses the WebSocket Hibernation
   API (acceptWebSocket / getWebSockets) so idle rooms cost nothing.

   Deploy: see server/cloudflare/README.md. */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Plain GET is a health check; only WebSocket upgrades become rooms.
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('chess relay ok\n', { status: 200 });
    }
    const gameId = (url.searchParams.get('game') || '').slice(0, 64);
    if (!gameId) return new Response('missing game id', { status: 400 });

    // Route every connection for this game id to the same Durable Object.
    const id = env.ROOMS.idFromName(gameId);
    return env.ROOMS.get(id).fetch(request);
  },
};

const MAX_SEATS = 2;

export class Room {
  constructor(state) {
    this.state = state;
  }

  async fetch() {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // Existing peers (before accepting this one) — used for seat assignment
    // and to notify the room that someone joined.
    const live = this.state.getWebSockets();
    const taken = new Set(
      live.map(w => (w.deserializeAttachment() || {}).seat).filter(Boolean)
    );
    let seat = null;
    for (let s = 1; s <= MAX_SEATS; s++) if (!taken.has(s)) { seat = s; break; }

    this.state.acceptWebSocket(server);

    if (seat === null) {
      server.send(JSON.stringify({ t: 'full' }));
      server.close(1000, 'full');
      return new Response(null, { status: 101, webSocket: client });
    }

    server.serializeAttachment({ seat });
    server.send(JSON.stringify({ t: 'welcome', seat, peers: taken.size }));
    for (const peer of live) {
      try { peer.send(JSON.stringify({ t: 'peer-joined' })); } catch (_) { /* */ }
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, message) {
    let msg;
    try { msg = JSON.parse(message); } catch (_) { return; }
    if (msg && msg.t === 'relay') {
      for (const peer of this.state.getWebSockets()) {
        if (peer !== ws) {
          try { peer.send(JSON.stringify({ t: 'peer', d: msg.d })); } catch (_) { /* */ }
        }
      }
    }
  }

  webSocketClose(ws) { this._left(ws); }
  webSocketError(ws) { this._left(ws); }

  _left(ws) {
    // Only seated players count as a departure; a rejected (full) socket doesn't.
    const att = ws.deserializeAttachment() || {};
    if (!att.seat) return;
    for (const peer of this.state.getWebSockets()) {
      if (peer !== ws) {
        try { peer.send(JSON.stringify({ t: 'peer-left' })); } catch (_) { /* */ }
      }
    }
  }
}
