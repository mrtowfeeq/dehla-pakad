import { useEffect, useState } from "react";
import { Activity, Clock3, Gamepad2, ShieldAlert, Users, Wifi } from "lucide-react";
import { useApp } from "@/context/AppContext";
import { errMsg } from "@/lib/api";

const METRICS = [
  ["registered_players", "Registered players", Users],
  ["online_players", "Online now", Wifi],
  ["players_in_games", "Players in games", Gamepad2],
  ["active_public_lobbies", "Public lobbies", Activity],
  ["active_private_lobbies", "Private lobbies", ShieldAlert],
  ["active_matches", "Active matches", Gamepad2],
  ["active_spectators", "Active spectators", Users],
  ["games_completed_today", "Completed today", Clock3],
  ["new_registrations_today", "New players today", Users],
  ["completed_matches", "Completed matches", Activity],
];

function CountChart({ title, rows, testId }) {
  const max = Math.max(1, ...(rows || []).map((row) => Number(row.count) || 0));
  return (
    <section className="rounded-2xl border border-white/10 bg-[#071710]/80 p-4 sm:p-5" data-testid={testId}>
      <h2 className="text-sm font-semibold">{title}</h2>
      {!rows?.length ? <p className="mt-4 text-sm text-white/45">No data available.</p> : (
        <div className="mt-4 flex h-32 items-end gap-1.5" aria-label={title}>
          {rows.map((row) => (
            <div key={row.day} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1" title={`${row.day}: ${row.count}`}>
              <div className="w-full max-w-6 rounded-t bg-gradient-to-t from-emerald-800 to-amber-300/80" style={{ height: `${Math.max(3, (row.count / max) * 100)}%` }} />
              <span className="text-[8px] text-white/35">{row.day.slice(5)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export default function AdminOverview() {
  const { api } = useApp();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api.get("/admin/overview").then(({ data: result }) => {
      if (!cancelled) { setData(result); setError(""); }
    }).catch((failure) => {
      if (!cancelled) setError(errMsg(failure));
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [api]);

  if (loading && !data) return <div className="rounded-2xl border border-white/10 bg-black/20 p-6 text-sm text-white/60">Loading platform metrics…</div>;
  if (!data) return <div className="rounded-2xl border border-rose-300/20 bg-rose-300/5 p-6 text-sm text-rose-100" role="alert">{error || "Admin metrics are unavailable."}</div>;

  return (
    <div className="space-y-5" data-testid="admin-overview">
      {error && <div className="rounded-xl border border-amber-300/20 bg-amber-300/5 p-3 text-sm text-amber-100" role="status">Showing the last loaded metrics. {error}</div>}
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5" data-testid="admin-metrics">
        {METRICS.map(([key, label, Icon]) => (
          <article key={key} className="rounded-2xl border border-white/10 bg-[#071710]/80 p-4" data-testid={`admin-metric-${key}`}>
            <div className="flex items-center justify-between gap-2 text-white/50"><span className="text-xs">{label}</span><Icon size={15} /></div>
            <div className="mt-3 font-mono text-2xl font-bold tabular-nums text-white">{data.metrics?.[key] ?? "—"}</div>
          </article>
        ))}
      </section>
      <div className="grid gap-4 sm:grid-cols-2">
        <CountChart title="New registrations · 14 days" rows={data.charts?.registrations} testId="admin-registration-chart" />
        <CountChart title="Completed matches · 14 days" rows={data.charts?.completed_matches} testId="admin-match-chart" />
        <CountChart title="Public matches · 14 days" rows={data.charts?.public_matches} testId="admin-public-match-chart" />
        <CountChart title="Private matches · 14 days" rows={data.charts?.private_matches} testId="admin-private-match-chart" />
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        <section className="rounded-2xl border border-white/10 bg-[#071710]/80 p-4 sm:p-5" data-testid="admin-recent-activity">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">Recent activity</h2>
            <span className="text-[10px] text-white/40">Live records from the platform</span>
          </div>
          {data.recent_activity?.length ? <ul className="mt-3 divide-y divide-white/5">
            {data.recent_activity.map((item, index) => (
              <li key={`${item.kind}-${item.timestamp}-${index}`} className="flex items-start justify-between gap-4 py-2.5 text-xs">
                <span className="min-w-0 text-white/75">{item.summary}</span>
                <time className="shrink-0 text-white/35">{item.timestamp ? new Date(item.timestamp).toLocaleString() : "—"}</time>
              </li>
            ))}
          </ul> : <p className="mt-4 text-sm text-white/45">No recent activity is available.</p>}
        </section>
        <aside className="rounded-2xl border border-white/10 bg-black/20 p-4 sm:p-5" data-testid="admin-operations-note">
          <h2 className="text-sm font-semibold">Operational notes</h2>
          <p className="mt-2 text-xs leading-relaxed text-white/55">Online counts reflect authenticated WebSocket sessions. Historical online-player trends are not recorded yet, so this dashboard does not estimate them.</p>
          <p className="mt-3 text-xs text-white/45">14-day match completion rate: <b className="text-white/75">{data.metrics?.match_completion_rate_14d == null ? "Not enough data" : `${data.metrics.match_completion_rate_14d}%`}</b></p>
        </aside>
      </div>
    </div>
  );
}
