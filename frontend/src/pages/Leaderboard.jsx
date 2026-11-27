import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Crown, Flame, Medal, Star, Trophy } from "lucide-react";
import { useApp } from "@/context/AppContext";
import { PlayerAvatar } from "@/components/PlayerAvatar";
import { LeagueBadge, LEAGUE_NAME, LEAGUE_ORDER, leagueLabel } from "@/components/leagues/League";

const PODIUM = {
  // Plinth heights are minimums (never clip their text) stepped so 1st stands tallest.
  1: { label: "Champion", ring: "from-amber-100 via-amber-300 to-amber-600", plinth: "min-h-[136px] from-amber-300/30 to-amber-700/10 border-amber-300/50", text: "text-amber-200", glow: "shadow-[0_0_40px_-10px_rgba(251,191,36,.7)]" },
  2: { label: "Runner-up", ring: "from-slate-100 via-slate-300 to-slate-500", plinth: "min-h-[112px] from-slate-300/25 to-slate-600/10 border-slate-300/40", text: "text-slate-200", glow: "shadow-[0_0_30px_-12px_rgba(203,213,225,.6)]" },
  3: { label: "Third", ring: "from-orange-200 via-orange-400 to-orange-800", plinth: "min-h-[100px] from-orange-400/25 to-orange-800/10 border-orange-300/40", text: "text-orange-200", glow: "shadow-[0_0_30px_-12px_rgba(251,146,60,.6)]" },
};

// Two boards: match wins (the default) and lifetime medals. Every row carries both numbers.
const BOARDS = {
  wins: { label: "Wins", Icon: Trophy, blurb: "Top 50 players by wins from completed competitive matches." },
  medals: { label: "Medals", Icon: Medal, blurb: "Every player ranked by lifetime medals, which set their league: Bronze, Silver, Gold, Platinum, Diamond, Master and Legend, each with levels I to V." },
};

const medalsOf = (r) => Number(r.medals) || 0;
const fmt = (n) => Number(n || 0).toLocaleString("en-IN");

function MedalCount({ r, className = "" }) {
  return (
    <span className={`inline-flex items-center gap-1 font-mono text-orange-200 ${className}`} title="Lifetime medals" data-testid={`leaderboard-medals-${r.rank}`}>
      <Medal size={11} aria-hidden="true" />{fmt(medalsOf(r))}
    </span>
  );
}

function PodiumSpot({ r, me, board }) {
  const p = PODIUM[r.rank];
  const mine = r.user_id === me;
  return (
    <div className="flex min-w-0 flex-1 flex-col items-center" data-testid={`leaderboard-row-${r.rank}`}>
      {r.rank === 1 && <Crown size={26} className="mb-1 text-amber-300 drop-shadow-[0_2px_6px_rgba(251,191,36,.6)]" aria-hidden="true" />}
      <Link to={`/profile/${r.username}`} className="group flex flex-col items-center">
        <div className={`rounded-full bg-gradient-to-br p-1 ${p.ring} ${p.glow}`}>
          <PlayerAvatar user={r} size={r.rank === 1 ? 64 : 52} online={r.online} />
        </div>
        <span className={`mt-2 max-w-full truncate text-sm font-semibold group-hover:text-amber-200 ${mine ? "text-amber-200" : ""}`}>{r.display_name || r.username}{mine ? " (you)" : ""}</span>
      </Link>
      <span className="mt-0.5 inline-flex items-center gap-1 text-[10px] text-white/55"><Star size={10} aria-hidden="true" />Lv {r.progression?.level || 1}</span>
      <div className={`mt-2 flex w-full flex-col items-center justify-start rounded-t-2xl border border-b-0 bg-gradient-to-b px-1 pb-3 pt-2 text-center ${p.plinth}`}>
        <span className={`font-display text-3xl leading-none ${p.text}`}>{r.rank}</span>
        <span className="mt-1 text-[10px] font-bold uppercase tracking-wider text-white/60">{p.label}</span>
        {board === "medals" ? (
          <>
            <span className="mt-1 inline-flex items-center gap-1 font-mono text-sm font-bold text-white"><Medal size={12} className="text-orange-300" aria-hidden="true" />{fmt(medalsOf(r))} <span className="text-[10px] font-normal text-white/50">medals</span></span>
            <span className="font-mono text-[11px] text-white/55">{r.stats.wins} wins · {r.win_rate}%</span>
          </>
        ) : (
          <>
            <span className="mt-1 font-mono text-sm font-bold text-white">{r.stats.wins} <span className="text-[10px] font-normal text-white/50">wins</span></span>
            <span className="font-mono text-[11px] text-white/55">{r.win_rate}% · {r.stats.games_played} games</span>
            <MedalCount r={r} className="mt-0.5 text-[11px]" />
          </>
        )}
      </div>
    </div>
  );
}

