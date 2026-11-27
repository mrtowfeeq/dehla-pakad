import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { Search, UserPlus, Check, X, UserMinus, Users, Inbox, Send, Trophy, Star, Clock, Medal } from "lucide-react";
import { useApp, useSocketEvent } from "@/context/AppContext";
import { errMsg } from "@/lib/api";
import { PlayerAvatar } from "@/components/PlayerAvatar";

export function lastSeenText(value, now = Date.now()) {
  const t = Date.parse(value || "");
  if (!Number.isFinite(t)) return "Offline";
  const minutes = Math.max(0, Math.floor((now - t) / 60000));
  if (minutes < 1) return "Seen just now";
  if (minutes < 60) return `Seen ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Seen ${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `Seen ${days}d ago` : "Offline";
}

function PlayerCard({ u, children, testId, compact = false }) {
  const level = u.progression?.level;
  return (
    <div data-testid={testId}
      className={`group flex items-center gap-3 rounded-2xl border bg-gradient-to-br p-3 transition-colors ${u.online
        ? "border-emerald-300/25 from-emerald-400/[0.08] to-transparent hover:border-emerald-300/45"
        : "border-white/10 from-white/[0.04] to-transparent hover:border-white/20"}`}>
      <div className="relative shrink-0">
        <PlayerAvatar user={u} size={compact ? 36 : 44} online={u.online} />
      </div>
      <Link to={`/profile/${u.username}`} className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-semibold group-hover:text-amber-200">{u.display_name || u.username}</span>
          {level ? <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full border border-amber-200/30 bg-amber-200/10 px-1.5 py-px text-[9px] font-bold text-amber-200"><Star size={9} aria-hidden="true" />Lv {level}</span> : null}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 whitespace-nowrap text-xs text-muted-foreground">
          <span className={`inline-flex items-center gap-1 ${u.online ? "text-emerald-300" : ""}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${u.online ? "bg-emerald-400" : "bg-white/25"}`} aria-hidden="true" />
            {u.online ? "Online" : lastSeenText(u.last_seen)}
          </span>
          <span className="inline-flex items-center gap-1"><Trophy size={11} aria-hidden="true" />{u.stats?.wins ?? 0} wins</span>
          <span className="inline-flex items-center gap-1 text-orange-200/80" data-testid={`${testId}-medals`} title="Lifetime medals"><Medal size={11} aria-hidden="true" />{Number(u.medals || 0).toLocaleString("en-IN")}</span>
        </div>
      </Link>
      {children}
    </div>
  );
}

// You and your friends ranked by lifetime medals (public totals only).
function MedalTable({ me, friends }) {
  const rows = [{ ...me, isMe: true }, ...friends]
    .map((u) => ({ ...u, medals: Number(u.medals) || 0 }))
    .sort((a, b) => b.medals - a.medals || (a.isMe ? -1 : b.isMe ? 1 : 0) || String(a.username).localeCompare(String(b.username)))
    .slice(0, 6);
  return (
    <ol className="space-y-1.5" data-testid="friends-medal-table">
      {rows.map((u, i) => (
        <li key={u.user_id || "me"} className={`flex items-center gap-2.5 rounded-xl border px-2.5 py-1.5 text-sm ${u.isMe ? "border-orange-200/50 bg-orange-300/10" : "border-white/10 bg-black/20"}`}
          data-testid={`friends-medal-row-${i + 1}`}>
          <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-lg font-mono text-xs font-bold ${i === 0 ? "bg-gradient-to-br from-amber-100 to-amber-400 text-slate-950" : "bg-white/5 text-white/60"}`}>{i + 1}</span>
          {u.isMe ? <span className="min-w-0 flex-1 truncate font-semibold text-orange-100">You</span>
            : <Link to={`/profile/${u.username}`} className="min-w-0 flex-1 truncate hover:text-amber-200">{u.display_name || u.username}</Link>}
          <span className="inline-flex shrink-0 items-center gap-1 font-mono text-xs font-bold text-orange-200"><Medal size={12} aria-hidden="true" />{u.medals.toLocaleString("en-IN")}</span>
        </li>
      ))}
    </ol>
  );
}

function Panel({ title, Icon, count, children, testId }) {
  return (
    <section className="rounded-3xl border border-white/10 bg-gradient-to-b from-[#121c30] to-[#0b1222] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,.06)] sm:p-5" data-testid={testId}>
      <div className="mb-3 flex items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-amber-300/15 text-amber-200" aria-hidden="true"><Icon size={16} /></span>
        <h2 className="font-display text-lg">{title}</h2>
        {count !== undefined && <span className={`ml-auto rounded-full px-2 py-0.5 text-[11px] font-bold ${count ? "bg-amber-300 text-slate-950" : "bg-white/10 text-white/60"}`}>{count}</span>}
      </div>
      {children}
    </section>
  );
}

