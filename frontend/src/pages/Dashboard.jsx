import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Swords, DoorOpen, KeyRound, Play, Mail, Eye, ChevronRight, Star, Flame, Trophy, Crown, Target, Gamepad2, Skull, Users, Bot, Medal } from "lucide-react";
import { useApp, useSocketEvent } from "@/context/AppContext";
import { errMsg } from "@/lib/api";
import { PlayerAvatar } from "@/components/PlayerAvatar";
import { PlayingCard } from "@/components/PlayingCard";
import { medalSummary, netChange, signed, victoryName } from "@/components/medals/medalText";
import { LeagueBadge, ProgressBar, leagueLabel } from "@/components/leagues/League";

const TENS = ["10S", "10H", "10D", "10C"];

// Lifetime medals (live from the server via `me`) and your latest change, from the private GET /medals.
function MedalsCard({ total, latest, league, progress }) {
  const net = latest ? netChange(latest) : 0;
  return (
    <section className="relative overflow-hidden rounded-3xl border border-orange-300/30 bg-gradient-to-br from-[#2a1a0a] via-[#16110b] to-[#0b0a0c] p-5 shadow-[0_20px_44px_-26px_rgba(251,146,60,.45)] sm:p-6" data-testid="dashboard-medals">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_0%_0%,rgba(251,146,60,.18),transparent_55%)]" aria-hidden="true" />
      <div className="relative flex flex-wrap items-center gap-x-6 gap-y-4">
        <div className="flex items-center gap-3">
          {league ? <LeagueBadge league={league} size={56} testId="dashboard-league-badge" />
            : <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-100 via-amber-300 to-orange-500 text-slate-950" aria-hidden="true"><Medal size={26} /></span>}
          <div>
            {league && <div className="font-display text-lg leading-tight text-amber-50" data-testid="dashboard-league">{leagueLabel(league)}</div>}
            <div className="font-mono text-3xl font-black leading-none text-amber-100 tabular-nums" data-testid="dashboard-medals-total">{Number(total || 0).toLocaleString("en-IN")}</div>
            <div className="eyebrow mt-1 !text-orange-200/70">Lifetime medals</div>
          </div>
        </div>
        <div className="min-w-[200px] flex-1" data-testid="dashboard-medals-latest">
          {latest ? (
            <>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-semibold text-white/85">Last change · {victoryName(latest.victory_type)} {latest.won === false ? "loss" : "win"}</span>
                <b className={`rounded-full px-2 py-0.5 font-mono text-xs ${net > 0 ? "bg-orange-300/20 text-orange-200" : net < 0 ? "bg-rose-400/15 text-rose-200" : "bg-white/10 text-white/60"}`} data-testid="dashboard-medals-latest-net">{signed(net)}</b>
              </div>
              <p className="mt-1 text-xs text-white/55">{medalSummary(latest, latest.victory_type)}</p>
            </>
          ) : (
            <p className="text-sm text-white/55">Win rounds in matches without bots to earn medals: 1 per trick, +3 per ten, plus a win bonus.</p>
          )}
        </div>
        {progress && (
          <div className="basis-full" data-testid="dashboard-level-progress">
            <ProgressBar percent={progress.level_progress_percent}
              label={progress.is_top_level ? "Highest level reached" : `${progress.medals_to_next_level?.toLocaleString("en-IN")} medals to the next level`}
              detail={progress.next_league ? `${progress.next_league.name} at ${progress.next_league.min.toLocaleString("en-IN")}` : null} />
          </div>
        )}
        <div className="flex shrink-0 flex-wrap gap-2">
          <Link to="/leaderboard?board=medals" className="btn-ghost !border-orange-300/30 !py-1.5 text-sm" data-testid="dashboard-medals-leaderboard">Medal leaderboard</Link>
          <Link to="/history" className="btn-ghost !py-1.5 text-sm">Match history</Link>
        </div>
      </div>
    </section>
  );
}

function StatTile({ label, value, testId, Icon, tone }) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-b from-white/[0.06] to-white/[0.01] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,.06)]">
      <div className={`flex h-8 w-8 items-center justify-center rounded-lg ${tone}`} aria-hidden="true"><Icon size={16} /></div>
      <div className="mt-3 font-mono text-2xl font-bold leading-none tabular-nums" data-testid={testId}>{value}</div>
      <div className="eyebrow mt-1.5">{label}</div>
    </div>
  );
}

