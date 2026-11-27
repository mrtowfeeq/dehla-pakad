import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useApp } from "@/context/AppContext";

const STATUS_STYLES = {
  healthy: "border-emerald-300/25 bg-emerald-300/10 text-emerald-100",
  warning: "border-amber-300/25 bg-amber-300/10 text-amber-100",
  critical: "border-rose-300/25 bg-rose-300/10 text-rose-100",
  unknown: "border-white/15 bg-white/5 text-white/60",
};

function Status({ value = "unknown" }) {
  const rawStatus = String(value).toLowerCase();
  const status = ["pending", "running"].includes(rawStatus) ? "warning" : rawStatus;
  const label = status.charAt(0).toUpperCase() + status.slice(1);
  return <span className={`inline-flex rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider ${STATUS_STYLES[status] || STATUS_STYLES.unknown}`}>{label}</span>;
}

function pretty(value) {
  return value == null ? "—" : JSON.stringify(value);
}

function HealthCard({ title, status, children, testId }) {
  return (
    <section className="min-w-0 rounded-2xl border border-white/10 bg-[#071710]/80 p-4 sm:p-5" data-testid={testId}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        <Status value={status} />
      </div>
      <div className="mt-4 space-y-2 text-xs text-white/65">{children}</div>
    </section>
  );
}

