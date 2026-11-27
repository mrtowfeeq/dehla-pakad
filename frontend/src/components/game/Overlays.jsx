import { useState } from "react";
import { motion } from "framer-motion";
import { Link } from "react-router-dom";
import { Trophy, Flag, Share2, RotateCcw, History, Home, Crown, Flame, Sparkles, ShieldCheck, Target, XCircle, Scale, Info } from "lucide-react";
import { PlayingCard } from "@/components/PlayingCard";
import { PlayerAvatar } from "@/components/PlayerAvatar";
import { SUIT_SYMBOL, SUIT_NAME, TEAM_NAME, VICTORY_LABEL, REASON_LABEL, isRed } from "@/lib/api";
import { Burst } from "@/components/game/Effects";
import { CoinPayout } from "@/components/coins/CoinPayout";
import { MatchMedals } from "@/components/medals/MatchMedals";

function Modal({ children, testId, delay = 0, tone }) {
  return (
    <motion.div className="absolute inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-sm p-4" data-testid={testId}
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay }}>
      <motion.div initial={{ opacity: 0, y: 24, scale: 0.96 }} animate={tone === "loss" ? { opacity: 1, y: 0, scale: 1, x: [0, -6, 6, -3, 0] } : { opacity: 1, y: 0, scale: 1 }}
        transition={{ delay, duration: 0.45 }}
        className={`relative w-full max-w-md rounded-2xl border bg-[#0b1a17]/95 text-white p-6 shadow-2xl max-h-[90vh] overflow-y-auto ${tone === "loss" ? "border-rose-400/30" : "border-amber-400/30"}`}>
        {tone === "win" && <Burst />}
        {children}
      </motion.div>
    </motion.div>
  );
}

export function Banner({ children, testId }) {
  return (
    <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-40 rounded-xl bg-black/70 backdrop-blur px-5 py-3 text-sm text-white text-center max-w-[80%]" data-testid={testId}>
      {children}
    </div>
  );
}