export default function Friends() {
  const { api, me } = useApp();
  const [friends, setFriends] = useState([]);
  const [reqs, setReqs] = useState({ incoming: [], outgoing: [] });
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);
  const searchRef = useRef(null);

  const load = () => {
    api.get("/friends").then((r) => setFriends(r.data)).catch(() => {});
    api.get("/friends/requests").then((r) => setReqs(r.data)).catch(() => {});
  };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps
  useSocketEvent((m) => {
    if (m.type === "presence") setFriends((fs) => fs.map((f) => (f.user_id === m.user_id ? { ...f, online: m.online } : f)));
    if (m.type === "friend_request" || m.type === "friend_accepted") load();
  });
  useEffect(() => {
    if (!q.trim()) return setResults([]);
    const t = setTimeout(() => api.get("/users/search", { params: { q } }).then((r) => setResults(r.data)).catch(() => {}), 250);
    return () => clearTimeout(t);
  }, [q, api]);

  const run = async (fn, ok) => { try { await fn(); if (ok) toast.success(ok); load(); } catch (e) { toast.error(errMsg(e)); } };
  const friendIds = new Set(friends.map((f) => f.user_id));
  const pendingIds = new Set(reqs.outgoing.map((r) => r.user?.user_id));
  const online = friends.filter((f) => f.online);
  const offline = friends.filter((f) => !f.online);

  const friendCard = (f) => (
    <PlayerCard key={f.user_id} u={f} testId={`friend-row-${f.username}`}>
      <button className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-white/60 transition-colors hover:border-rose-300/40 hover:text-rose-200"
        onClick={() => run(() => api.delete(`/friends/${f.user_id}`), "Friend removed")} data-testid={`remove-friend-${f.username}`}
        aria-label={`Remove ${f.username} from friends`} title="Remove friend">
        <UserMinus size={14} />
      </button>
    </PlayerCard>
  );

  return (
    <div className="space-y-6" data-testid="friends-page">
      <section className="relative overflow-hidden rounded-3xl border border-amber-300/25 bg-gradient-to-br from-[#1b2a4a] via-[#111a30] to-[#0a1120] p-5 shadow-[0_24px_60px_-30px_rgba(0,0,0,.95)] sm:p-7">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_85%_0%,rgba(251,191,36,.14),transparent_55%)]" aria-hidden="true" />
        <div className="relative flex flex-wrap items-center gap-4">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-200 to-amber-500 text-slate-950 shadow-[inset_0_2px_0_rgba(255,255,255,.4),0_10px_22px_-10px_rgba(0,0,0,.9)]" aria-hidden="true"><Users size={26} /></span>
          <div className="min-w-0 flex-1">
            <p className="eyebrow !text-amber-200/70">Your circle</p>
            <h1 className="font-display text-4xl text-amber-50">Friends</h1>
          </div>
          <div className="flex gap-2" data-testid="friends-summary">
            {[["Friends", friends.length, "text-white"], ["Online", online.length, "text-emerald-300"], ["Requests", reqs.incoming.length, "text-amber-200"]].map(([label, value, tone]) => (
              <div key={label} className="min-w-[72px] rounded-2xl border border-white/10 bg-black/25 px-3 py-2 text-center">
                <div className={`font-mono text-xl font-bold leading-none ${tone}`}>{value}</div>
                <div className="mt-1 text-[10px] uppercase tracking-wider text-white/50">{label}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="space-y-6">
          {friends.length === 0 ? (
            <section className="flex flex-col items-center rounded-3xl border border-dashed border-white/15 bg-white/[0.02] px-6 py-10 text-center" data-testid="friends-empty">
              <div className="relative h-16 w-28" aria-hidden="true">
                <span className="absolute left-0 top-2 flex h-12 w-12 items-center justify-center rounded-full bg-sky-400/20 ring-2 ring-sky-300/50"><Users size={20} className="text-sky-200" /></span>
                <span className="absolute right-0 top-2 flex h-12 w-12 items-center justify-center rounded-full bg-amber-400/20 ring-2 ring-amber-300/50"><UserPlus size={20} className="text-amber-200" /></span>
              </div>
              <h2 className="mt-4 font-display text-2xl">Build your table</h2>
              <p className="mt-1 max-w-sm text-sm text-muted-foreground">No friends yet — search for players to add them, then invite them straight into your private rooms.</p>
              <button className="btn-gold mt-5" onClick={() => searchRef.current?.focus()} data-testid="friends-empty-search"><Search size={16} aria-hidden="true" /> Find players</button>
            </section>
          ) : (
            <>
              {online.length > 0 && (
                <section data-testid="friends-online">
                  <h2 className="eyebrow mb-3 inline-flex items-center gap-2"><span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" aria-hidden="true" />Online now · {online.length}</h2>
                  <div className="grid gap-2 sm:grid-cols-2">{online.map(friendCard)}</div>
                </section>
              )}
              {offline.length > 0 && (
                <section data-testid="friends-offline">
                  <h2 className="eyebrow mb-3">Offline · {offline.length}</h2>
                  <div className="grid gap-2 sm:grid-cols-2">{offline.map(friendCard)}</div>
                </section>
              )}
            </>
          )}
        </div>

        <aside className="space-y-6">
          {friends.length > 0 && me && (
            <Panel title="Medal table" Icon={Medal} testId="friends-medal-panel">
              <MedalTable me={me} friends={friends} />
              <Link to="/leaderboard?board=medals" className="mt-3 inline-block text-xs font-semibold text-amber-200 hover:text-amber-100">Full medal leaderboard →</Link>
            </Panel>
          )}
          <Panel title="Find players" Icon={Search} testId="friends-find-panel">
            <div className="relative">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <input ref={searchRef} data-testid="friend-search-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search username"
                aria-label="Search players by username" autoComplete="off"
                className="w-full rounded-xl border border-white/15 bg-black/40 py-2.5 pl-9 pr-3 shadow-[inset_0_2px_6px_rgba(0,0,0,.5)] outline-none placeholder:text-white/30 focus:border-amber-300/60 focus:ring-2 focus:ring-amber-300/30" />
            </div>
            {q.trim() && results.length === 0 && <p className="mt-3 text-xs text-muted-foreground" data-testid="friend-search-empty">No players match “{q.trim()}”.</p>}
            <div className="mt-3 space-y-2">
              {results.map((u) => (
                <PlayerCard key={u.user_id} u={u} compact testId={`search-result-${u.username}`}>
                  {friendIds.has(u.user_id) ? (
                    <span className="inline-flex items-center gap-1 rounded-lg bg-emerald-400/15 px-2 py-1 text-xs font-semibold text-emerald-300"><Check size={13} aria-hidden="true" />Friend</span>
                  ) : pendingIds.has(u.user_id) ? (
                    <span className="inline-flex items-center gap-1 rounded-lg bg-white/10 px-2 py-1 text-xs font-semibold text-white/60"><Clock size={13} aria-hidden="true" />Sent</span>
                  ) : (
                    <button className="btn-gold !px-2.5 !py-1.5 text-xs" onClick={() => run(() => api.post("/friends/requests", { username: u.username }), "Request sent")} data-testid={`add-friend-${u.username}`}>
                      <UserPlus size={14} aria-hidden="true" /> Add
                    </button>
                  )}
                </PlayerCard>
              ))}
            </div>
          </Panel>

          <Panel title="Requests" Icon={Inbox} count={reqs.incoming.length} testId="friends-requests-panel">
            {reqs.incoming.length === 0 && <p className="text-sm text-muted-foreground">No pending requests.</p>}
            <div className="space-y-2">
              {reqs.incoming.map((r) => (
                <PlayerCard key={r.id} u={r.user} compact testId={`incoming-request-${r.user.username}`}>
                  <button className="btn-gold !px-2.5 !py-1.5" onClick={() => run(() => api.post(`/friends/requests/${r.id}/accept`), "Friend added")} data-testid={`accept-request-${r.user.username}`} aria-label={`Accept ${r.user.username}`}><Check size={14} /></button>
                  <button className="btn-ghost !px-2.5 !py-1.5" onClick={() => run(() => api.post(`/friends/requests/${r.id}/decline`))} data-testid={`decline-request-${r.user.username}`} aria-label={`Decline ${r.user.username}`}><X size={14} /></button>
                </PlayerCard>
              ))}
            </div>
            {reqs.outgoing.length > 0 && (
              <>
                <div className="eyebrow mb-2 mt-5 inline-flex items-center gap-1.5"><Send size={12} aria-hidden="true" />Sent · {reqs.outgoing.length}</div>
                <div className="space-y-2">
                  {reqs.outgoing.map((r) => (
                    <PlayerCard key={r.id} u={r.user} compact testId={`outgoing-request-${r.user.username}`}>
                      <span className="inline-flex items-center gap-1 rounded-lg bg-white/10 px-2 py-1 text-xs font-semibold text-white/60"><Clock size={13} aria-hidden="true" />Pending</span>
                    </PlayerCard>
                  ))}
                </div>
              </>
            )}
          </Panel>
        </aside>
      </div>
    </div>
  );
}
