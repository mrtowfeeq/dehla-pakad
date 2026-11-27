import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Eye, Home, Info, Volume2, VolumeX, Users, WifiOff } from "lucide-react";
import { toast } from "sonner";
import { PlayerAvatar } from "@/components/PlayerAvatar";
import { Hud, TrickSlots } from "@/components/game/TableLayout";
import { timerSeatFor } from "@/lib/turnSeat";
import { TurnTimer } from "@/components/game/TurnTimer";
import { MatchOver } from "@/components/game/Overlays";
import { useApp, useSocketEvent } from "@/context/AppContext";
import { errMsg, TEAM_NAME } from "@/lib/api";
import { sound } from "@/lib/sound";
import { VoicePanel } from "@/components/voice/VoicePanel";

function SpectatorSeat({ player, state, snapshot, serverOffsetMs, horizontal = false }) {
  const active = state.phase === "trump_select"
    ? state.trump_selector === player.seat
    : state.turn === player.seat;
  const hasTimer = timerSeatFor(state, snapshot.turn_seat) === player.seat;
  return (
    <div data-testid={`spectator-seat-${player.seat}`}
      className={`seat-panel relative flex ${horizontal ? "flex-row gap-2 px-2.5 py-1.5" : "w-[78px] flex-col gap-1 px-1.5 py-2 sm:w-[96px]"} items-center rounded-2xl border ${player.team === 0 ? "border-sky-300/30" : "border-amber-300/30"} ${active ? "seat-panel-active border-amber-200/80 shadow-[0_0_20px_-3px_rgba(251,191,36,.45)]" : "bg-[#07120d]/85"}`}>
      {hasTimer && snapshot.turn_deadline && <TurnTimer deadline={snapshot.turn_deadline} phase={snapshot.turn_phase}
        graceDeadline={snapshot.turn_grace_deadline} duration={snapshot.turn_duration} serverOffsetMs={serverOffsetMs}
        className={horizontal ? "-top-4 right-1" : "-top-4 left-1/2 -translate-x-1/2"} />}
      <PlayerAvatar user={player} size={horizontal ? 34 : 38} online={player.online} ring={active ? "ring-2 ring-amber-300" : ""} />
      <div className={`min-w-0 ${horizontal ? "text-left" : "w-full text-center"}`}>
        <div className="truncate text-[11px] font-semibold text-white sm:text-xs">{player.display_name || player.username}</div>
        <div className={`truncate text-[9px] font-bold uppercase tracking-wider ${player.team === 0 ? "text-sky-300" : "text-amber-300"}`}>
          {TEAM_NAME[player.team]} · Seat {player.seat + 1}
        </div>
        <div className={`text-[9px] ${player.online ? "text-emerald-300/80" : "text-white/45"}`}>{player.online ? "Connected" : "Offline"}</div>
      </div>
    </div>
  );
}

function MatchInfo({ snapshot, state, players }) {
  const completed = Array.isArray(state.tricks) ? state.tricks : [];
  const bySeat = (seat) => players.find((p) => p.seat === seat)?.display_name || players.find((p) => p.seat === seat)?.username || `Seat ${seat + 1}`;
  return (
    <section className="mt-3 rounded-xl border border-white/10 bg-black/35 p-3 text-xs text-white/75" data-testid="spectator-match-info">
      <div className="grid gap-2 sm:grid-cols-3">
        <span>Started <b className="text-white">{snapshot.created_at ? new Date(snapshot.created_at).toLocaleString() : "—"}</b></span>
        <span>Round <b className="text-white">{state.round_no}</b></span>
        <span>Target <b className="text-white">{state.target}</b></span>
      </div>
      <h2 className="mt-4 font-bold uppercase tracking-wider text-white/55">Completed tricks ({completed.length})</h2>
      {completed.length === 0
        ? <p className="mt-2 text-white/45">No completed tricks yet.</p>
        : <ol className="mt-2 grid max-h-52 gap-1 overflow-y-auto sm:grid-cols-2">
          {completed.map((trick, index) => (
            <li key={index} className="flex items-center justify-between gap-2 rounded-lg bg-white/5 px-2.5 py-1.5" data-testid={`spectator-history-trick-${index + 1}`}>
              <span className="shrink-0 font-mono text-white/55">{index + 1}</span>
              <span className="min-w-0 flex-1 truncate">{(trick.cards || []).map(([, card]) => card).join(" · ")}</span>
              <span className="shrink-0 text-amber-200">Won by {bySeat(trick.winner)}</span>
            </li>
          ))}
        </ol>}
    </section>
  );
}

