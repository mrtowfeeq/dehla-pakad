import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { toast } from "sonner";
import { UserPlus, Check } from "lucide-react";
import { useApp } from "@/context/AppContext";
import { errMsg } from "@/lib/api";
import { PlayerAvatar } from "@/components/PlayerAvatar";
import { MatchRow } from "@/pages/History";

export default function Profile() {
  const { username } = useParams();
  const { api, connected } = useApp();
  const [p, setP] = useState(null);
  const [error, setError] = useState(null);
  const load = () => api.get(`/users/${username}`).then((r) => setP(r.data)).catch((e) => setError(errMsg(e)));
  useEffect(() => { setP(null); setError(null); load(); }, [username]); // eslint-disable-line react-hooks/exhaustive-deps

  const addFriend = async () => {
    try { await api.post("/friends/requests", { username: p.username }); toast.success("Friend request sent"); load(); } catch (e) { toast.error(errMsg(e)); }
  };
  if (error) return <div className="text-muted-foreground" data-testid="profile-error">{error}</div>;
  if (!p) return <div className="text-muted-foreground">Loading…</div>;
  const s = p.stats;
  const rate = s.games_played ? Math.round((100 * s.wins) / s.games_played) : 0;

  return (
    <div className="space-y-12" data-testid="profile-page">
      <section className="flex flex-wrap items-center gap-6">
        <PlayerAvatar user={p} size={88} online={p.is_me ? connected : p.online} />
        <div className="flex-1 min-w-[200px]">
          <p className="eyebrow">{(p.is_me ? connected : p.online) ? "Online now" : "Offline"}</p>
          <h1 className="font-display text-4xl mt-1" data-testid="profile-username">{p.username}</h1>
          <p className="text-sm text-muted-foreground mt-1">Joined {p.created_at ? new Date(p.created_at).toLocaleDateString() : "—"}</p>
        </div>
        {p.is_me ? <Link to="/settings" className="btn-ghost" data-testid="edit-profile-btn">Edit profile</Link>
          : p.is_friend ? <span className="inline-flex items-center gap-1 text-emerald-400 font-semibold" data-testid="profile-friend-badge"><Check size={16} /> Friends</span>
          : p.pending_request ? <span className="text-muted-foreground text-sm" data-testid="profile-pending">Request pending</span>
          : <button className="btn-gold" onClick={addFriend} data-testid="profile-add-friend-btn"><UserPlus size={16} /> Add friend</button>}
      </section>
      <section className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-border rounded-2xl overflow-hidden border border-border">
        {[["Games played", s.games_played], ["Wins", s.wins], ["Losses", s.losses], ["Win rate", `${rate}%`],
          ["Normal Wins", s.normal_wins], ["Koth Wins", s.koth_wins], ["Grand Slams", s.grand_slam_wins], ["Rounds won", s.rounds_won]].map(([l, v]) => (
          <div key={l} className="bg-card p-5">
            <div className="font-mono text-3xl font-bold" data-testid={`profile-stat-${l.toLowerCase().replace(/\s+/g, "-")}`}>{v}</div>
            <div className="eyebrow mt-1">{l}</div>
          </div>
        ))}
      </section>
      <section>
        <h2 className="eyebrow mb-3">Recent matches</h2>
        {p.recent_matches.length === 0 ? <p className="text-sm text-muted-foreground">No completed matches yet.</p>
          : <div className="space-y-2">{p.recent_matches.map((m) => <MatchRow key={m.id} m={m} meId={p.user_id} />)}</div>}
      </section>
    </div>
  );
}
