"""dev-server.py — local-only WebSocket relay that speaks the exact same
wire protocol as server.js, so the real client can be tested over a real
WebSocket without Node installed. NOT for production — use server.js there.

Run: python3 server/dev-server.py   (listens on ws://localhost:8421)
"""
import asyncio
import json
from urllib.parse import urlparse, parse_qs

try:
    import websockets
except ImportError:
    raise SystemExit("pip install websockets")

MAX_SEATS = 2
rooms = {}  # game_id -> { seat: websocket }


async def send(ws, obj):
    try:
        await ws.send(json.dumps(obj))
    except Exception:
        pass


def peers(room, except_seat):
    return [w for s, w in room.items() if s != except_seat]


async def handler(ws, path=None):
    if path is None:
        # websockets >=13 exposes the path on ws.request.path; older on ws.path.
        req = getattr(ws, "request", None)
        path = getattr(req, "path", None) or getattr(ws, "path", "")
    qs = parse_qs(urlparse(path).query)
    game_id = (qs.get("game", [""])[0])[:64]
    if not game_id:
        await send(ws, {"t": "error", "m": "missing game id"})
        return

    room = rooms.setdefault(game_id, {})
    seat = next((s for s in range(1, MAX_SEATS + 1) if s not in room), None)
    if seat is None:
        await send(ws, {"t": "full"})
        return

    room[seat] = ws
    await send(ws, {"t": "welcome", "seat": seat, "peers": len(room) - 1})
    for p in peers(room, seat):
        await send(p, {"t": "peer-joined"})

    try:
        async for data in ws:
            try:
                msg = json.loads(data)
            except ValueError:
                continue
            if isinstance(msg, dict) and msg.get("t") == "relay":
                for p in peers(room, seat):
                    await send(p, {"t": "peer", "d": msg.get("d")})
    finally:
        if room.get(seat) is ws:
            del room[seat]
        for p in peers(room, seat):
            await send(p, {"t": "peer-left"})
        if not room:
            rooms.pop(game_id, None)


async def main():
    async with websockets.serve(handler, "localhost", 8421):
        print("dev chess relay on ws://localhost:8421")
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