function RankRow({ r, me, board }) {
  const mine = r.user_id === me;
  const byMedals = board === "medals";
  return (
    <div className={`flex items-center gap-3 rounded-2xl border p-3 transition-colors ${mine ? "border-amber-300/60 bg-amber-300/10 shadow-[0_0_24px_-12px_rgba(251,191,36,.6)]" : "border-white/10 bg-white/[0.03] hover:border-white/20"}`}
      data-testid={`leaderboard-row-${r.rank}`}>
      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl font-mono text-sm font-bold ${mine ? "bg-amber-300 text-slate-950" : "bg-white/5 text-white/70"}`}>{r.rank}</span>
      <Link to={`/profile/${r.username}`} className="flex min-w-0 flex-1 items-center gap-3 hover:text-amber-200">
        <PlayerAvatar user={r} size={34} online={r.online} />
        <div className="min-w-0">
          <div className="truncate font-semibold">{r.display_name || r.username}{mine && <span className="ml-1.5 rounded-full bg-amber-300 px-1.5 py-px text-[9px] font-black uppercase text-slate-950">You</span>}</div>
          <div className="inline-flex items-center gap-1 text-[11px] text-white/50"><Star size={10} aria-hidden="true" />Lv {r.progression?.level || 1}</div>
        </div>
      </Link>
      {/* The board's own number comes first and largest. */}
      <div className="w-14 shrink-0 text-right">
        {byMedals
          ? <div className="font-mono text-base font-bold text-orange-200" data-testid={`leaderboard-medals-${r.rank}`}>{fmt(medalsOf(r))}</div>
          : <div className="font-mono text-base font-bold">{r.stats.wins}</div>}
        <div className="text-[10px] uppercase tracking-wider text-white/45">{byMedals ? "medals" : "wins"}</div>
      </div>
      <div className="w-12 shrink-0 text-right">
        {byMedals
          ? <div className="font-mono text-xs text-white/70">{r.stats.wins}</div>
          : <MedalCount r={r} className="justify-end text-xs" />}
        <div className="text-[10px] uppercase tracking-wider text-white/35">{byMedals ? "wins" : "medals"}</div>
      </div>
      <div className="hidden w-28 shrink-0 sm:block">
        <div className="flex justify-between text-[10px] text-white/50"><span>{r.stats.games_played} games</span><span className="font-mono text-white/80">{r.win_rate}%</span></div>
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-gradient-to-r from-emerald-300 to-emerald-500" style={{ width: `${Math.min(100, r.win_rate)}%` }} /></div>
      </div>
      <div className="hidden shrink-0 gap-3 md:flex">
        <span className="inline-flex items-center gap-1 text-xs text-amber-200" title="Koth wins"><Crown size={12} aria-hidden="true" />{r.stats.koth_wins}</span>
        <span className="inline-flex items-center gap-1 text-xs text-rose-200" title="13 Mann wins"><Flame size={12} aria-hidden="true" />{r.stats.grand_slam_wins}</span>
      </div>
    </div>
  );
}

const PAGE_SIZE = 20;
const LEAGUE_FILTERS = [null, ...LEAGUE_ORDER];

// The medal board: the server ranks every human player by lifetime medals and sends one page at a time;
// a league filter shows that league's slice of the global ranking. Nothing is ranked in the browser.
function MedalBoard({ api, meId }) {
  const [league, setLeague] = useState(null);
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  useEffect(() => {
    let live = true;
    setData(null);
    api.get("/leaderboard", { params: { by: "medals", page, page_size: PAGE_SIZE, ...(league ? { league } : {}) } })
      .then((r) => live && setData(r.data))
      .catch(() => live && setData({ rows: [], total: 0, pages: 1, page, me: null }));
    return () => { live = false; };
  }, [api, page, league]);
  const pickLeague = (id) => { setLeague(id); setPage(1); };
  const me = data?.me;
  const rows = data?.rows || [];
  return (
    <section className="space-y-3" data-testid="medal-board">
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by league" data-testid="league-filters">
        {LEAGUE_FILTERS.map((id) => (
          <button key={id || "all"} type="button" onClick={() => pickLeague(id)} aria-pressed={league === id} data-testid={`league-filter-${id || "all"}`}
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold transition-colors ${league === id ? "border-amber-300 bg-amber-300/15 text-amber-100" : "border-white/10 bg-white/[0.03] text-white/65 hover:border-white/25"}`}>
            {id && <LeagueBadge league={{ id, level: 1 }} size={16} showLevel={false} />}{id ? LEAGUE_NAME[id] : "All leagues"}
          </button>
        ))}
      </div>

      {me && (
        <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-amber-300/40 bg-amber-300/[0.07] px-4 py-2.5" data-testid="medal-board-me">
          <LeagueBadge league={me.league} size={34} />
          <div className="min-w-0 flex-1 text-sm">
            <div className="font-semibold text-amber-100">Your rank <span className="font-display text-xl" data-testid="medal-board-my-rank">#{me.rank}</span></div>
            <div className="text-xs text-white/55">{leagueLabel(me.league)} · {Number(me.medals).toLocaleString("en-IN")} medals</div>
          </div>
          {me.page && me.page !== page && (
            <button type="button" className="btn-ghost !py-1.5 text-xs" onClick={() => setPage(me.page)} data-testid="medal-board-jump-me">Show my page ({me.page})</button>
          )}
        </div>
      )}

      {data === null ? <p className="text-muted-foreground" data-testid="medal-board-loading">Loading…</p>
        : rows.length === 0 ? (
          <div className="flex flex-col items-center rounded-3xl border border-dashed border-white/15 bg-white/[0.02] px-6 py-10 text-center" data-testid="leaderboard-empty">
            <Medal size={30} className="text-amber-300/70" aria-hidden="true" />
            <h2 className="mt-3 font-display text-2xl">{league ? `No players in ${LEAGUE_NAME[league]} yet` : "The hall is empty"}</h2>
            <p className="mt-1 text-sm text-muted-foreground">Win rounds in matches without bots to earn medals and climb the leagues.</p>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between px-1 text-[10px] uppercase tracking-wider text-white/45">
              <span>Rank · Player · League</span><span>Medals · Wins</span>
            </div>
            <ol className="space-y-2">
              {rows.map((r) => {
                const mine = r.user_id === meId;
                return (
                  <li key={r.user_id} className={`flex items-center gap-3 rounded-2xl border p-2.5 sm:p-3 ${mine ? "border-amber-300/60 bg-amber-300/10" : "border-white/10 bg-white/[0.03] hover:border-white/20"}`}
                    data-testid={`medal-row-${r.rank}`}>
                    <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl font-mono text-sm font-bold ${r.rank <= 3 ? "bg-gradient-to-br from-amber-100 to-amber-400 text-slate-950" : mine ? "bg-amber-300 text-slate-950" : "bg-white/5 text-white/70"}`}>{r.rank}</span>
                    <LeagueBadge league={r.league} size={34} />
                    <Link to={`/profile/${r.username}`} className="min-w-0 flex-1 hover:text-amber-200">
                      <div className="truncate font-semibold">{r.display_name || r.username}{mine && <span className="ml-1.5 rounded-full bg-amber-300 px-1.5 py-px text-[9px] font-black uppercase text-slate-950">You</span>}</div>
                      <div className="text-[11px] text-white/50" data-testid={`medal-row-${r.rank}-league`}>{leagueLabel(r.league)}</div>
                    </Link>
                    <div className="w-16 shrink-0 text-right">
                      <div className="font-mono text-base font-bold text-orange-200" data-testid={`leaderboard-medals-${r.rank}`}>{Number(r.medals || 0).toLocaleString("en-IN")}</div>
                      <div className="text-[10px] text-white/45">{r.stats?.wins ?? 0} wins</div>
                    </div>
                  </li>
                );
              })}
            </ol>
            <nav className="flex items-center justify-between gap-3 pt-1" aria-label="Leaderboard pages" data-testid="medal-board-pages">
              <button type="button" className="btn-ghost !py-1.5 text-sm" disabled={page <= 1} onClick={() => setPage((n) => Math.max(1, n - 1))} data-testid="medal-board-prev">Previous</button>
              <span className="text-xs text-white/55" data-testid="medal-board-page">Page {data.page} of {data.pages} · {Number(data.total).toLocaleString("en-IN")} players</span>
              <button type="button" className="btn-ghost !py-1.5 text-sm" disabled={page >= data.pages} onClick={() => setPage((n) => n + 1)} data-testid="medal-board-next">Next</button>
            </nav>
          </>
        )}
    </section>
  );
}

export default function Leaderboard() {
  const { api, me } = useApp();
  // ?board=medals (from the dashboard and the header) opens the medal board.
  const [board, setBoard] = useState(() => (new URLSearchParams(window.location.search).get("board") === "medals" ? "medals" : "wins"));
  const [rows, setRows] = useState(null);
  useEffect(() => {
    if (board !== "wins") return undefined;
    let live = true;
    setRows(null);
    api.get("/leaderboard").then((r) => live && setRows(r.data)).catch(() => live && setRows([]));
    return () => { live = false; };
  }, [api, board]);
  const list = rows || [];
  const podium = list.filter((r) => r.rank <= 3);
  const rest = list.filter((r) => r.rank > 3);
  const mine = list.find((r) => r.user_id === me.user_id);
  // Podium order: 2nd, 1st, 3rd.
  const ordered = [2, 1, 3].map((rank) => podium.find((r) => r.rank === rank)).filter(Boolean);
  const info = BOARDS[board];
  const wins = board === "wins";

  return (
    <div className="space-y-6" data-testid="leaderboard-page">
      <section className="relative overflow-hidden rounded-3xl border border-amber-300/25 bg-gradient-to-br from-[#2a1f0a] via-[#16120a] to-[#0a0a0f] p-5 shadow-[0_24px_60px_-30px_rgba(0,0,0,.95)] sm:p-7">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_50%_0%,rgba(251,191,36,.22),transparent_60%)]" aria-hidden="true" />
        <div className="relative flex flex-wrap items-center gap-4">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-200 to-amber-500 text-slate-950 shadow-[inset_0_2px_0_rgba(255,255,255,.4),0_10px_22px_-10px_rgba(0,0,0,.9)]" aria-hidden="true"><info.Icon size={26} /></span>
          <div className="min-w-0 flex-1">
            <p className="eyebrow !text-amber-200/70">Hall of tens</p>
            <h1 className="break-words font-display text-3xl text-amber-50 sm:text-4xl">Leaderboard</h1>
            <p className="mt-1 text-xs text-white/55" data-testid="leaderboard-blurb">{info.blurb}</p>
          </div>
          {wins && mine && (
            <div className="flex basis-full items-center justify-center gap-3 rounded-2xl border border-amber-300/40 bg-black/30 px-4 py-2 text-center sm:block sm:basis-auto" data-testid="leaderboard-my-rank">
              <div className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-amber-200/80"><Medal size={11} aria-hidden="true" />Your rank</div>
              <div className="font-display text-3xl leading-none text-amber-200">#{mine.rank}</div>
            </div>
          )}
        </div>

        <div className="relative mt-5 inline-flex rounded-full border border-white/10 bg-black/30 p-1" role="tablist" aria-label="Rank players by">
          {Object.entries(BOARDS).map(([id, b]) => (
            <button key={id} type="button" role="tab" aria-selected={board === id} onClick={() => setBoard(id)} data-testid={`leaderboard-tab-${id}`}
              className={`inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-xs font-bold transition-colors ${board === id ? "bg-gradient-to-r from-amber-200 to-amber-400 text-slate-950 shadow" : "text-white/65 hover:text-white"}`}>
              <b.Icon size={13} aria-hidden="true" />{b.label}
            </button>
          ))}
        </div>

        {wins && ordered.length > 0 && (
          <div className="relative mx-auto mt-8 flex max-w-xl items-end gap-2 sm:gap-4" data-testid="leaderboard-podium">
            {ordered.map((r) => <PodiumSpot key={r.user_id} r={r} me={me.user_id} board="wins" />)}
          </div>
        )}
      </section>

      {!wins ? <MedalBoard api={api} meId={me.user_id} />
        : rows === null ? <p className="text-muted-foreground">Loading…</p>
          : list.length === 0 ? (
            <div className="flex flex-col items-center rounded-3xl border border-dashed border-white/15 bg-white/[0.02] px-6 py-10 text-center" data-testid="leaderboard-empty">
              <Trophy size={30} className="text-amber-300/70" aria-hidden="true" />
              <h2 className="mt-3 font-display text-2xl">The hall is empty</h2>
              <p className="mt-1 text-sm text-muted-foreground">No players ranked yet.</p>
            </div>
          ) : rest.length > 0 && (
            <section aria-label="Ranks 4 and below">
              <div className="mb-2 flex items-center justify-between px-1 text-[10px] uppercase tracking-wider text-white/45">
                <span>Player</span>
                <span className="hidden sm:inline">Wins · Medals · Win rate · Koth · 13 Mann</span>
                <span className="sm:hidden">Wins · Medals</span>
              </div>
              <div className="space-y-2">{rest.map((r) => <RankRow key={r.user_id} r={r} me={me.user_id} board="wins" />)}</div>
            </section>
          )}
    </div>
  );
}