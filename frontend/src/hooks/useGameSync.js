import { useEffect, useRef } from "react";

export function useGameSync(gameId, connected, send) {
  const wasConnected = useRef(false);
  const connectionEpoch = useRef(0);
  const lastSync = useRef(null);

  useEffect(() => {
    if (!connected) {
      wasConnected.current = false;
      return;
    }

    if (!wasConnected.current) {
      wasConnected.current = true;
      connectionEpoch.current += 1;
    }
    if (!gameId) return;

    const syncKey = `${connectionEpoch.current}:${gameId}`;
    if (lastSync.current === syncKey) return;
    lastSync.current = syncKey;
    if (!send({ type: "sync_game", game_id: gameId })) lastSync.current = null;
  }, [connected, gameId, send]);
}
