import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Search } from "lucide-react";
import { PlayerAvatar } from "@/components/PlayerAvatar";
import { useApp } from "@/context/AppContext";
import { errMsg } from "@/lib/api";

const PAGE_SIZE = 25;

function dateLabel(value) {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleDateString();
}

function Status({ status }) {
  const styles = status === "banned"
    ? "border-rose-300/25 bg-rose-300/10 text-rose-100"
    : status === "suspended"
      ? "border-amber-300/25 bg-amber-300/10 text-amber-100"
      : "border-emerald-300/25 bg-emerald-300/10 text-emerald-100";
  return <span className={`inline-flex rounded-full border px-2 py-1 text-[9px] font-bold uppercase tracking-wider ${styles}`}>{status || "active"}</span>;
}

export default function AdminPlayers() {
  const { api } = useApp();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [after, setAfter] = useState("");
  const [before, setBefore] = useState("");
  const [sort, setSort] = useState("registered_desc");
  const [page, setPage] = useState(0);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    let timer;
    const load = async () => {
      setLoading(true);
      const params = new URLSearchParams({ offset: String(page * PAGE_SIZE), limit: String(PAGE_SIZE), sort });
      if (query.trim()) params.set("q", query.trim());
      if (status) params.set("status", status);
      if (after) params.set("registered_after", new Date(`${after}T00:00:00Z`).toISOString());
      if (before) params.set("registered_before", new Date(`${before}T23:59:59.999Z`).toISOString());
      try {
        const { data: result } = await api.get(`/admin/players?${params.toString()}`);
        if (!cancelled) { setData(result); setError(""); }
      } catch (failure) {
        if (!cancelled) setError(errMsg(failure));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    if (query.trim()) timer = setTimeout(() => { void load(); }, 250);
    else void load();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [api, query, status, after, before, sort, page]);

  const total = data?.total || 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-5" data-testid="admin-player-directory">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div><p className="eyebrow">Player operations</p><h2 className="mt-2 font-display text-2xl sm:text-3xl">Player directory</h2><p className="mt-1 text-xs text-white/45">Search accounts and review server-recorded activity.</p></div>
        <span className="rounded-full border border-white/10 bg-black/20 px-3 py-1.5 text-xs text-white/60">{total.toLocaleString()} players</span>
      </header>

      <section className="grid gap-3 rounded-2xl border border-white/10 bg-[#071710]/80 p-3 sm:grid-cols-2 xl:grid-cols-[minmax(220px,1.5fr)_repeat(3,minmax(130px,1fr))_minmax(150px,1fr)]" aria-label="Player filters">
        <label className="relative block sm:col-span-2 xl:col-span-1"><span className="sr-only">Search username or user ID</span><Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-white/35" /><input value={query} onChange={(event) => { setPage(0); setQuery(event.target.value); }} maxLength={80} placeholder="Username or user ID" className="w-full rounded-xl border border-white/10 bg-black/20 py-2.5 pl-9 pr-3 text-xs text-white outline-none placeholder:text-white/35 focus:border-amber-200/40" data-testid="admin-player-search" /></label>
        <label className="text-[10px] font-semibold uppercase tracking-wider text-white/45">Account status<select value={status} onChange={(event) => { setPage(0); setStatus(event.target.value); }} className="mt-1 block w-full rounded-xl border border-white/10 bg-[#0b1a14] px-2.5 py-2 text-xs text-white" data-testid="admin-player-status-filter"><option value="">All statuses</option><option value="active">Active</option><option value="suspended">Suspended</option><option value="banned">Banned</option></select></label>
        <label className="text-[10px] font-semibold uppercase tracking-wider text-white/45">Registered after<input type="date" value={after} onChange={(event) => { setPage(0); setAfter(event.target.value); }} className="mt-1 block w-full rounded-xl border border-white/10 bg-[#0b1a14] px-2.5 py-2 text-xs text-white" /></label>
        <label className="text-[10px] font-semibold uppercase tracking-wider text-white/45">Registered before<input type="date" value={before} onChange={(event) => { setPage(0); setBefore(event.target.value); }} className="mt-1 block w-full rounded-xl border border-white/10 bg-[#0b1a14] px-2.5 py-2 text-xs text-white" /></label>
        <label className="text-[10px] font-semibold uppercase tracking-wider text-white/45">Sort by<select value={sort} onChange={(event) => { setPage(0); setSort(event.target.value); }} className="mt-1 block w-full rounded-xl border border-white/10 bg-[#0b1a14] px-2.5 py-2 text-xs text-white"><option value="registered_desc">Recently registered</option><option value="registered_asc">Oldest registration</option><option value="username_asc">Username</option><option value="games_desc">Most games</option><option value="wins_desc">Most wins</option><option value="last_active_desc">Recently active</option><option value="last_active_asc">Least recently active</option></select></label>
      </section>

      {error && <p role="alert" className="rounded-xl border border-rose-300/20 bg-rose-300/5 p-3 text-xs text-rose-100">{error}</p>}
      <section className="overflow-hidden rounded-2xl border border-white/10 bg-[#071710]/80">
        {loading && !data ? <p className="p-5 text-sm text-white/55">Loading players…</p> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[950px] text-left text-xs">
              <thead className="border-b border-white/10 text-[9px] uppercase tracking-wider text-white/40"><tr><th className="px-4 py-3">Player</th><th className="px-4 py-3">User ID</th><th className="px-4 py-3">Registered</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Level · XP</th><th className="px-4 py-3">Games · W/L</th><th className="px-4 py-3">Last active</th></tr></thead>
              <tbody className="divide-y divide-white/5">
                {(data?.items || []).map((player) => <tr key={player.user_id} data-testid={`admin-player-${player.user_id}`}>
                  <td className="px-4 py-3"><Link to={`/admin/players/${encodeURIComponent(player.user_id)}`} className="inline-flex items-center gap-2.5 hover:text-amber-100"><PlayerAvatar user={player} size={32} online={player.online} /><span><b className="block text-white">{player.display_name || player.username || "Player"}</b><span className="text-white/40">{player.username ? `@${player.username}` : "No username"}</span></span></Link></td>
                  <td className="px-4 py-3 font-mono text-[10px] text-white/50">{player.user_id}</td>
                  <td className="px-4 py-3 text-white/65">{dateLabel(player.created_at)}</td>
                  <td className="px-4 py-3"><Status status={player.account_status} /></td>
                  <td className="px-4 py-3 font-mono text-white/65">{player.level ?? "—"} · {player.xp ?? "—"}</td>
                  <td className="px-4 py-3 font-mono text-white/65">{player.games_played ?? "—"} · {player.wins ?? "—"}/{player.losses ?? "—"}</td>
                  <td className="px-4 py-3 text-white/55">{player.last_active_at ? `${dateLabel(player.last_active_at)}${player.online ? " · online" : ""}` : "Never"}</td>
                </tr>)}
              </tbody>
            </table>
            {!data?.items?.length && <p className="p-6 text-center text-sm text-white/45">No players match these filters.</p>}
          </div>
        )}
        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-white/10 px-4 py-3 text-xs text-white/50">
          <span>{loading ? "Updating…" : total ? `${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, total)} of ${total}` : "0 players"}</span>
          <div className="flex gap-2"><button type="button" disabled={page === 0 || loading} onClick={() => setPage((current) => Math.max(0, current - 1))} className="rounded-lg border border-white/10 px-3 py-1.5 disabled:opacity-35">Previous</button><span className="px-1 py-1.5">Page {page + 1} / {pageCount}</span><button type="button" disabled={page + 1 >= pageCount || loading} onClick={() => setPage((current) => current + 1)} className="rounded-lg border border-white/10 px-3 py-1.5 disabled:opacity-35">Next</button></div>
        </footer>
      </section>
    </div>
  );
}
