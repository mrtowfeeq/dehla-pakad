import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { useGameSync } from "@/hooks/useGameSync";
import { isGameSnapshot, mergeGameSnapshot } from "./gameSnapshot";

global.IS_REACT_ACT_ENVIRONMENT = true;

function snapshot({ status = "active", seq = 4, online = true, gameId = "game-1" } = {}) {
  return {
    type: "game_state",
    game_id: gameId,
    room_code: "ROOM1",
    status,
    players: [{ user_id: "player-1", seat: 0, online }],
    state: { seq, phase: status === "finished" ? "match_over" : "playing" },
  };
}

function SyncProbe({ gameId, connected, send }) {
  useGameSync(gameId, connected, send);
  return null;
}

test.each([
  ["active games", "active"],
  ["finished games", "finished"],
  ["cancellations missed while disconnected", "cancelled"],
])("reconnection requests the route game and accepts its %s snapshot", async (_label, status) => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const send = jest.fn(() => true);
  const render = async (connected) => act(async () => {
    root.render(<SyncProbe gameId="game-1" connected={connected} send={send} />);
  });

  try {
    await render(false);
    await render(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenLastCalledWith({ type: "sync_game", game_id: "game-1" });

    const recovered = snapshot({ status });
    expect(isGameSnapshot(recovered, "game-1")).toBe(true);
    expect(mergeGameSnapshot(null, recovered, { source: "websocket" }).status).toBe(status);

    await render(false);
    await render(true);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith({ type: "sync_game", game_id: "game-1" });
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

test("does not send duplicate syncs during the same authenticated connection", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const send = jest.fn(() => true);
  const render = async (gameId, connected) => act(async () => {
    root.render(<SyncProbe gameId={gameId} connected={connected} send={send} />);
  });

  try {
    await render("game-1", true);
    await render("game-1", true);
    expect(send).toHaveBeenCalledTimes(1);
    await render("game-2", true);
    expect(send).toHaveBeenLastCalledWith({ type: "sync_game", game_id: "game-2" });
    expect(send).toHaveBeenCalledTimes(2);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

test("equal-sequence WebSocket snapshots refresh player presence", () => {
  const offline = snapshot({ seq: 9, online: false });
  const online = snapshot({ seq: 9, online: true });
  expect(mergeGameSnapshot(offline, online, { source: "websocket" }).players[0].online).toBe(true);
});

test.each([
  ["missing state", { ...snapshot(), state: undefined }],
  ["missing sequence", { ...snapshot(), state: {} }],
  ["non-numeric sequence", { ...snapshot(), state: { seq: "4" } }],
  ["negative sequence", { ...snapshot(), state: { seq: -1 } }],
  ["missing players", { ...snapshot(), players: undefined }],
  ["wrong message type", { ...snapshot(), type: "error" }],
])("rejects a game snapshot with %s", (_label, value) => {
  expect(isGameSnapshot(value, "game-1")).toBe(false);
  const current = snapshot({ seq: 12 });
  expect(mergeGameSnapshot(current, value)).toBe(current);
});

test("an older snapshot cannot replace newer game state", () => {
  const current = snapshot({ seq: 13, online: true });
  const older = snapshot({ seq: 12, online: false });
  expect(mergeGameSnapshot(current, older)).toBe(current);
});

test("a late equal-sequence REST response cannot discard newer WebSocket presence", () => {
  const websocket = snapshot({ seq: 14, online: true });
  const staleRest = snapshot({ seq: 14, online: false });
  const merged = mergeGameSnapshot(websocket, staleRest, {
    source: "rest",
    requestWsRevision: 2,
    currentWsRevision: 3,
  });
  expect(merged).toBe(websocket);
  expect(merged.players[0].online).toBe(true);
});

test("a late REST response with an older sequence cannot replace WebSocket state", () => {
  const websocket = snapshot({ seq: 15, online: true });
  const staleRest = snapshot({ seq: 14, online: false });
  expect(mergeGameSnapshot(websocket, staleRest, { source: "rest" })).toBe(websocket);
});
