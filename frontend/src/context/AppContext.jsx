import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/react";
import { useApi, WS_URL } from "@/lib/api";
import {
  SESSION_REPLACED_CLOSE,
  SESSION_REPLACED_CODE,
  SESSION_REPLACED_EVENT,
  notifySessionReplaced,
  resetSessionReplacedNotice,
} from "@/lib/sessionReplaced";

const Ctx = createContext(null);
export const useApp = () => useContext(Ctx);

export function AppProvider({ children }) {
  const { isSignedIn, getToken, signOut } = useAuth();
  const api = useApi();
  const [me, setMe] = useState(null);
  const [meError, setMeError] = useState(null);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef(null);
  const listeners = useRef(new Set());

  const refreshMe = useCallback(async () => {
    try {
      const { data } = await api.get("/me");
      setMe(data);
      setMeError(null);
      return data;
    } catch (e) {
      setMeError(e);
    }
  }, [api]);

  useEffect(() => {
    if (isSignedIn) refreshMe();
    else setMe(null);
  }, [isSignedIn, refreshMe]);

  useEffect(() => {
    if (isSignedIn) resetSessionReplacedNotice();
  }, [isSignedIn]);

  // A newer login on another device replaced this session: drop the socket and sign this browser out.
  useEffect(() => {
    const onReplaced = () => {
      const ws = wsRef.current;
      wsRef.current = null;
      setConnected(false);
      try { ws?.close(); } catch { /* already closed by the server */ }
      setMe(null);
      const toSignIn = () => { try { window.location.assign("/sign-in"); } catch { /* non-browser test env */ } };
      if (typeof signOut !== "function") return toSignIn();
      Promise.resolve()
        .then(() => signOut({ redirectUrl: "/sign-in" }))
        .catch(toSignIn);
    };
    window.addEventListener(SESSION_REPLACED_EVENT, onReplaced);
    return () => window.removeEventListener(SESSION_REPLACED_EVENT, onReplaced);
  }, [signOut]);

  const send = useCallback((msg) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(msg)); return true; } catch { return false; }
    }
    return false;
  }, []);

  const subscribe = useCallback((fn) => {
    listeners.current.add(fn);
    return () => listeners.current.delete(fn);
  }, []);

  useEffect(() => {
    if (!isSignedIn || !me?.username) return;
    let stop = false;
    let retry = 0;
    let timer = null;
    let tokenRequestInFlight = false;

    const isConnectingOrOpen = (ws) => ws && (
      ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN
    );

    const clearRetryTimer = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const scheduleReconnect = (delay) => {
      if (stop || timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        void connect();
      }, delay);
    };

    const connect = async () => {
      if (stop || tokenRequestInFlight) return;

      const current = wsRef.current;
      if (isConnectingOrOpen(current)) return;
      if (current) {
        wsRef.current = null;
        setConnected(false);
      }

      tokenRequestInFlight = true;
      let token;
      try { token = await getToken(); } catch { token = null; }
      tokenRequestInFlight = false;
      if (stop) return;
      if (!token) { scheduleReconnect(2000); return; }

      const active = wsRef.current;
      if (isConnectingOrOpen(active)) return;

      let ws;
      try {
        ws = new WebSocket(WS_URL);
      } catch {
        scheduleReconnect(Math.min(800 * 2 ** retry++, 8000));
        return;
      }
      wsRef.current = ws;
      ws.onopen = () => {
        if (stop || wsRef.current !== ws) return;
        try { ws.send(JSON.stringify({ type: "auth", token })); } catch { ws.close(); }
      };
      ws.onmessage = (e) => {
        if (stop || wsRef.current !== ws) return;
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }
        if (msg.type === SESSION_REPLACED_CODE) {
          stop = true;
          clearRetryTimer();
          setConnected(false);
          wsRef.current = null;
          try { ws.close(SESSION_REPLACED_CLOSE); } catch { /* the server closes it too */ }
          notifySessionReplaced(msg.message);
          return;
        }
        if (msg.type === "account_restricted") {
          clearRetryTimer();
          setConnected(false);
          wsRef.current = null;
          try { ws.close(4423); } catch { /* the server may already have closed the restricted socket */ }
          const expiresAt = typeof msg.expires_at === "string" ? Date.parse(msg.expires_at) : NaN;
          if (Number.isFinite(expiresAt)) {
            scheduleReconnect(Math.max(250, expiresAt - Date.now() + 250));
          } else {
            stop = true;
          }
        }
        if (msg.type === "hello") {
          retry = 0;
          setConnected(true);
        }
        // The server sends the new balance after every coin change (stake, payout, daily reward…).
        if (msg.type === "wallet" && Number.isFinite(msg.coins)) {
          setMe((current) => (current ? { ...current, coins: msg.coins } : current));
        }
        // Lifetime medals after a round award (computed and stored only by the server).
        if (msg.type === "medals" && Number.isFinite(msg.medals)) {
          setMe((current) => (current ? { ...current, medals: msg.medals } : current));
        }
        listeners.current.forEach((fn) => fn(msg));
      };
      ws.onclose = (event) => {
        if (wsRef.current !== ws) return;
        wsRef.current = null;
        setConnected(false);
        if (event?.code === SESSION_REPLACED_CLOSE) {
          // Never reconnect a replaced session; the newer login owns the account now.
          stop = true;
          clearRetryTimer();
          notifySessionReplaced();
          return;
        }
        scheduleReconnect(Math.min(800 * 2 ** retry++, 8000));
      };
    };

    void connect();
    const ping = setInterval(() => send({ type: "ping" }), 25000);
    const onOnline = () => {
      const ws = wsRef.current;
      if (isConnectingOrOpen(ws)) return;
      clearRetryTimer();
      retry = 0;
      void connect();
    };
    window.addEventListener("online", onOnline);
    return () => {
      stop = true;
      clearRetryTimer();
      clearInterval(ping);
      window.removeEventListener("online", onOnline);
      const ws = wsRef.current;
      wsRef.current = null;
      setConnected(false);
      ws?.close();
    };
  }, [isSignedIn, me?.username, getToken, send]);

  return (
    <Ctx.Provider value={{ me, meError, refreshMe, api, send, subscribe, connected }}>{children}</Ctx.Provider>
  );
}

export function useSocketEvent(handler) {
  const { subscribe } = useApp();
  const ref = useRef(handler);
  ref.current = handler;
  const listener = useRef(null);
  if (!listener.current) listener.current = (m) => ref.current(m);
  useEffect(() => subscribe(listener.current), [subscribe]);
}