export default function SpectatorView({ adminSpectator = false }) {
  const { gameId } = useParams();
  const { api, send, connected } = useApp();
  const [snapshot, setSnapshot] = useState(null);
  const [error, setError] = useState("");
  const [infoOpen, setInfoOpen] = useState(false);
  const [muted, setMuted] = useState(() => sound.prefs.muted);
  const [serverOffsetMs, setServerOffsetMs] = useState(0);
  const wsRevision = useRef(0);
  const lastServerTime = useRef(0);
  const [invite] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get("invite") || "");

  useEffect(() => {
    if (window.location.hash.includes("invite=")) {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const requestRevision = wsRevision.current;
    const startedAt = Date.now();
    const endpoint = adminSpectator
      ? `/admin/games/${encodeURIComponent(gameId)}/spectator-state`
      : `/spectator/games/${encodeURIComponent(gameId)}/state`;
    api.post(endpoint, adminSpectator ? {} : { invite: invite || null }).then(({ data }) => {
      if (cancelled) return;
      if (data?.type !== "spectator_state" || data.game_id !== gameId || !data.state) throw new Error("Invalid spectator state");
      const receivedAt = Date.now();
      const serverTime = Date.parse(data.server_time || "");
      if (Number.isFinite(serverTime) && serverTime >= lastServerTime.current) {
        lastServerTime.current = serverTime;
        setServerOffsetMs(serverTime - ((startedAt + receivedAt) / 2));
      }
      if (requestRevision === wsRevision.current) setSnapshot(data);
      setError("");
    }).catch((failure) => {
      if (!cancelled) setError(errMsg(failure));
    });
    return () => { cancelled = true; };
  }, [api, gameId, invite, adminSpectator]);

  useEffect(() => {
    if (!connected || !gameId) return;
    const type = adminSpectator ? "admin_spectator_join" : "spectator_join";
    if (!send({ type, game_id: gameId, ...(adminSpectator ? {} : { invite: invite || undefined }) })) {
      toast.error("Reconnecting to the live match…");
    }
  }, [connected, gameId, invite, send, adminSpectator]);

  useEffect(() => () => { send({ type: "spectator_leave", game_id: gameId }); }, [gameId, send]);

  useSocketEvent((message) => {
    if (message.game_id !== gameId) return;
    if (message.type === "spectator_state") {
      if (!message.state || message.state.seq === undefined) return;
      wsRevision.current += 1;
      const serverTime = Date.parse(message.server_time || "");
      if (Number.isFinite(serverTime) && serverTime >= lastServerTime.current) {
        lastServerTime.current = serverTime;
        setServerOffsetMs(serverTime - Date.now());
      }
      setSnapshot((current) => !current || (message.state.seq ?? -1) >= (current.state?.seq ?? -1) ? message : current);
      setError("");
    } else if (message.type === "spectator_error") {
      setSnapshot(null);
      setError(message.message || "Match unavailable or spectator access denied");
    } else if (message.type === "spectator_access_revoked") {
      setSnapshot(null);
      setError("The private-room host revoked spectator access.");
    }
  });

  if (error && !snapshot) {
    return (
      <main className="game-shell flex min-h-screen flex-col items-center justify-center gap-4 px-4 text-center text-white" data-testid="spectator-access-error">
        <Eye size={30} className="text-amber-300" />
        <h1 className="font-display text-2xl">This match cannot be watched</h1>
        <p className="max-w-md text-sm text-white/60">{error}</p>
        <div className="flex gap-2"><Link className="btn-gold" to={adminSpectator ? "/admin/lobbies" : "/spectate"}>{adminSpectator ? "Live lobbies" : "Public games"}</Link><Link className="btn-ghost" to="/home"><Home size={15} /> Home</Link></div>
      </main>
    );
  }
  if (!snapshot) {
    return <main className="game-shell flex min-h-screen items-center justify-center text-white" data-testid="spectator-loading">Loading spectator view…</main>;
  }

  const state = { ...snapshot.state, my_seat: -1 };
  const players = snapshot.players || [];
  const playerAt = (seat) => players.find((player) => player.seat === seat);
  const toggleSound = () => {
    sound.unlock();
    const nextMuted = !sound.prefs.muted;
    sound.update({ muted: nextMuted });
    setMuted(nextMuted);
  };

  if (snapshot.status === "cancelled") {
    return (
      <main className="game-shell flex min-h-screen flex-col items-center justify-center gap-4 px-4 text-center text-white" data-testid="spectator-cancelled">
        <h1 className="font-display text-3xl">This match was cancelled</h1>
        <p className="text-sm text-white/60">Spectator access has ended.</p>
        <div className="flex gap-2"><Link className="btn-gold" to={adminSpectator ? "/admin/lobbies" : "/spectate"}>{adminSpectator ? "Return to live lobbies" : "Return to games list"}</Link><Link className="btn-ghost" to="/home">Home</Link></div>
      </main>
    );
  }
  if (snapshot.status === "finished" || state.phase === "match_over") {
    return <MatchOver st={state} players={players} mySeat={null} game={snapshot} spectator />;
  }

  return (
    <div className="game-shell fixed inset-0 flex select-none flex-col overflow-hidden text-white" data-testid="spectator-view">
      <Hud st={state} connected={connected} roomCode={adminSpectator ? "ADMIN" : "SPECTATOR"} gameStatus={snapshot.status} players={players}
        left={<Link to={adminSpectator ? "/admin/lobbies" : "/spectate"} className="flex h-9 items-center gap-1.5 rounded-full bg-black/50 px-3 text-xs text-white hover:bg-black/70" data-testid="spectator-list-btn"><Eye size={15} /> {adminSpectator ? "Lobbies" : "Games"}</Link>}
        right={<div className="flex items-center gap-2">
          {snapshot.status === "active" && <VoicePanel gameId={gameId} eligible={snapshot.status === "active"} />}
          <button onClick={toggleSound} className="flex h-9 w-9 items-center justify-center rounded-full bg-black/50 hover:bg-black/70" data-testid="spectator-sound-toggle" aria-label={muted ? "Unmute sound" : "Mute sound"}>{muted ? <VolumeX size={17} /> : <Volume2 size={17} />}</button>
        </div>} />

      <div className="flex shrink-0 flex-wrap items-center justify-center gap-2 px-2 py-1.5 text-[10px] sm:text-xs" data-testid="spectator-status-bar">
        <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 font-bold uppercase tracking-wider ${adminSpectator ? "border-amber-300/30 bg-amber-300/10 text-amber-100" : "border-emerald-300/25 bg-emerald-300/10 text-emerald-200"}`}><span className={`h-1.5 w-1.5 rounded-full ${adminSpectator ? "bg-amber-300" : "bg-emerald-300"}`} /> {adminSpectator ? "ADMIN SPECTATING" : "LIVE"}</span>
        <span className="rounded-full border border-white/10 bg-black/30 px-2.5 py-1 font-bold uppercase tracking-wider text-white/70">Watching · Read only</span>
        <span className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-black/30 px-2.5 py-1 text-white/70" data-testid="spectator-count"><Users size={12} /> {snapshot.spectator_count} watching</span>
        {!connected && <span className="inline-flex items-center gap-1 rounded-full bg-amber-300/10 px-2 py-1 text-amber-200" data-testid="spectator-disconnected"><WifiOff size={12} /> Reconnecting · last safe state</span>}
        <button onClick={() => setInfoOpen((open) => !open)} className="inline-flex items-center gap-1 rounded-full bg-white/5 px-2.5 py-1 text-white/75 hover:bg-white/10" data-testid="spectator-info-toggle"><Info size={12} /> Match info</button>
      </div>
      {infoOpen && <div className="z-20 mx-2 shrink-0 sm:mx-4"><MatchInfo snapshot={snapshot} state={state} players={players} /></div>}

      <div className="relative min-h-0 flex-1 px-1 py-1 sm:px-4 sm:py-2" data-testid="spectator-table-area">
        <div className="game-table-grid mx-auto grid h-full w-full max-w-5xl grid-cols-[auto_minmax(0,1fr)_auto] grid-rows-[auto_minmax(0,1fr)_auto] gap-1 sm:gap-3">
          <div className="col-start-2 row-start-1 flex justify-center">{playerAt(2) && <SpectatorSeat player={playerAt(2)} state={state} snapshot={snapshot} serverOffsetMs={serverOffsetMs} />}</div>
          <div className="col-start-1 row-start-2 flex items-center justify-center">{playerAt(3) && <SpectatorSeat player={playerAt(3)} state={state} snapshot={snapshot} serverOffsetMs={serverOffsetMs} />}</div>
          <div className="col-start-3 row-start-2 flex items-center justify-center">{playerAt(1) && <SpectatorSeat player={playerAt(1)} state={state} snapshot={snapshot} serverOffsetMs={serverOffsetMs} />}</div>
          <div className="col-start-2 row-start-2 relative flex min-h-0 min-w-0 items-center justify-center">
            <div className="game-table-board relative z-10 flex h-full min-h-0 w-full items-center justify-center" data-testid="spectator-table-board">
              <div className="table-rail absolute inset-0 rounded-[36%]" />
              <TrickSlots cards={state.trick || []} currentTrick={state.trick || []} mySeat={0} winner={null} />
            </div>
          </div>
          <div className="col-span-3 col-start-1 row-start-3 flex min-w-0 items-center justify-center gap-2 sm:gap-4">
            {playerAt(0) && <SpectatorSeat player={playerAt(0)} state={state} snapshot={snapshot} serverOffsetMs={serverOffsetMs} horizontal />}
            <div className="min-w-0 rounded-full bg-black/45 px-3 py-1.5 text-center text-[10px] font-semibold text-white/80 sm:text-xs" data-testid="spectator-turn-indicator">
              {state.phase === "playing" ? `${players.find((player) => player.seat === state.turn)?.display_name || players.find((player) => player.seat === state.turn)?.username || "Player"} to play` : state.phase.replaceAll("_", " ")}
            </div>
          </div>
        </div>
      </div>
      <footer className="flex shrink-0 items-center justify-center gap-3 px-2 pb-[max(8px,env(safe-area-inset-bottom))] pt-1 text-[10px] text-white/45">
        <Link to={adminSpectator ? "/admin/lobbies" : "/spectate"} className="hover:text-white" data-testid="spectator-return-list">{adminSpectator ? "Return to live lobbies" : "Return to games list"}</Link>
        <span aria-hidden="true">·</span>
        <Link to="/home" className="hover:text-white" data-testid="spectator-return-home">Home</Link>
      </footer>
    </div>
  );
}
