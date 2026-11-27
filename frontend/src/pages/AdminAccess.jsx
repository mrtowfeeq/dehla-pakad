import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { PlayerAvatar } from "@/components/PlayerAvatar";
import { useApp } from "@/context/AppContext";
import { errMsg } from "@/lib/api";

export default function AdminAccess() {
  const { api, me } = useApp();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [pending, setPending] = useState("");
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data: result } = await api.get("/users");
      setData(result);
      setError("");
    } catch (failure) {
      setError(errMsg(failure));
    } finally {
      setLoading(false);
    }
  }, [api]);
  useEffect(() => { if (me.role === "admin") load(); }, [me.role, load]);

  const setRole = async (user, role) => {
    if (role === user.role) return;
    setPending(user.user_id);
    try {
      await api.patch(`/users/${encodeURIComponent(user.user_id)}/role`, { role });
      toast.success("Access role updated");
      await load();
    } catch (failure) {
      toast.error(errMsg(failure));
    } finally {
      setPending("");
    }
  };

  if (me.role !== "admin") return <div className="rounded-xl border border-white/10 bg-black/20 p-5 text-sm text-white/55">Role management requires administrator access.</div>;
  if (loading && !data) return <div className="rounded-xl border border-white/10 bg-black/20 p-5 text-sm text-white/55">Loading role assignments…</div>;
  if (error && !data) return <div className="rounded-xl border border-rose-300/20 bg-rose-300/5 p-5 text-sm text-rose-100" role="alert">{error}</div>;

  return (
    <section className="overflow-hidden rounded-2xl border border-white/10 bg-[#071710]/80" data-testid="admin-access-page">
      <header className="border-b border-white/10 p-4 sm:p-5"><h2 className="text-sm font-semibold">Platform access roles</h2><p className="mt-1 text-xs text-white/45">Role changes are checked and recorded by the backend. Contact and authentication details are not shown.</p></header>
      {error && <p role="alert" className="px-4 pt-3 text-sm text-rose-200">{error}</p>}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-left text-xs">
          <thead className="text-[9px] uppercase tracking-wider text-white/40"><tr><th className="px-4 py-3">Player</th><th className="px-4 py-3">Matches</th><th className="px-4 py-3">Role</th></tr></thead>
          <tbody className="divide-y divide-white/5">
            {(data?.users || []).map((user) => <tr key={user.user_id} data-testid={`admin-user-${user.user_id}`}>
              <td className="px-4 py-3"><div className="flex items-center gap-2"><PlayerAvatar user={user} size={28} online={user.online} /><span><b className="block text-white">{user.display_name || user.username || "Unregistered player"}</b><span className="text-white/40">{user.username ? `@${user.username}` : "No username"}</span></span></div></td>
              <td className="px-4 py-3 font-mono text-white/70">{user.stats?.games_played ?? 0}</td>
              <td className="px-4 py-3"><select value={user.role} disabled={pending === user.user_id} onChange={(event) => setRole(user, event.target.value)} aria-label={`Role for ${user.username || user.user_id}`} data-testid={`admin-role-select-${user.user_id}`} className="rounded-lg border border-white/10 bg-[#0b1a14] px-2 py-1.5 text-white">
                {(data?.roles || []).map((role) => <option key={role} value={role}>{role.replaceAll("_", " ")}</option>)}
              </select></td>
            </tr>)}
          </tbody>
        </table>
      </div>
      {!data?.users?.length && <p className="p-5 text-sm text-white/45">No player accounts are available.</p>}
    </section>
  );
}
