import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Ban, Clock3, FilePlus2, ShieldCheck, UserRound } from "lucide-react";
import { Link } from "react-router-dom";
import { PlayerAvatar } from "@/components/PlayerAvatar";
import { useApp } from "@/context/AppContext";
import { errMsg } from "@/lib/api";
import { toast } from "sonner";

function dateTime(value) {
  if (!value) return "Not recorded";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "Unknown" : parsed.toLocaleString();
}

function durationLabel(seconds) {
  if (!Number.isFinite(seconds)) return "Not recorded";
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.round(seconds % 60);
  return `${minutes}m ${remaining}s`;
}

function Status({ value }) {
  const styles = value === "banned" ? "border-rose-300/25 bg-rose-300/10 text-rose-100"
    : value === "suspended" ? "border-amber-300/25 bg-amber-300/10 text-amber-100"
      : "border-emerald-300/25 bg-emerald-300/10 text-emerald-100";
  return <span className={`rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider ${styles}`}>{value || "active"}</span>;
}

function Metric({ label, value, testId }) {
  return <article className="rounded-xl border border-white/10 bg-black/15 p-3" data-testid={testId}><p className="text-[10px] text-white/45">{label}</p><p className="mt-1 font-mono text-xl font-bold text-white">{value ?? "—"}</p></article>;
}

function Outcome({ value }) {
  const style = value === "win" ? "border-emerald-300/20 bg-emerald-300/10 text-emerald-100"
    : value === "loss" ? "border-rose-300/20 bg-rose-300/10 text-rose-100"
      : value === "draw" ? "border-amber-200/20 bg-amber-200/10 text-amber-100"
        : "border-white/10 bg-white/5 text-white/55";
  return <span className={`rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase ${style}`}>{value || "unknown"}</span>;
}