export function TrumpSelector({ onPick }) {
  return (
    <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[min(100%,300px)] rounded-2xl border border-amber-400/40 bg-[#0b1a17]/95 p-3 sm:p-5 text-white text-center shadow-2xl" data-testid="trump-suit-selector">
      <p className="eyebrow !text-amber-200/80">You choose trump</p>
      <p className="text-xs text-white/60 mt-1">Based on your first five cards — any suit is allowed.</p>
      <div className="grid grid-cols-4 gap-2 mt-4">
        {["S", "H", "D", "C"].map((s) => (
          <button key={s} onClick={() => onPick(s)} data-testid={`trump-option-${s}`}
            className="h-14 w-full sm:h-16 sm:w-16 rounded-xl bg-white hover:-translate-y-1 hover:shadow-amber-400/40 hover:shadow-lg transition-transform flex flex-col items-center justify-center">
            <span className={`text-3xl leading-none ${isRed(s) ? "text-rose-600" : "text-slate-900"}`}>{SUIT_SYMBOL[s]}</span>
            <span className="text-[9px] text-slate-600 font-bold uppercase mt-0.5">{SUIT_NAME[s]}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function KothPrompt({ onDecide }) {
  return (
    <Modal testId="koth-decision-modal">
      <p className="eyebrow !text-amber-200/80">Third ten captured</p>
      <h2 className="font-display text-2xl mt-2">Declare Koth?</h2>
      <p className="text-sm text-white/70 mt-3">The fourth ten is still in play. Declare Koth and whichever team captures it wins the round for <b>2 points</b>. Decline to take a <b>Normal Win (1 point)</b> now.</p>
      <div className="grid grid-cols-2 gap-3 mt-6">
        <button className="btn-ghost !bg-white/5 !border-white/15 text-white" onClick={() => onDecide(false)} data-testid="koth-decline-btn">Take Normal Win</button>
        <button className="btn-gold" onClick={() => onDecide(true)} data-testid="koth-declare-btn">Declare Koth</button>
      </div>
    </Modal>
  );
}

export function GrandSlamPrompt({ partnerHand, onDecide, autoKoth = false }) {
  return (
    <Modal testId="grand-slam-decision-modal">
      <p className="eyebrow !text-amber-200/80">Seven tricks in a row</p>
      <h2 className="font-display text-2xl mt-2">Go for 13 Mann?</h2>
      <p className="text-sm text-white/70 mt-3">Declare Grand Slam and your team must win all six remaining tricks for <b>3 points</b>. Lose one and the opponents get the Grand Slam. It replaces any active Koth.</p>
      {autoKoth && <p className="text-sm text-amber-100/80 mt-2" data-testid="grand-slam-auto-koth-note">Your team captured the third and fourth tens together. Decline to take the automatic <b>Koth (2 points)</b> now.</p>}
      <div className="mt-4">
        <div className="text-xs text-white/60 mb-2">Your partner's remaining cards (shown once):</div>
        <div className="flex flex-wrap gap-1" data-testid="partner-hand-reveal">
          {(partnerHand || []).map((c) => <PlayingCard key={c} card={c} size="sm" testId={`partner-card-${c}`} />)}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 mt-6">
        <button className="btn-ghost !bg-white/5 !border-white/15 text-white" onClick={() => onDecide(false)} data-testid="grand-slam-decline-btn">{autoKoth ? "Take Koth" : "Decline"}</button>
        <button className="btn-gold" onClick={() => onDecide(true)} data-testid="grand-slam-declare-btn">Declare Grand Slam</button>
      </div>
    </Modal>
  );
}

function formatMatchTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function formatMatchDuration(seconds) {
  if (!Number.isFinite(seconds)) return "—";
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return minutes ? `${minutes}m ${remainingSeconds}s` : `${remainingSeconds}s`;
}

// Visual tone per result: plaque tint, medallion gradient, title gradient and accent colours.
const PLAQUE_TONE = {
  normal: {
    Icon: Sparkles,
    border: "border-emerald-300/30", glow: "shadow-[0_0_40px_-12px_rgba(52,211,153,.45)]",
    bg: "from-emerald-400/[0.16] via-emerald-900/10 to-transparent",
    medal: "from-emerald-200 via-emerald-400 to-emerald-800", ring: "ring-emerald-200/40",
    title: "from-emerald-50 via-emerald-200 to-emerald-400", accent: "text-emerald-300",
  },
  koth: {
    Icon: Crown,
    border: "border-amber-300/40", glow: "shadow-[0_0_44px_-12px_rgba(251,191,36,.55)]",
    bg: "from-amber-400/[0.18] via-amber-900/10 to-transparent",
    medal: "from-amber-100 via-amber-300 to-amber-700", ring: "ring-amber-100/50",
    title: "from-amber-50 via-amber-200 to-amber-400", accent: "text-amber-300",
  },
  grand_slam: {
    Icon: Flame,
    border: "border-rose-300/40", glow: "shadow-[0_0_48px_-12px_rgba(251,113,133,.5)]",
    bg: "from-rose-500/[0.18] via-amber-900/10 to-transparent",
    medal: "from-amber-200 via-rose-400 to-rose-800", ring: "ring-rose-100/40",
    title: "from-amber-100 via-amber-200 to-rose-300", accent: "text-rose-300",
  },
  forfeit: {
    Icon: Flag,
    border: "border-rose-300/30", glow: "shadow-[0_0_36px_-14px_rgba(251,113,133,.4)]",
    bg: "from-rose-500/[0.12] via-slate-900/10 to-transparent",
    medal: "from-rose-200 via-rose-400 to-rose-800", ring: "ring-rose-100/30",
    title: "from-rose-50 via-rose-200 to-rose-300", accent: "text-rose-300",
  },
};

// Title and one-sentence explanation for each way a round ends, naming the teams involved.
// W = the round's winning team, L = the other team.
const REASON_DETAIL = {
  three_tens: { Icon: Target, title: "Three tens captured", detail: (W) => `${W} took three of the four tens while the opponents held the other.` },
  koth_declined: { Icon: Target, title: "Koth declined", detail: (W) => `${W} held three tens and chose the normal win.` },
  koth_fourth_ten: { Icon: Crown, title: "Fourth ten captured", detail: (W) => `After Koth was declared, ${W} captured the deciding fourth ten.` },
  automatic_koth: { Icon: Crown, title: "Automatic Koth", detail: (W) => `${W} captured the third and fourth tens together.` },
  grand_slam: { Icon: Trophy, title: "13 Mann completed", detail: (W) => `${W} won all thirteen tricks.` },
  grand_slam_failed: { Icon: XCircle, title: "Grand Slam attempt failed", detail: (W, L) => `${L} declared 13 Mann but lost a trick, so ${W} receives the Grand Slam.` },
  equal_tens: { Icon: Scale, title: "Tens split 2–2", detail: (W) => `Each team held two tens; ${W} won at least seven tricks.` },
  two_tens_seven_tricks: { Icon: Target, title: "Two tens and seven tricks", detail: (W) => `${W} held two tens and seven tricks while the opponents had a ten.` },
};

function finalReason(round, reason) {
  if (!reason) return null;
  const entry = REASON_DETAIL[reason];
  const winner = round?.winner_team === 0 || round?.winner_team === 1 ? round.winner_team : null;
  if (!entry || winner === null) return { Icon: Info, title: REASON_LABEL[reason] || reason, detail: "" };
  return { Icon: entry.Icon, title: entry.title, detail: entry.detail(TEAM_NAME[winner], TEAM_NAME[1 - winner]) };
}

// Game-style result plaque: a glowing medallion, the result as a gold display title, the reason, and a
// points stamp, on a panel tinted by the result type with a single light sweep when it appears.
function ResultPlaque({ tone, eyebrow, title, reason, points, scorer }) {
  const t = PLAQUE_TONE[tone] || PLAQUE_TONE.normal;
  return (
    <div className={`relative mt-4 w-full max-w-2xl overflow-hidden rounded-2xl border bg-gradient-to-r p-3 sm:p-4 ${t.border} ${t.bg} ${t.glow}`}
      data-testid="victory-type" data-tone={tone}>
      <div className="pointer-events-none absolute inset-0 rounded-2xl shadow-[inset_0_1px_0_rgba(255,255,255,.10),inset_0_-20px_40px_-30px_rgba(0,0,0,.8)]" aria-hidden="true" />
      <motion.div className="pointer-events-none absolute inset-y-0 -left-1/3 w-1/3 -skew-x-12 bg-gradient-to-r from-transparent via-white/[0.09] to-transparent" aria-hidden="true"
        initial={{ x: "0%" }} animate={{ x: "420%" }} transition={{ delay: 0.5, duration: 1.4, ease: "easeInOut" }} />
      <div className="relative grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:gap-4">
        <motion.div className={`relative flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-gradient-to-br shadow-[0_8px_24px_-8px_rgba(0,0,0,.9),inset_0_2px_0_rgba(255,255,255,.45)] ring-4 sm:h-16 sm:w-16 ${t.medal} ${t.ring}`}
          initial={{ scale: 0.6, rotate: -18, opacity: 0 }} animate={{ scale: 1, rotate: 0, opacity: 1 }}
          transition={{ delay: 0.15, type: "spring", stiffness: 260, damping: 16 }} aria-hidden="true">
          <span className="absolute inset-1.5 rounded-full border border-white/30" />
          <t.Icon size={26} className="text-slate-950 drop-shadow-[0_1px_0_rgba(255,255,255,.4)]" strokeWidth={2.2} />
        </motion.div>
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-[0.24em] text-white/50">{eyebrow}</div>
          <div className={`mt-0.5 bg-gradient-to-r bg-clip-text font-display text-xl uppercase leading-tight tracking-wide text-transparent sm:text-2xl ${t.title}`} data-testid="victory-type-badge">
            {title}
          </div>
          {reason && (
            <div className="mt-1.5" data-testid="victory-type-reason">
              <div className={`flex items-center gap-1.5 text-sm font-semibold text-white/90`}>
                {reason.Icon && <reason.Icon size={14} className={t.accent} aria-hidden="true" />}
                <span data-testid="victory-type-reason-title">{reason.title}</span>
              </div>
              {reason.detail && <p className="mt-0.5 text-xs leading-relaxed text-white/60" data-testid="victory-type-reason-detail">{reason.detail}</p>}
            </div>
          )}
        </div>
        {points ? (
          <div className={`col-span-2 flex items-center justify-center gap-2 rounded-xl border bg-black/35 px-3 py-2 text-center shadow-[inset_0_1px_0_rgba(255,255,255,.08)] sm:col-span-1 sm:flex-col sm:gap-0 sm:px-4 ${t.border}`}
            data-testid="victory-type-points">
            <b className="bg-gradient-to-b from-amber-100 to-amber-400 bg-clip-text font-display text-3xl leading-none text-transparent sm:text-4xl">+{points}</b>
            <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-amber-100/70">{scorer ? ` to ${scorer}` : " points"}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

// How the match was decided: the final round's result type, the exact reason naming both teams, and
// the points with who scored them. Forfeits and missing data get their own plaques.
export function FinalRoundSummary({ finalRound, reason, forfeiter }) {
  if (forfeiter) {
    return (
      <ResultPlaque tone="forfeit" eyebrow="Match ended" title="Forfeit"
        reason={{ title: `${forfeiter.display_name || forfeiter.username} forfeited the match`, detail: "" }} />
    );
  }
  if (!finalRound) {
    return (
      <ResultPlaque tone="normal" eyebrow="Match complete" title="Final result"
        reason={{ Icon: ShieldCheck, title: "Final result confirmed by the game server", detail: "" }} />
    );
  }
  const scorer = finalRound.winner_team === 0 || finalRound.winner_team === 1 ? TEAM_NAME[finalRound.winner_team] : null;
  return (
    <ResultPlaque tone={PLAQUE_TONE[finalRound.type] ? finalRound.type : "normal"} eyebrow="Final round · decided by"
      title={VICTORY_LABEL[finalRound.type] || finalRound.type} reason={finalReason(finalRound, reason)}
      points={finalRound.points} scorer={scorer} />
  );
}

export function MatchOver({ st, players, mySeat, game, spectator = false }) {
  const [shareStatus, setShareStatus] = useState("");
  const summary = game?.result_summary || {};
  const winnerTeam = summary.winner_team !== undefined ? summary.winner_team : st.winner_team;
  const hasWinner = winnerTeam === 0 || winnerTeam === 1;
  const draw = !hasWinner && (summary.is_draw === true || st.result?.is_draw === true || st.result?.type === "draw");
  const won = !spectator && hasWinner && mySeat !== null && mySeat !== undefined && winnerTeam === mySeat % 2;
  const unknownResult = !hasWinner && !draw;
  const rounds = Array.isArray(st.rounds) ? st.rounds : [];
  const scores = Array.isArray(summary.scores) ? summary.scores : Array.isArray(st.scores) ? st.scores : [0, 0];
  const tricksWon = Array.isArray(summary.tricks_won) ? summary.tricks_won : null;
  const target = summary.target ?? st.target;
  const roundsPlayed = summary.rounds_played ?? st.round_no ?? rounds.length;
  const finalTrick = summary.last_trick || st.last_trick;
  const finalTrump = summary.final_trump || st.trump;
  const finalResult = summary.final_result || st.result;
  const forfeitedBy = summary.forfeited_by ?? st.forfeited_by;
  const forfeiter = forfeitedBy !== null && forfeitedBy !== undefined ? players.find((p) => p.seat === forfeitedBy) : null;
  const finalRound = rounds[rounds.length - 1];
  const reason = forfeiter ? `${forfeiter.username} forfeited the match` : finalResult?.reason || finalRound?.reason;
  const teamPlayers = (team) => players.filter((p) => p.team === team).sort((a, b) => a.seat - b.seat);
  const roundWins = (team, type) => rounds.filter((r) => r.winner_team === team && r.type === type).length;

  const shareResult = async () => {
    const resultText = draw
      ? `Dehla Pakad match drawn ${scores[0]}–${scores[1]} after ${roundsPlayed} rounds.`
      : hasWinner
        ? `Dehla Pakad: ${TEAM_NAME[winnerTeam]} won ${scores[0]}–${scores[1]} (target ${target}) after ${roundsPlayed} rounds.`
        : `Dehla Pakad match result ${scores[0]}–${scores[1]} after ${roundsPlayed} rounds.`;
    const payload = { title: "Dehla Pakad match result", text: resultText };
    try {
      if (typeof navigator !== "undefined" && navigator.share) {
        await navigator.share(payload);
        setShareStatus("Shared");
        return;
      }
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(resultText);
        setShareStatus("Copied to clipboard");
        return;
      }
      setShareStatus("Sharing is unavailable in this browser");
    } catch (error) {
      if (error?.name === "AbortError") return;
      setShareStatus("Sharing failed");
    }
  };

  return (
    <motion.div className="absolute inset-0 z-50 overflow-y-auto bg-[#04100b] text-white" data-testid="victory-screen"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3 }}>
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(16,90,63,.48),transparent_60%)]" />
      <main className="relative mx-auto flex min-h-full w-full max-w-6xl flex-col gap-4 px-3 py-4 sm:gap-5 sm:px-6 sm:py-6 lg:gap-6 lg:px-8 lg:py-8">
        <motion.section className={`relative isolate overflow-hidden rounded-3xl border bg-[#071710]/90 p-4 shadow-2xl sm:p-6 lg:p-8 ${won ? "border-amber-300/35" : draw || unknownResult || spectator ? "border-white/15" : "border-rose-300/25"}`}
          initial={{ y: 14, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ duration: 0.35 }}>
          {won && <Burst count={24} />}
          <div className="relative z-10 grid gap-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
            <div className="min-w-0">
              <div className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-bold uppercase tracking-[0.16em] ${won ? "border-amber-200/30 bg-amber-200/10 text-amber-200" : draw || unknownResult ? "border-white/15 bg-white/5 text-white/75" : "border-rose-200/25 bg-rose-200/10 text-rose-200"}`}>
                {won ? <Trophy size={15} /> : draw || unknownResult ? <span aria-hidden="true">—</span> : <Flag size={14} />}
                {spectator ? "Final result" : draw ? "Match drawn" : won ? "Victory" : unknownResult ? "Result unavailable" : "Defeat"}
              </div>
              <h1 className="mt-3 break-words font-display text-3xl leading-tight sm:text-4xl lg:text-5xl" data-testid="victory-winning-team">
                {hasWinner ? `${TEAM_NAME[winnerTeam]} wins the match` : draw ? "The match is a draw" : "Match result unavailable"}
              </h1>
              <FinalRoundSummary finalRound={finalRound} reason={reason} forfeiter={forfeiter} />
              {game?.stake && !spectator && hasWinner && mySeat !== null && mySeat !== undefined && (
                <CoinPayout won={won} stake={game.stake} />
              )}
              {!spectator && mySeat !== null && mySeat !== undefined && (
                <MatchMedals summary={game?.match_medals} eligible={game?.medals_eligible} players={players} mySeat={mySeat} />
              )}
              {hasWinner && (
                <div className="mt-4 flex flex-wrap items-center gap-3" data-testid="winning-team-players">
                  {teamPlayers(winnerTeam).map((player) => (
                    player.is_bot
                      ? <div key={player.seat} className="flex min-w-0 items-center gap-2 rounded-full border border-amber-100/15 bg-black/20 py-1.5 pl-1.5 pr-3"><PlayerAvatar user={player} size={32} /><span className="max-w-[150px] truncate text-sm font-semibold">{player.username}</span></div>
                      : <Link key={player.seat} to={`/profile/${encodeURIComponent(player.username)}`} className="flex min-w-0 items-center gap-2 rounded-full border border-amber-100/15 bg-black/20 py-1.5 pl-1.5 pr-3 hover:border-amber-100/35" data-testid={`result-profile-link-${player.seat}`}>
                        <PlayerAvatar user={player} size={32} />
                        <span className="max-w-[150px] truncate text-sm font-semibold">{player.display_name || player.username}</span>
                      </Link>
                  ))}
                </div>
              )}
              <div className="mt-5 flex flex-wrap gap-2" data-testid="match-result-actions">
                {spectator
                  ? <Link to="/spectate" className="btn-gold !px-4 !py-2.5" data-testid="spectator-results-list-btn"><History size={16} /> Return to games list</Link>
                  : <><Link to="/play" className="btn-gold !px-4 !py-2.5" data-testid="victory-play-again-btn"><RotateCcw size={16} /> Play Again</Link>
                    <Link to="/history" className="btn-ghost !border-white/15 !bg-white/5 !px-4 !py-2.5 text-white" data-testid="victory-history-btn"><History size={16} /> Match History</Link></>}
                <Link to="/home" className="btn-ghost !border-white/15 !bg-white/5 !px-4 !py-2.5 text-white" data-testid="victory-home-btn"><Home size={16} /> Return Home</Link>
                <button type="button" onClick={shareResult} className="btn-ghost !border-white/15 !bg-white/5 !px-4 !py-2.5 text-white" data-testid="victory-share-btn"><Share2 size={16} /> Share Result</button>
              </div>
              <p className="mt-2 min-h-4 text-xs text-emerald-200/80" aria-live="polite" data-testid="victory-share-status">{shareStatus}</p>
            </div>
            <div className="rounded-2xl border border-amber-100/15 bg-black/25 px-5 py-4 text-center lg:min-w-52" data-testid="victory-final-score">
              <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-white/45">Final score</div>
              <div className="mt-2 flex items-baseline justify-center gap-2 font-mono text-4xl font-bold tabular-nums sm:text-5xl">
                <span className={winnerTeam === 0 ? "text-amber-200" : "text-team-a"}>{scores[0]}</span>
                <span className="text-white/30">–</span>
                <span className={winnerTeam === 1 ? "text-amber-200" : "text-team-b"}>{scores[1]}</span>
              </div>
              <div className="mt-2 text-xs text-white/55">First to {target}</div>
            </div>
          </div>
        </motion.section>

        <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(280px,.75fr)] lg:gap-5">
          <section className="min-w-0 rounded-3xl border border-white/10 bg-[#071710]/85 p-4 sm:p-5" data-testid="match-scoreboard">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-amber-200/60">Match scoreboard</p>
                <h2 className="mt-1 font-display text-xl sm:text-2xl">Both teams</h2>
              </div>
              <span className="rounded-full bg-white/5 px-3 py-1 text-xs text-white/60">{roundsPlayed} rounds · target {target}</span>
            </div>
            <div className="mt-4 grid min-w-0 gap-3 sm:grid-cols-2">
              {[0, 1].map((team) => {
                const teamWon = hasWinner && winnerTeam === team;
                return (
                  <article key={team} className={`min-w-0 rounded-2xl border p-3 sm:p-4 ${teamWon ? "border-amber-200/35 bg-amber-200/[0.07] shadow-[0_0_24px_rgba(245,190,75,.08)]" : "border-white/10 bg-black/15"}`} data-testid={`match-team-${team}`}>
                    <div className="flex items-center justify-between gap-2">
                      <h3 className={`font-bold uppercase tracking-wider ${team === 0 ? "text-team-a" : "text-team-b"}`}>{TEAM_NAME[team]}</h3>
                      {teamWon && <span className="rounded-full bg-amber-200/15 px-2 py-1 text-[9px] font-bold uppercase tracking-wider text-amber-100">Winner</span>}
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <div className="rounded-xl bg-black/20 p-2.5">
                        <div className="text-[9px] font-bold uppercase tracking-wider text-white/45">Final score</div>
                        <div className="mt-1 font-mono text-2xl font-bold tabular-nums">{scores[team]}<span className="text-sm text-white/40">/{target}</span></div>
                      </div>
                      <div className="rounded-xl bg-black/20 p-2.5">
                        <div className="text-[9px] font-bold uppercase tracking-wider text-white/45">Match tricks</div>
                        <div className="mt-1 font-mono text-2xl font-bold tabular-nums">{tricksWon?.[team] ?? "—"}</div>
                      </div>
                    </div>
                    <div className="mt-3 space-y-2">
                      {teamPlayers(team).map((player) => {
                        const content = <><PlayerAvatar user={player} size={32} /><div className="min-w-0 flex-1"><div className="truncate text-sm font-semibold">{player.display_name || player.username}</div><div className="text-[10px] text-white/45">{TEAM_NAME[team]} · Seat {player.seat + 1}</div></div></>;
                        return player.is_bot
                          ? <div key={player.seat} className="flex min-w-0 items-center gap-2 rounded-xl border border-white/5 bg-white/[0.025] p-2">{content}</div>
                          : <Link key={player.seat} to={`/profile/${encodeURIComponent(player.username)}`} className="flex min-w-0 items-center gap-2 rounded-xl border border-white/5 bg-white/[0.025] p-2 hover:border-amber-100/25" data-testid={`scoreboard-profile-link-${player.seat}`}>{content}</Link>;
                      })}
                    </div>
                    <div className="mt-3 border-t border-white/10 pt-2 text-[10px] text-white/55" data-testid={`team-round-wins-${team}`}>
                      Round wins · Normal {roundWins(team, "normal")} · Koth {roundWins(team, "koth")} · Grand Slam {roundWins(team, "grand_slam")}
                    </div>
                  </article>
                );
              })}
            </div>
            <p className="mt-3 text-[10px] text-white/40">Individual card totals are not tracked; player details and team totals come from the match record.</p>
          </section>

          <section className="min-w-0 rounded-3xl border border-white/10 bg-[#071710]/85 p-4 sm:p-5" data-testid="match-summary">
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-amber-200/60">Match summary</p>
            <h2 className="mt-1 font-display text-xl sm:text-2xl">Table details</h2>
            <dl className="mt-4 grid grid-cols-2 gap-2">
              {[
                ["Room ID", game?.room_code || "—", "match-room-id"],
                ["Match type", game?.is_public ? "Public" : "Private", "match-room-type"],
                ["Rounds played", roundsPlayed, "match-rounds-played"],
                ["Total tricks", summary.total_tricks ?? "—", "match-total-tricks"],
                ["Duration", formatMatchDuration(summary.duration_seconds), "match-duration"],
                ["Final trump", finalTrump ? `${SUIT_SYMBOL[finalTrump] || ""} ${SUIT_NAME[finalTrump] || finalTrump}` : "—", "match-final-trump"],
              ].map(([label, value, testId]) => (
                <div key={label} className="min-w-0 rounded-xl bg-black/20 p-2.5 sm:p-3" data-testid={testId}>
                  <dt className="text-[9px] font-bold uppercase tracking-wider text-white/40">{label}</dt>
                  <dd className="mt-1 break-words text-sm font-semibold">{value}</dd>
                </div>
              ))}
              <div className="min-w-0 rounded-xl bg-black/20 p-2.5 sm:p-3" data-testid="match-started-at">
                <dt className="text-[9px] font-bold uppercase tracking-wider text-white/40">Started</dt>
                <dd className="mt-1 break-words text-xs font-medium">{formatMatchTime(summary.started_at || game?.created_at)}</dd>
              </div>
              <div className="min-w-0 rounded-xl bg-black/20 p-2.5 sm:p-3" data-testid="match-finished-at">
                <dt className="text-[9px] font-bold uppercase tracking-wider text-white/40">Completed</dt>
                <dd className="mt-1 break-words text-xs font-medium">{formatMatchTime(summary.finished_at || game?.finished_at)}</dd>
              </div>
            </dl>
            <div className="mt-3 rounded-xl border border-white/10 bg-black/15 p-3" data-testid="match-completion-reason">
              <div className="text-[9px] font-bold uppercase tracking-wider text-white/40">Completion</div>
              <div className="mt-1 text-sm text-white/80">{reason ? REASON_LABEL[reason] || reason : draw ? "Draw" : unknownResult ? "The server did not provide a winning team." : "Match target reached"}</div>
              {!forfeiter && finalResult?.type && <div className="mt-1 text-xs text-white/50">{VICTORY_LABEL[finalResult.type] || finalResult.type}</div>}
            </div>
          </section>
        </div>

        <div className="grid min-w-0 gap-4 lg:grid-cols-2">
          {finalTrick?.cards?.length > 0 && (
            <section className="min-w-0 rounded-3xl border border-white/10 bg-[#071710]/85 p-4 sm:p-5" data-testid="match-last-trick">
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-amber-200/60">Match highlight</p>
              <h2 className="mt-1 font-display text-xl">Last completed trick</h2>
              <div className="mt-3 flex flex-wrap items-end gap-3">
                {finalTrick.cards.map(([seat, card]) => (
                  <div key={`${seat}-${card}`} className="text-center">
                    <PlayingCard card={card} size="xs" testId={`result-trick-card-${seat}`} className={seat === finalTrick.winner ? "ring-2 ring-amber-300" : ""} />
                    <div className="mt-1 max-w-16 truncate text-[9px] text-white/55">{players.find((p) => p.seat === seat)?.username || `Seat ${seat + 1}`}</div>
                  </div>
                ))}
                {finalTrick.winner !== null && finalTrick.winner !== undefined && (
                  <p className="pb-5 text-xs text-amber-100/75">Won by {players.find((p) => p.seat === finalTrick.winner)?.username || `Seat ${finalTrick.winner + 1}`}</p>
                )}
              </div>
            </section>
          )}
          {rounds.length > 0 && (
            <section className="min-w-0 rounded-3xl border border-white/10 bg-[#071710]/85 p-4 sm:p-5" data-testid="match-round-results">
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-amber-200/60">Match history</p>
              <h2 className="mt-1 font-display text-xl">Round results</h2>
              <div className="mt-3 max-h-64 space-y-2 overflow-y-auto pr-1">
                {rounds.map((round, index) => (
                  <article key={`${round.round ?? index}-${round.reason}`} className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-xl border border-white/5 bg-black/15 p-2.5" data-testid={`match-result-round-${round.round ?? index + 1}`}>
                    <div className="min-w-0">
                      <div className="text-xs font-bold">Round {round.round ?? index + 1} · {TEAM_NAME[round.winner_team]}</div>
                      <div className="mt-0.5 truncate text-[10px] text-white/50">{VICTORY_LABEL[round.type] || round.type} · Tricks {round.tricks_won?.[0] ?? "—"}–{round.tricks_won?.[1] ?? "—"}</div>
                    </div>
                    <div className="shrink-0 font-mono text-sm font-bold text-amber-200">+{round.points}</div>
                  </article>
                ))}
              </div>
            </section>
          )}
        </div>
      </main>
    </motion.div>
  );
}
