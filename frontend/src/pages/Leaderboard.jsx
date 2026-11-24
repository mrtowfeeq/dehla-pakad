import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useApp } from "@/context/AppContext";
import { PlayerAvatar } from "@/components/PlayerAvatar";

export default function Leaderboard() {
  const { api, me } = useApp();
  const [rows, setRows] = useState(null);
  useEffect(() => { api.get("/leaderboard").then((r) => setRows(r.data)).catch(() => setRows([])); }, [api]);
  return (
    <div data-testid="leaderboard-page">
      <p className="eyebrow">Hall of tens</p>
      <h1 className="font-display text-4xl mt-2">Leaderboard</h1>
      <div className="mt-8 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="eyebrow text-left border-b border-border">
              <th className="py-3 pr-3">#</th><th className="py-3 pr-3">Player</th><th className="py-3 px-3 text-right">Wins</th>
              <th className="py-3 px-3 text-right">Games</th><th className="py-3 px-3 text-right">Win %</th>
              <th className="py-3 px-3 text-right hidden sm:table-cell">Koth</th><th className="py-3 pl-3 text-right hidden sm:table-cell">13 Mann</th>
            </tr>
          </thead>
          <tbody>
            {(rows || []).map((r) => (
              <tr key={r.user_id} className={`border-b border-border ${r.user_id === me.user_id ? "bg-primary/10" : ""}`} data-testid={`leaderboard-row-${r.rank}`}>
                <td className={`py-3 pr-3 font-mono font-bold ${r.rank <= 3 ? "text-primary" : ""}`}>{r.rank}</td>
                <td className="py-3 pr-3">
                  <Link to={`/profile/${r.username}`} className="flex items-center gap-3 hover:text-primary">
                    <PlayerAvatar user={r} size={30} online={r.online} /><span className="font-semibold">{r.username}</span>
                  </Link>
                </td>
                <td className="py-3 px-3 text-right font-mono">{r.stats.wins}</td>
                <td className="py-3 px-3 text-right font-mono">{r.stats.games_played}</td>
                <td className="py-3 px-3 text-right font-mono">{r.win_rate}%</td>
                <td className="py-3 px-3 text-right font-mono hidden sm:table-cell">{r.stats.koth_wins}</td>
                <td className="py-3 pl-3 text-right font-mono hidden sm:table-cell">{r.stats.grand_slam_wins}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows?.length === 0 && <p className="text-muted-foreground mt-6">No players ranked yet.</p>}
      </div>
    </div>
  );
}
