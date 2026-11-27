import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { ArrowLeftRight, Bot, Check, Coins, Copy, Crown, Eye, Globe2, LockKeyhole, LogOut, Medal, MessageCircle, Play, Settings2, Shuffle, Target, Timer, UserPlus, X } from "lucide-react";
import { CoinIcon, formatCoins } from "@/components/coins/Coins";
import { PotCollect } from "@/components/coins/PotCollect";
import { useApp, useSocketEvent } from "@/context/AppContext";
import { errMsg, TEAM_NAME } from "@/lib/api";
import { PlayerAvatar } from "@/components/PlayerAvatar";
import { TargetPicker } from "@/components/TargetPicker";
import { ChatPanel, PrivateLobbyChatPanel } from "@/components/Chat";
import { VoicePanel } from "@/components/voice/VoicePanel";
import { sound } from "@/lib/sound";

const POS = ["bottom-0 left-1/2 -translate-x-1/2", "right-0 top-1/2 -translate-y-1/2", "top-0 left-1/2 -translate-x-1/2", "left-0 top-1/2 -translate-y-1/2"];
const TURN_DURATIONS = [15, 20, 30, 45, 60];

const TEAM_TONE = [
  { band: "from-sky-400/80 to-sky-600/60", border: "border-sky-300/40", text: "text-sky-200", chip: "bg-sky-400/15 text-sky-200 border-sky-300/30" },
  { band: "from-amber-400/80 to-amber-600/60", border: "border-amber-300/40", text: "text-amber-200", chip: "bg-amber-400/15 text-amber-200 border-amber-300/30" },
];