// A tiny top-down table: four seats around the felt, partners opposite (Team A sky, Team B amber),
// with the host's dealer chip. Decorative only.
function MiniTable() {
  const seats = [
    { pos: "left-1/2 top-0 -translate-x-1/2", team: "bg-sky-300" },
    { pos: "right-0 top-1/2 -translate-y-1/2", team: "bg-amber-300" },
    { pos: "left-1/2 bottom-0 -translate-x-1/2", team: "bg-sky-300", dealer: true },
    { pos: "left-0 top-1/2 -translate-y-1/2", team: "bg-amber-300" },
  ];
  return (
    <div className="pointer-events-none relative h-24 w-28 shrink-0" aria-hidden="true">
      <div className="felt absolute inset-3 rounded-[40%] border-4 border-[#6b3f1d] shadow-[inset_0_0_14px_rgba(0,0,0,.6),0_8px_18px_-8px_rgba(0,0,0,.9)]" />
      <div className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 gap-0.5">
        <span className="h-5 w-3.5 rounded-[3px] bg-white shadow" /><span className="h-5 w-3.5 rotate-12 rounded-[3px] bg-white shadow" />
      </div>
      {seats.map((s, i) => (
        <span key={i} className={`absolute h-5 w-5 rounded-full border-2 border-[#1b0f1f] ${s.team} ${s.pos} shadow-[0_3px_8px_rgba(0,0,0,.6)]`}>
          {s.dealer && <span className="absolute -right-2 -top-2 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-amber-300 text-[7px] font-black text-slate-950">D</span>}
        </span>
      ))}
    </div>
  );
}

const TILE_TONE = {
  hero: {
    shell: "felt border-amber-300/40 shadow-[0_20px_50px_-24px_rgba(16,185,129,.55)] hover:border-amber-200/70 hover:shadow-[0_24px_60px_-20px_rgba(251,191,36,.35)]",
    glow: "bg-[radial-gradient(ellipse_at_80%_10%,rgba(251,191,36,.18),transparent_55%)]",
    icon: "bg-gradient-to-br from-amber-200 to-amber-500 text-slate-950",
    title: "text-3xl text-amber-50 sm:text-4xl", desc: "text-emerald-50/75",
    cta: "rounded-xl bg-gradient-to-r from-amber-300 to-amber-500 px-4 py-2 text-slate-950 shadow-lg shadow-amber-500/25",
  },
  velvet: {
    shell: "border-amber-300/30 bg-gradient-to-br from-[#3b1638] via-[#24102a] to-[#120a18] shadow-[0_20px_44px_-26px_rgba(190,24,93,.55)] hover:border-amber-200/60",
    glow: "bg-[radial-gradient(ellipse_at_90%_0%,rgba(244,114,182,.18),transparent_55%)]",
    icon: "bg-gradient-to-br from-amber-100 via-amber-300 to-amber-600 text-[#2a0f24]",
    title: "text-2xl text-amber-50 sm:text-3xl", desc: "text-pink-50/65",
    cta: "rounded-xl border border-amber-300/60 bg-amber-300/10 px-4 py-2 text-amber-200 hover:bg-amber-300/20",
  },
};

