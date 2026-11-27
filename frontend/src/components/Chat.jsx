import { useEffect, useRef, useState } from "react";
import { useApp, useSocketEvent } from "@/context/AppContext";
import { Send, MessageCircle } from "lucide-react";
import { toast } from "sonner";

export const REACTIONS = ["👏", "😂", "🔥", "😮", "😢", "🙏", "👍", "😎"];

export function ChatPanel({ roomCode, className = "", compact }) {
  const { api, send, me } = useApp();
  const [msgs, setMsgs] = useState([]);
  const [text, setText] = useState("");
  const endRef = useRef(null);

  useEffect(() => {
    api.get(`/rooms/${roomCode}/chat`).then((r) => setMsgs(r.data)).catch(() => {});
  }, [roomCode, api]);
  useSocketEvent((m) => {
    if (m.type === "chat" && m.message.room_code === roomCode) setMsgs((x) => [...x.slice(-80), m.message]);
  });
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [msgs]);

  const submit = (e) => {
    e.preventDefault();
    if (!text.trim()) return;
    send({ type: "chat", room_code: roomCode, text });
    setText("");
  };

  return (
    <div className={`flex flex-col min-h-0 ${className}`} data-testid="chat-panel">
      {!compact && <div className="eyebrow flex items-center gap-2 mb-2"><MessageCircle size={14} /> Table chat</div>}
      <div className="flex-1 min-h-0 overflow-y-auto space-y-1.5 pr-1 text-sm" data-testid="chat-messages">
        {msgs.length === 0 && <div className="text-muted-foreground text-xs py-4">No messages yet. Say hello!</div>}
        {msgs.map((m) => (
          <div key={m.id} className="leading-snug">
            <span className={`font-semibold ${m.user_id === me.user_id ? "text-primary" : ""}`}>{m.username}</span>{" "}
            <span className="text-foreground/85 break-words">{m.text}</span>
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <form onSubmit={submit} className="flex gap-2 mt-2">
        <input data-testid="table-chat-input" value={text} maxLength={300} onChange={(e) => setText(e.target.value)} placeholder="Message…"
          className="flex-1 min-w-0 rounded-lg bg-background/70 border border-input px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring" />
        <button data-testid="table-chat-send-btn" className="btn-gold !px-3 !py-2" aria-label="Send"><Send size={16} /></button>
      </form>
    </div>
  );
}

export function formatLobbyTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function mergeLobbyMessages(current, incoming) {
  const byId = new Map();
  [...current, ...incoming].forEach((message) => {
    if (message?.id) byId.set(message.id, message);
  });
  return [...byId.values()]
    .sort((a, b) => (Date.parse(a.ts) || 0) - (Date.parse(b.ts) || 0))
    .slice(-60);
}

export function PrivateLobbyChatPanel({ roomCode, className = "" }) {
  const { api, send, me, connected } = useApp();
  const [msgs, setMsgs] = useState([]);
  const [text, setText] = useState("");
  const endRef = useRef(null);
  const historyRoom = useRef(null);
  const loadedHistoryRoom = useRef(null);

  useEffect(() => {
    const roomChanged = historyRoom.current !== roomCode;
    if (!roomChanged && !connected && loadedHistoryRoom.current === roomCode) return;
    if (roomChanged) {
      setMsgs([]);
      historyRoom.current = roomCode;
    }
    let active = true;
    api.get(`/rooms/${encodeURIComponent(roomCode)}/lobby-chat`).then((r) => {
      if (active && Array.isArray(r.data)) {
        loadedHistoryRoom.current = roomCode;
        setMsgs((current) => mergeLobbyMessages(current, r.data));
      }
    }).catch(() => {});
    return () => { active = false; };
  }, [api, roomCode, connected]);

  useSocketEvent((m) => {
    if (m.type === "private_lobby_chat_message" && m.message?.room_code === roomCode
      && m.message.channel === "private_lobby") {
      setMsgs((current) => mergeLobbyMessages(current, [m.message]));
    } else if (m.type === "private_lobby_chat_error") {
      toast.error(m.message);
    }
  });
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [msgs]);

  const submit = (e) => {
    e?.preventDefault();
    const message = text.trim();
    if (!message) return;
    if (!send({ type: "private_lobby_chat", room_code: roomCode, text: message })) {
      toast.error("Reconnecting… try again in a moment");
      return;
    }
    setText("");
  };

  return (
    <div className={`flex flex-col min-h-0 w-full ${className}`} data-testid="private-lobby-chat-panel">
      <div className="eyebrow flex items-center gap-2 mb-2"><MessageCircle size={14} /> Private room chat</div>
      <div className="flex-1 min-h-0 overflow-y-auto space-y-2 pr-1 text-sm" data-testid="private-lobby-chat-messages" aria-live="polite">
        {msgs.length === 0 && <div className="text-muted-foreground text-xs py-4">No messages yet. Say hello!</div>}
        {msgs.map((m) => (
          <div key={m.id} className="leading-snug break-words">
            <div className="flex items-baseline gap-2 min-w-0">
              <span className={`font-semibold truncate ${m.user_id === me?.user_id ? "text-primary" : ""}`}>{m.username}</span>
              <time className="shrink-0 text-[10px] text-muted-foreground" dateTime={m.ts}>{formatLobbyTimestamp(m.ts)}</time>
            </div>
            <p className="text-foreground/85 whitespace-pre-wrap break-words">{m.text}</p>
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <form onSubmit={submit} className="flex items-end gap-2 mt-2">
        <textarea data-testid="private-lobby-chat-input" value={text} maxLength={300} rows={2}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) submit(e); }}
          placeholder="Message…" aria-label="Private room message"
          className="flex-1 min-w-0 resize-none rounded-lg bg-background/70 border border-input px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring" />
        <button type="submit" data-testid="private-lobby-chat-send-btn" className="btn-gold !px-3 !py-2"
          aria-label="Send private room message"><Send size={16} /></button>
      </form>
    </div>
  );
}

export function ReactionBar({ roomCode }) {
  const { send } = useApp();
  return (
    <div className="flex flex-wrap gap-1" data-testid="reaction-bar">
      {REACTIONS.map((e, i) => (
        <button key={e} data-testid={`reaction-btn-${i}`} onClick={() => send({ type: "reaction", room_code: roomCode, emoji: e })}
          className="h-9 w-9 rounded-full hover:bg-white/10 active:scale-90 transition-transform text-lg">{e}</button>
      ))}
    </div>
  );
}
