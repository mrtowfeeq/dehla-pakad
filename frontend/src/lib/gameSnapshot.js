export function isGameSnapshot(value, expectedGameId) {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && value.type === "game_state"
    && typeof value.game_id === "string"
    && (!expectedGameId || value.game_id === expectedGameId)
    && ["active", "finished", "cancelled"].includes(value.status)
    && typeof value.room_code === "string"
    && Array.isArray(value.players)
    && !!value.state && typeof value.state === "object" && !Array.isArray(value.state)
    && Number.isSafeInteger(value.state.seq) && value.state.seq >= 0;
}

export function mergeGameSnapshot(current, incoming, {
  source = "websocket",
  requestWsRevision = 0,
  currentWsRevision = requestWsRevision,
} = {}) {
  if (!isGameSnapshot(incoming)) return current;
  if (!isGameSnapshot(current) || current.game_id !== incoming.game_id) return incoming;

  const currentSeq = current.state.seq;
  const incomingSeq = incoming.state.seq;
  if (incomingSeq > currentSeq) return incoming;
  if (incomingSeq < currentSeq) return current;

  // A REST response can arrive after a more recent presence broadcast with the
  // same engine sequence. Preserve the WebSocket view in that case.
  if (source === "rest" && currentWsRevision > requestWsRevision) return current;
  return incoming;
}
