"""Shared first-message authentication helpers for local WebSocket clients."""

import json


async def authenticate_socket(ws, token):
    await ws.send(json.dumps({"type": "auth", "token": token}))
    return ws


async def connect_authenticated(url, token):
    import websockets

    return await authenticate_socket(await websockets.connect(url), token)
