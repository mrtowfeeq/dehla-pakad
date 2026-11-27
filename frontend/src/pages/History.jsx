import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, Crown, Flame, Flag, History as HistoryIcon, Medal, Sparkles, Trophy, Bot, Clock, Swords } from "lucide-react";
import { useApp } from "@/context/AppContext";
import { TEAM_NAME, VICTORY_LABEL } from "@/lib/api";
import { PlayerAvatar } from "@/components/PlayerAvatar";
import { medalSummary, netChange, signed } from "@/components/medals/medalText";

const TYPE_STYLE = {
  normal: { Icon: Sparkles, chip: "border-emerald-300/30 bg-emerald-300/10 text-emerald-200" },
  koth: { Icon: Crown, chip: "border-amber-300/40 bg-amber-300/15 text-amber-200" },
  grand_slam: { Icon: Flame, chip: "border-rose-300/40 bg-rose-300/15 text-rose-200" },
};

function TypeChip({ type, points }) {
  const { Icon, chip } = TYPE_STYLE[type] || TYPE_STYLE.normal;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${chip}`}>
      <Icon size={11} aria-hidden="true" />{VICTORY_LABEL[type] || type}{points ? ` +${points}` : ""}
    </span>
  );
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function dayLabel(value, now = new Date()) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "Earlier";
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(d)) / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}

function outcomeFor(m, meId) {
  const mine = m.players.find((p) => p.user_id === meId);
  if (m.winner_team !== 0 && m.winner_team !== 1) return { key: "ended", mine };
  return { key: mine && mine.team === m.winner_team ? "won" : "lost", mine };
}

const OUTCOME = {
  won: { label: "Victory", Icon: Trophy, ribbon: "from-emerald-400 to-emerald-600", text: "text-emerald-300", border: "border-emerald-300/30", tint: "from-emerald-400/[0.08]" },
  lost: { label: "Defeat", Icon: Flag, ribbon: "from-rose-400 to-rose-600", text: "text-rose-300", border: "border-rose-300/25", tint: "from-rose-400/[0.06]" },
  ended: { label: "Ended", Icon: Clock, ribbon: "from-slate-400 to-slate-600", text: "text-slate-300", border: "border-white/10", tint: "from-white/[0.04]" },
};

export function MatchRow({ m, meId }) {
  const [open, setOpen] = useState(false);
  const { key, mine } = outcomeFor(m, meId);
  const o = OUTCOME[key];
  const my = mine ? mine.team : 0;
  const forfeit = m.forfeited_by !== null && m.forfeited_by !== undefined;
  const rounds = Array.isArray(m.rounds) ? m.rounds : [];
  const finalRound = rounds[rounds.length - 1];
  const duration = formatDuration(m.duration_seconds);
  const when = new Date(m.finished_at);
  const team = (t) => m.players.filter((p) => p.team === t).sort((a, b) => a.seat - b.seat);
  let running = [0, 0];
  // Medals (server-computed): only human-only matches are eligible; bot matches never show any.
  const medals = m.medals?.eligible ? m.medals : null;
  const medalTotal = (uid) => Number(medals?.totals?.[uid]) || 0;
  const roundMedals = (round, uid) => medals?.rounds?.find((x) => x.round === round)?.players?.find((p) => p.user_id === uid);
  const roundType = (round) => medals?.rounds?.find((x) => x.round === round)?.type;
  return (
    <div className={`overflow-hidden rounded-2xl border bg-gradient-to-r to-transparent transition-colors hover:border-white/25 ${o.border} ${o.tint}`} data-testid={`match-row-${m.id}`} data-outcome={key}>
      <button className="flex w-full items-stretch text-left" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className={`w-1.5 shrink-0 bg-gradient-to-b ${o.ribbon}`} aria-hidden="true" />
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-5 gap-y-3 p-4">
          <div className="w-[86px] shrink-0">
            <div className={`inline-flex items-center gap-1 text-[11px] font-black uppercase tracking-[0.18em] ${o.text}`} data-testid="match-outcome">
              <o.Icon size={12} aria-hidden="true" />{o.label}
            </div>
            <div className="mt-0.5 font-mono text-2xl font-bold leading-none" title="Your team – opponents" data-testid="match-score">
              <span className={my === 0 ? "text-team-a" : "text-team-b"}>{m.scores[my]}</span>
              <span className="text-white/30">–</span>
              <span className={my === 0 ? "text-team-b" : "text-team-a"}>{m.scores[1 - my]}</span>
            </div>
          </div>

          <div className="flex items-center gap-2" aria-hidden="true">
            <div className="flex -space-x-2">{team(my).map((p) => <PlayerAvatar key={p.seat} user={p} size={30} />)}</div>
            <Swords size={13} className="text-white/30" />
            <div className="flex -space-x-2">{team(1 - my).map((p) => <PlayerAvatar key={p.seat} user={p} size={30} />)}</div>
          </div>

          <div className="min-w-[160px] flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              {forfeit ? <span className="inline-flex items-center gap-1 rounded-full border border-rose-300/30 bg-rose-300/10 px-2 py-0.5 text-[11px] font-semibold text-rose-200"><Flag size={11} aria-hidden="true" />Forfeit</span>
                : finalRound ? <TypeChip type={finalRound.type} points={finalRound.points} /> : null}
              {medals && mine && (
                <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${medalTotal(mine.user_id) < 0 ? "border-rose-300/35 bg-rose-300/10 text-rose-200" : "border-orange-300/35 bg-orange-300/10 text-orange-200"}`}
                  data-testid="match-medals" title="Your net medal change in this match">
                  <Medal size={11} aria-hidden="true" />{signed(medalTotal(mine.user_id))} medal{Math.abs(medalTotal(mine.user_id)) === 1 ? "" : "s"}
                </span>
              )}
              {m.has_bots && <span className="inline-flex items-center gap-1 rounded-full border border-white/15 px-2 py-0.5 text-[11px] text-white/65"><Bot size={11} aria-hidden="true" />Practice</span>}
            </div>
            <div className="mt-1 text-xs text-muted-foreground" data-testid="match-meta">
              {m.is_public ? "Public" : "Private"} · to {m.target} · {rounds.length} round{rounds.length === 1 ? "" : "s"}{forfeit ? " · Forfeit" : ""}{m.has_bots ? " · Practice vs bots" : ""}
            </div>
          </div>

          <div className="ml-auto flex items-center gap-3 text-right">
            <div className="text-xs text-muted-foreground">
              <div className="font-semibold text-white/80">{Number.isNaN(when.getTime()) ? "—" : when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</div>
              {duration && <div className="inline-flex items-center gap-1"><Clock size={10} aria-hidden="true" />{duration}</div>}
            </div>
            <ChevronDown size={18} className={`shrink-0 text-white/40 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" />
          </div>
        </div>
      </button>
      {open && (
        <div className="grid gap-5 border-t border-white/10 bg-black/20 px-5 py-4 text-sm sm:grid-cols-[220px_minmax(0,1fr)]" data-testid={`match-details-${m.id}`}>
          <div className="space-y-3">
            {[my, 1 - my].map((t) => (
              <div key={t}>
                <div className={`text-xs font-bold uppercase tracking-wider ${t === 0 ? "text-team-a" : "text-team-b"}`}>
                  {TEAM_NAME[t]}{t === my && mine ? " · You" : ""}{m.winner_team === t ? " · Winner" : ""}
                </div>
                <div className="mt-1 flex flex-wrap gap-x-2">
                  {team(t).map((p, index) => (
                    <span key={p.seat} className="inline-flex items-center gap-2">
                      {index > 0 && <span aria-hidden="true" className="text-white/30">&amp;</span>}
                      {p.is_bot ? <span>{p.username}</span> : <Link to={`/profile/${encodeURIComponent(p.username)}`} className="hover:text-primary" data-testid={`history-player-profile-${p.seat}`}>{p.display_name || p.username}</Link>}
                      {medals && <span className={`inline-flex items-center gap-0.5 font-mono text-[11px] ${medalTotal(p.user_id) < 0 ? "text-rose-200/80" : "text-orange-200/80"}`} data-testid={`history-player-medals-${p.seat}`} title="Net medal change in this match"><Medal size={10} aria-hidden="true" />{signed(medalTotal(p.user_id))}</span>}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <ol className="space-y-1.5" data-testid={`match-rounds-${m.id}`}>
            {rounds.length === 0 && <li className="text-xs text-muted-foreground">No rounds were completed.</li>}
            {rounds.map((r) => {
              running = running.map((s, t) => s + (t === r.winner_team ? r.points || 0 : 0));
              const mineRound = mine && roundMedals(r.round, mine.user_id);
              return (
                <li key={r.round} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-white/[0.03] px-3 py-1.5 text-xs">
                  <span className="inline-flex items-center gap-2">
                    <span className="font-mono text-white/45">R{r.round}</span>
                    <span className={`h-2 w-2 rounded-full ${r.winner_team === 0 ? "bg-sky-300" : "bg-amber-300"}`} aria-hidden="true" />
                    <span className="font-semibold">{TEAM_NAME[r.winner_team]}</span>
                    <TypeChip type={r.type} points={r.points} />
                  </span>
                  <span className="inline-flex items-center gap-3">
                    {mineRound && (
                      <span className={`inline-flex items-center gap-1 font-mono ${netChange(mineRound) > 0 ? "text-orange-200" : netChange(mineRound) < 0 ? "text-rose-200" : "text-white/35"}`}
                        data-testid={`round-medals-${r.round}`} title={medalSummary(mineRound, mineRound.type || roundType(r.round) || r.type)}>
                        <Medal size={11} aria-hidden="true" />{signed(netChange(mineRound))}
                      </span>
                    )}
                    <span className="font-mono text-white/60" title="Running score (Team A – Team B)">{running[0]}–{running[1]}</span>
                  </span>
                  {mineRound && (
                    <span className="basis-full text-[11px] text-white/50" data-testid={`round-medals-detail-${r.round}`}>
                      {mineRound.won === false ? "Your team lost: " : "You earned: "}{medalSummary(mineRound, roundType(r.round) || r.type)}
                      {" "}→ <b className="font-mono text-white/80">{signed(netChange(mineRound))}</b>
                      {mineRound.balance_after !== null && mineRound.balance_after !== undefined && <> · balance <b className="font-mono text-orange-200/90">{Number(mineRound.balance_after).toLocaleString("en-IN")}</b></>}
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </div>
  );
}

const FILTERS = [
  ["all", "All"],
  ["competitive", "Competitive"],
  ["practice", "Practice"],
];

export default function History() {
  const { api, me } = useApp();
  const [matches, setMatches] = useState(null);
  const [filter, setFilter] = useState("all");
  useEffect(() => { api.get("/matches").then((r) => setMatches(r.data)).catch(() => setMatches([])); }, [api]);

  const shown = useMemo(() => (matches || []).filter((m) => filter === "all" || (filter === "practice" ? m.has_bots : !m.has_bots)), [matches, filter]);
  const summary = useMemo(() => {
    const decided = shown.filter((m) => m.winner_team === 0 || m.winner_team === 1);
    const won = decided.filter((m) => outcomeFor(m, me.user_id).key === "won").length;
    return { played: shown.length, won, rate: decided.length ? Math.round((won / decided.length) * 100) : null };
  }, [shown, me.user_id]);
  const groups = useMemo(() => {
    const out = [];
    shown.forEach((m) => {
      const label = dayLabel(m.finished_at);
      if (!out.length || out[out.length - 1].label !== label) out.push({ label, items: [] });
      out[out.length - 1].items.push(m);
    });
    return out;
  }, [shown]);

  return (
    <div className="space-y-6" data-testid="history-page">
      <section className="relative overflow-hidden rounded-3xl border border-amber-300/25 bg-gradient-to-br from-[#1b2a4a] via-[#111a30] to-[#0a1120] p-5 shadow-[0_24px_60px_-30px_rgba(0,0,0,.95)] sm:p-7">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_85%_0%,rgba(251,191,36,.14),transparent_55%)]" aria-hidden="true" />
        <div className="relative flex flex-wrap items-center gap-4">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-200 to-amber-500 text-slate-950 shadow-[inset_0_2px_0_rgba(255,255,255,.4),0_10px_22px_-10px_rgba(0,0,0,.9)]" aria-hidden="true"><HistoryIcon size={26} /></span>
          <div className="min-w-0 flex-1">
            <p className="eyebrow !text-amber-200/70">Your games</p>
            <h1 className="font-display text-4xl text-amber-50">Match history</h1>
          </div>
          <div className="flex gap-2" data-testid="history-summary">
            {[["Played", summary.played, "text-white"], ["Won", summary.won, "text-emerald-300"], ["Win rate", summary.rate === null ? "—" : `${summary.rate}%`, "text-amber-200"]].map(([label, value, tone]) => (
              <div key={label} className="min-w-[72px] rounded-2xl border border-white/10 bg-black/25 px-3 py-2 text-center">
                <div className={`font-mono text-xl font-bold leading-none ${tone}`}>{value}</div>
                <div className="mt-1 text-[10px] uppercase tracking-wider text-white/50">{label}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="relative mt-5 inline-flex rounded-xl border border-white/10 bg-black/30 p-1" role="tablist" aria-label="Filter matches">
          {FILTERS.map(([value, label]) => (
            <button key={value} role="tab" aria-selected={filter === value} onClick={() => setFilter(value)} data-testid={`history-filter-${value}`}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${filter === value ? "bg-amber-300 text-slate-950" : "text-white/65 hover:text-white"}`}>
              {label}
            </button>
          ))}
        </div>
      </section>

      {matches === null ? <p className="text-muted-foreground">Loading…</p>
        : matches.length === 0 ? (
          <div className="flex flex-col items-center rounded-3xl border border-dashed border-white/15 bg-white/[0.02] px-6 py-10 text-center" data-testid="history-empty">
            <HistoryIcon size={30} className="text-amber-300/70" aria-hidden="true" />
            <h2 className="mt-3 font-display text-2xl">No matches yet</h2>
            <p className="mt-1 text-sm text-muted-foreground">No completed matches yet. Finish a game to see it here.</p>
            <Link to="/play" className="btn-gold mt-5" data-testid="history-empty-play"><Swords size={16} aria-hidden="true" /> Find a table</Link>
          </div>
        ) : shown.length === 0 ? (
          <p className="rounded-2xl border border-white/10 p-6 text-center text-sm text-muted-foreground" data-testid="history-filter-empty">No {filter} matches yet.</p>
        ) : (
          <div className="space-y-6">
            {groups.map((g) => (
              <section key={g.label} aria-label={g.label}>
                <h2 className="eyebrow mb-2">{g.label}</h2>
                <div className="space-y-2">{g.items.map((m) => <MatchRow key={m.id} m={m} meId={me.user_id} />)}</div>
              </section>
            ))}
          </div>
        )}
    </div>
  );
}
