import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { Search, UserPlus, Check, X, UserMinus } from "lucide-react";
import { useApp, useSocketEvent } from "@/context/AppContext";
import { errMsg } from "@/lib/api";
import { PlayerAvatar } from "@/components/PlayerAvatar";

function Row({ u, children, testId }) {
  return (
    <div className="flex items-center gap-3 py-3 border-b border-border last:border-0" data-testid={testId}>
      <PlayerAvatar user={u} size={40} online={u.online} />
      <Link to={`/profile/${u.username}`} className="flex-1 min-w-0">
        <div className="font-semibold truncate hover:text-primary">{u.username}</div>
        <div className="text-xs text-muted-foreground">{u.online ? "Online" : "Offline"} · {u.stats.wins} wins</div>
      </Link>
      {children}
    </div>
  );
}

export default function Friends() {
  const { api } = useApp();
  const [friends, setFriends] = useState([]);
  const [reqs, setReqs] = useState({ incoming: [], outgoing: [] });
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);

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

  return (
    <div className="grid lg:grid-cols-[1fr_360px] gap-12" data-testid="friends-page">
      <section>
        <p className="eyebrow">Your circle</p>
        <h1 className="font-display text-4xl mt-2">Friends</h1>
        <div className="mt-8">
          {friends.length === 0 ? <p className="text-muted-foreground text-sm" data-testid="friends-empty">No friends yet — search for players to add them.</p>
            : friends.map((f) => (
              <Row key={f.user_id} u={f} testId={`friend-row-${f.username}`}>
                <button className="btn-ghost !px-2.5 !py-1.5 text-xs" onClick={() => run(() => api.delete(`/friends/${f.user_id}`), "Friend removed")} data-testid={`remove-friend-${f.username}`}>
                  <UserMinus size={14} />
                </button>
              </Row>
            ))}
        </div>
      </section>
      <aside className="space-y-8">
        <div>
          <div className="eyebrow mb-3">Find players</div>
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input data-testid="friend-search-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search username"
              className="w-full rounded-xl bg-background border border-input pl-9 pr-3 py-2.5 outline-none focus:ring-2 focus:ring-ring" />
          </div>
          <div className="mt-2">
            {results.map((u) => (
              <Row key={u.user_id} u={u} testId={`search-result-${u.username}`}>
                {friendIds.has(u.user_id) ? <Check size={16} className="text-emerald-400" /> : (
                  <button className="btn-gold !px-2.5 !py-1.5 text-xs" onClick={() => run(() => api.post("/friends/requests", { username: u.username }), "Request sent")} data-testid={`add-friend-${u.username}`}>
                    <UserPlus size={14} /> Add
                  </button>
                )}
              </Row>
            ))}
          </div>
        </div>
        <div>
          <div className="eyebrow mb-2">Requests ({reqs.incoming.length})</div>
          {reqs.incoming.length === 0 && <p className="text-xs text-muted-foreground">No pending requests.</p>}
          {reqs.incoming.map((r) => (
            <Row key={r.id} u={r.user} testId={`incoming-request-${r.user.username}`}>
              <button className="btn-gold !px-2.5 !py-1.5" onClick={() => run(() => api.post(`/friends/requests/${r.id}/accept`), "Friend added")} data-testid={`accept-request-${r.user.username}`}><Check size={14} /></button>
              <button className="btn-ghost !px-2.5 !py-1.5" onClick={() => run(() => api.post(`/friends/requests/${r.id}/decline`))} data-testid={`decline-request-${r.user.username}`}><X size={14} /></button>
            </Row>
          ))}
          {reqs.outgoing.length > 0 && <div className="eyebrow mt-6 mb-2">Sent</div>}
          {reqs.outgoing.map((r) => (
            <Row key={r.id} u={r.user} testId={`outgoing-request-${r.user.username}`}><span className="text-xs text-muted-foreground">Pending</span></Row>
          ))}
        </div>
      </aside>
    </div>
  );
}
