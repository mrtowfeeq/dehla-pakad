import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Eye, Home, RefreshCw, Users } from "lucide-react";
import { toast } from "sonner";
import { PlayerAvatar } from "@/components/PlayerAvatar";
import { useApp } from "@/context/AppContext";
import { errMsg, TEAM_NAME } from "@/lib/api";

function startedLabel(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "—";
}

export default function SpectatorGamesList() {
  const { api } = useApp();
  const [games, setGames] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get("/spectator/games");
      setGames(Array.isArray(data) ? data : []);
    } catch (error) {
      toast.error(errMsg(error));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-6" data-testid="spectator-games-list">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">Live viewing</p>
          <h1 className="mt-2 font-display text-3xl">Watch a match</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">Public matches are read-only here. Private matches require a host invitation.</p>
        </div>
        <div className="flex gap-2">
          <button className="btn-ghost !px-3" onClick={load} disabled={loading} data-testid="refresh-spectator-games"><RefreshCw size={15} /> Refresh</button>
          <Link className="btn-ghost !px-3" to="/home" data-testid="spectator-list-home"><Home size={15} /> Home</Link>
        </div>
      </header>

      {loading && games.length === 0 && <div className="panel p-6 text-sm text-muted-foreground" data-testid="spectator-games-loading">Finding live public matches…</div>}
      {!loading && games.length === 0 && (
        <div className="panel flex flex-col items-center gap-3 p-10 text-center" data-testid="spectator-games-empty">
          <Eye size={26} className="text-primary" />
          <h2 className="font-semibold">No public matches are live</h2>
          <p className="text-sm text-muted-foreground">Check back when a public table starts.</p>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {games.map((game) => (
          <article key={game.game_id} className="panel space-y-4 p-5" data-testid={`spectator-game-${game.game_id}`}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-300/25 bg-emerald-300/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-emerald-300">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-300" /> Live
                </span>
                <p className="mt-2 text-xs text-muted-foreground">Started {startedLabel(game.started_at)} · Round {game.round_no || 1}</p>
              </div>
              <div className="flex items-center gap-1.5 rounded-full bg-secondary/70 px-2.5 py-1.5 text-xs text-muted-foreground" data-testid={`spectator-count-${game.game_id}`}>
                <Users size={13} /> {game.spectator_count} watching
              </div>
            </div>
            <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 rounded-xl border border-border bg-background/40 p-3">
              {[0, 1].map((team) => (
                <div key={team} className={`min-w-0 ${team === 1 ? "col-start-3 text-right" : "col-start-1"}`}>
                  <p className={`truncate text-[10px] font-bold uppercase tracking-wider ${team === 0 ? "text-team-a" : "text-team-b"}`}>{TEAM_NAME[team]}</p>
                  <p className="mt-0.5 font-mono text-2xl font-bold tabular-nums" data-testid={`spectator-score-${game.game_id}-${team}`}>
                    {game.scores?.[team] ?? 0}<span className="text-xs text-muted-foreground">/{game.target ?? "—"}</span>
                  </p>
                </div>
              ))}
              <span className="col-start-2 row-start-1 text-center text-muted-foreground">–</span>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {(game.players || []).slice().sort((a, b) => a.seat - b.seat).map((player) => (
                <div key={player.seat} className="flex min-w-0 items-center gap-2 rounded-lg border border-border/70 bg-background/40 p-2" data-testid={`spectator-player-${game.game_id}-${player.seat}`}>
                  <PlayerAvatar user={player} size={28} online={player.online} />
                  <span className="truncate text-xs font-medium">{player.display_name || player.username}</span>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
              <span>{game.active_player ? `${game.active_player} to play` : "Match in progress"}</span>
              <Link to={`/spectate/${encodeURIComponent(game.game_id)}`} className="btn-gold !px-4 !py-2" data-testid={`watch-game-${game.game_id}`}>
                <Eye size={15} /> Watch
              </Link>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