export default function AdminPlayerDetail({ playerId }) {
  const { api, me } = useApp();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [durationHours, setDurationHours] = useState("24");
  const [reason, setReason] = useState("");
  const [banReason, setBanReason] = useState("");
  const [unbanReason, setUnbanReason] = useState("");
  const [noteContent, setNoteContent] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const requestVersion = useRef(0);
  const currentPlayerId = useRef(playerId);
  currentPlayerId.current = playerId;

  const load = useCallback(async () => {
    if (currentPlayerId.current !== playerId) return;
    const version = ++requestVersion.current;
    setLoading(true);
    try {
      const { data: result } = await api.get(`/admin/players/${encodeURIComponent(playerId)}`);
      if (version === requestVersion.current) {
        setData(result);
        setError("");
      }
    } catch (failure) {
      if (version === requestVersion.current) setError(errMsg(failure));
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  }, [api, playerId]);
  useEffect(() => {
    setData(null);
    setError("");
    void load();
    return () => { requestVersion.current += 1; };
  }, [load]);

  const isAdmin = me?.role === "admin";
  const canModerate = isAdmin || me?.role === "moderator";
  const canWriteNotes = canModerate;
  const selfTarget = data?.player?.user_id === me?.user_id;
  const status = data?.player?.account_status || "active";

  const runAction = async (path, body, successMessage) => {
    setPending(true);
    try {
      await api.post(`/admin/players/${encodeURIComponent(playerId)}/${path}`, body);
      toast.success(successMessage);
      setConfirmation("");
      setReason("");
      setBanReason("");
      setUnbanReason("");
      await load();
    } catch (failure) {
      toast.error(errMsg(failure));
    } finally {
      setPending(false);
    }
  };

  const addNote = async (event) => {
    event.preventDefault();
    const content = noteContent.trim();
    if (!content) return;
    setPending(true);
    try {
      await api.post(`/admin/players/${encodeURIComponent(playerId)}/notes`, { content });
      setNoteContent("");
      toast.success("Internal note added");
      await load();
    } catch (failure) {
      toast.error(errMsg(failure));
    } finally {
      setPending(false);
    }
  };

  if (loading && !data) return <div className="rounded-2xl border border-white/10 bg-black/20 p-5 text-sm text-white/55">Loading player record…</div>;
  if (!data) return <div className="space-y-3"><p role="alert" className="rounded-xl border border-rose-300/20 bg-rose-300/5 p-4 text-sm text-rose-100">{error || "Player record unavailable."}</p><Link to="/admin/players" className="text-xs text-amber-100">← Back to players</Link></div>;

  const { player, statistics, progression, achievements = [], match_history: matches = [], moderation_history: moderation = [], internal_notes: notes = [], recent_activity: activity = [], recent_performance: recentPerformance = [] } = data;
  const inputClass = "w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-xs text-white outline-none placeholder:text-white/35 focus:border-amber-200/40";

  return (
    <div className="space-y-5" data-testid="admin-player-detail">
      <Link to="/admin/players" className="inline-flex items-center gap-2 text-xs text-white/55 hover:text-white"><ArrowLeft size={14} /> Player directory</Link>
      {error && <p role="status" className="rounded-xl border border-amber-300/20 bg-amber-300/5 p-3 text-xs text-amber-100">Some player data could not be refreshed. {error}</p>}

      <header className="flex flex-wrap items-center gap-4 rounded-2xl border border-white/10 bg-[#071710]/80 p-4 sm:p-5">
        <PlayerAvatar user={player} size={56} online={player.online} />
        <div className="min-w-0 flex-1"><p className="eyebrow">Player profile</p><h2 className="mt-1 break-words font-display text-2xl sm:text-3xl">{player.display_name || player.username || "Player"}</h2><p className="mt-1 text-xs text-white/45">{player.username ? `@${player.username}` : "No username"} · <span className="font-mono">{player.user_id}</span></p></div>
        <Status value={player.account_status} />
      </header>

      <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="rounded-2xl border border-white/10 bg-[#071710]/80 p-4 sm:p-5" data-testid="admin-player-overview">
          <div className="flex items-center gap-2"><UserRound size={15} className="text-amber-100" /><h3 className="text-sm font-semibold">Account information</h3></div>
          <dl className="mt-4 grid gap-3 text-xs sm:grid-cols-2"><div><dt className="text-white/40">Registration</dt><dd className="mt-1 text-white/80">{dateTime(player.created_at)}</dd></div><div><dt className="text-white/40">Last active</dt><dd className="mt-1 text-white/80">{dateTime(player.last_active_at)}</dd></div><div><dt className="text-white/40">Account status</dt><dd className="mt-1"><Status value={player.account_status} /></dd></div><div><dt className="text-white/40">Level · XP</dt><dd className="mt-1 font-mono text-white/80">{progression?.level ?? "—"} · {progression?.xp ?? "—"}</dd></div></dl>
        </div>
        <div className="rounded-2xl border border-white/10 bg-[#071710]/80 p-4 sm:p-5"><div className="flex items-center gap-2"><Clock3 size={15} className="text-amber-100" /><h3 className="text-sm font-semibold">Progression</h3></div><p className="mt-4 text-xs text-white/55">{progression?.xp == null ? "Progression not recorded" : `${progression.xp_in_level} / ${progression.xp_to_next_level} XP toward next level`}</p><div className="mt-2 h-2 overflow-hidden rounded-full bg-white/10">{progression?.progress_percent != null && <div className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-amber-200" style={{ width: `${Math.min(100, Math.max(0, progression.progress_percent))}%` }} />}</div><p className="mt-2 text-right text-[10px] text-white/40">{progression?.progress_percent == null ? "—" : `${progression.progress_percent}%`}</p></div>
      </section>

      <section className="space-y-3" data-testid="admin-player-statistics"><div><p className="eyebrow">Authoritative results</p><h3 className="mt-1 font-display text-xl">Gameplay statistics</h3></div><div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6"><Metric label="Games" value={statistics.games_played} testId="admin-player-games" /><Metric label="Wins" value={statistics.wins} /><Metric label="Losses" value={statistics.losses} /><Metric label="Draws" value={statistics.draws} /><Metric label="Win rate" value={statistics.win_percent == null ? "—" : `${statistics.win_percent}%`} /><Metric label="Avg. duration" value={durationLabel(statistics.average_match_duration_seconds)} /></div><div className="flex flex-wrap items-center gap-2 rounded-xl border border-white/10 bg-black/15 p-3" data-testid="admin-player-recent-performance"><span className="mr-1 text-[10px] font-semibold uppercase tracking-wider text-white/45">Recent performance</span>{recentPerformance.length ? recentPerformance.slice(0, 5).map((outcome, index) => <Outcome key={`${outcome}-${index}`} value={outcome} />) : <span className="text-xs text-white/45">Not recorded</span>}</div></section>

      <section className="rounded-2xl border border-white/10 bg-[#071710]/80 p-4 sm:p-5" data-testid="admin-player-matches">
        <div className="flex flex-wrap items-end justify-between gap-2"><div><p className="eyebrow">Server-recorded results</p><h3 className="mt-1 text-sm font-semibold">Match history</h3></div><span className="text-[10px] text-white/40">{matches.length} recent matches</span></div>
        <div className="mt-3 overflow-x-auto"><table className="w-full min-w-[620px] text-left text-xs"><thead className="text-[9px] uppercase tracking-wider text-white/40"><tr><th className="py-2 pr-3">Result</th><th className="py-2 pr-3">Score</th><th className="py-2 pr-3">Players</th><th className="py-2 pr-3">Mode</th><th className="py-2">Finished</th></tr></thead><tbody className="divide-y divide-white/5">{matches.map((match) => <tr key={match.id} data-testid={`admin-player-match-${match.id}`}><td className={`py-2.5 pr-3 font-bold uppercase ${match.outcome === "win" ? "text-emerald-300" : match.outcome === "draw" ? "text-amber-200" : match.outcome === "loss" ? "text-rose-300" : "text-white/50"}`}>{match.outcome}</td><td className="py-2.5 pr-3 font-mono text-white/75">{match.scores ? `${match.scores[match.player_team] ?? "—"}–${match.scores[match.player_team === 0 ? 1 : 0] ?? "—"}` : "Not recorded"}</td><td className="py-2.5 pr-3 text-white/60">{match.players?.map((item) => item.display_name || item.username || "Player").join(" · ") || "Not recorded"}</td><td className="py-2.5 pr-3 text-white/50">{match.is_public ? "Public" : "Private"}{match.has_bots ? " · Bots" : ""}</td><td className="py-2.5 text-white/50">{dateTime(match.finished_at)}</td></tr>)}</tbody></table></div>
        {!matches.length && <p className="py-4 text-sm text-white/45">No completed matches are recorded for this player.</p>}
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-white/10 bg-[#071710]/80 p-4 sm:p-5" data-testid="admin-player-achievements"><div className="flex items-center justify-between gap-3"><h3 className="text-sm font-semibold">Achievements</h3><span className="text-[10px] text-white/40">{achievements.filter((item) => item.unlocked).length}/{achievements.length} unlocked</span></div><div className="mt-3 grid gap-2 sm:grid-cols-2">{achievements.map((item) => <article key={item.id} className="rounded-xl border border-white/5 bg-black/15 p-3"><div className="flex items-center justify-between gap-2"><b className="text-xs text-white/80">{item.name}</b><span className="text-[9px] text-white/40">{item.unlocked ? "Unlocked" : `${item.progress}/${item.target}`}</span></div><p className="mt-1 text-[10px] text-white/45">{item.description}</p>{item.unlocked_at && <time className="mt-1 block text-[9px] text-white/35">{dateTime(item.unlocked_at)}</time>}</article>)}</div></div>
        <div className="rounded-2xl border border-white/10 bg-[#071710]/80 p-4 sm:p-5" data-testid="admin-player-activity"><h3 className="text-sm font-semibold">Recent activity</h3>{activity.length ? <ul className="mt-3 space-y-2">{activity.slice(0, 10).map((item, index) => <li key={`${item.kind}-${item.timestamp}-${index}`} className="flex items-start justify-between gap-3 border-b border-white/5 pb-2 text-xs"><span className="text-white/70">{item.summary}</span><time className="shrink-0 text-[10px] text-white/35">{dateTime(item.timestamp)}</time></li>)}</ul> : <p className="mt-3 text-xs text-white/45">No recent activity is recorded.</p>}</div>
      </section>

      <section className="rounded-2xl border border-white/10 bg-[#071710]/80 p-4 sm:p-5" data-testid="admin-player-moderation">
        <div className="flex items-center gap-2"><ShieldCheck size={15} className="text-amber-100" /><h3 className="text-sm font-semibold">Moderation</h3></div>
        {selfTarget && <p className="mt-3 rounded-lg border border-amber-300/20 bg-amber-300/5 p-3 text-xs text-amber-100">Staff cannot moderate their own account.</p>}
        {!selfTarget && status === "active" && canModerate && <div className="mt-4 grid gap-3 lg:grid-cols-2">
          <form onSubmit={(event) => { event.preventDefault(); runAction("suspend", { duration_hours: Number(durationHours), reason }, "Player suspended"); }} className="space-y-3 rounded-xl border border-white/5 bg-black/15 p-3" data-testid="admin-player-suspend-form">
            <label className="block text-[10px] font-semibold uppercase tracking-wider text-white/45">Suspension duration<select value={durationHours} onChange={(event) => setDurationHours(event.target.value)} className={`${inputClass} mt-1`}><option value="1">1 hour</option><option value="6">6 hours</option><option value="24">24 hours</option><option value="72">3 days</option><option value="168">7 days</option><option value="720">30 days</option></select></label>
            <label className="block text-[10px] font-semibold uppercase tracking-wider text-white/45">Required reason<textarea required minLength={1} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} rows={3} className={`${inputClass} mt-1 resize-y normal-case tracking-normal`} placeholder="Explain why this temporary suspension is necessary." /></label>
            <button type="submit" disabled={pending || !reason.trim()} className="rounded-xl border border-amber-200/20 bg-amber-200/10 px-3 py-2 text-xs font-semibold text-amber-100 disabled:opacity-40">Suspend account</button>
          </form>
          {isAdmin && <div className="space-y-3 rounded-xl border border-rose-300/15 bg-rose-300/[0.03] p-3"><p className="text-xs font-semibold text-rose-100">Permanent ban</p><p className="text-[11px] text-white/45">A permanent ban blocks REST and WebSocket access. It preserves the player account and match history.</p><label className="block text-[10px] font-semibold uppercase tracking-wider text-white/45">Required reason<textarea required minLength={1} maxLength={500} value={banReason} onChange={(event) => setBanReason(event.target.value)} rows={3} className={`${inputClass} mt-1 resize-y normal-case tracking-normal`} placeholder="Explain why this permanent ban is necessary." /></label><button type="button" onClick={() => setConfirmation("ban")} disabled={pending || !banReason.trim()} className="inline-flex items-center gap-2 rounded-xl border border-rose-300/20 bg-rose-300/10 px-3 py-2 text-xs font-semibold text-rose-100 disabled:opacity-40"><Ban size={13} /> Review permanent ban</button></div>}
        </div>}
        {!selfTarget && status !== "active" && isAdmin && <div className="mt-4 rounded-xl border border-white/5 bg-black/15 p-3"><p className="text-xs text-white/70">Current restriction: <b className="capitalize">{status}</b>{data.player.account_status === "suspended" && data.moderation_history?.[0]?.expires_at ? ` · expires ${dateTime(data.moderation_history.find((item) => item.new_status === "suspended")?.expires_at)}` : ""}</p><label className="mt-3 block text-[10px] font-semibold uppercase tracking-wider text-white/45">Required unban reason<textarea required minLength={1} maxLength={500} value={unbanReason} onChange={(event) => setUnbanReason(event.target.value)} rows={2} className={`${inputClass} mt-1 resize-y normal-case tracking-normal`} placeholder="Record why access is being restored." /></label><button type="button" onClick={() => setConfirmation("unban")} disabled={pending || !unbanReason.trim()} className="mt-3 rounded-xl border border-emerald-300/20 bg-emerald-300/10 px-3 py-2 text-xs font-semibold text-emerald-100 disabled:opacity-40">Restore account access</button></div>}
        {!selfTarget && status === "active" && !canModerate && <p className="mt-3 text-xs text-white/45">Your role has read-only player access.</p>}

        {confirmation && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4" role="presentation"><section role="dialog" aria-modal="true" aria-labelledby="player-confirm-title" className="w-full max-w-md rounded-2xl border border-white/10 bg-[#0a1a13] p-5 shadow-2xl"><p className="eyebrow">Confirm action</p><h4 id="player-confirm-title" className="mt-2 text-lg font-semibold">{confirmation === "ban" ? "Permanently ban this player?" : "Restore this player’s account?"}</h4><p className="mt-2 text-xs leading-relaxed text-white/55">{confirmation === "ban" ? "This blocks future REST and WebSocket access. The account and match history remain stored." : "This removes the active account restriction and preserves the moderation history."}</p><p className="mt-3 break-words rounded-lg bg-black/20 p-3 text-xs text-white/70">Reason: {confirmation === "ban" ? banReason : unbanReason}</p><div className="mt-4 flex justify-end gap-2"><button type="button" onClick={() => setConfirmation("")} className="rounded-xl border border-white/10 px-3 py-2 text-xs text-white/70">Cancel</button><button type="button" disabled={pending} onClick={() => confirmation === "ban" ? runAction("ban", { reason: banReason }, "Player permanently banned") : runAction("unban", { reason: unbanReason }, "Player access restored")} className={`rounded-xl px-3 py-2 text-xs font-semibold ${confirmation === "ban" ? "bg-rose-300/15 text-rose-100" : "bg-emerald-300/15 text-emerald-100"}`}>{confirmation === "ban" ? "Confirm permanent ban" : "Confirm unban"}</button></div></section></div>}
        {canModerate && <div className="mt-5 border-t border-white/10 pt-4"><h4 className="text-xs font-semibold">Moderation history</h4>{moderation.length ? <ul className="mt-3 space-y-2">{moderation.map((event) => <li key={event.id} className="rounded-xl border border-white/5 bg-black/15 p-3" data-testid={`moderation-event-${event.id}`}><div className="flex flex-wrap items-center justify-between gap-2"><b className="text-xs capitalize text-white/85">{String(event.action).replaceAll("_", " ")}</b><time className="text-[10px] text-white/40">{dateTime(event.timestamp)}</time></div><p className="mt-1 text-[11px] text-white/55">By {event.actor_name || event.actor_id || "System"} · {event.previous_status || "—"} → {event.new_status || "—"}{event.expires_at ? ` · expires ${dateTime(event.expires_at)}` : ""}</p><p className="mt-2 whitespace-pre-wrap break-words text-xs text-white/75">{event.reason || "No reason recorded"}</p></li>)}</ul> : <p className="mt-2 text-xs text-white/45">No moderation events are recorded.</p>}</div>}
      </section>

      {(canWriteNotes || notes.length > 0) && <section className="rounded-2xl border border-white/10 bg-[#071710]/80 p-4 sm:p-5" data-testid="admin-player-notes"><div className="flex items-center gap-2"><FilePlus2 size={15} className="text-amber-100" /><h3 className="text-sm font-semibold">Internal administrator notes</h3><span className="rounded-full border border-amber-200/15 px-2 py-0.5 text-[9px] uppercase tracking-wider text-amber-100/70">Staff only</span></div>
        {canWriteNotes && <form onSubmit={addNote} className="mt-3 space-y-2"><label className="sr-only" htmlFor="admin-player-note">Add internal note</label><textarea id="admin-player-note" required maxLength={2000} value={noteContent} onChange={(event) => setNoteContent(event.target.value)} rows={3} className={`${inputClass} resize-y`} placeholder="Write a private staff note. This is not shown on public profiles." /><div className="flex items-center justify-between gap-2"><span className="text-[10px] text-white/35">{noteContent.length}/2000</span><button type="submit" disabled={pending || !noteContent.trim()} className="rounded-xl border border-amber-200/20 bg-amber-200/10 px-3 py-2 text-xs font-semibold text-amber-100 disabled:opacity-40">Add note</button></div></form>}
        <ul className="mt-3 space-y-2">{notes.map((note) => <li key={note.id} className="rounded-xl border border-white/5 bg-black/15 p-3" data-testid={`admin-player-note-${note.id}`}><div className="flex flex-wrap justify-between gap-2 text-[10px] text-white/40"><span>{note.author_name || note.author_id} · {note.env}</span><time>{dateTime(note.created_at)}</time></div><p className="mt-2 whitespace-pre-wrap break-words text-xs text-white/75">{note.content}</p></li>)}</ul>
        {!notes.length && !canWriteNotes && <p className="mt-2 text-xs text-white/45">Internal notes are not available to this staff role.</p>}
      </section>}
    </div>
  );
}