export default function AdminSystemHealth() {
  const { api } = useApp();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await api.get("/admin/system-health");
      setData(response.data);
      setError("");
    } catch {
      // Do not render API or database error details in the diagnostics page.
      setError("System diagnostics could not be refreshed. Check backend availability and admin access.");
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => { refresh(); }, [refresh]);

  const lastVerified = data?.last_verified_at
    ? new Date(data.last_verified_at).toLocaleString()
    : "Not verified yet";
  const indexItems = data?.indexes?.items || [];

  return (
    <div className="space-y-5" data-testid="admin-system-health">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow">Read-only diagnostics</p>
          <h2 className="mt-2 font-display text-2xl sm:text-3xl">System health</h2>
          <p className="mt-1 text-xs text-white/45">Last verification: <time>{lastVerified}</time></p>
        </div>
        <button type="button" onClick={refresh} disabled={loading} className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-xs font-semibold text-white/80 transition hover:bg-white/10 disabled:cursor-wait disabled:opacity-50" data-testid="admin-health-refresh">
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refresh
        </button>
      </header>

      {error && <p role="alert" className="rounded-xl border border-amber-300/20 bg-amber-300/5 p-3 text-xs text-amber-100">{error}</p>}
      {loading && !data && <p className="rounded-2xl border border-white/10 bg-black/20 p-5 text-sm text-white/60">Checking system health…</p>}
      {!loading && !data && !error && <p className="rounded-2xl border border-white/10 bg-black/20 p-5 text-sm text-white/60">No diagnostic data is available.</p>}

      {data && <>
        <section className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/10 bg-black/20 p-4" data-testid="admin-health-summary">
          <div><p className="text-[10px] font-bold uppercase tracking-[0.18em] text-white/40">Overall status</p><p className="mt-1 text-sm text-white/70">Environment: <b className="text-white">{data.environment || "Unknown"}</b></p></div>
          <Status value={data.status} />
        </section>

        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <HealthCard title="MongoDB" status={data.database?.status} testId="admin-health-database">
            <p>Database: <b className="break-all text-white/85">{data.database?.name || "Unavailable"}</b></p>
            <p>Backend uptime: <b className="text-white/85">{Number.isFinite(data.uptime_seconds) ? `${Math.floor(data.uptime_seconds / 60)}m ${data.uptime_seconds % 60}s` : "Unknown"}</b></p>
          </HealthCard>
          <HealthCard title="Index initialization" status={data.index_initialization?.status} testId="admin-health-index-initialization">
            <p>State: <b className="text-white/85">{data.index_initialization?.status || "Unknown"}</b></p>
            <p>Declared indexes attempted: <b className="text-white/85">{data.index_initialization?.attempted ?? "—"}</b></p>
            <p>Failed initializations: <b className="text-white/85">{data.index_initialization?.failures?.length ?? 0}</b></p>
            {data.index_initialization?.completed_at && <p>Completed: <time>{new Date(data.index_initialization.completed_at).toLocaleString()}</time></p>}
            {data.index_initialization?.failures?.length > 0 && <ul className="space-y-1 border-t border-white/10 pt-2 text-rose-100/85" aria-label="Failed index initialization">
              {data.index_initialization.failures.map((failure) => <li key={`${failure.collection}-${failure.index}`}>{failure.collection}.{failure.index} · {failure.error_type}</li>)}
            </ul>}
          </HealthCard>
          <HealthCard title="Spectator TTL index" status={data.spectator_ttl?.status} testId="admin-health-spectator-ttl">
            <p>Declared: <b className="text-white/85">{data.spectator_ttl?.declared?.name || "Unknown"}</b></p>
            <p>Expiry: <b className="text-white/85">{data.spectator_ttl?.declared?.expire_after_seconds === 0 ? "At expires_at" : `${data.spectator_ttl?.declared?.expire_after_seconds ?? "Unknown"} seconds`}</b></p>
            <p>Verified existing: <b className="text-white/85">{data.spectator_ttl?.verification?.verified ? "Yes" : "No"}</b></p>
          </HealthCard>
          <HealthCard title="WebSocket service" status={data.websocket?.status} testId="admin-health-websocket">
            <p>Implementation: <b className="text-white/85">{data.websocket?.implementation || "Unknown"}</b></p>
            <p>Connected clients: <b className="text-white/85">{data.websocket?.connected_clients ?? "Unknown"}</b></p>
          </HealthCard>
        </div>

        <section className="rounded-2xl border border-white/10 bg-[#071710]/80 p-4 sm:p-5" data-testid="admin-health-indexes">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div><h2 className="text-sm font-semibold">Required MongoDB indexes</h2><p className="mt-1 text-xs text-white/45">Declared requirements compared with read-only MongoDB metadata.</p></div>
            <Status value={data.indexes?.status} />
          </div>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-white/55">
            <span>Declared: {data.indexes?.declared_count ?? 0}</span>
            <span>Verified: {data.indexes?.verified_count ?? 0}</span>
            <span>Missing: {data.indexes?.missing_count ?? 0}</span>
            <span>Incompatible: {data.indexes?.incompatible_count ?? 0}</span>
            <span>Unknown: {data.indexes?.unknown_count ?? 0}</span>
          </div>
          <ul className="mt-4 space-y-2">
            {indexItems.map((item) => {
              const verification = item.verification || {};
              return <li key={`${item.collection}-${item.declared?.name}`} className="grid gap-2 rounded-xl border border-white/5 bg-black/15 p-3 text-[11px] sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                <div className="min-w-0">
                  <p className="break-all font-semibold text-white/85">{item.collection}.{item.declared?.name}</p>
                  <p className="mt-1 break-all text-white/50">Declared key: {pretty(item.declared?.key_pattern)}</p>
                  {verification.actual && <p className="mt-1 break-all text-white/45">Existing: {verification.actual.name || "Unnamed"} · {pretty(verification.actual.key_pattern)}</p>}
                  <p className="mt-1 text-white/40">Unique: {item.declared?.unique ? "Yes" : "No"} · Partial filter: {pretty(item.declared?.partial_filter_expression)} · TTL: {item.declared?.expire_after_seconds ?? "—"}</p>
                  {verification.issues?.length > 0 && <p className="mt-1 text-amber-100/80">{verification.issues.join(", ").replaceAll("_", " ")}</p>}
                </div>
                <Status value={verification.status} />
              </li>;
            })}
          </ul>
        </section>
      </>}
    </div>
  );
}
