import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { toast } from "sonner";
import { useApp } from "@/context/AppContext";
import { errMsg } from "@/lib/api";
import { PlayerAvatar } from "@/components/PlayerAvatar";

export default function Admin() {
  const { api, me } = useApp();
  const [data, setData] = useState(null);
  const [stats, setStats] = useState(null);
  const load = () => {
    api.get("/users").then((r) => setData(r.data)).catch(() => {});
    api.get("/admin/stats").then((r) => setStats(r.data)).catch(() => {});
  };
  useEffect(() => { if (me.role === "admin") load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (me.role !== "admin") return <Navigate to="/home" replace />;

  const setRole = async (uid, role) => {
    try { await api.patch(`/users/${uid}/role`, { role }); toast.success("Role updated"); load(); } catch (e) { toast.error(errMsg(e)); }
  };

  return (
    <div className="space-y-10" data-testid="admin-page">
      <div>
        <p className="eyebrow">Administration</p>
        <h1 className="font-display text-4xl mt-2">Admin</h1>
      </div>
      {stats && (
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-4">
          {Object.entries(stats).map(([k, v]) => (
            <div key={k}><div className="font-mono text-2xl font-bold" data-testid={`admin-stat-${k}`}>{v}</div><div className="eyebrow mt-1">{k.replace("_", " ")}</div></div>
          ))}
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="eyebrow text-left border-b border-border"><th className="py-3">Player</th><th>Email</th><th>Games</th><th>Role</th></tr></thead>
          <tbody>
            {data?.users.map((u) => (
              <tr key={u.user_id} className="border-b border-border" data-testid={`admin-user-row-${u.user_id}`}>
                <td className="py-3"><div className="flex items-center gap-2"><PlayerAvatar user={u} size={28} online={u.online} />{u.username || <i className="text-muted-foreground">no name</i>}</div></td>
                <td className="text-muted-foreground">{u.email}</td>
                <td className="font-mono">{u.stats.games_played}</td>
                <td>
                  <select value={u.role} onChange={(e) => setRole(u.user_id, e.target.value)} data-testid={`admin-role-select-${u.user_id}`}
                    className="rounded-lg bg-background border border-input px-2 py-1">
                    {data.roles.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">To ban or delete accounts use Manage → Users & Auth in Emergent.</p>
    </div>
  );
}
