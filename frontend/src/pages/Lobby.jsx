import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { Copy, Crown, Check, LogOut, UserPlus, Shuffle } from "lucide-react";
import { useApp, useSocketEvent } from "@/context/AppContext";
import { errMsg, TEAM_NAME } from "@/lib/api";
import { PlayerAvatar } from "@/components/PlayerAvatar";
import { TargetPicker } from "@/components/TargetPicker";
import { ChatPanel } from "@/components/Chat";

const POS = ["bottom-0 left-1/2 -translate-x-1/2", "right-0 top-1/2 -translate-y-1/2", "top-0 left-1/2 -translate-x-1/2", "left-0 top-1/2 -translate-y-1/2"];

function SeatSlot({ room, seat, selected, onClick, canEdit }) {
  const p = room.seats[seat];
  const team = seat % 2;
  const ready = p && room.ready[p.user_id];
  return (
    <button type="button" onClick={onClick} disabled={!canEdit} data-testid={`lobby-seat-${seat}`}
      className={`absolute ${POS[seat]} w-32 sm:w-36 rounded-2xl border-2 p-3 text-center bg-card/90 backdrop-blur transition-[transform,border-color] ${selected ? "border-primary scale-105" : team === 0 ? "border-[var(--team-a)]/40" : "border-[var(--team-b)]/40"} ${canEdit ? "hover:scale-105 cursor-pointer" : "cursor-default"}`}>
      <div className={`text-[10px] font-bold uppercase tracking-widest ${team === 0 ? "text-team-a" : "text-team-b"}`}>{TEAM_NAME[team]} · Seat {seat + 1}</div>
      {p ? (
        <div className="flex flex-col items-center mt-2 gap-1">
          <PlayerAvatar user={p} size={40} online={p.online} />
          <div className="text-sm font-semibold truncate max-w-full flex items-center gap-1">
            {room.host_id === p.user_id && <Crown size={12} className="text-primary" />}{p.username}
          </div>
          <div className={`text-[11px] font-bold ${ready ? "text-emerald-400" : "text-muted-foreground"}`} data-testid={`lobby-seat-${seat}-ready`}>{ready ? "READY" : "Not ready"}</div>
        </div>
      ) : (
        <div className="py-5 text-xs text-muted-foreground">Empty seat</div>
      )}
      {room.dealer_seat === seat && <div className="absolute -top-2 -right-2 h-6 w-6 rounded-full bg-primary text-primary-foreground text-[11px] font-black flex items-center justify-center" data-testid="dealer-chip">D</div>}
    </button>
  );
}