function SeatSlot({ room, seat, selected, onClick, canEdit, onRemoveBot, isMe, onToggleReady }) {
  const p = room.seats[seat];
  const team = seat % 2;
  const tone = TEAM_TONE[team];
  const ready = p && room.ready[p.user_id];
  return (
    <div className={`absolute ${POS[seat]} w-[6.25rem] transition-transform sm:w-36 ${selected ? "z-20 scale-105" : canEdit ? "hover:scale-105" : ""}`}>
      <button type="button" onClick={onClick} disabled={!canEdit} data-testid={`lobby-seat-${seat}`}
        aria-label={`${canEdit ? "Select" : "View"} ${p?.username || `seat ${seat + 1}`}`}
        className={`absolute inset-0 overflow-hidden rounded-2xl border-2 bg-gradient-to-b from-[#16213a]/95 to-[#0b1222]/95 shadow-[0_14px_30px_-14px_rgba(0,0,0,.95)] backdrop-blur ${selected ? "border-amber-300 shadow-[0_0_0_3px_rgba(251,191,36,.25),0_14px_30px_-14px_rgba(0,0,0,.95)]" : ready ? "border-emerald-400/60" : p ? tone.border : "border-dashed border-white/20"} ${canEdit ? "cursor-pointer" : "cursor-default"}`}>
        <span className={`absolute inset-x-0 top-0 h-1 bg-gradient-to-r ${tone.band}`} aria-hidden="true" />
        <span className="sr-only">{canEdit ? `Select seat ${seat + 1}` : `Seat ${seat + 1}`}</span>
      </button>
      <div className="pointer-events-none relative z-10 w-full px-2 pb-2.5 pt-3 text-center">
        <div className={`text-[9px] font-bold uppercase tracking-widest sm:text-[10px] ${tone.text}`}>
          <span className="sm:hidden">{TEAM_NAME[team].replace(/^Team\s+/i, "")} · Seat {seat + 1}</span>
          <span className="hidden sm:inline">{TEAM_NAME[team]} · Seat {seat + 1}</span>
        </div>
        {p ? (
          <div className="mt-2 flex flex-col items-center gap-1">
            <div className={`rounded-full p-0.5 ${room.host_id === p.user_id ? "bg-gradient-to-br from-amber-200 via-amber-400 to-amber-700" : ready ? "bg-emerald-400/70" : "bg-white/15"}`}>
              {p.is_bot ? <PlayerAvatar user={p} size={40} online={p.online} />
                : <Link to={`/profile/${encodeURIComponent(p.username)}`} className="pointer-events-auto block rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  aria-label={`View ${p.display_name || p.username}'s profile`} data-testid={`lobby-profile-link-${seat}`}><PlayerAvatar user={p} size={40} online={p.online} /></Link>}
            </div>
            <div className="flex max-w-full items-center gap-1 truncate text-sm font-semibold text-white">
              {room.host_id === p.user_id && <Crown size={12} className="shrink-0 text-amber-300" aria-label="Host" />}
              {p.is_bot ? p.username : <Link to={`/profile/${encodeURIComponent(p.username)}`} className="pointer-events-auto truncate hover:text-amber-200" data-testid={`lobby-username-link-${seat}`}>{p.display_name || p.username}</Link>}
            </div>
            {/* Lifetime medals for humans (public total); bots never earn medals and show their tag here instead. */}
            {!p.is_bot && (
              <span className="inline-flex items-center gap-1 rounded-full border border-orange-300/30 bg-orange-300/10 px-1.5 py-px font-mono text-[10px] font-bold text-orange-200"
                title="Lifetime medals" data-testid={`lobby-seat-${seat}-medals`}>
                <Medal size={10} aria-hidden="true" />{Number(p.medals || 0).toLocaleString("en-IN")}
              </span>
            )}
            {p.is_bot && (
              <span className="pointer-events-auto inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/5 px-1.5 py-px text-[10px] font-bold text-white/55">
                <Bot size={11} /> BOT
                {canEdit && (
                  <span role="button" tabIndex={0} aria-label="Remove bot" data-testid={`remove-bot-${seat}`}
                    onClick={(e) => { e.stopPropagation(); onRemoveBot(p.user_id); }}
                    className="ml-0.5 inline-flex h-4 w-4 items-center justify-center rounded-full bg-rose-500/80 text-white hover:bg-rose-500"><X size={10} /></span>
                )}
              </span>
            )}
          </div>
        ) : (
          <div className="flex flex-col items-center gap-1.5 py-3 text-xs text-white/40">
            <span className="flex h-10 w-10 items-center justify-center rounded-full border-2 border-dashed border-white/20"><UserPlus size={15} aria-hidden="true" /></span>
            Empty seat
          </div>
        )}
        {p && isMe ? (
          <button type="button" onClick={(e) => { e.stopPropagation(); onToggleReady(); }} data-testid="ready-toggle-btn"
            aria-pressed={!!ready} title={ready ? "Tap to mark yourself not ready" : "Tap when you're ready to play"}
            className={`pointer-events-auto absolute -left-3 -top-3.5 z-20 inline-flex items-center gap-1 whitespace-nowrap rounded-full border-2 px-2.5 py-1 text-[10px] font-black uppercase tracking-wider shadow-[0_6px_14px_-4px_rgba(0,0,0,.9)] transition-transform hover:scale-105 active:scale-95 ${ready
              ? "border-emerald-200/70 bg-emerald-500 text-white"
              : "animate-pulse border-amber-100/80 bg-gradient-to-br from-amber-200 to-amber-500 text-slate-950 hover:animate-none"}`}>
            <span data-testid={`lobby-seat-${seat}-ready`} className="inline-flex items-center gap-1">
              {ready ? <><Check size={11} strokeWidth={3} aria-hidden="true" />READY</> : <><Check size={11} strokeWidth={3} aria-hidden="true" />I'm ready</>}
            </span>
          </button>
        ) : p && (
          <div className={`pointer-events-none absolute -left-2 -top-2.5 inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[9px] font-black uppercase tracking-wider shadow-[0_4px_10px_-2px_rgba(0,0,0,.8)] ${ready ? "border-emerald-200/60 bg-emerald-500 text-white" : "border-white/20 bg-[#1f2937] text-white/60"}`}
            data-testid={`lobby-seat-${seat}-ready`}>
            {ready ? <><Check size={10} strokeWidth={3} aria-hidden="true" />READY</> : "Not ready"}
          </div>
        )}
        {room.dealer_seat === seat && <div className="pointer-events-none absolute -right-2 -top-2 flex h-7 w-7 items-center justify-center rounded-full border-2 border-amber-100/70 bg-gradient-to-br from-amber-200 to-amber-500 text-[11px] font-black text-slate-950 shadow-[0_4px_10px_-2px_rgba(0,0,0,.8)]" data-testid="dealer-chip" title="Dealer">D</div>}
      </div>
    </div>
  );
}

function Panel({ icon: Icon, title, tone = "bg-amber-300/15 text-amber-200", children, className = "", testid }) {
  return (
    <section className={`rounded-3xl border border-white/10 bg-gradient-to-b from-white/[0.05] to-white/[0.01] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,.05)] ${className}`} data-testid={testid}>
      {title && (
        <div className="mb-4 flex items-center gap-2.5">
          <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${tone}`} aria-hidden="true"><Icon size={15} /></span>
          <h2 className="font-display text-lg text-amber-50">{title}</h2>
        </div>
      )}
      {children}
    </section>
  );
}

function InfoRow({ icon: Icon, label, children, testid }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-sm">
      <span className="inline-flex items-center gap-2 text-white/55"><Icon size={14} className="text-amber-200/80" aria-hidden="true" />{label}</span>
      <b className="truncate text-right text-white" data-testid={testid}>{children}</b>
    </div>
  );
}

// Collapsible table chat: a round icon on the table's right edge opens a chat window over the table.
// The chat stays mounted while closed so history and live messages keep arriving; an unread badge counts
// messages from other players received while it is closed.
export function ChatDock({ room, meId }) {
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const boxRef = useRef(null);
  const openRef = useRef(open);
  openRef.current = open;

  useSocketEvent((m) => {
    const msg = m.message;
    const mine = room.is_public
      ? m.type === "chat" && msg?.room_code === room.code
      : m.type === "private_lobby_chat_message" && msg?.room_code === room.code && msg.channel === "private_lobby";
    if (mine && !openRef.current && msg.user_id !== meId) setUnread((n) => n + 1);
  });

  useEffect(() => {
    if (!open) return undefined;
    setUnread(0);
    const list = boxRef.current?.querySelector('[data-testid="chat-messages"], [data-testid="private-lobby-chat-messages"]');
    if (list) list.scrollTop = list.scrollHeight;
    boxRef.current?.querySelector("textarea, input")?.focus({ preventScroll: true });
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <div ref={boxRef} id="lobby-chat-window" role="dialog" aria-label="Table chat" hidden={!open} data-testid="lobby-chat-window"
        className={`absolute bottom-20 right-3 z-30 ${open ? "flex" : "hidden"} h-[22rem] max-h-[70%] w-[min(22rem,calc(100%-1.5rem))] flex-col overflow-hidden rounded-2xl border border-amber-300/30 bg-[#0b1222]/95 p-3 shadow-[0_24px_50px_-16px_rgba(0,0,0,.95)] backdrop-blur-md sm:bottom-24 sm:right-6`}>
        <button type="button" onClick={() => setOpen(false)} aria-label="Close chat" data-testid="lobby-chat-close"
          className="absolute right-2 top-2 z-10 flex h-7 w-7 items-center justify-center rounded-full text-white/55 hover:bg-white/10 hover:text-white"><X size={15} /></button>
        {room.is_public
          ? <ChatPanel roomCode={room.code} className="flex-1" />
          : <PrivateLobbyChatPanel roomCode={room.code} className="flex-1" />}
      </div>
      <button type="button" onClick={() => setOpen((v) => !v)} data-testid="lobby-chat-toggle"
        aria-expanded={open} aria-controls="lobby-chat-window" aria-label={open ? "Close chat" : unread ? `Open chat, ${unread} unread` : "Open chat"}
        className={`absolute bottom-3 right-3 z-30 flex h-14 w-14 items-center justify-center rounded-full border-2 shadow-[0_10px_24px_-8px_rgba(0,0,0,.95)] transition-transform hover:scale-105 active:scale-95 sm:bottom-6 sm:right-6 ${open
          ? "border-amber-100/70 bg-gradient-to-br from-amber-200 to-amber-500 text-slate-950"
          : "border-amber-300/50 bg-gradient-to-br from-[#1b2a4a] to-[#0a1120] text-amber-200"}`}>
        {open ? <X size={22} /> : <MessageCircle size={24} />}
        {!open && unread > 0 && (
          <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full border-2 border-[#0a1120] bg-rose-500 px-1 text-[10px] font-black text-white" data-testid="lobby-chat-unread">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>
    </>
  );
}

function InviteFriends({ code }) {
  const { api } = useApp();
  const [friends, setFriends] = useState([]);
  useEffect(() => { api.get("/friends").then((r) => setFriends(r.data)).catch(() => {}); }, [api]);
  const invite = async (f) => {
    try { await api.post(`/rooms/${code}/invite`, { user_id: f.user_id }); toast.success(`Invited ${f.username}`); } catch (e) { toast.error(errMsg(e)); }
  };
  if (!friends.length) return <p className="text-xs text-white/45">Add friends to invite them directly.</p>;
  const sorted = [...friends].sort((a, b) => Number(!!b.online) - Number(!!a.online));
  return (
    <div className="max-h-48 space-y-1.5 overflow-y-auto pr-1">
      {sorted.map((f) => (
        <div key={f.user_id} className="flex items-center gap-2.5 rounded-xl border border-white/5 bg-black/20 px-2.5 py-2 text-sm">
          <PlayerAvatar user={f} size={28} online={f.online} />
          <div className="min-w-0 flex-1">
            <div className="truncate font-semibold text-white">{f.username}</div>
            <div className={`text-[10px] ${f.online ? "text-emerald-300" : "text-white/40"}`}>{f.online ? "Online" : "Offline"}</div>
          </div>
          <button className="inline-flex items-center gap-1 rounded-lg border border-amber-300/40 bg-amber-300/10 px-2.5 py-1 text-xs font-semibold text-amber-200 hover:bg-amber-300/20" onClick={() => invite(f)} data-testid={`invite-friend-${f.username}`}><UserPlus size={13} /> Invite</button>
        </div>
      ))}
    </div>
  );
}

export default function Lobby() {
  const { code } = useParams();
  const { api, me } = useApp();
  const navigate = useNavigate();
  const [room, setRoom] = useState(null);
  const [sel, setSel] = useState(null);
  const [countdown, setCountdown] = useState(null);
  const prevRoom = useRef(null);
  const tableRef = useRef(null);
  useEffect(() => {
    const p = prevRoom.current;
    prevRoom.current = room;
    if (!p || !room) return;
    const seated = (r) => r.seats.filter(Boolean).length;
    const readyN = (r) => r.seats.filter((x) => x && r.ready[x.user_id]).length;
    if (seated(room) > seated(p)) sound.play("join");
    else if (seated(room) < seated(p)) sound.play("leave");
    if (readyN(room) > readyN(p)) sound.play("ready");
  }, [room]);
  const startCountdown = (gid) => {
    if (countdown !== null) return;
    let n = 3;
    setCountdown(n);
    sound.play("match_start");
    // At a stake table the entries are collected on the lobby table itself, so bring it into view.
    if (room?.stake) tableRef.current?.scrollIntoView?.({ behavior: "smooth", block: "center" });
    const t = setInterval(() => {
      n -= 1;
      if (n <= 0) { clearInterval(t); navigate(`/game/${gid}`); return; }
      setCountdown(n);
      sound.play("tick");
    }, 800);
  };

  const load = useCallback(() => api.get(`/rooms/${code}`).then((r) => setRoom(r.data)).catch((e) => { toast.error(errMsg(e)); navigate("/home"); }), [api, code, navigate]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (room?.status === "playing" && room.game_id && countdown === null) navigate(`/game/${room.game_id}`); }, [room, navigate]); // eslint-disable-line react-hooks/exhaustive-deps
  useSocketEvent((m) => {
    if (m.type === "room_update" && m.room.code === code && m.room.status !== "playing") setRoom(m.room);
    if (m.type === "game_started" && m.room_code === code) startCountdown(m.game_id);
    if (m.type === "requeued" && m.code === code) { toast("A player left — you're back at the front of the queue."); navigate("/play"); }
    if (m.type === "room_left" && m.code === code) navigate(room?.is_public ? "/play" : "/home");
  });

  // Stake tables the host can pick for a private room (with level locks), from the wallet.
  const [tiers, setTiers] = useState([]);
  const hostsPrivate = !!room && !room.is_public && room.host_id === me.user_id;
  useEffect(() => {
    if (!hostsPrivate) return;
    api.get("/wallet").then((r) => setTiers(Array.isArray(r.data?.tiers) ? r.data.tiers : [])).catch(() => {});
  }, [api, hostsPrivate]);

  if (!room) return <div className="text-muted-foreground" data-testid="lobby-loading">Loading lobby…</div>;
  const isHost = !room.is_public && room.host_id === me.user_id;
  const myReady = !!room.ready[me.user_id];
  const full = room.seats.every(Boolean);
  const allReady = full && room.seats.every((p) => room.ready[p.user_id]);
  const call = async (fn) => { try { const r = await fn(); if (r?.data?.code) setRoom(r.data); } catch (e) { toast.error(errMsg(e)); } };

  const clickSeat = (seat) => {
    if (!isHost) return;
    if (sel === null) return setSel(seat);
    if (sel !== seat) {
      const ids = room.seats.map((p) => p?.user_id || null);
      [ids[sel], ids[seat]] = [ids[seat], ids[sel]];
      call(() => api.post(`/rooms/${code}/seats`, { seats: ids }));
    }
    setSel(null);
  };
  const shuffleTeams = () => {
    const ids = room.seats.map((p) => p?.user_id || null);
    for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
    call(() => api.post(`/rooms/${code}/seats`, { seats: ids }));
  };
  const leave = async () => { await call(() => api.post(`/rooms/${code}/leave`)); navigate("/home"); };

  const mySeated = room.seats.some((p) => p?.user_id === me.user_id);
  const toggleReady = () => call(() => api.post(`/rooms/${code}/ready`, { ready: !myReady }));
  const seatedCount = room.seats.filter(Boolean).length;
  const readyCount = room.seats.filter((p) => p && room.ready[p.user_id]).length;
  const emptyCount = 4 - seatedCount;
  const dealerName = room.seats[room.dealer_seat]?.username || `Seat ${room.dealer_seat + 1}`;
  const status = !full ? `Waiting for ${emptyCount} more player${emptyCount === 1 ? "" : "s"}`
    : allReady ? (isHost ? "Everyone is ready — start the game" : room.is_public ? "Everyone is ready — dealing soon" : "Everyone is ready — waiting for the host")
      : `${readyCount}/4 players ready`;

  return (
    <div className="space-y-6" data-testid="lobby-page">
      {countdown !== null && room.stake && (
        <div className="pointer-events-none fixed inset-x-0 top-3 z-50 flex justify-center px-4" data-testid="match-start-countdown">
          <div className="flex items-center gap-3 rounded-full border border-amber-300/50 bg-[#0a1120]/90 py-1.5 pl-4 pr-1.5 text-white shadow-[0_14px_34px_-12px_rgba(0,0,0,.95)] backdrop-blur">
            <span className="text-xs font-semibold uppercase tracking-wider text-amber-100/80">Collecting entries · match starting</span>
            <span key={countdown} className="rise flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-amber-200 to-amber-500 font-display text-xl font-bold text-slate-950">{countdown}</span>
          </div>
        </div>
      )}
      {countdown !== null && !room.stake && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/75 text-white backdrop-blur-sm" data-testid="match-start-countdown">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_50%,rgba(251,191,36,.18),transparent_45%)]" aria-hidden="true" />
          <div className="eyebrow !text-amber-200/80">Match starting</div>
          <div key={countdown} className="rise mt-2 flex h-40 w-40 items-center justify-center rounded-full border-4 border-amber-300/60 bg-gradient-to-br from-[#1b2a4a] to-[#0a1120] font-display text-8xl text-amber-300 shadow-[0_0_60px_-10px_rgba(251,191,36,.6)]">{countdown}</div>
          <div className="mt-4 text-sm text-white/60">Shuffling the deck…</div>
        </div>
      )}

      <section className="relative overflow-hidden rounded-3xl border border-amber-300/25 bg-gradient-to-br from-[#1b2a4a] via-[#111a30] to-[#0a1120] p-5 shadow-[0_24px_60px_-30px_rgba(0,0,0,.95)] sm:p-7">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_20%_0%,rgba(251,191,36,.16),transparent_55%)]" aria-hidden="true" />
        <div className="relative flex flex-wrap items-center gap-4">
          <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-200 to-amber-500 text-slate-950 shadow-[inset_0_2px_0_rgba(255,255,255,.4),0_10px_22px_-10px_rgba(0,0,0,.9)]" aria-hidden="true">
            {room.is_public ? <Globe2 size={26} /> : <LockKeyhole size={24} />}
          </span>
          <div className="min-w-0 flex-1">
            <p className="eyebrow !text-amber-200/70">{room.is_public ? "Public match lobby" : "Private room"}</p>
            <h1 className="break-words font-display text-3xl text-amber-50 sm:text-4xl">Table lobby</h1>
            <p className="mt-1 text-xs text-white/55" data-testid="lobby-status">{status}</p>
            {room.stake && (
              <p className="mt-2 inline-flex max-w-full items-center gap-2 rounded-2xl border border-amber-300/40 bg-amber-300/10 px-2.5 py-1.5 text-xs text-amber-100" data-testid="lobby-stake">
                <CoinIcon size={16} className="shrink-0" />
                <span className="min-w-0 leading-snug">
                  <span className="font-semibold">{room.stake.name}</span>
                  <span className="text-amber-100/75"> · {formatCoins(room.stake.entry)} entry · winners get {formatCoins(room.stake.payout)} each</span>
                </span>
              </p>
            )}
          </div>
          {!room.is_public && (
            <button data-testid="copy-invite-code-btn"
              className="group flex basis-full items-center justify-between gap-3 rounded-2xl border border-dashed border-amber-300/50 bg-black/30 px-4 py-2.5 text-left transition-colors hover:border-amber-300 hover:bg-amber-300/10 sm:basis-auto"
              onClick={() => { navigator.clipboard?.writeText(room.code); toast.success("Invite code copied"); }}>
              <span>
                <span className="block text-[10px] uppercase tracking-wider text-amber-200/70">Invite code</span>
                <span className="font-mono text-2xl font-bold tracking-[0.3em] text-amber-200" data-testid="room-invite-code">{room.code}</span>
              </span>
              <Copy size={18} className="text-amber-200/70 group-hover:text-amber-200" aria-label="Copy" />
            </button>
          )}
        </div>
        <div className="relative mt-5 grid grid-cols-3 gap-2 sm:max-w-md">
          {[["Seated", `${seatedCount}/4`, "text-sky-200"], ["Ready", `${readyCount}/4`, "text-emerald-300"], ["Target", room.target, "text-amber-200"]].map(([label, value, tone]) => (
            <div key={label} className="rounded-2xl border border-white/10 bg-black/30 px-2 py-2 text-center">
              <div className={`font-mono text-xl font-bold leading-none ${tone}`}>{value}</div>
              <div className="mt-1 text-[10px] uppercase tracking-wider text-white/50">{label}</div>
            </div>
          ))}
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-4">
          <div className="relative rounded-3xl border border-white/10 bg-gradient-to-b from-white/[0.04] to-transparent p-3 pb-16 sm:p-6 sm:pb-6">
            {isHost && <p className="mb-2 flex items-start gap-2 rounded-xl border border-amber-300/20 bg-amber-300/[0.06] px-3 py-2 text-xs text-amber-100/80"><ArrowLeftRight size={14} className="mt-0.5 shrink-0 text-amber-300" aria-hidden="true" />Tap two seats to swap them. Seats 1 & 3 are Team A, seats 2 & 4 are Team B — partners sit opposite.</p>}
            <div ref={tableRef} className="relative mx-auto aspect-[4/5] w-full max-w-[480px] sm:aspect-square">
              <div className="absolute inset-[17%] rounded-full bg-gradient-to-br from-[#6b3f1d] via-[#4a2a12] to-[#2a170a] p-2.5 shadow-[0_30px_60px_-20px_rgba(0,0,0,.95),inset_0_2px_0_rgba(255,255,255,.12)]">
                <div className="felt grain flex h-full w-full items-center justify-center rounded-full border-2 border-amber-500/30 shadow-[inset_0_10px_30px_rgba(0,0,0,.55)]">
                  <div className="text-center">
                    <div className="text-[9px] uppercase tracking-[0.2em] text-amber-100/60">First to</div>
                    <div className="font-display text-4xl font-bold leading-none text-amber-300 drop-shadow-[0_2px_6px_rgba(0,0,0,.6)]" data-testid="lobby-target">{room.target}</div>
                    <div className="text-[10px] uppercase tracking-widest text-amber-100/70">points to win</div>
                  </div>
                </div>
              </div>
              {[0, 1, 2, 3].map((s) => <SeatSlot key={s} room={room} seat={s} selected={sel === s} canEdit={isHost} onClick={() => clickSeat(s)}
                onRemoveBot={(id) => call(() => api.delete(`/rooms/${code}/bots/${id}`))}
                isMe={room.seats[s]?.user_id === me.user_id} onToggleReady={toggleReady} />)}
              {countdown !== null && room.stake && (
                <PotCollect boxRef={tableRef} seats={room.seats} entry={room.stake.entry} payout={room.stake.payout} />
              )}
            </div>
            {mySeated && room.status === "lobby" && (
              <VoicePanel roomCode={room.code} eligible={room.status === "lobby"} variant="fab"
                className="!absolute bottom-3 left-3 z-30 sm:bottom-6 sm:left-6" />
            )}
            <ChatDock room={room} meId={me.user_id} />
          </div>
          <div className="grid grid-cols-2 gap-3" data-testid="lobby-teams">
            {[0, 1].map((team) => (
              <div key={team} className={`rounded-2xl border bg-gradient-to-br to-transparent p-3 ${team === 0 ? "border-sky-300/25 from-sky-400/10" : "border-amber-300/25 from-amber-400/10"}`}>
                <div className={`text-[10px] font-bold uppercase tracking-widest ${TEAM_TONE[team].text}`}>{TEAM_NAME[team]}</div>
                <div className="mt-1.5 space-y-1">
                  {[team, team + 2].map((s) => (
                    <div key={s} className="flex items-center justify-between gap-2 text-xs">
                      <span className="truncate text-white/80">{room.seats[s]?.display_name || room.seats[s]?.username || <span className="italic text-white/35">Open seat</span>}</span>
                      <span className="shrink-0 text-white/35">Seat {s + 1}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        <aside className="min-w-0 space-y-6">
          <Panel icon={Settings2} title={isHost ? "Table rules" : "Match settings"}>
            <div className="space-y-5">
              {isHost ? (
                <>
                  <div>
                    <div className="mb-2 text-sm font-semibold text-white/85">Match target</div>
                    <TargetPicker value={room.target} onChange={(t) => call(() => api.patch(`/rooms/${code}/settings`, { target: t }))} />
                  </div>
                  {!room.is_public && (
                    <div data-testid="lobby-stake-setting">
                      <div className="mb-2 flex items-center justify-between text-sm font-semibold text-white/85">
                        <span>Coin stake</span>
                        <span className="text-[10px] font-normal text-white/45">Changing it un-readies everyone</span>
                      </div>
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5 lg:grid-cols-2">
                        {[{ id: "free", name: "Free", unlocked: true }, ...tiers].map((t) => {
                          const active = (room.stake?.id || "free") === t.id;
                          return (
                            <button key={t.id} type="button" disabled={!t.unlocked || (t.id !== "free" && room.seats.some((p) => p?.is_bot))}
                              onClick={() => !active && call(() => api.patch(`/rooms/${code}/settings`, { stake_tier: t.id }))}
                              data-testid={`stake-option-${t.id}`} aria-pressed={active}
                              className={`rounded-xl border px-2 py-2 text-left text-xs font-bold transition-colors disabled:opacity-40 ${active ? "border-amber-300 bg-amber-300/15 text-amber-100" : "border-white/10 bg-black/20 text-white/70 hover:border-white/25"}`}>
                              <div className="truncate">{t.name}</div>
                              <div className="mt-0.5 flex items-center gap-1 text-[10px] font-normal text-white/55">
                                {t.id === "free" ? "No coins" : !t.unlocked ? `Level ${t.min_level}` : <><CoinIcon size={10} />{formatCoins(t.entry)}</>}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                      {room.seats.some((p) => p?.is_bot) && <p className="mt-1 text-[10px] text-white/45">Remove the bots to play for coins.</p>}
                    </div>
                  )}
                  <div>
                    <label htmlFor="lobby-turn-duration" className="mb-2 block text-sm font-semibold text-white/85">Turn duration</label>
                    <select id="lobby-turn-duration" data-testid="lobby-turn-duration" value={room.turn_duration || 30}
                      onChange={(event) => call(() => api.patch(`/rooms/${code}/settings`, { turn_duration: Number(event.target.value) }))}
                      className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2.5 text-sm text-white outline-none focus:border-amber-300/60 focus:ring-2 focus:ring-amber-300/25">
                      {TURN_DURATIONS.map((seconds) => <option key={seconds} value={seconds}>{seconds} seconds</option>)}
                    </select>
                    <p className="mt-1 text-xs text-white/45">Shared by all players when the match starts.</p>
                  </div>
                  {!room.is_public && <label className="flex cursor-pointer items-start justify-between gap-3 rounded-xl border border-white/10 bg-black/20 p-3" data-testid="lobby-spectator-setting">
                    <span className="min-w-0">
                      <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-white/85"><Eye size={14} className="text-amber-200/80" aria-hidden="true" />Allow private spectators</span>
                      <span className="mt-1 block text-xs text-white/45">Only people with a separate host invitation can watch.</span>
                    </span>
                    <input type="checkbox" checked={!!room.spectators_enabled} aria-label="Allow private spectators"
                      onChange={(event) => call(() => api.patch(`/rooms/${code}/settings`, { spectators_enabled: event.target.checked }))}
                      className="mt-1 h-4 w-4 accent-amber-500" />
                  </label>}
                  <div>
                    <div className="mb-2 text-sm font-semibold text-white/85">Dealer</div>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-2">
                      {[0, 1, 2, 3].map((s) => (
                        <button key={s} data-testid={`dealer-option-${s}`} onClick={() => call(() => api.patch(`/rooms/${code}/settings`, { dealer_seat: s }))}
                          className={`flex items-center gap-1.5 truncate rounded-xl border px-2 py-2 text-xs font-bold transition-colors ${room.dealer_seat === s ? "border-amber-300 bg-amber-300/15 text-amber-100" : "border-white/10 bg-black/20 text-white/70 hover:border-white/25"}`}>
                          <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] ${room.dealer_seat === s ? "bg-amber-300 text-slate-950" : "bg-white/10 text-white/50"}`}>{room.dealer_seat === s ? "D" : s + 1}</span>
                          <span className="truncate">{room.seats[s]?.username || `Seat ${s + 1}`}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                  <button className="btn-ghost w-full" onClick={shuffleTeams} data-testid="shuffle-teams-btn"><Shuffle size={16} /> Random teams</button>
                  {!full && !room.stake && (
                    <div className="grid grid-cols-2 gap-2">
                      <button className="btn-ghost" onClick={() => call(() => api.post(`/rooms/${code}/bots`))} data-testid="add-bot-btn"><Bot size={16} /> Add bot</button>
                      <button className="btn-ghost" data-testid="fill-bots-btn"
                        onClick={async () => { for (let i = 0; i < room.seats.filter((x) => !x).length; i++) await call(() => api.post(`/rooms/${code}/bots`)); }}>
                        Fill with bots
                      </button>
                    </div>
                  )}
                  {room.seats.some((p) => p?.is_bot) && <p className="rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-xs text-white/55" data-testid="bots-practice-note">Games with bots are practice — they don't count toward stats or the leaderboard.</p>}
                </>
              ) : (
                <div className="space-y-2">
                  <InfoRow icon={Crown} label="Dealer">{dealerName}</InfoRow>
                  <InfoRow icon={Target} label="Target">{room.target} points</InfoRow>
                  <InfoRow icon={Timer} label="Turn duration" testid="lobby-turn-duration-readonly">{room.turn_duration || 30} seconds</InfoRow>
                  <InfoRow icon={Coins} label="Coin stake" testid="lobby-stake-readonly">{room.stake ? `${room.stake.name} · ${formatCoins(room.stake.entry)}` : "Free table"}</InfoRow>
                  {room.is_public && <p className="text-right text-[10px] text-white/40">Turn duration is fixed for public matches.</p>}
                  {!room.is_public && <div data-testid="lobby-spectator-status"><InfoRow icon={Eye} label="Private spectators">{room.spectators_enabled ? "By invitation" : "Disabled"}</InfoRow></div>}
                  <p className="pt-1 text-xs text-white/50">{room.is_public ? "The game starts automatically when all four are ready. Players not ready within 60 seconds are removed." : "The host starts the game when everyone is ready."}</p>
                </div>
              )}
            </div>
          </Panel>

          <Panel testid="lobby-actions" className={myReady ? "border-emerald-400/30" : ""}>
            <div className="mb-3 flex items-center justify-between text-xs">
              <span className="font-semibold text-white/70">Players ready</span>
              <span className="font-mono text-emerald-300">{readyCount}/4</span>
            </div>
            <div className="mb-4 grid grid-cols-4 gap-1.5" aria-hidden="true">
              {room.seats.map((p, i) => <span key={i} className={`h-1.5 rounded-full ${p && room.ready[p.user_id] ? "bg-emerald-400" : p ? "bg-white/25" : "bg-white/10"}`} />)}
            </div>
            <div className="space-y-3">
              {mySeated ? (
                <p className={`rounded-xl border px-3 py-2 text-center text-xs ${myReady ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-200" : "border-amber-300/30 bg-amber-300/10 text-amber-100"}`} data-testid="lobby-ready-hint">
                  {myReady ? "You're ready — tap the badge on your seat to undo."
                    : room.stake ? `Ready means you accept the ${formatCoins(room.stake.entry)}-coin entry. Winners get ${formatCoins(room.stake.payout)} each.`
                      : "Tap “I'm ready” on your seat when you're set to play."}
                </p>
              ) : (
                <button data-testid="ready-toggle-btn" className={myReady ? "btn-ghost w-full" : "btn-gold w-full"} onClick={toggleReady}>
                  {myReady ? "Not ready" : <><Check size={16} /> I'm ready</>}
                </button>
              )}
              {isHost && (
                <button className="btn-gold w-full" disabled={!allReady} onClick={() => call(() => api.post(`/rooms/${code}/start`))} data-testid="start-game-btn">
                  <Play size={16} aria-hidden="true" /> Start game
                </button>
              )}
              {!full && <p className="text-center text-xs text-white/50" data-testid="lobby-waiting-text">Waiting for {emptyCount} more player(s)…</p>}
              <div className="flex justify-center border-t border-white/10 pt-3">
                <button className="inline-flex items-center gap-1.5 text-sm text-white/50 hover:text-rose-300" onClick={leave} data-testid="leave-room-btn"><LogOut size={14} /> Leave room</button>
              </div>
            </div>
          </Panel>

          {!room.is_public && (
            <Panel icon={UserPlus} title="Invite friends" tone="bg-teal-400/15 text-teal-200">
              <InviteFriends code={room.code} />
            </Panel>
          )}
        </aside>
      </div>
    </div>
  );
}
