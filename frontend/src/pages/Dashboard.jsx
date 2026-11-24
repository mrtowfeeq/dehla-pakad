import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Swords, DoorOpen, KeyRound, Play, Mail } from "lucide-react";
import { useApp, useSocketEvent } from "@/context/AppContext";
import { errMsg } from "@/lib/api";
import { PlayerAvatar } from "@/components/PlayerAvatar";

function StatTile({ label, value, testId }) {
  return (
    <div className="py-4">
      <div className="font-mono text-2xl font-bold" data-testid={testId}>{value}</div>
      <div className="eyebrow mt-1">{label}</div>
    </div>
  );
}

export default function Dashboard() {
  const { me, api, refreshMe } = useApp();
  const navigate = useNavigate();
  const [code, setCode] = useState("");
  const [invites, setInvites] = useState([]);
  const s = me.stats;

  const loadInvites = () => api.get("/invitations").then((r) => setInvites(r.data)).catch(() => {});
  useEffect(() => { refreshMe(); loadInvites(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useSocketEvent((m) => { if (m.type === "invitation") loadInvites(); });

  const join = async (e) => {
    e?.preventDefault();
    try {
      const { data } = await api.post(`/rooms/${code.trim().toUpperCase()}/join`);
      navigate(`/room/${data.code}`);
    } catch (err) { toast.error(errMsg(err)); }
  };
  const decline = async (id) => { await api.post(`/invitations/${id}/decline`); loadInvites(); };

  return (
    <div className="space-y-12" data-testid="dashboard-page">
      <section className="flex flex-col sm:flex-row sm:items-center gap-5 rise">
        <PlayerAvatar user={me} size={64} />
        <div>
          <p className="eyebrow">Welcome back</p>
          <h1 className="font-display text-3xl sm:text-4xl" data-testid="dashboard-username">{me.username}</h1>
        </div>
      </section>

      {(me.active_game_id || me.lobby_code) && (
        <div className="panel p-5 flex flex-wrap items-center gap-4 border-primary/50" data-testid="rejoin-banner">
          <Play className="text-primary" />
          <div className="flex-1 min-w-[200px]">
            <div className="font-bold">{me.active_game_id ? "You have a match in progress" : "You are seated in a lobby"}</div>
            <div className="text-sm text-muted-foreground">Your seat is being held for you.</div>
          </div>
          <button className="btn-gold" data-testid="rejoin-btn"
            onClick={() => navigate(me.active_game_id ? `/game/${me.active_game_id}` : `/room/${me.lobby_code}`)}>
            {me.active_game_id ? "Rejoin match" : "Back to lobby"}
          </button>
        </div>
      )}

      <section className="grid md:grid-cols-3 gap-4">
        <Link to="/play" className="panel p-6 group hover:border-primary/60 transition-colors" data-testid="dashboard-quick-match">
          <Swords className="text-primary" />
          <div className="font-display text-xl mt-6">Quick match</div>
          <p className="text-sm text-muted-foreground mt-1">Join the public queue. Teams are random.</p>
        </Link>
        <Link to="/rooms/new" className="panel p-6 group hover:border-primary/60 transition-colors" data-testid="create-room-btn">
          <DoorOpen className="text-primary" />
          <div className="font-display text-xl mt-6">Private room</div>
          <p className="text-sm text-muted-foreground mt-1">Host a table, pick teams, dealer and target.</p>
        </Link>
        <form onSubmit={join} className="panel p-6">
          <KeyRound className="text-primary" />
          <div className="font-display text-xl mt-6">Join with code</div>
          <div className="flex gap-2 mt-3">
            <input data-testid="join-code-input" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={6}
              placeholder="ABC123" className="flex-1 min-w-0 rounded-xl bg-background border border-input px-3 py-2 font-mono tracking-widest outline-none focus:ring-2 focus:ring-ring" />
            <button className="btn-gold !px-4" disabled={code.length !== 6} data-testid="join-room-btn">Join</button>
          </div>
        </form>
      </section>

      {invites.length > 0 && (
        <section>
          <h2 className="eyebrow mb-3">Invitations</h2>
          <div className="space-y-2">
            {invites.map((i) => (
              <div key={i.id} className="panel p-4 flex items-center gap-3" data-testid={`invitation-${i.id}`}>
                <Mail size={18} className="text-primary" />
                <div className="flex-1 text-sm"><b>{i.from_username}</b> invited you · <span className="font-mono">{i.room_code}</span> · {i.open_seats} open seat(s)</div>
                <button className="btn-gold !py-1.5 text-sm" onClick={() => navigate(`/join/${i.room_code}`)} data-testid={`accept-invite-${i.id}`}>Join</button>
                <button className="btn-ghost !py-1.5 text-sm" onClick={() => decline(i.id)} data-testid={`decline-invite-${i.id}`}>Decline</button>
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className="eyebrow mb-2">Your record</h2>
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-x-6 border-y border-border">
          <StatTile label="Games" value={s.games_played} testId="stat-games" />
          <StatTile label="Wins" value={s.wins} testId="stat-wins" />
          <StatTile label="Losses" value={s.losses} testId="stat-losses" />
          <StatTile label="Normal" value={s.normal_wins} testId="stat-normal" />
          <StatTile label="Koth" value={s.koth_wins} testId="stat-koth" />
          <StatTile label="13 Mann" value={s.grand_slam_wins} testId="stat-grand-slam" />
        </div>
      </section>
    </div>
  );
}
