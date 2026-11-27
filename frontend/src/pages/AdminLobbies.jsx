import { useCallback, useEffect, useState } from "react";
import { Eye, RefreshCw, Search, WifiOff } from "lucide-react";
import { Link } from "react-router-dom";
import { PlayerAvatar } from "@/components/PlayerAvatar";
import { useApp } from "@/context/AppContext";
import { errMsg } from "@/lib/api";

const PAGE_SIZE = 30;
const formatTime = (value) => value && !Number.isNaN(new Date(value).getTime()) ? new Date(value).toLocaleString() : "—";
const formatDuration = (seconds) => {
  const value = Math.max(0, Number(seconds) || 0);
  return `${Math.floor(value / 60)}m ${value % 60}s`;
};

function LobbyStatus({ value }) {
  const palette = value === "playing" ? "text-emerald-200 bg-emerald-300/10" : value === "waiting" ? "text-sky-200 bg-sky-300/10" : value === "completed" ? "text-white/60 bg-white/5" : "text-rose-200 bg-rose-300/10";
  return <span className={`rounded-full px-2 py-1 text-[9px] font-bold uppercase tracking-wider ${palette}`}>{value}</span>;
}

export default function AdminLobbies() {
  const { api } = useApp();
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [canSpectate, setCanSpectate] = useState(false);
  const [offset, setOffset] = useState(0);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [roomType, setRoomType] = useState("");
  const [status, setStatus] = useState("");
  const [disconnected, setDisconnected] = useState(false);
  const [sort, setSort] = useState("created_at_desc");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [truncated, setTruncated] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => { setSearch(query.trim()); setOffset(0); }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    const params = new URLSearchParams({ offset: String(offset), limit: String(PAGE_SIZE), sort });
    if (search) params.set("q", search);
    if (roomType) params.set("room_type", roomType);
    if (status) params.set("status", status);
    if (disconnected) params.set("disconnected", "true");
    try {
      const { data } = await api.get(`/admin/lobbies?${params.toString()}`);
      setRows(Array.isArray(data?.items) ? data.items : []);
      setTotal(Number(data?.total) || 0);
      setCanSpectate(Boolean(data?.can_spectate));
      setTruncated(Boolean(data?.truncated));
      setError("");
    } catch (failure) {
      setError(errMsg(failure));
    } finally {
      setLoading(false);
    }
  }, [api, offset, search, roomType, status, disconnected, sort]);

  useEffect(() => {
    load(false);
    const timer = setInterval(() => load(true), 15000);
    return () => clearInterval(timer);
  }, [load]);

  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-4" data-testid="admin-live-lobbies">
      <section className="grid gap-3 rounded-2xl border border-white/10 bg-[#071710]/80 p-3 sm:grid-cols-2 xl:grid-cols-[minmax(220px,1fr)_150px_150px_190px_auto] sm:p-4">
        <label className="relative block">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/40" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search room or player" aria-label="Search room or player"
            className="w-full rounded-xl border border-white/10 bg-black/25 py-2.5 pl-9 pr-3 text-sm text-white placeholder:text-white/35 focus:border-amber-200/40 focus:outline-none" />
        </label>
        <select value={roomType} onChange={(event) => { setRoomType(event.target.value); setOffset(0); }} aria-label="Filter room type" className="rounded-xl border border-white/10 bg-[#0b1a14] px-3 py-2 text-sm text-white">
          <option value="">All room types</option><option value="public">Public</option><option value="private">Private</option>
        </select>
        <select value={status} onChange={(event) => { setStatus(event.target.value); setOffset(0); }} aria-label="Filter room status" className="rounded-xl border border-white/10 bg-[#0b1a14] px-3 py-2 text-sm text-white">
          <option value="">Ongoing</option><option value="waiting">Waiting</option><option value="playing">Playing</option><option value="completed">Completed</option><option value="cancelled">Cancelled</option>
        </select>
        <select value={sort} onChange={(event) => { setSort(event.target.value); setOffset(0); }} aria-label="Sort lobbies" className="rounded-xl border border-white/10 bg-[#0b1a14] px-3 py-2 text-sm text-white">
          <option value="created_at_desc">Newest first</option><option value="created_at_asc">Oldest first</option><option value="duration_desc">Longest match</option><option value="duration_asc">Shortest match</option><option value="spectators_desc">Most spectators</option>
        </select>
        <button type="button" onClick={() => setDisconnected((value) => !value)} aria-pressed={disconnected} data-testid="admin-disconnected-filter"
          className={`inline-flex items-center justify-center gap-2 rounded-xl border px-3 py-2 text-xs font-semibold ${disconnected ? "border-amber-200/35 bg-amber-200/10 text-amber-100" : "border-white/10 bg-black/20 text-white/65"}`}>
          <WifiOff size={14} /> Disconnected
        </button>
      </section>

      {error && <div className="rounded-xl border border-rose-300/20 bg-rose-300/5 p-3 text-sm text-rose-100" role="alert">{error}</div>}
      {truncated && <div className="rounded-xl border border-amber-300/20 bg-amber-300/5 p-3 text-xs text-amber-100">The room scan reached its 2,000-candidate safety cap before local filters were applied. Refine the search or filters; results may otherwise be incomplete.</div>}

      <section className="overflow-hidden rounded-2xl border border-white/10 bg-[#071710]/80" aria-busy={loading}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
          <div><h2 className="text-sm font-semibold">Live lobby monitor</h2><p className="mt-0.5 text-[10px] text-white/40">Refreshes every 15 seconds · public and private rooms</p></div>
          <button onClick={() => load(false)} disabled={loading} className="inline-flex items-center gap-1.5 rounded-lg bg-white/5 px-3 py-2 text-xs text-white/70 hover:bg-white/10 disabled:opacity-50" data-testid="admin-lobbies-refresh"><RefreshCw size={13} /> Refresh</button>
        </div>
        {loading && rows.length === 0 ? <div className="p-8 text-center text-sm text-white/50">Loading rooms…</div>
          : rows.length === 0 ? <div className="p-8 text-center text-sm text-white/50">No rooms match these filters.</div>
            : <div className="overflow-x-auto">
              <table className="w-full min-w-[1040px] text-left text-xs">
                <thead className="bg-black/20 text-[9px] uppercase tracking-wider text-white/40">
                  <tr><th className="px-4 py-3">Room / owner</th><th className="px-4 py-3">Players</th><th className="px-4 py-3">Status / progress</th><th className="px-4 py-3">Created / started</th><th className="px-4 py-3">Duration / viewers</th><th className="px-4 py-3">Action</th></tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {rows.map((room, index) => (
                    <tr key={room.code || room.game_id || `${room.owner}-${room.created_at}-${index}`} className="align-top hover:bg-white/[0.025]" data-testid={`admin-lobby-${room.code || room.game_id || index}`}>
                      <td className="px-4 py-3">
                        <div className="font-mono font-bold text-white">{room.code || "Private room"}</div>
                        <div className="mt-1 flex items-center gap-1.5 text-[10px] text-white/45"><span className={`h-1.5 w-1.5 rounded-full ${room.room_type === "public" ? "bg-sky-300" : "bg-violet-300"}`} />{room.room_type} · Host {room.owner}</div>
                      </td>
                      <td className="max-w-[280px] px-4 py-3">
                        <div className="text-[10px] text-white/45">{room.occupied_seats}/{room.seat_limit} seated</div>
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          {room.players.map((player) => <span key={player.seat} className="inline-flex max-w-36 items-center gap-1.5 rounded-lg bg-black/25 px-1.5 py-1" title={`Seat ${player.seat + 1}${player.online ? " · online" : " · offline"}`}>
                            <PlayerAvatar user={player} size={19} online={player.online} /><span className="truncate">{player.display_name || player.username}</span>{!player.online && <WifiOff size={10} className="shrink-0 text-rose-300" />}
                          </span>)}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <LobbyStatus value={room.status} />
                        {room.current_state && <div className="mt-1.5 max-w-56 text-[10px] text-white/55">Round {room.current_state.round ?? "—"} · {room.current_state.phase || "—"}<br />{room.current_state.current_player ? `${room.current_state.current_player} to act · ` : ""}{room.current_state.scores?.join("–") || "—"} score · tricks {room.current_state.tricks_won?.join("–") || "—"}</div>}
                      </td>
                      <td className="px-4 py-3 text-[10px] text-white/55">Created {formatTime(room.created_at)}<br /><span className="text-white/35">Started {formatTime(room.match_started_at)}</span></td>
                      <td className="px-4 py-3 text-[10px] text-white/55">{room.match_started_at ? formatDuration(room.match_duration_seconds) : "—"}<br /><span className="text-white/35">{room.spectator_count} watching</span></td>
                      <td className="px-4 py-3">{canSpectate && room.watch_allowed && room.game_id
                        ? <Link to={`/admin/spectate/${encodeURIComponent(room.game_id)}`} className="inline-flex items-center gap-1 rounded-lg bg-amber-200 px-2.5 py-2 font-bold text-[#07120d] hover:bg-amber-100" data-testid={`admin-watch-${room.code || room.game_id || index}`}><Eye size={13} /> Watch</Link>
                        : <span className="text-[10px] text-white/30">No active match</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>}
        <footer className="flex items-center justify-between border-t border-white/10 px-4 py-3 text-xs text-white/45">
          <span>{total} rooms · page {page} of {pages}</span>
          <div className="flex gap-2"><button disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} className="rounded-lg bg-white/5 px-3 py-1.5 disabled:opacity-30">Previous</button><button disabled={offset + PAGE_SIZE >= total || loading} onClick={() => setOffset(offset + PAGE_SIZE)} className="rounded-lg bg-white/5 px-3 py-1.5 disabled:opacity-30">Next</button></div>
        </footer>
      </section>
    </div>
  );
}