function InviteFriends({ code }) {
  const { api } = useApp();
  const [friends, setFriends] = useState([]);
  useEffect(() => { api.get("/friends").then((r) => setFriends(r.data)).catch(() => {}); }, [api]);
  const invite = async (f) => {
    try { await api.post(`/rooms/${code}/invite`, { user_id: f.user_id }); toast.success(`Invited ${f.username}`); } catch (e) { toast.error(errMsg(e)); }
  };
  if (!friends.length) return <p className="text-xs text-muted-foreground">Add friends to invite them directly.</p>;
  return (
    <div className="space-y-1.5 max-h-40 overflow-y-auto">
      {friends.map((f) => (
        <div key={f.user_id} className="flex items-center gap-2 text-sm">
          <PlayerAvatar user={f} size={26} online={f.online} />
          <span className="flex-1 truncate">{f.username}</span>
          <button className="btn-ghost !px-2 !py-1 text-xs" onClick={() => invite(f)} data-testid={`invite-friend-${f.username}`}><UserPlus size={14} /> Invite</button>
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

  const load = useCallback(() => api.get(`/rooms/${code}`).then((r) => setRoom(r.data)).catch((e) => { toast.error(errMsg(e)); navigate("/home"); }), [api, code, navigate]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (room?.status === "playing" && room.game_id) navigate(`/game/${room.game_id}`); }, [room, navigate]);
  useSocketEvent((m) => {
    if (m.type === "room_update" && m.room.code === code) setRoom(m.room);
    if (m.type === "game_started" && m.room_code === code) navigate(`/game/${m.game_id}`);
    if (m.type === "requeued" && m.code === code) { toast("A player left — you're back at the front of the queue."); navigate("/play"); }
    if (m.type === "room_left" && m.code === code) navigate(room?.is_public ? "/play" : "/home");
  });

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

  return (
    <div className="grid lg:grid-cols-[1fr_340px] gap-10" data-testid="lobby-page">
      <div>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="eyebrow">{room.is_public ? "Public match lobby" : "Private room"}</p>
            <h1 className="font-display text-3xl mt-2">Table lobby</h1>
          </div>
          {!room.is_public && (
            <button data-testid="copy-invite-code-btn" className="btn-ghost font-mono tracking-[0.3em] text-lg"
              onClick={() => { navigator.clipboard?.writeText(room.code); toast.success("Invite code copied"); }}>
              <span data-testid="room-invite-code">{room.code}</span> <Copy size={16} />
            </button>
          )}
        </div>
        {isHost && <p className="text-sm text-muted-foreground mt-3">Tap two seats to swap them. Seats 1 & 3 are Team A, seats 2 & 4 are Team B — partners sit opposite.</p>}
        <div className="relative mx-auto mt-8 w-full max-w-[460px] aspect-square">
          <div className="absolute inset-[18%] rounded-full felt grain border-4 border-amber-500/25 shadow-2xl flex items-center justify-center">
            <div className="text-center">
              <div className="font-mono text-3xl font-bold text-amber-300" data-testid="lobby-target">{room.target}</div>
              <div className="text-[10px] uppercase tracking-widest text-amber-100/70">points to win</div>
            </div>
          </div>
          {[0, 1, 2, 3].map((s) => <SeatSlot key={s} room={room} seat={s} selected={sel === s} canEdit={isHost} onClick={() => clickSeat(s)} />)}
        </div>
      </div>

      <aside className="space-y-6">
        <div className="panel p-5 space-y-5">
          {isHost ? (
            <>
              <div>
                <div className="text-sm font-semibold mb-2">Match target</div>
                <TargetPicker value={room.target} onChange={(t) => call(() => api.patch(`/rooms/${code}/settings`, { target: t }))} />
              </div>
              <div>
                <div className="text-sm font-semibold mb-2">Dealer</div>
                <div className="grid grid-cols-4 gap-2">
                  {[0, 1, 2, 3].map((s) => (
                    <button key={s} data-testid={`dealer-option-${s}`} onClick={() => call(() => api.patch(`/rooms/${code}/settings`, { dealer_seat: s }))}
                      className={`rounded-lg py-2 text-xs font-bold border truncate px-1 ${room.dealer_seat === s ? "bg-primary text-primary-foreground border-primary" : "border-border"}`}>
                      {room.seats[s]?.username || `Seat ${s + 1}`}
                    </button>
                  ))}
                </div>
              </div>
              <button className="btn-ghost w-full" onClick={shuffleTeams} data-testid="shuffle-teams-btn"><Shuffle size={16} /> Random teams</button>
            </>
          ) : (
            <div className="text-sm text-muted-foreground">
              Dealer: <b className="text-foreground">{room.seats[room.dealer_seat]?.username || `Seat ${room.dealer_seat + 1}`}</b> · Target <b className="text-foreground">{room.target}</b>
              <div className="mt-1">{room.is_public ? "The game starts automatically when all four are ready. Players not ready within 60 seconds are removed." : "The host starts the game when everyone is ready."}</div>
            </div>
          )}
          <button data-testid="ready-toggle-btn" className={myReady ? "btn-ghost w-full" : "btn-gold w-full"}
            onClick={() => call(() => api.post(`/rooms/${code}/ready`, { ready: !myReady }))}>
            {myReady ? "Not ready" : <><Check size={16} /> I'm ready</>}
          </button>
          {isHost && (
            <button className="btn-gold w-full" disabled={!allReady} onClick={() => call(() => api.post(`/rooms/${code}/start`))} data-testid="start-game-btn">
              Start game
            </button>
          )}
          {!full && <p className="text-xs text-muted-foreground" data-testid="lobby-waiting-text">Waiting for {room.seats.filter((x) => !x).length} more player(s)…</p>}
          <button className="text-sm text-muted-foreground hover:text-destructive inline-flex items-center gap-1" onClick={leave} data-testid="leave-room-btn"><LogOut size={14} /> Leave room</button>
        </div>
        {!room.is_public && (
          <div className="panel p-5">
            <div className="eyebrow mb-3">Invite friends</div>
            <InviteFriends code={room.code} />
          </div>
        )}
        <div className="panel p-5 h-72 flex"><ChatPanel roomCode={room.code} className="flex-1" /></div>
      </aside>
    </div>
  );
}
