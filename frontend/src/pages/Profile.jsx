import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { toast } from "sonner";
import { Award, CalendarDays, Check, Clock3, Crown, Flame, Gamepad2, Gem, LockKeyhole, Medal, Shield, Sparkles, Star, Trophy, UserRound, UserPlus, Users } from "lucide-react";
import { useApp } from "@/context/AppContext";
import { errMsg } from "@/lib/api";
import { PlayerAvatar } from "@/components/PlayerAvatar";
import { Progress } from "@/components/ui/progress";
import { MatchRow } from "@/pages/History";
import { medalSummary, netChange, signed, victoryName } from "@/components/medals/medalText";
import { LeagueBadge, LEAGUE_NAME, ProgressBar, leagueLabel } from "@/components/leagues/League";

const ACHIEVEMENT_ICONS = { trophy: Trophy, sparkles: Sparkles, medal: Medal, shield: Shield, flame: Flame, crown: Crown, users: Users, gem: Gem };

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return "—";
  const minutes = Math.floor(seconds / 60);
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return minutes ? `${minutes}m` : `${seconds}s`;
}

function formatDate(value) {
  if (!value) return "Date unavailable";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Date unavailable" : date.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
}

function StatCard({ label, value, detail, icon: Icon, tone = "bg-amber-300/15 text-amber-200" }) {
  return (
    <article className="relative min-w-0 overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-b from-white/[0.06] to-white/[0.01] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,.06)] sm:p-5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-white/50">{label}</span>
        <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${tone}`} aria-hidden="true"><Icon size={15} /></span>
      </div>
      <div className="mt-2 break-words font-mono text-2xl font-bold tabular-nums text-white sm:text-3xl" data-testid={`profile-stat-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}>{value}</div>
      {detail && <div className="mt-1 text-xs text-white/40">{detail}</div>}
    </article>
  );
}

