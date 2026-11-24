import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/react";
import { useApi, WS_URL } from "@/lib/api";

const Ctx = createContext(null);
export const useApp = () => useContext(Ctx);

export function AppProvider({ children }) {
  const { isSignedIn, getToken } = useAuth();
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

  const send = useCallback((msg) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === 1) { ws.send(JSON.stringify(msg)); return true; }
    return false;
  }, []);

  const subscribe = useCallback((fn) => {
    listeners.current.add(fn);
    return () => listeners.current.delete(fn);
  }, []);

  useEffect(() => {
    if (!isSignedIn || !me?.username) return;
    let stop = false, retry = 0, timer;
    const connect = async () => {
      let token;
      try { token = await getToken(); } catch { token = null; }
      if (stop) return;
      if (!token) { timer = setTimeout(connect, 2000); return; }
      const ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token)}`);
      wsRef.current = ws;
      ws.onopen = () => { retry = 0; setConnected(true); };
      ws.onmessage = (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }
        listeners.current.forEach((fn) => fn(msg));
      };
      ws.onclose = () => {
        setConnected(false);
        if (!stop) timer = setTimeout(connect, Math.min(800 * 2 ** retry++, 8000));
      };
    };
    connect();
    const ping = setInterval(() => send({ type: "ping" }), 25000);
    const onOnline = () => { if (wsRef.current?.readyState !== 1) { clearTimeout(timer); retry = 0; connect(); } };
    window.addEventListener("online", onOnline);
    return () => {
      stop = true;
      clearTimeout(timer);
      clearInterval(ping);
      window.removeEventListener("online", onOnline);
      wsRef.current?.close();
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
  useEffect(() => subscribe((m) => ref.current(m)), [subscribe]);
}