function ModeTile({ to, testId, Icon, title, desc, tags, cta, hero = false, tone, art = null }) {
  const t = TILE_TONE[tone || (hero ? "hero" : "velvet")];
  return (
    <Link to={to} data-testid={testId}
      className={`group relative flex min-h-[176px] flex-col overflow-hidden rounded-3xl border p-5 transition-[transform,border-color,box-shadow] duration-200 hover:-translate-y-0.5 sm:p-6 ${t.shell}`}>
      <div className={`pointer-events-none absolute inset-0 ${t.glow}`} aria-hidden="true" />
      <div className="pointer-events-none absolute inset-0 rounded-3xl shadow-[inset_0_1px_0_rgba(255,255,255,.08)]" aria-hidden="true" />
      <div className="relative flex items-start justify-between gap-3">
        <span className={`flex h-12 w-12 items-center justify-center rounded-2xl shadow-[inset_0_2px_0_rgba(255,255,255,.35),0_8px_18px_-8px_rgba(0,0,0,.8)] ${t.icon}`} aria-hidden="true">
          <Icon size={22} strokeWidth={2.2} />
        </span>
        {tags && (
          <div className="flex flex-wrap justify-end gap-1.5">
            {tags.map(({ label, Icon: TagIcon }) => (
              <span key={label} className="inline-flex items-center gap-1 rounded-full border border-white/15 bg-black/25 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-white/75">
                {TagIcon && <TagIcon size={11} aria-hidden="true" />}{label}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="relative mt-auto flex items-end justify-between gap-3 pt-6">
        <div className="min-w-0">
          <div className={`font-display leading-tight ${t.title}`}>{title}</div>
          <p className={`mt-1 text-sm ${t.desc}`}>{desc}</p>
          <span className={`mt-4 inline-flex items-center gap-1 text-sm font-bold transition-colors ${t.cta}`}>
            {cta} <ChevronRight size={16} className="transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
          </span>
        </div>
        {art}
      </div>
    </Link>
  );
}

export default function Dashboard() {
  const { me, api, refreshMe } = useApp();
  const navigate = useNavigate();
  const [code, setCode] = useState("");
  const [invites, setInvites] = useState([]);
  const [latestMedal, setLatestMedal] = useState(null);
  const s = me.stats;
  const progression = me.progression || {};
  const level = progression.level || 1;
  const xpIn = progression.xp_in_level || 0;
  const xpNext = progression.xp_to_next_level || 500;
  const progress = Math.max(0, Math.min(100, progression.progress_percent ?? Math.round((xpIn / xpNext) * 100)));
  const winRate = s.games_played ? Math.round((s.wins / s.games_played) * 100) : null;
  const streak = progression.current_win_streak || 0;

  const loadInvites = () => api.get("/invitations").then((r) => setInvites(r.data)).catch(() => {});
  const loadMedals = () => api.get("/medals").then((r) => setLatestMedal(Array.isArray(r.data?.history) ? r.data.history[0] || null : null)).catch(() => {});
  useEffect(() => { refreshMe(); loadInvites(); loadMedals(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useSocketEvent((m) => {
    if (m.type === "invitation") loadInvites();
    if (m.type === "medals") loadMedals();
  });

  const join = async (e) => {
    e?.preventDefault();
    try {
      const { data } = await api.post(`/rooms/${code.trim().toUpperCase()}/join`);
      navigate(`/room/${data.code}`);
    } catch (err) { toast.error(errMsg(err)); }
  };
  const decline = async (id) => { await api.post(`/invitations/${id}/decline`); loadInvites(); };

  return (
    <div className="space-y-8 sm:space-y-10" data-testid="dashboard-page">
      {/* Player banner */}
      <section className="felt rise relative overflow-hidden rounded-3xl border border-amber-300/30 p-5 shadow-[0_24px_60px_-28px_rgba(0,0,0,.95)] sm:p-7" data-testid="dashboard-player-card">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_15%_0%,rgba(251,191,36,.16),transparent_55%)]" aria-hidden="true" />
        <div className="pointer-events-none absolute bottom-[-34px] right-8 hidden h-40 w-56 sm:block" aria-hidden="true">
          {TENS.map((card, i) => (
            <div key={card} className="absolute bottom-0 origin-bottom drop-shadow-[0_10px_16px_rgba(0,0,0,.55)]"
              style={{ left: i * 40, transform: `rotate(${(i - 1.5) * 11}deg) translateY(${Math.abs(i - 1.5) * 6}px)` }}>
              <PlayingCard card={card} size="lg" />
            </div>
          ))}
        </div>
        <div className="relative flex flex-col gap-5 sm:flex-row sm:items-center sm:pr-56">
          <div className="relative w-fit shrink-0">
            <div className="rounded-full p-1 bg-gradient-to-br from-amber-200 via-amber-400 to-amber-700 shadow-[0_10px_24px_-10px_rgba(0,0,0,.9)]">
              <PlayerAvatar user={me} size={72} />
            </div>
            <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full border border-amber-200/60 bg-[#1a1206] px-2 py-0.5 text-[10px] font-black uppercase tracking-wider text-amber-200" data-testid="dashboard-level">
              Lv {level}
            </span>
          </div>
          <div className="min-w-0 flex-1">
            <p className="eyebrow !text-emerald-100/70">Welcome back</p>
            <h1 className="truncate font-display text-3xl text-amber-50 sm:text-4xl" data-testid="dashboard-username">{me.username}</h1>
            <div className="mt-3 max-w-md" data-testid="dashboard-xp">
              <div className="flex justify-between text-[11px] font-semibold text-emerald-50/70">
                <span className="inline-flex items-center gap-1"><Star size={12} className="text-amber-300" aria-hidden="true" /> Level {level}</span>
                <span>{xpIn} / {xpNext} XP</span>
              </div>
              <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-black/40 shadow-[inset_0_1px_2px_rgba(0,0,0,.6)]" role="progressbar" aria-label={`Level ${level} progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
                <div className="h-full rounded-full bg-gradient-to-r from-amber-300 to-amber-500" style={{ width: `${progress}%` }} />
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2 text-xs">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-black/25 px-2.5 py-1 font-semibold text-white/85" data-testid="dashboard-win-rate">
                <Target size={13} className="text-emerald-300" aria-hidden="true" />{winRate === null ? "No games yet" : `${winRate}% win rate`}
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-black/25 px-2.5 py-1 font-semibold text-white/85" data-testid="dashboard-streak">
                <Flame size={13} className={streak ? "text-orange-300" : "text-white/40"} aria-hidden="true" />{streak ? `${streak}-win streak` : "No active streak"}
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-orange-300/30 bg-black/25 px-2.5 py-1 font-semibold text-orange-100" data-testid="dashboard-medals-chip">
                <Medal size={13} className="text-orange-300" aria-hidden="true" />{Number(me.medals || 0).toLocaleString("en-IN")} medals
              </span>
            </div>
          </div>
        </div>
      </section>

      {(me.active_game_id || me.lobby_code) && (
        <div className="relative flex flex-wrap items-center gap-4 overflow-hidden rounded-2xl border border-amber-300/60 bg-gradient-to-r from-amber-400/20 via-amber-400/5 to-transparent p-5 shadow-[0_0_40px_-16px_rgba(251,191,36,.6)]" data-testid="rejoin-banner">
          <span className="turn-pulse flex h-11 w-11 items-center justify-center rounded-full bg-gradient-to-br from-amber-200 to-amber-500 text-slate-950" aria-hidden="true"><Play size={20} /></span>
          <div className="min-w-[200px] flex-1">
            <div className="font-display text-lg">{me.active_game_id ? "You have a match in progress" : "You are seated in a lobby"}</div>
            <div className="text-sm text-muted-foreground">Your seat is being held for you.</div>
          </div>
          <button className="btn-gold" data-testid="rejoin-btn"
            onClick={() => navigate(me.active_game_id ? `/game/${me.active_game_id}` : `/room/${me.lobby_code}`)}>
            {me.active_game_id ? "Rejoin match" : "Back to lobby"}
          </button>
        </div>
      )}

      {/* Game modes */}
      <section aria-labelledby="dashboard-modes-title">
        <h2 id="dashboard-modes-title" className="eyebrow mb-3">Choose your table</h2>
        <div className="grid gap-4 md:grid-cols-3">
          <div className="md:col-span-2 md:row-span-2">
            <ModeTile hero to="/play" testId="dashboard-quick-match" Icon={Swords} title="Quick match"
              desc="Jump into the public queue. Partners are drawn at random."
              tags={[{ label: "4 players", Icon: Users }, { label: "First to 7" }, { label: "30s turns" }]} cta="Play now" />
          </div>
          <ModeTile to="/rooms/new" testId="create-room-btn" Icon={DoorOpen} title="Private room" tone="velvet"
            desc="Host a table, pick teams, dealer and target."
            tags={[{ label: "Friends", Icon: Users }, { label: "Bots", Icon: Bot }]} cta="Host a table" art={<MiniTable />} />
          <form onSubmit={join} className="relative flex min-h-[176px] flex-col overflow-hidden rounded-3xl border border-cyan-200/25 bg-gradient-to-br from-[#0d2f3a] via-[#0b1f2c] to-[#08121c] p-5 shadow-[0_20px_44px_-26px_rgba(34,211,238,.45)] sm:p-6">
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_90%_0%,rgba(103,232,249,.16),transparent_55%)]" aria-hidden="true" />
            <div className="pointer-events-none absolute inset-0 rounded-3xl shadow-[inset_0_1px_0_rgba(255,255,255,.08)]" aria-hidden="true" />
            <div className="relative flex items-start justify-between gap-3">
              <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-cyan-100 via-cyan-300 to-cyan-600 text-[#06222b] shadow-[inset_0_2px_0_rgba(255,255,255,.4),0_8px_18px_-8px_rgba(0,0,0,.8)]" aria-hidden="true"><KeyRound size={22} strokeWidth={2.2} /></span>
              <span className="inline-flex items-center gap-1 rounded-full border border-white/15 bg-black/25 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-white/75">6-letter invite</span>
            </div>
            <div className="relative mt-auto pt-5">
              <label htmlFor="dashboard-join-code" className="font-display text-2xl leading-tight text-cyan-50 sm:text-3xl">Join with code</label>
              <p className="mt-1 text-sm text-cyan-50/60">Enter the code your host shared.</p>
              <div className="mt-3 flex gap-2">
                <input id="dashboard-join-code" data-testid="join-code-input" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={6}
                  placeholder="ABC123" autoComplete="off" spellCheck={false}
                  className="min-w-0 flex-1 rounded-xl border border-cyan-200/20 bg-black/45 px-3 py-2.5 text-center font-mono text-lg font-bold uppercase tracking-[0.35em] text-amber-100 shadow-[inset_0_2px_6px_rgba(0,0,0,.6)] outline-none placeholder:text-white/20 focus:border-amber-300/60 focus:ring-2 focus:ring-amber-300/30" />
                <button className="btn-gold !px-4" disabled={code.length !== 6} data-testid="join-room-btn">Join</button>
              </div>
            </div>
          </form>
        </div>
      </section>

      <Link to="/spectate" className="group flex items-center gap-4 rounded-2xl border border-white/10 bg-gradient-to-r from-rose-500/10 via-transparent to-transparent p-5 transition-colors hover:border-rose-300/40" data-testid="dashboard-spectate-link">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-rose-500/15 text-rose-200" aria-hidden="true"><Eye size={20} /></span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1 rounded-full bg-rose-500/90 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wider text-white">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />Live
            </span>
            <span className="font-display text-lg">Watch public matches</span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">Follow a game in read-only spectator mode.</p>
        </div>
        <ChevronRight className="shrink-0 text-white/50 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
      </Link>

      {invites.length > 0 && (
        <section>
          <h2 className="eyebrow mb-3">Invitations</h2>
          <div className="space-y-2">
            {invites.map((i) => (
              <div key={i.id} className="flex flex-wrap items-center gap-3 rounded-2xl border border-amber-300/30 bg-gradient-to-r from-amber-400/10 to-transparent p-4" data-testid={`invitation-${i.id}`}>
                <span className="flex h-9 w-9 items-center justify-center rounded-full bg-amber-300/15 text-amber-200" aria-hidden="true"><Mail size={17} /></span>
                <div className="min-w-[160px] flex-1 text-sm"><b>{i.from_username}</b> invited you · <span className="font-mono text-amber-100">{i.room_code}</span> · {i.open_seats} open seat(s)</div>
                <button className="btn-gold !py-1.5 text-sm" onClick={() => navigate(`/join/${i.room_code}`)} data-testid={`accept-invite-${i.id}`}>Join</button>
                <button className="btn-ghost !py-1.5 text-sm" onClick={() => decline(i.id)} data-testid={`decline-invite-${i.id}`}>Decline</button>
              </div>
            ))}
          </div>
        </section>
      )}

      <MedalsCard total={me.medals} latest={latestMedal} league={me.league} progress={me.league_progress} />

      <section>
        <h2 className="eyebrow mb-3">Your record</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <StatTile label="Games" value={s.games_played} testId="stat-games" Icon={Gamepad2} tone="bg-sky-400/15 text-sky-200" />
          <StatTile label="Wins" value={s.wins} testId="stat-wins" Icon={Trophy} tone="bg-emerald-400/15 text-emerald-200" />
          <StatTile label="Losses" value={s.losses} testId="stat-losses" Icon={Skull} tone="bg-rose-400/15 text-rose-200" />
          <StatTile label="Normal" value={s.normal_wins} testId="stat-normal" Icon={Target} tone="bg-teal-400/15 text-teal-200" />
          <StatTile label="Koth" value={s.koth_wins} testId="stat-koth" Icon={Crown} tone="bg-amber-400/15 text-amber-200" />
          <StatTile label="13 Mann" value={s.grand_slam_wins} testId="stat-grand-slam" Icon={Flame} tone="bg-orange-400/15 text-orange-200" />
        </div>
      </section>
    </div>
  );
}
