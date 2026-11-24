import { useEffect, useState } from "react";
import { useApp } from "@/context/AppContext";
import { TEAM_NAME, VICTORY_LABEL } from "@/lib/api";
import { PlayerAvatar } from "@/components/PlayerAvatar";

export function MatchRow({ m, meId }) {
  const [open, setOpen] = useState(false);
  const mine = m.players.find((p) => p.user_id === meId);
  const won = mine && mine.team === m.winner_team;
  const my = mine ? mine.team : 0;
  const forfeit = m.forfeited_by !== null && m.forfeited_by !== undefined;
  return (
    <div className="panel" data-testid={`match-row-${m.id}`}>
      <button className="w-full p-4 flex flex-wrap items-center gap-4 text-left" onClick={() => setOpen((o) => !o)}>
        <span className={`text-xs font-black tracking-widest w-14 ${won ? "text-emerald-400" : "text-rose-400"}`}>{won ? "WIN" : "LOSS"}</span>
        <span className="font-mono text-lg" title="Your team – opponents"><span className={my === 0 ? "text-team-a" : "text-team-b"}>{m.scores[my]}</span>–<span className={my === 0 ? "text-team-b" : "text-team-a"}>{m.scores[1 - my]}</span></span>
        <div className="flex -space-x-2">{m.players.map((p) => <PlayerAvatar key={p.seat} user={p} size={28} />)}</div>
        <span className="text-xs text-muted-foreground">{m.is_public ? "Public" : "Private"} · to {m.target} · {m.rounds.length} round{m.rounds.length === 1 ? "" : "s"}{forfeit ? " · Forfeit" : ""}{m.has_bots ? " · Practice vs bots" : ""}</span>
        <span className="ml-auto text-xs text-muted-foreground">{new Date(m.finished_at).toLocaleString()}</span>
      </button>
      {open && (
        <div className="px-4 pb-4 grid sm:grid-cols-2 gap-6 text-sm">
          <div>
            {[0, 1].map((t) => (
              <div key={t} className="mb-2">
                <span className={`text-xs font-bold ${t === 0 ? "text-team-a" : "text-team-b"}`}>{TEAM_NAME[t]}{m.winner_team === t ? " · Winner" : ""}</span>
                <div>{m.players.filter((p) => p.team === t).map((p) => p.username).join(" & ")}</div>
              </div>
            ))}
          </div>
          <div className="space-y-1">
            {m.rounds.map((r) => (
              <div key={r.round} className="flex justify-between text-xs">
                <span>Round {r.round} · {TEAM_NAME[r.winner_team]}</span>
                <span className="text-muted-foreground">{VICTORY_LABEL[r.type]} +{r.points}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function History() {
  const { api, me } = useApp();
  const [matches, setMatches] = useState(null);
  useEffect(() => { api.get("/matches").then((r) => setMatches(r.data)).catch(() => setMatches([])); }, [api]);
  return (
    <div data-testid="history-page">
      <p className="eyebrow">Your games</p>
      <h1 className="font-display text-4xl mt-2">Match history</h1>
      <div className="mt-8 space-y-2">
        {matches === null ? <p className="text-muted-foreground">Loading…</p>
          : matches.length === 0 ? <p className="text-muted-foreground" data-testid="history-empty">No completed matches yet. Finish a game to see it here.</p>
          : matches.map((m) => <MatchRow key={m.id} m={m} meId={me.user_id} />)}
      </div>
    </div>
  );
}