function AchievementCard({ achievement }) {
  const Icon = ACHIEVEMENT_ICONS[achievement.icon] || Star;
  const percent = achievement.target ? (100 * achievement.progress) / achievement.target : 0;
  return (
    <article className={`relative min-w-0 overflow-hidden rounded-2xl border p-4 ${achievement.unlocked
      ? "border-amber-300/40 bg-gradient-to-br from-amber-300/[0.14] via-amber-900/10 to-transparent shadow-[0_0_28px_-14px_rgba(251,191,36,.6)]"
      : "border-white/10 bg-white/[0.02]"}`}
      data-testid={`achievement-${achievement.id}`} data-unlocked={achievement.unlocked ? "true" : "false"}>
      <div className="flex items-start gap-3">
        <div className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-full ring-2 ${achievement.unlocked
          ? "bg-gradient-to-br from-amber-100 via-amber-300 to-amber-600 text-slate-950 ring-amber-100/40 shadow-[inset_0_2px_0_rgba(255,255,255,.5),0_6px_16px_-6px_rgba(0,0,0,.9)]"
          : "bg-white/5 text-white/35 ring-white/10 grayscale"}`}>
          {achievement.unlocked ? <Icon size={20} /> : <LockKeyhole size={17} />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-1">
            <h3 className={`truncate text-sm font-bold ${achievement.unlocked ? "text-amber-100" : "text-white/75"}`}>{achievement.name}</h3>
            {achievement.unlocked && <Check size={15} className="text-emerald-300" aria-label="Unlocked" />}
          </div>
          <p className="mt-1 text-xs leading-relaxed text-white/45">{achievement.description}</p>
        </div>
      </div>
      {achievement.unlocked ? (
        <p className="mt-3 text-[10px] font-medium text-amber-200/65">Unlocked {achievement.unlocked_at ? formatDate(achievement.unlocked_at) : "before achievement tracking"}</p>
      ) : (
        <div className="mt-3">
          <div className="mb-1 flex justify-between text-[10px] text-white/40"><span>Progress</span><span>{achievement.progress}/{achievement.target}</span></div>
          <Progress value={percent} className="h-1.5 bg-white/10" />
        </div>
      )}
    </article>
  );
}

// League, level and medals. Everyone sees the public part (league, level, medal total); your own profile
// adds progress bars, your highest league and your promotion / demotion history from the private
// GET /progression.
function LeaguePanel({ profile, api }) {
  const [own, setOwn] = useState(null);
  useEffect(() => {
    if (!profile.is_me) return undefined;
    let live = true;
    api.get("/progression").then((r) => live && setOwn(r.data && r.data.progress ? r.data : null)).catch(() => {});
    return () => { live = false; };
  }, [api, profile.is_me]);
  const league = profile.league || { id: "bronze", name: "Bronze", level: 1, level_label: "I" };
  const p = own?.progress;
  const fmt = (n) => Number(n || 0).toLocaleString("en-IN");
  return (
    <section className="relative overflow-hidden rounded-3xl border border-orange-300/25 bg-gradient-to-br from-[#24180c] via-[#14100b] to-[#0b0a0c] p-5 sm:p-6" data-testid="profile-league">
      <div className="flex flex-wrap items-center gap-4">
        <LeagueBadge league={league} size={72} testId="profile-league-badge" />
        <div className="min-w-0 flex-1">
          <p className="eyebrow !text-orange-200/70">League</p>
          <h2 className="font-display text-3xl text-amber-50" data-testid="profile-league-name">{leagueLabel(league)}</h2>
          <p className="text-sm text-white/60"><b className="font-mono text-orange-200" data-testid="profile-league-medals">{fmt(profile.medals)}</b> lifetime medals</p>
        </div>
        {p && (
          <div className="rounded-2xl border border-white/10 bg-black/25 px-3 py-2 text-center" data-testid="profile-highest-league">
            <div className="text-[10px] uppercase tracking-wider text-white/45">Highest league</div>
            <div className="mt-1 flex items-center justify-center gap-1.5 font-semibold text-white/85">
              <LeagueBadge league={{ id: p.highest_league.id, level: 5 }} size={22} showLevel={false} />{p.highest_league.name}
            </div>
          </div>
        )}
      </div>
      {p && (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <ProgressBar testId="profile-level-progress" percent={p.level_progress_percent}
            label={p.is_top_level ? "Highest level reached" : `Next level · ${leagueLabel(nextLevelOf(p))}`}
            detail={p.is_top_level ? `${fmt(p.medals)} medals` : `${fmt(p.medals_to_next_level)} to go`} />
          <ProgressBar testId="profile-league-progress" percent={p.league_progress_percent} tone="from-sky-300 to-indigo-500"
            label={p.next_league ? `Next league · ${p.next_league.name} at ${fmt(p.next_league.min)}` : "Top league"}
            detail={p.next_league ? `${fmt(p.medals_to_next_league)} to go` : LEAGUE_NAME.legend} />
        </div>
      )}
      {p?.legend_rule && <p className="mt-2 text-[11px] text-white/50" data-testid="profile-legend-rule">{p.legend_rule}</p>}
      {own && (
        <div className="mt-4" data-testid="profile-league-history">
          <div className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-white/45">Promotions and demotions · only you can see this</div>
          {own.transitions?.length ? (
            <ol className="space-y-1">
              {own.transitions.map((t) => {
                const d = t.data || {};
                const up = d.direction === "promotion" || d.direction === "up";
                return (
                  <li key={t.id} className="flex flex-wrap items-center gap-2 rounded-lg bg-white/[0.03] px-2.5 py-1.5 text-xs" data-testid={`profile-transition-${t.id}`}>
                    <span className={`font-semibold ${up ? "text-amber-200" : "text-white/60"}`}>
                      {t.kind === "league" ? (up ? "Promoted" : "Moved down") : (up ? "Level up" : "Level down")}
                    </span>
                    <span className="text-white/70">{leagueLabel({ id: d.from?.league, level: d.from?.level })} → {leagueLabel({ id: d.to?.league, level: d.to?.level })}</span>
                    <span className="ml-auto font-mono text-white/45">{fmt(d.balance_after)} medals</span>
                  </li>
                );
              })}
            </ol>
          ) : <p className="text-xs text-white/45">No promotions or demotions yet.</p>}
        </div>
      )}
    </section>
  );
}

function nextLevelOf(p) {
  // Level V leads to the next league's Level I.
  return p.level < 5 ? { id: p.league, level: p.level + 1 } : { id: p.next_league?.id, level: 1 };
}

// Your own recent medal changes, from the private, signed-in GET /medals (never shown on other profiles).
function MedalHistory({ api }) {
  const [entries, setEntries] = useState(null);
  useEffect(() => {
    let live = true;
    api.get("/medals").then((r) => live && setEntries(Array.isArray(r.data?.history) ? r.data.history : []))
      .catch(() => live && setEntries([]));
    return () => { live = false; };
  }, [api]);
  return (
    <section data-testid="profile-medal-history">
      <div className="mb-3 flex items-end justify-between gap-3">
        <div><p className="eyebrow">Only you can see this</p><h2 className="mt-1 font-display text-2xl">Recent medal changes</h2></div>
        <span className="text-right text-[10px] text-white/40">Win: 1 per trick, +3 per ten, + bonus (Normal 1 · Koth 4 · Grand Slam 13) · Loss: minus the same bonus, never below 0</span>
      </div>
      {entries === null ? <div className="h-16 animate-pulse rounded-2xl bg-white/[0.03]" />
        : entries.length === 0 ? <p className="rounded-2xl border border-dashed border-white/10 bg-white/[0.02] p-5 text-center text-sm text-white/45" data-testid="profile-medal-history-empty">No medal changes yet. Medals change only in matches without bots.</p>
          : (
            <ol className="space-y-1.5">
              {entries.map((e) => {
                const net = netChange(e);
                const lost = e.won === false;
                return (
                  <li key={`${e.game_id}:${e.round}`} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-xs" data-testid={`medal-change-${e.game_id}-${e.round}`}>
                    <span className="min-w-0">
                      <span className="font-semibold text-white/85">{lost ? `${victoryName(e.victory_type)} loss` : `${victoryName(e.victory_type)} win`} · round {e.round}</span>
                      <span className="block text-[11px] text-white/50">{medalSummary(e, e.victory_type)}</span>
                    </span>
                    <span className="inline-flex shrink-0 items-center gap-2">
                      <b className={`font-mono text-sm ${net > 0 ? "text-orange-200" : net < 0 ? "text-rose-200" : "text-white/45"}`}>{signed(net)}</b>
                      {e.balance_after !== null && e.balance_after !== undefined && <span className="text-[10px] text-white/45">balance <b className="font-mono text-white/75">{Number(e.balance_after).toLocaleString("en-IN")}</b></span>}
                    </span>
                  </li>
                );
              })}
            </ol>
          )}
    </section>
  );
}

export default function Profile() {
  const { username } = useParams();
  const { api, connected } = useApp();
  const [profile, setProfile] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await api.get(`/users/${encodeURIComponent(username)}`);
      setProfile(data);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setProfile(null);
    void load();
    // `api` is stable for the authenticated session; username changes trigger a new profile load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [username]);

  const addFriend = async () => {
    try {
      await api.post("/friends/requests", { username: profile.username });
      toast.success("Friend request sent");
      await load();
    } catch (e) { toast.error(errMsg(e)); }
  };

  if (loading && !profile) {
    return <div className="space-y-5" data-testid="profile-loading" aria-label="Loading player profile">
      <div className="h-44 animate-pulse rounded-3xl border border-white/10 bg-white/[0.03]" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{Array.from({ length: 8 }, (_, i) => <div key={i} className="h-28 animate-pulse rounded-2xl bg-white/[0.03]" />)}</div>
    </div>;
  }
  if (error) return <section className="panel max-w-xl p-6" data-testid="profile-error"><p className="text-rose-300">{error}</p><button className="btn-ghost mt-4" onClick={load} data-testid="profile-retry-btn">Try again</button></section>;
  if (!profile) return null;

  const stats = profile.stats || {};
  const progression = profile.progression || {};
  const metrics = profile.profile_stats || {};
  const games = Number(stats.games_played) || 0;
  const wins = Number(stats.wins) || 0;
  const losses = Number(stats.losses) || 0;
  const draws = Number(stats.draws) || 0;
  const winRate = games ? Math.round((100 * wins) / games) : 0;
  const online = profile.is_me ? connected : profile.online;

  const koth = Number(stats.koth_wins) || 0;
  const slams = Number(stats.grand_slam_wins) || 0;
  const normals = Number(stats.normal_wins) || 0;
  const roundWins = Number(stats.rounds_won) || 0;
  // Lifetime medals, from the server only (1 per trick won + 3 per ten, human-only matches, winning team).
  const medals = Number(profile.medals) || 0;
  const bestStreak = metrics.best_win_streak ?? progression.best_win_streak;

  return (
    <div className="space-y-7 sm:space-y-9" data-testid="profile-page">
      <section className="felt relative overflow-hidden rounded-3xl border border-amber-300/30 p-5 shadow-[0_24px_60px_-28px_rgba(0,0,0,.95)] sm:p-8" data-testid="profile-header">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_15%_0%,rgba(251,191,36,.18),transparent_55%)]" aria-hidden="true" />
        <div className="relative flex flex-col gap-5 sm:flex-row sm:items-center">
          <div className="relative self-start">
            <div className="rounded-full bg-gradient-to-br from-amber-200 via-amber-400 to-amber-700 p-1 shadow-[0_12px_28px_-10px_rgba(0,0,0,.9),0_0_34px_rgba(245,190,75,.18)]">
              <PlayerAvatar user={profile} size={92} online={online} />
            </div>
            <span className="absolute -bottom-2 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full border border-amber-200/60 bg-[#1a1206] px-2.5 py-0.5 text-[11px] font-black uppercase tracking-wider text-amber-200" aria-hidden="true">
              Lv {progression.level || 1}
            </span>
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider ${online ? "border-emerald-200/20 bg-emerald-200/10 text-emerald-200" : "border-white/10 bg-white/5 text-white/45"}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${online ? "bg-emerald-300" : "bg-white/30"}`} />{online ? "Online" : "Offline"}
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-200/25 bg-amber-200/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-amber-100" data-testid="profile-level"><Star size={12} /> Level {progression.level || 1}</span>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-200/40 bg-gradient-to-r from-amber-300/20 to-orange-400/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-amber-100" data-testid="profile-medals" title="Lifetime medals"><Medal size={12} /> {medals.toLocaleString("en-IN")} medals</span>
            </div>
            <h1 className="mt-3 break-words font-display text-3xl leading-tight text-amber-50 sm:text-4xl" data-testid="profile-display-name">{profile.display_name || profile.username}</h1>
            <p className="mt-1 flex items-center gap-1.5 text-sm text-emerald-50/60" data-testid="profile-username"><UserRound size={14} /> @{profile.username}</p>
            {profile.bio && <p className="mt-3 max-w-2xl whitespace-pre-wrap break-words rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm italic leading-relaxed text-white/75" data-testid="profile-bio">{profile.bio}</p>}
            <div className="mt-4 grid max-w-md grid-cols-3 gap-2" data-testid="profile-headline-stats">
              {[["Win rate", `${winRate}%`, "text-emerald-300"], ["Wins", wins, "text-amber-200"], ["Best streak", bestStreak ?? "—", "text-orange-300"]].map(([label, value, tone]) => (
                <div key={label} className="rounded-2xl border border-white/10 bg-black/30 px-2 py-2 text-center">
                  <div className={`font-mono text-xl font-bold leading-none ${tone}`}>{value}</div>
                  <div className="mt-1 text-[10px] uppercase tracking-wider text-white/50">{label}</div>
                </div>
              ))}
            </div>
            <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-xs text-emerald-50/55">
              <span className="inline-flex items-center gap-1.5"><CalendarDays size={14} /> Member since {formatDate(profile.created_at)}</span>
              <span className="inline-flex items-center gap-1.5"><Gamepad2 size={14} /> {games} competitive matches</span>
            </div>
            <div className="mt-5 max-w-xl" data-testid="profile-xp-progress">
              <div className="mb-1.5 flex flex-wrap justify-between gap-1 text-[10px] font-semibold text-amber-100/65">
                <span>{progression.xp_in_level || 0} XP</span><span>{progression.xp_to_next_level || 500} XP to Level {(progression.level || 1) + 1}</span>
              </div>
              <Progress value={progression.progress_percent || 0} className="h-2 bg-black/40" />
              <p className="mt-1 text-[10px] text-white/35">{progression.xp || 0} total XP · earned from completed competitive matches</p>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2 sm:flex-col sm:items-stretch">
            {profile.is_me ? <Link to="/settings" className="btn-gold !px-4 !py-2.5" data-testid="edit-profile-btn">Edit profile</Link>
              : profile.is_friend ? <span className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-300/20 bg-emerald-300/10 px-3 py-2 text-sm font-semibold text-emerald-200" data-testid="profile-friend-badge"><Check size={15} /> Friends</span>
                : profile.pending_request ? <span className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/45" data-testid="profile-pending">Request pending</span>
                  : <button className="btn-gold !px-4 !py-2.5" onClick={addFriend} data-testid="profile-add-friend-btn"><UserPlus size={15} /> Add friend</button>}
          </div>
        </div>
      </section>

      <section data-testid="profile-statistics">
        <div className="mb-3 flex items-end justify-between gap-3">
          <div><p className="eyebrow">Competitive record</p><h2 className="mt-1 font-display text-2xl">Career statistics</h2></div>
          <span className="text-right text-[10px] text-white/35">Bot practice matches excluded</span>
        </div>
        <div className="mb-3 rounded-2xl border border-white/10 bg-white/[0.03] p-4" data-testid="profile-record-bar">
          <div className="flex justify-between text-xs font-semibold">
            <span className="text-emerald-300">{wins} won</span>
            <span className="text-white/45">{games} matches</span>
            <span className="text-rose-300">{losses} lost</span>
          </div>
          <div className="mt-2 flex h-2.5 overflow-hidden rounded-full bg-white/10" role="img" aria-label={`${wins} wins and ${losses} losses`}>
            {games > 0 && <>
              <div className="h-full bg-gradient-to-r from-emerald-400 to-emerald-500" style={{ width: `${(100 * wins) / games}%` }} />
              <div className="h-full bg-gradient-to-r from-rose-500 to-rose-400" style={{ width: `${(100 * losses) / games}%` }} />
            </>}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 sm:gap-3">
          <StatCard label="Matches" value={games} icon={Gamepad2} tone="bg-sky-400/15 text-sky-200" />
          <StatCard label="Wins" value={wins} icon={Trophy} tone="bg-emerald-400/15 text-emerald-200" />
          <StatCard label="Losses" value={losses} icon={Shield} tone="bg-rose-400/15 text-rose-200" />
          <StatCard label="Win rate" value={`${winRate}%`} detail={`${wins} wins of ${games}`} icon={Award} tone="bg-amber-300/15 text-amber-200" />
          <StatCard label="Medals" value={medals.toLocaleString("en-IN")} detail="1 per trick you win · +3 per ten, in rounds your team wins" icon={Medal} tone="bg-orange-400/15 text-orange-200" />
          <StatCard label="Team tricks won" value={metrics.total_team_tricks_won ?? "—"} detail="Team total across your matches" icon={Users} tone="bg-teal-400/15 text-teal-200" />
          <StatCard label="Avg match time" value={formatDuration(metrics.average_match_duration_seconds)} icon={Clock3} tone="bg-indigo-400/15 text-indigo-200" />
          <StatCard label="Current streak" value={metrics.current_win_streak ?? "—"} detail={`Best: ${metrics.best_win_streak ?? "—"}`} icon={Flame} tone="bg-orange-400/15 text-orange-200" />
          <StatCard label="Rounds won" value={roundWins} detail={draws ? `${draws} drawn matches` : "Across all completed matches"} icon={Star} tone="bg-amber-300/15 text-amber-200" />
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2.5 sm:gap-3" data-testid="profile-victory-types">
          {[["Normal wins", normals, Sparkles, "border-emerald-300/30 from-emerald-400/10 text-emerald-200"],
            ["Koth wins", koth, Crown, "border-amber-300/40 from-amber-400/15 text-amber-200"],
            ["13 Mann wins", slams, Flame, "border-rose-300/40 from-rose-400/15 text-rose-200"]].map(([label, value, Icon, tone]) => (
            <div key={label} className={`flex min-w-0 flex-col items-start gap-2 rounded-2xl border bg-gradient-to-br to-transparent p-3 sm:flex-row sm:items-center sm:gap-3 sm:p-4 ${tone}`}>
              <Icon size={20} className="shrink-0" aria-hidden="true" />
              <div className="min-w-0">
                <div className="font-mono text-xl font-bold leading-none text-white">{value}</div>
                <div className="mt-1 text-[10px] uppercase leading-tight tracking-wider">{label}</div>
              </div>
            </div>
          ))}
        </div>
        <p className="mt-2 text-[10px] text-white/35">Tricks are credited to the player’s team; individual card contributions are not tracked.</p>
      </section>

      <LeaguePanel profile={profile} api={api} />

      {profile.is_me && <MedalHistory api={api} />}

      <section data-testid="profile-achievements">
        <div className="mb-3 flex items-end justify-between gap-3">
          <div><p className="eyebrow">Milestones</p><h2 className="mt-1 font-display text-2xl">Achievements</h2></div>
          <span className="text-xs text-white/45">{(profile.achievements || []).filter((a) => a.unlocked).length}/{(profile.achievements || []).length} unlocked</span>
        </div>
        {(profile.achievements || []).length ? <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {profile.achievements.map((achievement) => <AchievementCard key={achievement.id} achievement={achievement} />)}
        </div> : <p className="panel p-5 text-sm text-muted-foreground">Achievements will appear as you complete competitive matches.</p>}
      </section>

      <section data-testid="profile-recent-matches">
        <div className="mb-3 flex items-end justify-between gap-3">
          <div><p className="eyebrow">Recent tables</p><h2 className="mt-1 font-display text-2xl">Match history</h2></div>
          {profile.is_me && <Link to="/history" className="text-xs font-semibold text-amber-200 hover:text-amber-100">View all matches →</Link>}
        </div>
        {!profile.recent_matches?.length ? <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.02] p-6 text-center text-sm text-white/45" data-testid="profile-recent-empty">No completed matches yet. Finish a competitive match to start your record.</div>
          : <div className="space-y-2">{profile.recent_matches.map((match) => <MatchRow key={match.id} m={match} meId={profile.user_id} />)}</div>}
      </section>
    </div>
  );
}
